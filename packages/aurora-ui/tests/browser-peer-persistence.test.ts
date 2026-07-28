import { describe, expect, it } from 'vitest'
import type {
  MeshPeerCredentialRecord,
  MeshReconnectChallengeMessage,
  WebRtcPeerConnectionProfile,
} from '@aurora/client/webrtc'
import {
  BrowserPersistentPeerCredentialStore,
  type BrowserVaultStorage,
} from '../src/browser-peer-persistence'
import type { ThinProfileDocument } from '../src/thin-connection-profile'

class MapVaultStorage implements BrowserVaultStorage {
  readonly values = new Map<string, unknown>()
  failWrites = false

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error('storage denied')
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
  failWrites = false
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('metadata denied')
    this.values.set(key, value)
  }
  removeItem(key: string): void { this.values.delete(key) }
}

const profile: WebRtcPeerConnectionProfile = {
  mode: 'webrtc-only',
  appId: 'aurora',
  room: 'family-room',
  roomSecretRef: 'ref:memory:family-room',
  signalingBrokers: ['wss://signal.example.test/mqtt'],
  expectedStablePeerId: 'host-peer',
  nodeName: 'Aurora host',
  production: true,
  stunServers: ['stun:stun.example.test:3478'],
  turnServers: ['turns:turn.example.test:5349'],
  requireAppLayerE2ee: true,
}

const credential: MeshPeerCredentialRecord = {
  tokenId: 'token-row-1',
  claimantPeerId: 'browser-peer',
  verifierPeerId: 'host-peer',
  claimantSignalingPeerId: 'browser-signal-old',
  verifierSignalingPeerId: 'host-signal-old',
  roomName: 'family-room',
  rawBearerToken: 'never-store-this-token-in-plaintext',
}

const challenge: MeshReconnectChallengeMessage = {
  type: 'mesh_auth_challenge_v1',
  challenge: 'a'.repeat(64),
  channel_binding: 'b'.repeat(64),
  claimant_peer_id: 'browser-peer',
  verifier_peer_id: 'host-peer',
  claimant_signaling_peer_id: 'browser-signal-new',
  verifier_signaling_peer_id: 'host-signal-new',
  room_name: 'family-room',
}

const thinProfileDocument: ThinProfileDocument = {
  version: 1,
  activeProfileId: 'hosted-home',
  profiles: [{
    id: 'hosted-home',
    label: 'Hosted home',
    mode: 'webrtc-preferred',
    gatewayUrl: 'https://gateway.example.test/api?tenant=home',
    signalingUrl: 'wss://signal.example.test/mqtt?tenant=home',
    nodeName: 'Aurora hosted web',
    localStablePeerId: 'aurora-hosted-web-stable',
    webrtcProfile: {
      ...profile,
      mode: 'webrtc-preferred',
      nodeName: 'Aurora hosted web',
      signalingBrokers: ['wss://signal.example.test/mqtt?tenant=home'],
    },
  }],
}

