import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { BrowserPersistentPeerCredentialStore, createBrowserNativeCapabilityPack, type AuroraRuntimeProfileV2 } from '@aurora/ui'
import { MemoryLocalDataBackend, type EncryptedDataEnvelopeV1, type EnvelopeCryptoPort, type LocalDataBackend, type LocalDataBackendStatus, type LocalDataKeyPurpose, type LocalDataSession } from '@aurora/client/local-data'
import type { LocalToolExportDecisionPort } from '@aurora/client/local-tools'
import type { MeshAuthorityWasmSource } from '@aurora/mesh-authority-web'
import {
  BrowserMeshNodeCompositionError,
  createBrowserMeshNodeServices,
} from './browser-mesh-node-services'

describe('browser mesh-node service composition', () => {
  it('fails closed when credential storage is memory-only', async () => {
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: memoryStorage(),
      crypto: null,
    })

    await expect(createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: store,
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      localDataBackendFactory: async () => localDataAuthority(new PersistentMemoryLocalDataBackend()),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: () => 'id-1',
      randomBytes: fixedBytes,
      authorityWasmSource: nodeWasmSource,
    })).rejects.toMatchObject({
      name: 'BrowserMeshNodeCompositionError',
      code: 'credential_store_memory_only',
    })
  })

  it('composes durable authority, grant, audit, native pack, and peer host before callers connect', async () => {
    const store = new BrowserPersistentPeerCredentialStore({
      storage: new MemoryVaultStorage(),
      metadataStorage: memoryStorage(),
      crypto: globalThis.crypto,
      now: () => 1_000,
    })
    const backend = new PersistentMemoryLocalDataBackend()
    const services = await createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: store,
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      origin: 'https://app.example',
      localDataBackendFactory: async () => localDataAuthority(backend),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: vi.fn()
        .mockReturnValueOnce('audit-1')
        .mockReturnValue('epoch-1'),
      randomBytes: fixedBytes,
      authorityWasmSource: nodeWasmSource,
    })

    expect(services.enabled).toBe(true)
    expect(services.grantStorePersistent).toBe(true)
    expect(services.storageBackendKind).toBe('indexeddb')
    expect(services.registeredToolIds).toEqual(['aurora.local.native.get_device_status.v1'])
    expect(services.session).toBe(backend.session)
    expect(services.backend).toBe(backend)
    expect(services.crypto).toBeInstanceOf(RecordingEnvelopeCrypto)
    expect(services.provider.enabled).toBe(true)
    expect(services.localToolRegistry).toBe(services.provider.localToolRegistry)
    await expect(services.localFeatureSharing.load()).resolves.toMatchObject({
      features: [
        expect.objectContaining({
          id: 'aurora.local.native.get_device_status.v1',
          enabled: false,
        }),
      ],
      approvedDevices: [],
    })
    expect(services.compositionStatus).toMatchObject({
      state: 'ready',
      productMessage: 'This device is available for sharing.',
    })

    expect(services.peerHost).toBeDefined()
    await expect(services.peerHost!.startEpoch('remote-peer')).resolves.toMatchObject({
      shared_services: [],
      active_protocol: 'legacy-unfiltered-v0',
      projection_active: false,
    })
    await expect(backend.session?.localAudit.listAudit()).resolves.toEqual([])
    await services.close()
  })

  it('defaults local tool export to deny-all until an explicit decision port opts in', async () => {
    const store = durableCredentialStore()
    const backend = new PersistentMemoryLocalDataBackend()
    const services = await createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: store,
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      localDataBackendFactory: async () => localDataAuthority(backend),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: () => 'id-1',
      randomBytes: fixedBytes,
      authorityWasmSource: nodeWasmSource,
    })

    const catalog = await dispatchExportCatalog(services)

    expect(catalog).toMatchObject({ tools: [] })
    await services.close()
  })

  it('routes pairing, sharing, and revocation through the Rust WASM authority', async () => {
    const services = await createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: durableCredentialStore(),
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      localDataBackendFactory: async () => localDataAuthority(new PersistentMemoryLocalDataBackend()),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: () => 'grant-browser-1',
      authorityWasmSource: nodeWasmSource,
    })
    const selector = {
      tokenId: 'token-browser-1',
      claimantPeerId: 'remote-peer',
      verifierPeerId: 'browser-peer',
      roomName: 'office',
    }

    const issued = await services.peerPairingIssuer.issue(selector)
    expect(issued).toMatchObject({
      tokenId: selector.tokenId,
      verifier: expect.objectContaining(selector),
    })
    expect(issued.bearerToken).toMatch(/^[0-9a-f]{64}$/u)

    const grant = await services.peerGrantManager.replaceGrant(selector, {
      allowedToolContractIds: ['aurora.local.native.get_device_status.v1'],
      capabilityPackIds: ['native-actions'],
    })
    await expect(services.peerGrantManager.listActiveGrants(selector)).resolves.toEqual([
      expect.objectContaining({
        grantId: grant.grantId,
        claimantPeerId: 'remote-peer',
        sharingState: 'active',
        secretFieldsRedacted: true,
      }),
    ])

    await expect(services.peerRevocationController.revoke(selector)).resolves.toMatchObject({
      type: 'peer_authority_revoked_v1',
      selector,
      reasonCode: 'peer_authority_revoked',
      redacted: true,
    })
    await expect(services.peerGrantManager.listActiveGrants(selector)).resolves.toEqual([])
    await services.close()
  })

  it('uses explicit export decisions and records local tool audit directly into durable local data', async () => {
    const store = durableCredentialStore()
    const backend = new PersistentMemoryLocalDataBackend()
    const exportDecision: LocalToolExportDecisionPort = {
      isShared: (tool) => tool.tool_contract_id === 'aurora.local.native.get_device_status.v1',
    }
    const services = await createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: store,
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      localDataBackendFactory: async () => localDataAuthority(backend),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      exportDecision,
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: vi.fn()
        .mockReturnValueOnce('audit-1')
        .mockReturnValue('epoch-1'),
      randomBytes: fixedBytes,
      authorityWasmSource: nodeWasmSource,
    })

    const catalog = await dispatchExportCatalog(services)
    expect(catalog).toMatchObject({
      tools: [
        expect.objectContaining({
          tool_contract_id: 'aurora.local.native.get_device_status.v1',
        }),
      ],
    })
    const execute = services.provider.peerHostRegistry.get('Tooling.ExecuteTool')
    expect(execute).toBeDefined()
    if (!execute) throw new Error('execute method missing')
    await services.provider.peerHostRegistry.dispatch(execute, {
      tool_name: 'aurora.local.native.get_device_status.v1',
      arguments: {},
    }, peerHostContext())

    await expect(services.session.localAudit.listAudit()).resolves.toEqual([
      expect.objectContaining({
        id: 'epoch-1',
        profileId: 'profile-1',
        localNodeId: 'browser-peer',
        peerId: 'remote-peer',
        action: 'local-tool.execute',
        decision: 'rejected',
        resultStatus: 'denied',
        methodId: 'Tooling.ExecuteTool',
        toolContractId: 'aurora.local.native.get_device_status.v1',
        redactedDetailJson: expect.objectContaining({
          redacted: true,
          secretsRedacted: true,
        }),
      }),
    ])
    await services.close()
  })

  it('serializes provider manifest refreshes after durable feature-sharing changes', async () => {
    const store = durableCredentialStore()
    const backend = new PersistentMemoryLocalDataBackend()
    const services = await createBrowserMeshNodeServices({
      runtimeProfile: meshProfile(),
      credentialStore: store,
      rolloutFlags: rolloutFlags(),
      localStablePeerId: 'browser-peer',
      localDataBackendFactory: async () => localDataAuthority(backend),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: () => 'id-1',
      randomBytes: fixedBytes,
      authorityWasmSource: nodeWasmSource,
    })
    let releaseFirstResume: (() => void) | undefined
    const firstResume = new Promise<void>((resolve) => {
      releaseFirstResume = resolve
    })
    let activeResumes = 0
    let maxActiveResumes = 0
    const resume = vi
      .spyOn(services.provider.peerHost, 'resumeLocalProvider')
      .mockImplementation(async () => {
        activeResumes += 1
        maxActiveResumes = Math.max(maxActiveResumes, activeResumes)
        try {
          if (resume.mock.calls.length === 1) await firstResume
        } finally {
          activeResumes -= 1
        }
      })

    await services.localFeatureSharing.setFeatureEnabled(
      'aurora.local.native.get_device_status.v1',
      true,
    )
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
    await services.localFeatureSharing.setFeatureEnabled(
      'aurora.local.native.get_device_status.v1',
      false,
    )

    expect(resume).toHaveBeenCalledOnce()
    releaseFirstResume?.()
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2))
    expect(maxActiveResumes).toBe(1)
    await services.close()
  })
})

