import { describe, expect, it, vi } from "vitest";
import {
  TOOLING_METHODS,
  nativeCapabilityManifestFixture,
  type AndroidVoiceForegroundServiceRequestResult,
  type AndroidVoiceForegroundServiceStatus,
  type NativeCapabilityManifest,
  type TauriSidecarStatus,
} from "@aurora/client";
import type {
  DeleteConversationResult,
  DeleteExpiredMemoryItemsResult,
  DeleteRecordResult,
  EncryptedDataEnvelopeV1,
  EnvelopeCryptoPort,
  LocalAuditRecord,
  LocalDataBackend,
  LocalDataBackendStatus,
  LocalDataExportV1,
  LocalDataImportResult,
  LocalDataRepositories,
  LocalDataSession,
  PeerGrantMetadataRecord,
} from "@aurora/client/local-data";
import {
  SecureInboundCredentialVerifierStore,
  type PeerHostCallContext,
  type InboundVerifierSecretStoragePort,
  type PeerRelationshipSelector,
} from "@aurora/client/webrtc";
import { AURORA_NATIVE_TOOL_IDS, type LocalToolExportDecisionPort } from "@aurora/client/local-tools";
import type {
  AuroraCapabilityPack,
  AuroraRuntimeProfileV2,
  AuroraWebRtcRolloutFlags,
  TauriNativeCapabilityTransport,
} from "@aurora/ui";

import { createTauriMeshNodeServices } from "./tauri-mesh-node-services";

const rolloutFlags: AuroraWebRtcRolloutFlags = {
  webrtc_thin_client: true,
  webrtc_scoped_subscriptions: true,
  webrtc_fragmentation: true,
  webrtc_app_layer_e2ee: true,
  mesh_node_runtime_v1: true,
  local_tool_provider_v1: true,
  lightweight_orchestrator_v1: true,
  native_webrtc_transport_v1: true,
};

const selector: PeerRelationshipSelector = {
  tokenId: "token-1",
  claimantPeerId: "peer-recipient",
  verifierPeerId: "node-1",
  roomName: "room-1",
};

