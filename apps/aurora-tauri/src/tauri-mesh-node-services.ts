import type {
  GeneratedBackendMethodOutput,
  AndroidVoiceForegroundServiceRequestResult,
  AndroidVoiceForegroundServiceStatus,
  NativeCapabilityManifest,
  TauriSidecarStatus,
} from "@aurora/client";
import type {
  EnvelopeCryptoPort,
  JsonValue as LocalDataJsonValue,
  LocalAuditRecord,
  LocalAuditRepository,
  LocalDataBackend,
  LocalDataSession,
} from "@aurora/client/local-data";
import {
  EncryptedPeerGrantRepository,
  LocalDataPeerAuditSink,
  PeerRevocationHub,
  RustPeerHostAuthorizationStore,
  createDurableHydrationLoader,
  createTauriAuthorityPort,
  type PeerAuthorityResolverPort,
  type PeerGrantManagerPort,
  type PeerRevocationController,
  SecureInboundCredentialVerifierStore,
  createPeerHostLocalSpeechSource,
  type InboundVerifierSecretStoragePort,
  type PeerHostLocalSpeechRuntimePort,
  type PeerHostLocalSpeechSource,
  type PeerHostLocalSpeechStage,
  type PeerHostLocalSpeechSessionStage,
  type PeerHostLocalSpeechSessionMethodId,
  type PeerHostLocalSpeechSessionRequest,
  type PeerGrantRepository,
  type RustAuthorityAuditFailureReporter,
} from "@aurora/client/webrtc";
import {
  DurableFeatureSharingController,
  LocalToolRegistry,
  ProviderLocalApprovalController,
  TrackingPeerPairingIssuer,
  createMeshNodeLocalToolProvider,
  type LocalFeatureSharingPort,
  type PeerPairingIssuerLike,
  type LocalToolAuditPort,
  type LocalToolAuditRecord,
  type LocalToolAuditResult,
  type LocalToolExportDecisionPort,
  type MeshNodeLocalToolProviderComposition,
  type ProviderLocalApprovalControllerPort,
} from "@aurora/client/local-tools";
import {
  normalizeAuroraWebRtcRolloutFlags,
  registerTauriNativeCapabilityPack,
  type AuroraRuntimeProfileV2,
  type AuroraWebRtcRolloutFlags,
  type TauriNativeCapabilityTransport,
} from "@aurora/ui";

import { TauriEnvelopeCryptoPort, TauriSqliteLocalDataBackend } from "./local-data/index.js";
import { createTauriInboundVerifierSecretStorage } from "./tauri-inbound-verifier-storage.js";

export interface TauriMeshNodeServicesOptions {
  readonly profile: AuroraRuntimeProfileV2 | null | undefined;
  readonly rolloutFlags: Partial<AuroraWebRtcRolloutFlags> | null | undefined;
  readonly nativeTransport?: TauriNativeCapabilityTransport | undefined;
  readonly backend?: LocalDataBackend | undefined;
  readonly crypto?: EnvelopeCryptoPort | undefined;
  readonly verifierSecretStorage?: InboundVerifierSecretStoragePort | undefined;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly exportDecision?: LocalToolExportDecisionPort | undefined;
  readonly approvalController?: ProviderLocalApprovalControllerPort | undefined;
  readonly invokeCommand?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly subscribeNativeNodeConfigPolicyChanges?: (listener: () => void) => Promise<() => void>;
  readonly reportAuthorityAuditFailure?: RustAuthorityAuditFailureReporter | undefined;
}

export type TauriMeshNodeServicesDisabledReason =
  | "profile_missing"
  | "profile_not_mesh_node"
  | "runtime_tier_not_lightweight_ts"
  | "rollout_disabled"
  | "capability_packs_disabled"
  | "mesh_membership_missing"
  | "native_evidence_missing"
  | "native_tools_unavailable"
  | "local_tool_audit_unavailable"
  | "durable_store_unavailable";

export interface DisabledTauriMeshNodeServices {
  readonly enabled: false;
  readonly reason: TauriMeshNodeServicesDisabledReason;
  readonly registeredToolIds: readonly string[];
  readonly localToolRegistry?: LocalToolRegistry | undefined;
  readonly localToolApprovals?: undefined;
  readonly peerHost?: undefined;
  readonly authorityResolver?: undefined;
  readonly pairingIssuer?: undefined;
  readonly grantManager?: undefined;
  readonly revocationController?: undefined;
  close(): Promise<void>;
}

