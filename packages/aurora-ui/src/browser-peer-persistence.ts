import {
  MemoryPeerCredentialStore,
  type MeshPeerCredentialRecord,
  type MeshReconnectChallengeMessage,
  type MeshReconnectProofMessage,
  type PeerCredentialStatus,
  type StoredPeerCredentialMetadata,
  type WebRtcPeerConnectionProfile,
  type WebRtcPeerCredentialStore,
} from '@aurora/client/webrtc'
import {
  parseThinProfileDocument,
  type ThinProfileDocument,
} from './thin-connection-profile'
import {
  migrateThinProfileDocumentToRuntime,
  parseRuntimeProfileDocument,
  runtimeProfileDocumentToThinDocument,
  serializeRuntimeProfileDocument,
  type AuroraRuntimeProfileDocumentV2,
} from './runtime-profile'
import {
  BROWSER_PEER_CREDENTIAL_PREFIX as CREDENTIAL_PREFIX,
  BROWSER_PEER_INBOUND_VERIFIER_KEY_PREFIX as INBOUND_VERIFIER_KEY_PREFIX,
  BROWSER_PEER_INBOUND_VERIFIER_PREFIX as INBOUND_VERIFIER_PREFIX,
  BROWSER_PEER_PROFILE_KEY as PROFILE_KEY,
  BROWSER_PEER_ROOM_PREFIX as ROOM_PREFIX,
  BROWSER_PEER_RUNTIME_PROFILE_DOCUMENT_KEY as RUNTIME_PROFILE_DOCUMENT_KEY,
  BROWSER_PEER_STABLE_PEER_KEY as STABLE_PEER_KEY,
  BROWSER_PEER_THIN_PROFILE_DOCUMENT_KEY as THIN_PROFILE_DOCUMENT_KEY,
  BROWSER_PEER_VAULT_DATABASE_NAME,
  BROWSER_PEER_VAULT_KEY_RECORD as KEY_RECORD,
  BROWSER_PEER_VAULT_OBJECT_STORE_NAME,
  BROWSER_PEER_VAULT_VERSION as VAULT_VERSION,
  browserPeerVolatileMetadata as volatileMetadata,
} from './browser-peer-persistence-keys'

export {
  BROWSER_PEER_VAULT_DATABASE_NAME,
  clearBrowserPeerProfileMetadata,
} from './browser-peer-persistence-keys'

type PersistedProfile = Omit<WebRtcPeerConnectionProfile, 'signalingBrokers' | 'stunServers' | 'turnServers'> & {
  signalingBrokers: string[]
  stunServers?: string[]
  turnServers?: string[]
}

interface EncryptedVaultRecord {
  version: 1
  nonce: string
  ciphertext: string
  updatedAtMs: number
}

export interface BrowserPeerPersistenceStatus {
  backend: 'encrypted-indexeddb' | 'platform-keychain' | 'memory'
  secretsPersisted: boolean
  profilePersisted: boolean
  fallbackReason?: string
}

export interface BrowserVaultStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  getOrCreateCryptoKey?(key: string, candidate: CryptoKey): Promise<unknown>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  close(): Promise<void>
}

export interface BrowserPersistentPeerCredentialStoreOptions {
  storage?: BrowserVaultStorage | null
  crypto?: Crypto | null
  metadataStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  origin?: string
  now?: () => number
}

export interface BrowserWebRtcCredentialStore extends WebRtcPeerCredentialStore {
  setRoomSecret(ref: string, value: string): void
  getRoomSecret(ref: string): Promise<Uint8Array | string | null>
  saveConnectionProfile(profile: WebRtcPeerConnectionProfile): void
  loadConnectionProfile(): WebRtcPeerConnectionProfile | null
  saveThinProfileDocument(document: ThinProfileDocument): void
  loadThinProfileDocument(): ThinProfileDocument | null
  saveRuntimeProfileDocument(document: AuroraRuntimeProfileDocumentV2): void
  loadRuntimeProfileDocument(): AuroraRuntimeProfileDocumentV2 | null
  getOrCreateLocalStablePeerId(): string
  persistenceStatus(): BrowserPeerPersistenceStatus
}

