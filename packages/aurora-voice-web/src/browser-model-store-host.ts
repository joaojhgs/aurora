import type {
  AuroraWebFetchedChunk,
  AuroraWebFileStat,
  AuroraWebModelStoreHost,
  AuroraWebPersistenceReport
} from './model-store-host.js'

export type AuroraBrowserStoreBackendKind = 'opfs' | 'indexeddb'

export interface AuroraBrowserStorageEstimate {
  readonly quota?: number
  readonly usage?: number
  readonly persisted?: boolean
}

export interface AuroraBrowserModelStorePort {
  readonly kind: AuroraBrowserStoreBackendKind
  storageEstimate(): Promise<AuroraBrowserStorageEstimate>
  readSnapshot(): Promise<AuroraBrowserModelStoreSnapshot | null>
  writeSnapshot(snapshot: AuroraBrowserModelStoreSnapshot): Promise<void>
  readBlob(physicalKey: string): Promise<Uint8Array | null>
  statBlob(physicalKey: string): Promise<number | null>
  writeBlob(physicalKey: string, bytes: Uint8Array): Promise<void>
  appendBlob(physicalKey: string, offset: number, bytes: Uint8Array): Promise<void>
  readBlobChunk(physicalKey: string, offset: number, maxBytes: number): Promise<Uint8Array | null>
  copyBlob(fromPhysicalKey: string, toPhysicalKey: string, expectedBytes: number): Promise<void>
  deleteBlob(physicalKey: string): Promise<void>
  listBlobKeys(): Promise<readonly string[]>
  listBlobDependencies(physicalKey: string): Promise<readonly string[]>
}

export interface AuroraBrowserModelStoreLimits {
  readonly maxKeyBytes?: number
  readonly maxJsonBytes?: number
  readonly maxChunkBytes?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

export interface AuroraBrowserModelStoreSnapshot {
  readonly schemaVersion: 1
  readonly json: readonly BrowserJsonEntry[]
  readonly staging: readonly BrowserBlobEntry[]
  readonly promoted: readonly BrowserBlobEntry[]
  readonly journal: BrowserPromotionJournal | null
}

interface BrowserJsonEntry {
  readonly key: string
  readonly physicalKey: string
  readonly byteLength: number
}

interface BrowserBlobEntry {
  readonly key: string
  readonly physicalKey: string
  readonly byteLength: number
  readonly packId: string
}

interface BrowserPromotionJournal {
  readonly key: string
  readonly stagingPhysicalKey: string
  readonly promotedPhysicalKey: string
  readonly byteLength: number
  readonly phase: 'staging' | 'committed'
}

interface BrowserRuntimeGlobal {
  readonly isSecureContext?: boolean
  readonly crypto?: Crypto
  readonly navigator?: {
    readonly storage?: {
      getDirectory?: () => Promise<OpfsDirectoryHandle>
      estimate?: () => Promise<{ quota?: number; usage?: number }>
      persisted?: () => Promise<boolean>
    }
  }
  readonly indexedDB?: IDBFactory
}

interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  keys?: () => AsyncIterable<string>
}

interface OpfsFileHandle {
  getFile(): Promise<Blob>
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>
}

interface OpfsWritableFileStream {
  write(data: BufferSource | Blob | string | { type: 'write'; position: number; data: BufferSource }): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
}

interface IndexedDbChunkedBlobRecord {
  readonly kind: 'aurora-chunked-v1'
  readonly byteLength: number
  readonly chunks: readonly string[]
}

const DEFAULT_LIMITS: Required<AuroraBrowserModelStoreLimits> = Object.freeze({
  maxKeyBytes: 256,
  maxJsonBytes: 1024 * 1024,
  maxChunkBytes: 2 * 1024 * 1024,
  // The pruned French PocketTTS int8 LM graph is about 306 MiB.
  maxFileBytes: 384 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
})

const SNAPSHOT_KEY = 'aurora.voice.web.model-store.snapshot.v1'
const BLOB_STORE = 'blobs'
const META_STORE = 'meta'
const COPY_CHUNK_BYTES = 64 * 1024

export class AuroraBrowserModelStoreHost implements AuroraWebModelStoreHost {
  private recovered = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly limits: Required<AuroraBrowserModelStoreLimits>

  constructor(private readonly port: AuroraBrowserModelStorePort, limits: AuroraBrowserModelStoreLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  static async create(
    globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal,
    limits?: AuroraBrowserModelStoreLimits
  ): Promise<AuroraBrowserModelStoreHost> {
    const port = await createBrowserModelStorePort(globalObject)
    return new AuroraBrowserModelStoreHost(port, limits)
  }

  static async openExisting(
    globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal,
    limits?: AuroraBrowserModelStoreLimits
  ): Promise<AuroraBrowserModelStoreHost | null> {
    const port = await openExistingBrowserModelStorePort(globalObject)
    return port === null ? null : new AuroraBrowserModelStoreHost(port, limits)
  }

  backendKind(): AuroraBrowserStoreBackendKind {
    return this.port.kind
  }

  async persistenceReport(): Promise<AuroraWebPersistenceReport> {
    try {
      const estimate = await this.port.storageEstimate()
      const quota = safeOptionalSize(estimate.quota)
      const usage = safeOptionalSize(estimate.usage) ?? 0
      return {
        available: true,
        persistent: estimate.persisted === true,
        quotaBytes: quota,
        usedBytes: usage
      }
    } catch {
      return { available: false, persistent: false, quotaBytes: null, usedBytes: 0 }
    }
  }

  async readJson(key: string): Promise<string | null> {
    return this.withStore(async () => {
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.json, key)
      if (!entry) return null
      const bytes = await this.port.readBlob(entry.physicalKey)
      if (bytes === null) throw redactedError('evicted')
      if (bytes.byteLength !== entry.byteLength) throw redactedError('corrupt')
      return decodeUtf8(bytes)
    })
  }

