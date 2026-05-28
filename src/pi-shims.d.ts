declare module "@earendil-works/pi-ai" {
  export type Api =
    | "openai-completions"
    | "anthropic-messages"
    | "openai-responses"
    | "azure-openai-responses"
    | "openai-codex-responses"
    | "google-generative-ai"
    | (string & {});

  export type Provider = string;

  export interface Model<TApi extends Api = Api> {
    id: string;
    name: string;
    api: TApi;
    provider: Provider;
    baseUrl: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
  }

  export interface Context {
    messages: unknown[];
    systemPrompt?: string;
    tools?: unknown[];
  }

  export interface SimpleStreamOptions {
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxTokens?: number;
    reasoning?: string;
    [key: string]: unknown;
  }

  export type AssistantMessage = {
    role: "assistant";
    content: unknown[];
    api: Api;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    stopReason: string;
    errorMessage?: string;
    timestamp: number;
  };

  export type AssistantMessageEvent =
    | { type: "error"; reason: string; error: AssistantMessage }
    | { type: string; [key: string]: unknown };

  export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
    push(event: AssistantMessageEvent): void;
    end(result?: AssistantMessage): void;
  }

  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function streamSimpleAnthropic(
    model: Model<"anthropic-messages">,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
  export function streamSimpleOpenAICompletions(
    model: Model<"openai-completions">,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
  export function streamSimpleGoogle(
    model: Model<"google-generative-ai">,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
  export function getModels(provider: string): Model<Api>[];
}

declare module "@earendil-works/pi-coding-agent" {
  import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

  export interface ProviderModelConfig {
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
  }

  export interface ExtensionAPI {
    registerProvider(
      name: string,
      config: {
        baseUrl?: string;
        apiKey?: string;
        api?: Api;
        models?: ProviderModelConfig[];
        streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
      },
    ): void;
  }

  export function getAgentDir(): string;
}
