import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Api,
  type AuthResult,
  clampThinkingLevel,
  createProvider,
  type Model,
  type ModelThinkingLevel,
  type OpenAICompletionsCompat,
  type Provider,
  type RefreshModelsContext,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";

export const PROVIDER_ID = "axonhub";
export const DEFAULT_BASE_URL = "http://localhost:8090";
export const DEFAULT_MODELS_DEV_CACHE_FILE = join(
  homedir(),
  ".cache",
  "pi",
  "models-dev-api.json",
);
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_CACHE_TTL = 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;

export type PluginOptions = {
  baseUrl?: string;
  apiKey?: string;
  cacheTtl?: number;
};

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderDependencies = {
  fetch?: FetchLike;
  modelsDevCacheFile?: string;
  now?: () => number;
};

type AxonHubModel = {
  id?: string;
  name?: string;
  display_name?: string;
  created?: number;
  created_at?: string;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
    tool_call?: boolean;
    toolCall?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cacheRead?: number;
    cache_write?: number;
    cacheWrite?: number;
  };
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  /** Validated at runtime; models.dev may omit, null, or reshape it. */
  reasoning_options?: unknown;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
};

type ModelsDevProvider = {
  id?: string;
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;

type ModelsDevMatch = {
  providerId: string;
  model: ModelsDevModel;
};

type EndpointFetchResult =
  | { status: "ok"; models: AxonHubModel[] }
  | { status: "error"; error: Error };

const OWNER_BY_PROVIDER_ID: Record<string, "anthropic" | "gemini" | "openai"> =
  {
    anthropic: "anthropic",
    gemini: "gemini",
    google: "gemini",
    openai: "openai",
  };

/**
 * models.dev provider IDs that publish first-party metadata. When several
 * aggregators mirror the same model ID, these sources win over aggregator
 * entries; the actual upstream channel is still decided by AxonHub routing.
 */
const FIRST_PARTY_MODELS_DEV_PROVIDERS: readonly string[] = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "zai",
  "zhipuai",
  "alibaba",
  "alibaba-cn",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "xai",
  "mistral",
  "cohere",
];

/** Effort levels models.dev may declare; "none" is handled as the off value. */
const DECLARABLE_EFFORT_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const MODEL_THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Top-level request fields this extension owns for thinking control. Anything
 * else in the payload (messages, tools, include, auth-related fields) is left
 * untouched.
 */
const THINKING_CONTROL_FIELDS: readonly string[] = [
  "reasoning_effort",
  "reasoning",
  "thinking",
  "enable_thinking",
];

/** Extension-internal thinking capability state derived from models.dev. */
export type AxonHubReasoningControlMode = "unknown" | "toggle" | "effort";

export type AxonHubReasoningControl = {
  version: 1;
  mode: AxonHubReasoningControlMode;
};

/**
 * Model shape persisted in the axonhub Provider Store. The extra field is
 * consumed only by this extension and must never leak into API payloads.
 */
export type AxonHubProviderModel = Model<Api> & {
  axonhubReasoningControl?: AxonHubReasoningControl;
};

/** Classified models.dev reasoning_options: undefined means "unknown". */
export type ReasoningCapability = {
  mode: "toggle" | "effort";
  levelMap: ThinkingLevelMap;
};

/**
 * Toggle-only UI: "off" maps to OpenAI none; "high" is the single non-off
 * slot (omitted here) and means "adopt the server default effort". Pi's
 * default medium clamps up to high.
 */
const TOGGLE_LEVEL_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  xhigh: null,
  max: null,
};

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export function resolveBaseUrl(options?: PluginOptions) {
  return normalizeBaseUrl(
    options?.baseUrl ?? process.env.AXONHUB_BASE_URL ?? DEFAULT_BASE_URL,
  );
}

export function parseEnvReference(value: string) {
  const braced = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return braced[1];
  const plain = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (plain) return plain[1];
  return undefined;
}

export async function resolveOptionApiKey(
  value: string | undefined,
  env: (name: string) => Promise<string | undefined>,
) {
  if (!value) return;
  const envName = parseEnvReference(value);
  if (envName) {
    const resolved = await env(envName);
    return resolved && resolved.length > 0 ? resolved : undefined;
  }
  return value.length > 0 ? value : undefined;
}

export function requestSignal(parent?: AbortSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!parent) return timeout;
  return AbortSignal.any([parent, timeout]);
}