  async writeJson(key: string, value: string): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(key, this.limits.maxKeyBytes)
      if (typeof value !== 'string') throw redactedError('json')
      const bytes = encodeUtf8(value)
      if (bytes.byteLength > this.limits.maxJsonBytes) throw redactedError('quota')
      const snapshot = await this.snapshot()
      const physicalKey = await this.allocatePhysicalName('json', key)
      const oldEntry = findEntry(snapshot.json, key)
      const oldBytes = oldEntry?.byteLength ?? 0
      await this.ensureTotal(snapshot, bytes.byteLength - oldBytes)
      await this.port.writeBlob(physicalKey, bytes)
      await this.port.writeSnapshot({
        ...snapshot,
        json: replaceJson(snapshot.json, { key, physicalKey, byteLength: bytes.byteLength })
      })
      if (oldEntry && oldEntry.physicalKey !== physicalKey) await this.port.deleteBlob(oldEntry.physicalKey)
    })
  }

  async deleteJson(key: string): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(key, this.limits.maxKeyBytes)
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.json, key)
      if (entry) await this.port.deleteBlob(entry.physicalKey)
      await this.port.writeSnapshot({
        ...snapshot,
        json: snapshot.json.filter((candidate) => candidate.key !== key)
      })
    })
  }

  async listJsonKeys(prefix: string): Promise<readonly string[]> {
    return this.withStore(async () => {
      validatePrefix(prefix, this.limits.maxKeyBytes)
      const snapshot = await this.snapshot()
      return snapshot.json
        .map((entry) => entry.key)
        .filter((key) => key.startsWith(prefix))
        .sort()
    })
  }

  async stagingLen(storageKey: string): Promise<number> {
    return this.withStore(async () => {
      const snapshot = await this.snapshot()
      return findEntry(snapshot.staging, storageKey)?.byteLength ?? 0
    })
  }

  async readStagingChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk> {
    return this.withStore(async () => this.readBlobChunk((await this.snapshot()).staging, storageKey, offset, maxBytes))
  }

  async appendStaging(storageKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(storageKey, this.limits.maxKeyBytes)
      validateOffset(offset)
      validateChunk(bytes, this.limits.maxChunkBytes)
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.staging, storageKey)
      const currentLen = entry?.byteLength ?? 0
      if (offset !== currentLen) throw redactedError('append_offset')
      const nextLen = checkedAdd(currentLen, bytes.byteLength)
      if (nextLen > this.limits.maxFileBytes) throw redactedError('quota')
      await this.ensureTotal(snapshot, bytes.byteLength)
      const physicalKey = entry?.physicalKey ?? await this.allocatePhysicalName('staging', storageKey)
      await this.port.appendBlob(physicalKey, offset, bytes)
      await this.port.writeSnapshot({
        ...snapshot,
        staging: replaceBlob(snapshot.staging, {
          key: storageKey,
          physicalKey,
          byteLength: nextLen,
          packId: packIdFromStorageKey(storageKey)
        })
      })
    })
  }

  async clearStaging(storageKey: string): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(storageKey, this.limits.maxKeyBytes)
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.staging, storageKey)
      if (entry) await this.port.deleteBlob(entry.physicalKey)
      await this.port.writeSnapshot({
        ...snapshot,
        staging: snapshot.staging.filter((candidate) => candidate.key !== storageKey),
        journal: snapshot.journal?.key === storageKey ? null : snapshot.journal
      })
    })
  }

  async promotedStat(storageKey: string): Promise<AuroraWebFileStat | null> {
    return this.withStore(async () => {
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.promoted, storageKey)
      if (!entry) return null
      const byteLength = await this.port.statBlob(entry.physicalKey)
      if (byteLength === null) throw redactedError('evicted')
      if (byteLength !== entry.byteLength) throw redactedError('corrupt')
      return { byteLength: entry.byteLength, sha256: null }
    })
  }

  async readPromotedChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk> {
    return this.withStore(async () => this.readBlobChunk((await this.snapshot()).promoted, storageKey, offset, maxBytes))
  }

  async promoteStagingAtomic(storageKey: string): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(storageKey, this.limits.maxKeyBytes)
      let snapshot = await this.snapshot()
      const staging = findEntry(snapshot.staging, storageKey)
      if (!staging) throw redactedError('missing_staging')
      const promotedPhysicalKey = staging.physicalKey
      const oldPromoted = findEntry(snapshot.promoted, storageKey)
      await this.port.writeSnapshot({
        ...snapshot,
        journal: {
          key: storageKey,
          stagingPhysicalKey: staging.physicalKey,
          promotedPhysicalKey,
          byteLength: staging.byteLength,
          phase: 'staging'
        }
      })
      snapshot = await this.snapshotWithoutRecovery()
      await this.port.writeSnapshot({
        ...snapshot,
        staging: snapshot.staging.filter((candidate) => candidate.key !== storageKey),
        promoted: replaceBlob(snapshot.promoted, {
          key: storageKey,
          physicalKey: promotedPhysicalKey,
          byteLength: staging.byteLength,
          packId: staging.packId
        }),
        journal: {
          key: storageKey,
          stagingPhysicalKey: staging.physicalKey,
          promotedPhysicalKey,
          byteLength: staging.byteLength,
          phase: 'committed'
        }
      })
      snapshot = await this.snapshotWithoutRecovery()
      await this.port.writeSnapshot({ ...snapshot, journal: null })
      if (oldPromoted && oldPromoted.physicalKey !== promotedPhysicalKey) {
        await this.port.deleteBlob(oldPromoted.physicalKey)
      }
    })
  }

  async deletePromoted(storageKey: string): Promise<void> {
    return this.withStore(async () => {
      validateLogicalKey(storageKey, this.limits.maxKeyBytes)
      const snapshot = await this.snapshot()
      const entry = findEntry(snapshot.promoted, storageKey)
      if (entry) await this.port.deleteBlob(entry.physicalKey)
      await this.port.writeSnapshot({
        ...snapshot,
        promoted: snapshot.promoted.filter((candidate) => candidate.key !== storageKey)
      })
    })
  }

  async listPromotedKeys(): Promise<readonly string[]> {
    return this.withStore(async () => {
      const snapshot = await this.snapshot()
      return snapshot.promoted.map((entry) => entry.key).sort()
    })
  }

  async removePackData(packId: string): Promise<void> {
    return this.withStore(async () => {
      validatePackId(packId, this.limits.maxKeyBytes)
      const snapshot = await this.snapshot()
      const stagingRemove = snapshot.staging.filter((entry) => entry.packId === packId)
      const promotedRemove = snapshot.promoted.filter((entry) => entry.packId === packId)
      for (const entry of [...stagingRemove, ...promotedRemove]) {
        await this.port.deleteBlob(entry.physicalKey)
      }
      await this.port.writeSnapshot({
        ...snapshot,
        staging: snapshot.staging.filter((entry) => entry.packId !== packId),
        promoted: snapshot.promoted.filter((entry) => entry.packId !== packId),
        journal: snapshot.journal && packIdFromStorageKey(snapshot.journal.key) === packId ? null : snapshot.journal
      })
    })
  }

  private async snapshot(): Promise<AuroraBrowserModelStoreSnapshot> {
    await this.recoverOnce()
    return this.snapshotWithoutRecovery()
  }

  private async snapshotWithoutRecovery(): Promise<AuroraBrowserModelStoreSnapshot> {
    return validateSnapshot(await this.port.readSnapshot())
  }

  private async recoverOnce(): Promise<void> {
    if (this.recovered) return
    let snapshot = validateSnapshot(await this.port.readSnapshot())
    const journal = snapshot.journal
    if (journal) {
      const promoted = await this.port.readBlob(journal.promotedPhysicalKey)
      if (promoted !== null && promoted.byteLength === journal.byteLength) {
        snapshot = {
          ...snapshot,
          staging: snapshot.staging.filter((entry) => entry.key !== journal.key),
          promoted: replaceBlob(snapshot.promoted, {
            key: journal.key,
            physicalKey: journal.promotedPhysicalKey,
            byteLength: journal.byteLength,
            packId: packIdFromStorageKey(journal.key)
          }),
          journal: null
        }
        await this.port.writeSnapshot(snapshot)
        if (journal.stagingPhysicalKey !== journal.promotedPhysicalKey) {
          await this.port.deleteBlob(journal.stagingPhysicalKey)
        }
      } else {
        await this.port.deleteBlob(journal.promotedPhysicalKey)
        snapshot = { ...snapshot, journal: null }
        await this.port.writeSnapshot(snapshot)
      }
    }
    await this.reconcileUnreferencedBlobs(snapshot)
    this.recovered = true
  }

  private async reconcileUnreferencedBlobs(snapshot: AuroraBrowserModelStoreSnapshot): Promise<void> {
    const referenced = new Set(
      [...snapshot.json, ...snapshot.staging, ...snapshot.promoted].map((entry) => entry.physicalKey)
    )
    for (const physicalKey of [...referenced]) {
      for (const dependency of await this.port.listBlobDependencies(physicalKey)) {
        referenced.add(dependency)
      }
    }
    for (const physicalKey of await this.port.listBlobKeys()) {
      if (!referenced.has(physicalKey)) await this.port.deleteBlob(physicalKey)
    }
  }

  private async readBlobChunk(
    entries: readonly BrowserBlobEntry[],
    key: string,
    offset: number,
    maxBytes: number
  ): Promise<AuroraWebFetchedChunk> {
    validateLogicalKey(key, this.limits.maxKeyBytes)
    validateOffset(offset)
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.limits.maxChunkBytes) {
      throw redactedError('max_bytes')
    }
    const entry = findEntry(entries, key)
    if (!entry) return { bytes: new Uint8Array(), offset, complete: true }
    const end = Math.min(entry.byteLength, checkedAdd(offset, maxBytes))
    const bytes = await this.port.readBlobChunk(entry.physicalKey, offset, maxBytes)
    if (bytes === null) throw redactedError('corrupt')
    return {
      bytes,
      offset,
      complete: end >= entry.byteLength
    }
  }

  private async allocatePhysicalName(kind: string, logicalKey: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const physicalKey = await physicalName(kind, logicalKey, randomNonce())
      if ((await this.port.statBlob(physicalKey)) === null) return physicalKey
    }
    throw redactedError('collision')
  }

  private async ensureTotal(snapshot: AuroraBrowserModelStoreSnapshot, extraBytes: number): Promise<void> {
    const used = [...snapshot.json, ...snapshot.staging, ...snapshot.promoted].reduce(
      (total, entry) => checkedAdd(total, entry.byteLength),
      0
    )
    if (checkedAdd(used, extraBytes) > this.limits.maxTotalBytes) throw redactedError('quota')
    const estimate = await this.port.storageEstimate()
    const quota = safeOptionalSize(estimate.quota)
    const browserUsage = safeOptionalSize(estimate.usage)
    if (quota !== null && browserUsage !== null && checkedAdd(browserUsage, Math.max(0, extraBytes)) > quota) {
      throw redactedError('quota')
    }
  }

  private async withStore<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    try {
      return await run
    } catch (error) {
      if (error instanceof AuroraBrowserModelStoreError) throw error
      throw redactedError('storage')
    }
  }
}

