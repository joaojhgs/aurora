import { describe, expect, it, vi } from "vitest";
import {
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
import type {
  InboundVerifierSecretStoragePort,
  PeerRelationshipSelector,
} from "@aurora/client/webrtc";
import { AURORA_NATIVE_TOOL_IDS } from "@aurora/client/local-tools";
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
};

const selector: PeerRelationshipSelector = {
  tokenId: "token-1",
  claimantPeerId: "peer-recipient",
  verifierPeerId: "node-1",
  roomName: "room-1",
};

describe("Tauri mesh node services", () => {
  it("returns disabled composition with no host or authority for disabled gates", async () => {
    await expect(disabledReason(profile({ nodeMode: "remote-console", runtimeTier: "none" }))).resolves.toBe("profile_not_mesh_node");
    await expect(disabledReason(profile({ runtimeTier: "python-full" }))).resolves.toBe("runtime_tier_not_lightweight_ts");
    await expect(disabledReason(profile(), { rolloutFlags: { ...rolloutFlags, local_tool_provider_v1: false } })).resolves.toBe("rollout_disabled");
    await expect(disabledReason(profile({ enabledCapabilityPacks: [] }))).resolves.toBe("capability_packs_disabled");
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
    expect(services.authorityResolver).toBeDefined();
    expect(services.pairingIssuer).toBeDefined();
    expect(services.grantManager).toBeDefined();

    await services.close();
    expect(backend.closed).toBe(true);
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
    nowMs = 2_001;
    await expect(services.grantManager.listActiveGrants(selector)).resolves.toEqual([]);
    await services.close();
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

async function createEnabledServices(now: () => number = () => 1_000) {
  const services = await createTauriMeshNodeServices({
    profile: profile(),
    rolloutFlags,
    nativeTransport: nativeTransport({ manifest: readyDesktopShareManifest() }),
    backend: new FakeLocalDataBackend(),
    crypto: new FakeEnvelopeCrypto(),
    verifierSecretStorage: new MemorySecretStorage(),
    randomBytes: randomBytes(3),
    randomId: sequentialIds("id"),
    now,
  });
  if (!services.enabled) {
    throw new Error(`expected enabled services, got ${"reason" in services ? services.reason : "unknown"}`);
  }
  return services;
}

function profile(patch: {
  nodeMode?: AuroraRuntimeProfileV2["nodeMode"];
  runtimeTier?: AuroraRuntimeProfileV2["runtimeTier"];
  enabledCapabilityPacks?: AuroraCapabilityPack[];
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
      ...(nodeMode === "mesh-node"
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
  readonly session = new FakeLocalDataSession();
  closed = false;

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
  readonly localAudit = new MemoryLocalAuditRepository();
  closed = false;

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

function randomBytes(seed: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(seed);
}

function sequentialIds(prefix: string): () => string {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
