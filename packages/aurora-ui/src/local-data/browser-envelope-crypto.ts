import {
  LocalDataError,
  parseEncryptedDataEnvelopeV1,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose
} from '@aurora/client/local-data'

const AES_GCM_NONCE_BYTES = 12
const AES_GCM_TAG_BITS = 128
const AES_GCM_KEY_BITS = 256
const ENVELOPE_KEY_STORE = 'keys'
const ENVELOPE_METADATA_STORE = 'metadata'
const ENVELOPE_METADATA_TYPE = 'aurora.local-data.envelope-key-metadata.v1'
const ENVELOPE_KEY_ID_PREFIX = 'aurora-local-data-envelope'
const VALID_LOCAL_DATA_KEY_PURPOSES = new Set<LocalDataKeyPurpose>(['local-structured-data'])

export interface BrowserEnvelopeCryptoPortOptions {
  readonly origin?: string
  readonly profileId: string
  readonly localNodeId: string
  readonly indexedDB?: IDBFactory
  readonly crypto?: Crypto
  readonly nowMs?: () => number
}

interface BrowserEnvelopeCryptoKeyStore {
  getActiveKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    nowMs: number,
  ): Promise<BrowserEnvelopeSelectedKey>
  getKey(scope: BrowserEnvelopeKeyScope, keyId: string): Promise<CryptoKey | null>
  rotateKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    nowMs: number,
  ): Promise<{ previousKeyId: string; newKeyId: string }>
  close(): Promise<void>
}

interface BrowserEnvelopeKeyScope {
  readonly origin: string
  readonly profileId: string
  readonly localNodeId: string
  readonly keyPurpose: LocalDataKeyPurpose
  readonly scopeKey: string
}

interface BrowserEnvelopeSelectedKey {
  readonly keyId: string
  readonly key: CryptoKey
}