export class AuroraBrowserModelStoreError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`aurora_voice_web_store:${code}`)
    this.name = 'AuroraBrowserModelStoreError'
    this.code = code
  }
}

export async function createBrowserModelStorePort(
  globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal
): Promise<AuroraBrowserModelStorePort> {
  if (globalObject.isSecureContext === true && typeof globalObject.navigator?.storage?.getDirectory === 'function') {
    try {
      return await OpfsBrowserModelStorePort.create(globalObject)
    } catch (error) {
      if (!globalObject.indexedDB) throw error
    }
  }
  if (globalObject.indexedDB) return new IndexedDbBrowserModelStorePort(globalObject, 'indexeddb')
  throw redactedError('unavailable')
}

export async function openExistingBrowserModelStorePort(
  globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal
): Promise<AuroraBrowserModelStorePort | null> {
  if (globalObject.isSecureContext === true && typeof globalObject.navigator?.storage?.getDirectory === 'function') {
    try {
      const opfsPort = await OpfsBrowserModelStorePort.openExisting(globalObject)
      if (opfsPort !== null || !globalObject.indexedDB) return opfsPort
    } catch (error) {
      if (
        !globalObject.indexedDB ||
        (
          !isNotFoundError(error) &&
          !isStorageAvailabilityError(error)
        )
      ) throw error
    }
  }
  if (globalObject.indexedDB) return IndexedDbBrowserModelStorePort.openExisting(globalObject)
  throw redactedError('unavailable')
}

