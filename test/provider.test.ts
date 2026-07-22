import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Credential, ProviderModelsStore } from "@earendil-works/pi-ai";
import {
  createAxonHubProvider,
  type FetchLike,
  injectWebSearchTool,
  isGptFamily,
  modelApi,
  modelBaseUrl,
  PROVIDER_ID,
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