/**
 * Browser credential vault for hosted thin clients.
 *
 * Secrets are AES-GCM encrypted before IndexedDB storage. The non-extractable
 * CryptoKey is itself structured-cloned into IndexedDB. This protects exported
 * database files and casual local inspection, but not an active same-origin XSS
 * that can invoke WebCrypto after the application loads.
 *
 * If WebCrypto, IndexedDB, or metadata storage is unavailable, the store fails
 * closed to memory-only behavior; it never writes plaintext secrets.
 */
export class BrowserPersistentPeerCredentialStore implements BrowserWebRtcCredentialStore {
  private readonly memory: MemoryPeerCredentialStore
  private readonly roomSecrets = new Map<string, Uint8Array>()
  private readonly cryptoImpl: Crypto | null
  private readonly storage: BrowserVaultStorage | null
  private readonly metadataStorage: BrowserPersistentPeerCredentialStoreOptions['metadataStorage']
  private readonly origin: string
  private readonly now: () => number
  private keyPromise: Promise<CryptoKey> | null = null
  private pendingWrites: Promise<void> = Promise.resolve()
  private closed = false
  private storageUsable: boolean
  private metadataUsable: boolean
  private fallbackReason: string | undefined

  constructor(options: BrowserPersistentPeerCredentialStoreOptions = {}) {
    this.cryptoImpl = options.crypto === undefined ? browserCrypto() : options.crypto
    this.storage = options.storage === undefined ? defaultVaultStorage() : options.storage
    this.metadataStorage = options.metadataStorage === undefined ? browserMetadataStorage() : options.metadataStorage
    this.origin = options.origin ?? browserOrigin()
    this.now = options.now ?? Date.now
    this.memory = new MemoryPeerCredentialStore({ now: this.now })
    this.storageUsable = this.storage !== null && this.cryptoImpl?.subtle !== undefined
    this.metadataUsable = this.metadataStorage !== null && this.metadataStorage !== undefined
    if (!this.storageUsable) this.fallbackReason = 'IndexedDB or WebCrypto is unavailable'
    if (!this.metadataUsable) this.fallbackReason ??= 'Browser metadata storage is unavailable'
  }

  persistenceStatus(): BrowserPeerPersistenceStatus {
    const secretsPersisted = this.storageUsable
    const out: BrowserPeerPersistenceStatus = {
      backend: secretsPersisted ? 'encrypted-indexeddb' : 'memory',
      secretsPersisted,
      profilePersisted: this.metadataUsable,
    }
    if (this.fallbackReason !== undefined) out.fallbackReason = this.fallbackReason
    return out
  }

  getOrCreateLocalStablePeerId(): string {
    this.assertOpen()
    const existing = this.readMetadata(STABLE_PEER_KEY)
    if (existing && /^[A-Za-z0-9._:-]{8,256}$/u.test(existing)) return existing
    const generated = `aurora-web-${randomIdentifier(this.cryptoImpl)}`
    this.writeMetadata(STABLE_PEER_KEY, generated)
    return generated
  }

  saveConnectionProfile(profile: WebRtcPeerConnectionProfile): void {
    this.assertOpen()
    const normalized = normalizeProfile(profile)
    this.writeMetadata(PROFILE_KEY, JSON.stringify(normalized))
  }

  loadConnectionProfile(): WebRtcPeerConnectionProfile | null {
    this.assertOpen()
    const encoded = this.readMetadata(PROFILE_KEY)
    if (!encoded) return null
    try {
      return normalizeProfile(JSON.parse(encoded))
    } catch {
      this.removeMetadata(PROFILE_KEY)
      return null
    }
  }