describe("Tauri mesh node services", () => {
  it("returns disabled composition with no host or authority for disabled gates", async () => {
    const missingProfileTransport = nativeTransport({ manifest: readyDesktopShareManifest() });

    await expect(disabledReason(null, { nativeTransport: missingProfileTransport })).resolves.toBe("profile_missing");
    expect(missingProfileTransport.getNativeCapabilityManifest).not.toHaveBeenCalled();
    await expect(disabledReason(profile({ nodeMode: "remote-console", runtimeTier: "none" }))).resolves.toBe("profile_not_mesh_node");
    await expect(disabledReason(profile({ runtimeTier: "python-full" }))).resolves.toBe("runtime_tier_not_lightweight_ts");
    await expect(disabledReason(profile(), { rolloutFlags: { ...rolloutFlags, local_tool_provider_v1: false } })).resolves.toBe("rollout_disabled");
    await expect(disabledReason(profile({ enabledCapabilityPacks: [] }))).resolves.toBe("capability_packs_disabled");
    await expect(disabledReason(profile({ meshMembership: false }))).resolves.toBe("mesh_membership_missing");
    await expect(disabledReason(profile(), { nativeTransport: nativeTransport({ manifestError: true }) })).resolves.toBe("native_evidence_missing");
  });

  it("opens durable stores and registers a native tool on the enabled path", async () => {
    const backend = new FakeLocalDataBackend();
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
      backend,
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      invokeCommand: fakeAuthorityInvoke(sequentialIds("id")),
      randomBytes: randomBytes(7),
      randomId: sequentialIds("id"),
      now: () => 1_000,
    });

    expect(services.enabled).toBe(true);
    if (!services.enabled) throw new Error("expected enabled services");
    expect(backend.opened).toEqual([{ profileId: "profile-1", localNodeId: "node-1" }]);
    expect(services.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.getDeviceStatus);
    expect(services.localToolRegistry.publicTools().map((tool) => tool.tool_contract_id).sort()).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
    ]);
    expect(services.peerHost).toBe(services.localToolProvider.peerHost);
    expect(services.localToolApprovals).toBe(
      services.localToolProvider.approvalController,
    );
    expect(services.authorityResolver).toBeDefined();
    expect(services.pairingIssuer).toBeDefined();
    expect(services.grantManager).toBeDefined();
    await expect(services.localFeatureSharing.load()).resolves.toMatchObject({
      features: [
        expect.objectContaining({
          id: AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
          enabled: false,
        }),
      ],
      approvedDevices: [],
    });

    await services.close();
    expect(backend.closed).toBe(true);
  });

  it("fails closed when durable Tauri adapters are not injected", async () => {
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
    });

    expect(services).toMatchObject({
      enabled: false,
      reason: "durable_store_unavailable",
    });
  });

  it("keeps native tools hidden by default until an explicit export policy shares them", async () => {
    const defaultServices = await createEnabledServices();
    const defaultVisibility = await toolingVisibility(defaultServices);

    expect(defaultVisibility.tools).toMatchObject({ count: 0, tools: [] });
    expect(defaultVisibility.catalog).toMatchObject({
      ok: true,
      tools: [],
      blocked_tools: [],
      total_count: 0,
    });
    await defaultServices.close();

    const explicitServices = await createEnabledServices(() => 1_000, {
      exportDecision: shareOnlyDeviceStatus(),
    });
    const explicitVisibility = await toolingVisibility(explicitServices);

    expect(explicitVisibility.tools).toMatchObject({
      count: 1,
      tools: [expect.objectContaining({ local_name: "native.get_device_status" })],
    });
    expect(explicitVisibility.catalog).toMatchObject({
      ok: true,
      tools: [expect.objectContaining({ local_name: "native.get_device_status" })],
      blocked_tools: [],
      total_count: 1,
    });
    await explicitServices.close();
  });

  it("enables the local tool provider when the lightweight orchestrator rollout is disabled", async () => {
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags: { ...rolloutFlags, lightweight_orchestrator_v1: false },
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
      backend: new FakeLocalDataBackend(),
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      invokeCommand: fakeAuthorityInvoke(sequentialIds("id")),
      randomBytes: randomBytes(11),
      randomId: sequentialIds("id"),
      now: () => 1_000,
    });

    expect(services.enabled).toBe(true);
    if (!services.enabled) throw new Error("expected enabled services");
    expect(services.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.getDeviceStatus);
    await services.close();
  });

  it("does not claim enabled when native evidence yields no tools", async () => {
    const backend = new FakeLocalDataBackend();
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopManifestNoTools() }),
      backend,
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      randomBytes: randomBytes(8),
      randomId: sequentialIds("id"),
    });

    expect(services).toMatchObject({
      enabled: false,
      reason: "native_tools_unavailable",
      registeredToolIds: [],
    });
    expect(services.peerHost).toBeUndefined();
    expect(services.authorityResolver).toBeUndefined();
    expect(services.grantManager).toBeUndefined();
    expect(backend.opened).toEqual([]);
  });

  it("roundtrips and revokes grants through the durable manager and controller", async () => {
    let nowMs = 1_000;
    const services = await createEnabledServices(() => nowMs);
    const grant = await services.grantManager.replaceGrant(selector, {
      allowedMethodIds: ["Tooling.GetTools"],
      allowedToolContractIds: [AURORA_NATIVE_TOOL_IDS.getDeviceStatus],
    });

    expect(grant).toMatchObject({
      claimantPeerId: "peer-recipient",
      verifierPeerId: "node-1",
      sharingState: "active",
    });
    expect(grant.grantId).toMatch(/^id-/u);
    await expect(services.grantManager.listActiveGrants(selector)).resolves.toHaveLength(1);

    const event = await services.revocationController.revoke(selector, "user_revoked", 2_000);

    expect(event).toMatchObject({
      reasonCode: "user_revoked",
      revokedGrantIds: [grant.grantId],
      redacted: true,
    });
    await expect(services.grantManager.listActiveGrants(selector)).resolves.toEqual([
      expect.objectContaining({ grantId: grant.grantId, revokedAtMs: 2_000 }),
    ]);
    nowMs = 2_001;
    await expect(services.grantManager.listActiveGrants(selector)).resolves.toEqual([]);
    await services.close();
  });

  it("projects native tooling methods through the composed Rust authority", async () => {
    const services = await createEnabledServices();
    await services.grantManager.replaceGrant(selector, {
      allowedMethodIds: ["Tooling.GetTools"],
      allowedToolContractIds: [AURORA_NATIVE_TOOL_IDS.getDeviceStatus],
    });
    const authenticatedPeerContext = peerHostCallContext(
      "Tooling.GetTools",
      1_000,
    ).authenticatedPeerContext;
    if (!authenticatedPeerContext) throw new Error("expected authenticated peer context");

    await expect(
      services.peerHost.startEpoch(selector.claimantPeerId, authenticatedPeerContext),
    ).resolves.toMatchObject({
      projection_active: true,
      shared_services: [
        expect.objectContaining({
          module: "Tooling",
          methods: [expect.objectContaining({ name: "GetTools" })],
        }),
      ],
    });
    await services.close();
  });

  it("persists issued verifiers and their revocation through the native composition", async () => {
    const verifierSecretStorage = new MemorySecretStorage();
    const services = await createEnabledServices(() => 1_000, {
      verifierSecretStorage,
    });
    const issued = await services.pairingIssuer.issue(selector);
    const durableVerifiers = new SecureInboundCredentialVerifierStore({
      storage: verifierSecretStorage,
    });

    await expect(durableVerifiers.getVerifier(selector, 1_000)).resolves.toEqual(
      issued.verifier,
    );
    await services.revocationController.revoke(selector, "user_revoked", 2_000);
    await expect(durableVerifiers.getVerifier(selector, 2_001)).resolves.toBeUndefined();
    await services.close();
  });

  it("refreshes the provider projection after local feature sharing changes", async () => {
    const services = await createEnabledServices();
    const refresh = vi
      .spyOn(services.peerHost, "resumeLocalProvider")
      .mockResolvedValue(undefined);

    await services.localFeatureSharing.setFeatureEnabled(
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      true,
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await services.pairingIssuer.issue(selector, {
      featureIds: [AURORA_NATIVE_TOOL_IDS.getDeviceStatus],
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    await services.localFeatureSharing.revokePeerSharing(selector.claimantPeerId);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));

    await services.close();
  });

  it("persists redacted native prepare and execute audit metadata on the enabled path", async () => {
    let nowMs = 1_000;
    const backend = new FakeLocalDataBackend();
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
      backend,
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      invokeCommand: fakeAuthorityInvoke(sequentialIds("id")),
      randomBytes: randomBytes(9),
      randomId: sequentialIds("id"),
      now: () => nowMs,
    });

    expect(services.enabled).toBe(true);
    if (!services.enabled) throw new Error("expected enabled services");
    await services.grantManager.replaceGrant(selector, {
      allowedMethodIds: [TOOLING_METHODS.executeTool],
      allowedToolContractIds: [AURORA_NATIVE_TOOL_IDS.getDeviceStatus],
      capabilityPackIds: ["native.deviceStatus"],
    });

    const prepare = services.localToolProvider.peerHostRegistry.get(TOOLING_METHODS.prepareExecution);
    const execute = services.localToolProvider.peerHostRegistry.get(TOOLING_METHODS.executeTool);
    if (!prepare || !execute) throw new Error("expected native tooling handlers");

    const prepareOutput = await services.localToolProvider.peerHostRegistry.dispatch(prepare, {
      tool_name: AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      arguments: {},
      correlation_id: "corr-native-1",
    }, peerHostCallContext(TOOLING_METHODS.prepareExecution, nowMs));
    expect(prepareOutput).toMatchObject({ ok: true, correlation_id: "corr-native-1" });

    nowMs = 1_001;
    const executeOutput = await services.localToolProvider.peerHostRegistry.dispatch(execute, {
      tool_name: AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
      arguments: {},
      correlation_id: "corr-native-1",
    }, peerHostCallContext(TOOLING_METHODS.executeTool, nowMs));
    expect(executeOutput).toMatchObject({ ok: true, status: "success", correlation_id: "corr-native-1" });

    const audits = await services.localDataSession.localAudit.listAudit();
    const localToolAudits = audits.filter((record) => record.action.startsWith("local_tool."));
    expect(localToolAudits).toEqual([
      expect.objectContaining({
        profileId: "profile-1",
        localNodeId: "node-1",
        peerId: "peer-recipient",
        action: "local_tool.prepare",
        decision: "allowed",
        resultStatus: "complete",
        connectionEpoch: null,
        methodId: TOOLING_METHODS.prepareExecution,
        toolContractId: expect.stringContaining(AURORA_NATIVE_TOOL_IDS.getDeviceStatus),
        correlationId: "corr-native-1",
        createdAtMs: 1_000,
      }),
      expect.objectContaining({
        profileId: "profile-1",
        localNodeId: "node-1",
        peerId: "peer-recipient",
        action: "local_tool.execute",
        decision: "success",
        resultStatus: "complete",
        connectionEpoch: null,
        methodId: TOOLING_METHODS.executeTool,
        toolContractId: expect.stringContaining(AURORA_NATIVE_TOOL_IDS.getDeviceStatus),
        correlationId: "corr-native-1",
        createdAtMs: 1_001,
      }),
    ]);
    for (const audit of localToolAudits) {
      expect(audit.redactedDetailJson).toMatchObject({
        providerPeerId: "node-1",
        callerPrincipalId: "principal-1",
        redacted: true,
        secretsRedacted: true,
      });
      expect([AURORA_NATIVE_TOOL_IDS.getDeviceStatus, "native.get_device_status"]).toContain(
        audit.redactedDetailJson.localToolName,
      );
      expect(audit.redactedDetailJson).not.toHaveProperty("display_args_preview");
      expect(audit.redactedDetailJson).not.toHaveProperty("displayArgsPreview");
      expect(audit.redactedDetailJson).not.toHaveProperty("detail");
    }
    await services.close();
  });

  it("does not claim enabled when durable local tool audit storage is unavailable", async () => {
    const backend = new FakeLocalDataBackend(new FakeLocalDataSession({} as MemoryLocalAuditRepository));
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
      backend,
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      randomBytes: randomBytes(10),
      randomId: sequentialIds("id"),
    });

    expect(services).toMatchObject({
      enabled: false,
      reason: "local_tool_audit_unavailable",
    });
    expect(services.peerHost).toBeUndefined();
    expect(services.authorityResolver).toBeUndefined();
    expect(services.grantManager).toBeUndefined();
    expect(backend.opened).toHaveLength(1);
    expect(backend.closed).toBe(true);
  });

  it("closes durable storage when composition setup fails after open", async () => {
    const backend = new FakeLocalDataBackend();
    const services = await createTauriMeshNodeServices({
      profile: profile(),
      rolloutFlags,
      nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
      backend,
      crypto: new FakeEnvelopeCrypto(),
      verifierSecretStorage: new MemorySecretStorage(),
      randomBytes: () => {
        throw new Error("random unavailable");
      },
      randomId: sequentialIds("id"),
    });

    expect(services).toMatchObject({
      enabled: false,
      reason: "durable_store_unavailable",
    });
    expect(services.peerHost).toBeUndefined();
    expect(services.authorityResolver).toBeUndefined();
    expect(backend.opened).toHaveLength(1);
    expect(backend.closed).toBe(true);
  });
});