export class OpfsBrowserModelStorePort implements AuroraBrowserModelStorePort {
  readonly kind = 'opfs' as const
  private readonly blobsPromise: Promise<OpfsDirectoryHandle>

  private constructor(
    private readonly globalObject: BrowserRuntimeGlobal,
    private readonly root: OpfsDirectoryHandle,
    createBlobs = true
  ) {
    this.blobsPromise = root.getDirectoryHandle(BLOB_STORE, { create: createBlobs })
  }

  static async create(globalObject: BrowserRuntimeGlobal): Promise<OpfsBrowserModelStorePort> {
    const root = await globalObject.navigator?.storage?.getDirectory?.()
    if (!root) throw redactedError('unavailable')
    return new OpfsBrowserModelStorePort(globalObject, root)
  }

  static async openExisting(globalObject: BrowserRuntimeGlobal): Promise<OpfsBrowserModelStorePort | null> {
    const root = await globalObject.navigator?.storage?.getDirectory?.()
    if (!root) throw redactedError('unavailable')
    try {
      await root.getFileHandle(SNAPSHOT_KEY, { create: false })
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    try {
      await root.getDirectoryHandle(BLOB_STORE, { create: false })
      return new OpfsBrowserModelStorePort(globalObject, root, false)
    } catch {
      throw redactedError('storage')
    }
  }

  async storageEstimate(): Promise<AuroraBrowserStorageEstimate> {
    return browserStorageEstimate(this.globalObject)
  }

  async readSnapshot(): Promise<AuroraBrowserModelStoreSnapshot | null> {
    const bytes = await this.readMeta(SNAPSHOT_KEY)
    return bytes === null ? null : JSON.parse(decodeUtf8(bytes))
  }

  async writeSnapshot(snapshot: AuroraBrowserModelStoreSnapshot): Promise<void> {
    await this.writeMeta(SNAPSHOT_KEY, encodeUtf8(JSON.stringify(snapshot)))
  }

  async readBlob(physicalKey: string): Promise<Uint8Array | null> {
    validatePhysicalKey(physicalKey)
    try {
      const handle = await (await this.blobsPromise).getFileHandle(physicalKey)
      return new Uint8Array(await (await handle.getFile()).arrayBuffer())
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async statBlob(physicalKey: string): Promise<number | null> {
    validatePhysicalKey(physicalKey)
    try {
      const handle = await (await this.blobsPromise).getFileHandle(physicalKey)
      return (await handle.getFile()).size
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async writeBlob(physicalKey: string, bytes: Uint8Array): Promise<void> {
    validatePhysicalKey(physicalKey)
    const handle = await (await this.blobsPromise).getFileHandle(physicalKey, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes)
      await writable.truncate(bytes.byteLength)
    } finally {
      await writable.close()
    }
  }

  async appendBlob(physicalKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    validatePhysicalKey(physicalKey)
    validateOffset(offset)
    const handle = await (await this.blobsPromise).getFileHandle(physicalKey, { create: true })
    const file = await handle.getFile()
    if (file.size !== offset) throw redactedError('append_offset')
    const writable = await handle.createWritable({ keepExistingData: true })
    try {
      await writable.write({ type: 'write', position: offset, data: bytes })
    } finally {
      await writable.close()
    }
  }

  async listBlobKeys(): Promise<readonly string[]> {
    const directory = await this.blobsPromise
    if (typeof directory.keys === 'function') {
      const keys: string[] = []
      for await (const key of directory.keys()) keys.push(String(key))
      return keys.sort()
    }
    return []
  }

  async listBlobDependencies(physicalKey: string): Promise<readonly string[]> {
    validatePhysicalKey(physicalKey)
    return []
  }

  async deleteBlob(physicalKey: string): Promise<void> {
    validatePhysicalKey(physicalKey)
    try {
      await (await this.blobsPromise).removeEntry(physicalKey)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }

  async readBlobChunk(physicalKey: string, offset: number, maxBytes: number): Promise<Uint8Array | null> {
    validatePhysicalKey(physicalKey)
    validateOffset(offset)
    try {
      const handle = await (await this.blobsPromise).getFileHandle(physicalKey)
      const file = await handle.getFile()
      return new Uint8Array(await file.slice(offset, Math.min(file.size, checkedAdd(offset, maxBytes))).arrayBuffer())
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  async copyBlob(fromPhysicalKey: string, toPhysicalKey: string, expectedBytes: number): Promise<void> {
    validatePhysicalKey(fromPhysicalKey)
    validatePhysicalKey(toPhysicalKey)
    validateByteLength(expectedBytes)
    const size = await this.statBlob(fromPhysicalKey)
    if (size !== expectedBytes) throw redactedError('corrupt')
    await this.deleteBlob(toPhysicalKey)
    let offset = 0
    while (offset < expectedBytes) {
      const chunk = await this.readBlobChunk(fromPhysicalKey, offset, COPY_CHUNK_BYTES)
      if (chunk === null || chunk.byteLength === 0) throw redactedError('corrupt')
      await this.appendBlob(toPhysicalKey, offset, chunk)
      offset = checkedAdd(offset, chunk.byteLength)
    }
  }

  private async readMeta(name: string): Promise<Uint8Array | null> {
    try {
      const handle = await this.root.getFileHandle(name)
      return new Uint8Array(await (await handle.getFile()).arrayBuffer())
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  private async writeMeta(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.root.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes)
      await writable.truncate(bytes.byteLength)
    } finally {
      await writable.close()
    }
  }
}

export class IndexedDbBrowserModelStorePort implements AuroraBrowserModelStorePort {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal,
    readonly kind: AuroraBrowserStoreBackendKind = 'indexeddb',
    private readonly databaseName = 'aurora-voice-web-model-store-v1',
    private readonly createStores = true
  ) {}

  static async openExisting(
    globalObject: BrowserRuntimeGlobal = globalThis as BrowserRuntimeGlobal,
    kind: AuroraBrowserStoreBackendKind = 'indexeddb',
    databaseName = 'aurora-voice-web-model-store-v1'
  ): Promise<IndexedDbBrowserModelStorePort | null> {
    const indexedDB = globalObject.indexedDB
    if (!indexedDB) throw redactedError('unavailable')
    if (!await indexedDbDatabaseMayExist(indexedDB, databaseName)) return null
    const port = new IndexedDbBrowserModelStorePort(globalObject, kind, databaseName, false)
    try {
      await port.db()
    } catch (error) {
      if (isStoreErrorCode(error, 'absent')) return null
      throw error
    }
    return port
  }

  async storageEstimate(): Promise<AuroraBrowserStorageEstimate> {
    return browserStorageEstimate(this.globalObject)
  }

  async readSnapshot(): Promise<AuroraBrowserModelStoreSnapshot | null> {
    const value = await this.get(META_STORE, SNAPSHOT_KEY)
    return typeof value === 'string' ? JSON.parse(value) : null
  }

  async writeSnapshot(snapshot: AuroraBrowserModelStoreSnapshot): Promise<void> {
    await this.put(META_STORE, SNAPSHOT_KEY, JSON.stringify(snapshot))
  }

  async readBlob(physicalKey: string): Promise<Uint8Array | null> {
    const value = await this.get(BLOB_STORE, physicalKey)
    if (value === undefined || value === null) return null
    if (isIndexedDbChunkedBlobRecord(value)) return this.readChunkedBlob(value)
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
    throw redactedError('corrupt')
  }

  async statBlob(physicalKey: string): Promise<number | null> {
    validatePhysicalKey(physicalKey)
    const value = await this.get(BLOB_STORE, physicalKey)
    if (value === undefined || value === null) return null
    if (isIndexedDbChunkedBlobRecord(value)) return this.statChunkedBlob(value)
    return byteLengthOfLegacyIndexedDbBlob(value)
  }

  async writeBlob(physicalKey: string, bytes: Uint8Array): Promise<void> {
    validatePhysicalKey(physicalKey)
    await this.deleteBlob(physicalKey)
    await this.put(BLOB_STORE, physicalKey, new Uint8Array(bytes))
  }

  async appendBlob(physicalKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    validatePhysicalKey(physicalKey)
    validateOffset(offset)
    const existing = await this.get(BLOB_STORE, physicalKey)
    const record = await this.normalizedChunkedRecord(physicalKey, existing)
    if (record.byteLength !== offset) throw redactedError('append_offset')
    const chunkKey = indexedDbChunkKey(physicalKey, record.chunks.length)
    await this.put(BLOB_STORE, chunkKey, new Uint8Array(bytes))
    await this.put(BLOB_STORE, physicalKey, {
      kind: 'aurora-chunked-v1',
      byteLength: checkedAdd(record.byteLength, bytes.byteLength),
      chunks: [...record.chunks, chunkKey]
    } satisfies IndexedDbChunkedBlobRecord)
  }

  async readBlobChunk(physicalKey: string, offset: number, maxBytes: number): Promise<Uint8Array | null> {
    validatePhysicalKey(physicalKey)
    validateOffset(offset)
    const existing = await this.get(BLOB_STORE, physicalKey)
    if (existing === undefined || existing === null) return null
    if (!isIndexedDbChunkedBlobRecord(existing)) {
      const bytes = await bytesFromLegacyIndexedDbBlob(existing)
      return bytes.slice(offset, Math.min(bytes.byteLength, checkedAdd(offset, maxBytes)))
    }
    return this.readChunkedRange(existing, offset, maxBytes)
  }

  async copyBlob(fromPhysicalKey: string, toPhysicalKey: string, expectedBytes: number): Promise<void> {
    validatePhysicalKey(fromPhysicalKey)
    validatePhysicalKey(toPhysicalKey)
    validateByteLength(expectedBytes)
    const existing = await this.get(BLOB_STORE, fromPhysicalKey)
    if (existing === undefined || existing === null) throw redactedError('corrupt')
    if (isIndexedDbChunkedBlobRecord(existing)) {
      if (existing.byteLength !== expectedBytes) throw redactedError('corrupt')
      await this.deleteBlob(toPhysicalKey)
      const chunks: string[] = []
      for (let index = 0; index < existing.chunks.length; index += 1) {
        const sourceChunkKey = existing.chunks[index]
        if (!sourceChunkKey) throw redactedError('corrupt')
        const chunk = await this.get(BLOB_STORE, sourceChunkKey)
        if (!(chunk instanceof Uint8Array)) throw redactedError('corrupt')
        const chunkKey = indexedDbChunkKey(toPhysicalKey, index)
        await this.put(BLOB_STORE, chunkKey, new Uint8Array(chunk))
        chunks.push(chunkKey)
      }
      await this.put(BLOB_STORE, toPhysicalKey, { ...existing, chunks })
      return
    }
    const bytes = await bytesFromLegacyIndexedDbBlob(existing)
    if (bytes.byteLength !== expectedBytes) throw redactedError('corrupt')
    await this.writeBlob(toPhysicalKey, bytes)
  }

  async deleteBlob(physicalKey: string): Promise<void> {
    const existing = await this.get(BLOB_STORE, physicalKey)
    if (isIndexedDbChunkedBlobRecord(existing)) {
      for (const chunkKey of existing.chunks) await this.delete(BLOB_STORE, chunkKey)
    }
    await this.delete(BLOB_STORE, physicalKey)
  }

  async listBlobKeys(): Promise<readonly string[]> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, 'readonly')
      const request = tx.objectStore(BLOB_STORE).getAllKeys()
      request.onerror = () => reject(redactedError('storage'))
      request.onsuccess = () => resolve(request.result.map(String).sort())
    })
  }

  async listBlobDependencies(physicalKey: string): Promise<readonly string[]> {
    validatePhysicalKey(physicalKey)
    const value = await this.get(BLOB_STORE, physicalKey)
    return isIndexedDbChunkedBlobRecord(value) ? [...value.chunks] : []
  }

  private async get(storeName: string, key: string): Promise<unknown> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const request = tx.objectStore(storeName).get(key)
      request.onerror = () => reject(redactedError('storage'))
      request.onsuccess = () => resolve(request.result)
    })
  }

  private async normalizedChunkedRecord(
    physicalKey: string,
    existing: unknown
  ): Promise<IndexedDbChunkedBlobRecord> {
    if (existing === undefined || existing === null) {
      return { kind: 'aurora-chunked-v1', byteLength: 0, chunks: [] }
    }
    if (isIndexedDbChunkedBlobRecord(existing)) return existing
    const bytes = await bytesFromLegacyIndexedDbBlob(existing)
    const chunkKey = indexedDbChunkKey(physicalKey, 0)
    await this.put(BLOB_STORE, chunkKey, bytes)
    return { kind: 'aurora-chunked-v1', byteLength: bytes.byteLength, chunks: [chunkKey] }
  }

  private async readChunkedBlob(record: IndexedDbChunkedBlobRecord): Promise<Uint8Array> {
    const output = new Uint8Array(record.byteLength)
    let offset = 0
    for (const chunkKey of record.chunks) {
      const value = await this.get(BLOB_STORE, chunkKey)
      if (!(value instanceof Uint8Array)) throw redactedError('corrupt')
      output.set(value, offset)
      offset = checkedAdd(offset, value.byteLength)
    }
    if (offset !== record.byteLength) throw redactedError('corrupt')
    return output
  }

  private async statChunkedBlob(record: IndexedDbChunkedBlobRecord): Promise<number> {
    let byteLength = 0
    for (const chunkKey of record.chunks) {
      const value = await this.get(BLOB_STORE, chunkKey)
      if (value === undefined || value === null) throw redactedError('evicted')
      if (!(value instanceof Uint8Array)) throw redactedError('corrupt')
      byteLength = checkedAdd(byteLength, value.byteLength)
    }
    if (byteLength !== record.byteLength) throw redactedError('corrupt')
    return byteLength
  }

  private async readChunkedRange(
    record: IndexedDbChunkedBlobRecord,
    offset: number,
    maxBytes: number
  ): Promise<Uint8Array> {
    const end = Math.min(record.byteLength, checkedAdd(offset, maxBytes))
    const output = new Uint8Array(Math.max(0, end - offset))
    let sourceOffset = 0
    let targetOffset = 0
    for (const chunkKey of record.chunks) {
      const value = await this.get(BLOB_STORE, chunkKey)
      if (!(value instanceof Uint8Array)) throw redactedError('corrupt')
      const chunkStart = sourceOffset
      const chunkEnd = checkedAdd(sourceOffset, value.byteLength)
      if (chunkEnd > offset && chunkStart < end) {
        const from = Math.max(0, offset - chunkStart)
        const to = Math.min(value.byteLength, end - chunkStart)
        output.set(value.slice(from, to), targetOffset)
        targetOffset = checkedAdd(targetOffset, to - from)
      }
      sourceOffset = chunkEnd
      if (sourceOffset >= end) break
    }
    if (targetOffset !== output.byteLength) throw redactedError('corrupt')
    return output
  }

  private async put(storeName: string, key: string, value: unknown): Promise<void> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(redactedError('storage'))
      tx.objectStore(storeName).put(value, key)
    })
  }

  private async delete(storeName: string, key: string): Promise<void> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(redactedError('storage'))
      tx.objectStore(storeName).delete(key)
    })
  }

  private async db(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    const indexedDB = this.globalObject.indexedDB
    if (!indexedDB) throw redactedError('unavailable')
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1)
      request.onerror = () => reject(redactedError('unavailable'))
      request.onupgradeneeded = () => {
        if (!this.createStores) {
          reject(redactedError('absent'))
          request.transaction?.abort()
          return
        }
        const db = request.result
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE)
      }
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(META_STORE) || !db.objectStoreNames.contains(BLOB_STORE)) {
          db.close()
          reject(redactedError('unavailable'))
          return
        }
        resolve(db)
      }
    })
    return this.dbPromise
  }
}