  saveThinProfileDocument(document: ThinProfileDocument): void {
    this.assertOpen()
    this.saveRuntimeProfileDocument(migrateThinProfileDocumentToRuntime(document))
  }

  loadThinProfileDocument(): ThinProfileDocument | null {
    this.assertOpen()
    const runtimeDocument = this.loadRuntimeProfileDocument()
    if (runtimeDocument) {
      try {
        return runtimeProfileDocumentToThinDocument(runtimeDocument)
      } catch {
        return null
      }
    }
    const encoded = this.readMetadata(THIN_PROFILE_DOCUMENT_KEY)
    if (!encoded) return null
    const parsed = parseThinProfileDocument(encoded)
    if (parsed) return parsed
    this.removeMetadata(THIN_PROFILE_DOCUMENT_KEY)
    return null
  }

  saveRuntimeProfileDocument(document: AuroraRuntimeProfileDocumentV2): void {
    this.assertOpen()
    this.writeMetadata(RUNTIME_PROFILE_DOCUMENT_KEY, serializeRuntimeProfileDocument(document))
    this.removeMetadata(THIN_PROFILE_DOCUMENT_KEY)
  }

  loadRuntimeProfileDocument(): AuroraRuntimeProfileDocumentV2 | null {
    this.assertOpen()
    const encoded = this.readMetadata(RUNTIME_PROFILE_DOCUMENT_KEY)
    if (encoded) {
      const parsed = parseRuntimeProfileDocument(encoded)
      if (parsed) return parsed
      this.removeMetadata(RUNTIME_PROFILE_DOCUMENT_KEY)
      return null
    }
    const legacy = this.readMetadata(THIN_PROFILE_DOCUMENT_KEY)
    if (!legacy) return null
    const parsed = parseRuntimeProfileDocument(legacy)
    if (!parsed) {
      this.removeMetadata(THIN_PROFILE_DOCUMENT_KEY)
      return null
    }
    if (this.metadataUsable) {
      this.writeMetadata(RUNTIME_PROFILE_DOCUMENT_KEY, serializeRuntimeProfileDocument(parsed))
      this.removeMetadata(THIN_PROFILE_DOCUMENT_KEY)
    }
    return parsed
  }

  setRoomSecret(ref: string, value: string): void {
    this.assertOpen()
    assertStorageKey('room secret reference', ref)
    if (!value) throw new Error('Room secret must not be empty')
    const bytes = new TextEncoder().encode(value)
    const previous = this.roomSecrets.get(ref)
    previous?.fill(0)
    this.roomSecrets.set(ref, bytes)
    this.enqueueWrite(async () => {
      await this.writeEncrypted(`${ROOM_PREFIX}${ref}`, { value })
    })
  }

  async getRoomSecret(ref: string): Promise<Uint8Array | null> {
    this.assertOpen()
    assertStorageKey('room secret reference', ref)
    const memory = this.roomSecrets.get(ref)
    if (memory !== undefined) return new Uint8Array(memory)
    await this.pendingWrites
    const persisted = await this.readEncrypted<{ value?: unknown }>(`${ROOM_PREFIX}${ref}`)
    if (typeof persisted?.value !== 'string' || persisted.value.length === 0) return null
    const bytes = new TextEncoder().encode(persisted.value)
    this.roomSecrets.set(ref, bytes)
    return new Uint8Array(bytes)
  }

  async get(peerId: string): Promise<StoredPeerCredentialMetadata | undefined> {
    this.assertOpen()
    assertStorageKey('peer ID', peerId, 256)
    const memory = await this.memory.get(peerId)
    if (memory !== undefined) return memory
    await this.hydrateCredential(peerId)
    return await this.memory.get(peerId)
  }

