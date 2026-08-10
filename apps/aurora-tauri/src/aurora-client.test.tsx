import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AuroraClient as Aurora,
  AuroraError,
  AUTH_METHODS,
  GATEWAY_METHODS,
  MockAuroraTransport,
  ORCHESTRATOR_METHODS,
  ORCHESTRATOR_MODEL_METHODS,
  STT_METHODS,
  TOOLING_METHODS,
  capabilityCatalogFixture,
  cloneFixture,
  modelRuntimeCatalogFixture,
  nativeCapabilityManifestFixture,
  routeExplainFixture,
  type AuroraTransportRequest,
  type ToolingGetExportCatalogResponse,
} from "@aurora/client";
import {
  auroraNavSections,
  buildShellSnapshot,
  getProductionRouteOracle,
  loadingShellSnapshot,
  encodeMeshInviteToken,
  webRtcProfileFromInvite,
  type BrowserWebRtcSnapshot,
  type NativeDesktopVoicePort,
} from "@aurora/ui";
import {
  MemoryLocalDataBackend,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LightweightMemoryRecord,
  type LocalDataSession,
} from "@aurora/client/local-data";
import {
  computeProjectionChecksum,
  computeProjectionPageHash,
} from "@aurora/client/local-tools";
import type {
  ProviderLocalApprovalControllerPort,
  ProviderLocalApprovalSnapshot,
} from "@aurora/client/local-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuroraTauriRuntime,
  loadTauriRemoteAssistantTools,
  type AuroraThinConnectionProfile,
} from "./aurora-client";
import {
  AuroraTauriApp,
  rebuildAuroraThinRuntime,
  routeForPath,
  tauriRouteRegistryRouteIds,
  type AuroraTauriRuntime,
} from "./tauri-app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const primaryNavItems = auroraNavSections.flatMap((section) => section.items);

const PLACEHOLDER_MARKERS = [
  "A full product page still needs to be mounted",
  "rendering the assistant diagnostics on the wrong page",
  "TauriRoutePlaceholder",
  "ata-placeholder-panel",
  "debug-dashboard",
] as const;

const DIAGNOSTICS_PAGE_MARKERS = [
  "Troubleshooting",
  "Live checks",
  "Privacy check",
  "Support export",
  "Service checks",
  "App logs",
] as const;

const adminRouteIds = new Set([
  "admin",
  "services",
  "access",
  "tokens",
  "backups",
  "scheduler",
  "audit",
]);

const TAURI_RENDERED_ROUTE_LANDMARK_OVERRIDES: Record<
  string,
  readonly string[]
> = {
  native: ["Device controls", "Device permissions"],
  tools: [
    "Tools & Plugins",
    "Review tool sources",
  ],
  mesh: ["Connected devices", "Connect trusted devices and choose what each one can use."],
  backups: ["Backups", "Snapshots, verification and restore"],
  settings: ["Settings", "Connection choices"],
  models: ["Models & Sources", "Loading model sources from Aurora"],
  onboarding: ["Welcome to Aurora", "Detected installation"],
};

function expectedRenderedLandmarks(
  routeId: string,
  oracle: ReturnType<typeof getProductionRouteOracle>,
): readonly string[] {
  return (
    TAURI_RENDERED_ROUTE_LANDMARK_OVERRIDES[routeId] ??
    oracle?.renderedLandmarks ??
    []
  );
}

const runtimeRouteIds = new Set(["settings", "models"]);

function thinRuntimeProfile(
  mode: "http-only" | "webrtc-only" | "webrtc-preferred",
  gatewayUrl = mode === "webrtc-only" ? "" : "https://gateway.example.test",
): AuroraThinConnectionProfile {
  const base: AuroraThinConnectionProfile = {
    id: `test-${mode}`,
    label: `Test ${mode}`,
    mode,
    gatewayUrl,
    signalingUrl: mode === "http-only" ? "" : "wss://signaling.example.test",
    nodeName: "Aurora test thin client",
    localStablePeerId: `aurora-test-${mode}`,
  };
  if (mode !== "http-only") {
    base.webrtcProfile = {
      mode,
      appId: "aurora",
      room: "test-room",
      roomSecretRef: "ref:test:test-room",
      signalingBrokers: ["wss://signaling.example.test"],
      nodeName: base.nodeName,
    };
  }
  return base;
}

function thinRuntimeDocument(profile: AuroraThinConnectionProfile) {
  return {
    version: 1 as const,
    activeProfileId: profile.id,
    profiles: [profile],
  };
}

class RecordingMockAuroraTransport extends MockAuroraTransport {
  readonly requests: AuroraTransportRequest[] = [];

  constructor() {
    super();
    this.register("DB.ListSessions", () => ({
      sessions: [],
      active_session_id: null,
      total: 0,
    }));
  }

  override async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>,
  ) {
    this.requests.push(request);
    return super.request<TData, TPayload>(request);
  }
}
function tauriLocalTransportProxy(transport: RecordingMockAuroraTransport) {
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property === "kind") return "tauri-local";
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof transport;
}

function nativeMobileTransportProxy(transport: RecordingMockAuroraTransport) {
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property === "kind") return "native-mobile";
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof transport;
}

function testRuntime(
  client: Aurora,
  modePreferenceStore?: AuroraTauriRuntime["modePreferenceStore"],
): AuroraTauriRuntime {
  return {
    client,
    mode: "mock",
    thinConnectionMode: "http-only",
    thinDiagnostics: () => ["mode=http-only", "mock runtime"],
    modePreferenceStore,
    thinProfileConfigured: true,
    requiresOnboarding: false,
    pendingThinInviteText: null,
    sidecarStatus: async () => null,
    startSidecar: async () => null,
    stopSidecar: async () => null,
    nativePermissionStatus: async () => null,
    trayStatus: async () => null,
    notificationStatus: async () => null,
    iosVoiceStatus: async () => null,
    iosInvocationStatus: async () => null,
    iosLocalLightInferenceStatus: async () => null,
    iosBackgroundStatus: async () => null,
    dialogStatus: async () => null,
    audioBridgeStatus: async () => null,
    iosSecureStorageStatus: async () => null,
    iosBiometricStatus: async () => null,
    androidBaselineStatus: async () => null,
    androidForegroundStatus: async () => null,
    androidMediaPolicyStatus: async () => null,
    dispose: async () => undefined,
    shutdown: async () => undefined,
  };
}

function fakeLocalApprovalController() {
  let snapshot: ProviderLocalApprovalSnapshot = {
    pending: [
      {
        id: "local-approval-safe-id",
        toolDisplayName: "Share text",
        toolDescription: "Share selected text through this device.",
        callerPeerId: "peer-must-not-render",
        displayArgsPreview: {
          title: "Launch note",
          text: "Aurora is ready",
        },
        createdAtMs: 1_000,
        expiresAtMs: 301_000,
      },
    ],
    revision: 1,
  };
  const listeners = new Set<(next: ProviderLocalApprovalSnapshot) => void>();
  const decide = vi.fn((approvalId: string, choice: "approve" | "deny") => {
    if (approvalId !== snapshot.pending[0]?.id) return false;
    snapshot = { pending: [], revision: snapshot.revision + 1 };
    for (const listener of listeners) listener(snapshot);
    return choice === "approve" || choice === "deny";
  });
  const controller: ProviderLocalApprovalControllerPort = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    decide,
    awaitApproval: async () => ({
      status: "closed",
      approvalId: "local-approval-safe-id",
    }),
    releaseClaim: () => false,
    consumeClaim: () => false,
    close: () => undefined,
  };
  return { controller, decide };
}

function testMeshInviteText(): string {
  return encodeMeshInviteToken({
    kind: "aurora.mesh.invite",
    generated_at: "2026-07-26T00:00:00.000Z",
    node: { peer_id: "peer-host", node_name: "Aurora host" },
    signaling: {
      provider: "mqtt",
      room: "tauri-room",
      room_password: "tauri-secret",
      app_id: "aurora",
      mqtt_brokers: ["wss://broker.example/mqtt"],
    },
    webrtc: { app_layer_e2ee: true, stun_servers: ["stun:stun.example:3478"] },
  });
}

function fakeThinPeer(
  snapshot: Partial<BrowserWebRtcSnapshot> = {},
): NonNullable<AuroraTauriRuntime["thinPeer"]> {
  const base: BrowserWebRtcSnapshot = {
    state: "idle",
    connectionMode: "webrtc-only",
    icePathCategory: "unknown",
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
    status: "needs-invite",
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: false,
    ...snapshot,
  };
  return {
    snapshot: () => base,
    subscribe: (listener: (next: BrowserWebRtcSnapshot) => void) => {
      listener(base);
      return () => undefined;
    },
    importInvite: (inviteText: string) => webRtcProfileFromInvite(inviteText)!,
    connect: async () => undefined,
    confirmPairing: async () => undefined,
    rejectPairing: async () => undefined,
    disconnect: async () => undefined,
    isFallbackEligibleAfterWebRtcRoute: () => false,
    markFallback: () => undefined,
  } as unknown as NonNullable<AuroraTauriRuntime["thinPeer"]>;
}

function controllableThinPeer(
  snapshot: Partial<BrowserWebRtcSnapshot> = {},
): {
  peer: NonNullable<AuroraTauriRuntime["thinPeer"]>;
  emit: (next: Partial<BrowserWebRtcSnapshot>) => void;
} {
  let current = fakeThinPeer(snapshot).snapshot();
  const listeners = new Set<(next: BrowserWebRtcSnapshot) => void>();
  const peer = {
    ...fakeThinPeer(snapshot),
    snapshot: () => current,
    subscribe: (listener: (next: BrowserWebRtcSnapshot) => void) => {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as NonNullable<AuroraTauriRuntime["thinPeer"]>;
  return {
    peer,
    emit(next) {
      current = { ...current, ...next };
      for (const listener of listeners) listener(current);
    },
  };
}

function unconfiguredThinRuntime(
  mode: "desktop-thin" | "mobile-native",
  client: Aurora,
): AuroraTauriRuntime {
  const document = {
    version: 1 as const,
    activeProfileId: null,
    profiles: [],
  };
  let runtime!: AuroraTauriRuntime;
  const controller: NonNullable<AuroraTauriRuntime["thinProfileController"]> = {
    evidence: "test narrow runtime profile store",
    document,
    saveProfile: async (profile) => ({
      version: 1,
      activeProfileId: profile.id,
      profiles: [profile],
    }),
    selectProfile: async () => document,
    createRuntime: async () => runtime,
  };
  runtime = {
    ...testRuntime(client),
    mode,
    thinConnectionMode: "http-only",
    thinPeer: fakeThinPeer({ status: "needs-invite" }),
    thinProfileConfigured: false,
    requiresOnboarding: true,
    pendingThinInviteText: null,
    thinProfileController: controller,
  };
  return runtime;
}

async function mountOutcomeApp(runtime: AuroraTauriRuntime) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuroraTauriApp runtimeOverride={runtime} />);
    await flushReactWork();
  });
  return { container, root };
}

async function flushReactWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flushReactWork();
      });
    }
  }
  throw lastError;
}

async function navigateByHref(container: HTMLElement, href: string) {
  const link = Array.from(
    container.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`),
  )[0];
  expect(link, `navigation link for ${href}`).toBeDefined();
  await act(async () => {
    link!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushReactWork();
  });
}

async function clickButtonByLabel(container: HTMLElement, label: string) {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.includes(label),
  );
  expect(button, `button ${label}`).toBeDefined();
  expect(button?.disabled, `button ${label} should be enabled`).toBe(false);
  await act(async () => {
    button!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushReactWork();
  });
}

async function clickButtonInRegion(
  container: HTMLElement,
  regionText: string,
  label: string,
) {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => {
    if (!candidate.textContent?.includes(label)) return false;
    let current: HTMLElement | null = candidate;
    while (current && current !== container) {
      if (current.textContent?.includes(regionText)) return true;
      current = current.parentElement;
    }
    return false;
  });
  expect(button, `button ${label} in region ${regionText}`).toBeDefined();
  expect(
    button?.disabled,
    `button ${label} in region ${regionText} should be enabled`,
  ).toBe(false);
  await act(async () => {
    button!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flushReactWork();
  });
}

async function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReactWork();
  });
}

function requestMethods(transport: RecordingMockAuroraTransport): string[] {
  return transport.requests.map((request) => request.method);
}

function writeOutcomeArtifact(name: string, html: string) {
  const reportDir = join(process.cwd(), "reports", "e2e-outcomes");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${name}.html`), html);
}

function adminDraftFixture(methodId: string) {
  const suffix = methodId.replace(".", "-");
  return {
    action_id: `aa-${suffix}`,
    nonce: `nonce-${suffix}`,
    digest: `digest-${suffix}`,
    method_id: methodId,
    affected_resources: ["services.orchestrator.llm.provider"],
    required_phrase: "CONFIRM",
    required_reason: true,
    required_reauth: true,
    expires_at: "2026-06-25T12:05:00Z",
    expires_in_seconds: 300,
    confirmation_headers: {
      action_id: "X-Aurora-AdminAction-Id",
      confirmation_token: "X-Aurora-AdminAction-Token",
      digest: "X-Aurora-AdminAction-Digest",
    },
  };
}

function adminConfirmFixture(actionId: string) {
  const suffix = actionId.replace("aa-", "");
  return {
    action_id: actionId,
    confirmation_token: `token-${suffix}`,
    digest: `digest-${suffix}`,
    confirmed: true,
    expires_at: "2026-06-25T12:05:00Z",
    audit_receipt: `audit-${suffix}`,
    confirmation_headers: {
      action_id: "X-Aurora-AdminAction-Id",
      confirmation_token: "X-Aurora-AdminAction-Token",
      digest: "X-Aurora-AdminAction-Digest",
    },
  };
}

