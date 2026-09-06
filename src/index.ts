import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyThinkingControl,
  createAxonHubProvider,
  injectWebSearchTool,
  isGptFamily,
  type PluginOptions,
  PROVIDER_ID,
  type WebSearchPayload,
} from "./provider.ts";

export default function (pi: ExtensionAPI, options?: PluginOptions) {
  pi.registerProvider(createAxonHubProvider(options));

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID) return;

    // Enforce the final thinking-control policy on AxonHub OpenAI payloads,
    // then chain the GPT web_search tool injection.
    const controlled = applyThinkingControl(
      model,
      pi.getThinkingLevel(),
      event.payload,
    );
    if (!isGptFamily(model.id)) return controlled;
    if (typeof controlled !== "object" || controlled === null) {
      return controlled;
    }
    return injectWebSearchTool(controlled as WebSearchPayload);
  });
}
