import { describe, expect, it, vi } from 'vitest'
import { BrowserPersistentPeerCredentialStore, createBrowserNativeCapabilityPack, type AuroraRuntimeProfileV2 } from '@aurora/ui'
import { MemoryLocalDataBackend, type EncryptedDataEnvelopeV1, type EnvelopeCryptoPort, type LocalDataBackend, type LocalDataBackendStatus, type LocalDataKeyPurpose, type LocalDataSession } from '@aurora/client/local-data'
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
      localDataBackendFactory: async () => new PersistentMemoryLocalDataBackend(),
      envelopeCryptoFactory: () => new RecordingEnvelopeCrypto(),
      nativeCapabilityPackFactory: (options) => createBrowserNativeCapabilityPack({
        ...options,
        navigator: { onLine: true, userAgent: 'vitest' },
      }),
      cursorSecret: 'cursor-secret-1234',
      nowMs: () => 1_000,
      randomId: () => 'id-1',
      randomBytes: fixedBytes,
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
      localDataBackendFactory: async () => backend,
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
    })

    expect(services.enabled).toBe(true)
    expect(services.grantStorePersistent).toBe(true)
    expect(services.storageBackendKind).toBe('indexeddb')
    expect(services.registeredToolIds).toEqual(['aurora.local.native.get_device_status.v1'])

    expect(services.peerHost).toBeDefined()
    await expect(services.peerHost!.startEpoch('remote-peer')).resolves.toMatchObject({
      shared_services: [],
      active_protocol: 'projection-v1',
    })
    await expect(backend.session?.localAudit.listAudit()).resolves.toEqual([])
    await services.close()
  })
})

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
    const key = `cipher-${this.nextId++}`
    this.values.set(key, new Uint8Array(plaintext))
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'test-key',
      nonceB64Url: 'bm9uY2U',
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