function assistantCapabilityCatalog() {
  const catalog = cloneFixture(capabilityCatalogFixture);
  const baseProvider = catalog.providers[0]!;
  const baseAction = catalog.actions[0]!;
  const toolingProvider = {
    ...baseProvider,
    provider_id: "local:Tooling",
    provider_kind: "local" as const,
    peer_id: "local-peer",
    node_name: "local Aurora node",
    service_instance_id: "tooling-local",
    module: "Tooling",
    eligible: true,
    reason_code: "available",
    reason: "Local Aurora exposes its tool catalog.",
    policy: {
      ...baseProvider.policy,
      required_permissions: ["Tooling.GetToolCatalog"],
      explicit_selector_required: false,
      consent_required: false,
      privacy_indicator_required: false,
      approval_required: false,
      selector_required: false,
      denial_reasons: [],
    },
  };
  const toolingAction = {
    ...baseAction,
    action_id: "tooling-get-tool-catalog-local",
    module: "Tooling",
    method: "GetToolCatalog",
    topic: TOOLING_METHODS.listCatalog,
    provider_id: toolingProvider.provider_id,
    provider_kind: toolingProvider.provider_kind,
    peer_id: toolingProvider.peer_id,
    service_instance_id: toolingProvider.service_instance_id,
    selector: {
      peer_id: toolingProvider.peer_id,
      module: "Tooling",
      provider_id: toolingProvider.provider_id,
    },
    bindability: "available" as const,
    route_blockers: [],
    summary: "Open the local Aurora tool catalog.",
    policy: toolingProvider.policy,
    freshness: toolingProvider.freshness,
  };
  const provider = {
    ...baseProvider,
    provider_id: "local:Orchestrator",
    provider_kind: "local",
    peer_id: "local-peer",
    node_name: "local Aurora node",
    service_instance_id: "orchestrator-local",
    module: "Orchestrator",
    eligible: true,
    reason_code: "available",
    reason:
      "Local Gateway advertises Orchestrator.ExternalUserInput for assistant prompts.",
    policy: {
      ...baseProvider.policy,
      required_permissions: ["Orchestrator.use"],
      explicit_selector_required: false,
      consent_required: false,
      privacy_indicator_required: false,
      approval_required: false,
      selector_required: false,
      denial_reasons: [],
    },
  };
  const action = {
    ...baseAction,
    action_id: "orchestrator-external-user-input-local",
    module: "Orchestrator",
    method: "ExternalUserInput",
    topic: ORCHESTRATOR_METHODS.externalUserInput,
    provider_id: provider.provider_id,
    provider_kind: provider.provider_kind,
    peer_id: provider.peer_id,
    service_instance_id: provider.service_instance_id,
    selector: {
      peer_id: "local-peer",
      module: "Orchestrator",
      provider_id: provider.provider_id,
    },
    bindability: "available",
    route_blockers: [],
    summary:
      "Send an assistant prompt through the local Gateway and Orchestrator.",
    policy: provider.policy,
    freshness: provider.freshness,
  };
  const interruptAction = {
    ...baseAction,
    action_id: "orchestrator-interrupt-local",
    module: "Orchestrator",
    method: "Interrupt",
    topic: ORCHESTRATOR_METHODS.interrupt,
    provider_id: provider.provider_id,
    provider_kind: provider.provider_kind,
    peer_id: provider.peer_id,
    service_instance_id: provider.service_instance_id,
    selector: {
      peer_id: "local-peer",
      module: "Orchestrator",
      provider_id: provider.provider_id,
    },
    bindability: "available",
    route_blockers: [],
    summary:
      "Stop or cancel the active assistant generation through the local Orchestrator interrupt contract.",
    policy: provider.policy,
    freshness: provider.freshness,
  };
  catalog.providers = [...catalog.providers, toolingProvider, provider];
  catalog.actions = [...catalog.actions, toolingAction, action, interruptAction];
  catalog.provider_index = {
    ...catalog.provider_index,
    Tooling: [toolingProvider.provider_id],
    Orchestrator: [provider.provider_id],
  };
  catalog.action_index = {
    ...catalog.action_index,
    Tooling: [toolingAction.action_id],
    [TOOLING_METHODS.listCatalog]: [toolingAction.action_id],
    Orchestrator: [action.action_id, interruptAction.action_id],
    [ORCHESTRATOR_METHODS.externalUserInput]: [action.action_id],
    [ORCHESTRATOR_METHODS.interrupt]: [interruptAction.action_id],
  };
  return catalog;
}

function assistantGatewayTransport(
  responseText = "Local Gateway says hello from Orchestrator.",
): RecordingMockAuroraTransport {
  const transport = new RecordingMockAuroraTransport();
  transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
  transport.register(GATEWAY_METHODS.getCapabilityCatalog, () =>
    assistantCapabilityCatalog(),
  );
  transport.register(GATEWAY_METHODS.explainRoute, () => ({
    topic: ORCHESTRATOR_METHODS.externalUserInput,
    module: "Orchestrator",
    selected_target: "local",
    selected_peer_id: "local-peer",
    selected_service_instance_id: "orchestrator-local",
    selected_provider_id: "local:Orchestrator",
    selector_valid: true,
    selector_validation_code: "ok",
    selector_validation_message:
      "Local assistant route selected by backend policy.",
    fallback_behavior: "none",
    candidates: [
      {
        provider_id: "local:Orchestrator",
        peer_id: "local-peer",
        provider_kind: "local",
        service_instance_id: "orchestrator-local",
        module: "Orchestrator",
        version: "test",
        included: true,
        selected: true,
        reason_code: "available",
        reason: "Local Gateway advertises Orchestrator.ExternalUserInput.",
        latency_ms: 8,
        active_calls: 0,
        max_concurrent: 4,
        available_capacity: 4,
        blockers: [],
      },
    ],
    blockers: [],
    security_privacy_blockers: [],
    secrets_redacted: true,
  }));
  transport.register(ORCHESTRATOR_METHODS.interrupt, (request) => ({
    interrupt_id: "interrupt-tauri-assistant",
    status: "cancelled",
    requested_scopes: (request.payload as { scopes?: string[] } | undefined)
      ?.scopes ?? ["generation", "tool_call", "tts_playback", "session"],
    results: [
      {
        scope: "generation",
        status: "cancelled",
        message: "mock assistant generation cancelled",
        cancelled_count: 1,
      },
    ],
    session_id:
      (request.payload as { session_id?: string | null } | undefined)
        ?.session_id ?? null,
    request_id:
      (request.payload as { request_id?: string | null } | undefined)
        ?.request_id ?? null,
    event_topic: "Orchestrator.Interrupted",
    audit_event: "audit:orchestrator:interrupt:tauri-assistant",
    idempotent: false,
  }));
  transport.register(ORCHESTRATOR_METHODS.externalUserInput, (request) => ({
    text: responseText,
    session_id: "tauri-assistant-session",
    request_id: (request.payload as { request_id?: string }).request_id,
    correlation_id: (request.payload as { correlation_id?: string })
      .correlation_id,
    metadata: { model: "local-gateway-test" },
  }));
  return transport;
}

function assistantGatewayStreamingTransport(): RecordingMockAuroraTransport {
  const transport = assistantGatewayTransport(
    "Streaming request accepted by local Orchestrator.",
  );
  transport.stream("assistant", async function* (request) {
    yield {
      id: "assistant-stream-delta-e2e",
      kind: "assistant.delta",
      correlation_id: request.correlationId,
      payload: {
        delta: "Streaming partial backend text...",
        session_id: "tauri-stream-session",
        request_id: request.correlationId,
        metadata: { model: "local-stream-test" },
      },
    };
    yield {
      id: "assistant-stream-tool-e2e",
      kind: "tool.requested",
      correlation_id: "corr-tool-e2e",
      payload: {
        text: "Tool approval pending until the Tools route returns a decision.",
        session_id: "tauri-stream-session",
        request_id: request.correlationId,
        metadata: {
          model: "local-stream-test",
          name: "Tooling.RequestApproval",
          status: "requested",
          risk_class: "requires-approval",
          target: "local tool registry",
          data_leaves_device: false,
          summary: "Approve or deny through the Tools approval surface.",
          payload_preview: { token: "[redacted]", args_hash: "payload_hash" },
        },
      },
    };
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) {
        resolve();
        return;
      }
      request.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  });
  return transport;
}

function assistantGatewayAuthFailureTransport(): RecordingMockAuroraTransport {
  const transport = new RecordingMockAuroraTransport();
  transport.register(GATEWAY_METHODS.getCapabilityCatalog, () =>
    assistantCapabilityCatalog(),
  );
  transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
  transport.register(ORCHESTRATOR_METHODS.externalUserInput, () => {
    throw new AuroraError({
      code: "auth",
      message: "Gateway returned 401 for assistant prompt",
      method: ORCHESTRATOR_METHODS.externalUserInput,
      busTopic: ORCHESTRATOR_METHODS.externalUserInput,
    });
  });
  return transport;
}

function memoryCapabilityCatalog() {
  const catalog = cloneFixture(capabilityCatalogFixture);
  const baseProvider = catalog.providers[0]!;
  const baseAction = catalog.actions[0]!;
  const provider = {
    ...baseProvider,
    provider_id: "local:DB",
    provider_kind: "local",
    peer_id: "local-peer",
    node_name: "local Aurora node",
    service_instance_id: "db-local",
    module: "DB",
    eligible: true,
    reason_code: "available",
    reason:
      "Local Gateway advertises DB.RAGSearch for the production memory route.",
    policy: {
      ...baseProvider.policy,
      required_permissions: ["DB.use"],
      explicit_selector_required: false,
      consent_required: false,
      privacy_indicator_required: false,
      approval_required: false,
      selector_required: false,
      denial_reasons: [],
    },
  };
  const action = {
    ...baseAction,
    action_id: "db-rag-search-local",
    module: "DB",
    method: "RAGSearch",
    topic: "DB.RAGSearch",
    provider_id: provider.provider_id,
    provider_kind: provider.provider_kind,
    peer_id: provider.peer_id,
    service_instance_id: provider.service_instance_id,
    selector: {
      peer_id: "local-peer",
      module: "DB",
      provider_id: provider.provider_id,
    },
    bindability: "available",
    route_blockers: [],
    summary: "Search local memory and RAG namespaces through the DB service.",
    policy: provider.policy,
    freshness: provider.freshness,
  };
  catalog.providers = [...catalog.providers, provider];
  catalog.actions = [...catalog.actions, action];
  catalog.provider_index = {
    ...catalog.provider_index,
    DB: [provider.provider_id],
  };
  catalog.action_index = {
    ...catalog.action_index,
    DB: [action.action_id],
    "DB.RAGSearch": [action.action_id],
  };
  return catalog;
}

function memoryGatewayTransport(): RecordingMockAuroraTransport {
  const transport = new RecordingMockAuroraTransport();
  transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
  transport.register(GATEWAY_METHODS.getCapabilityCatalog, () =>
    memoryCapabilityCatalog(),
  );
  return transport;
}

async function tauriMeshNodeMemoryRuntime({
  ownerAvailable = true,
}: {
  ownerAvailable?: boolean;
} = {}): Promise<AuroraTauriRuntime> {
  const backend = new MemoryLocalDataBackend({ schemaVersion: 3 });
  const session = await backend.open("profile-1", "node-1");
  await seedTauriLocalData(session);
  return {
    ...testRuntime(new Aurora({ transport: memoryGatewayTransport() })),
    mode: "desktop-thin",
    thinConnectionMode: "webrtc-only",
    nodeMode: "mesh-node",
    runtimeTier: "lightweight-ts",
    localNodeProviderStatus: {
      available: true,
      reasonCode: null,
      registeredToolIds: ["native-actions.share-text"],
    },
    localData: {
      profileId: "profile-1",
      localNodeId: "node-1",
      session,
      crypto: new TestEnvelopeCryptoPort(),
      ownerAvailable,
    },
    dispose: async () => backend.close(),
    shutdown: async () => backend.close(),
  };
}

function unavailableTauriMeshNodeRuntime(): AuroraTauriRuntime {
  return {
    ...testRuntime(new Aurora({ transport: memoryGatewayTransport() })),
    mode: "desktop-thin",
    thinConnectionMode: "webrtc-only",
    nodeMode: "mesh-node",
    runtimeTier: "lightweight-ts",
    localNodeProviderStatus: {
      available: false,
      reasonCode: "durable_store_unavailable",
      registeredToolIds: [],
    },
  };
}

async function seedTauriLocalData(session: LocalDataSession): Promise<void> {
  await session.conversations.upsertConversation(
    conversationFixture({ id: "conversation-local", updatedAtMs: 1_000 }),
  );
  await session.conversations.appendMessage(
    messageFixture({
      id: "message-local",
      conversationId: "conversation-local",
      sequence: 1,
    }),
  );
  await session.memory.upsertMemoryItem(
    memoryFixture({ id: "memory-local", namespace: "notes" }),
  );
}

const encryptedEnvelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: "AES-GCM-256",
  keyId: "key-1",
  nonceB64Url: "AAAAAAAAAAAAAAAA",
  ciphertextAndTagB64Url: "AAAAAAAAAAAAAAAAAAAAAA",
  createdAtMs: 1,
});

class TestEnvelopeCryptoPort implements EnvelopeCryptoPort {
  async encrypt(
    _keyPurpose: LocalDataKeyPurpose,
    _plaintext: Uint8Array,
    _aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    return encryptedEnvelopeFixture;
  }

  async decrypt(
    _envelope: EncryptedDataEnvelopeV1,
    _aad: Uint8Array,
  ): Promise<Uint8Array> {
    return new TextEncoder().encode("decrypted");
  }

  async rotateKey(
    _keyPurpose: LocalDataKeyPurpose,
  ): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: "key-1", newKeyId: "key-2" };
  }
}

function conversationFixture(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: "conversation-1",
    profileId: "profile-1",
    localNodeId: "node-1",
    titleEnvelope: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    archivedAtMs: null,
    ...overrides,
  };
}

function messageFixture(
  overrides: Partial<ConversationMessageRecord> = {},
): ConversationMessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    sequence: 0,
    role: "assistant",
    contentEnvelope: null,
    toolEnvelope: null,
    status: "complete",
    createdAtMs: 3,
    ...overrides,
  };
}

function memoryFixture(
  overrides: Partial<LightweightMemoryRecord> = {},
): LightweightMemoryRecord {
  return {
    id: "memory-1",
    profileId: "profile-1",
    localNodeId: "node-1",
    namespace: "notes",
    payloadEnvelope: encryptedEnvelopeFixture,
    sourceType: "conversation",
    sourceId: "conversation-1",
    createdAtMs: 4,
    updatedAtMs: 5,
    expiresAtMs: null,
    ...overrides,
  };
}

function toolsCapabilityCatalog() {
  const catalog = cloneFixture(capabilityCatalogFixture);
  const baseProvider = catalog.providers[0]!;
  const baseAction = catalog.actions[0]!;
  const provider = {
    ...baseProvider,
    provider_id: "local:Tooling",
    provider_kind: "local",
    peer_id: "local-peer",
    node_name: "local Aurora node",
    service_instance_id: "tooling-local",
    module: "Tooling",
    eligible: true,
    reason_code: "available",
    reason:
      "Local Gateway advertises Tooling.GetToolCatalog for the production tools route.",
    policy: {
      ...baseProvider.policy,
      required_permissions: ["Tooling.use"],
      explicit_selector_required: false,
      consent_required: false,
      privacy_indicator_required: false,
      approval_required: false,
      selector_required: false,
      denial_reasons: [],
    },
  };
  const listCatalogAction = {
    ...baseAction,
    action_id: "tooling-get-tool-catalog-local",
    module: "Tooling",
    method: "GetToolCatalog",
    topic: TOOLING_METHODS.listCatalog,
    provider_id: provider.provider_id,
    provider_kind: provider.provider_kind,
    peer_id: provider.peer_id,
    service_instance_id: provider.service_instance_id,
    selector: {
      peer_id: "local-peer",
      module: "Tooling",
      provider_id: provider.provider_id,
    },
    bindability: "available",
    route_blockers: [],
    summary:
      "Load the production tools catalog through the local Gateway and Tooling service.",
    policy: provider.policy,
    freshness: provider.freshness,
  };
  catalog.providers = [...catalog.providers, provider];
  catalog.actions = [...catalog.actions, listCatalogAction];
  catalog.provider_index = {
    ...catalog.provider_index,
    Tooling: [...(catalog.provider_index.Tooling ?? []), provider.provider_id],
  };
  catalog.action_index = {
    ...catalog.action_index,
    Tooling: [
      ...(catalog.action_index.Tooling ?? []),
      listCatalogAction.action_id,
    ],
    [TOOLING_METHODS.listCatalog]: [listCatalogAction.action_id],
  };
  return catalog;
}

function toolsGatewayTransport(): RecordingMockAuroraTransport {
  const transport = new RecordingMockAuroraTransport();
  transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
  transport.register(GATEWAY_METHODS.getCapabilityCatalog, () =>
    toolsCapabilityCatalog(),
  );
  transport.fail(
    TOOLING_METHODS.executeTool,
    "unavailable_service",
    "Tool execution backend refused safe local tool",
  );
  return transport;
}