async function disabledReason(
  runtimeProfile: AuroraRuntimeProfileV2 | null,
  patch: Partial<Parameters<typeof createTauriMeshNodeServices>[0]> = {},
) {
  const services = await createTauriMeshNodeServices({
    profile: runtimeProfile,
    rolloutFlags,
    nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
    backend: new FakeLocalDataBackend(),
    crypto: new FakeEnvelopeCrypto(),
    verifierSecretStorage: new MemorySecretStorage(),
    randomBytes: randomBytes(1),
    randomId: sequentialIds("id"),
    ...patch,
  });
  expect(services.peerHost).toBeUndefined();
  expect(services.authorityResolver).toBeUndefined();
  expect(services.pairingIssuer).toBeUndefined();
  expect(services.grantManager).toBeUndefined();
  if (services.enabled) throw new Error("expected disabled services");
  return services.reason;
}

async function createEnabledServices(
  now: () => number = () => 1_000,
  patch: Partial<Parameters<typeof createTauriMeshNodeServices>[0]> = {},
) {
  const services = await createTauriMeshNodeServices({
    profile: profile(),
    rolloutFlags,
    nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
    backend: new FakeLocalDataBackend(),
    crypto: new FakeEnvelopeCrypto(),
    verifierSecretStorage: new MemorySecretStorage(),
    invokeCommand: fakeAuthorityInvoke(sequentialIds("id")),
    randomBytes: randomBytes(3),
    randomId: sequentialIds("id"),
    now,
    ...patch,
  });
  if (!services.enabled) {
    throw new Error(`expected enabled services, got ${"reason" in services ? services.reason : "unknown"}`);
  }
  return services;
}