  async status(peerId: string): Promise<PeerCredentialStatus> {
    this.assertOpen()
    const credential = await this.get(peerId)
    const persistence = this.persistenceStatus()
    return {
      peerId,
      found: credential !== undefined,
      hasBearerToken: credential !== undefined,
      credential,
      backend: persistence.backend,
      persisted: persistence.secretsPersisted,
      secretsRedacted: true,
      redactedFields: ['rawBearerToken'],
    }
  }

  async save(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata> {
    this.assertOpen()
    assertStorageKey('peer ID', peerId, 256)
    const stored = await this.memory.save(peerId, credential)
    await this.persistSafely(`${CREDENTIAL_PREFIX}${peerId}`, credential)
    return stored
  }

  async prove(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    return await this.createReconnectProof(peerId, challenge)
  }

  async createReconnectProof(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    this.assertOpen()
    assertStorageKey('peer ID', peerId, 256)
    await this.hydrateCredential(peerId)
    return await this.memory.createReconnectProof(peerId, challenge)
  }

  async remove(peerId: string): Promise<void> {
    this.assertOpen()
    assertStorageKey('peer ID', peerId, 256)
    await this.memory.remove(peerId)
    await this.deleteSafely(`${CREDENTIAL_PREFIX}${peerId}`)
  }

  async getOpaqueSecret(key: string): Promise<string | undefined> {
    this.assertOpen()
    const storageKey = normalizeInboundVerifierSecretKey(key)
    const persisted = await this.readEncryptedRequired<{ value?: unknown }>(storageKey)
    if (persisted === undefined) return undefined
    if (typeof persisted.value !== 'string') throw new Error('Persistent inbound verifier secret is unreadable')
    return persisted.value
  }

  async setOpaqueSecret(key: string, value: string): Promise<void> {
    this.assertOpen()
    const storageKey = normalizeInboundVerifierSecretKey(key)
    if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) throw new Error('Invalid inbound verifier secret value')
    await this.writeEncryptedRequired(storageKey, { value })
  }

  async deleteOpaqueSecret(key: string): Promise<void> {
    this.assertOpen()
    const storageKey = normalizeInboundVerifierSecretKey(key)
    await this.deleteEncryptedRequired(storageKey)
  }