async function indexedDbDatabaseMayExist(indexedDB: IDBFactory, databaseName: string): Promise<boolean> {
  const databases = (indexedDB as unknown as { databases?: unknown }).databases
  if (typeof databases !== 'function') return true
  let entries: Array<{ name?: string }>
  try {
    entries = await databases.call(indexedDB) as Array<{ name?: string }>
  } catch {
    return true
  }
  return entries.some((entry) => entry.name === databaseName)
}

function validateSnapshot(snapshot: AuroraBrowserModelStoreSnapshot | null): AuroraBrowserModelStoreSnapshot {
  if (snapshot === null) {
    return { schemaVersion: 1, json: [], staging: [], promoted: [], journal: null }
  }
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.json) || !Array.isArray(snapshot.staging) || !Array.isArray(snapshot.promoted)) {
    throw redactedError('corrupt')
  }
  return {
    schemaVersion: 1,
    json: snapshot.json.map(validateJsonEntry).sort(compareEntry),
    staging: snapshot.staging.map(validateBlobEntry).sort(compareEntry),
    promoted: snapshot.promoted.map(validateBlobEntry).sort(compareEntry),
    journal: snapshot.journal === null ? null : validateJournal(snapshot.journal)
  }
}

function validateJsonEntry(entry: BrowserJsonEntry): BrowserJsonEntry {
  validateLogicalKey(entry.key, DEFAULT_LIMITS.maxKeyBytes)
  validatePhysicalKey(entry.physicalKey)
  validateByteLength(entry.byteLength)
  return entry
}

