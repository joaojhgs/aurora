import { describe, expect, it } from 'vitest'
import {
  emptyAuroraNodeConfigDocument,
  type AuroraNodeConfigDocumentV1,
} from '@aurora/client/node-config'
import {
  BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY,
  BrowserPersistentPeerCredentialStore,
  type BrowserVaultStorage,
} from '../src/browser-peer-persistence'

class MapVaultStorage implements BrowserVaultStorage {
  readonly values = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }

  async close(): Promise<void> {}
}

class MapMetadataStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('browser node config persistence', () => {
  it('stores a node policy in the origin-encrypted vault and reloads it', async () => {
    const storage = new MapVaultStorage()
    const metadata = new MapMetadataStorage()
    const document = emptyAuroraNodeConfigDocument(700)
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      crypto: globalThis.crypto,
      metadataStorage: metadata,
      origin: 'https://node.example.test',
    })

    await store.saveNodeConfigDocument(document)

    expect(metadata.values.has(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBe(false)
    const encrypted = storage.values.get(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)
    expect(encrypted).toBeDefined()
    expect(JSON.stringify(encrypted)).not.toContain('"services"')
    expect(JSON.stringify(encrypted)).not.toContain('"prefer"')
    expect(await store.loadNodeConfigDocument()).toEqual(document)
  })

  it('migrates a valid legacy metadata policy into encrypted storage and removes corrupt data', async () => {
    const storage = new MapVaultStorage()
    const metadata = new MapMetadataStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      crypto: globalThis.crypto,
      metadataStorage: metadata,
      origin: 'https://node.example.test',
    })
    const legacyDocument: AuroraNodeConfigDocumentV1 = emptyAuroraNodeConfigDocument(800)
    legacyDocument.services.tts = {
      routing: { prefer: 'network', fallback: 'local' },
    }
    metadata.setItem(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY, JSON.stringify({
      version: 0,
      updatedAtMs: 800,
      services: {
        tts: { prefer: 'network', fallback: 'local' },
      },
    }))

    expect(await store.loadNodeConfigDocument()).toEqual(legacyDocument)
    expect(metadata.getItem(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBeNull()
    expect(storage.values.has(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBe(true)

    metadata.setItem(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY, '{"version":1,"updatedAtMs":-1}')
    await storage.delete(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)
    expect(await store.loadNodeConfigDocument()).toBeNull()
    expect(metadata.values.has(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBe(false)
  })

  it('fails closed when durable browser storage is unavailable', async () => {
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      crypto: null,
      metadataStorage: new MapMetadataStorage(),
    })

    await expect(store.saveNodeConfigDocument(emptyAuroraNodeConfigDocument(900))).rejects.toThrow('Persistent browser node config storage is unavailable')
    await expect(store.loadNodeConfigDocument()).resolves.toBeNull()
  })
})