  async clear(): Promise<void> {
    this.assertOpen()
    for (const secret of this.roomSecrets.values()) secret.fill(0)
    this.roomSecrets.clear()
    await this.memory.clear()
    await this.pendingWrites
    let vaultClearError: unknown
    if (this.storage !== null) {
      let keys: string[] = []
      try {
        keys = await this.storage.keys()
      } catch (error) {
        this.fallbackToMemory(error)
        vaultClearError = error
      }
      const deleteErrors: unknown[] = []
      for (const key of keys) {
        try {
          await this.storage.delete(key)
        } catch (error) {
          deleteErrors.push(error)
        }
      }
      if (deleteErrors.length > 0) {
        const error = deleteErrors[0]
        this.fallbackToMemory(error)
        vaultClearError = error
      } else if (vaultClearError === undefined) {
        this.keyPromise = null
      }
    }
    this.removeMetadata(PROFILE_KEY)
    this.removeMetadata(THIN_PROFILE_DOCUMENT_KEY)
    this.removeMetadata(RUNTIME_PROFILE_DOCUMENT_KEY)
    this.removeMetadata(STABLE_PEER_KEY)
    if (vaultClearError !== undefined) {
      throw vaultClearError
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.pendingWrites
    for (const secret of this.roomSecrets.values()) secret.fill(0)
    this.roomSecrets.clear()
    await this.memory.close()
    await this.storage?.close()
    this.closed = true
  }

  private async hydrateCredential(peerId: string): Promise<void> {
    if (await this.memory.get(peerId) !== undefined) return
    const record = await this.readEncrypted<MeshPeerCredentialRecord>(`${CREDENTIAL_PREFIX}${peerId}`)
    if (record === null) return
    try {
      await this.memory.save(peerId, record)
    } catch {
      await this.deleteSafely(`${CREDENTIAL_PREFIX}${peerId}`)
    }
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.pendingWrites = this.pendingWrites.then(write).catch((error) => {
      this.fallbackToMemory(error)
    })
  }

  private async persistSafely(key: string, value: unknown): Promise<void> {
    try {
      await this.pendingWrites
      await this.writeEncrypted(key, value)
    } catch (error) {
      this.fallbackToMemory(error)
    }
  }

  private async deleteSafely(key: string): Promise<void> {
    if (!this.storageUsable || this.storage === null) return
    try {
      await this.pendingWrites
      await this.storage.delete(key)
    } catch (error) {
      this.fallbackToMemory(error)
    }
  }

  private async writeEncrypted(key: string, value: unknown): Promise<void> {
    if (!this.storageUsable || this.storage === null || this.cryptoImpl === null) return
    const cryptoKey = await this.vaultKey()
    const nonce = new Uint8Array(12)
    this.cryptoImpl.getRandomValues(nonce)
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
    try {
      const ciphertext = await this.cryptoImpl.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: this.aad(key) },
        cryptoKey,
        plaintext,
      )
      const record: EncryptedVaultRecord = {
        version: VAULT_VERSION,
        nonce: toBase64Url(nonce),
        ciphertext: toBase64Url(new Uint8Array(ciphertext)),
        updatedAtMs: this.now(),
      }
      await this.storage.set(key, record)
    } finally {
      plaintext.fill(0)
    }
  }

  private async readEncrypted<T>(key: string): Promise<T | null> {
    if (!this.storageUsable || this.storage === null || this.cryptoImpl === null) return null
    try {
      const value = await this.storage.get(key)
      if (!isEncryptedVaultRecord(value)) return null
      const plaintext = new Uint8Array(await this.cryptoImpl.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(value.nonce), additionalData: this.aad(key) },
        await this.vaultKey(),
        fromBase64Url(value.ciphertext),
      ))
      try {
        return JSON.parse(new TextDecoder().decode(plaintext)) as T
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      this.fallbackToMemory(error)
      return null
    }
  }

  private async writeEncryptedRequired(key: string, value: unknown): Promise<void> {
    try {
      this.assertDurableInboundVerifierStorage()
      await this.pendingWrites
      this.assertDurableInboundVerifierStorage()
      const storage = this.storage!
      const cryptoImpl = this.cryptoImpl!
      const cryptoKey = await this.vaultKey()
      const nonce = new Uint8Array(12)
      cryptoImpl.getRandomValues(nonce)
      const plaintext = new TextEncoder().encode(JSON.stringify(value))
      try {
        const ciphertext = await cryptoImpl.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: this.aad(key) },
          cryptoKey,
          plaintext,
        )
        const record: EncryptedVaultRecord = {
          version: VAULT_VERSION,
          nonce: toBase64Url(nonce),
          ciphertext: toBase64Url(new Uint8Array(ciphertext)),
          updatedAtMs: this.now(),
        }
        await storage.set(key, record)
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      this.fallbackToMemory(error)
      throw error
    }
  }

  private async readEncryptedRequired<T>(key: string): Promise<T | undefined> {
    this.assertDurableInboundVerifierStorage()
    try {
      await this.pendingWrites
      this.assertDurableInboundVerifierStorage()
      const value = await this.storage!.get(key)
      if (value === undefined || value === null) return undefined
      if (!isEncryptedVaultRecord(value)) throw new Error('Persistent inbound verifier secret is unreadable')
      const plaintext = new Uint8Array(await this.cryptoImpl!.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(value.nonce), additionalData: this.aad(key) },
        await this.vaultKey(),
        fromBase64Url(value.ciphertext),
      ))
      try {
        return JSON.parse(new TextDecoder().decode(plaintext)) as T
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      this.fallbackToMemory(error)
      throw error
    }
  }

  private async deleteEncryptedRequired(key: string): Promise<void> {
    this.assertDurableInboundVerifierStorage()
    try {
      await this.pendingWrites
      await this.storage!.delete(key)
    } catch (error) {
      this.fallbackToMemory(error)
      throw error
    }
  }

  private async vaultKey(): Promise<CryptoKey> {
    if (this.keyPromise !== null) return await this.keyPromise
    if (this.storage === null || this.cryptoImpl === null) throw new Error('Persistent browser vault is unavailable')
    this.keyPromise = (async () => {
      const existing = await this.storage!.get(KEY_RECORD)
      if (isAesGcmCryptoKey(existing)) return existing
      const generated = await this.cryptoImpl!.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
      const stored = this.storage!.getOrCreateCryptoKey === undefined
        ? await storeGeneratedKey(this.storage!, generated)
        : await this.storage!.getOrCreateCryptoKey(KEY_RECORD, generated)
      if (!isAesGcmCryptoKey(stored)) throw new Error('IndexedDB returned an invalid vault key')
      return stored
    })()
    return await this.keyPromise
  }

  private aad(key: string): Uint8Array {
    return new TextEncoder().encode(`aurora-web-thin-vault|${VAULT_VERSION}|${this.origin}|${key}`)
  }

  private fallbackToMemory(error: unknown): void {
    this.storageUsable = false
    this.keyPromise = null
    this.fallbackReason = error instanceof Error ? `Persistent vault unavailable: ${error.message}` : 'Persistent vault unavailable'
  }

  private readMetadata(key: string): string | null {
    const fallback = volatileMetadata.get(this.volatileMetadataKey(key)) ?? null
    if (!this.metadataUsable || this.metadataStorage == null) return fallback
    try {
      const persisted = this.metadataStorage.getItem(key)
      return persisted ?? fallback
    } catch (error) {
      this.fallbackMetadataToMemory(error)
      return fallback
    }
  }

  private writeMetadata(key: string, value: string): void {
    if (!this.metadataUsable || this.metadataStorage == null) {
      volatileMetadata.set(this.volatileMetadataKey(key), value)
      return
    }
    try {
      this.metadataStorage.setItem(key, value)
    } catch (error) {
      this.fallbackMetadataToMemory(error)
      volatileMetadata.set(this.volatileMetadataKey(key), value)
    }
  }

  private removeMetadata(key: string): void {
    volatileMetadata.delete(this.volatileMetadataKey(key))
    if (!this.metadataUsable || this.metadataStorage == null) return
    try {
      this.metadataStorage.removeItem(key)
    } catch (error) {
      this.fallbackMetadataToMemory(error)
    }
  }

  private fallbackMetadataToMemory(error: unknown): void {
    this.metadataUsable = false
    // Persisting secrets without the stable peer ID/profile needed to address
    // them after reload would create an unusable, misleading partial state.
    this.storageUsable = false
    this.keyPromise = null
    this.fallbackReason = error instanceof Error
      ? `Metadata storage unavailable: ${error.message}`
      : 'Metadata storage unavailable'
  }

  private volatileMetadataKey(key: string): string {
    return `${this.origin}|${key}`
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Browser peer credential store is closed')
  }

  private assertDurableInboundVerifierStorage(): void {
    if (!this.storageUsable || this.storage === null || this.cryptoImpl === null || this.cryptoImpl.subtle === undefined) {
      throw new Error('Persistent inbound verifier storage is unavailable')
    }
  }
}