interface StoredBrowserEnvelopeKeyMetadataV1 {
  readonly type: typeof ENVELOPE_METADATA_TYPE
  readonly formatVersion: 1
  readonly scopeKey: string
  readonly origin: string
  readonly profileId: string
  readonly localNodeId: string
  readonly keyPurpose: LocalDataKeyPurpose
  readonly activeVersion: number
  readonly activeKeyId: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export class BrowserEnvelopeCryptoPort implements EnvelopeCryptoPort {
  #keyStore: BrowserEnvelopeCryptoKeyStore
  private readonly origin: string
  private readonly profileId: string
  private readonly localNodeId: string
  private readonly cryptoImpl: Crypto
  private readonly nowMs: () => number
  private operationQueue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: BrowserEnvelopeCryptoPortOptions) {
    this.origin = canonicalOrigin(options.origin)
    this.profileId = parseIdentitySegment(options.profileId, 'identity.profile')
    this.localNodeId = parseIdentitySegment(options.localNodeId, 'identity.local_node')
    const cryptoImpl = options.crypto ?? globalThis.crypto
    if (!isUsableCrypto(cryptoImpl)) {
      throw new LocalDataError('unsupported_backend', 'Browser local data encryption is unavailable', { reason: 'webcrypto_unavailable' })
    }
    this.cryptoImpl = cryptoImpl
    this.#keyStore = new IndexedDbBrowserEnvelopeCryptoKeyStore({
      ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
      databaseName: deriveBrowserEnvelopeCryptoDatabaseName(this.origin, this.localNodeId)
    })
    this.nowMs = options.nowMs ?? (() => Date.now())
  }

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    return await this.enqueue(async () => {
      this.assertOpen()
      assertSupportedKeyPurpose(keyPurpose)
      const scope = this.scope(keyPurpose)
      const selected = await this.#keyStore.getActiveKey(scope, () => this.generateKey(), this.nowMs())
      const nonce = new Uint8Array(AES_GCM_NONCE_BYTES)
      this.cryptoImpl.getRandomValues(nonce)
      const ciphertextAndTag = new Uint8Array(await this.cryptoImpl.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: AES_GCM_TAG_BITS },
        selected.key,
        plaintext,
      ))
      return parseEncryptedDataEnvelopeV1({
        version: 1,
        algorithm: 'AES-GCM-256',
        keyId: selected.keyId,
        nonceB64Url: toBase64Url(nonce),
        ciphertextAndTagB64Url: toBase64Url(ciphertextAndTag),
        createdAtMs: this.nowMs()
      })
    })
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    return await this.enqueue(async () => {
      this.assertOpen()
      const parsed = parseEncryptedDataEnvelopeV1(envelope)
      const scope = scopeFromKeyId(parsed.keyId, this.origin, this.profileId, this.localNodeId)
      const key = await this.#keyStore.getKey(scope, parsed.keyId)
      if (key === null) {
        throw new LocalDataError('invalid_record', 'Local data envelope key is unavailable', { reason: 'missing_key' })
      }
      try {
        return new Uint8Array(await this.cryptoImpl.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64Url(parsed.nonceB64Url),
            additionalData: aad,
            tagLength: AES_GCM_TAG_BITS
          },
          key,
          fromBase64Url(parsed.ciphertextAndTagB64Url),
        ))
      } catch {
        throw new LocalDataError('invalid_record', 'Local data envelope could not be opened', { reason: 'decryption_failed' })
      }
    })
  }

  async rotateKey(keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return await this.enqueue(async () => {
      this.assertOpen()
      assertSupportedKeyPurpose(keyPurpose)
      return await this.#keyStore.rotateKey(this.scope(keyPurpose), () => this.generateKey(), this.nowMs())
    })
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) return
      this.closed = true
      await this.#keyStore.close()
    })
  }

  private async enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await work()
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return await result
  }

  private scope(keyPurpose: LocalDataKeyPurpose): BrowserEnvelopeKeyScope {
    return buildBrowserEnvelopeKeyScope({
      origin: this.origin,
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      keyPurpose
    })
  }

  private async generateKey(): Promise<CryptoKey> {
    return await this.cryptoImpl.subtle.generateKey(
      { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalDataError('session_closed', 'Browser local data encryption is closed')
  }
}

export function createBrowserEnvelopeCryptoPort(options: BrowserEnvelopeCryptoPortOptions): EnvelopeCryptoPort {
  return new BrowserEnvelopeCryptoPort(options)
}

class IndexedDbBrowserEnvelopeCryptoKeyStore implements BrowserEnvelopeCryptoKeyStore {
  private readonly indexedDB: IDBFactory
  private readonly databaseName: string
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(options: { indexedDB?: IDBFactory; databaseName?: string } = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!indexedDB) {
      throw new LocalDataError('unsupported_backend', 'Browser local data key vault is unavailable', { reason: 'indexeddb_unavailable' })
    }
    this.indexedDB = indexedDB
    this.databaseName = options.databaseName ?? deriveBrowserEnvelopeCryptoDatabaseName(canonicalOrigin(), 'default')
  }

  async getActiveKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    nowMs: number,
  ): Promise<BrowserEnvelopeSelectedKey> {
    const candidate = await createCandidate()
    return await this.withTransaction('readwrite', async (stores) => {
      const existing = parseStoredMetadata(await stores.getMetadata(scope.scopeKey), scope)
      if (existing !== null) {
        const key = await stores.getKey(existing.activeKeyId)
        if (!isAesGcm256Key(key)) {
          throw new LocalDataError('invalid_record', 'Browser local data envelope key is invalid', { reason: 'invalid_key' })
        }
        return { keyId: existing.activeKeyId, key }
      }
      const keyId = keyIdForVersion(scope, 1)
      const metadata = createStoredMetadata(scope, 1, keyId, nowMs, nowMs)
      await stores.putKey(keyId, candidate)
      await stores.putMetadata(scope.scopeKey, metadata)
      return { keyId, key: candidate }
    })
  }

  async getKey(scope: BrowserEnvelopeKeyScope, keyId: string): Promise<CryptoKey | null> {
    if (!keyIdBelongsToScope(keyId, scope)) return null
    return await this.withTransaction('readonly', async (stores) => {
      const key = await stores.getKey(keyId)
      if (key === undefined) return null
      if (!isAesGcm256Key(key)) {
        throw new LocalDataError('invalid_record', 'Browser local data envelope key is invalid', { reason: 'invalid_key' })
      }
      return key
    })
  }

  async rotateKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    nowMs: number,
  ): Promise<{ previousKeyId: string; newKeyId: string }> {
    const candidate = await createCandidate()
    return await this.withTransaction('readwrite', async (stores) => {
      const existing = parseStoredMetadata(await stores.getMetadata(scope.scopeKey), scope)
      if (existing === null) {
        const keyId = keyIdForVersion(scope, 1)
        await stores.putKey(keyId, candidate)
        await stores.putMetadata(scope.scopeKey, createStoredMetadata(scope, 1, keyId, nowMs, nowMs))
        return { previousKeyId: keyId, newKeyId: keyId }
      }
      const previousKey = await stores.getKey(existing.activeKeyId)
      if (!isAesGcm256Key(previousKey)) {
        throw new LocalDataError('invalid_record', 'Browser local data envelope key is invalid', { reason: 'invalid_key' })
      }
      const nextVersion = existing.activeVersion + 1
      const nextKeyId = keyIdForVersion(scope, nextVersion)
      await stores.putKey(nextKeyId, candidate)
      await stores.putMetadata(scope.scopeKey, {
        ...existing,
        activeVersion: nextVersion,
        activeKeyId: nextKeyId,
        updatedAtMs: nowMs
      })
      return { previousKeyId: existing.activeKeyId, newKeyId: nextKeyId }
    })
  }

  async close(): Promise<void> {
    if (this.databasePromise !== null) (await this.databasePromise).close()
    this.databasePromise = null
  }

  private async withTransaction<T>(
    mode: IDBTransactionMode,
    work: (stores: BrowserEnvelopeTransactionStores) => Promise<T>,
  ): Promise<T> {
    const database = await this.database()
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction([ENVELOPE_KEY_STORE, ENVELOPE_METADATA_STORE], mode)
      const stores = new BrowserEnvelopeTransactionStores(
        transaction.objectStore(ENVELOPE_KEY_STORE),
        transaction.objectStore(ENVELOPE_METADATA_STORE),
      )
      let result: T
      let rejected = false
      void work(stores).then(
        (value) => {
          result = value
        },
        (error: unknown) => {
          rejected = true
          transaction.abort()
          reject(error)
        },
      )
      transaction.oncomplete = () => {
        if (!rejected) resolve(result)
      }
      transaction.onerror = () => {
        if (!rejected) reject(transaction.error ?? new Error('Browser local data key vault transaction failed'))
      }
      transaction.onabort = () => {
        if (!rejected) reject(transaction.error ?? new Error('Browser local data key vault transaction aborted'))
      }
    })
  }

  private async database(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) return await this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(ENVELOPE_KEY_STORE)) request.result.createObjectStore(ENVELOPE_KEY_STORE)
        if (!request.result.objectStoreNames.contains(ENVELOPE_METADATA_STORE)) request.result.createObjectStore(ENVELOPE_METADATA_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Browser local data key vault open failed'))
      request.onblocked = () => reject(new Error('Browser local data key vault upgrade blocked'))
    })
    return await this.databasePromise
  }
}

