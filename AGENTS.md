# AGENTS.md

## Project

- This repository publishes the TypeScript ESM Pi extension `@pandada8/pi-axonhub`.
- Support Node.js `>=22.19.0`; the publish workflow runs Node.js 24.
- Use npm and keep `package-lock.json` synchronized with dependency changes.
- Pi dependencies come from npm (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, currently 0.81.x).

## Commands

- Install dependencies: `npm ci`
- Required verification: `npm run check` (`tsc --noEmit`, `biome check .`, then the full `node --test` suite)
- Lint: `npm run lint`
- Format: `npm run format`
- Biome is the project linter and formatter; its root configuration is `biome.json`. Use the npm scripts as the command source of truth.

## Module boundaries

- `src/index.ts` owns extension startup, provider registration, and the `before_provider_request` hook that applies the final thinking-control policy to AxonHub OpenAI payloads and chains the GPT `web_search` injection.
- `src/provider.ts` owns credentials, model discovery, catalog merging, models.dev enrichment (exact-ID matching with first-party preference), the three-state reasoning capability (`unknown`/`toggle`/`effort`) with its persisted marker, the unified OpenAI-compat configuration, API/base URL routing, and the pure `applyThinkingControl` payload helper.
- Tests live in `test/provider.test.ts` and cover source disambiguation, capability/UI/store behavior, the final payload matrix, and serializer-level integration with real pi-ai streams.

## TypeScript conventions

- Keep strict TypeScript and NodeNext ESM semantics.
- Use `.js` specifiers for production relative imports between TypeScript modules.
- Follow existing names: `camelCase` for values/functions, `PascalCase` for types, and `UPPER_SNAKE_CASE` for module constants.
- Use the Biome configuration: 2-space indentation and its standard formatting rules.

## Architecture constraints

- Register the `axonhub` provider at startup; the API key resolves at auth time from extension options, `AXONHUB_API_KEY`, or a stored `/login axonhub` credential in Pi `auth.json`. Without a key the provider appears for login but models stay unavailable.
- Keep the default base URL `http://localhost:8090` and normalize trailing `/v1` or `/` before building endpoint URLs.
- Fetch AxonHub models on every Pi startup through Pi Provider Store; keep the store on partial failures, clear it on a successful dual-empty catalog, and restore it offline without network.
- Cache `https://models.dev/api.json` at `~/.cache/pi/models-dev-api.json` for one day and fall back to its existing cache when refresh fails.
- Route Anthropic models through `/anthropic`, Gemini models through `/gemini/v1beta`, and other models through `/v1`.
- Derive thinking capability only from models.dev `reasoning_options` on the single matched entry: exact-ID match with `owned_by` first, then the first-party provider list, then the first candidate. Never merge effort levels across sources or guess brands from keywords.
- Three states: `effort` (declared levels map to themselves; `off` maps to `none` only when a toggle or `none` value exists), `toggle` (`off`/`high` UI; on omits control so the server default applies), and `unknown` (omit all thinking control). `reasoning: false` overrides everything.
- Persist the capability marker (`axonhubReasoningControl`, version 1) on models in the Provider Store only; it must never enter API payloads. Missing, stale, or malformed markers are treated as `unknown`, as are models rebuilt from an explicit `models.json` `models` array.
- In `before_provider_request`, apply `applyThinkingControl` for AxonHub OpenAI-completions/responses payloads using `pi.getThinkingLevel()` narrowed defensively and clamped with Pi's own `clampThinkingLevel`; preserve messages, tools, `include`, and encrypted reasoning replay, and never modify the input payload in place.
- Keep the unified OpenAI-completions compat (`supportsStore: false`, `supportsDeveloperRole: false`, `maxTokensField: "max_tokens"`, `requiresReasoningContentOnAssistantMessages: true`, `thinkingFormat: "openai"`, `supportsReasoningEffort: true`) and `compat.sendSessionAffinityHeaders: true` for AxonHub model configurations; native Anthropic/Gemini models keep their existing compat.
- Keep API keys and auth payloads out of logs, errors, fixtures, and committed files.

## Commits and releases

- Use Conventional Commit prefixes seen in current history: `feat:`, `fix:`, `chore:`, and `refactor:`.
- Publish through `.github/workflows/publish.yml`; it runs for `v*` tags and manual workflow dispatch, checks the package, then publishes publicly to npm.
- Treat `niyoh120/pi-axonhub` as the canonical maintenance repository while retaining the npm package name `@pandada8/pi-axonhub`.
- Keep `package.json.repository` aligned with the canonical maintenance repository.