function validateBlobEntry(entry: BrowserBlobEntry): BrowserBlobEntry {
  validateLogicalKey(entry.key, DEFAULT_LIMITS.maxKeyBytes)
  validatePhysicalKey(entry.physicalKey)
  validateByteLength(entry.byteLength)
  validatePackId(entry.packId, DEFAULT_LIMITS.maxKeyBytes)
  return entry
}

function validateJournal(journal: BrowserPromotionJournal): BrowserPromotionJournal {
  validateLogicalKey(journal.key, DEFAULT_LIMITS.maxKeyBytes)
  validatePhysicalKey(journal.stagingPhysicalKey)
  validatePhysicalKey(journal.promotedPhysicalKey)
  validateByteLength(journal.byteLength)
  if (journal.phase !== 'staging' && journal.phase !== 'committed') throw redactedError('corrupt')
  return journal
}

function validateLogicalKey(key: string, maxBytes: number): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    byteLength(key) > maxBytes ||
    key.includes('..') ||
    !/^[A-Za-z0-9._:@+-]+$/.test(key)
  ) {
    throw redactedError('key')
  }
}

function validatePrefix(prefix: string, maxBytes: number): void {
  if (prefix.length === 0) return
  validateLogicalKey(prefix, maxBytes)
}

function validatePackId(packId: string, maxBytes: number): void {
  validateLogicalKey(packId, maxBytes)
}