export class IndexedDbBrowserVaultStorage implements BrowserVaultStorage {
  private readonly databaseName: string
  private readonly objectStoreName: string
  private readonly factory: IDBFactory
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(options: { indexedDB?: IDBFactory; databaseName?: string; objectStoreName?: string } = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB
    if (!factory) throw new Error('IndexedDB is unavailable')
    this.factory = factory
    this.databaseName = options.databaseName ?? BROWSER_PEER_VAULT_DATABASE_NAME
    this.objectStoreName = options.objectStoreName ?? BROWSER_PEER_VAULT_OBJECT_STORE_NAME
  }

  async get(key: string): Promise<unknown> {
    return await this.request('readonly', (store) => store.get(key))
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.request('readwrite', (store) => store.put(value, key))
  }

  async getOrCreateCryptoKey(key: string, candidate: CryptoKey): Promise<unknown> {
    const database = await this.database()
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, 'readwrite')
      const store = transaction.objectStore(this.objectStoreName)
      const request = store.get(key)
      let selected: unknown
      request.onsuccess = () => {
        if (isAesGcmCryptoKey(request.result)) {
          selected = request.result
          return
        }
        selected = candidate
        store.put(candidate, key)
      }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB vault-key read failed'))
      transaction.oncomplete = () => resolve(selected)
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB vault-key transaction failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB vault-key transaction aborted'))
    })
  }

  async delete(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(key))
  }

  async keys(): Promise<string[]> {
    const keys = await this.request('readonly', (store) => store.getAllKeys())
    return (keys as IDBValidKey[]).filter((key): key is string => typeof key === 'string')
  }

  async close(): Promise<void> {
    if (this.databasePromise !== null) (await this.databasePromise).close()
    this.databasePromise = null
  }

  private async request<T>(
    mode: IDBTransactionMode,
    build: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.database()
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, mode)
      const request = build(transaction.objectStore(this.objectStoreName))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    })
  }

  private async database(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) return await this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.objectStoreName)) {
          request.result.createObjectStore(this.objectStoreName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB vault'))
      request.onblocked = () => reject(new Error('IndexedDB vault upgrade is blocked'))
    })
    return await this.databasePromise
  }
}

