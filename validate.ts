/**
 * Validation that imports real source from src/thinking.ts (no pi-package deps).
 * Run: node validate.ts
 */

import {
  detectThinkingKind,
  glm5ThinkingLevelMap,
  gpt56ThinkingLevelMap,
  modelThinkingCompat,
  modelThinkingLevelMap,
} from "./src/thinking.ts";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  } else {
    failed++;
    console.error(
      `  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

// ── Thinking adaptation cases ──────────────────────────────────
console.log("=== Thinking adaptation ===");

{
  const kind = detectThinkingKind({
    id: "deepseek-v4-pro",
    owned_by: "deepseek",
  });
  assert("1. DeepSeek kind", kind === "deepseek", `got ${kind}`);
  const compat = modelThinkingCompat(kind);
  assert("1. thinkingFormat", compat.thinkingFormat === "deepseek");
  assert("1. supportsReasoningEffort", compat.supportsReasoningEffort === true);
  assert(
    "1. requiresReasoningContentOnAssistantMessages",
    compat.requiresReasoningContentOnAssistantMessages === true,
  );
  const map = modelThinkingLevelMap(kind);
  assert("1. xhigh", map?.xhigh === "xhigh");
  assert("1. minimal null", map?.minimal === null);
  assert("1. off omitted", map?.off === undefined);
}

{
  const kind = detectThinkingKind({ id: "qwen3-235b", owned_by: "qwen" });
  assert("2. Qwen kind", kind === "qwen");
  const compat = modelThinkingCompat(kind);
  assert("2. thinkingFormat", compat.thinkingFormat === "qwen");
  assert(
    "2. supportsReasoningEffort false",
    compat.supportsReasoningEffort === false,
  );
  const map = modelThinkingLevelMap(kind);
  assert("2. minimal null", map?.minimal === null);
  assert("2. low null", map?.low === null);
  assert("2. medium null", map?.medium === null);
}

{
  const kind = detectThinkingKind(
    { id: "qwen-max" },
    { providerId: "alibaba", model: {} },
  );
  assert("2b. Qwen via alibaba providerId", kind === "qwen");
}

{
  const kind = detectThinkingKind({ id: "glm-4.7", owned_by: "zai" });
  assert("3. Z.ai kind", kind === "zai");
  const compat = modelThinkingCompat(kind);
  assert("3. thinkingFormat", compat.thinkingFormat === "zai");
  assert(
    "3. supportsReasoningEffort false",
    compat.supportsReasoningEffort === false,
  );
}

{
  const kind = detectThinkingKind({ id: "glm-4-flash", owned_by: "zhipu" });
  assert("3b. Zhipu kind", kind === "zai");
}

{
  const kind = detectThinkingKind({
    id: "deepseek/deepseek-r1",
    owned_by: "together",
  });
  assert("4. Together-hosts-DeepSeek → together", kind === "together");
}

{
  const kind = detectThinkingKind({
    id: "Qwen/Qwen3-32B",
    owned_by: "together",
  });
  assert("4b. Together-hosts-Qwen → together", kind === "together");
}

{
  const kind = detectThinkingKind({
    id: "deepseek/deepseek-chat",
    owned_by: "openrouter",
  });
  assert("5. OpenRouter-hosts-DeepSeek → openrouter", kind === "openrouter");
  const map = modelThinkingLevelMap(kind);
  assert("5. off→none", map?.off === "none");
  assert("5. low→low", map?.low === "low");
  assert("5. medium", map?.medium === "medium");
  assert("5. high", map?.high === "high");
  assert("5. xhigh", map?.xhigh === "xhigh");
}

{
  const kind = detectThinkingKind({ id: "moonshot-v1", owned_by: "moonshot" });
  assert("6. Unknown → openai", kind === "openai");
  const compat = modelThinkingCompat(kind);
  assert("6. thinkingFormat", compat.thinkingFormat === "openai");
  assert(
    "6. supportsReasoningEffort false",
    compat.supportsReasoningEffort === false,
  );
  const map = modelThinkingLevelMap(kind);
  assert("6. no map", map === undefined);
}

{
  const maps = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
    gpt56ThinkingLevelMap,
  );
  assert(
    "7. GPT-5.6 models support xhigh",
    maps.every((map) => map?.xhigh === "xhigh"),
  );
  assert(
    "7. GPT-5.6 models support max",
    maps.every((map) => map?.max === "max"),
  );
  assert(
    "7. other GPT versions omit extended map",
    ["gpt-5.5", "gpt-5.60"].every(
      (id) => gpt56ThinkingLevelMap(id) === undefined,
    ),
  );
}

// ── GLM-5.2+ thinking levels ──────────────────────────────────────
console.log("\n=== GLM-5.2+ thinking levels ===");

{
  assert(
    "G1. glm-5.2 supports max",
    glm5ThinkingLevelMap("glm-5.2")?.max === "max",
  );
  assert(
    "G1. glm-5.2 supports xhigh",
    glm5ThinkingLevelMap("glm-5.2")?.xhigh === "xhigh",
  );
  assert(
    "G1. glm-5.2 omits high (not in base zai map or glm5 map)",
    glm5ThinkingLevelMap("glm-5.2")?.high === undefined,
  );
}

{
  assert(
    "G2. glm-5.10 supports max",
    glm5ThinkingLevelMap("glm-5.10")?.max === "max",
  );
  assert(
    "G2. glm5.10 (no dash) supports max",
    glm5ThinkingLevelMap("glm5.10")?.max === "max",
  );
}

{
  assert(
    "G3. glm-5.1 omitted (reasoning_effort unsupported)",
    glm5ThinkingLevelMap("glm-5.1") === undefined,
  );
  assert("G3. glm-5 omitted", glm5ThinkingLevelMap("glm-5") === undefined);
  assert("G3. glm-4.7 omitted", glm5ThinkingLevelMap("glm-4.7") === undefined);
}

{
  assert(
    "G4. unrelated id omitted",
    glm5ThinkingLevelMap("gpt-5.6") === undefined,
  );
  assert(
    "G4. glm-5-turbo omitted (no minor version)",
    glm5ThinkingLevelMap("glm-5-turbo") === undefined,
  );
  assert(
    "G4. glm-5.2-preview (suffix) supported",
    glm5ThinkingLevelMap("glm-5.2-preview")?.max === "max",
  );
  assert(
    "G4. org/glm-5.2 (owner-prefixed) supported",
    glm5ThinkingLevelMap("org/glm-5.2")?.max === "max",
  );
  assert(
    "G4. glm-4.5.1 (multi-dot old) omitted",
    glm5ThinkingLevelMap("glm-4.5.1") === undefined,
  );
  assert(
    "G4. chatglm5.2 (no boundary) omitted",
    glm5ThinkingLevelMap("chatglm5.2") === undefined,
  );
}

// ── Precedence ──────────────────────────────────────────────────
console.log("\n=== Precedence ===");

{
  const kind = detectThinkingKind(
    { id: "deepseek-chat", owned_by: "deepseek" },
    { providerId: "openrouter", model: {} },
  );
  assert(
    "F1. openrouter providerId overrides deepseek owned_by",
    kind === "openrouter",
  );
}

{
  const kind = detectThinkingKind({ id: "glm-4-flash", owned_by: "glm" });
  assert("F2. glm provider alias → zai", kind === "zai");
}

{
  const kind = detectThinkingKind({ id: "something-r1-online" });
  assert("F3. r1 token match", kind === "deepseek");
}

{
  const kind = detectThinkingKind({ id: "mar1gold" });
  assert("F4. r1 word-boundary no false positive", kind === "openai");
}

{
  const kind = detectThinkingKind({ id: "deepseek-v3-0324" });
  assert("F5. keyword deepseek fallback", kind === "deepseek");
}

{
  const kind = detectThinkingKind({ id: "qwen2.5-coder-7b" });
  assert("F6. keyword qwen fallback", kind === "qwen");
}

{
  const kind = detectThinkingKind({ id: "glm-4-flash" });
  assert("F7. keyword glm fallback", kind === "zai");
}

// ── Separator-insensitive matching ─────────────────────────────
console.log("\n=== Separators ===");

{
  const kind = detectThinkingKind({ id: "my-model", owned_by: "z.ai" });
  assert("S1. owned_by z.ai → zai", kind === "zai", `got ${kind}`);
}

{
  const kind = detectThinkingKind({ id: "my-model", owned_by: "open_router" });
  assert(
    "S2. owned_by open_router → openrouter",
    kind === "openrouter",
    `got ${kind}`,
  );
}

{
  const kind = detectThinkingKind({ id: "deep-seek-chat" });
  assert(
    "S3. model id deep-seek-chat → deepseek",
    kind === "deepseek",
    `got ${kind}`,
  );
}

{
  const kind = detectThinkingKind({ id: "z-ai-model" });
  assert("S4. model id z-ai-model → zai", kind === "zai", `got ${kind}`);
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