async function toolingVisibility(services: Awaited<ReturnType<typeof createEnabledServices>>) {
  const getTools = services.localToolProvider.peerHostRegistry.get("Tooling.GetTools");
  const getExportCatalog = services.localToolProvider.peerHostRegistry.get(TOOLING_METHODS.getExportCatalog);
  if (!getTools || !getExportCatalog) throw new Error("expected tooling visibility handlers");
  return {
    tools: await services.localToolProvider.peerHostRegistry.dispatch(
      getTools,
      {},
      peerHostCallContext("Tooling.GetTools", 1_000),
    ),
    catalog: await services.localToolProvider.peerHostRegistry.dispatch(
      getExportCatalog,
      { protocol_tier: "projection_v1", page_size: 100 },
      peerHostCallContext(TOOLING_METHODS.getExportCatalog, 1_000),
    ),
  };
}

function shareOnlyDeviceStatus(): LocalToolExportDecisionPort {
  return {
    isShared: (tool) => tool.global_tool_id.includes(AURORA_NATIVE_TOOL_IDS.getDeviceStatus),
  };
}

function profile(patch: {
  nodeMode?: AuroraRuntimeProfileV2["nodeMode"];
  runtimeTier?: AuroraRuntimeProfileV2["runtimeTier"];
  enabledCapabilityPacks?: AuroraCapabilityPack[];
  meshMembership?: boolean;
} = {}): AuroraRuntimeProfileV2 {
  const nodeMode = patch.nodeMode ?? "mesh-node";
  return {
    version: 2,
    id: "profile-1",
    label: "Local mesh node",
    nodeMode,
    runtimeTier: patch.runtimeTier ?? "lightweight-ts",
    ...(nodeMode === "remote-console"
      ? {
          homeConnection: {
            mode: "http-only",
            gatewayUrl: "https://aurora.example.test",
          },
        }
      : {}),
    localNode: {
      nodeName: "Local Node",
      stablePeerId: "node-1",
      enabledCapabilityPacks: patch.enabledCapabilityPacks ?? ["native-actions"],
      ...(nodeMode === "mesh-node" && patch.meshMembership !== false
        ? {
            meshMembership: {
              signalingUrl: "wss://mesh.example.test",
              webrtcProfile: {
                mode: "webrtc-only",
                signalingBrokers: ["wss://mesh.example.test"],
                room: "room-1",
                roomSecretRef: "room-ref",
                appId: "aurora-test",
              },
            },
          }
        : {}),
    },
  };
}

