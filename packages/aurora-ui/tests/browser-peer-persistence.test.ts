import { describe, expect, it } from 'vitest'
import {
  inboundVerifierSecretKey,
  type MeshPeerCredentialRecord,
  type MeshReconnectChallengeMessage,
  type PeerRelationshipSelector,
  type WebRtcPeerConnectionProfile,
} from '@aurora/client/webrtc'
import {
  BrowserPersistentPeerCredentialStore,
  type BrowserVaultStorage,
} from '../src/browser-peer-persistence'
import {
  migrateThinProfileDocumentToRuntime,
  type ThinProfileDocument,
} from '../src/thin-connection-profile'

class MapVaultStorage implements BrowserVaultStorage {
  readonly values = new Map<string, unknown>()
  failReads = false
  failWrites = false
  failDeletes = false
  readonly failDeleteKeys = new Set<string>()

  async get(key: string): Promise<unknown> {
    if (this.failReads) throw new Error('storage read denied')
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error('storage denied')
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes || this.failDeleteKeys.has(key)) throw new Error('storage delete denied')
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

const verifierSelector: PeerRelationshipSelector = {
  tokenId: 'token-row-1',
  claimantPeerId: 'browser-peer',
  verifierPeerId: 'host-peer',
  roomName: 'family-room',
}

const verifierSecretKey = inboundVerifierSecretKey(verifierSelector)

const verifierSecret = JSON.stringify({
  version: 1,
  tokenId: 'token-row-1',
  claimantPeerId: 'browser-peer',
  verifierPeerId: 'host-peer',
  roomName: 'family-room',
  tokenHashHex: 'c'.repeat(64),
  createdAtMs: 100,
  credentialRevision: 1,
})

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
    first.savePeerConnectionProfile({
      ...profile,
      expectedStablePeerId: 'peer-portugal',
      expectedSignalingPeerId: 'signal-portugal',
      nodeName: 'Portugal node',
    })
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
    expect(reloaded.loadPeerConnectionProfiles().map((saved) => saved.expectedStablePeerId)).toEqual([
      'host-peer',
      'peer-portugal',
    ])
    expect(reloaded.loadPeerConnectionProfiles().find((saved) => saved.expectedStablePeerId === 'peer-portugal'))
      .not.toHaveProperty('expectedSignalingPeerId')
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
    await reloaded.remove('peer-portugal')
    expect(reloaded.loadPeerConnectionProfiles().map((saved) => saved.expectedStablePeerId)).toEqual(['host-peer'])
    await reloaded.close()
  })

  it('does not pin a stable peer to an expired signaling transport after reload', async () => {
    const metadata = new MapMetadataStorage()
    const first = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })

    first.saveConnectionProfile({
      ...profile,
      expectedSignalingPeerId: 'host-signal-before-restart',
    })
    first.savePeerConnectionProfile({
      ...profile,
      expectedStablePeerId: 'peer-portugal',
      expectedSignalingPeerId: 'portugal-signal-before-restart',
    })

    expect(first.loadConnectionProfile()).toMatchObject({ expectedStablePeerId: 'host-peer' })
    expect(first.loadConnectionProfile()).not.toHaveProperty('expectedSignalingPeerId')
    expect(first.loadPeerConnectionProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ expectedStablePeerId: 'peer-portugal' }),
    ]))
    expect(first.loadPeerConnectionProfiles().find((saved) => saved.expectedStablePeerId === 'peer-portugal'))
      .not.toHaveProperty('expectedSignalingPeerId')
    await first.close()
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

  it('retries encrypted persistence after a transient vault failure', async () => {
    const storage = new MapVaultStorage()
    storage.failWrites = true
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://aurora.example.test',
    })

    await store.save('host-peer', credential)
    expect(store.persistenceStatus()).toMatchObject({ backend: 'memory', secretsPersisted: false })

    storage.failWrites = false
    await store.save('host-peer-recovered', { ...credential, verifierPeerId: 'host-peer-recovered' })

    expect(store.persistenceStatus()).toMatchObject({
      backend: 'encrypted-indexeddb',
      secretsPersisted: true,
      profilePersisted: true,
    })
    expect(storage.values.has('credential:host-peer-recovered')).toBe(true)
    await store.close()
  })

  it('stores inbound verifier secrets only in the encrypted vault and restores them after restart', async () => {
    const storage = new MapVaultStorage()
    const metadata = new MapMetadataStorage()
    const first = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await first.setOpaqueSecret(verifierSecretKey, verifierSecret)
    await expect(first.getOpaqueSecret(verifierSecretKey)).resolves.toBe(verifierSecret)
    await first.close()

    const serializedVault = JSON.stringify([...storage.values.entries()])
    expect(serializedVault).toContain(verifierSecretKey)
    expect(serializedVault).not.toContain(verifierSecret)
    expect(serializedVault).not.toContain('"tokenHashHex"')
    expect(serializedVault).not.toContain('c'.repeat(64))
    expect([...metadata.values.values()].join('\n')).not.toContain('tokenHashHex')

    const reloaded = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await expect(reloaded.getOpaqueSecret(verifierSecretKey)).resolves.toBe(verifierSecret)
    await reloaded.close()
  })

  it('accepts SDK-valid inbound verifier keys with room names up to 512 characters', async () => {
    const storage = new MapVaultStorage()
    const longRoomSelector: PeerRelationshipSelector = {
      ...verifierSelector,
      roomName: 'r'.repeat(512),
    }
    const longRoomKey = inboundVerifierSecretKey(longRoomSelector)
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await expect(store.setOpaqueSecret(longRoomKey, verifierSecret)).resolves.toBeUndefined()
    await expect(store.getOpaqueSecret(longRoomKey)).resolves.toBe(verifierSecret)
    await store.close()
  })

  it('rejects inbound verifier secret keys outside the exact default namespace', async () => {
    const store = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    const wrongNamespace = verifierSecretKey.replace('aurora.peer-host.inbound-verifier.v1:', 'aurora.peer-host.other.v1:')
    const invalidPart = `${verifierSecretKey}:extra`

    await expect(store.setOpaqueSecret(wrongNamespace, verifierSecret)).rejects.toThrow('Invalid inbound verifier secret key')
    await expect(store.getOpaqueSecret(wrongNamespace)).rejects.toThrow('Invalid inbound verifier secret key')
    await expect(store.deleteOpaqueSecret(wrongNamespace)).rejects.toThrow('Invalid inbound verifier secret key')
    await expect(store.setOpaqueSecret(invalidPart, verifierSecret)).rejects.toThrow('Invalid inbound verifier secret key')
    await expect(store.getOpaqueSecret('aurora.peer-host.inbound-verifier.v1:host.peer:browser-peer:family-room:token-row-1'))
      .rejects.toThrow('Invalid inbound verifier secret key')
    await store.close()
  })

  it('rejects inbound verifier operations when durable encrypted storage is unavailable or fails', async () => {
    const unavailable = new BrowserPersistentPeerCredentialStore({
      storage: null,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await expect(unavailable.getOpaqueSecret(verifierSecretKey)).rejects.toThrow('Persistent inbound verifier storage is unavailable')
    await expect(unavailable.setOpaqueSecret(verifierSecretKey, verifierSecret)).rejects.toThrow('Persistent inbound verifier storage is unavailable')
    await expect(unavailable.deleteOpaqueSecret(verifierSecretKey)).rejects.toThrow('Persistent inbound verifier storage is unavailable')
    await unavailable.close()

    const queuedFailure = new MapVaultStorage()
    const queuedStore = new BrowserPersistentPeerCredentialStore({
      storage: queuedFailure,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    queuedFailure.failWrites = true
    queuedStore.setRoomSecret(profile.roomSecretRef, 'queued-room-secret')
    await expect(queuedStore.setOpaqueSecret(verifierSecretKey, verifierSecret))
      .rejects.toThrow('storage denied')
    expect(await queuedFailure.keys()).not.toContain(verifierSecretKey)
    await queuedStore.close()

    const queuedReadFailure = new MapVaultStorage()
    const queuedReadStore = new BrowserPersistentPeerCredentialStore({
      storage: queuedReadFailure,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await queuedReadStore.setOpaqueSecret(verifierSecretKey, verifierSecret)
    queuedReadFailure.failWrites = true
    queuedReadStore.setRoomSecret(profile.roomSecretRef, 'queued-room-secret')
    await expect(queuedReadStore.getOpaqueSecret(verifierSecretKey)).resolves.toBe(verifierSecret)
    await queuedReadStore.close()

    const failingWrites = new MapVaultStorage()
    failingWrites.failWrites = true
    const writeStore = new BrowserPersistentPeerCredentialStore({
      storage: failingWrites,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await expect(writeStore.setOpaqueSecret(verifierSecretKey, verifierSecret)).rejects.toThrow('storage denied')
    expect(await writeStore.get('host-peer')).toBeUndefined()
    await writeStore.close()

    const failingReads = new MapVaultStorage()
    const readStore = new BrowserPersistentPeerCredentialStore({
      storage: failingReads,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await readStore.setOpaqueSecret(verifierSecretKey, verifierSecret)
    failingReads.failReads = true
    await expect(readStore.getOpaqueSecret(verifierSecretKey)).rejects.toThrow('storage read denied')
    await readStore.close()

    const failingDeletes = new MapVaultStorage()
    const deleteStore = new BrowserPersistentPeerCredentialStore({
      storage: failingDeletes,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    await deleteStore.setOpaqueSecret(verifierSecretKey, verifierSecret)
    failingDeletes.failDeletes = true
    await expect(deleteStore.deleteOpaqueSecret(verifierSecretKey)).rejects.toThrow('storage delete denied')
    await deleteStore.close()
  })

  it('clears inbound verifier secrets with device credential data', async () => {
    const storage = new MapVaultStorage()
    const metadata = new MapMetadataStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await store.setOpaqueSecret(verifierSecretKey, verifierSecret)
    await store.save('host-peer', credential)
    store.setRoomSecret(profile.roomSecretRef, 'room-secret')
    await expect(store.getOpaqueSecret(verifierSecretKey)).resolves.toBe(verifierSecret)

    await store.clear()

    expect(await storage.keys()).not.toContain(verifierSecretKey)
    expect((await storage.keys()).some((key) => key.startsWith('credential:') || key.startsWith('room:'))).toBe(false)
    await expect(store.getOpaqueSecret(verifierSecretKey)).resolves.toBeUndefined()
    await store.close()
  })

  it('deletes the vault key and rotates to a fresh key before reusing persistent storage', async () => {
    const storage = new MapVaultStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })
    const staleCredential = {
      ...credential,
      tokenId: 'token-row-stale',
      verifierPeerId: 'stale-host-peer',
    }

    await store.save('stale-host-peer', staleCredential)
    await store.save('host-peer', credential)
    store.setRoomSecret(profile.roomSecretRef, 'room-secret')
    await store.setOpaqueSecret(verifierSecretKey, verifierSecret)
    await expect(store.getRoomSecret(profile.roomSecretRef)).resolves.toBeDefined()
    const firstVaultKey = storage.values.get('internal:vault-key')
    const staleCiphertext = storage.values.get('credential:stale-host-peer')
    expect(firstVaultKey).toBeDefined()
    expect(staleCiphertext).toBeDefined()

    await store.clear()

    expect(await storage.keys()).toEqual([])
    expect(storage.values.get('internal:vault-key')).toBeUndefined()
    expect(await store.get('host-peer')).toBeUndefined()
    expect(await store.get('stale-host-peer')).toBeUndefined()
    expect(await store.getRoomSecret(profile.roomSecretRef)).toBeNull()
    await expect(store.getOpaqueSecret(verifierSecretKey)).resolves.toBeUndefined()

    await store.save('host-peer', credential)
    const secondVaultKey = storage.values.get('internal:vault-key')
    expect(secondVaultKey).toBeDefined()
    expect(secondVaultKey).not.toBe(firstVaultKey)

    storage.values.set('credential:stale-host-peer', staleCiphertext)
    await expect(store.get('stale-host-peer')).resolves.toBeUndefined()
    expect(await store.prove('stale-host-peer', challenge)).toBeUndefined()
    await store.close()
  })

  it('clears inbound verifier secrets after an unrelated queued vault downgrade when storage deletes still work', async () => {
    const storage = new MapVaultStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await store.setOpaqueSecret(verifierSecretKey, verifierSecret)
    storage.failWrites = true
    store.setRoomSecret(profile.roomSecretRef, 'queued-room-secret')

    await expect(store.clear()).resolves.toBeUndefined()

    expect(await storage.keys()).not.toContain(verifierSecretKey)
    await store.close()
  })

  it('reports clear failures for uncleared inbound verifier material', async () => {
    const storage = new MapVaultStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await store.setOpaqueSecret(verifierSecretKey, verifierSecret)
    await store.save('host-peer', credential)
    store.setRoomSecret(profile.roomSecretRef, 'room-secret')
    storage.failDeleteKeys.add(verifierSecretKey)

    await expect(store.clear()).rejects.toThrow('storage delete denied')

    const keys = await storage.keys()
    expect(keys).toContain(verifierSecretKey)
    expect(keys.some((key) => key.startsWith('credential:') || key.startsWith('room:'))).toBe(false)
    await store.close()
  })

  it('reports clear failures when the vault key cannot be deleted', async () => {
    const storage = new MapVaultStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await store.save('host-peer', credential)
    storage.failDeleteKeys.add('internal:vault-key')

    await expect(store.clear()).rejects.toThrow('storage delete denied')

    expect(await storage.keys()).toContain('internal:vault-key')
    expect(store.persistenceStatus()).toMatchObject({
      backend: 'memory',
      secretsPersisted: false,
    })
    await store.close()
  })

  it('reports clear failures when any outbound credential or room secret cannot be deleted', async () => {
    const storage = new MapVaultStorage()
    const store = new BrowserPersistentPeerCredentialStore({
      storage,
      metadataStorage: new MapMetadataStorage(),
      crypto: globalThis.crypto,
      origin: 'https://provider.aurora.example.test',
    })

    await store.save('host-peer', credential)
    store.setRoomSecret(profile.roomSecretRef, 'room-secret')
    await expect(store.getRoomSecret(profile.roomSecretRef)).resolves.toBeDefined()
    storage.failDeleteKeys.add('credential:host-peer')

    await expect(store.clear()).rejects.toThrow('storage delete denied')

    const keys = await storage.keys()
    expect(keys).toContain('credential:host-peer')
    expect(keys).not.toContain('room:ref:memory:family-room')
    expect(keys).not.toContain('internal:vault-key')
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

    metadata.failWrites = false
    store.saveConnectionProfile(profile)
    await store.save('host-peer', credential)
    expect(store.persistenceStatus()).toMatchObject({
      backend: 'encrypted-indexeddb',
      secretsPersisted: true,
      profilePersisted: true,
    })
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
    expect(store.loadRuntimeProfileDocument()).toEqual(migrateThinProfileDocumentToRuntime(thinProfileDocument))
    const plaintextMetadata = [...metadata.values.values()].join('\n')
    expect(metadata.getItem('aurora.runtimeProfiles.v2')).toContain('"version":2')
    expect(metadata.getItem('aurora.webThin.connectionProfiles.v1')).toBeNull()
    expect(plaintextMetadata).toContain('https://gateway.example.test/api?tenant=home')
    expect(plaintextMetadata).toContain('wss://signal.example.test/mqtt?tenant=home')
    expect(plaintextMetadata).not.toContain(credential.rawBearerToken)
    expect(plaintextMetadata).not.toContain('never-store-this-room-secret-in-plaintext')
    expect(plaintextMetadata).not.toContain('"roomSecret"')
    await store.close()
  })

  it('migrates legacy v1 metadata to v2 and removes corrupt v2 metadata safely', async () => {
    const metadata = new MapMetadataStorage()
    metadata.setItem('aurora.webThin.connectionProfiles.v1', JSON.stringify(thinProfileDocument))
    const migrated = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://profiles.aurora.example.test',
    })

    expect(migrated.loadRuntimeProfileDocument()).toEqual(migrateThinProfileDocumentToRuntime(thinProfileDocument))
    expect(metadata.getItem('aurora.runtimeProfiles.v2')).toContain('"version":2')
    expect(metadata.getItem('aurora.webThin.connectionProfiles.v1')).toBeNull()
    await migrated.close()

    metadata.setItem('aurora.runtimeProfiles.v2', '{"version":2,"activeProfileId":"missing","profiles":[]}')
    const corrupt = new BrowserPersistentPeerCredentialStore({
      storage: new MapVaultStorage(),
      metadataStorage: metadata,
      crypto: globalThis.crypto,
      origin: 'https://profiles.aurora.example.test',
    })
    expect(corrupt.loadRuntimeProfileDocument()).toBeNull()
    expect(metadata.getItem('aurora.runtimeProfiles.v2')).toBeNull()
    await corrupt.close()
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