async function submitAssistantPrompt(container: HTMLElement, prompt: string) {
  await waitUntil(() => {
    const textarea =
      container.querySelector<HTMLTextAreaElement>("#assistant-prompt");
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
  });
  const textarea =
    container.querySelector<HTMLTextAreaElement>("#assistant-prompt")!;
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    valueSetter?.call(textarea, prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReactWork();
  });
  const form = container.querySelector<HTMLFormElement>(
    "form.aui-assistant-form",
  );
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flushReactWork();
    await flushReactWork();
  });
}

function renderTauriRoute(href: string) {
  vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");
  window.history.replaceState({}, "", href);
  const runtime = adminTestRuntime();
  return renderToStaticMarkup(
    <AuroraTauriApp
      runtimeOverride={runtime}
      initialSnapshotOverride={{ ...loadingShellSnapshot, loadState: "ready" }}
    />,
  );
}

function renderReadyTauriApp(): string {
  const runtime = adminTestRuntime();
  return renderToStaticMarkup(
    <AuroraTauriApp
      runtimeOverride={runtime}
      initialSnapshotOverride={{ ...loadingShellSnapshot, loadState: "ready" }}
    />,
  );
}

function adminTestRuntime(): AuroraTauriRuntime {
  const client = new Aurora({ transport: new MockAuroraTransport() });
  client.auth.setAdmin({
    principalId: "test-admin",
    principalName: "Test admin",
    permissions: ["*"],
  });
  return testRuntime(client);
}

function expectNoPlaceholderOrDebugUi(markup: string, routeId: string) {
  for (const marker of PLACEHOLDER_MARKERS) {
    expect(markup, `${routeId} should not render ${marker}`).not.toContain(
      marker,
    );
  }
}

function mainContentText(markup: string) {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const main = host.querySelector("main#content");
  expect(
    main,
    "route markup should expose the production main content landmark",
  ).not.toBeNull();
  return main?.textContent ?? "";
}

function assertNoRouteReachesPlaceholderCopyForTests() {
  const failures: string[] = [];

  for (const item of primaryNavItems) {
    const markup = renderTauriRoute(item.href);
    for (const marker of [
      ...PLACEHOLDER_MARKERS,
      "This Tauri route is now navigable",
      "route is unregistered",
    ]) {
      if (markup.includes(marker)) {
        failures.push(`${item.id} (${item.href}) rendered ${marker}`);
      }
    }
    if (markup.includes(`${item.label} route registry error`)) {
      failures.push(`${item.id} (${item.href}) rendered route registry error`);
    }
  }

  expect(failures).toEqual([]);
}

function routesByGroup(routeIds: Set<string>) {
  return auroraNavSections
    .flatMap((section) => section.items)
    .filter((route) => routeIds.has(route.id));
}

