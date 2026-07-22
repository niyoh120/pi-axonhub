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

The extension auto-detects the thinking protocol for OpenAI-compatible models so that reasoning parameters are sent in the format expected by the upstream provider, not a generic OpenAI format. When both a routing/hosting provider hint (OpenRouter, Together) and a model-family keyword (DeepSeek, Qwen, etc.) are present, the routing provider wins because the wire protocol is determined by the endpoint, not the model family.

| Detected provider | `thinkingFormat` | Supported thinking levels     | Wire parameters                        |
| ----------------- | ---------------- | ----------------------------- | -------------------------------------- |
| DeepSeek          | `deepseek`       | off, high, xhigh              | `thinking: { type }, reasoning_effort` |
| Qwen / Alibaba    | `qwen`           | off, high                     | `enable_thinking`                      |
| Z.ai / Zhipu/GLM  | `zai`            | off, high                     | `enable_thinking`                      |
| Together          | `together`       | off, high                     | `reasoning: { enabled }`               |
| OpenRouter        | `openrouter`     | off, low, medium, high, xhigh | `reasoning: { effort }`                |
| Unknown / generic | `openai`         | off                           | `reasoning_effort` when supported      |

GPT-5.6 models, including Sol, Terra, and Luna, use the Responses API and expose the `xhigh` and `max` thinking levels. GPT requests also receive the built-in `web_search` tool when missing.

Detection uses `owned_by`, `models.dev` provider id, and model id/name keywords with the precedence described above. Models that are not identified fall back to the existing safe generic OpenAI-compatible default.
