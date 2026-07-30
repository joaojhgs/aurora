import type {
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
  MemoryPeerRevocationBroadcaster,
  MemoryPeerRevocationController,
  MemoryReconnectChallengeStore,
  PeerAuthorityResolver,
  PeerGrantManager,
  PeerPairingIssuer,
  SecureInboundCredentialVerifierStore,
  type InboundVerifierSecretStoragePort,
  type PeerGrantRepository,
} from "@aurora/client/webrtc";
import {
  LocalToolRegistry,
  createMeshNodeLocalToolProvider,
  type LocalToolAuditPort,
  type LocalToolAuditRecord,
  type LocalToolAuditResult,
  type LocalToolExportDecisionPort,
  type MeshNodeLocalToolProviderComposition,
} from "@aurora/client/local-tools";
import {
  normalizeAuroraWebRtcRolloutFlags,
  registerTauriNativeCapabilityPack,
  type AuroraRuntimeProfileV2,
  type AuroraWebRtcRolloutFlags,
  type TauriNativeCapabilityTransport,
} from "@aurora/ui";
import { invoke } from "@tauri-apps/api/core";

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
  readonly invokeCommand?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export type TauriMeshNodeServicesDisabledReason =
  | "profile_missing"
  | "profile_not_mesh_node"
  | "runtime_tier_not_lightweight_ts"
  | "rollout_disabled"
  | "capability_packs_disabled"
  | "native_evidence_missing"
  | "native_tools_unavailable"
  | "local_tool_audit_unavailable"
  | "durable_store_unavailable";

export interface DisabledTauriMeshNodeServices {
  readonly enabled: false;
  readonly reason: TauriMeshNodeServicesDisabledReason;
  readonly registeredToolIds: readonly string[];
  readonly localToolRegistry?: LocalToolRegistry | undefined;
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
  readonly verifierStore: SecureInboundCredentialVerifierStore;
  readonly grantRepository: PeerGrantRepository;
  readonly auditSink: LocalDataPeerAuditSink;
  readonly challengeStore: MemoryReconnectChallengeStore;
  readonly authorityResolver: PeerAuthorityResolver;
  readonly pairingIssuer: PeerPairingIssuer;
  readonly revocationBroadcaster: MemoryPeerRevocationBroadcaster;
  readonly revocationController: MemoryPeerRevocationController;
  readonly grantManager: PeerGrantManager;
  readonly localToolRegistry: LocalToolRegistry;
  readonly localToolProvider: MeshNodeLocalToolProviderComposition;
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

  const invokeCommand = options.invokeCommand ?? invoke;
  const backend = options.backend ?? new TauriSqliteLocalDataBackend({ invokeCommand });
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
    const crypto = options.crypto ?? new TauriEnvelopeCryptoPort({
      profileId: profile.id,
      localNodeId: localPeerId,
      invokeCommand,
    });
    const verifierStore = new SecureInboundCredentialVerifierStore({
      storage: options.verifierSecretStorage ?? createTauriInboundVerifierSecretStorage({ invoke: invokeCommand }),
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
    const challengeStore = new MemoryReconnectChallengeStore({ randomBytes });
    const authorityResolver = new PeerAuthorityResolver({
      verifierStore,
      grantRepository,
      challengeStore,
      auditSink,
    });
    const pairingIssuer = new PeerPairingIssuer({
      verifierStore,
      auditSink,
      randomBytes,
      ...(options.now ? { now: options.now } : {}),
    });
    const revocationBroadcaster = new MemoryPeerRevocationBroadcaster();
    const revocationController = new MemoryPeerRevocationController({
      verifierStore,
      grantRepository,
      challengeStore,
      auditSink,
      broadcaster: revocationBroadcaster,
      ...(options.now ? { now: options.now } : {}),
    });
    const grantManager = new PeerGrantManager({
      repository: grantRepository,
      ...(options.now ? { now: options.now } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    const localToolProvider = createMeshNodeLocalToolProvider({
      nodeMode: "mesh-node",
      localPeerId,
      nodeName,
      registry,
      authorityResolver,
      exportDecision: options.exportDecision ?? DENY_ALL_LOCAL_TOOLS,
      audit: localToolAudit,
      cursorSecret: randomBytes(32),
      providerEnabled: true,
      ...(options.now ? { clock: options.now } : {}),
      ...(options.randomId ? { randomId: options.randomId } : {}),
    });
    if (!localToolProvider.enabled) {
      await backend.close().catch(() => undefined);
      return disabled("native_tools_unavailable", {
        registry,
        registeredToolIds: registered.registered,
      });
    }

    return {
      enabled: true,
      profileId: profile.id,
      localNodeId: localPeerId,
      localPeerId,
      nodeName,
      localDataSession: session,
      verifierStore,
      grantRepository,
      auditSink,
      challengeStore,
      authorityResolver,
      pairingIssuer,
      revocationBroadcaster,
      revocationController,
      grantManager,
      localToolRegistry: registry,
      localToolProvider,
      peerHost: localToolProvider.peerHost,
      registeredToolIds: localToolProvider.registeredToolIds,
      close: async () => {
        localToolProvider.peerHost.suspend("provider_closed");
        await backend.close();
      },
    };
  } catch (error) {
    await backend.close().catch(() => undefined);
    return disabled(error instanceof LocalToolAuditUnavailableError
      ? "local_tool_audit_unavailable"
      : "durable_store_unavailable", {
      registry,
      registeredToolIds: registered.registered,
    });
  }
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

const DENY_ALL_LOCAL_TOOLS: LocalToolExportDecisionPort = Object.freeze({
  isShared: () => false,
});

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