export function isGptFamily(id: string) {
  return /(?:^|[/_.-])gpt(?:$|[/_.-])/i.test(id);
}

export function normalizeOwner(owner?: string) {
  return owner ? OWNER_BY_PROVIDER_ID[owner] : undefined;
}

export function ownerFromMatch(item: AxonHubModel, match?: ModelsDevMatch) {
  return normalizeOwner(item.owned_by) ?? normalizeOwner(match?.providerId);
}

export function modelApi(id: string, owner?: string): Api {
  if (isGptFamily(id)) return "openai-responses";
  if (owner === "anthropic") return "anthropic-messages";
  if (owner === "gemini") return "google-generative-ai";
  return "openai-completions";
}

export function modelBaseUrl(baseUrl: string, owner?: string) {
  if (owner === "anthropic") return `${baseUrl}/anthropic`;
  if (owner === "gemini") return `${baseUrl}/gemini/v1beta`;
  return `${baseUrl}/v1`;
}

export function isAnthropicAdaptiveThinkingModel(id: string) {
  return (
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4.7") ||
    id.includes("opus-4-8") ||
    id.includes("opus-4.8") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

/**
 * Unified Chat Completions compatibility: AxonHub terminates the OpenAI
 * protocol, so every completions model gets the same guarantees (no store,
 * system role, max_tokens field, reasoning_content backfill on replayed
 * assistant messages when the model reasons).
 */
const OPENAI_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "openai",
  supportsReasoningEffort: true,
};

export function modelCompat(
  id: string,
  owner: string | undefined,
  api: Api,
): Model<Api>["compat"] | undefined {
  if (owner === "anthropic") {
    return isAnthropicAdaptiveThinkingModel(id)
      ? { forceAdaptiveThinking: true }
      : undefined;
  }
  if (owner === "gemini") return undefined;
  // The unified guarantees are Chat Completions only; Responses models keep
  // their own serializer defaults (developer role, store:false, ...).
  if (api !== "openai-completions") return undefined;
  return OPENAI_COMPLETIONS_COMPAT;
}

export function mergeAxonHubModels(
  basic: AxonHubModel[],
  detailed: AxonHubModel[],
) {
  const byId = new Map<string, AxonHubModel>();
  for (const model of [...basic, ...detailed]) {
    if (!model.id) continue;
    byId.set(model.id, { ...byId.get(model.id), ...model });
  }
  return [...byId.values()];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAxonHubModelsPayload(payload: unknown): AxonHubModel[] {
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new Error("Invalid AxonHub models payload: expected { data: [] }");
  }
  return payload.data as AxonHubModel[];
}

async function fetchEndpoint(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<EndpointFetchResult> {
  try {
    const response = await fetchImpl(url, { headers, signal });
    if (!response.ok) {
      return {
        status: "error",
        error: new Error(
          `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
        ),
      };
    }
    const payload = (await response.json()) as unknown;
    return { status: "ok", models: parseAxonHubModelsPayload(payload) };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function resolveMergedCatalog(
  basic: EndpointFetchResult,
  detailed: EndpointFetchResult,
) {
  if (basic.status === "ok" && detailed.status === "ok") {
    return mergeAxonHubModels(basic.models, detailed.models);
  }

  if (basic.status === "ok" && detailed.status === "error") {
    if (basic.models.length === 0) {
      throw new Error(
        `AxonHub detailed models request failed with empty basic catalog: ${detailed.error.message}`,
      );
    }
    return mergeAxonHubModels(basic.models, []);
  }

  if (basic.status === "error" && detailed.status === "ok") {
    if (detailed.models.length === 0) {
      throw new Error(
        `AxonHub basic models request failed with empty detailed catalog: ${basic.error.message}`,
      );
    }
    return mergeAxonHubModels([], detailed.models);
  }

  const basicError =
    basic.status === "error" ? basic.error.message : "unknown basic error";
  const detailedError =
    detailed.status === "error"
      ? detailed.error.message
      : "unknown detailed error";
  throw new Error(
    `AxonHub models refresh failed: ${basicError}; ${detailedError}`,
  );
}

async function readFreshCache<T>(file: string, ttl: number, now: number) {
  try {
    const info = await stat(file);
    if (now - info.mtimeMs > ttl) return;
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return;
  }
}

async function readCache<T>(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return;
  }
}

async function writeCache(file: string, payload: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2));
}

async function loadModelsDev(
  fetchImpl: FetchLike,
  cacheFile: string,
  ttl: number,
  now: number,
  signal?: AbortSignal,
) {
  const cached = await readFreshCache<ModelsDevResponse>(cacheFile, ttl, now);
  if (cached) return cached;

  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${MODELS_DEV_URL}: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as ModelsDevResponse;
    await writeCache(cacheFile, payload);
    return payload;
  } catch {
    return (await readCache<ModelsDevResponse>(cacheFile)) ?? {};
  }
}

export function modelsDevIndex(payload: ModelsDevResponse) {
  const index = new Map<string, ModelsDevMatch[]>();

  for (const [providerId, provider] of Object.entries(payload)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const match = { providerId, model };
      for (const id of new Set(
        [key, model.id].filter(
          (value): value is string => typeof value === "string",
        ),
      )) {
        const matches = index.get(id);
        if (matches) matches.push(match);
        else index.set(id, [match]);
      }
    }
  }

  return index;
}

/**
 * Exact-ID match with first-party preference: owned_by wins, then the
 * first-party provider list in order, then the first candidate. No keyword
 * or fuzzy brand guessing.
 */
export function modelsDevMatch(
  item: AxonHubModel,
  index: Map<string, ModelsDevMatch[]>,
) {
  if (!item.id) return;
  const matches = index.get(item.id);
  if (!matches?.length) return;

  const owner = item.owned_by;
  if (owner) {
    const byOwner = matches.find((match) => match.providerId === owner);
    if (byOwner) return byOwner;
  }

  for (const providerId of FIRST_PARTY_MODELS_DEV_PROVIDERS) {
    const firstParty = matches.find((match) => match.providerId === providerId);
    if (firstParty) return firstParty;
  }

  return matches[0];
}

/**
 * Normalize models.dev reasoning_options into a three-state capability.
 *
 * - effort: at least one recognizable non-off effort value is declared.
 *   Every Pi slot starts unsupported (null), declared levels map to
 *   themselves, and "off" maps to OpenAI none only when a valid toggle or a
 *   "none" value exists.
 * - toggle: a valid toggle without any non-off effort value. "off" maps to
 *   none; "high" stays selectable as the adopt-server-default slot.
 * - unknown (undefined): no match, missing/empty/invalid data, only unknown
 *   values, "none" without a toggle, or budget-token-only entries.
 *
 * Unknown entry types, "default"/null values, and duplicates are ignored;
 * multiple valid effort entries merge.
 */
export function reasoningCapabilityFromOptions(
  reasoningOptions: unknown,
): ReasoningCapability | undefined {
  if (!Array.isArray(reasoningOptions)) return undefined;

  let hasToggle = false;
  let hasNone = false;
  const efforts = new Set<string>();

  for (const entry of reasoningOptions) {
    if (!isObject(entry) || Array.isArray(entry)) continue;
    if (entry.type === "toggle") {
      hasToggle = true;
      continue;
    }
    if (entry.type !== "effort") continue;
    const values = entry.values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (value === "none") hasNone = true;
      else if (
        typeof value === "string" &&
        DECLARABLE_EFFORT_LEVELS.includes(value)
      ) {
        efforts.add(value);
      }
    }
  }

  if (efforts.size > 0) {
    const levelMap: ThinkingLevelMap = {
      off: hasToggle || hasNone ? "none" : null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    };
    for (const effort of efforts) {
      (levelMap as Record<string, string | null>)[effort] = effort;
    }
    return { mode: "effort", levelMap };
  }

  if (hasToggle) {
    return { mode: "toggle", levelMap: { ...TOGGLE_LEVEL_MAP } };
  }
  return undefined;
}

/** Read the extension marker defensively: missing/unknown/malformed → unknown. */
export function axonhubReasoningControlMode(
  model: Model<Api> | undefined,
): AxonHubReasoningControlMode {
  const marker = (model as AxonHubProviderModel | undefined)
    ?.axonhubReasoningControl;
  if (!isObject(marker) || marker.version !== 1) return "unknown";
  if (marker.mode === "toggle" || marker.mode === "effort") return marker.mode;
  return "unknown";
}

function hasModality(
  model: ModelsDevModel | undefined,
  direction: "input" | "output",
  modality: string,
) {
  return model?.modalities?.[direction]?.includes(modality);
}

export function toProviderModel(
  baseUrl: string,
  item: AxonHubModel,
  match?: ModelsDevMatch,
): AxonHubProviderModel | undefined {
  if (!item.id) return;

  const cached = match?.model;
  const owner = ownerFromMatch(item, match);
  const api = modelApi(item.id, owner);
  const supportsVision =
    item.capabilities?.vision ??
    cached?.attachment ??
    hasModality(cached, "input", "image") ??
    false;
  const reasoning = item.capabilities?.reasoning ?? cached?.reasoning ?? false;

  const compat = modelCompat(item.id, owner, api);

  const result: AxonHubProviderModel = {
    id: item.id,
    name: item.name ?? item.display_name ?? cached?.name ?? item.id,
    api,
    provider: PROVIDER_ID,
    baseUrl: modelBaseUrl(baseUrl, owner),
    reasoning,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: item.pricing?.input ?? cached?.cost?.input ?? 0,
      output: item.pricing?.output ?? cached?.cost?.output ?? 0,
      cacheRead:
        item.pricing?.cache_read ??
        item.pricing?.cacheRead ??
        cached?.cost?.cache_read ??
        0,
      cacheWrite:
        item.pricing?.cache_write ??
        item.pricing?.cacheWrite ??
        cached?.cost?.cache_write ??
        0,
    },
    contextWindow: item.context_length ?? cached?.limit?.context ?? 200000,
    maxTokens: item.max_output_tokens ?? cached?.limit?.output ?? 32000,
    compat: { ...compat, sendSessionAffinityHeaders: true },
  };

  // Dynamic levels and the capability marker are OpenAI-path only; native
  // Anthropic/Gemini models keep their off/budget/adaptive behavior.
  if (
    reasoning &&
    (api === "openai-completions" || api === "openai-responses")
  ) {
    const capability = reasoningCapabilityFromOptions(
      cached?.reasoning_options,
    );
    if (capability) {
      result.thinkingLevelMap = capability.levelMap;
      result.axonhubReasoningControl = { version: 1, mode: capability.mode };
    }
  }

  return result;
}

function isKnownThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && MODEL_THINKING_LEVELS.includes(value);
}

function clampHostThinkingLevel(
  model: Model<Api>,
  hostThinkingLevel: unknown,
): ModelThinkingLevel {
  if (isKnownThinkingLevel(hostThinkingLevel)) {
    return clampThinkingLevel(model, hostThinkingLevel);
  }
  // Host APIs declare ThinkingLevel without "off", but session state can hold
  // "off" at runtime, and future levels would arrive as unrecognized strings.
  // Defer unrecognized values to Pi's own clamp, whose unknown-level branch
  // resolves to the first level the model supports.
  return clampThinkingLevel(model, hostThinkingLevel as ModelThinkingLevel);
}

function stripThinkingControl(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!THINKING_CONTROL_FIELDS.some((field) => field in payload)) {
    return payload;
  }
  const next = { ...payload };
  for (const field of THINKING_CONTROL_FIELDS) {
    delete next[field];
  }
  return next;
}

function writeThinkingControl(
  payload: Record<string, unknown>,
  api: string,
  effort: string,
  keepReasoningAuxFields: boolean,
): Record<string, unknown> {
  // stripThinkingControl copies only when control fields exist; copy here
  // otherwise so the original payload is never mutated.
  const stripped = stripThinkingControl(payload);
  const writable = stripped === payload ? { ...payload } : stripped;

  if (api === "openai-responses") {
    const prior =
      keepReasoningAuxFields && isObject(payload.reasoning)
        ? payload.reasoning
        : undefined;
    writable.reasoning = { ...prior, effort };
  } else {
    writable.reasoning_effort = effort;
  }
  return writable;
}

/**
 * Final thinking-control policy for AxonHub models, applied to the serialized
 * payload right before it is sent.
 *
 * | model state             | user level   | completions        | responses               |
 * |-------------------------|--------------|--------------------|-------------------------|
 * | reasoning=false/unknown | any          | omit               | omit                    |
 * | toggle                  | off          | reasoning_effort none | reasoning {effort none} |
 * | toggle                  | on           | omit (server default) | omit (server default) |
 * | effort                  | off          | reasoning_effort none | reasoning {effort none} |
 * | effort                  | declared     | reasoning_effort value | reasoning {effort value} |
 *
 * Missing data always omits control parameters, which takes precedence over
 * an explicit off. Existing Responses `include` entries and everything in
 * messages/input are preserved untouched.
 */
export function applyThinkingControl(
  model: Model<Api> | undefined,
  hostThinkingLevel: unknown,
  payload: unknown,
): unknown {
  if (!model || model.provider !== PROVIDER_ID) return payload;
  if (!isObject(payload)) return payload;

  const api = model.api;
  if (api !== "openai-completions" && api !== "openai-responses") {
    return payload;
  }

  const mode = axonhubReasoningControlMode(model);
  if (!model.reasoning || mode === "unknown") {
    return stripThinkingControl(payload);
  }

  const level = clampHostThinkingLevel(model, hostThinkingLevel);

  if (mode === "toggle") {
    return level === "off"
      ? writeThinkingControl(payload, api, "none", false)
      : stripThinkingControl(payload);
  }

  if (level === "off") {
    return writeThinkingControl(payload, api, "none", false);
  }
  const mapped = model.thinkingLevelMap?.[level];
  return typeof mapped === "string"
    ? writeThinkingControl(payload, api, mapped, true)
    : stripThinkingControl(payload);
}

export type WebSearchPayload = {
  tools?: Array<{ type: string; name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

export function injectWebSearchTool(payload: WebSearchPayload) {
  const existingTools = payload.tools ?? [];
  const hasWebSearch = existingTools.some((tool) => tool.type === "web_search");
  if (hasWebSearch) return payload;
  return {
    ...payload,
    tools: [...existingTools, { type: "web_search" as const }],
  };
}

export function createAxonHubProvider(
  options?: PluginOptions,
  dependencies: ProviderDependencies = {},
): Provider {
  const baseUrl = resolveBaseUrl(options);
  const ttl = options?.cacheTtl ?? DEFAULT_CACHE_TTL;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const modelsDevCacheFile =
    dependencies.modelsDevCacheFile ?? DEFAULT_MODELS_DEV_CACHE_FILE;
  const now = dependencies.now ?? Date.now;

  return createProvider({
    id: PROVIDER_ID,
    name: "AxonHub",
    baseUrl,
    auth: {
      apiKey: {
        name: "AxonHub API key",
        async login(interaction) {
          const key = await interaction.prompt({
            type: "secret",
            message: "AxonHub API key",
          });
          return { type: "api_key", key };
        },
        async resolve({ ctx, credential }): Promise<AuthResult | undefined> {
          const fromOption = await resolveOptionApiKey(
            options?.apiKey,
            (name) => ctx.env(name),
          );
          if (fromOption) {
            return {
              auth: { apiKey: fromOption },
              source: "extension option",
            };
          }

          if (
            credential?.type === "api_key" &&
            typeof credential.key === "string" &&
            credential.key.length > 0
          ) {
            return {
              auth: { apiKey: credential.key },
              source: "stored API key",
            };
          }

          const envKey = await ctx.env("AXONHUB_API_KEY");
          if (envKey && envKey.length > 0) {
            return {
              auth: { apiKey: envKey },
              source: "AXONHUB_API_KEY",
            };
          }

          return undefined;
        },
      },
    },
    models: [],
    async fetchModels(context: RefreshModelsContext) {
      const key =
        context.credential?.type === "api_key"
          ? context.credential.key
          : undefined;
      if (!key) {
        throw new Error("AxonHub API key is required to refresh models");
      }

      const signal = requestSignal(context.signal);
      const headers = { Authorization: `Bearer ${key}` };
      const [basic, detailed, modelsDev] = await Promise.all([
        fetchEndpoint(fetchImpl, `${baseUrl}/v1/models`, headers, signal),
        fetchEndpoint(
          fetchImpl,
          `${baseUrl}/v1/models?include=all`,
          headers,
          signal,
        ),
        loadModelsDev(fetchImpl, modelsDevCacheFile, ttl, now(), signal),
      ]);

      const catalog = resolveMergedCatalog(basic, detailed);
      const index = modelsDevIndex(modelsDev);
      return catalog
        .map((item) =>
          toProviderModel(baseUrl, item, modelsDevMatch(item, index)),
        )
        .filter((model): model is AxonHubProviderModel => model !== undefined);
    },
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
    },
  });
}
