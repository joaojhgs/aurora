import {
  LightweightOrchestratorError,
  type LightweightAssistantProvider,
  type LightweightProviderRequest,
  type LightweightProviderResponse,
  type LightweightToolCall,
} from "@aurora/client/lightweight-orchestrator";

export interface TauriAssistantProviderInvoke {
  (command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface TauriAssistantProviderStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly provider: "openai-compatible";
  readonly endpoint?: string | null;
  readonly model?: string | null;
  readonly backend: "platform-keychain";
  readonly persisted: boolean;
  readonly secretsRedacted: true;
  readonly redactedFields: readonly string[];
}

export interface TauriAssistantProviderConfigureRequest {
  readonly provider?: "openai-compatible";
  readonly endpoint?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly clear?: boolean;
}

export interface TauriAssistantProviderClient {
  readonly provider: LightweightAssistantProvider;
  status(): Promise<TauriAssistantProviderStatus>;
  configure(request: TauriAssistantProviderConfigureRequest): Promise<TauriAssistantProviderStatus>;
}

export interface TauriAssistantProviderOptions {
  readonly invoke: TauriAssistantProviderInvoke;
}

export function createTauriAssistantProviderClient(
  options: TauriAssistantProviderOptions,
): TauriAssistantProviderClient {
  return {
    provider: {
      complete: (request) => completeWithTauriProvider(options.invoke, request),
    },
    status: () => readProviderStatus(options.invoke),
    configure: (request) => configureProvider(options.invoke, request),
  };
}

async function readProviderStatus(
  invoke: TauriAssistantProviderInvoke,
): Promise<TauriAssistantProviderStatus> {
  return parseStatus(await invoke("aurora_assistant_provider_status"));
}

async function configureProvider(
  invoke: TauriAssistantProviderInvoke,
  request: TauriAssistantProviderConfigureRequest,
): Promise<TauriAssistantProviderStatus> {
  return parseStatus(await invoke("aurora_assistant_provider_configure", { request }));
}

async function completeWithTauriProvider(
  invoke: TauriAssistantProviderInvoke,
  request: LightweightProviderRequest,
): Promise<LightweightProviderResponse> {
  if (request.signal.aborted) {
    throw new LightweightOrchestratorError("provider_call_cancelled");
  }
  const response = await invoke("aurora_assistant_provider_complete", {
    request: {
      messages: request.messages,
      tools: request.tools,
      maxToolCalls: request.maxToolCalls,
    },
  });
  return parseProviderResponse(response);
}

function parseStatus(raw: unknown): TauriAssistantProviderStatus {
  if (!isRecord(raw)) throw new LightweightOrchestratorError("provider_status_malformed");
  const provider = raw.provider === "openai-compatible" ? raw.provider : null;
  if (!provider) throw new LightweightOrchestratorError("provider_status_malformed");
  if (raw.secretsRedacted !== true) {
    throw new LightweightOrchestratorError("provider_status_unredacted");
  }
  return {
    configured: raw.configured === true,
    enabled: raw.enabled === true,
    provider,
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : null,
    model: typeof raw.model === "string" ? raw.model : null,
    backend: raw.backend === "platform-keychain" ? raw.backend : "platform-keychain",
    persisted: raw.persisted === true,
    secretsRedacted: true,
    redactedFields: stringArray(raw.redactedFields),
  };
}

function parseProviderResponse(raw: unknown): LightweightProviderResponse {
  if (!isRecord(raw)) throw new LightweightOrchestratorError("provider_response_malformed");
  if (raw.type === "message") {
    return { type: "message", content: stringValue(raw.content) };
  }
  if (raw.type === "tool_calls") {
    const toolCalls = Array.isArray(raw.toolCalls)
      ? raw.toolCalls.map(parseToolCall)
      : null;
    if (!toolCalls) throw new LightweightOrchestratorError("provider_response_malformed");
    return {
      type: "tool_calls",
      content: typeof raw.content === "string" ? raw.content : null,
      toolCalls,
    };
  }
  throw new LightweightOrchestratorError("provider_response_malformed");
}

function parseToolCall(raw: unknown): LightweightToolCall {
  if (!isRecord(raw)) throw new LightweightOrchestratorError("provider_response_malformed");
  const route = raw.route === "local" || raw.route === "remote" ? raw.route : null;
  if (!route) throw new LightweightOrchestratorError("provider_response_malformed");
  const args = raw.arguments;
  if (!isRecord(args)) throw new LightweightOrchestratorError("provider_response_malformed");
  return {
    id: stringValue(raw.id),
    toolName: stringValue(raw.toolName),
    providerToolName: stringValue(raw.providerToolName),
    arguments: args as LightweightToolCall["arguments"],
    route,
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new LightweightOrchestratorError("provider_response_malformed");
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