class BrowserEnvelopeTransactionStores {
  constructor(
    private readonly keyStore: IDBObjectStore,
    private readonly metadataStore: IDBObjectStore,
  ) {}

  async getMetadata(scopeKey: string): Promise<unknown> {
    return await idbRequest(this.metadataStore.get(scopeKey))
  }

  async putMetadata(scopeKey: string, value: StoredBrowserEnvelopeKeyMetadataV1): Promise<void> {
    await idbRequest(this.metadataStore.put(value, scopeKey))
  }

  async getKey(keyId: string): Promise<unknown> {
    return await idbRequest(this.keyStore.get(keyId))
  }

  async putKey(keyId: string, key: CryptoKey): Promise<void> {
    await idbRequest(this.keyStore.put(key, keyId))
  }
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser local data key vault request failed'))
  })
}

function deriveBrowserEnvelopeCryptoDatabaseName(origin: string | undefined, localNodeId: string): string {
  return `${ENVELOPE_KEY_ID_PREFIX}-${stableHash(`${canonicalOrigin(origin)}\u0000${localNodeId}`)}`
}

function buildBrowserEnvelopeKeyScope(input: {
  origin: string
  profileId: string
  localNodeId: string
  keyPurpose: LocalDataKeyPurpose
}): BrowserEnvelopeKeyScope {
  assertSupportedKeyPurpose(input.keyPurpose)
  const origin = canonicalOrigin(input.origin)
  const profileId = parseIdentitySegment(input.profileId, 'identity.profile')
  const localNodeId = parseIdentitySegment(input.localNodeId, 'identity.local_node')
  const scopeKey = stableHash(`${origin}\u0000${localNodeId}\u0000${profileId}\u0000${input.keyPurpose}`)
  return {
    origin,
    profileId,
    localNodeId,
    keyPurpose: input.keyPurpose,
    scopeKey
  }
}