function readyDesktopShareManifest(): NativeCapabilityManifest {
  return {
    ...nativeCapabilityManifestFixture,
    permissions: {
      ...nativeCapabilityManifestFixture.permissions,
      "aurora.nativeCapabilityManifest": true,
      "aurora.notificationsSend": false,
    },
    capabilities: {
      ...nativeCapabilityManifestFixture.capabilities,
      "native.permissionsManifest": true,
      "native.notifications": false,
    },
    permissionStates: {
      ...nativeCapabilityManifestFixture.permissionStates,
      "aurora.nativeCapabilityManifest": "available",
    },
    capabilityStates: {
      ...nativeCapabilityManifestFixture.capabilityStates,
      "native.permissionsManifest": "available",
    },
  };
}

function readyDesktopManifestNoTools(): NativeCapabilityManifest {
  return {
    ...nativeCapabilityManifestFixture,
    permissions: {
      ...nativeCapabilityManifestFixture.permissions,
      "aurora.nativeCapabilityManifest": false,
    },
    capabilities: {
      ...nativeCapabilityManifestFixture.capabilities,
      "native.permissionsManifest": false,
    },
    permissionStates: {
      ...nativeCapabilityManifestFixture.permissionStates,
      "aurora.nativeCapabilityManifest": "needs_native_permission",
    },
    capabilityStates: {
      ...nativeCapabilityManifestFixture.capabilityStates,
      "native.permissionsManifest": "needs_native_permission",
    },
  };
}

