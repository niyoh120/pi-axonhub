/** Thinking-kind detection and compat/map logic.  No pi-package imports — safe to import in tests. */

export type ThinkingKind =
  | "openai"
  | "openrouter"
  | "together"
  | "deepseek"
  | "qwen"
  | "zai";

type ProviderThinkingKind = Exclude<ThinkingKind, "openai">;

/** Lightweight model hint so this module stays dependency-free. */
export interface ThinkingModelHint {
  id?: string;
  name?: string;
  display_name?: string;
  owned_by?: string;
}

/** Lightweight match hint. */
export interface ThinkingMatchHint {
  providerId?: string;
  model?: { id?: string; name?: string };
}

// ── keyword tables ──────────────────────────────────────────────

const PROVIDER_HINT_ALIASES: Record<ProviderThinkingKind, string[]> = {
  openrouter: ["openrouter", "open-router"],
  together: ["together", "togetherai", "together-ai"],
  deepseek: ["deepseek", "deep-seek"],
  qwen: ["qwen", "alibaba", "dashscope", "tongyi"],
  zai: ["zai", "z-ai", "zhipu", "bigmodel", "glm"],
};

const MODEL_KEYWORD_FALLBACK: Record<ProviderThinkingKind, string[]> = {
  openrouter: ["openrouter", "open-router"],
  together: ["together", "togetherai", "together-ai"],
  deepseek: ["deepseek", "deep-seek", "deepseek-r1"],
  qwen: ["qwen", "qwq", "tongyi"],
  zai: ["zai", "z-ai", "zhipu", "glm"],
};

const PROVIDER_PRECEDENCE: ProviderThinkingKind[] = [
  "openrouter",
  "together",
  "deepseek",
  "qwen",
  "zai",
];

// ── helpers ─────────────────────────────────────────────────────

function normalizeHint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesR1Token(text: string): boolean {
  return /(?:^|[^a-z0-9])r1(?:[^a-z0-9]|$)/i.test(text);
}

// Pre-normalized alias tables for separator-insensitive matching.
const NORM_HINT_ALIASES: Record<ProviderThinkingKind, string[]> =
  Object.fromEntries(
    Object.entries(PROVIDER_HINT_ALIASES).map(([k, v]) => [
      k,
      v.map(normalizeHint),
    ]),
  ) as Record<ProviderThinkingKind, string[]>;

const NORM_MODEL_KEYWORDS: Record<ProviderThinkingKind, string[]> =
  Object.fromEntries(
    Object.entries(MODEL_KEYWORD_FALLBACK).map(([k, v]) => [
      k,
      v.map(normalizeHint),
    ]),
  ) as Record<ProviderThinkingKind, string[]>;

// ── detection ───────────────────────────────────────────────────

function detectThinkingKindFromModel(
  item: ThinkingModelHint,
  match?: ThinkingMatchHint,
): ThinkingKind | undefined {
  const rawTexts = [
    item.id,
    item.name,
    item.display_name,
    match?.model?.id,
    match?.model?.name,
  ].filter((v): v is string => typeof v === "string");
  const normalizedTexts = rawTexts.map((v) => normalizeHint(v));

  for (const kind of ["openrouter", "together"] as const) {
    if (
      normalizedTexts.some((t) =>
        NORM_MODEL_KEYWORDS[kind].some((kw) => t.includes(kw)),
      )
    )
      return kind;
  }

  if (
    normalizedTexts.some((t) =>
      NORM_MODEL_KEYWORDS.deepseek.some((kw) => t.includes(kw)),
    ) ||
    rawTexts.some((t) => matchesR1Token(t))
  ) {
    return "deepseek";
  }

  if (
    normalizedTexts.some((t) =>
      NORM_MODEL_KEYWORDS.qwen.some((kw) => t.includes(kw)),
    )
  )
    return "qwen";

  if (
    normalizedTexts.some((t) =>
      NORM_MODEL_KEYWORDS.zai.some((kw) => t.includes(kw)),
    )
  )
    return "zai";

  return undefined;
}

export function detectThinkingKind(
  item: ThinkingModelHint,
  match?: ThinkingMatchHint,
): ThinkingKind {
  const normalizedHints = [item.owned_by, match?.providerId]
    .filter((v): v is string => typeof v === "string")
    .map((v) => normalizeHint(v));

  for (const kind of PROVIDER_PRECEDENCE) {
    const aliases = NORM_HINT_ALIASES[kind];
    if (normalizedHints.some((h) => aliases.includes(h))) return kind;
  }

  const modelKind = detectThinkingKindFromModel(item, match);
  if (modelKind) return modelKind;

  return "openai";
}

// ── compat builder ──────────────────────────────────────────────

export interface ThinkingCompat {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
  thinkingFormat: ThinkingKind;
  requiresReasoningContentOnAssistantMessages?: boolean;
}

function baseCompat(): Omit<
  ThinkingCompat,
  | "thinkingFormat"
  | "supportsReasoningEffort"
  | "requiresReasoningContentOnAssistantMessages"
> {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens" as const,
  };
}

export function modelThinkingCompat(
  thinkingKind: ThinkingKind,
): ThinkingCompat {
  switch (thinkingKind) {
    case "deepseek":
      return {
        ...baseCompat(),
        supportsReasoningEffort: true,
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
      };
    case "qwen":
      return {
        ...baseCompat(),
        supportsReasoningEffort: false,
        thinkingFormat: "qwen",
      };
    case "zai":
      return {
        ...baseCompat(),
        supportsReasoningEffort: false,
        thinkingFormat: "zai",
      };
    case "together":
      return {
        ...baseCompat(),
        supportsReasoningEffort: false,
        thinkingFormat: "together",
      };
    case "openrouter":
      return {
        ...baseCompat(),
        supportsReasoningEffort: false,
        thinkingFormat: "openrouter",
      };
    default:
      return {
        ...baseCompat(),
        supportsReasoningEffort: false,
        thinkingFormat: "openai",
      };
  }
}

// ── level map builder ───────────────────────────────────────────

export type ThinkingLevelMap = Partial<
  Record<
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    string | null
  >
>;

/** GPT-5.6 exposes Pi's extended reasoning levels through Responses API. */
export function gpt56ThinkingLevelMap(
  id: string,
): ThinkingLevelMap | undefined {
  if (!/(?:^|[^0-9])gpt-5\.6(?:[^0-9]|$)/.test(id.toLowerCase()))
    return undefined;
  return { xhigh: "xhigh", max: "max" };
}

export function modelThinkingLevelMap(
  thinkingKind: ThinkingKind,
): ThinkingLevelMap | undefined {
  switch (thinkingKind) {
    case "deepseek":
      return {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "xhigh",
      };
    case "qwen":
    case "zai":
    case "together":
      return { minimal: null, low: null, medium: null };
    case "openrouter":
      return {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      };
    default:
      return undefined;
  }
}
