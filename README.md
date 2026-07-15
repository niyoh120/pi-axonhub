# @pandada8/pi-axonhub

Pi extension that discovers AxonHub models from `/v1/models` and `/v1/models?include=all`, enriches them with cached metadata from `https://models.dev/api.json`, and registers them as the `axonhub` provider.

AxonHub models are fetched once on each Pi startup and written to `~/.cache/pi/axonhub-models.json`. `models.dev` metadata is cached at `~/.cache/pi/models-dev-api.json` for one day. If no API key is configured, the extension does not register the provider.

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

You can also store the key in `~/.pi/agent/auth.json`:

```json
{
  "axonhub": {
    "type": "api_key",
    "key": "ah-your-api-key"
  }
}
```

When using `auth.json`, `AXONHUB_API_KEY` is not required. `AXONHUB_BASE_URL` is optional and defaults to `http://localhost:8090`.

For local development, point Pi directly at this checkout:

```sh
pi -e /path/to/pi-axonhub
```

OpenAI-compatible models are sent to AxonHub `/v1`. Anthropic-owned models are sent to AxonHub `/anthropic`. Gemini-owned models are sent to AxonHub `/gemini`.

The extension auto-detects the thinking protocol for OpenAI-compatible models so that reasoning parameters are sent in the format expected by the upstream provider, not a generic OpenAI format. When both a routing/hosting provider hint (OpenRouter, Together) and a model-family keyword (DeepSeek, Qwen, etc.) are present, the routing provider wins because the wire protocol is determined by the endpoint, not the model family.

| Detected provider | `thinkingFormat`  | Supported thinking levels        | Wire parameters                               |
| ----------------- | ----------------- | -------------------------------- | --------------------------------------------- |
| DeepSeek          | `deepseek`        | off, high, xhigh                 | `thinking: { type }, reasoning_effort`        |
| Qwen / Alibaba    | `qwen`            | off, high                        | `enable_thinking`                             |
| Z.ai / Zhipu/GLM | `zai`             | off, high                        | `enable_thinking`                             |
| Together          | `together`        | off, high                        | `reasoning: { enabled }`                      |
| OpenRouter        | `openrouter`      | off, low, medium, high, xhigh     | `reasoning: { effort }`                       |
| Unknown / generic | `openai`          | off                              | `reasoning_effort` (not sent if unsupported)  |

GPT-5.6 models, including Sol, Terra, and Luna, use the Responses API and expose the `xhigh` and `max` thinking levels.

Detection uses `owned_by`, `models.dev` provider id, and model id/name keywords with the precedence described above. Models that are not identified fall back to the existing safe generic OpenAI-compatible default.
