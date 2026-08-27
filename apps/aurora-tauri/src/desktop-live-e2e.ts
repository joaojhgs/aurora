import {
  type AuroraClient,
  type JsonObject,
} from "@aurora/client";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  canonicalJson,
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  createLocalToolingProviderHandlers,
  providerServiceInstanceId,
  type LocalToolAuditRecord,
  type LocalToolDescriptorV1,
  type RegisteredLocalTool,
} from "@aurora/client/local-tools";
import {
  MemoryPeerCredentialStore,
  RustPeerHostAuthorizationStore,
  SecureInboundCredentialVerifierStore,
  createTauriAuthorityPort,
  WebRtcPeerHost,
  createBrowserWebRtcAuroraRuntime,
  createToolingPeerHostRegistry,
  type MeshPeerCredentialRecord,
  type MeshReconnectChallengeMessage,
  type MeshReconnectProofMessage,
  type PeerCredentialStatus,
  type PeerConnectionLike,
  type PeerSessionPeerConnectionFactory,
  type StoredPeerCredentialMetadata,
  type BrowserWebRtcRuntime,
  type WebRtcPeerConnectionProfile,
} from "@aurora/client/webrtc";
import {
  activeRuntimeProfile,
  getAuroraSurfaceProfile,
  sanitizeRuntimeProfileDocument,
  type AuroraRuntimeProfileDocumentV2,
  type AuroraRuntimeProfileV2,
} from "@aurora/ui";
import { createTauriNativePeerConnection } from "./native-webrtc";

const HOOK_NAME = "__AURORA_DESKTOP_LIVE_E2E__";
const HOOK_PAYLOAD_SCHEMA = "aurora.desktop_live_e2e.hook_payload.v1";
const REPORT_SCHEMA = "aurora.desktop_live_e2e.desktop_report.v1";
const AC18_BROWSER_TOOL_CONTRACT_ID = "interop.browser.echo";
const AC18_BROWSER_TOOL_LOCAL_NAME = "interop.browser.echo";
const FORCE_NATIVE_WEBRTC_ENV = "VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC";

function createEphemeralInboundVerifierStore(): SecureInboundCredentialVerifierStore {
  const secrets = new Map<string, string>();
  return new SecureInboundCredentialVerifierStore({
    storage: {
      getOpaqueSecret: async (key) => secrets.get(key),
      setOpaqueSecret: async (key, value) => {
        secrets.set(key, value);
      },
      deleteOpaqueSecret: async (key) => {
        secrets.delete(key);
      },
    },
  });
}

type DesktopLiveE2eWindow = Window & {
  __AURORA_DESKTOP_LIVE_E2E__?: (payload: unknown) => Promise<DesktopLiveE2eReport>;
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export type DesktopLiveE2ePayload = {
  schema: typeof HOOK_PAYLOAD_SCHEMA;
  sessionNonce: string;
  tauriPid: string;
  ready: DesktopLiveReadyPayload;
  runtimeProfile: AuroraRuntimeProfileDocumentV2;
  invite: JsonObject;
  readyPath?: string | undefined;
  runtimeProfilePath?: string | undefined;
  invitePath?: string | undefined;
  reportPath?: string | undefined;
  donePath?: string | undefined;
  roomSecret: string;
};

export type DesktopLiveReadyPayload = {
  lane: "direct" | "stun" | "turn";
  appId: string;
  room: string;
  brokerUrl: string;
  expectedStablePeerId: string;
  localStablePeerId: string;
  localSignalingId: string;
  expectedNegotiationRole: "offerer" | "answerer";
  nodeName: string;
  stunServers: string[];
  turnServers: string[];
  turnUsername?: string | undefined;
  turnCredential?: string | undefined;
  forceRelay: boolean;
  suppressHostCandidates: boolean;
  eventTopic: string;
  eventCorrelationId: string;
  ttsEventTopic: string;
  ttsCorrelationId: string;
  wrongCorrelationId: string;
  mutationTopic: string;
  mutationCountTopic: string;
  mutationStartedTopic: string;
  revokeTopic: string;
  largeEchoTopic: string;
  errorTopic: string;
  streamTopic: string;
  streamStatusTopic: string;
  ac18LocalToolProvider: boolean;
  ac18ToolContractId?: string | undefined;
  ac18ToolLocalName?: string | undefined;
  ac18ProbeId?: string | undefined;
  ac18ForgedFramePeerId?: string | undefined;
  timeoutMs: number;
};

export type DesktopLiveE2eReport = {
  schema: typeof REPORT_SCHEMA;
  status: "passed";
  sessionNonce: string;
  tauriPid: string;
  secretsRedacted: true;
  noHttpFetchTransportUsed: true;
  roleSwitchEvidence: {
    passed: true;
    from: "remote-console";
    to: "mesh-node";
    remoteConsoleAuthorized: boolean;
    meshNodeAuthorized: boolean;
  };
  browserResult: Record<string, unknown>;
  desktopResult: Record<string, unknown>;
  durationMs: number;
};

type HookInstallOptions = {
  target?: DesktopLiveE2eWindow | undefined;
  env?: Record<string, unknown> | undefined;
  runDesktopLiveE2e?: (payload: DesktopLiveE2ePayload) => Promise<DesktopLiveE2eReport>;
};

type Snapshot = ReturnType<ReturnType<typeof createBrowserWebRtcAuroraRuntime>["peer"]["snapshot"]>;
type MeshTransportPort = {
  getManifest(peerId: string): Promise<{
    peerId: string;
    nodeName?: string | null | undefined;
    services?: Array<{ methods?: unknown[] | undefined }> | undefined;
  } | null>;
  streamRequest<T = unknown>(request: { method: string } & Record<string, unknown>): AsyncIterable<T>;
};
type DesktopLiveRuntime = BrowserWebRtcRuntime<AuroraClient> & {
  meshTransport?: MeshTransportPort | undefined;
};
export type DesktopLivePeerConnector = {
  peer: {
    connectPeer(
      profile: WebRtcPeerConnectionProfile,
      options?: { negotiationIntent?: "auto" | "offerer" | "answerer" },
    ): Promise<void>;
  };
};
type RemoteConsoleManifestDrainRuntime = {
  meshTransport?: Pick<MeshTransportPort, "getManifest"> | undefined;
  client: {
    registry: {
      getRegistry(): Promise<unknown>;
    };
  };
  peer: {
    snapshot(): {
      pendingCallCount?: number | undefined;
    };
  };
};

type Ac18BrowserLocalToolProbe = {
  auditRecords: LocalToolAuditRecord[];
  invocationRecords: Array<Record<string, unknown>>;
  peerHost: WebRtcPeerHost;
  peerAuthorityResolver: ReturnType<RustPeerHostAuthorizationStore["asResolverPort"]>;
  peerPairingIssuer: ReturnType<RustPeerHostAuthorizationStore["asPairingIssuerPort"]>;
  toolContractId: string;
  localName: string;
  probeId: string;
  forgedFramePeerId: string;
  registeredTool: RegisteredLocalTool;
  serviceInstanceId: string;
};

type MeshInteropContractReport = Record<string, unknown> & {
  authorized: boolean;
  httpFetchCalls: string[];
  noHttpFetchTransportUsed: boolean;
};
export type DesktopLiveRevocationSnapshot = {
  readonly state: string;
  readonly pendingPairing?: unknown;
};

export type DesktopLiveRevocationObservation = {
  readonly snapshot: DesktopLiveRevocationSnapshot;
  readonly pendingPairingPrompts: number;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly timedOut: boolean;
};

export type DesktopLiveRevocationObservationOptions = {
  readonly snapshot: () => DesktopLiveRevocationSnapshot;
  readonly snapshots: DesktopLiveRevocationSnapshot[];
  readonly startIndex: number;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
};

type DesktopLiveNodeRole = "remote-console" | "mesh-node";

export class DesktopLiveE2eCredentialStore extends MemoryPeerCredentialStore {
  private readonly roomSecrets = new Map<string, Uint8Array>();

  setRoomSecret(ref: string, value: string): void {
    this.roomSecrets.get(ref)?.fill(0);
    this.roomSecrets.set(ref, new TextEncoder().encode(value));
  }

  async getRoomSecret(ref: string): Promise<Uint8Array | null> {
    const value = this.roomSecrets.get(ref);
    return value ? new Uint8Array(value) : null;
  }

  override async close(): Promise<void> {
    // Each role runtime borrows this store. The outer live-E2E run owns its
    // lifetime so a role switch cannot erase the next role's room secret or
    // durable peer credential.
  }

  async destroy(): Promise<void> {
    for (const value of this.roomSecrets.values()) value.fill(0);
    this.roomSecrets.clear();
    await super.close();
  }
}

export function isDesktopLiveE2eHookEnabled(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return Boolean(
    env.VITE_AURORA_DESKTOP_LIVE_E2E === "1" &&
    env.VITE_AURORA_CONNECTION_MODE === "webrtc-only" &&
    env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK === "1",
  );
}

export function isDesktopLiveNativeWebRtcForced(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return env[FORCE_NATIVE_WEBRTC_ENV] === "1";
}

export function resolveDesktopLivePeerConnectionPrimitive(
  env: Record<string, unknown> = import.meta.env,
  hasBrowserRtcPeerConnection = typeof globalThis.RTCPeerConnection === "function",
  supportsNativeWebRtcBridge = desktopLiveSurfaceSupportsNativeWebRtc(),
): "tauri-native-webrtc" | "browser-rtcpeerconnection" {
  const nativeForced = isDesktopLiveNativeWebRtcForced(env);
  if (!supportsNativeWebRtcBridge && (nativeForced || !hasBrowserRtcPeerConnection)) {
    throw new Error(
      "Desktop live E2E requires browser RTCPeerConnection where the native transport is unavailable",
    );
  }
  return nativeForced || !hasBrowserRtcPeerConnection
    ? "tauri-native-webrtc"
    : "browser-rtcpeerconnection";
}

function desktopLiveSurfaceSupportsNativeWebRtc(): boolean {
  return getAuroraSurfaceProfile({
    transportKind: "tauri-thin",
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
  }).supportsNativeWebRtcBridge;
}

export function desktopLiveSignalingId(
  baseSignalingId: string,
  nodeRole: DesktopLiveNodeRole,
): string {
  return nodeRole === "remote-console"
    ? baseSignalingId
    : `${baseSignalingId}-mesh`;
}

export function desktopLivePairingConfirmationMode(
  nodeRole: DesktopLiveNodeRole,
): "automatic" | "managed" {
  return nodeRole === "remote-console" ? "automatic" : "managed";
}

export function installDesktopLiveE2eHook(
  options: HookInstallOptions = {},
): boolean {
  const target = options.target ?? (typeof window === "undefined" ? undefined : window as DesktopLiveE2eWindow);
  if (!target || !isDesktopLiveE2eHookEnabled(options.env)) return false;
  target[HOOK_NAME] = async (rawPayload: unknown) => {
    const payload = validateDesktopLiveE2ePayload(rawPayload);
    return await (options.runDesktopLiveE2e ?? runDesktopLiveE2e)(payload);
  };
  return true;
}

export function validateDesktopLiveE2ePayload(rawPayload: unknown): DesktopLiveE2ePayload {
  if (!isRecord(rawPayload)) throw new Error("Desktop live E2E payload must be an object");
  if (rawPayload.schema !== HOOK_PAYLOAD_SCHEMA) throw new Error("Desktop live E2E payload schema is unsupported");
  const sessionNonce = requiredString(rawPayload.sessionNonce, "sessionNonce");
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(sessionNonce)) throw new Error("Desktop live E2E sessionNonce is invalid");
  const tauriPid = requiredString(rawPayload.tauriPid, "tauriPid");
  if (!/^[1-9]\d{0,19}$/u.test(tauriPid)) throw new Error("Desktop live E2E tauriPid is invalid");
  const roomSecret = requiredString(rawPayload.roomSecret, "roomSecret");
  if (roomSecret.length < 16) throw new Error("Desktop live E2E roomSecret is invalid");
  const ready = validateReadyPayload(rawPayload.ready);
  const runtimeProfile = sanitizeRuntimeProfileDocument(
    requiredRecord(rawPayload.runtimeProfile, "runtimeProfile") as unknown as AuroraRuntimeProfileDocumentV2,
  );
  const invite = requiredRecord(rawPayload.invite, "invite") as JsonObject;
  validateInvite(invite, ready, roomSecret);
  const profile = requireActiveLiveProfile(runtimeProfile);
  if (profile.homeConnection?.webrtcProfile?.room !== ready.room) {
    throw new Error("Desktop live E2E runtime profile room does not match readiness payload");
  }
  if (profile.localNode.meshMembership?.webrtcProfile.room !== ready.room) {
    throw new Error("Desktop live E2E mesh-node profile room does not match readiness payload");
  }
  return {
    schema: HOOK_PAYLOAD_SCHEMA,
    sessionNonce,
    tauriPid,
    ready,
    runtimeProfile,
    invite,
    roomSecret,
    readyPath: optionalString(rawPayload.readyPath),
    runtimeProfilePath: optionalString(rawPayload.runtimeProfilePath),
    invitePath: optionalString(rawPayload.invitePath),
    reportPath: optionalString(rawPayload.reportPath),
    donePath: optionalString(rawPayload.donePath),
  };
}

