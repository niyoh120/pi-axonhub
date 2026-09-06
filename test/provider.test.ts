import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type AssistantMessage,
  type Credential,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ProviderModelsStore,
} from "@earendil-works/pi-ai";
import {
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import defaultExport from "../src/index.ts";
import {
  type AxonHubProviderModel,
  applyThinkingControl,
  axonhubReasoningControlMode,
  createAxonHubProvider,
  type FetchLike,
  injectWebSearchTool,
  isGptFamily,
  modelApi,
  modelBaseUrl,
  modelsDevIndex,
  modelsDevMatch,
  PROVIDER_ID,
  reasoningCapabilityFromOptions,
  resolveMergedCatalog,
  resolveOptionApiKey,
  toProviderModel,
} from "../src/provider.ts";

function memoryStore(initial?: {
  models: unknown[];
  checkedAt?: number;
}): ProviderModelsStore & { data?: { models: unknown[]; checkedAt?: number } } {
  return {
    data: initial ? structuredClone(initial) : undefined,
    async read() {
      return this.data
        ? (structuredClone(this.data) as Awaited<
            ReturnType<ProviderModelsStore["read"]>
          >)
        : undefined;
    },
    async write(entry) {
      this.data = structuredClone(entry) as {
        models: unknown[];
        checkedAt?: number;
      };
    },
    async delete() {
      this.data = undefined;
    },
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return handler();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempCacheFile() {
  const dir = await mkdtemp(join(tmpdir(), "pi-axonhub-"));
  tempDirs.push(dir);
  return join(dir, "models-dev-api.json");
}

// ── models.dev fixtures ─────────────────────────────────────────

type ModelsDevModelFixture = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: unknown;
};

type ModelsDevPayloadFixture = Record<
  string,
  { models: Record<string, ModelsDevModelFixture> }
>;

function buildModelsDevIndex(payload: ModelsDevPayloadFixture) {
  return modelsDevIndex(payload as Parameters<typeof modelsDevIndex>[0]);
}

function matchFor(
  payload: ModelsDevPayloadFixture,
  item: { id?: string; owned_by?: string },
) {
  return modelsDevMatch(item, buildModelsDevIndex(payload));
}

const BASE_URL = "http://localhost:8090";

function effortFixture(values: string[], extra: unknown[] = []) {
  return [{ type: "effort", values }, ...extra];
}

function completionsModel(options: {
  id: string;
  ownedBy?: string;
  reasoning?: boolean;
  reasoningOptions?: unknown;
}) {
  const payload: ModelsDevPayloadFixture = {
    "aggregator-x": {
      models: {
        [options.id]: {
          reasoning: true,
          reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        },
      },
    },
    [options.ownedBy ?? "source-a"]: {
      models: {
        [options.id]: {
          reasoning: options.reasoning ?? true,
          reasoning_options: options.reasoningOptions,
        },
      },
    },
  };
  const item = {
    id: options.id,
    owned_by: options.ownedBy,
    capabilities: { reasoning: options.reasoning ?? true },
  };
  return toProviderModel(BASE_URL, item, matchFor(payload, item));
}

describe("models.dev source disambiguation", () => {
  const mirrored: ModelsDevPayloadFixture = {
    // Aggregator entry comes first in the index; first-party must still win.
    "aggregator-x": {
      models: {
        "glm-5.2": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
        },
      },
    },
    zai: {
      models: {
        "glm-5.2": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["high", "max"] }],
        },
      },
    },
  };

  it("prefers first-party metadata regardless of candidate order", () => {
    const item = { id: "glm-5.2" };
    const forward = buildModelsDevIndex(mirrored);
    const match = modelsDevMatch(item, forward);
    assert.equal(match?.providerId, "zai");

    const reversed = buildModelsDevIndex({
      zai: mirrored.zai,
      "aggregator-x": mirrored["aggregator-x"],
    });
    const reversedMatches = reversed.get("glm-5.2");
    assert.deepEqual(
      reversedMatches?.map((m) => m.providerId),
      ["zai", "aggregator-x"],
    );
    assert.equal(modelsDevMatch(item, reversed)?.providerId, "zai");
  });

  it("resolves declared effort levels from the first-party entry", () => {
    const model = toProviderModel(
      BASE_URL,
      { id: "glm-5.2", capabilities: { reasoning: true } },
      modelsDevMatch({ id: "glm-5.2" }, buildModelsDevIndex(mirrored)),
    );
    assert.ok(model);
    assert.equal(model.api, "openai-completions");
    assert.equal(axonhubReasoningControlMode(model), "effort");
    assert.deepEqual(model.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("owned_by exact match beats the first-party preference", () => {
    const payload: ModelsDevPayloadFixture = {
      openai: {
        models: { "shared-id": { reasoning_options: [{ type: "toggle" }] } },
      },
      "aggregator-x": {
        models: {
          "shared-id": {
            reasoning_options: [{ type: "effort", values: ["low"] }],
          },
        },
      },
    };
    const match = modelsDevMatch(
      { id: "shared-id", owned_by: "aggregator-x" },
      buildModelsDevIndex(payload),
    );
    assert.equal(match?.providerId, "aggregator-x");
  });

  it("falls back to the aggregator entry and to no candidate", () => {
    const aggregatorOnly = buildModelsDevIndex({
      "aggregator-x": {
        models: {
          "solo-model": { reasoning_options: [{ type: "toggle" }] },
        },
      },
    });
    assert.equal(
      modelsDevMatch({ id: "solo-model" }, aggregatorOnly)?.providerId,
      "aggregator-x",
    );
    assert.equal(modelsDevMatch({ id: "missing" }, aggregatorOnly), undefined);
    assert.equal(modelsDevMatch({ id: "" }, aggregatorOnly), undefined);
  });

  it("declares max and low levels verbatim from data", () => {
    const model = completionsModel({
      id: "grok-fable-5",
      ownedBy: "xai",
      reasoningOptions: effortFixture(["low", "max"]),
    });
    assert.ok(model);
    assert.equal(model.thinkingLevelMap?.low, "low");
    assert.equal(model.thinkingLevelMap?.max, "max");
    assert.equal(model.thinkingLevelMap?.high, null);
  });
});

describe("reasoning capability, UI map, and store persistence", () => {
  it("classifies effort, toggle, and unknown reasoning_options", () => {
    const effort = reasoningCapabilityFromOptions(
      effortFixture(["low", "high"]),
    );
    assert.deepEqual(effort, {
      mode: "effort",
      levelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
    });

    const effortWithOff = reasoningCapabilityFromOptions([
      { type: "effort", values: ["none", "medium"] },
    ]);
    assert.equal(effortWithOff?.levelMap.off, "none");

    const toggle = reasoningCapabilityFromOptions([{ type: "toggle" }]);
    assert.deepEqual(toggle, {
      mode: "toggle",
      levelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        xhigh: null,
        max: null,
      },
    });
    assert.equal("high" in (toggle?.levelMap ?? {}), false);

    const unknownCases: unknown[] = [
      undefined,
      null,
      { type: "effort" },
      [],
      [{ type: "budget_tokens", min: 1024 }],
      [{ type: "weird" }],
      [{ type: "effort", values: [] }],
      [{ type: "effort", values: ["default", null] }],
      [{ type: "effort", values: ["none"] }],
      ["not-an-object"],
      [{ type: "effort", values: "low" }],
    ];
    for (const input of unknownCases) {
      assert.equal(
        reasoningCapabilityFromOptions(input),
        undefined,
        `expected unknown for ${JSON.stringify(input)}`,
      );
    }
  });

  it("ignores unknown entries, deduplicates, and merges effort lists", () => {
    const merged = reasoningCapabilityFromOptions([
      { type: "toggle" },
      { type: "effort", values: ["low", "low", "default", null, "max"] },
      { type: "effort", values: ["medium"] },
      { type: "budget_tokens", min: 1 },
      "garbage",
      { type: "effort" },
    ]);
    assert.equal(merged?.mode, "effort");
    assert.deepEqual(merged?.levelMap, {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: null,
      max: "max",
    });
  });

  it("keeps reasoning=false above metadata and skips legacy names without data", () => {
    const gpt = toProviderModel(BASE_URL, {
      id: "gpt-5.6-sol",
      capabilities: { reasoning: true },
    });
    assert.equal(gpt?.api, "openai-responses");
    assert.equal(gpt?.thinkingLevelMap, undefined);
    assert.equal(axonhubReasoningControlMode(gpt), "unknown");

    const glm = completionsModel({
      id: "glm-4.7",
      ownedBy: "zai",
      reasoning: true,
      reasoningOptions: undefined,
    });
    assert.equal(glm?.thinkingLevelMap, undefined);
    assert.equal(axonhubReasoningControlMode(glm), "unknown");

    const nonReasoning = completionsModel({
      id: "glm-5.2-off",
      ownedBy: "zai",
      reasoning: false,
      reasoningOptions: effortFixture(["high", "max"]),
    });
    assert.equal(nonReasoning?.reasoning, false);
    assert.equal(nonReasoning?.thinkingLevelMap, undefined);
    assert.equal(axonhubReasoningControlMode(nonReasoning), "unknown");
  });

  it("exposes toggle UI off/high and clamps the Pi default medium to high", () => {
    const toggle = completionsModel({
      id: "kimi-k2.6",
      ownedBy: "moonshotai",
      reasoningOptions: [{ type: "toggle" }],
    });
    assert.ok(toggle);
    assert.deepEqual(getSupportedThinkingLevels(toggle), ["off", "high"]);
    assert.equal(clampThinkingLevel(toggle, "medium"), "high");
    assert.equal(clampThinkingLevel(toggle, "off"), "off");

    const effort = completionsModel({
      id: "deepseek-v4-pro",
      ownedBy: "deepseek",
      reasoningOptions: effortFixture(
        ["low", "high", "max"],
        [{ type: "toggle" }],
      ),
    });
    assert.ok(effort);
    assert.deepEqual(getSupportedThinkingLevels(effort), [
      "off",
      "low",
      "high",
      "max",
    ]);
    assert.equal(clampThinkingLevel(effort, "xhigh"), "max");
  });

  it("leaves native Anthropic/Gemini models without dynamic levels", () => {
    const anthropic = toProviderModel(BASE_URL, {
      id: "claude-opus-4-8",
      owned_by: "anthropic",
      capabilities: { reasoning: true },
    });
    assert.equal(anthropic?.api, "anthropic-messages");
    assert.equal(anthropic?.thinkingLevelMap, undefined);
    assert.equal(axonhubReasoningControlMode(anthropic), "unknown");
    assert.deepEqual(
      (anthropic?.compat as { forceAdaptiveThinking?: boolean } | undefined)
        ?.forceAdaptiveThinking,
      true,
    );
    assert.equal(
      (anthropic?.compat as { sendSessionAffinityHeaders?: boolean })
        ?.sendSessionAffinityHeaders,
      true,
    );

    const google = toProviderModel(BASE_URL, {
      id: "gemini-2.5-pro",
      owned_by: "google",
      capabilities: { reasoning: true },
    });
    assert.equal(google?.api, "google-generative-ai");
    assert.equal(google?.thinkingLevelMap, undefined);
    assert.equal(axonhubReasoningControlMode(google), "unknown");
  });

  it("applies the unified Chat Completions compat to every completions model", () => {
    const model = completionsModel({
      id: "plain-model",
      ownedBy: "source-a",
      reasoning: false,
    });
    assert.deepEqual(model?.compat, {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      sendSessionAffinityHeaders: true,
    });
  });

  it("persists the capability marker through refresh, JSON round trip, and offline restore", async () => {
    const axonhubModels = {
      data: [{ id: "kimi-k2.6", owned_by: "moonshotai" }],
    };
    const modelsDev = {
      moonshotai: {
        models: {
          "kimi-k2.6": {
            reasoning: true,
            reasoning_options: [{ type: "toggle" }],
          },
        },
      },
    };
    const { fetchImpl } = createFetch({
      "/v1/models?include=all": () => jsonResponse(axonhubModels),
      "/v1/models": () => jsonResponse(axonhubModels),
      "models.dev": () => jsonResponse(modelsDev),
    });
    const store = memoryStore();
    const provider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: BASE_URL },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );

    await provider.refreshModels?.({
      credential: { type: "api_key", key: "test-key" },
      store,
      allowNetwork: true,
    });

    const marker = { version: 1, mode: "toggle" };
    assert.deepEqual(
      (provider.getModels()[0] as { axonhubReasoningControl?: unknown })
        ?.axonhubReasoningControl,
      marker,
    );
    const storedModel = store.data?.models[0] as
      | { axonhubReasoningControl?: unknown }
      | undefined;
    assert.deepEqual(storedModel?.axonhubReasoningControl, marker);

    // FileModelsStore persists as JSON; simulate the round trip and an
    // offline restore in a fresh provider.
    const persisted = JSON.parse(
      JSON.stringify({ models: store.data?.models, checkedAt: 1 }),
    );
    const offline = memoryStore(persisted);
    const offlineProvider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: BASE_URL },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );
    await offlineProvider.refreshModels?.({
      credential: { type: "api_key", key: "test-key" },
      store: offline,
      allowNetwork: false,
    });
    assert.deepEqual(
      (offlineProvider.getModels()[0] as { axonhubReasoningControl?: unknown })
        .axonhubReasoningControl,
      marker,
    );
  });

  it("treats missing, stale, malformed, or rebuilt models as unknown", () => {
    const mapOnly = completionsModel({
      id: "manual-map",
      ownedBy: "source-a",
      reasoningOptions: [{ type: "toggle" }],
    });
    assert.ok(mapOnly);
    const withMarker = (marker: unknown): Model<typeof mapOnly.api> =>
      ({ ...mapOnly, axonhubReasoningControl: marker }) as AxonHubProviderModel;
    // models.json explicit models array rebuilds the model without the
    // extension marker; a hand-written thinkingLevelMap is not evidence.
    const rebuilt = withMarker(undefined);
    assert.equal(axonhubReasoningControlMode(rebuilt), "unknown");
    assert.deepEqual(
      applyThinkingControl(rebuilt, "high", {
        reasoning_effort: "medium",
      }),
      {},
    );

    assert.equal(
      axonhubReasoningControlMode(withMarker({ version: 2, mode: "toggle" })),
      "unknown",
    );
    assert.equal(
      axonhubReasoningControlMode(withMarker({ version: 1, mode: "quantum" })),
      "unknown",
    );
    assert.equal(axonhubReasoningControlMode(withMarker("broken")), "unknown");
    assert.equal(axonhubReasoningControlMode(undefined), "unknown");
  });
});

