# @pandada8/pi-axonhub

Pi extension that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, enriches them with cached metadata from `https://models.dev/api.json`, and registers them as the `axonhub` provider.

Requires **Pi `>=0.81.0`** and **Node.js `>=22.19.0`**.

AxonHub models use Pi 0.81 Provider Store. After the first successful online refresh, later startups restore the cached catalog immediately and refresh in the background. On a successful dual-endpoint empty catalog, the store is cleared. HTTP, network, timeout, parse failures, and partial-empty failures keep the previous catalog. Offline mode (`--offline` / `PI_OFFLINE`) restores the store without network requests.

`models.dev` metadata is cached at `~/.cache/pi/models-dev-api.json` for one day and only enriches model fields. AxonHub catalog refresh is independent of that TTL. Extension option `cacheTtl` only controls the models.dev cache window.

The legacy file `~/.cache/pi/axonhub-models.json` is no longer used and is not imported on upgrade. After upgrading, run once online with a configured API key so Provider Store can be seeded.

## Usage

Install the package into Pi's global settings:

```sh
pi install npm:@pandada8/pi-axonhub
```

This writes the package to `~/.pi/agent/settings.json` under `packages`. You can also edit it manually:

```json
{
  "packages": ["npm:@pandada8/pi-axonhub"]
}
```

Configure AxonHub and run Pi:

```sh
export AXONHUB_BASE_URL=http://localhost:8090
export AXONHUB_API_KEY=ah-your-api-key
pi
```

You can also store the key with `/login axonhub`, which writes `~/.pi/agent/auth.json`:

```json
{
  "axonhub": {
    "type": "api_key",
    "key": "ah-your-api-key"
  }
}
```

API key resolution order:

1. Extension option `apiKey` (literal value, or `$VAR` / `${VAR}` env reference)
2. Stored credential from `/login axonhub`
3. `AXONHUB_API_KEY`

If a stored credential and `AXONHUB_API_KEY` are both present, the stored credential wins. Re-run `/login axonhub` to replace the stored key. An API key is required; without one the provider appears for login but models stay unavailable.

`AXONHUB_BASE_URL` is optional and defaults to `http://localhost:8090`.

For local development, point Pi directly at this checkout:

```sh
pi -e /path/to/pi-axonhub
```

OpenAI-compatible models are sent to AxonHub `/v1`. Anthropic-owned models are sent to AxonHub `/anthropic`. Gemini-owned models are sent to AxonHub `/gemini/v1beta`.

## Thinking control

AxonHub terminates the OpenAI protocol and converts standard OpenAI thinking control for the actual upstream, so the extension sends only standard OpenAI fields and derives thinking capabilities from models.dev `reasoning_options` data. Every OpenAI-completions model gets the same compatibility guarantees: no `store`, `system` role, `max_tokens` field, and `reasoning_content` backfill on replayed assistant messages for reasoning models. GPT-family models use the Responses API and receive the built-in `web_search` tool when missing.

models.dev entries are matched by exact model ID. When several aggregators mirror the same ID, `owned_by` wins, then first-party metadata sources (OpenAI, Anthropic, Google, DeepSeek, Z.ai/Zhipu, Alibaba, Moonshot, MiniMax, xAI, Mistral, Cohere), then the first candidate. The selected entry alone provides the capability data; effort levels are never merged across sources.

Each OpenAI-path reasoning model is classified into one of three states:

| State | models.dev data | Pi UI levels | Outbound control |
| ----- | --------------- | ------------ | ---------------- |
| `effort` | At least one declared effort level (`minimal`…`max`) | The declared levels, plus `off` when `none`/toggle is declared | `reasoning_effort` (completions) / `reasoning.effort` (responses) with the declared value |
| `toggle` | A toggle without declared effort levels | `off` and `high` only | `off` sends `none`; `high` sends nothing |
| `unknown` | No match, missing/empty/invalid data, `none` without a toggle, or budget-token-only | Pi's default level display | All thinking control fields are omitted |

Meaning of the toggle UI labels:

- `off` sends the standard OpenAI `none` effort, which disables reasoning where the upstream supports it.
- `high` means "adopt the server default". Pi's default `medium` clamps up to `high` because it is the only non-off slot. Nothing is sent, so the upstream default (on or off) applies. The model never claimed support for a `high` effort value.

For `unknown` models the UI can still show Pi's default levels, but the final request hook strips every thinking control field (`reasoning_effort`, `reasoning`, and legacy private `thinking`/`enable_thinking`), so no unverified parameter reaches AxonHub. The same applies when `reasoning: false`. This omission rule takes precedence over an explicit `off`.

The hook only rewrites top-level thinking control fields of OpenAI-completions and OpenAI-responses payloads. Native Anthropic and Gemini models keep their existing behavior (off, token budgets, adaptive thinking). Real thinking history, `reasoning_content`, tool calls, signatures, and encrypted reasoning replay items in `messages`/`input` are preserved. Responses `include` entries such as `reasoning.encrypted_content` are kept exactly as Pi generated them and are never added when absent, so stateless multi-turn reasoning replay keeps working even when effort control is omitted. Authentication headers, session affinity, store/max-token settings, and tools are untouched.

### Capability persistence and custom models

The three-state capability is stored on each model as an extension-internal marker (`axonhubReasoningControl`) inside the Provider Store; it never appears in API payloads. The marker survives online refresh, JSON persistence, and offline restore.

Two boundaries to know:

- An older catalog persisted before this version keeps its old static level maps until the first successful online refresh replaces the model structure. The hook already treats those unmarked models as `unknown` and omits thinking control, so no stale parameter is sent; only the UI may briefly show the old levels.
- A hand-maintained `models.json` entry for the `axonhub` provider with an explicit `models` array rebuilds those models from the JSON definition, which drops the extension marker; such models are treated as `unknown` and thinking control is omitted. Plain `modelOverrides` field merges preserve the marker. A hand-written `thinkingLevelMap` alone is never treated as models.dev capability evidence.