function validatePhysicalKey(key: string): void {
  if (!/^aurora-[a-z]+-[a-f0-9]{64}$/.test(key)) throw redactedError('corrupt')
}

function validateByteLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw redactedError('corrupt')
}

function validateOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw redactedError('offset')
}

function validateChunk(bytes: Uint8Array, maxChunkBytes: number): void {
  if (!(bytes instanceof Uint8Array)) throw redactedError('bytes')
  if (bytes.byteLength > maxChunkBytes) throw redactedError('quota')
}

function findEntry<T extends { readonly key: string }>(entries: readonly T[], key: string): T | undefined {
  validateLogicalKey(key, DEFAULT_LIMITS.maxKeyBytes)
  return entries.find((entry) => entry.key === key)
}

function replaceJson(entries: readonly BrowserJsonEntry[], next: BrowserJsonEntry): readonly BrowserJsonEntry[] {
  return [...entries.filter((entry) => entry.key !== next.key), next].sort(compareEntry)
}

function replaceBlob(entries: readonly BrowserBlobEntry[], next: BrowserBlobEntry): readonly BrowserBlobEntry[] {
  return [...entries.filter((entry) => entry.key !== next.key), next].sort(compareEntry)
}

function compareEntry(left: { readonly key: string }, right: { readonly key: string }): number {
  return left.key.localeCompare(right.key)
}