describe("final payload thinking control", () => {
  const gptEffort = toProviderModel(
    BASE_URL,
    { id: "gpt-5.6-sol", capabilities: { reasoning: true } },
    matchFor(
      {
        openai: {
          models: {
            "gpt-5.6-sol": {
              reasoning: true,
              reasoning_options: effortFixture([
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ]),
            },
          },
        },
      },
      { id: "gpt-5.6-sol" },
    ),
  );
  const kimiToggle = completionsModel({
    id: "kimi-k2.6",
    ownedBy: "moonshotai",
    reasoningOptions: [{ type: "toggle" }],
  });
  const glmLowMax = completionsModel({
    id: "glm-5.2",
    ownedBy: "zai",
    reasoningOptions: effortFixture(["low", "max"]),
  });
  const deepseekEffort = completionsModel({
    id: "deepseek-v4-pro",
    ownedBy: "deepseek",
    reasoningOptions: effortFixture(
      ["none", "low", "high", "max"],
      [{ type: "toggle" }],
    ),
  });
  const unknownReasoner = toProviderModel(
    BASE_URL,
    { id: "mystery-reasoner", capabilities: { reasoning: true } },
    matchFor(
      {
        "aggregator-x": { models: { "mystery-reasoner": { reasoning: true } } },
      },
      { id: "mystery-reasoner" },
    ),
  );

  assert.ok(
    gptEffort && kimiToggle && glmLowMax && deepseekEffort && unknownReasoner,
  );

  const legacyInput = () => ({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "noop" } }],
    reasoning_effort: "medium",
    reasoning: { effort: "medium", summary: "auto" },
    thinking: { type: "enabled" },
    enable_thinking: true,
    include: ["reasoning.encrypted_content"],
  });

  function assertStripped(result: unknown) {
    const body = result as Record<string, unknown>;
    assert.equal("reasoning_effort" in body, false);
    assert.equal("reasoning" in body, false);
    assert.equal("thinking" in body, false);
    assert.equal("enable_thinking" in body, false);
    assert.equal("axonhubReasoningControl" in body, false);
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(body.tools, [
      { type: "function", function: { name: "noop" } },
    ]);
  }

  it("omits control for unknown models, non-reasoning models, and missing data", () => {
    for (const level of ["off", "medium", "high", "bogus"]) {
      for (const model of [
        unknownReasoner,
        { ...kimiToggle, reasoning: false },
      ]) {
        const input = legacyInput();
        const result = applyThinkingControl(model, level, input);
        assertStripped(result);
        // Existing include stays; nothing new is added.
        assert.deepEqual((result as { include?: unknown[] }).include, [
          "reasoning.encrypted_content",
        ]);
        const bare = applyThinkingControl(model, level, { model: "x" });
        assert.equal("include" in (bare as object), false);
        // The input object is never mutated.
        assert.equal(input.reasoning_effort, "medium");
        assert.deepEqual(input.reasoning, {
          effort: "medium",
          summary: "auto",
        });
      }
    }
  });

  it("toggles: off sends none, on omits and keeps server default", () => {
    const offInput = legacyInput();
    const off = applyThinkingControl(kimiToggle, "off", offInput);
    assert.equal(
      (off as { reasoning_effort?: string }).reasoning_effort,
      "none",
    );
    assert.equal("reasoning" in (off as object), false);
    assert.equal("thinking" in (off as object), false);
    assert.equal("enable_thinking" in (off as object), false);
    assert.equal(offInput.reasoning_effort, "medium");

    for (const level of ["high", "medium", "low"]) {
      assertStripped(applyThinkingControl(kimiToggle, level, legacyInput()));
    }

    // Responses: off is the effort-only standard spelling; on drops the whole
    // reasoning object, including Pi-generated summary, and keeps include.
    const responsesOff = applyThinkingControl(
      { ...kimiToggle, api: "openai-responses" },
      "off",
      legacyInput(),
    );
    assert.deepEqual((responsesOff as { reasoning?: unknown }).reasoning, {
      effort: "none",
    });
    assert.equal("reasoning_effort" in (responsesOff as object), false);

    const responsesOn = applyThinkingControl(
      { ...kimiToggle, api: "openai-responses" },
      "high",
      legacyInput(),
    );
    assert.equal("reasoning" in (responsesOn as object), false);
    assert.deepEqual((responsesOn as { include?: unknown[] }).include, [
      "reasoning.encrypted_content",
    ]);
  });

  it("effort models: declared off and levels map verbatim", () => {
    const off = applyThinkingControl(deepseekEffort, "off", legacyInput());
    assert.equal(
      (off as { reasoning_effort?: string }).reasoning_effort,
      "none",
    );

    const max = applyThinkingControl(deepseekEffort, "max", legacyInput());
    assert.equal(
      (max as { reasoning_effort?: string }).reasoning_effort,
      "max",
    );

    // Pi clamps unsupported requests onto declared levels: high is not
    // declared on glmLowMax, xhigh/max are next.
    const clamped = applyThinkingControl(glmLowMax, "high", legacyInput());
    assert.equal(
      (clamped as { reasoning_effort?: string }).reasoning_effort,
      "max",
    );
    const clampedOff = applyThinkingControl(glmLowMax, "off", legacyInput());
    assert.equal(
      (clampedOff as { reasoning_effort?: string }).reasoning_effort,
      "low",
    );
  });

  it("responses effort requests keep legal aux fields and override effort", () => {
    const input = legacyInput();
    const result = applyThinkingControl(gptEffort, "max", input);
    const body = result as {
      reasoning?: { effort?: string; summary?: string };
      reasoning_effort?: string;
    };
    assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
    assert.equal(body.reasoning_effort, undefined);
    assert.deepEqual(input.reasoning, { effort: "medium", summary: "auto" });

    // Off uses the effort-only spelling even when a summary was present.
    const off = applyThinkingControl(gptEffort, "off", legacyInput());
    assert.deepEqual((off as { reasoning?: unknown }).reasoning, {
      effort: "none",
    });
  });

  it("narrows host thinking levels defensively", () => {
    // Runtime "off" arrives even though the declared type omits it.
    assert.equal(
      (
        applyThinkingControl(kimiToggle, "off", legacyInput()) as {
          reasoning_effort?: string;
        }
      ).reasoning_effort,
      "none",
    );
    // Unrecognized values fall back to Pi clamp: first supported level.
    for (const bogus of ["bogus", undefined, null, 42]) {
      const completions = applyThinkingControl(
        kimiToggle,
        bogus,
        legacyInput(),
      );
      assert.equal(
        (completions as { reasoning_effort?: string }).reasoning_effort,
        "none",
      );
      const responses = applyThinkingControl(
        { ...kimiToggle, api: "openai-responses" },
        bogus,
        legacyInput(),
      );
      assert.deepEqual((responses as { reasoning?: unknown }).reasoning, {
        effort: "none",
      });
    }
  });

  it("ignores other providers, native APIs, and non-object payloads", () => {
    const foreign = { ...kimiToggle, provider: "other-provider" };
    const input = legacyInput();
    assert.equal(applyThinkingControl(foreign, "high", input), input);

    const anthropic = toProviderModel(BASE_URL, {
      id: "claude-opus-4-8",
      owned_by: "anthropic",
      capabilities: { reasoning: true },
    });
    assert.ok(anthropic);
    assert.equal(applyThinkingControl(anthropic, "high", input), input);

    assert.equal(applyThinkingControl(kimiToggle, "high", "junk"), "junk");
    assert.equal(applyThinkingControl(undefined, "high", input), input);
  });

  it("chains thinking control with GPT web_search in the real index handler", () => {
    // Off host: GPT effort model with a declared none maps to effort "none"
    // and still gets the web_search tool.
    const piOff = fakeExtensionHost("off");
    defaultExport(piOff as unknown as ExtensionAPI, { apiKey: "test-key" });

    const gptPayload = {
      model: "gpt-5.6-sol",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium", summary: "auto" },
    };
    const gptResult = piOff.emit(
      "before_provider_request",
      gptPayload,
      gptEffort,
    );
    const gptBody = gptResult as {
      reasoning?: { effort?: string };
      tools?: Array<{ type: string }>;
    };
    assert.deepEqual(gptBody.reasoning, { effort: "none" });
    assert.deepEqual(gptBody.tools, [{ type: "web_search" }]);

    // On host: a non-GPT toggle model strips control and gets no tools.
    const piOn = fakeExtensionHost("medium");
    defaultExport(piOn as unknown as ExtensionAPI, { apiKey: "test-key" });
    const completionsPayload = {
      model: "kimi-k2.6",
      reasoning_effort: "high",
    };
    const kimiResult = piOn.emit(
      "before_provider_request",
      completionsPayload,
      kimiToggle,
    );
    assert.equal("reasoning_effort" in (kimiResult as object), false);
    assert.equal("tools" in (kimiResult as object), false);

    // Other providers keep their payload untouched.
    const foreignPayload = { model: "foreign", reasoning_effort: "high" };
    const foreign = piOn.emit("before_provider_request", foreignPayload, {
      ...kimiToggle,
      provider: "other-provider",
    });
    assert.equal(foreign, foreignPayload);
  });
});

