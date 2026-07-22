import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAxonHubProvider,
  injectWebSearchTool,
  isGptFamily,
  type PluginOptions,
  PROVIDER_ID,
  type WebSearchPayload,
} from "./provider.ts";

// Named exports kept for validation/testing compatibility with the prior surface.
export { modelCompat } from "./provider.ts";
export {
  detectThinkingKind,
  modelThinkingLevelMap,
} from "./thinking.ts";

export default function (pi: ExtensionAPI, options?: PluginOptions) {
  pi.registerProvider(createAxonHubProvider(options));

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID) return;
    if (!isGptFamily(model.id)) return;

    return injectWebSearchTool(event.payload as WebSearchPayload);
  });
}