function packIdFromStorageKey(storageKey: string): string {
  const at = storageKey.indexOf('@')
  return at <= 0 ? storageKey : storageKey.slice(0, at)
}

async function physicalName(kind: string, logicalKey: string, nonce: string): Promise<string> {
  const crypto = (globalThis as BrowserRuntimeGlobal).crypto
  if (!crypto?.subtle) throw redactedError('unavailable')
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(`${kind}\0${logicalKey}\0${nonce}`))
  return `aurora-${kind}-${hex(new Uint8Array(digest))}`
}

function randomNonce(): string {
  const crypto = (globalThis as BrowserRuntimeGlobal).crypto
  if (!crypto?.getRandomValues) throw redactedError('unavailable')
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return hex(bytes)
}

function hex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
  return output
}

function isIndexedDbChunkedBlobRecord(value: unknown): value is IndexedDbChunkedBlobRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<IndexedDbChunkedBlobRecord>
  return candidate.kind === 'aurora-chunked-v1' &&
    Number.isSafeInteger(candidate.byteLength) &&
    (candidate.byteLength ?? -1) >= 0 &&
    Array.isArray(candidate.chunks) &&
    candidate.chunks.every((chunk) => typeof chunk === 'string' && chunk.length > 0)
}

function indexedDbChunkKey(physicalKey: string, index: number): string {
  validatePhysicalKey(physicalKey)
  if (!Number.isSafeInteger(index) || index < 0) throw redactedError('corrupt')
  return `${physicalKey}.chunk.${index}`
}

function byteLengthOfLegacyIndexedDbBlob(value: unknown): number {
  if (value instanceof Blob) return value.size
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  throw redactedError('corrupt')
}

async function bytesFromLegacyIndexedDbBlob(value: unknown): Promise<Uint8Array> {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  throw redactedError('corrupt')
}

async function browserStorageEstimate(globalObject: BrowserRuntimeGlobal): Promise<AuroraBrowserStorageEstimate> {
  const estimate = await globalObject.navigator?.storage?.estimate?.()
  const persisted = await globalObject.navigator?.storage?.persisted?.()
  return {
    ...(estimate?.quota === undefined ? {} : { quota: estimate.quota }),
    ...(estimate?.usage === undefined ? {} : { usage: estimate.usage }),
    ...(persisted === undefined ? {} : { persisted })
  }
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function checkedAdd(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total < 0) throw redactedError('overflow')
  return total
}

function safeOptionalSize(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) return null
  return value
}

function byteLength(value: string): number {
  return encodeUtf8(value).byteLength
}

function redactedError(code: string): AuroraBrowserModelStoreError {
  return new AuroraBrowserModelStoreError(code)
}

function isStoreErrorCode(error: unknown, code: string): boolean {
  return error instanceof AuroraBrowserModelStoreError && error.code === code
}

function isStorageAvailabilityError(error: unknown): boolean {
  if (isStoreErrorCode(error, 'unavailable')) return true
  return error instanceof DOMException && (
    error.name === 'InvalidStateError' ||
    error.name === 'NotAllowedError' ||
    error.name === 'SecurityError'
  )
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}
