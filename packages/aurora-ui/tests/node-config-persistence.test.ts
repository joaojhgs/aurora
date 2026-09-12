import { describe, expect, it } from 'vitest'
import {
  emptyAuroraNodeConfigDocument,
  type AuroraNodeConfigDocumentV1,
} from '@aurora/client'
import {
  BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY,
  BrowserPersistentPeerCredentialStore,
} from '../src/browser-peer-persistence'

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
  it('stores a node policy separately from runtime profiles and reloads it', () => {
    const metadata = new MapMetadataStorage()
    const document = emptyAuroraNodeConfigDocument(700)
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      crypto: null,
      metadataStorage: metadata,
      origin: 'https://node.example.test',
    })

    store.saveNodeConfigDocument(document)

    expect(metadata.values.has(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBe(true)
    expect(metadata.values.has('aurora.runtimeProfiles.v2')).toBe(false)
    expect(store.loadNodeConfigDocument()).toEqual(document)
  })

  it('migrates valid sparse documents and removes corrupt persisted policy', () => {
    const metadata = new MapMetadataStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      crypto: null,
      metadataStorage: metadata,
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

    expect(store.loadNodeConfigDocument()).toEqual(legacyDocument)
    expect(metadata.getItem(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toContain('"version":1')

    metadata.setItem(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY, '{"version":1,"updatedAtMs":-1}')
    expect(store.loadNodeConfigDocument()).toBeNull()
    expect(metadata.values.has(BROWSER_PEER_NODE_CONFIG_DOCUMENT_KEY)).toBe(false)
  })
})