function scopeFromKeyId(
  keyId: string,
  origin: string,
  profileId: string,
  localNodeId: string,
): BrowserEnvelopeKeyScope {
  const match = /^aurora-local-data-envelope\.([a-z0-9-]+)\.([a-f0-9]{16})\.v[1-9][0-9]*$/u.exec(keyId)
  if (match === null) {
    throw new LocalDataError('invalid_record', 'Local data envelope key is invalid', { reason: 'invalid_key_id' })
  }
  const keyPurpose = match[1] as LocalDataKeyPurpose
  assertSupportedKeyPurpose(keyPurpose)
  const scope = buildBrowserEnvelopeKeyScope({ origin, profileId, localNodeId, keyPurpose })
  if (match[2] !== scope.scopeKey) {
    throw new LocalDataError('invalid_record', 'Local data envelope key is unavailable', { reason: 'missing_key' })
  }
  return scope
}

function keyIdForVersion(scope: BrowserEnvelopeKeyScope, version: number): string {
  return `${ENVELOPE_KEY_ID_PREFIX}.${scope.keyPurpose}.${scope.scopeKey}.v${version}`
}

function keyIdBelongsToScope(keyId: string, scope: BrowserEnvelopeKeyScope): boolean {
  return keyId.startsWith(`${ENVELOPE_KEY_ID_PREFIX}.${scope.keyPurpose}.${scope.scopeKey}.v`)
}

function createStoredMetadata(
  scope: BrowserEnvelopeKeyScope,
  activeVersion: number,
  activeKeyId: string,
  createdAtMs: number,
  updatedAtMs: number,
): StoredBrowserEnvelopeKeyMetadataV1 {
  return {
    type: ENVELOPE_METADATA_TYPE,
    formatVersion: 1,
    scopeKey: scope.scopeKey,
    origin: scope.origin,
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
    keyPurpose: scope.keyPurpose,
    activeVersion,
    activeKeyId,
    createdAtMs,
    updatedAtMs
  }
}

function parseStoredMetadata(value: unknown, scope: BrowserEnvelopeKeyScope): StoredBrowserEnvelopeKeyMetadataV1 | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) ||
    value.type !== ENVELOPE_METADATA_TYPE ||
    value.formatVersion !== 1 ||
    value.scopeKey !== scope.scopeKey ||
    value.origin !== scope.origin ||
    value.profileId !== scope.profileId ||
    value.localNodeId !== scope.localNodeId ||
    value.keyPurpose !== scope.keyPurpose ||
    typeof value.activeVersion !== 'number' ||
    !Number.isSafeInteger(value.activeVersion) ||
    value.activeVersion < 1 ||
    typeof value.activeKeyId !== 'string' ||
    value.activeKeyId !== keyIdForVersion(scope, value.activeVersion) ||
    typeof value.createdAtMs !== 'number' ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    typeof value.updatedAtMs !== 'number' ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs) {
    throw new LocalDataError('invalid_record', 'Browser local data envelope metadata is invalid', {
      boundaryId: 'envelope.key.metadata',
      validation: 'redacted'
    })
  }
  return value as unknown as StoredBrowserEnvelopeKeyMetadataV1
}

function assertSupportedKeyPurpose(keyPurpose: LocalDataKeyPurpose): void {
  if (!VALID_LOCAL_DATA_KEY_PURPOSES.has(keyPurpose)) {
    throw new LocalDataError('invalid_record', 'Local data envelope key purpose is invalid', { reason: 'invalid_key_purpose' })
  }
}

function parseIdentitySegment(value: string, boundaryId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) return value
  throw new LocalDataError('invalid_record', `Invalid local data boundary: ${boundaryId}`, {
    boundaryId,
    validation: 'redacted'
  })
}

function isUsableCrypto(value: Crypto | undefined): value is Crypto {
  return value !== undefined &&
    typeof value.getRandomValues === 'function' &&
    value.subtle !== undefined &&
    typeof value.subtle.generateKey === 'function' &&
    typeof value.subtle.encrypt === 'function' &&
    typeof value.subtle.decrypt === 'function'
}

function isAesGcm256Key(value: unknown): value is CryptoKey {
  if (!isRecord(value)) return false
  const algorithm = value.algorithm
  return isRecord(algorithm) &&
    algorithm.name === 'AES-GCM' &&
    algorithm.length === AES_GCM_KEY_BITS &&
    value.extractable === false &&
    Array.isArray(value.usages) &&
    value.usages.includes('encrypt') &&
    value.usages.includes('decrypt')
}

function canonicalOrigin(origin: string | undefined = globalThis.location?.origin): string {
  if (origin === undefined || origin.trim().length === 0) return 'unknown-origin'
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, '0')
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