describe("Aurora Tauri runtime wrapper", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.history.replaceState({}, "", "/");
  });

  it("recomposes a saved runtime profile so first-run native services are available immediately", async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() });
    const savedDocument = {
      version: 1 as const,
      activeProfileId: "saved",
      profiles: [thinRuntimeProfile("webrtc-only")],
    };
    const nextRuntime = testRuntime(client);
    const dispose = vi.fn(async () => undefined);
    const createRuntime = vi.fn(async () => nextRuntime);
    const recreateRuntime = vi.fn(async () => nextRuntime);
    const runtime = {
      ...testRuntime(client),
      dispose,
      thinProfileController: {
        evidence: "test profile store",
        document: { version: 1 as const, activeProfileId: null, profiles: [] },
        saveProfile: vi.fn(async () => savedDocument),
        selectProfile: vi.fn(async () => savedDocument),
        createRuntime,
        recreateRuntime,
      },
    } as AuroraTauriRuntime;

    const rebuilt = await rebuildAuroraThinRuntime(runtime, (controller) =>
      controller.saveProfile(thinRuntimeProfile("webrtc-only")),
    );

    expect(rebuilt).toBe(nextRuntime);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(savedDocument);
    expect(recreateRuntime).not.toHaveBeenCalled();
  });

  it("uses the SDK mock transport when no Tauri shell or Gateway URL is present", async () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");

    const runtime = createAuroraTauriRuntime();

    expect(runtime.mode).toBe("mock");
    expect(runtime.client.transport.kind).toBe("mock");
    await expect(runtime.sidecarStatus()).resolves.toBeNull();
    await expect(runtime.nativePermissionStatus()).resolves.toBeNull();
    await expect(runtime.iosSecureStorageStatus()).resolves.toBeNull();
    await expect(runtime.iosBiometricStatus()).resolves.toBeNull();
    await expect(runtime.iosLocalLightInferenceStatus()).resolves.toBeNull();
    await expect(runtime.androidBaselineStatus()).resolves.toBeNull();
    await expect(runtime.overlayShow?.("voice")).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.overlayStatus?.()).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(
      runtime.overlayRegisterHotkey?.("CommandOrControl+K"),
    ).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      hotkeyRegistered: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.overlayStartDrag?.()).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.overlayMoveBy?.(12, -6)).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("uses HTTP Gateway transport without a sidecar when Tauri runs in desktop-thin mode", async () => {
    Object.defineProperty(window, "__TAURI__", {
      value: {},
      configurable: true,
    });
    const profile = thinRuntimeProfile(
      "http-only",
      "http://gateway.example.test:8000",
    );

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: thinRuntimeDocument(profile),
    });

    expect(runtime.mode).toBe("desktop-thin");
    expect(runtime.client.transport.kind).toBe("http");
    await expect(runtime.sidecarStatus()).resolves.toBeNull();
    await expect(runtime.startSidecar()).resolves.toBeNull();
    await expect(runtime.stopSidecar()).resolves.toBeNull();

    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  });

  it("selects desktop-thin WebRTC-only in Tauri without starting the local sidecar", async () => {
    Object.defineProperty(window, "__TAURI__", {
      value: {},
      configurable: true,
    });
    window.history.replaceState(
      {},
      "",
      "/mesh#invite=aurora%3A%2F%2Fmesh%2Finvite%3Fbad%3D1",
    );

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: thinRuntimeDocument(
        thinRuntimeProfile("webrtc-only"),
      ),
    });

    expect(runtime.mode).toBe("desktop-thin");
    expect(runtime.thinConnectionMode).toBe("webrtc-only");
    expect(runtime.client.transport.kind).toBe("mesh");
    expect(window.location.hash).not.toContain("invite=");
    expect(runtime.thinPeer?.snapshot()).toMatchObject({
      hasHttpFallback: false,
      secretsPersisted: true,
      persistenceBackend: "platform-keychain",
    });
    await expect(runtime.sidecarStatus()).resolves.toBeNull();
    await expect(runtime.startSidecar()).resolves.toBeNull();
    await runtime.thinPeer?.disconnect("test cleanup");
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  });

  it("selects desktop-thin WebRTC-preferred with explicit HTTP fallback diagnostics", async () => {
    vi.stubEnv("VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK", "1");
    Object.defineProperty(window, "__TAURI__", {
      value: {},
      configurable: true,
    });
    window.history.replaceState(
      {},
      "",
      `/mesh#invite=${encodeURIComponent(testMeshInviteText())}`,
    );

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: thinRuntimeDocument(
        thinRuntimeProfile("webrtc-preferred"),
      ),
    });

    expect(runtime.mode).toBe("desktop-thin");
    expect(runtime.thinConnectionMode).toBe("webrtc-preferred");
    expect(runtime.client.transport.kind).toBe("mesh");
    expect(window.location.hash).not.toContain("invite=");
    expect(runtime.thinPeer?.snapshot().hasHttpFallback).toBe(true);
    expect(runtime.thinDiagnostics().join(" ")).toContain(
      "mode=webrtc-preferred",
    );
    expect(runtime.thinDiagnostics().join(" ")).toContain(
      "http endpoint configured",
    );
    await runtime.thinPeer?.disconnect("test cleanup");
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  });

  it("keeps desktop-thin HTTP and sidecar isolation intact when WebRTC rollout is disabled", async () => {
    vi.stubEnv("VITE_AURORA_WEBRTC_THIN_CLIENT", "false");
    Object.defineProperty(window, "__TAURI__", {
      value: {},
      configurable: true,
    });

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: thinRuntimeDocument(
        thinRuntimeProfile("webrtc-preferred"),
      ),
    });

    expect(runtime.mode).toBe("desktop-thin");
    expect(runtime.thinConnectionMode).toBe("webrtc-preferred");
    expect(runtime.client.transport.kind).toBe("http");
    expect(runtime.thinPeer?.snapshot()).toMatchObject({
      status: "disabled",
      hasHttpFallback: true,
    });
    await expect(runtime.sidecarStatus()).resolves.toBeNull();
    await expect(runtime.startSidecar()).resolves.toBeNull();
    await expect(runtime.stopSidecar()).resolves.toBeNull();
    await runtime.dispose();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  });

  it("uses thin HTTP mode for browser previews only from an explicit runtime profile", async () => {
    const profile = thinRuntimeProfile("http-only", "http://127.0.0.1:8000");

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: thinRuntimeDocument(profile),
    });

    expect(runtime.mode).toBe("desktop-thin");
    expect(runtime.client.transport.kind).toBe("http");
    await expect(runtime.sidecarStatus()).resolves.toBeNull();
    await expect(runtime.iosSecureStorageStatus()).resolves.toBeNull();
    await expect(runtime.iosLocalLightInferenceStatus()).resolves.toBeNull();
    await expect(runtime.androidBaselineStatus()).resolves.toBeNull();
    await expect(runtime.overlayShow?.("text")).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.overlayStatus?.()).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
    await expect(
      runtime.overlayRegisterHotkey?.("CommandOrControl+K"),
    ).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      hotkeyRegistered: false,
      reason: "not-tauri-runtime",
    });
    await expect(runtime.overlayStartDrag?.()).resolves.toMatchObject({
      ok: false,
      available: false,
      disabled: true,
      visible: false,
      reason: "not-tauri-runtime",
    });
  });

  it("renders the assistant page at the root instead of the diagnostics dashboard", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");

    const markup = renderReadyTauriApp();

    expect(markup).toContain("Assistant");
    expect(markup).toContain("Prompt");
    expect(markup).toContain("Text chat");
    expect(markup).not.toContain("Troubleshooting");
    expect(markup).not.toContain("Service checks");
  });

  it("routes the diagnostics dashboard away from the assistant landing page", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");
    window.history.replaceState({}, "", "/admin");

    const markup = renderReadyTauriApp();

    expect(markup).toContain("Troubleshooting");
    expect(markup).toContain("Live checks");
    expect(markup).toContain("Privacy check");
    expect(markup).toContain("Service checks");
    expect(markup).not.toContain("iOS microphone capture");
    expect(markup).not.toContain("Android baseline");
    expect(markup).not.toContain("Assistant role probe");
    expect(markup).toContain("Device permissions");
    expect(markup).toContain("Support export");
  });

  it("renders desktop-thin WebRTC connection controls and diagnostics without sidecar controls", () => {
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: new MockAuroraTransport() })),
      mode: "desktop-thin",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({
        status: "pairing",
        pairingSessionId: "pair-1",
        pairingVerificationCode: "123-456",
      }),
      thinDiagnostics: () => [
        "mode=webrtc-only",
        "invite room=test-room",
        "secret=memory-only",
      ],
      sidecarStatus: async () => null,
      startSidecar: async () => null,
      stopSidecar: async () => null,
    };
    window.history.replaceState(
      {},
      "",
      "/diagnostics#invite=aurora%3A%2F%2Fmesh%2Finvite%3Froom%3Dtest",
    );

    const markup = renderToStaticMarkup(
      <AuroraTauriApp
        runtimeOverride={runtime}
        initialSnapshotOverride={{
          ...loadingShellSnapshot,
          loadState: "ready",
          transportKind: "mesh",
        }}
      />,
    );

    expect(markup).toContain("Connected Aurora device");
    expect(markup).toContain(
      "Connection details come from the saved Aurora invite and can be changed later",
    );
    expect(markup).toContain("Connected Aurora device");
    expect(markup).toContain("Device connection");
    expect(markup).toContain("Direct device connection");
    expect(markup).not.toContain("aurora_sidecar_start");
  });

  it("retries verified remote assistant tools until the authorized peer catalog is ready", async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() });
    const digest = computeProjectionChecksum([], [], []);
    const pageBase = {
      ok: true,
      provider_peer_id: "python-peer",
      service_instance_id: "remote:python-peer:Tooling",
      selected_protocol_tier: "projection_v1" as const,
      authority_revision: {
        catalog_revision: 1,
        export_policy_revision: 1,
        auth_grant_revision: 1,
        manifest_revision: 1,
        switch_revision: 1,
        protocol_revision: 1,
      },
      projection_revision: "projection-1",
      projection_digest: digest,
      page_index: 0,
      page_size: 100,
      page_hash: "0".repeat(64),
      tools: [],
      blocked_tools: [],
      retirements: [],
      complete: true as const,
      next_cursor: null,
      total_count: 0,
      final_checksum: digest,
    };
    const page = {
      ...pageBase,
      page_hash: computeProjectionPageHash(
        pageBase as ToolingGetExportCatalogResponse,
      ),
    } as ToolingGetExportCatalogResponse;
    const getExportCatalog = vi
      .spyOn(client.tools, "getExportCatalog")
      .mockRejectedValueOnce(new Error("catalog authority is still arriving"))
      .mockResolvedValue(page);
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(client),
      mode: "desktop-thin",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({ status: "authorized" }),
      thinFeatures: {
        requestedNodeRole: "mesh-node",
        activeNodeRole: "mesh-node",
        meshNodeRuntimeEnabled: true,
        localToolProviderEnabled: true,
        lightweightOrchestratorEnabled: true,
        usesBrowserVoiceRuntime: false,
        focusedPushToTalkOwner: "native-desktop",
        wakewordOwner: "unavailable",
        localSpeechPack: {
          state: "disabled",
          availabilityState: "unsupported",
          label: "On-device speech",
          detail: "On-device speech is turned off on this device.",
          blockers: ["local_speech_disabled"],
          canRunLocalVad: false,
          canRunLocalKws: false,
          canRunLocalStt: false,
          canRunLocalTts: false,
        },
      },
      localAssistant: {
        provider: {
          complete: async () => ({ type: "message", content: "Ready." }),
        },
      },
    };
    await expect(loadTauriRemoteAssistantTools(runtime)).resolves.toEqual([]);
    expect(getExportCatalog).toHaveBeenCalledTimes(2);
    expect(getExportCatalog).toHaveBeenCalledWith({
      protocol_tier: "projection_v1",
      page_size: 100,
      cursor: null,
      last_projection_revision: null,
      last_projection_digest: null,
    });
  });

  it("refreshes the shell when a thin peer becomes authorized without a local assistant", async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() });
    const getGraph = vi.spyOn(client.capabilities, "getGraph");
    const thinPeer = controllableThinPeer({
      status: "connecting",
      state: "negotiating",
    });
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(client),
      mode: "mobile-native",
      thinConnectionMode: "webrtc-only",
      thinPeer: thinPeer.peer,
      localAssistant: undefined,
    };
    window.history.replaceState({}, "", "/assistant");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => expect(getGraph).toHaveBeenCalledTimes(1));
      await act(async () => {
        thinPeer.emit({ status: "authorized", state: "authorized" });
        await flushReactWork();
      });
      await waitUntil(() => expect(getGraph).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("shows sensitive shared-feature approval locally without exposing peer or token details", async () => {
    const approvals = fakeLocalApprovalController();
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: new MockAuroraTransport() })),
      localToolApprovals: approvals.controller,
    };
    window.history.replaceState({}, "", "/assistant");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(document.body.textContent).toContain("Allow Share text?");
        expect(mounted.container.textContent).toContain("Aurora ready");
        expect(document.body.textContent).toContain("Allow once");
      });
      expect(document.body.textContent).not.toContain("peer-must-not-render");
      expect(document.body.textContent).not.toContain("approval_token");
      expect(
        document.body.querySelector('[role="alertdialog"]'),
      ).not.toBeNull();
      expect(
        document.body
          .querySelector('[data-local-feature-approval="pending"]')
          ?.getAttribute("class"),
      ).toContain("ata-local-feature-approval");

      await clickButtonByLabel(document.body, "Allow once");
      expect(approvals.decide).toHaveBeenCalledWith(
        "local-approval-safe-id",
        "approve",
      );
      await waitUntil(() => {
        expect(document.body.textContent).not.toContain("Allow Share text?");
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it.each([
    ["desktop thin", "desktop-thin", "desktop", false],
    ["Android thin", "mobile-native", "android", true],
    ["iOS thin", "mobile-native", "ios", true],
  ] as const)(
    "gates an unconfigured %s runtime on first-run connection onboarding",
    (_label, mode, nativePlatform, _showsQrScanner) => {
      const transport = new RecordingMockAuroraTransport();
      const runtime = unconfiguredThinRuntime(
        mode,
        new Aurora({ transport }),
      );
      const markup = renderToStaticMarkup(
        <AuroraTauriApp
          runtimeOverride={runtime}
          initialSnapshotOverride={{
            ...loadingShellSnapshot,
            loadState: "ready",
            nativePlatform,
          }}
        />,
      );

      expect(markup).toContain("Connect to Aurora");
      expect(markup).toContain("Make this device available");
      expect(markup).toContain("Continue");
      expect(markup).not.toContain("Node name");
      expect(markup).not.toContain("Paste invite");
      expect(markup).not.toContain("Open invite file");
      expect(markup).not.toContain("Scan invite");
      expect(markup).not.toContain("HTTP Gateway endpoint");
      expect(markup).not.toContain("WebSocket signaling endpoint");
      expect(markup).not.toContain("Connection mode");
      expect(markup).not.toContain("Stable peer ID");
      expect(markup).toContain('aria-labelledby="onboarding-title"');
      expect(markup).toContain('data-step="detect"');
      expect(markup).not.toContain('aria-label="Primary navigation"');
      expect(markup).not.toContain('id="content"');
      expect(transport.requests).toHaveLength(0);
    },
  );

  it("opens the Mesh page after thin invite onboarding is saved", async () => {
    const runtime = unconfiguredThinRuntime(
      "desktop-thin",
      new Aurora({ transport: new RecordingMockAuroraTransport() }),
    );
    window.history.replaceState({}, "", "/");
    const mounted = await mountOutcomeApp(runtime);
    try {
      await clickButtonByLabel(mounted.container, "Continue");
      await flushReactWork();
      const invite = mounted.container.querySelector<HTMLTextAreaElement>(
        "#webthin-invite",
      );
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      expect(invite).not.toBeNull();
      await act(async () => {
        valueSetter?.call(invite, testMeshInviteText());
        invite?.dispatchEvent(new Event("input", { bubbles: true }));
        invite?.dispatchEvent(new Event("change", { bubbles: true }));
        await flushReactWork();
      });
      const continueButton = Array.from(
        mounted.container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) =>
        button.textContent?.includes("Save invite and continue"),
      );
      expect(continueButton?.disabled).toBe(false);
      await act(async () => {
        continueButton?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flushReactWork();
      });
      await waitUntil(() => expect(window.location.pathname).toBe("/mesh"));
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("saves manual address onboarding as a remote-console HTTP profile", async () => {
    const client = new Aurora({ transport: new RecordingMockAuroraTransport() });
    const document = {
      version: 1 as const,
      activeProfileId: "saved-home",
      profiles: [{
        id: "saved-home",
        label: "Saved Connect to Aurora",
        mode: "webrtc-only" as const,
        gatewayUrl: "",
        signalingUrl: "wss://old.example/mqtt",
        nodeName: "Aurora mobile",
        localStablePeerId: "mobile-peer-old",
        webrtcProfile: webRtcProfileFromInvite(testMeshInviteText())!,
      }],
    };
    let savedProfile: AuroraThinConnectionProfile | null = null;
    const modeWrites: string[] = [];
    const tierWrites: string[] = [];
    let runtime!: AuroraTauriRuntime;
    const controller: NonNullable<AuroraTauriRuntime["thinProfileController"]> = {
      evidence: "test runtime profile store",
      document,
      saveProfile: async (profile) => {
        savedProfile = profile;
        return {
          version: 1,
          activeProfileId: profile.id,
          profiles: [profile],
        };
      },
      selectProfile: async () => document,
      createRuntime: async () => runtime,
    };
    runtime = {
      ...testRuntime(client),
      mode: "mobile-native",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({ status: "needs-invite" }),
      thinProfileConfigured: true,
      requiresOnboarding: false,
      pendingThinInviteText: null,
      thinProfile: document.profiles[0],
      thinProfileController: controller,
      modePreferenceStore: {
        evidence: "test runtime-backed mode preference",
        readSelectedMode: async () => "mesh-node",
        readSelectedRuntimeTier: async () => "lightweight-ts",
        writeSelectedMode: async (modeId) => {
          modeWrites.push(modeId);
          return true;
        },
        writeSelectedRuntimeTier: async (runtimeTier) => {
          tierWrites.push(runtimeTier);
          return true;
        },
      },
      nodeMode: "mesh-node",
      runtimeTier: "lightweight-ts",
    };
    window.history.replaceState({}, "", "/onboarding");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const activeCard = mounted.container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Make this device available");
      });
      await clickButtonByLabel(mounted.container, "Connect to Aurora");
      await waitUntil(() => {
        expect(modeWrites).toContain("remote-console");
        expect(tierWrites).toContain("none");
      });
      await clickButtonByLabel(mounted.container, "Continue");
      await flushReactWork();
      modeWrites.length = 0;
      tierWrites.length = 0;

      await clickButtonByLabel(mounted.container, "Connect with an address");
      const endpoint = mounted.container.querySelector<HTMLInputElement>(
        "#aurora-endpoint",
      );
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      expect(endpoint).not.toBeNull();
      await act(async () => {
        valueSetter?.call(endpoint, "https://gateway.example.test/api");
        endpoint?.dispatchEvent(new Event("input", { bubbles: true }));
        endpoint?.dispatchEvent(new Event("change", { bubbles: true }));
        await flushReactWork();
      });
      await clickButtonByLabel(mounted.container, "Use this address");

      await waitUntil(() => expect(window.location.pathname).toBe("/mesh"));
      expect(modeWrites).toEqual([]);
      expect(tierWrites).toEqual([]);
      expect(savedProfile).toEqual({
        id: "saved-home",
        label: "Saved Connect to Aurora",
        mode: "http-only",
        gatewayUrl: "https://gateway.example.test/api",
        signalingUrl: "",
        nodeName: "Aurora mobile",
        localStablePeerId: "mobile-peer-old",
      });
      expect(savedProfile).not.toHaveProperty("webrtcProfile");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("saves an invite-backed Connect to Aurora profile without rewriting the selected role", async () => {
    const client = new Aurora({ transport: new RecordingMockAuroraTransport() });
    const document = {
      version: 1 as const,
      activeProfileId: "saved-home",
      profiles: [{
        id: "saved-home",
        label: "Saved Connect to Aurora",
        mode: "webrtc-only" as const,
        gatewayUrl: "",
        signalingUrl: "wss://old.example/mqtt",
        nodeName: "Aurora mobile",
        localStablePeerId: "mobile-peer-old",
        webrtcProfile: webRtcProfileFromInvite(testMeshInviteText())!,
      }],
    };
    let savedProfile: AuroraThinConnectionProfile | null = null;
    const modeWrites: string[] = [];
    const tierWrites: string[] = [];
    let runtime!: AuroraTauriRuntime;
    const controller: NonNullable<AuroraTauriRuntime["thinProfileController"]> = {
      evidence: "test runtime profile store",
      document,
      saveProfile: async (profile) => {
        savedProfile = profile;
        return {
          version: 1,
          activeProfileId: profile.id,
          profiles: [profile],
        };
      },
      selectProfile: async () => document,
      createRuntime: async () => runtime,
    };
    runtime = {
      ...testRuntime(client),
      mode: "mobile-native",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({ status: "needs-invite" }),
      thinProfileConfigured: true,
      requiresOnboarding: false,
      pendingThinInviteText: null,
      thinProfile: document.profiles[0],
      thinProfileController: controller,
      modePreferenceStore: {
        evidence: "test runtime-backed mode preference",
        readSelectedMode: async () => "mesh-node",
        readSelectedRuntimeTier: async () => "lightweight-ts",
        writeSelectedMode: async (modeId) => {
          modeWrites.push(modeId);
          return true;
        },
        writeSelectedRuntimeTier: async (runtimeTier) => {
          tierWrites.push(runtimeTier);
          return true;
        },
      },
      nodeMode: "mesh-node",
      runtimeTier: "lightweight-ts",
    };
    window.history.replaceState({}, "", "/onboarding");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const activeCard = mounted.container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Make this device available");
      });
      await clickButtonByLabel(mounted.container, "Connect to Aurora");
      await waitUntil(() => {
        expect(modeWrites).toContain("remote-console");
        expect(tierWrites).toContain("none");
      });
      await clickButtonByLabel(mounted.container, "Continue");
      await flushReactWork();
      modeWrites.length = 0;
      tierWrites.length = 0;
      const invite = mounted.container.querySelector<HTMLTextAreaElement>(
        "#webthin-invite",
      );
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      expect(invite).not.toBeNull();
      expect(mounted.container.textContent).toContain("Save invite and continue");
      expect(mounted.container.textContent).not.toContain("Username");
      expect(mounted.container.textContent).not.toContain("Sign in");
      await act(async () => {
        valueSetter?.call(invite, testMeshInviteText());
        invite?.dispatchEvent(new Event("input", { bubbles: true }));
        invite?.dispatchEvent(new Event("change", { bubbles: true }));
        await flushReactWork();
      });
      await clickButtonByLabel(mounted.container, "Save invite and continue");
      await waitUntil(() => expect(window.location.pathname).toBe("/mesh"));
      expect(modeWrites).toEqual([]);
      expect(tierWrites).toEqual([]);
      expect(savedProfile).toMatchObject({
        mode: "webrtc-only",
        signalingUrl: "wss://old.example/mqtt",
        webrtcProfile: { room: "tauri-room" },
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("saves an invite-backed available-device profile with the explicit mesh role", async () => {
    const client = new Aurora({ transport: new RecordingMockAuroraTransport() });
    const document = {
      version: 1 as const,
      activeProfileId: "saved-home",
      profiles: [{
        id: "saved-home",
        label: "Saved Connect to Aurora",
        mode: "webrtc-only" as const,
        gatewayUrl: "",
        signalingUrl: "wss://old.example/mqtt",
        nodeName: "Aurora mobile",
        localStablePeerId: "mobile-peer-old",
        webrtcProfile: webRtcProfileFromInvite(testMeshInviteText())!,
      }],
    };
    let savedProfile: AuroraThinConnectionProfile | null = null;
    const modeWrites: string[] = [];
    const tierWrites: string[] = [];
    let runtime!: AuroraTauriRuntime;
    const controller: NonNullable<AuroraTauriRuntime["thinProfileController"]> = {
      evidence: "test runtime profile store",
      document,
      saveProfile: async (profile) => {
        savedProfile = profile;
        return {
          version: 1,
          activeProfileId: profile.id,
          profiles: [profile],
        };
      },
      selectProfile: async () => document,
      createRuntime: async () => ({
        ...runtime,
        nodeMode: "mesh-node",
        runtimeTier: "lightweight-ts",
      }),
    };
    runtime = {
      ...testRuntime(client),
      mode: "mobile-native",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({ status: "needs-invite" }),
      thinProfileConfigured: true,
      requiresOnboarding: false,
      pendingThinInviteText: null,
      thinProfile: document.profiles[0],
      thinProfileController: controller,
      modePreferenceStore: {
        evidence: "test runtime-backed mode preference",
        readSelectedMode: async () => "remote-console",
        readSelectedRuntimeTier: async () => "none",
        writeSelectedMode: async (modeId) => {
          modeWrites.push(modeId);
          return true;
        },
        writeSelectedRuntimeTier: async (runtimeTier) => {
          tierWrites.push(runtimeTier);
          return true;
        },
      },
      nodeMode: "remote-console",
      runtimeTier: "none",
    };
    window.history.replaceState({}, "", "/onboarding");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const activeCard = mounted.container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Connect to Aurora");
      });
      await clickButtonByLabel(mounted.container, "Make this device available");
      await waitUntil(() => {
        expect(modeWrites).toEqual(["mesh-node"]);
        expect(tierWrites).toEqual(["lightweight-ts"]);
      });
      await clickButtonByLabel(mounted.container, "Continue");
      await flushReactWork();
      modeWrites.length = 0;
      tierWrites.length = 0;
      expect(mounted.container.textContent).toContain(
        "Choose what this device can share with approved Aurora devices.",
      );
      expect(mounted.container.textContent).toContain("Add setup invite");
      expect(mounted.container.textContent).toContain("Save device setup");
      expect(mounted.container.textContent).not.toContain(
        "Use an invite or address to connect this device.",
      );
      expect(mounted.container.textContent).not.toContain(
        "Connect with an address",
      );

      const invite = mounted.container.querySelector<HTMLTextAreaElement>(
        "#webthin-invite",
      );
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      expect(invite).not.toBeNull();
      await act(async () => {
        valueSetter?.call(invite, testMeshInviteText());
        invite?.dispatchEvent(new Event("input", { bubbles: true }));
        invite?.dispatchEvent(new Event("change", { bubbles: true }));
        await flushReactWork();
      });
      await clickButtonByLabel(mounted.container, "Save device setup");

      await waitUntil(() => expect(window.location.pathname).toBe("/mesh"));
      expect(modeWrites).toEqual([]);
      expect(tierWrites).toEqual([]);
      expect(savedProfile).toMatchObject({
        mode: "webrtc-only",
        signalingUrl: "wss://old.example/mqtt",
        webrtcProfile: { room: "tauri-room" },
      });

      const rebuilt = await rebuildAuroraThinRuntime(runtime, (profileController) =>
        profileController.saveProfile(document.profiles[0]),
      );
      expect(rebuilt.nodeMode).toBe("mesh-node");
      expect(rebuilt.runtimeTier).toBe("lightweight-ts");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("saves diagnostics profile changes without mutating the selected role", async () => {
    const client = new Aurora({ transport: new RecordingMockAuroraTransport() });
    const document = {
      version: 1 as const,
      activeProfileId: "diagnostics-home",
      profiles: [{
        id: "diagnostics-home",
        label: "Diagnostics home",
        mode: "http-only" as const,
        gatewayUrl: "https://gateway.example.test/api",
        signalingUrl: "",
        nodeName: "Aurora diagnostics",
        localStablePeerId: "diagnostics-peer",
      }],
    };
    let savedProfile: AuroraThinConnectionProfile | null = null;
    const modeWrites: string[] = [];
    const tierWrites: string[] = [];
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(client),
      mode: "desktop-thin",
      thinConnectionMode: "http-only",
      thinPeer: fakeThinPeer({ status: "needs-invite" }),
      thinProfile: document.profiles[0],
      thinProfileConfigured: true,
      thinProfileController: {
        evidence: "test diagnostics runtime profile store",
        document,
        saveProfile: async (profile) => {
          savedProfile = profile;
          return {
            version: 1,
            activeProfileId: profile.id,
            profiles: [profile],
          };
        },
        selectProfile: async () => document,
        createRuntime: async () => runtime,
      },
      modePreferenceStore: {
        evidence: "test runtime-backed mode preference",
        readSelectedMode: async () => "mesh-node",
        readSelectedRuntimeTier: async () => "lightweight-ts",
        writeSelectedMode: async (modeId) => {
          modeWrites.push(modeId);
          return true;
        },
        writeSelectedRuntimeTier: async (runtimeTier) => {
          tierWrites.push(runtimeTier);
          return true;
        },
      },
      nodeMode: "mesh-node",
      runtimeTier: "lightweight-ts",
    };
    window.history.replaceState({}, "", "/diagnostics");

    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(mounted.container.textContent).toContain("Save and use profile");
      });
      await clickButtonByLabel(mounted.container, "Save and use profile");
      await waitUntil(() => expect(savedProfile).not.toBeNull());

      expect(modeWrites).toEqual([]);
      expect(tierWrites).toEqual([]);
      expect(savedProfile).toMatchObject({
        id: "diagnostics-home",
        mode: "http-only",
        gatewayUrl: "https://gateway.example.test/api",
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("keeps desktop-local startup outside the thin-client onboarding gate", () => {
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: new MockAuroraTransport() })),
      mode: "desktop-local",
      thinProfileConfigured: false,
      requiresOnboarding: false,
    };
    const markup = renderToStaticMarkup(
      <AuroraTauriApp
        runtimeOverride={runtime}
        initialSnapshotOverride={{
          ...loadingShellSnapshot,
          loadState: "ready",
          transportKind: "tauri-local",
        }}
      />,
    );

    expect(markup).not.toContain("Connect this Aurora client");
    expect(markup).toContain('id="content"');
    expect(markup).toContain("Assistant");
  });

  it("keeps profile saves independent of runtime role selection", () => {
    const source = readFileSync(
      join(process.cwd(), "src/tauri-app.tsx"),
      "utf8",
    );

    expect(source).not.toContain(
      "onSaveProfile: nativeContext.saveThinProfile",
    );
    expect(source).not.toContain("saveRemoteConsoleThinProfile");
    expect(source).not.toContain('writeSelectedMode("remote-console")');
    expect(source).not.toContain('writeSelectedRuntimeTier?.("none")');
  });

  it("renders the models page for the models route", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");
    window.history.replaceState({}, "", "/models");

    const markup = renderReadyTauriApp();

    expectMarkupToContainText(markup, "Models & Sources", "/models");
    expect(markup).toContain("Loading model sources from Aurora");
    expect(markup).not.toContain("Native boundary");
  });

  it("registers a production Tauri component for every primary nav route", () => {
    const routeIds = new Set<string>(tauriRouteRegistryRouteIds);
    const missing = primaryNavItems
      .filter((item) => !routeIds.has(item.id))
      .map((item) => `${item.id}:${item.href}`);

    expect(missing).toEqual([]);
    expect(routeIds.size).toBe(primaryNavItems.length);
  });

  it("keeps the legacy TauriRoutePlaceholder out of production route source", () => {
    const source = readFileSync(
      join(process.cwd(), "src/tauri-app.tsx"),
      "utf8",
    );

    expect(source).not.toContain("TauriRoutePlaceholder");
    expect(source).not.toContain("ata-placeholder-panel");
    expect(source).not.toContain("debug-dashboard");
    expect(source).not.toContain(
      "A full product page still needs to be mounted",
    );
  });

  it("renders every primary route without the legacy route placeholder copy", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");

    for (const item of primaryNavItems) {
      window.history.replaceState({}, "", item.href);
      const markup = renderReadyTauriApp();
      const oracle = getProductionRouteOracle(item.id);

      expect(
        oracle,
        `${item.href} must have a production surface oracle`,
      ).toBeDefined();
      for (const landmark of expectedRenderedLandmarks(item.id, oracle)) {
        expectMarkupToContainText(markup, landmark, item.href);
      }
      expect(markup, item.href).not.toContain(
        "A full product page still needs to be mounted",
      );
      expect(markup, item.href).not.toContain(
        "This Tauri route is now navigable",
      );
      expect(markup, item.href).not.toContain("route is unregistered");
    }
  });

  it("e2e:routes test-only assert: no route reaches placeholder copy", () => {
    assertNoRouteReachesPlaceholderCopyForTests();
  });

  it("keeps credentials and raw-audio payloads out of rendered diagnostics and route output", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "http://127.0.0.1:8000");

    for (const href of ["/", "/admin", "/admin/tokens", "/settings"]) {
      window.history.replaceState({}, "", href);
      const markup = renderReadyTauriApp();

      expect(markup, href).not.toContain("test-token");
      expect(markup, href).not.toMatch(/authorization/i);
      expect(markup, href).not.toMatch(/api[_-]?key/i);
      expect(markup, href).not.toMatch(/raw[-_ ]audio payload/i);
      expect(markup, href).not.toMatch(/audio_buffer/i);
    }
  });
});