export async function runDesktopLiveE2e(
  payload: DesktopLiveE2ePayload,
): Promise<DesktopLiveE2eReport> {
  const startedAt = performance.now();
  const ready = payload.ready;
  const profile = requireActiveLiveProfile(payload.runtimeProfile);
  const homeProfile = profile.homeConnection?.webrtcProfile;
  const meshProfile = profile.localNode.meshMembership?.webrtcProfile;
  if (!homeProfile || !meshProfile) {
    throw new Error("Desktop live E2E requires home and mesh WebRTC profiles");
  }
  const credentialStore = new DesktopLiveE2eCredentialStore();
  credentialStore.setRoomSecret(homeProfile.roomSecretRef, payload.roomSecret);
  credentialStore.setRoomSecret(meshProfile.roomSecretRef, payload.roomSecret);
  const snapshots: Snapshot[] = [];
  let remoteRuntime: DesktopLiveRuntime | null = null;
  let meshRuntime: DesktopLiveRuntime | null = null;
  const peerConnectionPrimitive = resolveDesktopLivePeerConnectionPrimitive();
  try {
    remoteRuntime = createInteropRuntime({
      ready,
      profile: homeProfile,
      credentialStore,
      nodeRole: "remote-console",
      signalingPeerId: desktopLiveSignalingId(ready.localSignalingId, "remote-console"),
      localNodeName: "Aurora desktop live E2E",
      snapshots,
    });
    const remoteAuthorized = await connectAndAuthorize(
      remoteRuntime,
      homeProfile,
      ready.expectedNegotiationRole,
      Math.min(30_000, ready.timeoutMs),
      "remote-console authorization",
    );
    await drainRemoteConsoleManifestHandshake(remoteRuntime, ready);
    await remoteRuntime.peer.disconnect("desktop live role switch to mesh-node");
    await remoteRuntime.close();
    remoteRuntime = null;

    const ac18 = ready.ac18LocalToolProvider
      ? createAc18BrowserLocalToolProvider(ready)
      : null;
    meshRuntime = createInteropRuntime({
      ready,
      profile: meshProfile,
      credentialStore,
      nodeRole: "mesh-node",
      signalingPeerId: desktopLiveSignalingId(ready.localSignalingId, "mesh-node"),
      localNodeName: profile.localNode.nodeName,
      snapshots,
      ...(ac18
        ? {
            peerHost: ac18.peerHost,
            peerAuthorityResolver: ac18.peerAuthorityResolver,
            peerPairingIssuer: ac18.peerPairingIssuer,
          }
        : {}),
    });
    const browserResult = await runMeshInteropContract({
      runtime: meshRuntime,
      ready,
      profile: meshProfile,
      snapshots,
      ac18,
    });
    const observedHttpFetchCalls = Array.isArray(browserResult.httpFetchCalls)
      ? browserResult.httpFetchCalls
      : null;
    if (
      browserResult.noHttpFetchTransportUsed !== true ||
      observedHttpFetchCalls === null ||
      observedHttpFetchCalls.length !== 0
    ) {
      throw new Error("Desktop live E2E observed an HTTP request outside WebRTC");
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const meshNodeAuthorized = browserResult.authorized === true;
    return {
      schema: REPORT_SCHEMA,
      status: "passed",
      sessionNonce: payload.sessionNonce,
      tauriPid: payload.tauriPid,
      secretsRedacted: true,
      noHttpFetchTransportUsed: browserResult.noHttpFetchTransportUsed,
      roleSwitchEvidence: {
        passed: true,
        from: "remote-console",
        to: "mesh-node",
        remoteConsoleAuthorized: remoteAuthorized,
        meshNodeAuthorized,
      },
      browserResult,
      desktopResult: {
        runtimeProfileId: profile.id,
        runtimeRole: profile.nodeMode,
        runtimeTier: profile.runtimeTier,
        inviteValidated: true,
        pidBinding: {
          expectedTauriPid: payload.tauriPid,
          source: "webdriver-payload",
          actualOsPidVerified: false,
          requiredSharedChange:
            "Provide a maintained tauri-driver application wrapper or a test-only Rust command before claiming WebView-observed OS PID proof.",
        },
        nativeWebRtcFallback: {
          used: peerConnectionPrimitive === "tauri-native-webrtc",
          primitive: peerConnectionPrimitive,
          forcedByLiveGate: isDesktopLiveNativeWebRtcForced(),
        },
        tauriWebView: typeof window !== "undefined" && Boolean((window as DesktopLiveE2eWindow).__TAURI__ || (window as DesktopLiveE2eWindow).__TAURI_INTERNALS__),
        secretsRedacted: true,
      },
      durationMs,
    };
  } finally {
    await meshRuntime?.close().catch(() => undefined);
    await remoteRuntime?.close().catch(() => undefined);
    await credentialStore.destroy().catch(() => undefined);
  }
}

function createInteropRuntime({
  ready,
  profile,
  credentialStore,
  nodeRole,
  signalingPeerId,
  localNodeName,
  snapshots,
  peerHost,
  peerAuthorityResolver,
  peerPairingIssuer,
}: {
  ready: DesktopLiveReadyPayload;
  profile: WebRtcPeerConnectionProfile;
  credentialStore: DesktopLiveE2eCredentialStore;
  nodeRole: DesktopLiveNodeRole;
  signalingPeerId: string;
  localNodeName: string;
  snapshots: Snapshot[];
  peerHost?: WebRtcPeerHost | undefined;
  peerAuthorityResolver?: ReturnType<RustPeerHostAuthorizationStore["asResolverPort"]> | undefined;
  peerPairingIssuer?: ReturnType<RustPeerHostAuthorizationStore["asPairingIssuerPort"]> | undefined;
}): DesktopLiveRuntime {
  const runtime = createBrowserWebRtcAuroraRuntime({
    mode: "webrtc-only",
    profile,
    localStablePeerId: ready.localStablePeerId,
    localNodeName,
    nodeRole,
    ...(peerHost ? { peerHost } : {}),
    ...(peerAuthorityResolver ? { peerAuthorityResolver } : {}),
    ...(peerPairingIssuer ? { peerPairingIssuer } : {}),
    defaultTimeoutMs: ready.timeoutMs,
    credentialStore,
    createPeerConnection: makePeerConnectionFactory(
      ready.forceRelay,
      ready.suppressHostCandidates,
      ready.turnUsername,
      ready.turnCredential,
    ),
    randomId: signalingIdFactory(signalingPeerId),
    allowInsecureLoopback: true,
    windowLocation: typeof window === "undefined"
      ? { protocol: "tauri:", hostname: "localhost" }
      : window.location,
    pairingConnectPoll: {
      maxAttempts: Math.max(20, Math.ceil(ready.timeoutMs / 500)),
      initialDelayMs: 100,
      maxDelayMs: 500,
      rpcTimeoutMs: 5000,
    },
  });
  runtime.peer.subscribe((snapshot) => {
    snapshots.push(snapshot);
    const pending = snapshot.pendingPairing;
    if (
      pending &&
      desktopLivePairingConfirmationMode(nodeRole) === "automatic"
    ) {
      void runtime.peer.confirmPairing(pending.sessionId).catch(() => undefined);
    }
  });
  return runtime;
}

async function connectAndAuthorize(
  runtime: DesktopLiveRuntime,
  profile: WebRtcPeerConnectionProfile,
  negotiationIntent: DesktopLiveReadyPayload["expectedNegotiationRole"],
  timeoutMs: number,
  label = "mesh-node authorization",
): Promise<boolean> {
  await connectDesktopLivePeer(runtime, profile, negotiationIntent);
  try {
    await waitFor(
      () => runtime.peer.snapshot().state === "authorized",
      `authorized desktop WebRTC DataChannel (${label})`,
      timeoutMs,
    );
  } catch (error) {
    const snapshot = runtime.peer.snapshot();
    const diagnostics = {
      state: snapshot.state,
      negotiationRole: snapshot.negotiationRole,
      connectedStablePeerId: snapshot.connectedStablePeerId,
      connectedSignalingPeerId: snapshot.connectedSignalingPeerId,
      reconnectCount: snapshot.reconnectCount,
      lastRedactedError: snapshot.lastRedactedError,
    };
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}; diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  return runtime.peer.snapshot().state === "authorized";
}

export async function connectDesktopLivePeer(
  runtime: DesktopLivePeerConnector,
  profile: WebRtcPeerConnectionProfile,
  negotiationIntent: DesktopLiveReadyPayload["expectedNegotiationRole"],
): Promise<void> {
  await runtime.peer.connectPeer(profile, { negotiationIntent });
}

export async function reconnectDesktopLivePeer(
  runtime: DesktopLivePeerConnector,
  profile: WebRtcPeerConnectionProfile,
): Promise<void> {
  await connectDesktopLivePeer(runtime, profile, "offerer");
}

export async function drainRemoteConsoleManifestHandshake(
  runtime: RemoteConsoleManifestDrainRuntime,
  ready: Pick<DesktopLiveReadyPayload, "expectedStablePeerId" | "timeoutMs">,
): Promise<void> {
  const meshTransport = runtime.meshTransport;
  if (!meshTransport) {
    throw new Error("Authorized remote-console runtime did not expose its mesh transport");
  }
  const manifest = await meshTransport.getManifest(ready.expectedStablePeerId);
  if (!manifest) {
    throw new Error("Python peer did not return a remote-console manifest before role switch");
  }
  await runtime.client.registry.getRegistry();
  await waitFor(
    () => Number(runtime.peer.snapshot().pendingCallCount ?? 0) === 0,
    "remote-console manifest ACK drain before role switch",
    Math.min(5000, ready.timeoutMs),
  );
}

async function runMeshInteropContract({
  runtime,
  ready,
  profile,
  snapshots,
  ac18,
}: {
  runtime: DesktopLiveRuntime;
  ready: DesktopLiveReadyPayload;
  profile: WebRtcPeerConnectionProfile;
  snapshots: Snapshot[];
  ac18: Ac18BrowserLocalToolProbe | null;
}): Promise<MeshInteropContractReport> {
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return await originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  let autoConfirmPairing = true;
  let stage = "connect-and-authorize";
  const operationTimeoutMs = Math.min(20_000, ready.timeoutMs);
  const reconnectTimeoutMs = Math.min(30_000, ready.timeoutMs);
  const unsubscribe = runtime.peer.subscribe((snapshot) => {
    const pending = snapshot.pendingPairing;
    if (pending && autoConfirmPairing) void runtime.peer.confirmPairing(pending.sessionId).catch(() => undefined);
  });
  try {
    await connectAndAuthorize(
      runtime,
      profile,
      ready.expectedNegotiationRole,
      reconnectTimeoutMs,
    );
    const authorizedSnapshot = runtime.peer.snapshot();
    stage = "registry";
    const registry = await retryDesktopProviderReadiness(
      () => runtime.client.registry.getRegistry(),
      "desktop live registry after WebRTC authorization",
      operationTimeoutMs,
    );
    const meshTransport = runtime.meshTransport;
    if (!meshTransport) throw new Error("Authorized desktop runtime did not expose its mesh transport");
    stage = "manifest";
    const manifest = await retryDesktopProviderReadiness(
      () => meshTransport.getManifest(ready.expectedStablePeerId),
      "desktop live manifest after WebRTC authorization",
      operationTimeoutMs,
    );
    if (!manifest) throw new Error("Python peer did not return a manifest over the DataChannel");
    if (ac18) {
      stage = "browser-local-tool-provider";
      await waitForAc18BrowserProbe(ac18, operationTimeoutMs);
    }
    stage = "intentional-error-rpc";
    const intentionalError = await runtime.client.requestResult(
      ready.errorTopic,
      {},
      { busTopic: ready.errorTopic, timeoutMs: 5000 },
    );
    const fragmentCountsBefore = runtime.peer.snapshot();
    const largeRequestBlob = "x".repeat(512 * 1024);
    stage = "fragmented-large-rpc";
    const largeResult = await runtime.client.request<{ blob: string }>(
      ready.largeEchoTopic,
      { blob: largeRequestBlob },
      { busTopic: ready.largeEchoTopic, timeoutMs: operationTimeoutMs },
    );
    const fragmentCountsAfter = runtime.peer.snapshot();
    const expectedLargeResultBlob = "y".repeat(512 * 1024);

    stage = "completed-stream";
    const completedStreamProbeId = `g009-stream-complete-${ready.lane}`;
    const completedStreamChunks: unknown[] = [];
    for await (const chunk of meshTransport.streamRequest({
      method: ready.streamTopic,
      busTopic: ready.streamTopic,
      payload: { probe_id: completedStreamProbeId, mode: "complete" },
      timeoutMs: operationTimeoutMs,
      audit: { correlationId: completedStreamProbeId },
    })) {
      completedStreamChunks.push(chunk);
    }

    stage = "cancelled-stream";
    const cancelledStreamProbeId = `g009-stream-cancel-${ready.lane}`;
    const streamAbort = new AbortController();
    const cancelledStream = meshTransport.streamRequest<Record<string, unknown>>({
      method: ready.streamTopic,
      busTopic: ready.streamTopic,
      payload: { probe_id: cancelledStreamProbeId, mode: "cancel" },
      timeoutMs: operationTimeoutMs,
      signal: streamAbort.signal,
      audit: { correlationId: cancelledStreamProbeId },
    });
    const cancelledIterator = cancelledStream[Symbol.asyncIterator]();
    const cancelledFirstChunk = await cancelledIterator.next();
    streamAbort.abort();
    let cancelledClientError = "";
    try {
      await cancelledIterator.next();
    } catch (error) {
      cancelledClientError = error instanceof Error ? error.message : String(error);
    }
    const cancelledStreamStatus = await waitForStreamStatus(
      runtime,
      ready.streamStatusTopic,
      cancelledStreamProbeId,
      operationTimeoutMs,
    );

    stage = "candidate-pair";
    const selectedCandidatePair = await waitForSelectedCandidatePair(runtime, ready.lane, Math.min(8000, ready.timeoutMs));
    stage = "generic-scoped-event";
    const subscription = runtime.client.events.subscribe({
      stream: "generic",
      topics: [ready.eventTopic],
      correlationId: ready.eventCorrelationId,
      timeoutMs: operationTimeoutMs,
    });
    const event = await firstEvent(subscription, operationTimeoutMs);
    subscription.close("desktop live event received");

    stage = "wrong-correlation-event";
    const ttsWrong = runtime.client.events.subscribe({
      stream: "generic",
      topics: [ready.ttsEventTopic],
      correlationId: ready.wrongCorrelationId,
      payload: { correlation_id: ready.wrongCorrelationId },
      timeoutMs: 600,
    });
    const wrongCorrelationEvent = await optionalFirstEvent(ttsWrong, 600);
    ttsWrong.close("desktop live wrong correlation probe done");
    stage = "correlated-tts-event";
    const ttsSub = runtime.client.events.subscribe({
      stream: "generic",
      topics: [ready.ttsEventTopic],
      correlationId: ready.ttsCorrelationId,
      payload: { correlation_id: ready.ttsCorrelationId },
      timeoutMs: operationTimeoutMs,
    });
    const ttsEvent = await firstEvent(ttsSub, operationTimeoutMs);
    ttsSub.close("desktop live tts metadata event received");
    stage = "wildcard-event-rejection";
    let wildcardDelivered = false;
    try {
      const wildcardSub = runtime.client.events.subscribe({
        stream: "generic",
        topics: ["TTS.*"],
        correlationId: ready.ttsCorrelationId,
        payload: { correlation_id: ready.ttsCorrelationId },
        timeoutMs: 800,
      });
      wildcardDelivered = (await optionalFirstEvent(wildcardSub, 800)) !== null;
      wildcardSub.close("desktop live wildcard probe done");
    } catch {
      wildcardDelivered = false;
    }

    stage = "authorized-reconnect";
    const reconnectStart = snapshots.length;
    await runtime.peer.disconnect("desktop live reconnect probe").catch(() => undefined);
    await reconnectDesktopLivePeer(runtime, profile);
    await waitFor(() => runtime.peer.snapshot().state === "authorized", "authorized desktop reconnect WebRTC DataChannel", reconnectTimeoutMs);
    const reconnectRegistry = await retryDesktopProviderReadiness(
      () => runtime.client.registry.getRegistry(),
      "desktop live registry after WebRTC reconnect",
      operationTimeoutMs,
    );
    const reconnectPairingPrompts = countPendingPairing(snapshots, reconnectStart);

    stage = "uncertain-mutation";
    const mutationId = `g009-${ready.lane}-${Date.now().toString(36)}`;
    const mutationStart = snapshots.length;
    const mutationStartedSub = runtime.client.events.subscribe({
      stream: "generic",
      topics: [ready.mutationStartedTopic],
      correlationId: mutationId,
      payload: { correlation_id: mutationId },
      timeoutMs: operationTimeoutMs,
    });
    let mutationSettledBeforeDisconnect = false;
    const mutationStartedAtMs = Date.now();
    const mutationPromise = runtime.client.requestResult(
      ready.mutationTopic,
      { mutation_id: mutationId, delay_seconds: 1.2 },
      { busTopic: ready.mutationTopic, timeoutMs: 5000 },
    )
      .then((value: Awaited<ReturnType<AuroraClient["requestResult"]>>) => {
        mutationSettledBeforeDisconnect = true;
        return value.ok
          ? { settled: "resolved", value: value.data, settled_after_disconnect: false }
      : {
          settled: "rejected",
          message: String((value.error as { message?: unknown }).message ?? ""),
          settled_after_disconnect: true,
        };
      })
      .catch((error: unknown) => ({
        settled: "rejected",
        message: error instanceof Error ? error.message : String(error),
        settled_after_disconnect: true,
      }));
    const mutationStartedEvent = await firstEvent(mutationStartedSub, operationTimeoutMs);
    mutationStartedSub.close("desktop live mutation started ack received");
    const disconnectAtMs = Date.now();
    const settledBeforeDisconnect = mutationSettledBeforeDisconnect;
    await runtime.peer.disconnect("desktop live uncertain connection loss before mutation response settled").catch(() => undefined);
    const mutationResult = await Promise.race([
      mutationPromise,
      sleep(350).then(() => ({
        settled: "pending_after_forced_loss",
        message: "no desktop response observed after forced connection loss",
        settled_after_disconnect: false,
      })),
    ]);
    await reconnectDesktopLivePeer(runtime, profile);
    await waitFor(() => runtime.peer.snapshot().state === "authorized", "post-mutation reconnect WebRTC DataChannel", reconnectTimeoutMs);
    await retryDesktopProviderReadiness(
      () => runtime.client.registry.getRegistry(),
      "desktop live registry after uncertain mutation WebRTC reconnect",
      operationTimeoutMs,
    );
    const mutationReconnectPairingPrompts = countPendingPairing(snapshots, mutationStart);
    const mutationCount = await retryDesktopProviderReadiness(
      () => runtime.client.request(
        ready.mutationCountTopic,
        { mutation_id: mutationId },
        { busTopic: ready.mutationCountTopic, timeoutMs: 5000 },
      ),
      "desktop live mutation count after WebRTC reconnect",
      operationTimeoutMs,
    );

    stage = "credential-revocation";
    const revokeResult = await runtime.client.request(ready.revokeTopic, {}, { busTopic: ready.revokeTopic, timeoutMs: 5000 });
    const revokedStart = snapshots.length;
    autoConfirmPairing = false;
    await runtime.peer.disconnect("desktop live revoked credential reconnect probe").catch(() => undefined);
    await reconnectDesktopLivePeer(runtime, profile);
    const revocationObservation = await waitForPostRevocationPairingObservation({
      snapshot: () => runtime.peer.snapshot(),
      snapshots,
      startIndex: revokedStart,
      timeoutMs: reconnectTimeoutMs,
    });
    const revokedSnapshot = revocationObservation.snapshot;
    const revokedPendingPairing = revocationObservation.pendingPairingPrompts;

    const snapshot = runtime.peer.snapshot();
    stage = "report-assembly";
    return {
      lane: ready.lane,
      authorized: authorizedSnapshot.state === "authorized",
      finalStateAfterRevocation: revokedSnapshot.state,
      icePathCategory: [...snapshots].reverse().find((item) => item.icePathCategory !== "unknown")?.icePathCategory ?? snapshot.icePathCategory,
      selectedCandidatePair,
      selectedSignalingBrokerOrigin: snapshot.selectedSignalingBrokerOrigin,
      iceCandidatePolicy: {
        suppressHostCandidates: ready.suppressHostCandidates,
        source: ready.suppressHostCandidates ? "harness browser and Python signaling candidate/SDP filters" : "browser default ICE candidate policy",
      },
      connectedStablePeerId: snapshot.connectedStablePeerId || ready.expectedStablePeerId,
      connectedSignalingPeerId: snapshot.connectedSignalingPeerId,
      protocolCapabilities: snapshot.protocolCapabilities,
      negotiationRole: authorizedSnapshot.negotiationRole,
      pendingCallCount: snapshot.pendingCallCount,
      registryModuleCount: Array.isArray((registry as { modules?: unknown }).modules) ? (registry as { modules: unknown[] }).modules.length : 0,
      registryDigest: (registry as { digest?: string }).digest ?? "",
      manifestEvidence: {
        peerId: manifest.peerId,
        nodeName: manifest.nodeName,
        serviceCount: manifest.services?.length ?? 0,
        methodCount: manifest.services?.reduce((count: number, service) => count + (service.methods?.length ?? 0), 0) ?? 0,
      },
      ac18LocalToolProviderEvidence: ac18
        ? await buildAc18Evidence(ac18)
        : {
            enabled: false,
            toolContractId: null,
            localName: null,
            globalToolId: null,
            providerServiceInstanceId: null,
            schemaHash: null,
            probeId: null,
            invocationRecords: [],
            positiveInvocationCount: 0,
            negativeInvocationCount: 0,
            failClosedWithoutNegativeInvocation: true,
            providerLeaseAtInvocation: null,
            identityOverride: null,
            toolResponseDataDigest: null,
            auditRecords: [],
          },
      errorEvidence: {
        rejected: intentionalError.ok === false,
        code: intentionalError.ok ? null : intentionalError.error.code,
        message: intentionalError.ok ? null : intentionalError.error.message,
      },
      largeRpcEvidence: {
        requestBytes: largeRequestBlob.length,
        requestSha256: await sha256Hex(largeRequestBlob),
        resultBytes: largeResult.blob.length,
        resultSha256: await sha256Hex(largeResult.blob),
        expectedResultSha256: await sha256Hex(expectedLargeResultBlob),
        sentFragmentCount: fragmentCountsAfter.sentFragmentCount - fragmentCountsBefore.sentFragmentCount,
        receivedFragmentCount: fragmentCountsAfter.receivedFragmentCount - fragmentCountsBefore.receivedFragmentCount,
      },
      rpcStreamEvidence: {
        completedChunks: completedStreamChunks,
        cancelledFirstChunk: cancelledFirstChunk.value,
        cancelledClientError,
        pythonStatus: cancelledStreamStatus,
      },
      event,
      ttsEvent,
      scopedEventEvidence: {
        wrongCorrelationDelivered: wrongCorrelationEvent !== null,
        wildcardDelivered,
      },
      reconnectEvidence: {
        registryModuleCount: Array.isArray((reconnectRegistry as { modules?: unknown }).modules)
          ? (reconnectRegistry as { modules: unknown[] }).modules.length
          : 0,
        pendingPairingPrompts: reconnectPairingPrompts,
        authorizedWithoutSas: reconnectPairingPrompts === 0,
      },
      mutationEvidence: {
        mutationId,
        mutationStartedEvent,
        mutationResult,
        mutationCount,
        uncertainLossWindow: {
          startedAckBeforeDisconnect: Boolean(mutationStartedEvent),
          responseSettledBeforeDisconnect: settledBeforeDisconnect,
          requestStartedToDisconnectMs: disconnectAtMs - mutationStartedAtMs,
          disconnectBeforeResponseSettled: !settledBeforeDisconnect,
          browserResultCategory: (mutationResult as { settled?: string }).settled === "rejected"
            ? "transport_lost_before_response"
            : "response_survived_disconnect",
        },
        executionCountAtMostOnce: Number((mutationCount as { execution_count?: unknown }).execution_count ?? 999) <= 1,
        pairingPromptsDuringMutationReconnect: mutationReconnectPairingPrompts,
      },
      revocationEvidence: {
        revokeResult,
        finalState: revokedSnapshot.state,
        pendingPairingPrompts: revokedPendingPairing,
        routeAuthorizedAfterRevocation: revokedSnapshot.state === "authorized",
        observation: {
          elapsedMs: revocationObservation.elapsedMs,
          timeoutMs: revocationObservation.timeoutMs,
          timedOut: revocationObservation.timedOut,
        },
      },
      hostileCaseEvidence: {
        liveMalformedFrames: "not injected in desktop live lane to avoid destabilizing shared DataChannel; see unitVectorTests in aggregate report",
        failClosedObserved: revokedSnapshot.state !== "authorized",
      },
      snapshots: snapshots.map((item) => ({
        state: item.state,
        icePathCategory: item.icePathCategory,
        connectedStablePeerId: item.connectedStablePeerId,
        selectedSignalingBrokerOrigin: item.selectedSignalingBrokerOrigin,
        hasPendingPairing: Boolean(item.pendingPairing),
      })),
      httpFetchCalls: fetchCalls,
      noHttpFetchTransportUsed: fetchCalls.length === 0,
    };
  } catch (error) {
    const snapshot = runtime.peer.snapshot();
    const diagnostics = {
      state: snapshot.state,
      reconnectCount: snapshot.reconnectCount,
      pendingCallCount: snapshot.pendingCallCount,
      pendingStreamCount: snapshot.pendingStreamCount,
      sentFragmentCount: snapshot.sentFragmentCount,
      receivedFragmentCount: snapshot.receivedFragmentCount,
      lastRedactedError: snapshot.lastRedactedError,
    };
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Desktop live ${stage} failed: ${detail}; diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
}

export async function retryDesktopProviderReadiness<T>(
  operation: () => Promise<T>,
  label: string,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastProviderNotReady: unknown = null;
  do {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientProviderNotReady(error)) throw error;
      lastProviderNotReady = error;
      if (Date.now() >= deadline) break;
      await sleep(intervalMs);
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: provider_not_ready`, {
    cause: lastProviderNotReady,
  });
}

export async function waitForAc18BrowserProbe(
  ac18: Pick<Ac18BrowserLocalToolProbe, "auditRecords" | "invocationRecords" | "probeId">,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    () => {
      const positiveInvocationCount = ac18.invocationRecords.filter(
        (record) => record.probe_id === ac18.probeId,
      ).length;
      const negativeAuditObserved = ac18.auditRecords.some(
        (record) =>
          record.action === "execute" &&
          record.result === "not_found" &&
          record.correlation_id === `${ac18.probeId}-negative`,
      );
      return positiveInvocationCount === 1 && negativeAuditObserved;
    },
    "Python peer to complete the browser-local tool provider probe",
    timeoutMs,
  );
}

function isTransientProviderNotReady(error: unknown): boolean {
  if (isCanonicalProviderNotReadyShape(error)) return true;
  if (!isRecord(error)) return false;
  if (hasConflictingProviderReadinessEnvelope(error)) return false;
  if (hasCanonicalProviderNotReadyStatus(error) && (
    error.reason_code === "provider_not_ready" ||
    canonicalReasonCode(error.detail) === "provider_not_ready" ||
    canonicalReasonCode(error.error) === "provider_not_ready"
  )) return true;
  return isCanonicalProviderNotReadyShape(error.detail) ||
    isCanonicalProviderNotReadyShape(error.error);
}

function isCanonicalProviderNotReadyShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasCanonicalProviderNotReadyStatus(value) &&
    value.reason_code === "provider_not_ready";
}

function hasCanonicalProviderNotReadyStatus(value: Record<string, unknown>): boolean {
  const status = typeof value.status === "number" ? value.status : null;
  const numericCode = typeof value.code === "number" ? value.code : null;
  const semanticCode = typeof value.code === "string" ? value.code : null;
  if (semanticCode !== null && semanticCode !== "unavailable_service") return false;
  if (status === null && numericCode === null) return false;
  return (status === null || status === 425) &&
    (numericCode === null || numericCode === 425);
}

function hasConflictingProviderReadinessEnvelope(value: Record<string, unknown>): boolean {
  const numericStatus = typeof value.status === "number" ? value.status : null;
  const numericCode = typeof value.code === "number" ? value.code : null;
  const semanticCode = typeof value.code === "string" ? value.code : null;
  return (numericStatus !== null && numericStatus !== 425) ||
    (numericCode !== null && numericCode !== 425) ||
    (semanticCode !== null &&
      semanticCode !== "unknown" &&
      semanticCode !== "unavailable_service");
}

type DesktopLiveInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function resolveDesktopLiveInvoke(): DesktopLiveInvoke {
  return (command, args) => tauriInvoke(command, args);
}

function canonicalReasonCode(value: unknown): string | null {
  return isRecord(value) && typeof value.reason_code === "string"
    ? value.reason_code
    : null;
}

function createAc18BrowserLocalToolProvider(
  config: DesktopLiveReadyPayload,
): Ac18BrowserLocalToolProbe {
  const toolContractId = config.ac18ToolContractId ?? AC18_BROWSER_TOOL_CONTRACT_ID;
  const localName = config.ac18ToolLocalName ?? AC18_BROWSER_TOOL_LOCAL_NAME;
  const probeId = config.ac18ProbeId ?? `ac18-browser-tool-${config.lane}`;
  const forgedFramePeerId = config.ac18ForgedFramePeerId ?? "forged-ac18-frame-peer";
  const auditRecords: LocalToolAuditRecord[] = [];
  const invocationRecords: Array<Record<string, unknown>> = [];
  let peerHost: WebRtcPeerHost | null = null;
  const descriptor: LocalToolDescriptorV1 = {
    version: 1,
    toolContractId,
    localName,
    displayName: "Interop browser echo",
    description: "Returns a deterministic browser-local interop response",
    argsSchema: {
      type: "object",
      properties: {
        probe_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["probe_id", "message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        probe_id: { type: "string" },
        message: { type: "string" },
        handled_by: { type: "string" },
        caller_peer_id: { type: "string" },
      },
      required: ["probe_id", "message", "handled_by", "caller_peer_id"],
      additionalProperties: false,
    },
    argumentVisibility: {
      probe_id: "public",
      message: "public",
    },
    requiredPermissions: ["Tooling.ExecuteTool"],
    resourceScopes: ["interop.browser.echo"],
    safetyClass: "standard",
    privacyClass: "public",
    mutating: false,
    dataEgress: false,
    nativeRequirements: { capabilityIds: ["interop.browser.echo"], osPermissions: [] },
    confirmationPolicy: "never",
    handlerId: "interop.browser.echo",
  };
  const registry = new LocalToolRegistry({
    stablePeerId: config.localStablePeerId,
    providerLabel: "Aurora desktop live E2E",
    source: "core",
    sourceId: "desktop-live-e2e",
  });
  const registeredTool = registry.register({
    descriptor,
    handler: ({ arguments: args, context }) => {
      const providerLease = peerHost?.currentLease() ?? null;
      const record = {
        probe_id: String(args.probe_id ?? ""),
        message: String(args.message ?? ""),
        returned_message: `${String(args.message ?? "")}:browser-local`,
        handled_by: config.localStablePeerId,
        caller_peer_id: context.callerPeerId,
        method_id: context.methodId,
        permissions: [...context.permissions],
        permission_count: context.permissions.length,
        provider_lease: providerLease,
      };
      invocationRecords.push(record);
      return {
        probe_id: record.probe_id,
        message: record.returned_message,
        handled_by: record.handled_by,
        caller_peer_id: context.callerPeerId,
      };
    },
  });
  const serviceInstanceId = providerServiceInstanceId(config.localStablePeerId);
  const policy = new LocalToolExecutionPolicy({
    providerPeerId: config.localStablePeerId,
    providerServiceInstanceId: serviceInstanceId,
    ports: {
      hasMethodGrant: (methodId) =>
        [
          "Tooling.GetTools",
          "Tooling.GetExportCatalog",
          "Tooling.PrepareExecution",
          "Tooling.ExecuteTool",
        ].includes(methodId),
      hasToolGrant: (candidate) => candidate === toolContractId,
      hasCapabilityGrant: (candidate) => candidate === "interop.browser.echo",
      hasResourceGrant: (candidate) => candidate === "interop.browser.echo",
    },
  });
  const provider = createLocalToolingProviderHandlers({
    registry,
    policy,
    providerPeerId: config.localStablePeerId,
    serviceInstanceId,
    audit: (record) => {
      auditRecords.push(record);
    },
    exportDecision: { isShared: () => true },
    cursorSecret: `ac18-cursor-${config.lane}`,
    connectionEpoch: () => {
      const lease = peerHost?.currentLease();
      return typeof lease?.connection_epoch === "string" ? lease.connection_epoch : null;
    },
    authorityRevision: {
      catalog_revision: 1,
      export_policy_revision: 1,
      auth_grant_revision: 1,
      manifest_revision: 1,
      switch_revision: 0,
      protocol_revision: 1,
    },
  });
  const authorizationStore = new RustPeerHostAuthorizationStore(
    createTauriAuthorityPort(resolveDesktopLiveInvoke()),
  );
  const authorityPairingIssuer = authorizationStore.asPairingIssuerPort(
    createEphemeralInboundVerifierStore(),
  );
  const peerPairingIssuer: ReturnType<
    RustPeerHostAuthorizationStore["asPairingIssuerPort"]
  > = {
    async issue(selector, options) {
      const issued = await authorityPairingIssuer.issue(selector, options);
      await authorizationStore.hydrate({
        verifiers: [],
        grants: [
          {
            version: 1,
            grantId: "ac18-python-gateway-grant",
            tokenId: issued.verifier.tokenId,
            claimantPeerId: issued.verifier.claimantPeerId,
            verifierPeerId: issued.verifier.verifierPeerId,
            roomName: issued.verifier.roomName,
            allowedMethodIds: [
              "Tooling.GetTools",
              "Tooling.GetExportCatalog",
              "Tooling.PrepareExecution",
              "Tooling.ExecuteTool",
            ],
            allowedToolContractIds: [toolContractId],
            capabilityPackIds: ["interop.browser.echo"],
            resourceScopes: ["interop.browser.echo"],
            createdAtMs: Date.now(),
            grantRevision: 1,
          },
        ],
      });
      return {
        ...issued,
        grantedPermissions: ["Tooling.GetTools", "Tooling.ExecuteTool"],
      };
    },
    async rollback(selector) {
      await authorityPairingIssuer.rollback(selector);
    },
  };
  const configuredPeerHost = new WebRtcPeerHost({
    localPeerId: config.localStablePeerId,
    nodeName: "Aurora desktop live E2E",
    registry: createToolingPeerHostRegistry(provider),
    // Pairing and provider decisions share this one native Rust authority.
    // The grant is hydrated only after Rust issues the selector it belongs to,
    // so the manifest can never be authorized against a placeholder token.
    authorizationStore,
    randomId: () => `ac18-epoch-${config.lane}`,
    defaultTimeoutMs: config.timeoutMs,
  });
  peerHost = configuredPeerHost;
  return {
    auditRecords,
    invocationRecords,
    peerAuthorityResolver: authorizationStore.asResolverPort(),
    peerPairingIssuer,
    peerHost: configuredPeerHost,
    toolContractId,
    localName,
    probeId,
    forgedFramePeerId,
    registeredTool,
    serviceInstanceId,
  };
}

async function buildAc18Evidence(ac18: Ac18BrowserLocalToolProbe): Promise<Record<string, unknown>> {
  const positiveInvocations = ac18.invocationRecords.filter(
    (record) => record.probe_id === ac18.probeId,
  );
  const negativeInvocations = ac18.invocationRecords.filter(
    (record) => String(record.probe_id ?? "").endsWith("-negative"),
  );
  const first = positiveInvocations[0];
  const digestInput = {
    caller_peer_id: first?.caller_peer_id ?? null,
    handled_by: first?.handled_by ?? null,
    message: first?.returned_message ?? null,
    probe_id: first?.probe_id ?? null,
  };
  return {
    enabled: true,
    authorityImplementation: "rust-native-tauri",
    toolContractId: ac18.toolContractId,
    localName: ac18.localName,
    globalToolId: ac18.registeredTool.toolInfo.global_tool_id,
    providerServiceInstanceId: ac18.serviceInstanceId,
    schemaHash: ac18.registeredTool.schemaHash,
    probeId: ac18.probeId,
    invocationRecords: ac18.invocationRecords,
    positiveInvocationCount: positiveInvocations.length,
    negativeInvocationCount: negativeInvocations.length,
    failClosedWithoutNegativeInvocation: negativeInvocations.length === 0,
    providerLeaseAtInvocation: first?.provider_lease ?? null,
    identityOverride: {
      forgedFrameCallerPeerId: ac18.forgedFramePeerId,
      forgedFrameEffectivePermissions: [],
      observedCallerPeerId: first?.caller_peer_id ?? null,
      authenticatedCallerPeerId: "python-gateway-g009",
      observedPermissionCount: first?.permission_count ?? 0,
      frameCallerPeerIdOverridden:
        first?.caller_peer_id === "python-gateway-g009" &&
        first?.caller_peer_id !== ac18.forgedFramePeerId,
      framePermissionsOverridden: Number(first?.permission_count ?? 0) > 0,
    },
    toolResponseDataDigest: positiveInvocations.length === 1
      ? await sha256Hex(canonicalJson(digestInput))
      : null,
    auditRecords: ac18.auditRecords.map((record) => ({
      action: record.action,
      result: record.result,
      reason_code: record.reason_code ?? null,
      provider_peer_id: record.provider_peer_id,
      provider_service_instance_id: record.provider_service_instance_id,
      caller_peer_id: record.caller_peer_id,
      method_id: record.method_id,
      global_tool_id: record.global_tool_id ?? null,
      local_tool_name: record.local_tool_name ?? null,
      correlation_id: record.correlation_id ?? null,
      connection_epoch: record.connection_epoch ?? null,
      redacted: record.redacted,
      secrets_redacted: record.secrets_redacted,
    })),
  };
}

function requireActiveLiveProfile(document: AuroraRuntimeProfileDocumentV2): AuroraRuntimeProfileV2 {
  const profile = activeRuntimeProfile(document);
  if (!profile) throw new Error("Desktop live E2E runtime profile is missing an active profile");
  if (profile.nodeMode !== "mesh-node") throw new Error("Desktop live E2E active profile must switch to mesh-node");
  if (profile.runtimeTier !== "lightweight-ts") throw new Error("Desktop live E2E active profile must use lightweight-ts");
  if (!profile.homeConnection?.webrtcProfile) throw new Error("Desktop live E2E active profile is missing home WebRTC profile");
  if (!profile.localNode.meshMembership?.webrtcProfile) throw new Error("Desktop live E2E active profile is missing mesh-node membership profile");
  return profile;
}

function validateReadyPayload(raw: unknown): DesktopLiveReadyPayload {
  const ready = requiredRecord(raw, "ready");
  const lane = requiredString(ready.lane, "ready.lane");
  if (lane !== "direct" && lane !== "stun" && lane !== "turn") throw new Error("Desktop live E2E lane is unsupported");
  const timeoutMs = requiredNumber(ready.timeoutMs, "ready.timeoutMs");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new Error("Desktop live E2E timeoutMs is invalid");
  return {
    lane,
    appId: requiredString(ready.appId, "ready.appId"),
    room: requiredString(ready.room, "ready.room"),
    brokerUrl: requiredString(ready.brokerUrl, "ready.brokerUrl"),
    expectedStablePeerId: requiredString(ready.expectedStablePeerId, "ready.expectedStablePeerId"),
    localStablePeerId: requiredString(ready.localStablePeerId, "ready.localStablePeerId"),
    localSignalingId: requiredString(ready.localSignalingId, "ready.localSignalingId"),
    expectedNegotiationRole: ready.expectedNegotiationRole === "answerer" ? "answerer" : "offerer",
    nodeName: requiredString(ready.nodeName, "ready.nodeName"),
    stunServers: stringArray(ready.stunServers, "ready.stunServers"),
    turnServers: stringArray(ready.turnServers, "ready.turnServers"),
    turnUsername: optionalString(ready.turnUsername),
    turnCredential: optionalString(ready.turnCredential),
    forceRelay: ready.forceRelay === true,
    suppressHostCandidates: ready.suppressHostCandidates === true,
    eventTopic: requiredString(ready.eventTopic, "ready.eventTopic"),
    eventCorrelationId: requiredString(ready.eventCorrelationId, "ready.eventCorrelationId"),
    ttsEventTopic: requiredString(ready.ttsEventTopic, "ready.ttsEventTopic"),
    ttsCorrelationId: requiredString(ready.ttsCorrelationId, "ready.ttsCorrelationId"),
    wrongCorrelationId: requiredString(ready.wrongCorrelationId, "ready.wrongCorrelationId"),
    mutationTopic: requiredString(ready.mutationTopic, "ready.mutationTopic"),
    mutationCountTopic: requiredString(ready.mutationCountTopic, "ready.mutationCountTopic"),
    mutationStartedTopic: requiredString(ready.mutationStartedTopic, "ready.mutationStartedTopic"),
    revokeTopic: requiredString(ready.revokeTopic, "ready.revokeTopic"),
    largeEchoTopic: requiredString(ready.largeEchoTopic, "ready.largeEchoTopic"),
    errorTopic: requiredString(ready.errorTopic, "ready.errorTopic"),
    streamTopic: requiredString(ready.streamTopic, "ready.streamTopic"),
    streamStatusTopic: requiredString(ready.streamStatusTopic, "ready.streamStatusTopic"),
    ac18LocalToolProvider: ready.ac18LocalToolProvider === true,
    ac18ToolContractId: optionalString(ready.ac18ToolContractId),
    ac18ToolLocalName: optionalString(ready.ac18ToolLocalName),
    ac18ProbeId: optionalString(ready.ac18ProbeId),
    ac18ForgedFramePeerId: optionalString(ready.ac18ForgedFramePeerId),
    timeoutMs,
  };
}

function validateInvite(invite: JsonObject, ready: DesktopLiveReadyPayload, roomSecret: string): void {
  if (invite.kind !== "aurora.mesh.invite") throw new Error("Desktop live E2E invite kind is unsupported");
  const signaling = requiredRecord(invite.signaling, "invite.signaling");
  if (signaling.app_id !== ready.appId || signaling.room !== ready.room) {
    throw new Error("Desktop live E2E invite signaling does not match readiness payload");
  }
  if (signaling.room_password !== roomSecret) {
    throw new Error("Desktop live E2E invite room secret does not match payload");
  }
}

function makePeerConnectionFactory(
  forceRelay: boolean,
  suppressHostCandidates: boolean,
  turnUsername?: string,
  turnCredential?: string,
): PeerSessionPeerConnectionFactory {
  return (configuration: RTCConfiguration): PeerConnectionLike => {
    const iceServers = configuration.iceServers?.map((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      if (
        urls.some((url) => typeof url === "string" && (url.startsWith("turn:") || url.startsWith("turns:"))) &&
        !server.username &&
        turnUsername &&
        turnCredential
      ) {
        return { ...server, username: turnUsername, credential: turnCredential };
      }
      return server;
    });
    const next: RTCConfiguration = { ...configuration };
    if (iceServers !== undefined) next.iceServers = iceServers;
    if (forceRelay) next.iceTransportPolicy = "relay";
    if (resolveDesktopLivePeerConnectionPrimitive() === "tauri-native-webrtc") {
      return createTauriNativePeerConnection(next);
    }
    const pc = new RTCPeerConnection(next);
    return (suppressHostCandidates ? suppressHostIceCandidates(pc) : pc) as unknown as PeerConnectionLike;
  };
}

function suppressHostIceCandidates(pc: RTCPeerConnection): RTCPeerConnection {
  let assigned: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  return new Proxy(pc, {
    get(target, property) {
      if (property === "onicecandidate") return assigned;
      if (property === "localDescription") return stripHostIceCandidatesFromSdp(target.localDescription);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "onicecandidate") {
        assigned = value;
        target.onicecandidate = typeof value === "function"
          ? (event: RTCPeerConnectionIceEvent) => {
              if (event.candidate !== null && isHostCandidate(event.candidate)) return;
              value(event);
            }
          : value;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
}

function stripHostIceCandidatesFromSdp(
  description: RTCSessionDescription | RTCSessionDescriptionInit | null,
): RTCSessionDescriptionInit | null {
  if (description === null) return null;
  const separator = description.sdp?.includes("\r\n") ? "\r\n" : "\n";
  return {
    type: description.type,
    sdp: (description.sdp ?? "")
      .split(/\r?\n/u)
      .filter((line) => !/^a=candidate:.*\btyp\s+host\b/iu.test(line))
      .join(separator),
  };
}

function isHostCandidate(candidate: unknown): boolean {
  const text = typeof candidate === "string"
    ? candidate
    : typeof (candidate as { candidate?: unknown } | null)?.candidate === "string"
      ? String((candidate as { candidate: string }).candidate)
      : "";
  return /\btyp\s+host\b/u.test(text);
}

async function waitForStreamStatus(
  runtime: DesktopLiveRuntime,
  topic: string,
  probeId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await runtime.client.request<Record<string, unknown>>(
      topic,
      { probe_id: probeId },
      { busTopic: topic, timeoutMs: 5000 },
    );
    if (last.cancelled === true) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Python stream cancellation: ${JSON.stringify(last)}`);
}

async function waitForSelectedCandidatePair(
  runtime: DesktopLiveRuntime,
  lane: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = await runtime.peer.getSelectedCandidatePairEvidence();
  while (Date.now() < deadline) {
    if (candidatePairMatchesLane(lane, last as unknown as Record<string, unknown>)) return last as unknown as Record<string, unknown>;
    await sleep(100);
    last = await runtime.peer.getSelectedCandidatePairEvidence();
  }
  return last as unknown as Record<string, unknown>;
}

function candidatePairMatchesLane(lane: string, selectedPair: Record<string, unknown>): boolean {
  if (selectedPair.selected !== true) return false;
  const category = selectedPair.category || "unknown";
  const localType = selectedPair.localCandidateType;
  const remoteType = selectedPair.remoteCandidateType;
  const candidateTypes = new Set([localType, remoteType]);
  const stunGather = isRecord(selectedPair.stunServerReflexiveCandidate) ? selectedPair.stunServerReflexiveCandidate : {};
  if (lane === "direct") {
    return category === "host" ||
      (
        category === "prflx" &&
        candidateTypes.has("prflx") &&
        candidateTypes.has("host") &&
        stunGather.gathered !== true &&
        !candidateTypes.has("relay")
      );
  }
  if (lane === "stun") {
    const configuredServerProven = stunGather.urlMatchesConfiguredStunServer === true;
    const singleConfiguredServerProven = stunGather.urlMatchesConfiguredStunServer === null &&
      stunGather.configuredStunServerCount === 1;
    const stunGatheredViaConfiguredServer =
      stunGather.gathered === true &&
      stunGather.candidateType === "srflx" &&
      (configuredServerProven || singleConfiguredServerProven) &&
      stunGather.rawAddressRedacted === true;
    return (candidateTypes.has("srflx") || candidateTypes.has("prflx")) &&
      (
        (category === "srflx" && candidateTypes.has("srflx")) ||
        (category === "prflx" && candidateTypes.has("prflx") && stunGatheredViaConfiguredServer)
      );
  }
  if (lane === "turn") return category === "relay" && candidateTypes.has("relay");
  return false;
}

async function firstEvent<T>(iterable: AsyncIterable<T>, timeoutMs: number): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for DataChannel event")), timeoutMs));
  try {
    const result = await Promise.race([iterator.next(), timer]);
    if (result.done) throw new Error("DataChannel event stream ended before first event");
    return result.value;
  } finally {
    await iterator.return?.();
  }
}

