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
} from "@aurora/client";
import {
  auroraNavSections,
  buildShellSnapshot,
  getProductionRouteOracle,
  loadingShellSnapshot,
  encodeMeshInviteToken,
  webRtcProfileFromInvite,
  type BrowserWebRtcSnapshot,
} from "@aurora/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuroraTauriRuntime,
  type AuroraThinConnectionProfile,
} from "./aurora-client";
import {
  AuroraTauriApp,
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
  "Native boundary",
  "Denied native defaults",
  "Shut down shell",
  "WebRTC and ICE diagnostics",
  "Diagnostics overview",
  "Live probes",
  "Redaction preview",
  "Support-bundle export",
  "Service probes",
  "Native manifest and permissions",
  "Sidecar and frontend logs",
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
  native: ["Native platform settings", "Native permissions and capabilities"],
  tools: [
    "Tools & Plugins",
    "Core tools, MCP servers, plugins and mesh peer tools",
  ],
  mesh: ["Mesh & Peers", "Peer trust, pairing and permissions"],
  backups: ["Backups", "Snapshots, verification and restore"],
  settings: ["Settings", "General permissions, schema-backed configuration"],
  models: ["Models & Runtime", "Loading model runtime catalog from Aurora"],
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
    createRuntime: () => runtime,
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
  catalog.providers = [...catalog.providers, provider];
  catalog.actions = [...catalog.actions, action, interruptAction];
  catalog.provider_index = {
    ...catalog.provider_index,
    Orchestrator: [provider.provider_id],
  };
  catalog.action_index = {
    ...catalog.action_index,
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
      secretsPersisted: false,
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
    expect(markup).not.toContain("Native boundary");
    expect(markup).not.toContain("Denied native defaults");
  });

  it("routes the diagnostics dashboard away from the assistant landing page", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");
    window.history.replaceState({}, "", "/admin");

    const markup = renderReadyTauriApp();

    expect(markup).toContain("Native boundary");
    expect(markup).toContain("Runtime mode");
    expect(markup).toContain("Audio bridge");
    expect(markup).not.toContain("iOS microphone capture");
    expect(markup).not.toContain("Android baseline");
    expect(markup).not.toContain("Assistant role probe");
    expect(markup).toContain("Denied native defaults");
    expect(markup).toContain("Diagnostics overview");
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
    expect(markup).toContain("Thin connection mode");
    expect(markup).toContain("webrtc-only");
    expect(markup).toContain("Thin peer status");
    expect(markup).toContain("pairing");
    expect(markup).toContain("memory-only");
    expect(markup).toContain("Desktop thin webrtc-only shell");
    expect(markup).not.toContain("aurora_sidecar_start");
  });

  it.each([
    ["desktop thin", "desktop-thin", "desktop", false],
    ["Android thin", "mobile-native", "android", true],
    ["iOS thin", "mobile-native", "ios", true],
  ] as const)(
    "gates an unconfigured %s runtime on first-run connection onboarding",
    (_label, mode, nativePlatform, showsQrScanner) => {
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
      expect(markup).toContain("Node name");
      expect(markup).toContain("Paste invite");
      expect(markup).toContain("Open invite file");
      expect(markup.includes("Scan invite")).toBe(showsQrScanner);
      expect(markup).not.toContain("HTTP Gateway endpoint");
      expect(markup).not.toContain("WebSocket signaling endpoint");
      expect(markup).not.toContain("Connection mode");
      expect(markup).not.toContain("Stable peer ID");
      expect(markup).toContain('data-onboarding-scroll-viewport="true"');
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

  it("renders the models page for the models route", () => {
    vi.stubEnv("VITE_AURORA_GATEWAY_URL", "");
    window.history.replaceState({}, "", "/models");

    const markup = renderReadyTauriApp();

    expectMarkupToContainText(markup, "Models & Runtime", "/models");
    expect(markup).toContain("Loading model runtime catalog from Aurora");
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
      "Backend service health and restart control",
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
      "General permissions, schema-backed configuration",
    );
    expect(settingsText).toContain("Privacy defaults");
    expect(settingsText).toContain("Voice behavior");
    expect(settingsText).toContain("Theme, accessibility, and local storage");
    expect(settingsText).toContain("Route and fallback policy");
    expect(settingsText).toContain("Configuration");
    expect(settingsText).toContain("Data policy and retention");
    expect(settingsText).toContain("Current platform surface");
    expect(settingsText).toContain("Native controls");
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
          "Deleting a memory previews affected DB and RAG records before removal",
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
        expect(memory.container.textContent).toContain("Route path");
        expect(memory.container.textContent).toContain("Privacy class");
        expect(memory.container.textContent).toContain("Policy");
        expect(memory.container.textContent).toContain("Audit");
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
          "Memory request denied by authentication or permissions",
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
          "Namespace visibility",
        );
        expect(dataPolicy.container.textContent).toContain("Raw audio storage");
        expect(dataPolicy.container.textContent).toContain(
          "Transcript storage",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Remote/mesh fallback",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Export, delete, and import data flows",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Audit trail for policy changes",
        );
        expect(dataPolicy.container.textContent).toContain(
          "Policy edits require AdminAction draft/confirm/audit through Config.Set",
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
          "Core tools, MCP servers, plugins and mesh peer tools",
        );
        expect(tools.container.textContent).toContain("Sources");
        expect(tools.container.textContent).toContain(
          "Selected source tool inventory",
        );
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
        expect(mesh.container.textContent).toContain("Mesh & Peers");
        expect(mesh.container.textContent).toContain(
          "Pending pairing requests",
        );
        expect(mesh.container.textContent).toContain("Route policy");
        expect(mesh.container.textContent).toContain(
          "Service sharing and outbound routing",
        );
        expect(mesh.container.textContent).toContain(
          "Outbound route decision preview (advanced)",
        );
        expect(mesh.container.textContent).toContain("All peer records");
        expect(mesh.container.textContent).toContain("Review & approve");
        expect(mesh.container.textContent).toContain("Gateway.ExplainRoute");
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
      expect(mesh.container.textContent).toContain(
        "Peer permissions and actions",
      );
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
          "WebRTC and ICE diagnostics",
        );
        expect(diagnostics.container.textContent).toContain(
          "Degraded diagnostics inputs",
        );
        expect(diagnostics.container.textContent).toContain("diagnostics down");
        expect(diagnostics.container.textContent).toContain(
          "Repair Gateway.GetWebRTCDiagnostics",
        );
        expect(diagnostics.container.textContent).toContain("Service probes");
        expect(diagnostics.container.textContent).toContain(
          "Sidecar and frontend logs",
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
        expect(success.container.textContent).toContain("local-gateway-test");
      });
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
          "Assistant request denied by authentication or permissions.",
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

  it("e2e:assistant projects realtime voice partials into the composer textbox with recorder above it", async () => {
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
    const runtime = testRuntime(new Aurora({ transport }));
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    const mounted = await mountOutcomeApp(runtime);
    try {
      await waitUntil(() => {
        const textarea =
          mounted.container.querySelector<HTMLTextAreaElement>(
            "#assistant-prompt",
          );
        const recorder = mounted.container.querySelector<HTMLElement>(
          ".aui-composer-recorder-row",
        );
        expect(textarea?.value).toBe("what is the weather");
        expect(textarea?.readOnly).toBe(true);
        expect(recorder).not.toBeNull();
        expect(recorder!.compareDocumentPosition(textarea!)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      });
      writeOutcomeArtifact(
        "assistant-voice-partial-textbox-recorder-above",
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
    const runtime = testRuntime(new Aurora({ transport }));
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

  it("e2e:assistant push-to-talk tries focused WebView capture and falls back to local STT in Tauri local mode", async () => {
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
    transport.register(STT_METHODS.listen, (request) => ({
      success: true,
      session_id:
        (request.payload as { session_id?: string } | undefined)?.session_id ??
        "voice-test-session",
    }));
    const runtime = {
      ...testRuntime(
        new Aurora({ transport: tauriLocalTransportProxy(transport) }),
      ),
      mode: "desktop-local" as const,
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
        expect(requestMethods(transport)).toContain(STT_METHODS.listen);
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
        expect(fallback.container.textContent).toMatch(/pending backend (response|receipt)/);
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
        expect(live.container.textContent).toContain("Tooling.RequestApproval");
        expect(live.container.textContent).toContain("Payload preview");
        expect(live.container.textContent).toContain("[redacted]");
        expect(live.container.textContent).toContain("Requested");
        expect(live.container.textContent).toContain("Status");
        expect(live.container.textContent).toContain("Stop");
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
      expect(live.container.textContent).not.toContain("Retry");
      await navigateByHref(live.container, "/tools");
      await waitUntil(() => {
        expect(live.container.textContent).toContain("Tools & Plugins");
        expect(live.container.textContent).toContain(
          "Core tools, MCP servers, plugins and mesh peer tools",
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
            reason:
              "Select model provider llama.cpp desktop from Aurora Models runtime",
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
        expect(container.textContent).toContain("Models & Runtime");
        expect(container.textContent).toContain("llama.cpp desktop");
        expect(container.textContent).toContain("Active provider (chat)");
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
        "model provider AdminAction reauth checkbox in dialog",
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
        expect(requestMethods(transport)).toEqual(
          expect.arrayContaining([
            "Gateway.AdminActionDraft",
            "Gateway.AdminActionConfirm",
            "Config.Set",
          ]),
        );
        expect(container.textContent).toContain(
          "Provider selection applied through Config.Set AdminAction",
        );
        expect(container.textContent).toContain("audit-Config-Set");
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
        expect(container.textContent).toContain("Models & Runtime");
        expect(container.textContent).toContain(
          "No model runtime providers were returned by the backend catalog.",
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
        expect(container.textContent).toContain("Models & Runtime");
        expect(container.textContent).toContain("Mobile local-light runtime");
        expect(container.textContent).toContain("Active provider (chat)");
        expect(container.textContent).toContain("Not set");
        expect(container.textContent).toContain("Mobile local-light runtime");
        expect(container.textContent).toContain("Planned");
        expect(container.textContent).toContain("Set as active");
        expect(container.textContent).not.toContain(
          "Mobile local-light runtime ★",
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
      expect(writes).toEqual([]);
      expect(tiers).toEqual([]);
      await clickButtonByLabel(container, "Connect to Aurora");
      await waitUntil(() => {
        expect(writes).toEqual(["remote-console"]);
        expect(tiers).toEqual(["none"]);
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("e2e:runtime keeps mode selection locked until preference restore completes", async () => {
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
      expect(desktopThinButton?.disabled).toBe(true);
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
      ["/admin/contracts", ["Contracts registry", "Contract registry browser"]],
      [
        "/admin/plugins",
        [
          "Tools & Plugins",
          "Core tools, MCP servers, plugins and mesh peer tools",
        ],
      ],
      ["/admin/pairing", ["Pairing queue"]],
      ["/diagnostics", ["Native boundary", "Live probes"]],
      [
        "/memory/policy",
        ["Data policy and retention", "Audit trail for policy changes"],
      ],
      ["/settings/native", ["Settings", "Native controls"]],
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
        expect(markup, route.id).not.toContain("Native boundary");
        expect(markup, route.id).not.toContain("Denied native defaults");
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
        expect(healthy.container.textContent).toContain("Service probes");
        expect(healthy.container.textContent).toContain(
          "Gateway service probe",
        );
        expect(healthy.container.textContent).toContain("available-local");
        expect(healthy.container.textContent).toContain(
          "OpenAPI and contract surface",
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
          "Degraded diagnostics inputs",
        );
        expect(error.container.textContent).toContain("support bundle down");
        expect(error.container.textContent).toContain("diagnostics down");
        expect(error.container.textContent).toContain(
          "Gateway.GetSupportBundle did not return service probe rows",
        );
        expect(error.container.textContent).toContain(
          "Repair Gateway.GetSupportBundle redacted log collection",
        );
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
      expect(shellStatusText).toContain("Local mode");
      expect(shellStatusText).toContain("Healthy");
      expect(shellStatusText).toContain("Member");
      expect(shellStatusText).not.toContain("Desktop Local");
      expect(shellStatusText).not.toContain("Admin");
      expect(container.textContent).toContain("Routes");
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
          "Gateway unavailable for outcome test",
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
        expect(container.textContent).toContain("Native boundary");
        expect(container.textContent).toContain("Desktop local shell");
      });
      expect(container.textContent).toContain(
        "threads; gateway=http://127.0.0.1:8000; running=true",
      );
      expect(container.textContent).toContain("Sidecar supervisorrunning");
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
        expect(desktop.container.textContent).toContain("Desktop controls");
        expect(desktop.container.textContent).toContain("Native permissions");
        expect(desktop.container.textContent).toContain("Tray");
        expect(desktop.container.textContent).toContain("Notifications");
        expect(desktop.container.textContent).toContain("Dialogs");
        expect(desktop.container.textContent).toContain("Audio bridge");
        expect(desktop.container.textContent).toContain("Sidecar");
        expect(desktop.container.textContent).toContain(
          "aurora_native_permission_status",
        );
        expect(desktop.container.textContent).toContain("aurora_tray_status");
        expect(desktop.container.textContent).toContain(
          "aurora_notification_status",
        );
        expect(desktop.container.textContent).toContain("aurora_dialog_status");
        expect(desktop.container.textContent).toContain(
          "aurora_audio_bridge_status",
        );
      });
      expect(desktop.container.textContent).toContain(
        "tauri-capability-manifest",
      );
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
        expect(browser.container.textContent).toContain("Native controls");
        expect(browser.container.textContent).toContain(
          "Local desktop sidecar controls are hidden on this surface",
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