function nativeTransport(options: {
  manifest?: NativeCapabilityManifest;
  manifestError?: boolean;
}): TauriNativeCapabilityTransport {
  return {
    getNativeCapabilityManifest: vi.fn(async () => {
      if (options.manifestError) throw new Error("unavailable");
      return options.manifest ?? readyDesktopShareManifest();
    }),
    getSidecarStatus: vi.fn(async (): Promise<TauriSidecarStatus> => ({ running: true })),
    getAndroidVoiceForegroundServiceStatus: vi.fn(async (): Promise<AndroidVoiceForegroundServiceStatus> => {
      throw new Error("unsupported");
    }),
    startAndroidVoiceForegroundService: vi.fn(async (): Promise<AndroidVoiceForegroundServiceRequestResult> => {
      throw new Error("unsupported");
    }),
    shareNativeText: vi.fn(async () => ({ shared: true })),
    openNativeDeepLink: vi.fn(async () => ({ opened: true })),
    showNativeNotification: vi.fn(async () => ({ shown: true })),
  };
}

class FakeLocalDataBackend implements LocalDataBackend {
  readonly kind = "sqlite-tauri" as const;
  readonly persistent = true;
  readonly sqlite = true;
  readonly opened: Array<{ profileId: string; localNodeId: string }> = [];
  readonly session: FakeLocalDataSession;
  closed = false;

  constructor(session = new FakeLocalDataSession()) {
    this.session = session;
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    this.opened.push({ profileId, localNodeId });
    this.closed = false;
    this.session.profileId = profileId;
    this.session.localNodeId = localNodeId;
    return this.session;
  }

  async status(): Promise<LocalDataBackendStatus> {
    return {
      kind: "sqlite-tauri",
      persistent: true,
      sqlite: true,
      profileId: this.session.profileId,
      schemaVersion: 1,
      migrationState: "idle",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.session.close();
  }
}

class FakeLocalDataSession implements LocalDataSession {
  profileId = "profile-1";
  localNodeId = "node-1";
  readonly schemaVersion = 1;
  readonly conversations = emptyConversationRepository();
  readonly memory = emptyMemoryRepository();
  readonly localTools = emptyLocalToolRepository();
  readonly peerGrants = new MemoryPeerGrantMetadataRepository();
  readonly localAudit: MemoryLocalAuditRepository;
  closed = false;

  constructor(localAudit = new MemoryLocalAuditRepository()) {
    this.localAudit = localAudit;
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    return await work(this);
  }

  async exportV1(): Promise<LocalDataExportV1> {
    throw new Error("not used");
  }