export interface EnabledTauriMeshNodeServices {
  readonly enabled: true;
  readonly profileId: string;
  readonly localNodeId: string;
  readonly localPeerId: string;
  readonly nodeName: string;
  readonly localDataSession: LocalDataSession;
  readonly envelopeCrypto: EnvelopeCryptoPort;
  readonly verifierStore: SecureInboundCredentialVerifierStore;
  readonly grantRepository: PeerGrantRepository;
  readonly auditSink: LocalDataPeerAuditSink;
  readonly authorizationStore: RustPeerHostAuthorizationStore;
  readonly authorityResolver: PeerAuthorityResolverPort;
  readonly pairingIssuer: PeerPairingIssuerLike;
  readonly localFeatureSharing: LocalFeatureSharingPort;
  readonly revocationBroadcaster: PeerRevocationHub;
  readonly revocationController: PeerRevocationController;
  readonly grantManager: PeerGrantManagerPort;
  readonly localToolRegistry: LocalToolRegistry;
  readonly localToolProvider: MeshNodeLocalToolProviderComposition;
  readonly localToolApprovals: ProviderLocalApprovalControllerPort;
  readonly peerHost: MeshNodeLocalToolProviderComposition["peerHost"];
  readonly registeredToolIds: readonly string[];
  close(): Promise<void>;
}

export type TauriMeshNodeServices =
  | DisabledTauriMeshNodeServices
  | EnabledTauriMeshNodeServices;

const REQUIRED_ROLLOUT_FLAGS: readonly (keyof AuroraWebRtcRolloutFlags)[] = [
  "webrtc_thin_client",
  "webrtc_scoped_subscriptions",
  "webrtc_fragmentation",
  "webrtc_app_layer_e2ee",
  "mesh_node_runtime_v1",
  "local_tool_provider_v1",
];

const NATIVE_CAPABILITY_PACK_ID = "native-actions";

