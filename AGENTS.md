# AGENTS.md

## Project

- This repository publishes the TypeScript ESM Pi extension `@pandada8/pi-axonhub`.
- Support Node.js `>=22.19.0`; the publish workflow runs Node.js 24.
- Use npm and keep `package-lock.json` synchronized with dependency changes.
- The current Pi development dependencies resolve from `../../badlogic/pi-mono/packages/ai` and `../../badlogic/pi-mono/packages/coding-agent`.

## Commands

- Install dependencies: `npm ci`
- Required verification: `npm run check` (`tsc --noEmit` plus `biome check .`)
- Lint: `npm run lint`
- Format: `npm run format`
- Manual thinking verification: `node validate.ts`
- Biome is the project linter and formatter; its root configuration is `biome.json`. Use the npm scripts as the command source of truth.

## Module boundaries

- `src/index.ts` owns extension startup, credentials, model discovery, caching, models.dev enrichment, API/base URL routing, provider registration, and the GPT `web_search` request hook.
- `src/thinking.ts` owns provider detection, thinking compatibility, and thinking-level maps. Keep it free of Pi package imports so `validate.ts` can execute it directly.
- `src/pi-shims.d.ts` contains compile-time declarations for the Pi APIs consumed by this package. Keep the shims limited to the used API surface.
- `validate.ts` is a focused manual harness for `src/thinking.ts`; update it with observable thinking behavior changes.

## TypeScript conventions

- Keep strict TypeScript and NodeNext ESM semantics.
- Use `.js` specifiers for production relative imports between TypeScript modules.
- Follow existing names: `camelCase` for values/functions, `PascalCase` for types, and `UPPER_SNAKE_CASE` for module constants.
- Use the Biome configuration: 2-space indentation and its standard formatting rules.

## Architecture constraints

- Register the provider as `axonhub` only when an API key resolves from extension options, `AXONHUB_API_KEY`, or Pi `auth.json`.
- Keep the default base URL `http://localhost:8090` and normalize trailing `/v1` or `/` before building endpoint URLs.
- Fetch AxonHub models on every Pi startup and write the result to `~/.cache/pi/axonhub-models.json`.
- Cache `https://models.dev/api.json` for one day and fall back to its existing cache when refresh fails.
- Route Anthropic models through `/anthropic`, Gemini models through `/gemini/v1beta`, and other models through `/v1`.
- Preserve routing-provider precedence for thinking detection: OpenRouter and Together endpoint hints take priority over model-family keywords.
- Preserve `compat.sendSessionAffinityHeaders: true` for AxonHub model configurations.
- Keep API keys and auth payloads out of logs, errors, fixtures, and committed files.

## Commits and releases

- Use Conventional Commit prefixes seen in current history: `feat:`, `fix:`, `chore:`, and `refactor:`.
- Publish through `.github/workflows/publish.yml`; it runs for `v*` tags and manual workflow dispatch, checks the package, then publishes publicly to npm.
- Treat `niyoh120/pi-axonhub` as the canonical maintenance repository while retaining the npm package name `@pandada8/pi-axonhub`.
- Keep `package.json.repository` aligned with the canonical maintenance repository.