function defaultVaultStorage(): BrowserVaultStorage | null {
  try {
    return typeof globalThis.indexedDB === 'undefined' ? null : new IndexedDbBrowserVaultStorage()
  } catch {
    return null
  }
}

function browserCrypto(): Crypto | null {
  return typeof globalThis.crypto === 'undefined' ? null : globalThis.crypto
}

function browserMetadataStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function browserOrigin(): string {
  return typeof window === 'undefined' ? 'ssr' : window.location.origin
}

function randomIdentifier(cryptoImpl: Crypto | null): string {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoImpl?.getRandomValues(bytes)
  if (bytes.some((value) => value !== 0)) return toBase64Url(bytes)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function assertStorageKey(name: string, value: string, maxLength = 1024): void {
  if (!value || value.length > maxLength) throw new Error(`Invalid ${name}`)
}

function normalizeInboundVerifierSecretKey(key: string): string {
  if (!key.startsWith(INBOUND_VERIFIER_KEY_PREFIX) || key.length > 8192) throw new Error('Invalid inbound verifier secret key')
  const parts = key.split(':')
  if (parts.length !== 5 || parts[0] !== INBOUND_VERIFIER_PREFIX) throw new Error('Invalid inbound verifier secret key')
  const encodedLimits = [768, 768, 4096, 768]
  const decodedLimits = [256, 256, 512, 256]
  for (const [index, part] of parts.slice(1).entries()) {
    if (part.length === 0 || part.length > encodedLimits[index]!) throw new Error('Invalid inbound verifier secret key')
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      throw new Error('Invalid inbound verifier secret key')
    }
    if (decoded.length === 0 || decoded.length > decodedLimits[index]!) throw new Error('Invalid inbound verifier secret key')
    if (index !== 2 && !/^[A-Za-z0-9_.:@/-]+$/u.test(decoded)) throw new Error('Invalid inbound verifier secret key')
    if (encodeInboundVerifierKeyPart(decoded) !== part) throw new Error('Invalid inbound verifier secret key')
  }
  return key
}

function encodeInboundVerifierKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/\./gu, '%2E')
}

