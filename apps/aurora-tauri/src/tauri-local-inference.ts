import {
  LocalInferenceClient,
  createLocalCompositeProvider,
  type LocalInferenceInvoke,
} from "@aurora/client/local-inference";
import type { LightweightProviderRequest } from "@aurora/client/lightweight-orchestrator";
import {
  LightweightOrchestratorError,
  type LightweightAssistantProvider,
} from "@aurora/client/lightweight-orchestrator";

export const DEFAULT_OFFLINE_ASSISTANT_MODEL = "chat-qwen3-0b8";
export const CACTUS_OFFLINE_ASSISTANT_MODEL = "chat-qwen3-06b-cactus";
export const NEEDLE2_LOCAL_ACTIONS_MODEL = "actions-needle2";

export interface NativeLocalInferenceSelection {
  readonly chatModelId: string;
  readonly actionsModelId?: string;
  readonly engines: Awaited<ReturnType<LocalInferenceClient["engines"]>>;
}

const selections = new WeakMap<LocalInferenceClient, Promise<NativeLocalInferenceSelection>>();

/** Select model IDs only from the capabilities reported by the native owner. */
export function resolveNativeLocalInferenceSelection(
  client: LocalInferenceClient,
): Promise<NativeLocalInferenceSelection> {
  const existing = selections.get(client);
  if (existing) return existing;
  const pending = (async () => {
    let engines: NativeLocalInferenceSelection["engines"] = [];
    let catalog: Awaited<ReturnType<LocalInferenceClient["catalog"]>> = [];
    try { engines = await client.engines(); } catch { /* Keep the supported default selection. */ }
    try { catalog = await client.catalog(); } catch { /* Optional action-model discovery. */ }
    const chatModelId = engines.some((engine) => engine.engine === "cactus")
      ? CACTUS_OFFLINE_ASSISTANT_MODEL
      : DEFAULT_OFFLINE_ASSISTANT_MODEL;
    const actionsModelId = catalog.some((model) =>
      model.modelId === NEEDLE2_LOCAL_ACTIONS_MODEL && model.capabilities.tools && !model.capabilities.chat
    ) ? NEEDLE2_LOCAL_ACTIONS_MODEL : undefined;
    return { chatModelId, ...(actionsModelId ? { actionsModelId } : {}), engines };
  })();
  selections.set(client, pending);
  return pending;
}

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
  let models: Promise<NativeLocalInferenceSelection> | null = null;
  const localModels = () => models ??= resolveNativeLocalInferenceSelection(client);
  let localProvider: LightweightAssistantProvider | null = null;
  const localProviderFor = async (selection: NativeLocalInferenceSelection) => {
    if (!localProvider) {
      localProvider = createLocalCompositeProvider({
        client,
        chat: { modelId: selection.chatModelId, sessionId },
        ...(selection.actionsModelId
          ? { actions: { modelId: selection.actionsModelId, sessionId } }
          : {}),
      });
    }
    return localProvider;
  };
  const turnRoutes = new WeakMap<AbortSignal, "peer" | "local">();
  const turnModels = new WeakMap<AbortSignal, string>();
  let legacyRoute: "peer" | "local" | undefined;
  let legacyModel: string | undefined;
  let loadedModelId: string | null = null;
  let localQueue: Promise<void> = Promise.resolve();

  const prepareModel = async (modelId: string) => {
    if (loadedModelId !== modelId) {
      if (loadedModelId !== null) {
        await client.sessionDestroy(sessionId);
        loadedModelId = null;
      }
      const status = await client.modelStatus(modelId);
      if (status.state !== "ready") return false;
      await client.sessionCreate(modelId, sessionId);
      loadedModelId = modelId;
      return true;
    }
    const status = await client.modelStatus(modelId);
    if (status.state === "ready") return true;
    await client.sessionDestroy(sessionId);
    loadedModelId = null;
    return false;
  };

  const provider: LightweightAssistantProvider = {
    async complete(request) {
      if (request.signal.aborted || request.turnSignal?.aborted) {
        throw new LightweightOrchestratorError("provider_call_cancelled");
      }
      const turnSignal = request.turnSignal;
      let route = turnSignal ? turnRoutes.get(turnSignal) : legacyRoute;
      const startsLegacyTurn = !turnSignal && request.messages.at(-1)?.role === "user";
      if (startsLegacyTurn) { route = undefined; legacyModel = undefined; }
      if (!route) {
        route = options.peerReady() ? "peer" : "local";
        if (route === "local" && (!options.enabled || request.providerId)) {
          throw new LightweightOrchestratorError("unavailable_service", "Connect an approved device to continue");
        }
        if (turnSignal) turnRoutes.set(turnSignal, route);
        else legacyRoute = route;
      }
      if (route === "peer") return options.peerProvider.complete(request);

      const selection = await localModels();
      const actionTurn = hasLocalToolIntent(request);
      const existingTurnModel = turnSignal ? turnModels.get(turnSignal) : legacyModel;
      let modelId = existingTurnModel;
      if (!modelId) {
        const requested = request.modelId;
        if (requested != null
          && requested !== selection.chatModelId
          && requested !== selection.actionsModelId) {
          throw new LightweightOrchestratorError("unavailable_service", "Selected on-device assistant is unavailable");
        }
        const useActions = selection.actionsModelId !== undefined
          && (requested === selection.actionsModelId || (requested == null && actionTurn));
        modelId = useActions ? selection.actionsModelId! : selection.chatModelId;
        if (turnSignal) turnModels.set(turnSignal, modelId);
        else legacyModel = modelId;
      } else if (request.modelId != null && request.modelId !== modelId) {
        throw new LightweightOrchestratorError("unavailable_service", "Selected on-device assistant is unavailable");
      }

      const current = localQueue.then(async () => {
        if (request.signal.aborted || request.turnSignal?.aborted) {
          throw new LightweightOrchestratorError("provider_call_cancelled");
        }
        await prepareModel(modelId!);
        if (request.signal.aborted || request.turnSignal?.aborted) {
          throw new LightweightOrchestratorError("provider_call_cancelled");
        }
        return (await localProviderFor(selection)).complete(request);
      });
      localQueue = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  return {
    client,
    provider,
    close: () => client.close(),
  };
}

function hasLocalToolIntent(request: LightweightProviderRequest): boolean {
  if (request.tools.some((tool) =>
    tool.execution_location === "local" && tool.source_type === "local" && tool.provider_available !== false
  )) return true;
  let lastUserIndex = -1;
  request.messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  return request.messages.slice(lastUserIndex + 1).some((message) =>
    message.role === "assistant" && message.toolCalls?.some((call) => call.route === "local") === true
  );
}