type FakeHost = {
  thinkingLevel: unknown;
  registerProvider: () => void;
  on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
  emit: (event: string, payload: unknown, model: unknown) => unknown;
  getThinkingLevel: () => unknown;
};

function fakeExtensionHost(thinkingLevel: unknown): FakeHost {
  const handlers = new Map<
    string,
    Array<(event: never, ctx: never) => unknown>
  >();
  const host = {
    thinkingLevel,
    registerProvider: () => {},
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, payload: unknown, model: unknown) {
      let current = payload;
      for (const handler of handlers.get(event) ?? []) {
        const result = handler(
          { type: event, payload: current } as never,
          {
            model,
          } as never,
        );
        if (result !== undefined) current = result;
      }
      return current;
    },
    getThinkingLevel: () => thinkingLevel,
  };
  return host as unknown as FakeHost;
}

// ── serializer integration ──────────────────────────────────────

type RecordedRequest = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function stubGlobalFetch(respond: () => Response) {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) {
        for (const [key, value] of raw.entries()) headers[key] = value;
      } else if (Array.isArray(raw)) {
        for (const [key, value] of raw as [string, string][])
          headers[key] = value;
      } else {
        Object.assign(headers, raw as Record<string, string>);
      }
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    requests.push({
      url: String(input),
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
      headers,
    });
    return respond();
  }) as typeof fetch;
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function sseResponse(events: unknown[], terminator = "") {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n");
  return new Response(`${body}\n\n${terminator}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectStream(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function userMessage(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

describe("serializer integration with real pi-ai streams", () => {
  it("replays real reasoning_content and tool history on Chat Completions", async () => {
    const model = completionsModel({
      id: "deepseek-v4-pro",
      ownedBy: "deepseek",
      reasoningOptions: effortFixture(
        ["low", "high", "max"],
        [{ type: "toggle" }],
      ),
    });
    assert.ok(model);

    const round1Events = [
      {
        id: "chatcmpl-1",
        model: "deepseek-v4-pro",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "real thinking" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"city":"SF"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    let respond: () => Response;
    const stub = stubGlobalFetch(() => respond());
    try {
      respond = () => sseResponse(round1Events, "data: [DONE]\n\n");
      const first = await collectStream(
        openAICompletionsApi().streamSimple(
          model,
          {
            systemPrompt: "Be brief.",
            messages: [userMessage("Weather in SF?")],
            tools: [WEATHER_TOOL as never],
          },
          {
            apiKey: "test-key",
            reasoning: "high",
            sessionId: "sess-1",
            onPayload: (payload) =>
              applyThinkingControl(model, "high", payload),
          },
        ),
      );
      const done = first[first.length - 1] as {
        type: string;
        message?: AssistantMessage;
      };
      assert.equal(done.type, "done");
      const blocks = done.message?.content ?? [];
      assert.equal(blocks[0]?.type, "thinking");
      assert.equal(blocks[0]?.thinking, "real thinking");
      assert.equal(blocks[0]?.thinkingSignature, "reasoning_content");
      const toolCall = blocks[1] as unknown as {
        type: string;
        name: string;
        arguments: { city: string };
      };
      assert.equal(toolCall.type, "toolCall");
      assert.equal(toolCall.name, "get_weather");
      assert.deepEqual(toolCall.arguments, { city: "SF" });
      assert.equal(done.message?.stopReason, "toolUse");

      const firstBody = stub.requests[0]?.body as {
        model: string;
        reasoning_effort: string;
        max_tokens: number;
        messages: Array<Record<string, unknown>>;
        store?: unknown;
      };
      assert.equal(firstBody.model, "deepseek-v4-pro");
      assert.equal(firstBody.reasoning_effort, "high");
      assert.equal(typeof firstBody.max_tokens, "number");
      assert.equal("store" in firstBody, false);
      assert.equal(firstBody.messages[0]?.role, "system");
      assert.equal(stub.requests[0]?.headers["x-session-affinity"], "sess-1");
      assert.equal(stub.requests[0]?.headers.authorization, "Bearer test-key");
      assert.equal(
        JSON.stringify(firstBody).includes("axonhubReasoningControl"),
        false,
      );

      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "call_1",
        toolName: "get_weather",
        content: [{ type: "text" as const, text: "sunny" }],
        isError: false,
        timestamp: Date.now(),
      };
      const assistant = done.message as AssistantMessage;
      respond = () =>
        sseResponse(
          [
            {
              id: "chatcmpl-2",
              choices: [
                {
                  index: 0,
                  delta: { content: "It is sunny" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-2",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ],
          "data: [DONE]\n\n",
        );
      const second = await collectStream(
        openAICompletionsApi().streamSimple(
          model,
          {
            systemPrompt: "Be brief.",
            messages: [userMessage("Weather in SF?"), assistant, toolResult],
          },
          {
            apiKey: "test-key",
            reasoning: "high",
            onPayload: (payload) =>
              applyThinkingControl(model, "high", payload),
          },
        ),
      );
      assert.equal(
        (second[second.length - 1] as { type: string }).type,
        "done",
      );

      const secondBody = stub.requests[1]?.body as {
        messages: Array<Record<string, unknown>>;
        tools: unknown[];
        reasoning_effort: string;
      };
      const replayed = secondBody.messages.find(
        (message) => message.role === "assistant",
      );
      assert.ok(replayed);
      assert.equal(replayed.reasoning_content, "real thinking");
      assert.ok(Array.isArray(replayed.tool_calls));
      const toolMessage = secondBody.messages.find(
        (message) => message.role === "tool",
      );
      assert.ok(toolMessage);
      assert.equal(toolMessage.tool_call_id, "call_1");
      assert.deepEqual(secondBody.tools, []);
      assert.equal(secondBody.reasoning_effort, "high");

      // Plain assistant history without thinking gets the empty-field backfill.
      respond = () =>
        sseResponse(
          [
            {
              id: "chatcmpl-3",
              choices: [
                { index: 0, delta: { content: "ok" }, finish_reason: null },
              ],
            },
            {
              id: "chatcmpl-3",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ],
          "data: [DONE]\n\n",
        );
      await collectStream(
        openAICompletionsApi().streamSimple(
          model,
          {
            messages: [
              userMessage("hi"),
              {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                api: "openai-completions",
                provider: PROVIDER_ID,
                model: model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: "test-key",
            onPayload: (payload) => applyThinkingControl(model, "off", payload),
          },
        ),
      );
      const thirdBody = stub.requests[2]?.body as {
        messages: Array<Record<string, unknown>>;
        reasoning_effort: string;
      };
      const plain = thirdBody.messages.find(
        (message) => message.role === "assistant",
      );
      assert.equal(plain?.reasoning_content, "");
      assert.equal(thirdBody.reasoning_effort, "none");
    } finally {
      stub.restore();
    }
  });

  it("cleans default Responses control and preserves encrypted reasoning replay", async () => {
    const gptModel = toProviderModel(
      BASE_URL,
      { id: "gpt-5.6-sol", capabilities: { reasoning: true } },
      matchFor(
        {
          openai: {
            models: {
              "gpt-5.6-sol": {
                reasoning: true,
                reasoning_options: effortFixture([
                  "none",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ]),
              },
            },
          },
        },
        { id: "gpt-5.6-sol" },
      ),
    );
    const unknownModel = toProviderModel(BASE_URL, {
      id: "gpt-4o-mini",
      capabilities: { reasoning: true },
    });
    assert.ok(gptModel && unknownModel);

    const reasoningRound = [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "enc-1",
          summary: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        delta: "Hello",
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          output: [],
        },
      },
    ];

    let respond: () => Response;
    const stub = stubGlobalFetch(() => respond());
    try {
      // Unknown model: Pi's generated default control (medium + summary) is
      // removed while the generated include stays.
      respond = () => sseResponse(reasoningRound);
      const first = await collectStream(
        openAIResponsesApi().streamSimple(
          unknownModel,
          { messages: [userMessage("hi")] },
          {
            apiKey: "test-key",
            reasoning: "medium",
            onPayload: (payload) =>
              applyThinkingControl(unknownModel, "medium", payload),
          },
        ),
      );
      assert.equal((first[first.length - 1] as { type: string }).type, "done");
      const unknownBody = stub.requests[0]?.body as {
        reasoning?: unknown;
        include?: string[];
        store?: unknown;
      };
      assert.equal("reasoning" in unknownBody, false);
      assert.deepEqual(unknownBody.include, ["reasoning.encrypted_content"]);
      // Pi's Responses serializer always sends store:false (stateless mode).
      assert.equal(unknownBody.store, false);

      // Effort model: none and max outputs, then replay the encrypted
      // reasoning item with include intact.
      respond = () => sseResponse(reasoningRound);
      const round1 = await collectStream(
        openAIResponsesApi().streamSimple(
          gptModel,
          { messages: [userMessage("hi")] },
          {
            apiKey: "test-key",
            reasoning: "max",
            onPayload: (payload) =>
              applyThinkingControl(gptModel, "max", payload),
          },
        ),
      );
      const done1 = round1[round1.length - 1] as {
        type: string;
        message?: AssistantMessage;
      };
      assert.equal(done1.type, "done");
      const maxBody = stub.requests[1]?.body as {
        reasoning?: { effort?: string };
        include?: string[];
      };
      assert.equal(maxBody.reasoning?.effort, "max");
      assert.deepEqual(maxBody.include, ["reasoning.encrypted_content"]);
      const thinking = done1.message?.content[0] as {
        type: string;
        thinkingSignature?: string;
      };
      assert.equal(thinking.type, "thinking");
      assert.ok(thinking.thinkingSignature?.includes("enc-1"));

      const assistant = done1.message as AssistantMessage;
      respond = () => sseResponse(reasoningRound);
      const round2 = await collectStream(
        openAIResponsesApi().streamSimple(
          gptModel,
          { messages: [userMessage("hi"), assistant] },
          {
            apiKey: "test-key",
            onPayload: (payload) =>
              applyThinkingControl(gptModel, "off", payload),
          },
        ),
      );
      assert.equal(
        (round2[round2.length - 1] as { type: string }).type,
        "done",
      );
      const offBody = stub.requests[2]?.body as {
        input?: Array<Record<string, unknown>>;
        reasoning?: { effort?: string; summary?: string };
        include?: string[];
      };
      assert.deepEqual(offBody.reasoning, { effort: "none" });
      // Pi's off branch never generates include; the hook keeps it absent
      // instead of inventing response-selection fields.
      assert.equal("include" in (offBody as object), false);
      const replayedReasoning = offBody.input?.find(
        (item) => item.type === "reasoning",
      );
      assert.equal(replayedReasoning?.id, "rs_1");
      assert.equal(replayedReasoning?.encrypted_content, "enc-1");
      assert.equal(
        JSON.stringify(offBody).includes("axonhubReasoningControl"),
        false,
      );
    } finally {
      stub.restore();
    }
  });
});

describe("AxonHub catalog merge and refresh", () => {
  it("merges detailed over basic and supports single non-empty success", () => {
    const merged = resolveMergedCatalog(
      {
        status: "ok",
        models: [{ id: "a", name: "basic", context_length: 1000 }],
      },
      {
        status: "ok",
        models: [{ id: "a", name: "detailed", max_output_tokens: 99 }],
      },
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.name, "detailed");
    assert.equal(merged[0]?.context_length, 1000);
    assert.equal(merged[0]?.max_output_tokens, 99);

    const single = resolveMergedCatalog(
      {
        status: "error",
        error: new Error("basic failed"),
      },
      {
        status: "ok",
        models: [{ id: "b", name: "only-detailed" }],
      },
    );
    assert.deepEqual(
      single.map((model) => model.id),
      ["b"],
    );
  });

  it("keeps old store when one endpoint is empty and the other fails", async () => {
    const store = memoryStore({
      models: [
        {
          id: "old",
          name: "old",
          api: "openai-completions",
          provider: PROVIDER_ID,
          baseUrl: "http://localhost:8090/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
      checkedAt: 1,
    });
    const { fetchImpl } = createFetch({
      "/v1/models?include=all": () => {
        throw new Error("detailed down");
      },
      "/v1/models": () => jsonResponse({ data: [] }),
      "models.dev": () => jsonResponse({}),
    });
    const provider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: "http://localhost:8090" },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );

    const refresh = provider.refreshModels;
    assert.ok(refresh);
    await assert.rejects(
      () =>
        refresh({
          credential: { type: "api_key", key: "test-key" },
          store,
          allowNetwork: true,
        }),
      /empty basic catalog/,
    );
  });

  it("writes empty store when both endpoints succeed with empty data", async () => {
    const store = memoryStore({
      models: [
        {
          id: "old",
          name: "old",
          api: "openai-completions",
          provider: PROVIDER_ID,
          baseUrl: "http://localhost:8090/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
      checkedAt: 1,
    });
    const { fetchImpl, calls } = createFetch({
      "/v1/models?include=all": () => jsonResponse({ data: [] }),
      "/v1/models": () => jsonResponse({ data: [] }),
      "models.dev": () => jsonResponse({}),
    });
    const provider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: "http://localhost:8090" },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );

    await provider.refreshModels?.({
      credential: { type: "api_key", key: "test-key" },
      store,
      allowNetwork: true,
    });

    assert.deepEqual(provider.getModels(), []);
    assert.deepEqual(store.data?.models, []);
    assert.equal(
      calls.some((url) => url.includes("models.dev")),
      true,
    );
  });
});

describe("Provider store, offline, and defaults", () => {
  it("restores store offline without network and keeps store on dual failure", async () => {
    const seedModel = {
      id: "cached",
      name: "cached",
      api: "openai-completions" as const,
      provider: PROVIDER_ID,
      baseUrl: "http://localhost:8090/v1",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123,
      maxTokens: 45,
    };
    const store = memoryStore({ models: [seedModel], checkedAt: 1 });
    const { fetchImpl, calls } = createFetch({
      "/v1/models": () => {
        throw new Error("basic failed");
      },
      "models.dev": () => {
        throw new Error("models.dev failed");
      },
    });
    const provider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: "http://localhost:8090" },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );

    await provider.refreshModels?.({
      credential: { type: "api_key", key: "test-key" },
      store,
      allowNetwork: false,
    });
    assert.deepEqual(
      provider.getModels().map((model) => model.id),
      ["cached"],
    );
    assert.equal(calls.length, 0);

    const refresh = provider.refreshModels;
    assert.ok(refresh);
    await assert.rejects(
      () =>
        refresh({
          credential: { type: "api_key", key: "test-key" },
          store,
          allowNetwork: true,
        }),
      /models refresh failed/,
    );
    assert.deepEqual(
      provider.getModels().map((model) => model.id),
      ["cached"],
    );
  });

  it("publishes conservative defaults when models.dev fails", async () => {
    const store = memoryStore();
    const { fetchImpl } = createFetch({
      "/v1/models?include=all": () =>
        jsonResponse({
          data: [{ id: "plain-model", owned_by: "moonshot" }],
        }),
      "/v1/models": () =>
        jsonResponse({
          data: [{ id: "plain-model", owned_by: "moonshot" }],
        }),
      "models.dev": () => {
        throw new Error("models.dev offline");
      },
    });
    const provider = createAxonHubProvider(
      { apiKey: "test-key", baseUrl: "http://localhost:8090" },
      { fetch: fetchImpl, modelsDevCacheFile: await tempCacheFile() },
    );

    await provider.refreshModels?.({
      credential: { type: "api_key", key: "test-key" },
      store,
      allowNetwork: true,
    });

    const model = provider.getModels()[0];
    assert.ok(model);
    assert.equal(model.id, "plain-model");
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.input, ["text"]);
    assert.deepEqual(model.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(model.contextWindow, 200000);
    assert.equal(model.maxTokens, 32000);
    assert.equal(model.api, "openai-completions");
  });

  it("resolves auth option literal, $VAR, stored, env, and unconfigured", async () => {
    process.env.OPTION_KEY = "from-option-env";
    process.env.AXONHUB_API_KEY = "from-default-env";

    const optionLiteral = createAxonHubProvider({ apiKey: "literal-key" });
    const optionEnv = createAxonHubProvider({ apiKey: "$OPTION_KEY" });
    const storedOnly = createAxonHubProvider({});
    const envOnly = createAxonHubProvider({});
    const none = createAxonHubProvider({});

    const env = async (name: string) => process.env[name];
    const resolve = async (
      provider: ReturnType<typeof createAxonHubProvider>,
      credential?: Credential,
    ) =>
      provider.auth.apiKey?.resolve({
        ctx: {
          env,
          fileExists: async () => false,
        },
        credential: credential?.type === "api_key" ? credential : undefined,
      });

    assert.equal((await resolve(optionLiteral))?.auth.apiKey, "literal-key");
    assert.equal((await resolve(optionEnv))?.auth.apiKey, "from-option-env");
    assert.equal(
      (
        await resolve(storedOnly, {
          type: "api_key",
          key: "stored-key",
        })
      )?.auth.apiKey,
      "stored-key",
    );
    assert.equal((await resolve(envOnly))?.auth.apiKey, "from-default-env");
    delete process.env.AXONHUB_API_KEY;
    assert.equal(await resolve(none), undefined);

    assert.equal(
      await resolveOptionApiKey("$" + "{OPTION_KEY}", env),
      "from-option-env",
    );
    assert.equal(await resolveOptionApiKey("$MISSING", env), undefined);

    delete process.env.OPTION_KEY;
  });
});

describe("mapping and request hook", () => {
  it("classifies GPT family and routes API/baseUrl", () => {
    assert.equal(isGptFamily("gpt-5.6-sol"), true);
    assert.equal(isGptFamily("openai/gpt-4o"), true);
    assert.equal(isGptFamily("notgpt"), false);
    assert.equal(modelApi("gpt-5.6-sol"), "openai-responses");
    assert.equal(modelApi("claude-sonnet", "anthropic"), "anthropic-messages");
    assert.equal(modelApi("gemini-2.5", "gemini"), "google-generative-ai");
    assert.equal(
      modelBaseUrl("http://localhost:8090", "gemini"),
      "http://localhost:8090/gemini/v1beta",
    );
    assert.equal(
      modelBaseUrl("http://localhost:8090", "anthropic"),
      "http://localhost:8090/anthropic",
    );

    const mapped = toProviderModel("http://localhost:8090", {
      id: "openai/gpt-4o",
      owned_by: "openai",
    });
    assert.equal(mapped?.api, "openai-responses");
    assert.equal(mapped?.provider, PROVIDER_ID);
    assert.equal(
      (mapped?.compat as { sendSessionAffinityHeaders?: boolean } | undefined)
        ?.sendSessionAffinityHeaders,
      true,
    );
  });

  it("injects web_search idempotently for GPT payloads", () => {
    const first = injectWebSearchTool({});
    assert.deepEqual(first.tools, [{ type: "web_search" }]);
    const second = injectWebSearchTool(first);
    assert.equal(second.tools?.length, 1);
    assert.deepEqual(second.tools, [{ type: "web_search" }]);
  });

  it("gates GPT family the same way routing does", () => {
    assert.equal(isGptFamily("gpt-5.6-sol"), true);
    assert.equal(isGptFamily("openai/gpt-4o"), true);
    assert.equal(isGptFamily("GPT-4o"), true);
    assert.equal(isGptFamily("claude-sonnet"), false);
  });
});