function expectMarkupToContainText(
  markup: string,
  text: string,
  context: string,
) {
  const htmlEscaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  expect(
    markup.includes(text) || markup.includes(htmlEscaped),
    `${context} should render production landmark ${text}`,
  ).toBe(true);
}

function resetTauriRouteGateState() {
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
}

describe("Tauri CI/E2E route gates", () => {
  afterEach(resetTauriRouteGateState);

  it("e2e:routes renders every registered route without placeholder or debug dashboard UI", () => {
    const routes = auroraNavSections.flatMap((section) => section.items);
    expect(routes).toHaveLength(13);
    expect(new Set(tauriRouteRegistryRouteIds)).toEqual(
      new Set(routes.map((route) => route.id)),
    );

    for (const route of routes) {
      const markup = renderTauriRoute(route.href);

      expectNoPlaceholderOrDebugUi(markup, route.id);
      expectMarkupToContainText(markup, route.label, route.id);
      expect(markup, route.id).not.toContain(
        `${route.label} route registry error`,
      );
    }
  });

  it("e2e:routes embeds the diagnostics dashboard only in Admin Overview", () => {
    for (const route of primaryNavItems) {
      const markup = renderTauriRoute(route.href);

      if (route.id === "admin") {
        for (const marker of DIAGNOSTICS_PAGE_MARKERS) {
          expect(markup, marker).toContain(marker);
        }
        continue;
      }

      for (const marker of DIAGNOSTICS_PAGE_MARKERS) {
        expect(
          markup,
          `${route.id} must not render diagnostics dashboard marker ${marker}`,
        ).not.toContain(marker);
      }
    }
  });

  it("e2e:routes keeps services primary while contracts are no longer a registered primary route", () => {
    const servicesMarkup = renderTauriRoute("/admin/services");
    const adminMarkup = renderTauriRoute("/admin");
    const servicesText = mainContentText(servicesMarkup);
    const adminText = mainContentText(adminMarkup);

    expectNoPlaceholderOrDebugUi(servicesMarkup, "services");
    expectNoPlaceholderOrDebugUi(adminMarkup, "admin");
    expect(tauriRouteRegistryRouteIds).toContain("services");
    expect(tauriRouteRegistryRouteIds).not.toContain("contracts");
    expect(servicesText).toContain("Services");
    expect(servicesText).toContain(
      "Service health and restart controls",
    );
    expect(servicesText).not.toContain("Contracts registry");

    expect(adminText).toContain("Diagnostics");
    expect(adminText).not.toBe(servicesText);
  });

  it("e2e:routes embeds configuration, data policy, and native settings inside Settings", () => {
    const settingsMarkup = renderTauriRoute("/settings");
    const settingsText = mainContentText(settingsMarkup);

    expectNoPlaceholderOrDebugUi(settingsMarkup, "settings");
    expect(settingsText).toContain(
      "Permissions, connection choices, privacy, and data controls are grouped on one Settings page.",
    );
    expect(settingsText).toContain("Privacy defaults");
    expect(settingsText).toContain("Voice behavior");
    expect(settingsText).toContain("Theme, accessibility, and local storage");
    expect(settingsText).toContain("Connection choices");
    expect(settingsText).toContain("Configuration");
    expect(settingsText).toContain("Data policy and retention");
    expect(settingsText).toContain("Device controls");
    expect(settingsText).not.toContain("Route and fallback policy");
    expect(settingsText).not.toContain("Native permission id");
  });

  it("e2e:routes renders the memory cockpit with collections, search, conversations, and policy-safe actions", async () => {
    const runtime = testRuntime(
      new Aurora({ transport: memoryGatewayTransport() }),
    );
    window.history.replaceState({}, "", "/memory");
    const memory = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(memory.container.textContent).toContain("Memory & Knowledge");
        expect(memory.container.textContent).toContain("Collections");
        expect(memory.container.textContent).toContain("Search");
        const searchInput =
          memory.container.querySelector<HTMLInputElement>("#memory-query");
        expect(searchInput?.getAttribute("aria-label")).toContain(
          "Search conversations",
        );
        expect(searchInput?.placeholder).toContain("Search conversations");
        expect(memory.container.textContent).toContain("Conversation history");
        expect(memory.container.textContent).toContain(
          "Deleting a memory previews affected saved records before removal",
        );
      });
      const queryInput =
        memory.container.querySelector<HTMLInputElement>("#memory-query");
      expect(queryInput).not.toBeNull();
      const searchForm = queryInput!.closest("form");
      expect(searchForm).not.toBeNull();
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        valueSetter?.call(queryInput, "mesh pairing");
        queryInput!.dispatchEvent(new Event("input", { bubbles: true }));
        queryInput!.dispatchEvent(new Event("change", { bubbles: true }));
        await flushReactWork();
      });
      await act(async () => {
        searchForm!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await flushReactWork();
        await flushReactWork();
      });
      await waitUntil(() => {
        expect(memory.container.textContent).toContain(
          'Search hit for "mesh pairing"',
        );
        expect(memory.container.textContent).toContain("Saved through");
        expect(memory.container.textContent).toContain("Privacy class");
        expect(memory.container.textContent).toContain("Policy");
        expect(memory.container.textContent).toContain("History");
      });
      writeOutcomeArtifact(
        "memory-route-collections-search",
        memory.container.innerHTML,
      );
    } finally {
      await act(async () => memory.root.unmount());
      memory.container.remove();
    }
  });

  it("e2e:routes renders this-device local data only for eligible Tauri mesh-node runtimes", async () => {
    window.history.replaceState({}, "", "/memory");
    const memory = await mountOutcomeApp(await tauriMeshNodeMemoryRuntime());
    try {
      await waitUntil(() => {
        expect(memory.container.textContent).toContain("This device");
        expect(memory.container.textContent).toContain(
          "Saved on this device",
        );
        expect(memory.container.textContent).toContain("Conversation Local");
        expect(memory.container.textContent).toContain(
          "Memory on this device",
        );
        expect(memory.container.textContent).toContain(
          "Connected Aurora device",
        );
      });
      writeOutcomeArtifact(
        "memory-route-tauri-local-data",
        memory.container.innerHTML,
      );
    } finally {
      await act(async () => memory.root.unmount());
      memory.container.remove();
    }
  });

  it("e2e:routes keeps Tauri local data absent or safe for ineligible runtimes", async () => {
    const cases: Array<{
      name: string;
      runtime: AuroraTauriRuntime | Promise<AuroraTauriRuntime>;
      expected: "absent" | "owner-blocked";
    }> = [
      {
        name: "remote-console",
        runtime: {
          ...testRuntime(new Aurora({ transport: memoryGatewayTransport() })),
          mode: "desktop-thin",
          nodeMode: "remote-console",
          runtimeTier: "none",
        },
        expected: "absent",
      },
      {
        name: "unavailable-storage",
        runtime: unavailableTauriMeshNodeRuntime(),
        expected: "absent",
      },
      {
        name: "non-owner",
        runtime: tauriMeshNodeMemoryRuntime({ ownerAvailable: false }),
        expected: "owner-blocked",
      },
    ];

    for (const testCase of cases) {
      window.history.replaceState({}, "", "/memory");
      const memory = await mountOutcomeApp(await testCase.runtime);
      try {
        await waitUntil(() => {
          expect(memory.container.textContent).toContain("Memory & Knowledge");
          expect(memory.container.textContent).toContain(
            "Connected Aurora device",
          );
          if (testCase.expected === "absent") {
            expect(memory.container.textContent).not.toContain("This device");
          } else {
            expect(memory.container.textContent).toContain("This device");
            expect(memory.container.textContent).toContain(
              "Local features are already active in another Aurora window",
            );
          }
        });
        writeOutcomeArtifact(
          `memory-route-tauri-local-data-${testCase.name}`,
          memory.container.innerHTML,
        );
      } finally {
        await act(async () => memory.root.unmount());
        memory.container.remove();
      }
    }
  });

  it("e2e:routes covers memory empty and error states", async () => {
    const emptyTransport = memoryGatewayTransport();
    emptyTransport.register("DB.GetMessages", () => ({
      messages: [],
      total: 0,
      has_more: false,
    }));
    emptyTransport.register("DB.RAGListNamespaces", () => ({ namespaces: [] }));
    window.history.replaceState({}, "", "/memory");
    const emptyMemory = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: emptyTransport })),
    );
    try {
      await waitUntil(() => {
        expect(emptyMemory.container.textContent).toContain(
          "No collections yet",
        );
        expect(emptyMemory.container.textContent).toContain(
          "Collections appear after conversations",
        );
        expect(emptyMemory.container.textContent).toContain(
          "No conversations yet",
        );
        expect(emptyMemory.container.textContent).toContain(
          "Saved conversations will appear here",
        );
      });
    } finally {
      await act(async () => emptyMemory.root.unmount());
      emptyMemory.container.remove();
    }

    const errorTransport = memoryGatewayTransport().fail(
      "DB.RAGListNamespaces",
      "permission",
      "DB permission denied",
    );
    window.history.replaceState({}, "", "/memory");
    const errorMemory = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: errorTransport })),
    );
    try {
      await waitUntil(() => {
        expect(errorMemory.container.textContent).toContain(
          "Memory request denied. Review access and try again.",
        );
        expect(errorMemory.container.textContent).toContain(
          "No collections yet",
        );
      });
      writeOutcomeArtifact(
        "memory-route-empty-error",
        errorMemory.container.innerHTML,
      );
    } finally {
      await act(async () => errorMemory.root.unmount());
      errorMemory.container.remove();
    }
  });

  it("e2e:routes renders data policy retention and audit status instead of the memory search page", async () => {
    const runtime = testRuntime(
      new Aurora({ transport: memoryGatewayTransport() }),
    );
    window.history.replaceState({}, "", "/settings");
    const dataPolicy = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(
          dataPolicy.container.querySelector("#data-policy-title"),
        ).not.toBeNull();
        expect(dataPolicy.container.textContent).toContain(
          "Data policy and retention",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Retention defaults",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Collection visibility",
        );
        expect(dataPolicy.container.textContent).toContain("Audio storage");
        expect(dataPolicy.container.textContent).toContain(
          "Audio, transcripts, and sharing rules",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Shared-device help",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Export, delete, and import data flows",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Activity history for policy changes",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Confirmation is required before settings can be changed.",
        );
        expect(dataPolicy.container.textContent).not.toMatch(
          /\b(draft|confirm\/audit|fallback)\b/,
        );
      });
      expect(
        dataPolicy.container.querySelector("#data-policy-title"),
      ).not.toBeNull();
      writeOutcomeArtifact(
        "data-policy-route-retention-audit",
        dataPolicy.container.innerHTML,
      );
    } finally {
      await act(async () => dataPolicy.root.unmount());
      dataPolicy.container.remove();
    }
  });

  it("e2e:routes covers tools source rail, source detail, and search filtering", async () => {
    const transport = toolsGatewayTransport();
    const runtime = testRuntime(new Aurora({ transport }));
    window.history.replaceState({}, "", "/tools");
    const tools = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(tools.container.textContent).toContain("Tools & Plugins");
        expect(tools.container.textContent).toContain(
          "Review tool sources",
        );
        expect(tools.container.textContent).toContain("Sources");
        expect(tools.container.textContent).toContain(
          "Expand a tool to review what it can do",
        );
        expect(tools.container.textContent).not.toContain("Service sharing");
        expect(requestMethods(transport)).toContain(
          TOOLING_METHODS.listCatalog,
        );
      });

      const searchInput = tools.container.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
      expect(searchInput, "tools route search input").not.toBeNull();
      await setInputValue(searchInput!, "email");
      await waitUntil(() => {
        expect(tools.container.textContent).toContain("Send email draft");
        expect(tools.container.textContent).not.toContain("Open garage door");
      });

      await setInputValue(searchInput!, "serviceHealth");
      await waitUntil(() => {
        expect(tools.container.textContent).toContain(
          "diagnostics.serviceHealth",
        );
        expect(tools.container.textContent).not.toContain("Send email draft");
      });
      writeOutcomeArtifact(
        "tools-route-source-rail-search",
        tools.container.innerHTML,
      );
    } finally {
      await act(async () => tools.root.unmount());
      tools.container.remove();
    }
  });

  it("e2e:routes covers mesh status load, pairing entry, actions, route preview, and diagnostics errors", async () => {
    const meshTransport = new RecordingMockAuroraTransport();
    window.history.replaceState({}, "", "/mesh");
    const mesh = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: meshTransport })),
    );
    try {
      await waitUntil(() => {
        expect(mesh.container.textContent).toContain("Connected devices");
        expect(mesh.container.textContent).toContain("Waiting for approval");
        expect(mesh.container.textContent).toContain("How Aurora chooses a device");
        expect(mesh.container.textContent).toContain("Service sharing");
        expect(mesh.container.textContent).toContain("Device selection details");
        expect(mesh.container.textContent).toContain("All devices");
        expect(mesh.container.textContent).toContain("Review & approve");
        expect(mesh.container.textContent).not.toContain("Gateway.ExplainRoute");
        expect(requestMethods(meshTransport)).toContain(
          GATEWAY_METHODS.getMeshStatus,
        );
        expect(requestMethods(meshTransport)).toContain(
          AUTH_METHODS.meshListPeers,
        );
        expect(requestMethods(meshTransport)).toContain(
          AUTH_METHODS.listPendingPairings,
        );
        expect(requestMethods(meshTransport)).toContain(
          AUTH_METHODS.listDevices,
        );
        expect(requestMethods(meshTransport)).toContain(
          GATEWAY_METHODS.getWebRTCDiagnostics,
        );
      });
      const reviewButtons = Array.from(
        mesh.container.querySelectorAll<HTMLButtonElement>("button"),
      ).filter((button) => button.textContent?.includes("Review & approve"));
      expect(
        reviewButtons.length,
        "mesh review request controls",
      ).toBeGreaterThan(0);
      expect(mesh.container.textContent).toContain("Device permissions and actions");
      writeOutcomeArtifact(
        "mesh-route-status-pair-actions-route-preview",
        mesh.container.innerHTML,
      );
    } finally {
      await act(async () => mesh.root.unmount());
      mesh.container.remove();
    }

    const diagnosticsTransport = new RecordingMockAuroraTransport().fail(
      GATEWAY_METHODS.getWebRTCDiagnostics,
      "unavailable_service",
      "diagnostics down",
    );
    window.history.replaceState({}, "", "/admin");
    const diagnostics = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: diagnosticsTransport })),
    );
    try {
      await waitUntil(() => {
        expect(diagnostics.container.textContent).toContain("Diagnostics");
        expect(diagnostics.container.textContent).toContain(
          "Troubleshooting",
        );
        expect(diagnostics.container.textContent).toContain(
          "Check whether connected devices, service checks, support export, and repair steps are ready.",
        );
        expect(diagnostics.container.textContent).toContain("Could not connect to this Aurora device. Try again or reconnect the device.");
        expect(diagnostics.container.textContent).not.toContain("Gateway.GetWebRTCDiagnostics");
        expect(diagnostics.container.textContent).toContain("Service checks");
        expect(diagnostics.container.textContent).toContain(
          "App logs",
        );
        expect(requestMethods(diagnosticsTransport)).toContain(
          GATEWAY_METHODS.getWebRTCDiagnostics,
        );
      });
      writeOutcomeArtifact(
        "diagnostics-webrtc-error-state",
        diagnostics.container.innerHTML,
      );
    } finally {
      await act(async () => diagnostics.root.unmount());
      diagnostics.container.remove();
    }
  });

  it("keeps local service settings off remote mobile mesh surfaces", async () => {
    const transport = new RecordingMockAuroraTransport();
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(
        new Aurora({ transport: nativeMobileTransportProxy(transport) }),
      ),
      mode: "mobile-native",
      thinConnectionMode: "webrtc-only",
      thinPeer: fakeThinPeer({ status: "authorized", state: "authorized" }),
    };
    window.history.replaceState({}, "", "/mesh");

    const mesh = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(mesh.container.textContent).toContain("Connected devices");
        expect(requestMethods(transport)).toContain(
          GATEWAY_METHODS.getMeshStatus,
        );
      });
      expect(mesh.container.textContent).not.toContain("Service sharing");
      expect(requestMethods(transport)).not.toContain("Config.Get");
      expect(requestMethods(transport)).not.toContain(
        "Config.GetSchemaMetadata",
      );
      expect(requestMethods(transport)).not.toContain(
        GATEWAY_METHODS.getMeshInviteConfig,
      );
    } finally {
      await act(async () => mesh.root.unmount());
      mesh.container.remove();
    }
  });

  it("e2e:assistant sends a text prompt to local Gateway and renders response or precise backend error", async () => {
    const successTransport = assistantGatewayTransport();
    const successRuntime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: successTransport })),
      mode: "desktop-local",
      sidecarStatus: async () => ({
        running: true,
        mode: "threads",
        pid: 6060,
        gatewayUrl: "http://127.0.0.1:8000",
        lastError: null,
        details: { healthPath: "/api/health" },
      }),
      startSidecar: async () => ({
        running: true,
        mode: "threads",
        pid: 6060,
        gatewayUrl: "http://127.0.0.1:8000",
        lastError: null,
        details: { healthPath: "/api/health" },
      }),
    };
    window.history.replaceState({}, "", "/");

    const success = await mountOutcomeApp(successRuntime);
    try {
      await submitAssistantPrompt(success.container, "hello local gateway");
      await waitUntil(() => {
        expect(success.container.textContent).toContain(
          "Local Gateway says hello from Orchestrator.",
        );
        expect(success.container.textContent).not.toContain("local-gateway-test");
      });
      expect(
        Array.from(
          success.container.querySelectorAll(
            ".aui-assistant-runtime-strip dt",
          ),
          (element) => element.textContent,
        ),
      ).toEqual([
        "Selected model",
        "Model state",
        "Answers from",
        "On this device",
        "Connection",
      ]);
      expect(success.container.textContent).not.toContain(
        "Local service status",
      );
      const assistantRequests = successTransport.requests.filter(
        (request) => request.method === ORCHESTRATOR_METHODS.externalUserInput,
      );
      expect(assistantRequests).toHaveLength(1);
      expect(assistantRequests[0]?.payload).toEqual(
        expect.objectContaining({
          text: "hello local gateway",
          source: "ui",
          stream: true,
        }),
      );
      expect(requestMethods(successTransport)).toContain(
        GATEWAY_METHODS.getCapabilityCatalog,
      );
      writeOutcomeArtifact(
        "assistant-send-success",
        success.container.innerHTML,
      );
    } finally {
      await act(async () => success.root.unmount());
      success.container.remove();
    }

    const failureTransport = assistantGatewayAuthFailureTransport();
    const failureRuntime = testRuntime(
      new Aurora({ transport: failureTransport }),
    );
    window.history.replaceState({}, "", "/");
    const failure = await mountOutcomeApp(failureRuntime);
    try {
      await submitAssistantPrompt(
        failure.container,
        "hello with expired token",
      );
      await waitUntil(() => {
        expect(failure.container.textContent).toContain(
          "Assistant request denied. Review access and try again.",
        );
      });
      const assistantRequests = failureTransport.requests.filter(
        (request) => request.method === ORCHESTRATOR_METHODS.externalUserInput,
      );
      expect(assistantRequests).toHaveLength(1);
      expect(assistantRequests[0]?.payload).toEqual(
        expect.objectContaining({
          text: "hello with expired token",
          source: "ui",
          stream: true,
        }),
      );
      writeOutcomeArtifact(
        "assistant-send-auth-error",
        failure.container.innerHTML,
      );
    } finally {
      await act(async () => failure.root.unmount());
      failure.container.remove();
    }
  });

  it("e2e:assistant does not project coordinator voice events into the installed desktop composer", async () => {
    const transport = assistantGatewayTransport();
    transport.register(ORCHESTRATOR_MODEL_METHODS.getRuntime, () =>
      cloneFixture(modelRuntimeCatalogFixture),
    );
    transport.stream("voice", [
      {
        id: "voice-start-live-textbox",
        kind: "voice.session.started",
        topic: "STTCoordinator.SessionStarted",
        payload: {
          session_id: "voice-live-textbox",
          source: "wakeword",
          wake_word: "jarvis",
        },
      },
      {
        id: "voice-partial-live-textbox",
        kind: "voice.transcription.partial",
        topic: "STTCoordinator.Partial",
        payload: {
          session_id: "voice-live-textbox",
          text: "what is the weather",
          source: "stt",
        },
      },
    ]);
    const runtime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local" as const,
    };
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const mounted = await mountOutcomeApp(runtime);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
        "#assistant-prompt",
      );
      expect(textarea?.value).toBe("");
      expect(
        mounted.container.querySelector<HTMLElement>(
          ".aui-composer-recorder-row",
        ),
      ).toBeNull();
      writeOutcomeArtifact(
        "assistant-voice-partial-not-projected-in-desktop-native",
        mounted.container.innerHTML,
      );
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("e2e:assistant ignores a remote coordinator session partial that is not locally owned", async () => {
    const transport = assistantGatewayTransport();
    transport.register(ORCHESTRATOR_MODEL_METHODS.getRuntime, () =>
      cloneFixture(modelRuntimeCatalogFixture),
    );
    transport.stream("voice", [
      {
        id: "voice-start-foreign-textbox",
        kind: "voice.session.started",
        topic: "STTCoordinator.SessionStarted",
        payload: {
          session_id: "voice-foreign-textbox",
          source_peer_id: "peer-remote",
          source: "wakeword",
        },
      },
      {
        id: "voice-partial-foreign-textbox",
        kind: "voice.transcription.partial",
        topic: "STTCoordinator.Partial",
        payload: {
          session_id: "voice-foreign-textbox",
          source_peer_id: "peer-remote",
          text: "must not appear",
          source: "stt",
        },
      },
    ]);
    const runtime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local" as const,
    };
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const mounted = await mountOutcomeApp(runtime);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      expect(
        mounted.container.querySelector<HTMLTextAreaElement>(
          "#assistant-prompt",
        )?.value,
      ).toBe("");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("e2e:assistant push-to-talk uses the installed desktop voice port in Tauri local mode", async () => {
    const transport = new RecordingMockAuroraTransport();
    transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
    transport.register(GATEWAY_METHODS.getCapabilityCatalog, () =>
      assistantCapabilityCatalog(),
    );
    transport.register(GATEWAY_METHODS.explainRoute, () =>
      cloneFixture(routeExplainFixture),
    );
    transport.register(ORCHESTRATOR_MODEL_METHODS.getRuntime, () =>
      cloneFixture(modelRuntimeCatalogFixture),
    );
    const nativeCalls = {
      start: 0,
      finish: 0,
      cancel: 0,
      startRequests: [] as Array<Parameters<NativeDesktopVoicePort["start"]>[0]>,
    };
    const nativeVoice: NativeDesktopVoicePort = {
      status: async () => ({
        available: true,
        phase: "idle",
        generation: null,
        backgroundEligible: false,
        connection: "this_device",
        reasonCode: null,
        redacted: true,
      }),
      start: async (request) => {
        nativeCalls.start += 1;
        nativeCalls.startRequests.push(request);
        return {
          available: true,
          phase: "listening",
          generation: 1,
          backgroundEligible: false,
          connection: "this_device",
          reasonCode: null,
          redacted: true,
        };
      },
      finish: async () => {
        nativeCalls.finish += 1;
        return {
          available: true,
          phase: "processing",
          generation: 1,
          backgroundEligible: false,
          connection: "this_device",
          reasonCode: null,
          redacted: true,
        };
      },
      cancel: async () => {
        nativeCalls.cancel += 1;
        return {
          available: true,
          phase: "idle",
          generation: null,
          backgroundEligible: false,
          connection: "this_device",
          reasonCode: null,
          redacted: true,
        };
      },
      subscribe: async () => () => undefined,
    };
    const runtime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local" as const,
      nativeVoice,
      sidecarStatus: async () => ({
        running: true,
        mode: "threads",
        pid: 6060,
        gatewayUrl: "http://127.0.0.1:8000",
        lastError: null,
        details: { healthPath: "/api/health" },
      }),
    };
    window.history.replaceState({}, "", "/");
    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const button = mounted.container.querySelector<HTMLButtonElement>(
          '[aria-label="Push to talk"]',
        );
        expect(button).not.toBeNull();
        expect(button?.disabled).toBe(false);
      });
      await clickButtonByLabel(mounted.container, "Push to talk");
      await waitUntil(() => {
        expect(nativeCalls.start).toBe(1);
        expect(nativeCalls.startRequests).toEqual([
          {
            trigger: "focused_push_to_talk",
            remoteAudioConsent: false,
          },
        ]);
        expect(requestMethods(transport)).not.toContain(STT_METHODS.listen);
        expect(mounted.container.textContent).toContain("Stop listening");
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
  });

  it("e2e:assistant covers live stream, fallback banner, stop/retry, route sheet, tool approval, and no-model state", async () => {
    const fallbackTransport = assistantGatewayTransport(
      "Fallback final response from local Orchestrator.",
    );
    fallbackTransport.register(ORCHESTRATOR_MODEL_METHODS.getRuntime, () => ({
      generated_at: "2026-06-19T00:00:00Z",
      selected_provider_id: null,
      provider: null,
      providers: [],
      secrets_redacted: true,
    }));
    const fallbackRuntime = testRuntime(
      new Aurora({ transport: fallbackTransport }),
    );
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const fallback = await mountOutcomeApp(fallbackRuntime);
    try {
      await waitUntil(() => {
        expect(fallback.container.textContent).toContain("Model");
        expect(fallback.container.textContent).toContain("Configured default");
        expect(fallback.container.textContent).toContain(
          "Route & privacy sheet",
        );
      });
      await submitAssistantPrompt(fallback.container, "exercise fallback path");
      await waitUntil(() => {
        expect(fallback.container.textContent).toContain(
          "Fallback final response from local Orchestrator.",
        );
        expect(fallback.container.textContent).toContain(
          "Route & privacy sheet",
        );
        expect(fallback.container.textContent).toContain(
          "Route & privacy sheet",
        );
      });
      const routeButton = fallback.container.querySelector<HTMLButtonElement>(
        '[aria-controls="assistant-route-panel"]',
      );
      expect(routeButton, "route sheet trigger").toBeDefined();
      expect(routeButton?.disabled).toBe(false);
      writeOutcomeArtifact(
        "assistant-stream-fallback-route-sheet",
        fallback.container.innerHTML,
      );
    } finally {
      await act(async () => fallback.root.unmount());
      fallback.container.remove();
    }

    const streamTransport = assistantGatewayStreamingTransport();
    const streamRuntime = testRuntime(
      new Aurora({ transport: streamTransport }),
    );
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const live = await mountOutcomeApp(streamRuntime);
    try {
      await submitAssistantPrompt(
        live.container,
        "exercise live stream and tool approval",
      );
      await waitUntil(() => {
        expect(live.container.textContent).toContain(
          "Streaming partial backend text...",
        );
        expect(live.container.textContent).toContain("Action requested");
        expect(live.container.textContent).toContain("Will be updated");
        expect(live.container.textContent).not.toContain("secret-token");
        expect(live.container.textContent).toContain("Requested");
        expect(live.container.textContent).toContain("Status");
        expect(live.container.textContent).toContain("Stop");
        expect(live.container.textContent).not.toContain("Tooling.RequestApproval");
        expect(live.container.textContent).not.toContain("Payload preview");
        expect(live.container.textContent).not.toContain("Retry");
      });
      expect(
        requestMethods(streamTransport).filter(
          (method) => method === ORCHESTRATOR_METHODS.externalUserInput,
        ),
      ).toHaveLength(1);
      await clickButtonByLabel(live.container, "Stop assistant generation");
      await waitUntil(() => {
        expect(live.container.textContent).toContain("Aurora · cancelled");
        expect(requestMethods(streamTransport)).toContain(
          ORCHESTRATOR_METHODS.interrupt,
        );
      });
      expect(live.container.textContent).toContain("Retry");
      await navigateByHref(live.container, "/tools");
      await waitUntil(() => {
        expect(live.container.textContent).toContain("Tools & Plugins");
        expect(live.container.textContent).toContain(
          "Review tool sources",
        );
      });
      writeOutcomeArtifact(
        "assistant-live-stream-tool-stop-retry-tools",
        live.container.innerHTML,
      );
    } finally {
      await act(async () => live.root.unmount());
      live.container.remove();
    }
  });

  it("e2e:assistant keeps the assistant landing page separate from diagnostics", () => {
    const markup = renderTauriRoute("/");
    const mainText = mainContentText(markup);

    expectNoPlaceholderOrDebugUi(markup, "assistant");
    expect(mainText).toContain("Text chat with Aurora");
    expect(mainText).toContain("Prompt");
    expect(mainText).toContain("Push to talk");
    expect(mainText).not.toContain("Voice modes");
    expect(mainText).toContain("Route & privacy sheet");
    expect(mainText).not.toContain("Runtime snapshot");
    for (const marker of DIAGNOSTICS_PAGE_MARKERS) {
      expect(
        mainText,
        `assistant main content must not render diagnostics/dashboard marker ${marker}`,
      ).not.toContain(marker);
    }
    expect(mainText).not.toContain("route registry error");
  });

  it("e2e:admin renders admin routes with admin-specific components instead of placeholders", () => {
    const routes = routesByGroup(adminRouteIds);
    expect(routes.map((route) => route.id)).toEqual([
      "admin",
      "services",
      "access",
      "tokens",
      "backups",
      "scheduler",
      "audit",
    ]);

    for (const route of routes) {
      const markup = renderTauriRoute(route.href);

      expectNoPlaceholderOrDebugUi(markup, route.id);
      expectMarkupToContainText(markup, route.label, route.id);
      expect(markup, route.id).not.toContain("route registry error");
      expect(markup, route.id).not.toContain("aui-badge-privacy-blocked");
    }
  });

  it("e2e:runtime loads model catalog and selects local provider through Config.Set AdminAction", async () => {
    const transport = new RecordingMockAuroraTransport();
    let selectedProvider = "cloud:openai:Orchestrator";
    transport
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => {
        const catalog = cloneFixture(modelRuntimeCatalogFixture);
        catalog.selected_provider_id = selectedProvider;
        catalog.providers = catalog.providers.map((provider) => ({
          ...provider,
          selected: provider.provider_id === selectedProvider,
        }));
        return catalog;
      })
      .register("Gateway.AdminActionDraft", (request) => {
        expect(request.payload).toEqual({
          method_id: "Config.Set",
          payload: {
            key_path: "services.orchestrator.llm.provider",
            value: "llama_cpp",
          },
          affected_resources: ["services.orchestrator.llm.provider"],
        });
        return adminDraftFixture("Config.Set");
      })
      .register("Gateway.AdminActionConfirm", (request) => {
        expect(request.payload).toEqual(
          expect.objectContaining({
            action_id: "aa-Config-Set",
            reason: "Select model source llama.cpp desktop",
            reauth_confirmed: true,
          }),
        );
        return adminConfirmFixture(
          (request.payload as { action_id: string }).action_id,
        );
      })
      .register("Config.Set", (request) => {
        expect(request.payload).toEqual({
          key_path: "services.orchestrator.llm.provider",
          value: "llama_cpp",
        });
        expect(request.headers).toEqual({
          "X-Aurora-AdminAction-Id": "aa-Config-Set",
          "X-Aurora-AdminAction-Token": "token-Config-Set",
          "X-Aurora-AdminAction-Digest": "digest-Config-Set",
        });
        selectedProvider = "local:Orchestrator:llama-cpp";
        return { success: true, previous_value: "openai" };
      });
    const runtime = testRuntime(new Aurora({ transport }));
    window.history.replaceState({}, "", "/models");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Models & Sources");
        expect(container.textContent).toContain("llama.cpp desktop");
        expect(container.textContent).toContain("Selected source (chat)");
        expect(container.textContent).toContain("OpenAI-compatible gateway");
        expect(requestMethods(transport)).toContain(
          ORCHESTRATOR_MODEL_METHODS.getCatalog,
        );
      });
      await clickButtonInRegion(
        container,
        "llama.cpp desktop",
        "Set as active",
      );
      await waitUntil(() => {
        expect(document.body.textContent).toContain("Select llama.cpp desktop");
        expect(
          document.body.querySelector(
            '.aui-modal[role="dialog"], [role="alertdialog"]',
          ),
        ).not.toBeNull();
      });
      const dialog = document.body.querySelector<HTMLElement>(
        '.aui-modal[role="dialog"], [role="alertdialog"]',
      )!;
      const dialogReauth = dialog.querySelector<HTMLElement>(
        'button[role="checkbox"], [data-slot="checkbox"]',
      );
      expect(
        dialogReauth,
        "model source reauth checkbox in dialog",
      ).not.toBeNull();
      await act(async () => {
        dialogReauth!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flushReactWork();
      });
      const confirmButton = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) =>
        button.textContent?.includes("Select llama.cpp desktop"),
      );
      expect(confirmButton, "model provider confirm button").not.toBeNull();
      await act(async () => {
        confirmButton!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flushReactWork();
      });
      await waitUntil(() => {
        const methods = requestMethods(transport);
        expect(methods).toEqual(
          expect.arrayContaining([
            "Gateway.AdminActionDraft",
            "Gateway.AdminActionConfirm",
            "Config.Set",
          ]),
        );
        expect(methods.indexOf("Gateway.AdminActionDraft")).toBeLessThan(
          methods.indexOf("Gateway.AdminActionConfirm"),
        );
        expect(methods.indexOf("Gateway.AdminActionConfirm")).toBeLessThan(
          methods.indexOf("Config.Set"),
        );
        expect(container.textContent).toContain("Model source selection applied.");
        expect(container.textContent).not.toContain("Config.Set");
        expect(container.textContent).not.toContain("AdminAction");
        expect(container.textContent).not.toContain("audit-Config-Set");
      });
      expect(
        requestMethods(transport).filter(
          (method) => method === ORCHESTRATOR_MODEL_METHODS.getCatalog,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime renders model no-provider empty state without writes", async () => {
    const transport = new RecordingMockAuroraTransport();
    transport.register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => ({
      ...cloneFixture(modelRuntimeCatalogFixture),
      selected_provider_id: null,
      providers: [],
      provider_index: {},
      unavailable: [],
    }));
    const runtime = testRuntime(new Aurora({ transport }));
    window.history.replaceState({}, "", "/models");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Models & Sources");
        expect(container.textContent).toContain(
          "No model sources were returned by Aurora.",
        );
      });
      expect(requestMethods(transport)).toContain(
        ORCHESTRATOR_MODEL_METHODS.getCatalog,
      );
      expect(requestMethods(transport)).not.toContain("Config.Set");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime renders mobile local-light planned status without claiming active native model support", async () => {
    const transport = new RecordingMockAuroraTransport();
    transport.register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => {
      const nativeProvider = cloneFixture(
        modelRuntimeCatalogFixture.providers.find(
          (provider) => provider.provider_id === "native:mobile-local-light",
        )!,
      );
      return {
        ...cloneFixture(modelRuntimeCatalogFixture),
        selected_provider_id: null,
        providers: [nativeProvider],
        provider_index: { "native-mobile": ["native:mobile-local-light"] },
        unavailable: ["native:mobile-local-light"],
      };
    });
    const runtime = testRuntime(new Aurora({ transport }));
    window.history.replaceState({}, "", "/models");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Models & Sources");
        expect(container.textContent).toContain("Mobile local-light source");
        expect(container.textContent).toContain("Selected source (chat)");
        expect(container.textContent).toContain("Not set");
        expect(container.textContent).toContain("Mobile local-light source");
        expect(container.textContent).toContain("Planned");
        expect(container.textContent).toContain("Set as active");
        expect(container.textContent).not.toContain(
          "Mobile local-light source ★",
        );
      });
      expect(requestMethods(transport)).toContain(
        ORCHESTRATOR_MODEL_METHODS.getCatalog,
      );
      expect(requestMethods(transport)).not.toContain("Config.Set");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime restores onboarding mode through platform preference store without browser storage", async () => {
    const writes: string[] = [];
    const tiers: string[] = [];
    const modePreferenceStore: NonNullable<
      AuroraTauriRuntime["modePreferenceStore"]
    > = {
      evidence: "test platform secure storage",
      readSelectedMode: async () => "remote-console",
      readSelectedRuntimeTier: async () => "none",
      writeSelectedMode: async (modeId) => {
        writes.push(modeId);
        return true;
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier);
        return true;
      },
    };
    const runtime = testRuntime(
      new Aurora({ transport: new MockAuroraTransport() }),
      modePreferenceStore,
    );
    window.history.replaceState({}, "", "/onboarding");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const activeCard = container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Connect to Aurora");
        expect(container.textContent).toContain("Connect to Aurora");
      });
      expect(writes).toEqual([]);
      expect(tiers).toEqual([]);
      await clickButtonByLabel(container, "Connect to Aurora");
      await waitUntil(() => {
        expect(writes).toEqual(["remote-console"]);
        expect(tiers).toEqual(["none"]);
      });
      expect(container.textContent).not.toContain("localStorage");
      expect(container.textContent).not.toContain("sessionStorage");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime keeps onboarding preference store evidence out of rendered copy", async () => {
    const hostileEvidence = "thin client HTTP Gateway WebRTC invite store evidence";
    const modePreferenceStore: NonNullable<
      AuroraTauriRuntime["modePreferenceStore"]
    > = {
      evidence: hostileEvidence,
      readSelectedMode: async () => "remote-console",
      readSelectedRuntimeTier: async () => "none",
      writeSelectedMode: async () => true,
      writeSelectedRuntimeTier: async () => true,
    };
    const runtime = testRuntime(
      new Aurora({ transport: new MockAuroraTransport() }),
      modePreferenceStore,
    );
    window.history.replaceState({}, "", "/onboarding");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Restored Connect to Aurora");
      });
      expect(container.textContent).not.toContain(hostileEvidence);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime rejects invalid stored onboarding modes and records failed saves", async () => {
    const writes: string[] = [];
    const tiers: string[] = [];
    const modePreferenceStore: NonNullable<
      AuroraTauriRuntime["modePreferenceStore"]
    > = {
      evidence: "test platform secure storage",
      readSelectedMode: async () => "not-a-node-mode",
      readSelectedRuntimeTier: async () => "not-a-tier",
      writeSelectedMode: async (modeId) => {
        writes.push(modeId);
        return false;
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier);
        return false;
      },
    };
    const runtime = testRuntime(
      new Aurora({ transport: new MockAuroraTransport() }),
      modePreferenceStore,
    );
    window.history.replaceState({}, "", "/onboarding");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const activeCard = container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Connect to Aurora");
        expect(container.textContent).toContain("Connect to Aurora");
      });
      expect(writes).toEqual(["remote-console"]);
      expect(tiers).toEqual(["none"]);
      await clickButtonByLabel(container, "Connect to Aurora");
      await waitUntil(() => {
        expect(writes).toEqual(["remote-console", "remote-console"]);
        expect(tiers).toEqual(["none", "none"]);
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime keeps mode selection usable while preference restore completes", async () => {
    let resolveRead: (modeId: string | null) => void = () => undefined;
    const writes: string[] = [];
    const tiers: string[] = [];
    const modePreferenceStore: NonNullable<
      AuroraTauriRuntime["modePreferenceStore"]
    > = {
      evidence: "test platform secure storage",
      readSelectedMode: async () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
      writeSelectedMode: async (modeId) => {
        writes.push(modeId);
        return true;
      },
      writeSelectedRuntimeTier: async (runtimeTier) => {
        tiers.push(runtimeTier);
        return true;
      },
    };
    const runtime = testRuntime(
      new Aurora({ transport: new MockAuroraTransport() }),
      modePreferenceStore,
    );
    window.history.replaceState({}, "", "/onboarding");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      const desktopThinButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) =>
        candidate.textContent?.includes("Connect to Aurora"),
      );
      expect(desktopThinButton?.disabled).toBe(false);
      await act(async () => {
        resolveRead("remote-console");
        await flushReactWork();
      });
      await waitUntil(() => {
        const activeCard = container.querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-checked="true"]',
        );
        expect(activeCard?.textContent).toContain("Connect to Aurora");
      });
      expect(writes).toEqual([]);
      expect(tiers).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:routes keeps diagnostics embedded fallback disabled without fabricating local availability", async () => {
    const snapshot = await buildShellSnapshot(
      new Aurora({ transport: new MockAuroraTransport() }),
    );
    const diagnosticsRoute = routeForPath(snapshot, "/diagnostics");

    expect(diagnosticsRoute.item.id).toBe("diagnostics");
    expect(diagnosticsRoute.state).not.toBe("available-local");
    expect(diagnosticsRoute.state).not.toBe("available-remote");
    expect(diagnosticsRoute.routeable).toBe(false);
    expect(diagnosticsRoute.disabled).toBe(true);
    expect(diagnosticsRoute.evidenceSources).toEqual(["pending SDK request"]);
  });

  it("e2e:runtime resolves embedded deep links to production pages without optimistic route availability", async () => {
    const deepLinks = [
      ["/admin/devices", ["Devices", "Registered devices"]],
      ["/admin/config", ["Configuration", "Staged review"]],
      ["/admin/contracts", ["Service actions", "Service action browser"]],
      [
        "/admin/plugins",
        [
          "Tools & Plugins",
          "Core tools, MCP servers, plugins and mesh peer tools",
        ],
      ],
      ["/admin/pairing", ["Pairing queue"]],
      ["/diagnostics", ["Troubleshooting", "Live checks"]],
      [
        "/memory/policy",
        ["Data policy and retention", "Activity history for policy changes"],
      ],
      ["/settings/native", ["Settings", "Device controls"]],
    ] as const;

    for (const [path, landmarks] of deepLinks) {
      window.history.replaceState({}, "", path);
      const runtime = testRuntime(
        new Aurora({ transport: new MockAuroraTransport() }),
      );
      const { container, root } = await mountOutcomeApp(runtime);
      await waitUntil(() => {
        for (const landmark of landmarks)
          expect(container.textContent).toContain(landmark);
        expect(container.textContent).not.toContain("route registry error");
        expect(container.textContent).not.toContain("embedded SDK route");
      });
      root.unmount();
      container.remove();
    }
  });

  it("e2e:runtime renders runtime routes without false global privacy blocking", () => {
    const routes = routesByGroup(runtimeRouteIds);
    expect(routes.map((route) => route.id)).toEqual([
      "settings",
      "models",
    ]);

    for (const route of routes) {
      const markup = renderTauriRoute(route.href);

      expectNoPlaceholderOrDebugUi(markup, route.id);
      expectMarkupToContainText(markup, route.label, route.id);
      expect(markup, route.id).not.toContain("route registry error");
      if (route.id !== "settings") {
        expect(markup, route.id).not.toContain("Troubleshooting");
        expect(markup, route.id).not.toContain("Service checks");
        expect(markup, route.id).not.toContain("aui-badge-privacy-blocked");
      }
    }
  });

  it("e2e:runtime captures healthy, degraded, and error diagnostics probe states", async () => {
    const healthyTransport = new RecordingMockAuroraTransport();
    window.history.replaceState({}, "", "/admin");
    const healthy = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: healthyTransport })),
    );
    try {
      await waitUntil(() => {
        expect(healthy.container.textContent).toContain("Service checks");
        expect(healthy.container.textContent).toContain(
          "Auth service probe",
        );
        expect(healthy.container.textContent).toContain("Ready");
        expect(healthy.container.textContent).toContain(
          "Feature access",
        );
        expect(healthy.container.textContent).toContain("Frontend errors/logs");
      });
      expect(requestMethods(healthyTransport)).toEqual(
        expect.arrayContaining([
          GATEWAY_METHODS.getSupportBundle,
          GATEWAY_METHODS.getWebRTCDiagnostics,
          GATEWAY_METHODS.getCapabilityCatalog,
        ]),
      );
    } finally {
      await act(async () => healthy.root.unmount());
      healthy.container.remove();
    }

    const errorTransport = new RecordingMockAuroraTransport()
      .fail(
        GATEWAY_METHODS.getSupportBundle,
        "unavailable_service",
        "support bundle down",
      )
      .fail(
        GATEWAY_METHODS.getWebRTCDiagnostics,
        "unavailable_service",
        "diagnostics down",
      );
    window.history.replaceState({}, "", "/admin");
    const error = await mountOutcomeApp(
      testRuntime(new Aurora({ transport: errorTransport })),
    );
    try {
      await waitUntil(() => {
        expect(error.container.textContent).toContain(
          "Some checks need attention",
        );
        expect(error.container.textContent).toContain("Could not connect to this Aurora device. Try again or reconnect the device.");
        expect(error.container.textContent).toContain(
          "Service checks are not available yet.",
        );
        expect(error.container.textContent).not.toContain("Gateway.GetSupportBundle");
      });
    } finally {
      await act(async () => error.root.unmount());
      error.container.remove();
    }
  });

  it("e2e:outcomes drives real navigation, SDK calls, visible errors, and render artifacts", async () => {
    const transport = new RecordingMockAuroraTransport();
    const runtime = testRuntime(new Aurora({ transport }));
    window.history.replaceState({}, "", "/");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Prompt");
        expect(requestMethods(transport)).toContain(
          "Gateway.GetCapabilityCatalog",
        );
        expect(requestMethods(transport)).toContain("Gateway.GetRegistry");
      });
      expect(
        container.querySelector('[aria-label="Primary navigation"]'),
      ).not.toBeNull();
      const shellStatusText = container.querySelector(
        '[aria-label="Aurora shell status"]',
      )?.textContent;
      expect(shellStatusText).toContain("Connected to local");
      expect(shellStatusText).toContain("Healthy");
      expect(shellStatusText).toContain("Member");
      expect(shellStatusText).not.toContain("Desktop Local");
      expect(shellStatusText).not.toContain("Admin");
      expect(container.textContent).toContain("Route & privacy sheet");
      writeOutcomeArtifact("assistant-loaded", container.innerHTML);

      await navigateByHref(container, "/mesh");
      await waitUntil(() => {
        expect(window.location.pathname).toBe("/mesh");
        expect(container.textContent).toContain("Mesh");
        expect(requestMethods(transport)).toContain("Auth.MeshListPeers");
      });
      expect(container.textContent).toContain("trust");
      writeOutcomeArtifact("mesh-after-navigation", container.innerHTML);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }

    const failingTransport = new RecordingMockAuroraTransport();
    failingTransport.register("Gateway.GetCapabilityCatalog", () => {
      throw new AuroraError({
        code: "transport_loss",
        message: "Gateway unavailable for outcome test",
        method: "Gateway.GetCapabilityCatalog",
      });
    });
    const failingRuntime = testRuntime(
      new Aurora({ transport: failingTransport }),
    );
    window.history.replaceState({}, "", "/");

    const failure = await mountOutcomeApp(failingRuntime);
    try {
      await waitUntil(() => {
        expect(failure.container.textContent).toContain(
          "Could not connect to this Aurora device. Try again.",
        );
      });
      expect(requestMethods(failingTransport)).toContain(
        "Gateway.GetCapabilityCatalog",
      );
      writeOutcomeArtifact(
        "gateway-error-visible",
        failure.container.innerHTML,
      );
    } finally {
      await act(async () => failure.root.unmount());
      failure.container.remove();
    }
  });

  it("e2e:runtime probes local Gateway readiness before rendering desktop-local as ready", async () => {
    const transport = new RecordingMockAuroraTransport();
    transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
    const sidecarCalls: string[] = [];
    const readySidecar = {
      running: true,
      mode: "threads",
      pid: 4242,
      gatewayUrl: "http://127.0.0.1:8000",
      lastError: null,
      details: { healthPath: "/api/health" },
    };
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local",
      startSidecar: async () => {
        sidecarCalls.push("start");
        return readySidecar;
      },
      sidecarStatus: async () => {
        sidecarCalls.push("status");
        return readySidecar;
      },
    };
    window.history.replaceState({}, "", "/");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Prompt");
      });
      expect(sidecarCalls).toEqual(["start", "status"]);
      const methods = requestMethods(transport);
      const firstCapabilityCatalog = methods.indexOf(
        GATEWAY_METHODS.getCapabilityCatalog,
      );
      expect(methods.indexOf(GATEWAY_METHODS.health)).toBeGreaterThanOrEqual(0);
      expect(
        methods.indexOf(GATEWAY_METHODS.getRegistry),
      ).toBeGreaterThanOrEqual(0);
      expect(
        methods.indexOf(GATEWAY_METHODS.getServices),
      ).toBeGreaterThanOrEqual(0);
      expect(firstCapabilityCatalog).toBeGreaterThanOrEqual(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime waits through transient Gateway health misses before blocking routes", async () => {
    const transport = new RecordingMockAuroraTransport();
    let healthAttempts = 0;
    transport.register(GATEWAY_METHODS.health, () => {
      healthAttempts += 1;
      if (healthAttempts === 1) {
        throw new AuroraError({
          code: "transport_loss",
          message:
            "Gateway request failed: error sending request for url (http://127.0.0.1:8000/api/health)",
          method: GATEWAY_METHODS.health,
        });
      }
      return { status: "healthy" };
    });
    const readySidecar = {
      running: true,
      mode: "threads",
      pid: 4242,
      gatewayUrl: "http://127.0.0.1:8000",
      lastError: null,
      details: { healthPath: "/api/health" },
    };
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local",
      startSidecar: async () => readySidecar,
      sidecarStatus: async () => readySidecar,
    };
    window.history.replaceState({}, "", "/");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
      });
      await waitUntil(() => {
        expect(container.textContent).toContain("Prompt");
      });
      expect(healthAttempts).toBeGreaterThanOrEqual(2);
      expect(container.textContent).not.toContain("Aurora unavailable");
      expect(container.textContent).not.toContain(
        "Gateway request failed: error sending request for url (http://127.0.0.1:8000/api/health)",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime does not mount route effects before Gateway and DB readiness", async () => {
    const transport = new RecordingMockAuroraTransport();
    let releaseHealth: ((value: { status: string }) => void) | undefined;
    transport.register(
      GATEWAY_METHODS.health,
      () =>
        new Promise<{ status: string }>((resolve) => {
          releaseHealth = resolve;
        }),
    );
    const readySidecar = {
      running: true,
      mode: "threads",
      pid: 4243,
      gatewayUrl: "http://127.0.0.1:8000",
      lastError: null,
      details: { healthPath: "/api/health" },
    };
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local",
      startSidecar: async () => readySidecar,
      sidecarStatus: async () => readySidecar,
    };
    window.history.replaceState({}, "", "/");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      expect(container.textContent).not.toContain("Prompt");
      expect(requestMethods(transport)).toContain(GATEWAY_METHODS.health);
      expect(requestMethods(transport)).not.toContain("DB.ListSessions");

      await act(async () => {
        releaseHealth?.({ status: "healthy" });
        await flushReactWork();
      });
      await waitUntil(() => {
        expect(container.textContent).toContain("Prompt");
        expect(requestMethods(transport)).toContain("DB.ListSessions");
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime renders desktop-local sidecar status from Tauri command status", async () => {
    const transport = new RecordingMockAuroraTransport();
    transport.register(GATEWAY_METHODS.health, () => ({ status: "healthy" }));
    const readySidecar = {
      running: true,
      mode: "threads",
      pid: 5150,
      gatewayUrl: "http://127.0.0.1:8000",
      lastError: null,
      details: { healthPath: "/api/health", command: "aurora_sidecar_status" },
    };
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local",
      startSidecar: async () => readySidecar,
      sidecarStatus: async () => readySidecar,
    };
    window.history.replaceState({}, "", "/admin");

    const { container, root } = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain("Troubleshooting");
        expect(container.textContent).toContain("Aurora is running on this computer");
      });
      expect(container.textContent).toContain("Connected to Aurora");
      expect(container.textContent).toContain("Aurora ready");
      expect(container.textContent).not.toContain(
        "native sidecar status unavailable in this runtime",
      );
      expect(container.textContent).not.toContain("not used in thin mode");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime covers desktop native settings status and browser fallback status", async () => {
    const desktopTransport = new RecordingMockAuroraTransport();
    desktopTransport
      .register(GATEWAY_METHODS.health, () => ({ status: "healthy" }))
      .register("Native.GetCapabilityManifest", () =>
        cloneFixture(nativeCapabilityManifestFixture),
      );
    const desktopRuntime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: desktopTransport })),
      mode: "desktop-local",
      sidecarStatus: async () => ({
        running: true,
        mode: "threads",
        pid: 5150,
        gatewayUrl: "http://127.0.0.1:8000",
        lastError: null,
        details: {
          healthPath: "/api/health",
          command: "aurora_sidecar_status",
        },
      }),
      startSidecar: async () => ({
        running: true,
        mode: "threads",
        pid: 5150,
        gatewayUrl: "http://127.0.0.1:8000",
        lastError: null,
        details: { healthPath: "/api/health", command: "aurora_sidecar_start" },
      }),
      nativePermissionStatus: async () => ({
        platform: "tauri-desktop",
        permissions: { "aurora.nativeCapabilityManifest": true },
        capabilities: { "native.notifications": true },
        deniedByDefault: [],
        privacyClasses: ["system"],
        evidenceSource: "tauri-capability-manifest",
        secretsRedacted: true,
      }),
      trayStatus: async () => ({
        available: true,
        permission: "aurora.trayStatus",
        capability: "desktop.tray",
        source: "aurora_tray_status",
      }),
      notificationStatus: async () => ({
        available: true,
        permission: "aurora.notificationsStatus",
        capability: "native.notifications",
        source: "aurora_notification_status",
      }),
      dialogStatus: async () => ({
        available: true,
        permission: "aurora.dialogStatus",
        capability: "native.dialogs",
        source: "aurora_dialog_status",
      }),
      audioBridgeStatus: async () => ({
        available: true,
        permission: "aurora.audioBridgeStatus",
        capability: "native.audio",
        source: "aurora_audio_bridge_status",
      }),
    };
    window.history.replaceState({}, "", "/settings");

    const desktop = await mountOutcomeApp(desktopRuntime);
    try {
      await waitUntil(() => {
        expect(desktop.container.textContent).toContain("Settings");
        expect(desktop.container.textContent).toContain("Device controls");
        expect(desktop.container.textContent).toContain("Device permissions");
        expect(desktop.container.textContent).toContain("Tray");
        expect(desktop.container.textContent).toContain("Notifications");
        expect(desktop.container.textContent).toContain("Dialogs");
        expect(desktop.container.textContent).toContain("Audio access");
        expect(desktop.container.textContent).toContain("Aurora on this computer");
      });
      expect(desktop.container.textContent).toContain("Available");
    } finally {
      await act(async () => desktop.root.unmount());
      desktop.container.remove();
    }

    const browserTransport = new MockAuroraTransport().lose(
      "Native.GetCapabilityManifest",
    );
    const browserRuntime: AuroraTauriRuntime = {
      ...testRuntime(new Aurora({ transport: browserTransport })),
      mode: "desktop-thin",
      sidecarStatus: async () => null,
      startSidecar: async () => null,
    };
    window.history.replaceState({}, "", "/settings");

    const browser = await mountOutcomeApp(browserRuntime);
    try {
      await waitUntil(() => {
        expect(browser.container.textContent).toContain("Settings");
        expect(browser.container.textContent).toContain("Device controls");
        expect(browser.container.textContent).toContain(
          "Computer-only controls are not available here.",
        );
      });
      expect(browser.container.textContent).not.toContain("Tauri tray status");
      expect(browser.container.textContent).not.toContain("Request permission");
    } finally {
      await act(async () => browser.root.unmount());
      browser.container.remove();
    }
  });
});
