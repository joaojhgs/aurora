import {
  LocalInferenceClient,
  createLocalCompositeProvider,
  type LocalInferenceInvoke,
} from "@aurora/client/local-inference";
import {
  LightweightOrchestratorError,
  type LightweightAssistantProvider,
} from "@aurora/client/lightweight-orchestrator";

export const DEFAULT_OFFLINE_ASSISTANT_MODEL = "chat-qwen3-0b8";

/** Choose a ready peer before starting a turn, or the explicitly enabled device assistant. */
export function createTauriLocalAssistantRouter(options: {
  invoke: LocalInferenceInvoke;
  peerProvider: LightweightAssistantProvider;
  peerReady: () => boolean;
  enabled: boolean;
  sessionId?: string;
}) {
  const client = new LocalInferenceClient(options.invoke);
  const sessionId = options.sessionId ?? `local-assistant-${crypto.randomUUID()}`;
  const localProvider = createLocalCompositeProvider({
    client,
    chat: { modelId: DEFAULT_OFFLINE_ASSISTANT_MODEL, sessionId },
  });
  const turnRoutes = new WeakMap<AbortSignal, "peer" | "local">();
  let legacyRoute: "peer" | "local" | undefined;
  const provider: LightweightAssistantProvider = {
    async complete(request) {
      if (request.signal.aborted || request.turnSignal?.aborted) {
        throw new LightweightOrchestratorError("provider_call_cancelled");
      }
      const turnSignal = request.turnSignal;
      let route = turnSignal ? turnRoutes.get(turnSignal) : legacyRoute;
      if (!turnSignal && request.messages.at(-1)?.role === "user") route = undefined;
      if (!route) {
        route = options.peerReady() ? "peer" : "local";
        if (route === "local" && (!options.enabled || request.providerId)) {
          throw new LightweightOrchestratorError("unavailable_service", "Connect an approved device to continue");
        }
        if (turnSignal) turnRoutes.set(turnSignal, route);
        else legacyRoute = route;
      }
      if (route === "peer") return options.peerProvider.complete(request);
      const modelId = request.modelId ?? DEFAULT_OFFLINE_ASSISTANT_MODEL;
      await client.sessionCreate(modelId, sessionId);
      if (request.signal.aborted) {
        throw new LightweightOrchestratorError("provider_call_cancelled");
      }
      return localProvider.complete(request);
    },
  };
  return { client, provider, close: () => client.close() };
}