function normalizeProfile(value: unknown): PersistedProfile {
  if (!isRecord(value)) throw new Error('Invalid persisted WebRTC profile')
  const mode = value.mode
  const appId = stringField(value, 'appId', 256)
  const room = stringField(value, 'room', 512)
  const roomSecretRef = stringField(value, 'roomSecretRef', 1024)
  const signalingBrokers = stringArrayField(value, 'signalingBrokers', 16)
  for (const broker of signalingBrokers) assertSafeSignalingBroker(broker)
  if (mode !== 'webrtc-only' && mode !== 'webrtc-preferred') throw new Error('Invalid persisted WebRTC mode')
  const out: PersistedProfile = { mode, appId, room, roomSecretRef, signalingBrokers }
  copyOptionalString(value, out, 'expectedStablePeerId', 256)
  copyOptionalString(value, out, 'expectedSignalingPeerId', 256)
  copyOptionalString(value, out, 'nodeName', 256)
  copyOptionalBoolean(value, out, 'production')
  copyOptionalBoolean(value, out, 'allowInsecureLoopbackSignaling')
  copyOptionalBoolean(value, out, 'requireAppLayerE2ee')
  const stunServers = optionalStringArray(value, 'stunServers', 16)
  const turnServers = optionalStringArray(value, 'turnServers', 16)
  if (stunServers !== undefined) {
    for (const server of stunServers) assertSafeIceServer(server, 'stun')
    out.stunServers = stunServers
  }
  if (turnServers !== undefined) {
    for (const server of turnServers) assertSafeIceServer(server, 'turn')
    out.turnServers = turnServers
  }
  return out
}

function stringField(value: Record<string, unknown>, key: string, maxLength: number): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0 || field.length > maxLength) throw new Error(`Invalid persisted WebRTC ${key}`)
  return field
}

function stringArrayField(value: Record<string, unknown>, key: string, maxItems: number): string[] {
  const field = value[key]
  if (!Array.isArray(field) || field.length === 0 || field.length > maxItems || field.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2048)) {
    throw new Error(`Invalid persisted WebRTC ${key}`)
  }
  return [...field]
}

function optionalStringArray(value: Record<string, unknown>, key: string, maxItems: number): string[] | undefined {
  if (value[key] === undefined) return undefined
  const field = value[key]
  if (!Array.isArray(field) || field.length > maxItems || field.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2048)) {
    throw new Error(`Invalid persisted WebRTC ${key}`)
  }
  return [...field] as string[]
}

function assertSafeSignalingBroker(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid persisted WebRTC signaling broker')
  }
  if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') return
  throw new Error('Invalid persisted WebRTC signaling broker')
}

function assertSafeIceServer(value: string, kind: 'stun' | 'turn'): void {
  const scheme = value.slice(0, value.indexOf(':')).toLowerCase()
  const allowed = kind === 'stun' ? ['stun', 'stuns'] : ['turn', 'turns']
  if (!allowed.includes(scheme)) throw new Error(`Invalid persisted WebRTC ${kind} server`)
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`Invalid persisted WebRTC ${key}`)
  target[key] = value
}

function copyOptionalBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') throw new Error(`Invalid persisted WebRTC ${key}`)
  target[key] = value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEncryptedVaultRecord(value: unknown): value is EncryptedVaultRecord {
  return isRecord(value) &&
    value.version === VAULT_VERSION &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.updatedAtMs === 'number'
}

function isAesGcmCryptoKey(value: unknown): value is CryptoKey {
  if (!isRecord(value)) return false
  const algorithm = value.algorithm
  const usages = value.usages
  return isRecord(algorithm) &&
    algorithm.name === 'AES-GCM' &&
    value.extractable === false &&
    Array.isArray(usages) &&
    usages.includes('encrypt') &&
    usages.includes('decrypt')
}

async function storeGeneratedKey(storage: BrowserVaultStorage, generated: CryptoKey): Promise<unknown> {
  await storage.set(KEY_RECORD, generated)
  return generated
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