const AUTHORITY_WASM_DIR = resolve(
  process.cwd(),
  '../../packages/aurora-mesh-authority-web/dist/wasm',
)

const nodeWasmSource: MeshAuthorityWasmSource = {
  importBindings: async () => await import(resolve(AUTHORITY_WASM_DIR, 'aurora_mesh_authority.js')),
  wasmBytes: async () => readFileSync(resolve(AUTHORITY_WASM_DIR, 'aurora_mesh_authority_bg.wasm')),
}

async function localDataAuthority(backend: PersistentMemoryLocalDataBackend) {
  return {
    backend,
    session: await backend.open('profile-1', 'browser-peer'),
  }
}

function durableCredentialStore(): BrowserPersistentPeerCredentialStore {
  return new BrowserPersistentPeerCredentialStore({
    storage: new MemoryVaultStorage(),
    metadataStorage: memoryStorage(),
    crypto: globalThis.crypto,
    now: () => 1_000,
  })
}

async function dispatchExportCatalog(services: Awaited<ReturnType<typeof createBrowserMeshNodeServices>>): Promise<unknown> {
  const method = services.provider.peerHostRegistry.get('Tooling.GetExportCatalog')
  expect(method).toBeDefined()
  if (!method) throw new Error('export catalog method missing')
  return await services.provider.peerHostRegistry.dispatch(method, {}, peerHostContext('Tooling.GetExportCatalog'))
}