describe('BrowserPersistentPeerCredentialStore', () => {
  it('encrypts room and reconnect secrets, then restores them after a reload', async () => {
    const storage = new MapVaultStorage()
    const metadata = new MapMetadataStorage()
    const first = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })

    first.setRoomSecret(profile.roomSecretRef, 'never-store-this-room-secret-in-plaintext')
    first.saveConnectionProfile(profile)
    const stablePeerId = first.getOrCreateLocalStablePeerId()
    await first.save('host-peer', credential)
    const firstProof = await first.prove('host-peer', challenge)
    await first.close()

    const serializedVault = JSON.stringify([...storage.values.entries()])
    expect(serializedVault).not.toContain(credential.rawBearerToken)
    expect(serializedVault).not.toContain('never-store-this-room-secret-in-plaintext')
    expect(serializedVault).not.toContain('"rawBearerToken"')
    expect([...metadata.values.values()].join('\n')).not.toContain(credential.rawBearerToken)
    expect([...metadata.values.values()].join('\n')).not.toContain('never-store-this-room-secret-in-plaintext')

    const reloaded = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })
    expect(reloaded.getOrCreateLocalStablePeerId()).toBe(stablePeerId)
    expect(reloaded.loadConnectionProfile()).toEqual(profile)
    expect(new TextDecoder().decode(await reloaded.getRoomSecret(profile.roomSecretRef) ?? undefined))
      .toBe('never-store-this-room-secret-in-plaintext')
    expect(await reloaded.get('host-peer')).toMatchObject({
      tokenId: credential.tokenId,
      claimantPeerId: credential.claimantPeerId,
      verifierPeerId: credential.verifierPeerId,
    })
    expect(await reloaded.prove('host-peer', challenge)).toEqual(firstProof)
    expect(reloaded.persistenceStatus()).toMatchObject({
      backend: 'encrypted-indexeddb',
      secretsPersisted: true,
      profilePersisted: true,
    })
    await reloaded.close()
  })

  it('falls back to memory-only when encrypted persistence fails', async () => {
    const storage = new MapVaultStorage()
    storage.failWrites = true
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })

    store.setRoomSecret(profile.roomSecretRef, 'memory-room-secret')
    await store.save('host-peer', credential)
    expect(await store.prove('host-peer', challenge)).toBeDefined()
    expect(new TextDecoder().decode(await store.getRoomSecret(profile.roomSecretRef) ?? undefined))
      .toBe('memory-room-secret')
    expect(store.persistenceStatus()).toMatchObject({
      backend: 'memory',
      secretsPersisted: false,
      profilePersisted: true,
    })
    expect(store.persistenceStatus().fallbackReason).toContain('storage denied')
    await store.close()
  })

  it('fully downgrades to memory-only when reconnect metadata cannot persist', async () => {
    const metadata = new MapMetadataStorage()
    metadata.failWrites = true
    const store = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })

    store.saveConnectionProfile(profile)
    expect(store.persistenceStatus()).toMatchObject({
      backend: 'memory',
      secretsPersisted: false,
      profilePersisted: false,
    })
    expect(store.persistenceStatus().fallbackReason).toContain('metadata denied')
    await store.close()
  })

  it('persists a sanitized runtime connection profile without room or bearer secrets', async () => {
    const metadata = new MapMetadataStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://profiles.aurora.example.test',
    })

    store.saveThinProfileDocument(thinProfileDocument)

    expect(store.loadThinProfileDocument()).toEqual(thinProfileDocument)
    const plaintextMetadata = [...metadata.values.values()].join('\n')
    expect(plaintextMetadata).toContain('https://gateway.example.test/api?tenant=home')
    expect(plaintextMetadata).toContain('wss://signal.example.test/mqtt?tenant=home')
    expect(plaintextMetadata).not.toContain(credential.rawBearerToken)
    expect(plaintextMetadata).not.toContain('never-store-this-room-secret-in-plaintext')
    expect(plaintextMetadata).not.toContain('"roomSecret"')
    await store.close()
  })

  it('keeps runtime profile metadata available for the current SPA session when browser storage is unavailable', async () => {
    const origin = 'https://volatile-profile.aurora.example.test'
    const first = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: null,
      crypto: globalThis.crypto,
      origin,
    })
    first.saveThinProfileDocument(thinProfileDocument)
    const stablePeerId = first.getOrCreateLocalStablePeerId()
    expect(first.persistenceStatus()).toMatchObject({
      backend: 'memory',
      secretsPersisted: false,
      profilePersisted: false,
    })
    await first.close()

    const rebuiltInSamePage = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: null,
      crypto: globalThis.crypto,
      origin,
    })
    expect(rebuiltInSamePage.loadThinProfileDocument()).toEqual(thinProfileDocument)
    expect(rebuiltInSamePage.getOrCreateLocalStablePeerId()).toBe(stablePeerId)

    await rebuiltInSamePage.clear()
    await rebuiltInSamePage.close()
    const afterClear = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: null,
      crypto: globalThis.crypto,
      origin,
    })
    expect(afterClear.loadThinProfileDocument()).toBeNull()
    expect(afterClear.getOrCreateLocalStablePeerId()).not.toBe(stablePeerId)
    await afterClear.clear()
    await afterClear.close()
  })

  it('rejects malformed persisted profile metadata without exposing secrets', async () => {
    const metadata = new MapMetadataStorage()
    metadata.setItem('aurora.webThin.profile.v1', JSON.stringify({
      ...profile,
      signalingBrokers: ['javascript:alert(1)'],
      roomSecret: 'must-not-be-accepted',
    }))
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
    })

    expect(store.loadConnectionProfile()).toBeNull()
    expect(metadata.getItem('aurora.webThin.profile.v1')).toBeNull()
    await store.close()
  })

  it('rejects unsafe persisted ICE server metadata', async () => {
    const metadata = new MapMetadataStorage()
    metadata.setItem('aurora.webThin.profile.v1', JSON.stringify({
      ...profile,
      stunServers: ['https://stun.example.test'],
    }))
    const store = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
    })

    expect(store.loadConnectionProfile()).toBeNull()
    expect(metadata.getItem('aurora.webThin.profile.v1')).toBeNull()
    await store.close()
  })
})