async function optionalFirstEvent<T>(iterable: AsyncIterable<T>, timeoutMs: number): Promise<T | null> {
  try {
    return await firstEvent(iterable, timeoutMs);
  } catch {
    return null;
  }
}

function countPendingPairing(snapshots: Snapshot[], startIndex = 0): number {
  return snapshots.slice(startIndex).filter((item) => Boolean(item.pendingPairing)).length;
}

export async function waitForPostRevocationPairingObservation(
  options: DesktopLiveRevocationObservationOptions,
): Promise<DesktopLiveRevocationObservation> {
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let lastSnapshot = options.snapshot();
  let observedPendingPairingPrompts = countRevocationPendingPairingPrompts(
    options.snapshots,
    options.startIndex,
    lastSnapshot,
  );
  while (true) {
    lastSnapshot = options.snapshot();
    const pendingPairingPrompts = countRevocationPendingPairingPrompts(
      options.snapshots,
      options.startIndex,
      lastSnapshot,
    );
    observedPendingPairingPrompts = Math.max(observedPendingPairingPrompts, pendingPairingPrompts);
    if (
      lastSnapshot.state === "authorized" ||
      lastSnapshot.state === "failed" ||
      (lastSnapshot.state === "awaiting-sas-confirmation" && observedPendingPairingPrompts > 0)
    ) {
      return {
        snapshot: lastSnapshot,
        pendingPairingPrompts: observedPendingPairingPrompts,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        timedOut: false,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        snapshot: lastSnapshot,
        pendingPairingPrompts: observedPendingPairingPrompts,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: options.timeoutMs,
        timedOut: true,
      };
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

function countRevocationPendingPairingPrompts(
  snapshots: DesktopLiveRevocationSnapshot[],
  startIndex: number,
  current: DesktopLiveRevocationSnapshot,
): number {
  const observed = snapshots.slice(startIndex).filter((item) => Boolean(item.pendingPairing)).length;
  return observed > 0 || !current.pendingPairing ? observed : 1;
}

function signalingIdFactory(signalingId: string): () => string {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return signalingId;
    }
    return globalThis.crypto.randomUUID();
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function waitFor(predicate: () => boolean, label: string, timeoutMs: number, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Desktop live E2E ${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Desktop live E2E ${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`Desktop live E2E ${label} must be a number`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Desktop live E2E ${label} must be a string array`);
  }
  return [...value];
}