function peerHostContext(methodId = 'Tooling.ExecuteTool') {
  return {
    id: 'call-1',
    methodId,
    remotePeerId: 'remote-peer',
    identity: {
      callerPeerId: 'remote-peer',
      principalId: 'principal-a',
      effectivePermissions: [
        'Tooling.GetTools',
        'Tooling.ExecuteTool',
        'Native.GetDeviceStatus',
      ],
      authGrantRevision: 1,
      manifestRevision: 1,
    },
    signal: new AbortController().signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000,
  }
}

function meshProfile(): AuroraRuntimeProfileV2 {
  return {
    version: 2,
    id: 'profile-1',
    label: 'Browser mesh',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    localNode: {
      nodeName: 'Browser peer',
      stablePeerId: 'browser-peer',
      enabledCapabilityPacks: ['native-actions'],
      meshMembership: {
        signalingUrl: 'wss://signaling.example.invalid',
        webrtcProfile: {
          mode: 'webrtc-only',
          appId: 'aurora',
          room: 'office',
          roomSecretRef: 'ref:browser:office',
          signalingBrokers: ['wss://signaling.example.invalid'],
        },
      },
    },
  }
}

function rolloutFlags() {
  return {
    webrtc_thin_client: true,
    webrtc_scoped_subscriptions: true,
    webrtc_fragmentation: true,
    webrtc_app_layer_e2ee: true,
    mesh_node_runtime_v1: true,
    local_tool_provider_v1: true,
    lightweight_orchestrator_v1: true,
    native_webrtc_transport_v1: true,
  }
}

function fixedBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(7)
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

class PersistentMemoryLocalDataBackend implements LocalDataBackend {
  readonly kind = 'indexeddb' as const
  readonly persistent = true
  readonly sqlite = false
  private readonly inner = new MemoryLocalDataBackend()
  session: LocalDataSession | null = null

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    this.session = await this.inner.open(profileId, localNodeId)
    return this.session
  }

  async status(): Promise<LocalDataBackendStatus> {
    const status = await this.inner.status()
    return {
      ...status,
      kind: 'indexeddb',
      persistent: true,
      degradedReason: undefined,
    }
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

class RecordingEnvelopeCrypto implements EnvelopeCryptoPort {
  private readonly values = new Map<string, Uint8Array>()
  private nextId = 1

  async encrypt(_keyPurpose: LocalDataKeyPurpose, plaintext: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    const key = Buffer.from(new Uint8Array(16).fill(this.nextId++)).toString('base64url')
    this.values.set(key, new Uint8Array(plaintext))
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'test-key',
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: key,
      createdAtMs: 1_000,
    }
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1): Promise<Uint8Array> {
    const value = this.values.get(envelope.ciphertextAndTagB64Url)
    if (!value) throw new Error('missing ciphertext')
    return new Uint8Array(value)
  }

  async rotateKey(): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'test-key', newKeyId: 'test-key' }
  }
}

class MemoryVaultStorage {
  private readonly values = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async getOrCreateCryptoKey(key: string, candidate: CryptoKey): Promise<unknown> {
    const existing = this.values.get(key)
    if (existing) return existing
    this.values.set(key, candidate)
    return candidate
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }

  async close(): Promise<void> {
  }
}