export async function createTauriMeshNodeServices(
  options: TauriMeshNodeServicesOptions,
): Promise<TauriMeshNodeServices> {
  const profile = options.profile;
  if (!profile) return disabled("profile_missing");
  if (profile.nodeMode !== "mesh-node") return disabled("profile_not_mesh_node");
  if (profile.runtimeTier !== "lightweight-ts") {
    return disabled("runtime_tier_not_lightweight_ts");
  }
  if (!allRequiredRolloutsEnabled(options.rolloutFlags)) return disabled("rollout_disabled");
  if (!profile.localNode.enabledCapabilityPacks.includes(NATIVE_CAPABILITY_PACK_ID)) {
    return disabled("capability_packs_disabled");
  }
  const meshMembership = profile.localNode.meshMembership;
  if (!meshMembership) return disabled("mesh_membership_missing");
  if (!options.nativeTransport || !(await nativeEvidenceAvailable(options.nativeTransport))) {
    return disabled("native_evidence_missing");
  }

  const localPeerId = profile.localNode.stablePeerId;
  const nodeName = profile.localNode.nodeName;
  const registry = new LocalToolRegistry({
    stablePeerId: localPeerId,
    providerLabel: nodeName,
    source: "core",
    sourceId: "tauri-native",
  });
  let registered: Awaited<ReturnType<typeof registerTauriNativeCapabilityPack>>;
  let localToolApprovals: ProviderLocalApprovalControllerPort | null = null;
  let unsubscribeNodeConfigPolicy: (() => void) | undefined;
  try {
    registered = await registerTauriNativeCapabilityPack({
      registry,
      transport: options.nativeTransport,
    });
  } catch {
    return disabled("native_tools_unavailable", { registry, registeredToolIds: [] });
  }
  if (registered.registered.length === 0) {
    return disabled("native_tools_unavailable", { registry, registeredToolIds: [] });
  }

  const invokeCommand = options.invokeCommand;
  const backend = options.backend
    ?? (invokeCommand ? new TauriSqliteLocalDataBackend({ invokeCommand }) : null);
  if (!backend) {
    return disabled("durable_store_unavailable", {
      registry,
      registeredToolIds: registered.registered,
    });
  }
  let session: LocalDataSession;
  try {
    session = await backend.open(profile.id, localPeerId);
  } catch {
    await backend.close().catch(() => undefined);
    return disabled("durable_store_unavailable", {
      registry,
      registeredToolIds: registered.registered,
    });
  }

  try {
    const crypto = options.crypto
      ?? (invokeCommand
        ? new TauriEnvelopeCryptoPort({
            profileId: profile.id,
            localNodeId: localPeerId,
            invokeCommand,
          })
        : null);
    const verifierSecretStorage = options.verifierSecretStorage
      ?? (invokeCommand
        ? createTauriInboundVerifierSecretStorage({ invoke: invokeCommand })
        : null);
    if (!crypto || !verifierSecretStorage) {
      throw new Error("Tauri durable authority adapters are unavailable");
    }
    const verifierStore = new SecureInboundCredentialVerifierStore({
      storage: verifierSecretStorage,
    });
    const grantRepository = new EncryptedPeerGrantRepository({
      metadataRepository: session.peerGrants,
      crypto,
      profileId: profile.id,
      localNodeId: localPeerId,
    });
    const auditSink = new LocalDataPeerAuditSink({
      auditRepository: session.localAudit,
      profileId: profile.id,
      localNodeId: localPeerId,
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    const localToolAudit = createDurableLocalToolAudit({
      auditRepository: session.localAudit,
      profileId: profile.id,
      localNodeId: localPeerId,
      ...(options.randomId ? { randomId: options.randomId } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const randomBytes = options.randomBytes ?? secureRandomBytes;
    if (!invokeCommand) {
      throw new Error("Tauri mesh authority commands are unavailable");
    }
    // After R2 the authority is Rust. TypeScript keeps the durable adapters and
    // replays a relationship's rows into the authority the first time it is
    // asked about that peer; it does not decide anything itself. See
    // `docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md` section 1.
    const authorizationStore = new RustPeerHostAuthorizationStore(
      createTauriAuthorityPort(invokeCommand),
      // The tool-to-permission projection lives in the provider composition,
      // which is the only place that knows the local tool registry.
      undefined,
      createDurableHydrationLoader({
        verifierStore,
        grantRepository,
        ...(options.now ? { now: options.now } : {}),
      }),
      // The authority records what it decided; persisting those rows stays here,
      // because the durable store is TypeScript's.
      auditSink,
      options.reportAuthorityAuditFailure ?? reportTauriAuthorityAuditFailure,
    );
    const nowMs = options.now ?? (() => Date.now());
    const authorityResolver = authorizationStore.asResolverPort();
    const basePairingIssuer = authorizationStore.asPairingIssuerPort(verifierStore, nowMs);
    const revocationBroadcaster = new PeerRevocationHub();
    const revocationController = authorizationStore.asRevocationControllerPort(
      revocationBroadcaster,
      { verifierStore, grantRepository },
      nowMs,
    );
    const grantManager = authorizationStore.asGrantManagerPort(nowMs, grantRepository);
    const localFeatureSharing = new DurableFeatureSharingController({
      registry,
      session,
      grantManager,
      localVerifierPeerId: localPeerId,
      roomName: meshMembership.webrtcProfile.room,
      crypto,
      ...(options.now ? { now: options.now } : {}),
    });
    await localFeatureSharing.load();
    const pairingIssuer = new TrackingPeerPairingIssuer({
      delegate: basePairingIssuer,
      registry: localFeatureSharing,
    });
    const approvalController = options.approvalController
      ?? new ProviderLocalApprovalController({
        ...(options.now ? { nowMs: options.now } : {}),
      });
    localToolApprovals = approvalController;
    let scheduleProviderRefresh: (() => void) | undefined;
    let policyChangedBeforeProviderReady = false;
    if (options.subscribeNativeNodeConfigPolicyChanges) {
      try {
        unsubscribeNodeConfigPolicy = await options.subscribeNativeNodeConfigPolicyChanges(() => {
          if (scheduleProviderRefresh) scheduleProviderRefresh();
          else policyChangedBeforeProviderReady = true;
        });
      } catch {
        // Without the change signal, a cached capability snapshot could outlive
        // the policy that authorized it. Keep tooling available without speech.
      }
    }
    const speechHost = unsubscribeNodeConfigPolicy
      ? await createRefreshableTauriNativeSpeechHost(options.invokeCommand, localPeerId)
      : undefined;
    const localToolProvider = createMeshNodeLocalToolProvider({
      nodeMode: "mesh-node",
      localPeerId,
      nodeName,
      registry,
      authorityResolver,
      authorizationStore,
      exportDecision: options.exportDecision ?? localFeatureSharing,
      audit: localToolAudit,
      cursorSecret: randomBytes(32),
      providerEnabled: true,
      approvalController,
      approvalPolicy: localFeatureSharing,
      ...(speechHost ? { speechHost } : {}),
      ...(options.now ? { clock: options.now } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    if (!localToolProvider.enabled) {
      await speechHost?.close().catch(() => undefined);
      unsubscribeNodeConfigPolicy?.();
      approvalController.close();
      await backend.close().catch(() => undefined);
      return disabled("native_tools_unavailable", {
        registry,
        registeredToolIds: registered.registered,
      });
    }

    let providerRefreshClosed = false;
    let providerRefreshFailure: unknown;
    let providerRefreshQueue = Promise.resolve();
    scheduleProviderRefresh = () => {
      providerRefreshQueue = providerRefreshQueue.then(async () => {
        if (providerRefreshClosed) return;
        if (providerRefreshFailure !== undefined) throw providerRefreshFailure;
        speechHost?.setVisible(false);
        await localToolProvider.peerHost.suspendLocalProvider("speech_policy_changed");
        await speechHost?.refresh();
        if (providerRefreshClosed) return;
        await localToolProvider.peerHost.resumeLocalProvider();
      });
      void providerRefreshQueue.catch((error) => { providerRefreshFailure ??= error; });
    };
    if (policyChangedBeforeProviderReady) scheduleProviderRefresh();
    let initialFeatureSnapshotSeen = false;
    const unsubscribeFeatureSharing = localFeatureSharing.subscribe(() => {
      if (!initialFeatureSnapshotSeen) {
        initialFeatureSnapshotSeen = true;
        return;
      }
      scheduleProviderRefresh();
    });
    let initialApprovalPolicySnapshotSeen = false;
    const unsubscribeApprovalPolicy = localFeatureSharing.subscribeApprovalPolicies(() => {
      if (!initialApprovalPolicySnapshotSeen) {
        initialApprovalPolicySnapshotSeen = true;
        return;
      }
      scheduleProviderRefresh();
    });

    return {
      enabled: true,
      profileId: profile.id,
      localNodeId: localPeerId,
      localPeerId,
      nodeName,
      localDataSession: session,
      envelopeCrypto: crypto,
      verifierStore,
      grantRepository,
      auditSink,
      authorizationStore,
      authorityResolver,
      pairingIssuer,
      localFeatureSharing,
      revocationBroadcaster,
      revocationController,
      grantManager,
      localToolRegistry: registry,
      localToolProvider,
      localToolApprovals: approvalController,
      peerHost: localToolProvider.peerHost,
      registeredToolIds: localToolProvider.registeredToolIds,
      close: async () => {
        providerRefreshClosed = true;
        unsubscribeFeatureSharing();
        unsubscribeApprovalPolicy();
        unsubscribeNodeConfigPolicy?.();
        let failure = providerRefreshFailure;
        try {
          await providerRefreshQueue;
        } catch (error) {
          failure ??= error;
        }
        localToolProvider.peerHost.suspend("provider_closed");
        try {
          await speechHost?.close();
        } catch (error) {
          failure ??= error;
        }
        approvalController.close();
        try {
          await backend.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      },
    };
  } catch (error) {
    unsubscribeNodeConfigPolicy?.();
    localToolApprovals?.close();
    await backend.close().catch(() => undefined);
    return disabled(error instanceof LocalToolAuditUnavailableError
      ? "local_tool_audit_unavailable"
      : "durable_store_unavailable", {
      registry,
      registeredToolIds: registered.registered,
    });
  }
}

interface NativeSpeechSnapshot {
  readonly revision: number;
  readonly stt: PeerHostLocalSpeechStage | null;
  readonly tts: PeerHostLocalSpeechStage | null;
  readonly kws?: unknown;
  readonly vad?: unknown;
}

interface NativeSpeechSessionStageSnapshot {
  readonly enabled: boolean;
  readonly modelId: string | null;
  readonly modelRevision: string;
  readonly language: string | null;
  readonly phraseRevision?: string | null;
  readonly format: "pcm_s16le";
  readonly sampleRateHz: 16_000;
  readonly channels: 1;
  readonly maxChunkBytes: number;
  readonly maxInputBytes: number;
  readonly maxQueue: number;
  readonly idleLeaseMs: number;
  readonly maxActiveMs: number;
  readonly maxConcurrentSessions: 1;
  readonly implementation: "native";
}

interface ActiveNativeSpeechSession {
  readonly remotePeerId: string;
  readonly connectionEpoch: string;
  readonly stage: "kws" | "vad";
  readonly sessionId: string;
  readonly context: PeerHostLocalSpeechSessionRequest["callContext"];
  terminal: boolean;
}

async function createTauriNativeSpeechHost(
  invokeCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  peerId: string,
): Promise<PeerHostLocalSpeechSource | undefined> {
  let snapshot: NativeSpeechSnapshot;
  try {
    const value = await invokeCommand("aurora_native_speech_host_snapshot");
    if (!isNativeSpeechSnapshot(value)) return undefined;
    snapshot = value;
  } catch {
    // A missing command registration or unavailable local engine simply means
    // this host has no local speech capability. It never enables a fake path.
    return undefined;
  }
  const kws = isNativeSpeechSessionStage(snapshot.kws, "kws") ? toSpeechSessionStage(snapshot.revision, snapshot.kws) : undefined;
  const vad = isNativeSpeechSessionStage(snapshot.vad, "vad") ? toSpeechSessionStage(snapshot.revision, snapshot.vad) : undefined;
  if (!snapshot.stt?.enabled && !snapshot.tts?.enabled && !kws && !vad) return undefined;

  const activeOperations = new Map<string, { readonly settled: Promise<void>; finish(): void }>();
  const startOperation = (): { readonly id: string; readonly settled: Promise<void>; finish(): void } => {
    const id = globalThis.crypto.randomUUID();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    let finished = false;
    const operation = {
      settled,
      finish() {
        if (finished) return;
        finished = true;
        activeOperations.delete(id);
        resolveSettled();
      },
    };
    activeOperations.set(id, operation);
    return { id, ...operation };
  };
  const activeNativeSessions = new Map<string, ActiveNativeSpeechSession>();
  const cancelNativeSession = async (
    key: string,
    owner: ActiveNativeSpeechSession,
    reason: "interrupted" | "revoked",
  ): Promise<void> => {
    if (owner.terminal) {
      activeNativeSessions.delete(key);
      return;
    }
    const methodId = `${owner.stage === "kws" ? "WakeWord" : "VAD"}.StreamCancel` as PeerHostLocalSpeechSessionMethodId;
    const result = await invokeCommand("aurora_peer_host_local_speech_stage", {
      request: {
        operation: "cancel",
        stage: owner.stage,
        payload: { reason, session_id: owner.sessionId },
        callContext: {
          id: owner.context.id,
          methodId,
          remotePeerId: owner.context.remotePeerId,
          identity: owner.context.identity,
          authenticatedPeerContext: owner.context.authenticatedPeerContext,
        },
      },
    });
    if (!isNativeSpeechTerminalResult(result)) throw new Error("Local speech session is unavailable");
    activeNativeSessions.delete(key);
  };
  const runtime: PeerHostLocalSpeechRuntimePort = {
    async transcribeSpeech(request) {
      const stage = snapshot.stt;
      if (!stage?.enabled || !stage.modelId) throw new Error("Local transcription is unavailable");
      const operation = startOperation();
      try {
        const result = await invokeCommand("aurora_peer_host_local_speech_transcribe", {
          request: {
            operationId: operation.id,
            modelId: stage.modelId,
            language: request.language ?? null,
            sampleRateHz: 16_000,
            audioBase64: encodePcmBase64(request.pcm),
          },
        });
        if (!isTextResult(result)) throw new Error("Local transcription is unavailable");
        return { text: result.text };
      } finally {
        operation.finish();
      }
    },
    async synthesizeSpeech(request) {
      const stage = snapshot.tts;
      if (!stage?.enabled || !stage.voiceId) throw new Error("Local synthesis is unavailable");
      const operation = startOperation();
      try {
        const result = await invokeCommand("aurora_peer_host_local_speech_synthesize", {
          request: {
            operationId: operation.id,
            modelId: stage.modelId,
            voiceId: request.voiceId,
            language: stage.language,
            text: request.text,
            speed: request.speed,
          },
        });
        if (!isNativeSpeechAudioResult(result)) throw new Error("Local synthesis is unavailable");
        return {
          pcm: decodePcmBase64(result.audioBase64),
          sampleRateHz: result.sampleRateHz,
          durationMs: result.durationMs,
        };
      } finally {
        operation.finish();
      }
    },
    async cancel() {
      const operations = [...activeOperations.entries()];
      const cancellations = await Promise.allSettled(operations.map(async ([id]) => {
        await invokeCommand("aurora_peer_host_local_speech_cancel", { operationId: id });
      }));
      await Promise.all(operations.map(([, operation]) => operation.settled));
      const failure = cancellations.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    async cancelSpeechSessions(remotePeerId, connectionEpoch, reason) {
      const terminalReason = reason === "peer_authority_revoked" ? "revoked" : "interrupted";
      const owned = [...activeNativeSessions.entries()].filter(([, owner]) =>
        owner.remotePeerId === remotePeerId && owner.connectionEpoch === connectionEpoch);
      const results = await Promise.allSettled(owned.map(([key, owner]) => cancelNativeSession(key, owner, terminalReason)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    async closeSpeechSessions(reason) {
      const terminalReason = reason === "peer_authority_revoked" ? "revoked" : "interrupted";
      const results = await Promise.allSettled([...activeNativeSessions.entries()]
        .map(([key, owner]) => cancelNativeSession(key, owner, terminalReason)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    async speechSession<TMethodId extends PeerHostLocalSpeechSessionMethodId>(
      request: PeerHostLocalSpeechSessionRequest<TMethodId>,
    ) {
      const authenticated = request.callContext.authenticatedPeerContext;
      const connectionEpoch = authenticated?.connectionEpoch;
      if (!authenticated || typeof connectionEpoch !== "string" || connectionEpoch.length === 0 ||
        request.callContext.identity.callerPeerId !== request.callContext.remotePeerId) {
        throw new Error("Local speech session is unavailable");
      }
      const input = request.payload as unknown as Record<string, unknown>;
      const rawSessionId = typeof input.session_id === "string" ? input.session_id : undefined;
      const key = rawSessionId === undefined ? undefined : nativeSpeechSessionKey(request.stage, rawSessionId);
      const owner = key === undefined ? undefined : activeNativeSessions.get(key);
      if (request.operation !== "begin" && (!owner ||
        owner.remotePeerId !== request.callContext.remotePeerId || owner.connectionEpoch !== connectionEpoch)) {
        throw new Error("Local speech session is unavailable");
      }
      const callContext = {
        id: request.callContext.id,
        methodId: request.methodId,
        remotePeerId: request.callContext.remotePeerId,
        identity: request.callContext.identity,
        authenticatedPeerContext: authenticated,
      };
      const result = await invokeCommand("aurora_peer_host_local_speech_stage", {
        request: {
          operation: request.operation,
          stage: request.stage,
          payload: request.payload,
          callContext,
        },
      });
      if (request.operation === "begin" && isNativeSpeechAdmission(result) &&
        result.status === "admitted" && result.session_id) {
        activeNativeSessions.set(nativeSpeechSessionKey(request.stage, result.session_id), {
          remotePeerId: request.callContext.remotePeerId,
          connectionEpoch,
          stage: request.stage,
          sessionId: result.session_id,
          context: request.callContext,
          terminal: false,
        });
      } else if (key !== undefined && isNativeSpeechTerminalResult(result)) {
        const terminalOwner = activeNativeSessions.get(key);
        if (terminalOwner) {
          terminalOwner.terminal = true;
          const terminalEntries = [...activeNativeSessions.entries()].filter(([, value]) => value.terminal);
          while (terminalEntries.length > 32) {
            const [oldestKey] = terminalEntries.shift()!;
            activeNativeSessions.delete(oldestKey);
          }
        }
      }
      return result as GeneratedBackendMethodOutput<TMethodId>;
    },
  };
  return createPeerHostLocalSpeechSource({
    peerId,
    runtime,
    revision: snapshot.revision,
    ...(snapshot.stt ? { stt: { ...snapshot.stt, implementation: "native" } } : {}),
    ...(snapshot.tts ? { tts: { ...snapshot.tts, implementation: "native" } } : {}),
    ...(kws ? { kws } : {}),
    ...(vad ? { vad } : {}),
  });
}

type RefreshablePeerHostLocalSpeechSource = PeerHostLocalSpeechSource & {
  refresh(): Promise<void>;
};

async function createRefreshableTauriNativeSpeechHost(
  invokeCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  peerId: string,
): Promise<RefreshablePeerHostLocalSpeechSource> {
  let source = await createTauriNativeSpeechHost(invokeCommand, peerId);
  let registry: Parameters<PeerHostLocalSpeechSource["register"]>[0] | undefined;
  let closed = false;

  return {
    register(nextRegistry) {
      registry = nextRegistry;
      source?.register(nextRegistry);
    },
    capabilities() {
      return source?.capabilities() ?? [];
    },
    setReady(readiness) {
      source?.setReady(readiness);
    },
    setVisible(visible) {
      source?.setVisible(visible);
    },
    async disconnectPeer(remotePeerId, connectionEpoch, reason) {
      await source?.disconnectPeer(remotePeerId, connectionEpoch, reason);
    },
    async refresh() {
      if (closed) return;
      const previous = source;
      previous?.setVisible(false);
      await previous?.close();
      if (source === previous) source = undefined;

      const next = await createTauriNativeSpeechHost(invokeCommand, peerId);
      if (closed) {
        await next?.close();
        return;
      }
      source = next;
      if (registry) next?.register(registry);
    },
    async close() {
      closed = true;
      const previous = source;
      previous?.setVisible(false);
      await previous?.close();
      if (source === previous) source = undefined;
    },
  };
}

function isNativeSpeechSnapshot(value: unknown): value is NativeSpeechSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<NativeSpeechSnapshot>;
  return Number.isSafeInteger(candidate.revision)
    && candidate.revision! >= 0
    && (candidate.stt === null || isNativeSpeechStage(candidate.stt, "stt"))
    && (candidate.tts === null || isNativeSpeechStage(candidate.tts, "tts"));
}

function isNativeSpeechSessionStage(
  value: unknown,
  stage: "kws" | "vad",
): value is NativeSpeechSessionStageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<NativeSpeechSessionStageSnapshot>;
  const commonValid = typeof candidate.enabled === "boolean"
    && (typeof candidate.modelId === "string" || candidate.modelId === null)
    && typeof candidate.modelRevision === "string" && candidate.modelRevision.length > 0 && candidate.modelRevision.length <= 128
    && (typeof candidate.language === "string" || candidate.language === null)
    && (candidate.phraseRevision === undefined || candidate.phraseRevision === null ||
      (typeof candidate.phraseRevision === "string" && candidate.phraseRevision.length > 0 && candidate.phraseRevision.length <= 128))
    && candidate.format === "pcm_s16le"
    && candidate.sampleRateHz === 16_000
    && candidate.channels === 1
    && Number.isSafeInteger(candidate.maxChunkBytes) && candidate.maxChunkBytes! > 0 && candidate.maxChunkBytes! <= 65_536
    && Number.isSafeInteger(candidate.maxInputBytes) && candidate.maxInputBytes! > 0 && candidate.maxInputBytes! <= 4_194_304
    && Number.isSafeInteger(candidate.maxQueue) && candidate.maxQueue! >= 0 && candidate.maxQueue! <= 4
    && Number.isSafeInteger(candidate.idleLeaseMs) && candidate.idleLeaseMs! > 0 && candidate.idleLeaseMs! <= 300_000
    && Number.isSafeInteger(candidate.maxActiveMs) && candidate.maxActiveMs! > 0 && candidate.maxActiveMs! <= 300_000
    && candidate.maxConcurrentSessions === 1
    && candidate.implementation === "native";
  if (!commonValid) return false;
  if (!candidate.enabled) return true;
  return typeof candidate.modelId === "string" && candidate.modelId.length > 0 && candidate.modelId.length <= 128
    && (candidate.language === null || (candidate.language!.length > 0 && candidate.language!.length <= 64))
    && (stage === "kws" ? typeof candidate.phraseRevision === "string" && candidate.phraseRevision.length > 0 : candidate.phraseRevision == null);
}

function toSpeechSessionStage(
  capabilityRevision: number,
  snapshot: NativeSpeechSessionStageSnapshot,
): PeerHostLocalSpeechSessionStage {
  return {
    enabled: snapshot.enabled,
    modelId: snapshot.modelId,
    language: snapshot.language,
    capabilityRevision,
    supportedFormats: [snapshot.format],
    sampleRates: [snapshot.sampleRateHz],
    channels: [snapshot.channels],
    maxInputBytes: snapshot.maxInputBytes,
    maxChunkBytes: snapshot.maxChunkBytes,
    maxConcurrent: snapshot.maxConcurrentSessions,
    maxQueue: snapshot.maxQueue,
    idleLeaseMs: snapshot.idleLeaseMs,
  };
}

function nativeSpeechSessionKey(stage: "kws" | "vad", sessionId: string): string {
  return `${stage}:${sessionId}`;
}

function isNativeSpeechAdmission(value: unknown): value is { readonly status: "admitted" | "rejected"; readonly session_id: string | null } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const admission = value as { status?: unknown; session_id?: unknown };
  return (admission.status === "admitted" || admission.status === "rejected")
    && (typeof admission.session_id === "string" || admission.session_id === null);
}

function isNativeSpeechTerminalResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("state" in value)) return false;
  return ["canceled", "completed", "failed", "interrupted", "revoked", "timed_out"]
    .includes(String((value as { state?: unknown }).state));
}

function isNativeSpeechStage(
  value: unknown,
  kind: "stt" | "tts",
): value is PeerHostLocalSpeechStage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PeerHostLocalSpeechStage>;
  const commonValid = typeof candidate.enabled === "boolean"
    && (typeof candidate.modelId === "string" || candidate.modelId === null)
    && (typeof candidate.language === "string" || candidate.language === null)
    && (candidate.voiceId === undefined || typeof candidate.voiceId === "string" || candidate.voiceId === null)
    && (candidate.modelId === null || (candidate.modelId.length > 0 && candidate.modelId.length <= 128))
    && (candidate.language === null || (candidate.language.length > 0 && candidate.language.length <= 64))
    && (candidate.voiceId == null || (candidate.voiceId.length > 0 && candidate.voiceId.length <= 128));
  if (!commonValid || !candidate.enabled) return false;
  return kind === "stt"
    ? typeof candidate.modelId === "string" && candidate.modelId.length > 0
    : typeof candidate.voiceId === "string" && candidate.voiceId.length > 0;
}

function isTextResult(value: unknown): value is { readonly text: string } {
  return typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string";
}

function isNativeSpeechAudioResult(
  value: unknown,
): value is { readonly audioBase64: string; readonly durationMs: number; readonly sampleRateHz: number } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { audioBase64?: unknown; durationMs?: unknown; sampleRateHz?: unknown };
  return typeof result.audioBase64 === "string"
    && result.audioBase64.length > 0
    && result.audioBase64.length <= 7_680_000
    && typeof result.durationMs === "number"
    && Number.isSafeInteger(result.durationMs)
    && result.durationMs >= 0
    && result.durationMs <= 60_000
    && typeof result.sampleRateHz === "number"
    && Number.isSafeInteger(result.sampleRateHz)
    && result.sampleRateHz > 0
    && result.sampleRateHz <= 48_000;
}

function encodePcmBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  pcm.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function decodePcmBase64(encoded: string): Int16Array {
  if (encoded.length === 0 || encoded.length > 7_680_000) {
    throw new Error("Invalid local synthesis audio");
  }
  const binary = atob(encoded);
  if (binary.length % 2 !== 0) throw new Error("Invalid local synthesis audio");
  const pcm = new Int16Array(binary.length / 2);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = view.getInt16(index * 2, true);
  }
  return pcm;
}

function reportTauriAuthorityAuditFailure(
  failure: Parameters<RustAuthorityAuditFailureReporter>[0],
): void {
  console.warn("Aurora authority audit records could not be saved", failure);
}

function disabled(
  reason: TauriMeshNodeServicesDisabledReason,
  details: {
    readonly registry?: LocalToolRegistry | undefined;
    readonly registeredToolIds?: readonly string[] | undefined;
  } = {},
): DisabledTauriMeshNodeServices {
  return {
    enabled: false,
    reason,
    registeredToolIds: details.registeredToolIds ?? [],
    ...(details.registry ? { localToolRegistry: details.registry } : {}),
    close: async () => undefined,
  };
}

async function nativeEvidenceAvailable(
  transport: TauriNativeCapabilityTransport,
): Promise<boolean> {
  try {
    const manifest = await transport.getNativeCapabilityManifest();
    return manifestEvidenceAvailable(manifest);
  } catch {
    return false;
  }
}

function manifestEvidenceAvailable(manifest: NativeCapabilityManifest): boolean {
  return manifest !== null
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && typeof manifest.permissions === "object"
    && manifest.permissions !== null
    && typeof manifest.capabilities === "object"
    && manifest.capabilities !== null;
}

function allRequiredRolloutsEnabled(
  flags: Partial<AuroraWebRtcRolloutFlags> | null | undefined,
): boolean {
  const normalized = normalizeAuroraWebRtcRolloutFlags(flags);
  return REQUIRED_ROLLOUT_FLAGS.every((flag) => normalized[flag] === true);
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

class LocalToolAuditUnavailableError extends Error {
  constructor() {
    super("local tool audit repository unavailable");
    this.name = "LocalToolAuditUnavailableError";
  }
}

function createDurableLocalToolAudit(options: {
  readonly auditRepository: LocalAuditRepository | null | undefined;
  readonly profileId: string;
  readonly localNodeId: string;
  readonly randomId?: () => string;
  readonly now?: () => number;
}): LocalToolAuditPort {
  if (!options.auditRepository || typeof options.auditRepository.appendAudit !== "function") {
    throw new LocalToolAuditUnavailableError();
  }
  const randomId = options.randomId ?? defaultLocalToolAuditId;
  const now = options.now ?? Date.now;
  return async (record: LocalToolAuditRecord) => {
    await options.auditRepository!.appendAudit(localAuditRecordFromLocalToolAudit({
      record,
      profileId: options.profileId,
      localNodeId: options.localNodeId,
      id: randomId(),
      createdAtMs: now(),
    }));
  };
}

function localAuditRecordFromLocalToolAudit(options: {
  readonly record: LocalToolAuditRecord;
  readonly profileId: string;
  readonly localNodeId: string;
  readonly id: string;
  readonly createdAtMs: number;
}): LocalAuditRecord {
  const record = options.record;
  return {
    id: options.id,
    profileId: options.profileId,
    localNodeId: options.localNodeId,
    peerId: boundedNullable(record.caller_peer_id),
    action: record.action === "prepare" ? "local_tool.prepare" : "local_tool.execute",
    decision: record.result,
    resultStatus: resultStatus(record.result),
    connectionEpoch: boundedNullable(record.connection_epoch),
    methodId: boundedNullable(record.method_id),
    toolContractId: boundedNullable(record.global_tool_id ?? record.local_tool_name ?? null),
    correlationId: boundedNullable(record.correlation_id),
    redactedDetailJson: redactedLocalToolAuditDetails(record),
    createdAtMs: options.createdAtMs,
  };
}

function redactedLocalToolAuditDetails(record: LocalToolAuditRecord): Record<string, LocalDataJsonValue> {
  return {
    providerPeerId: record.provider_peer_id,
    providerServiceInstanceId: record.provider_service_instance_id,
    callerPrincipalId: record.caller_principal_id ?? null,
    localToolName: record.local_tool_name ?? null,
    policyDecisionId: record.policy_decision_id ?? null,
    reasonCode: record.reason_code ?? null,
    argsHash: record.args_hash ?? null,
    redacted: true,
    secretsRedacted: true,
  };
}

function resultStatus(result: LocalToolAuditResult): string {
  if (result === "allowed" || result === "dry_run" || result === "success") return "complete";
  if (result === "cancelled") return "cancelled";
  return "failed";
}

function boundedNullable(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 256);
}

function defaultLocalToolAuditId(): string {
  const bytes = secureRandomBytes(16);
  return `audit-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createDisabledTauriNativeCapabilityTransport(): TauriNativeCapabilityTransport {
  const unavailable = async (): Promise<never> => {
    throw new Error("native capability evidence unavailable");
  };
  return {
    getNativeCapabilityManifest: unavailable,
    getSidecarStatus: unavailable as () => Promise<TauriSidecarStatus>,
    getAndroidVoiceForegroundServiceStatus: unavailable as () => Promise<AndroidVoiceForegroundServiceStatus>,
    startAndroidVoiceForegroundService: unavailable as () => Promise<AndroidVoiceForegroundServiceRequestResult>,
    shareNativeText: unavailable,
    openNativeDeepLink: unavailable,
    showNativeNotification: unavailable,
  };
}