  async importV1(_document: LocalDataExportV1): Promise<LocalDataImportResult> {
    throw new Error("not used");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MemoryPeerGrantMetadataRepository {
  readonly records = new Map<string, PeerGrantMetadataRecord>();

  async upsertPeerGrant(record: PeerGrantMetadataRecord): Promise<void> {
    this.records.set(record.grantId, structuredClone(record));
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

class MemoryLocalAuditRepository {
  readonly records: LocalAuditRecord[] = [];

  async appendAudit(record: LocalAuditRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return this.records.map((record) => structuredClone(record));
  }
}

class MemorySecretStorage implements InboundVerifierSecretStoragePort {
  readonly values = new Map<string, string>();

  async getOpaqueSecret(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async setOpaqueSecret(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteOpaqueSecret(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeEnvelopeCrypto implements EnvelopeCryptoPort {
  readonly values = new Map<string, Uint8Array>();

  async encrypt(_keyPurpose: "local-structured-data", plaintext: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    const keyId = `key-${this.values.size + 1}`;
    this.values.set(keyId, new Uint8Array(plaintext));
    return {
      version: 1,
      algorithm: "AES-GCM-256",
      keyId,
      nonceB64Url: "AAAAAAAAAAAAAAAA",
      ciphertextAndTagB64Url: "AAAAAAAAAAAAAAAAAAAAAA",
      createdAtMs: 1,
    };
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1): Promise<Uint8Array> {
    const value = this.values.get(envelope.keyId);
    if (!value) throw new Error("missing envelope");
    return new Uint8Array(value);
  }

  async rotateKey(_keyPurpose: "local-structured-data"): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: "old", newKeyId: "new" };
  }
}

function emptyConversationRepository() {
  return {
    upsertConversation: async () => undefined,
    appendMessage: async () => undefined,
    deleteConversation: async (): Promise<DeleteConversationResult> => ({ deleted: false, deletedMessages: 0 }),
    listConversations: async () => [],
    listMessages: async () => [],
  };
}

function emptyMemoryRepository() {
  return {
    upsertMemoryItem: async () => undefined,
    deleteMemoryItem: async (): Promise<DeleteRecordResult> => ({ deleted: false }),
    deleteExpiredMemoryItems: async (): Promise<DeleteExpiredMemoryItemsResult> => ({ deleted: 0 }),
    listMemoryItems: async () => [],
  };
}

function emptyLocalToolRepository() {
  return {
    upsertLocalToolState: async () => undefined,
    listLocalToolStates: async () => [],
  };
}

function peerHostCallContext(methodId: string, receivedAtMs: number): PeerHostCallContext {
  return {
    id: `call-${methodId}`,
    methodId,
    remotePeerId: "peer-recipient",
    identity: {
      callerPeerId: "peer-recipient",
      principalId: "principal-1",
      effectivePermissions: ["Tooling.GetTools", TOOLING_METHODS.executeTool, "Native.GetDeviceStatus"],
      authGrantRevision: 1,
      manifestRevision: 1,
    },
    authenticatedPeerContext: {
      selector,
      transport: {
        channelBinding: "binding-1",
        claimantSignalingPeerId: "peer-recipient",
        verifierSignalingPeerId: "node-1",
      },
      connectionEpoch: "epoch-1",
      credentialRevision: 1,
      authenticatedAtMs: receivedAtMs,
    },
    signal: new AbortController().signal,
    receivedAtMs,
    deadlineAtMs: receivedAtMs + 1_000,
  };
}

function fakeAuthorityInvoke(newId: () => string) {
  const grants = new Map<string, {
    grantId: string;
    tokenId: string;
    claimantPeerId: string;
    verifierPeerId: string;
    roomName: string;
    allowedMethodIds: string[];
    allowedToolContractIds: string[];
    capabilityPackIds: string[];
    resourceScopes: string[];
    createdAtMs: number;
    expiresAtMs?: number;
    revokedAtMs?: number;
    grantRevision: number;
  }>();
  const keyFor = (input: PeerRelationshipSelector) =>
    `${input.tokenId}:${input.claimantPeerId}:${input.verifierPeerId}:${input.roomName}`;
  const summarize = (
    grant: (typeof grants extends Map<string, infer T> ? T : never),
    nowMs: number,
  ) => ({
    ...grant,
    sharingState:
      grant.revokedAtMs !== undefined && nowMs > grant.revokedAtMs
        ? "revoked"
        : grant.expiresAtMs !== undefined && nowMs >= grant.expiresAtMs
          ? "expired"
          : "active",
    secretFieldsRedacted: true,
    redactedFields: ["secret"],
  });
  return async (command: string, args?: Record<string, unknown>) => {
    if (command === "aurora_mesh_authority_hydrate") return undefined;
    if (command === "aurora_mesh_authority_drain_audit") return [];
    if (command === "aurora_mesh_authority_snapshot_manifest") {
      const request = args?.request as {
        remotePeerId?: string;
        authenticatedPeerContext?: { selector: PeerRelationshipSelector };
        nowMs?: number;
      };
      const requestSelector = request.authenticatedPeerContext?.selector;
      const nowMs = Number(request.nowMs ?? 0);
      const active = requestSelector
        ? [...grants.values()]
            .filter((grant) => keyFor(grant) === keyFor(requestSelector))
            .filter((grant) => grant.revokedAtMs === undefined || grant.revokedAtMs > nowMs)
            .filter((grant) => grant.expiresAtMs === undefined || grant.expiresAtMs > nowMs)
        : [];
      return {
        recipientPeerId: request.remotePeerId ?? requestSelector?.claimantPeerId,
        grantedMethodIds: [...new Set(active.flatMap((grant) => grant.allowedMethodIds))].sort(),
        grantedToolContractIds: [
          ...new Set(active.flatMap((grant) => grant.allowedToolContractIds)),
        ].sort(),
        authGrantRevision: active.reduce(
          (revision, grant) => Math.max(revision, grant.grantRevision),
          0,
        ),
        authGrantState: active.length > 0 ? "active" : "unknown",
      };
    }
    if (command === "aurora_mesh_authority_authorize") {
      return {
        allowed: true,
        reasonCode: "allowed",
        grantedToolContractIds: [AURORA_NATIVE_TOOL_IDS.getDeviceStatus],
      };
    }
    if (command === "aurora_mesh_authority_list_active_grants") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      const nowMs = Number(args?.nowMs ?? 0);
      return [...grants.values()]
        .filter((grant) => keyFor(grant) === keyFor(selectorArg))
        .filter((grant) => grant.revokedAtMs === undefined || nowMs <= grant.revokedAtMs)
        .filter((grant) => grant.expiresAtMs === undefined || nowMs < grant.expiresAtMs)
        .map((grant) => summarize(grant, nowMs));
    }
    if (command === "aurora_mesh_authority_replace_grant") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      const selection = args?.selection as {
        allowedMethodIds?: string[];
        allowedToolContractIds?: string[];
        capabilityPackIds?: string[];
        resourceScopes?: string[];
        expiresAtMs?: number;
      };
      const nowMs = Number(args?.nowMs ?? 0);
      const grant = {
        version: 1,
        grantId: newId(),
        tokenId: selectorArg.tokenId,
        claimantPeerId: selectorArg.claimantPeerId,
        verifierPeerId: selectorArg.verifierPeerId,
        roomName: selectorArg.roomName,
        allowedMethodIds: [...(selection.allowedMethodIds ?? [])],
        allowedToolContractIds: [...(selection.allowedToolContractIds ?? [])],
        capabilityPackIds: [...(selection.capabilityPackIds ?? [])],
        resourceScopes: [...(selection.resourceScopes ?? [])],
        createdAtMs: nowMs,
        ...(selection.expiresAtMs !== undefined
          ? { expiresAtMs: selection.expiresAtMs }
          : {}),
        grantRevision: 1,
      };
      grants.set(keyFor(selectorArg), grant);
      return summarize(grant, nowMs);
    }
    if (command === "aurora_mesh_authority_export_grants") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      return [...grants.values()].filter(
        (grant) => keyFor(grant) === keyFor(selectorArg),
      );
    }
    if (command === "aurora_mesh_authority_revoke_peer_authority") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      const revokedAtMs = Number(args?.revokedAtMs ?? 0);
      const revokedGrantIds: string[] = [];
      for (const [key, grant] of grants.entries()) {
        if (key !== keyFor(selectorArg)) continue;
        grant.revokedAtMs = revokedAtMs;
        grant.grantRevision += 1;
        revokedGrantIds.push(grant.grantId);
      }
      return {
        selector: selectorArg,
        reasonCode: String(args?.reasonCode ?? "peer_authority_revoked"),
        revokedAtMs,
        revokedGrantIds,
        redacted: true,
      };
    }
    if (command === "aurora_mesh_authority_revoke_sharing") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      const nowMs = Number(args?.nowMs ?? 0);
      const summaries = [];
      for (const [key, grant] of grants.entries()) {
        if (key !== keyFor(selectorArg)) continue;
        grant.revokedAtMs = nowMs;
        grant.grantRevision += 1;
        summaries.push(summarize(grant, nowMs));
      }
      return summaries;
    }
    if (command === "aurora_mesh_authority_issue_pairing_credential") {
      const selectorArg = args?.selector as PeerRelationshipSelector;
      const createdAtMs = Number(args?.nowMs ?? 0);
      return {
        tokenId: selectorArg.tokenId,
        bearerToken: "a".repeat(64),
        verifier: {
          version: 1,
          ...selectorArg,
          tokenHashHex: "b".repeat(64),
          createdAtMs,
          ...(typeof args?.expiresAtMs === "number"
            ? { expiresAtMs: args.expiresAtMs }
            : {}),
          credentialRevision: 1,
        },
      };
    }
    if (command === "aurora_mesh_authority_rollback_pairing_credential") {
      return undefined;
    }
    if (command === "aurora_mesh_authority_resolve_grant") {
      return {
        allowed: true,
        reason: "allowed",
        grant: null,
        grantRevision: 1,
        matchedGrantIds: [],
      };
    }
    if (command === "aurora_mesh_authority_issue_reconnect_challenge") {
      return {
        challengeId: newId(),
        challengeNonce: "nonce",
        expiresAtMs: 2_000,
        issuedAtMs: 1_000,
      };
    }
    if (command === "aurora_mesh_authority_verify_reconnect_proof") {
      return { ok: true, credentialRevision: 1 };
    }
    throw new Error(`unexpected authority command ${command}`);
  };
}

function randomBytes(seed: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(seed);
}

function sequentialIds(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
