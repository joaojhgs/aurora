import {
  assertOpen,
  assertStoredMigrationChecksums,
  buildLocalDataExportV1,
  compareUtf8,
  LocalDataError,
  localDataIdSchema,
  localDataMigrationManifest,
  parseConversationMessageRecord,
  parseConversationRecord,
  parseLightweightMemoryRecord,
  parseLocalAuditRecord,
  parseLocalDataExportV1,
  parseLocalToolStateRecord,
  parsePeerGrantMetadataRecord,
  parseTranscriptSessionRecord,
  parseTranscriptSegmentRecord,
  type ConversationMessageRecord,
  type ConversationRecord,
  type DeleteConversationResult,
  type DeleteExpiredMemoryItemsResult,
  type DeleteRecordResult,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataExportV1,
  type LocalDataImportResult,
  type LocalDataRecordCollections,
  type LocalDataRepositories,
  type LocalDataScope,
  type LocalDataSession,
  type LocalToolStateRecord,
  type TranscriptSessionRecord,
  type TranscriptSegmentRecord,
  type TranscriptSessionListQuery,
  type TranscriptSegmentListQuery,
  type FinalizeTranscriptSessionInput,
  type AppendTranscriptSegmentResult,
  type RecoverTranscriptSessionsResult,
  type DeleteTranscriptSessionResult,
  type DeleteExpiredTranscriptSessionsResult,
  type MutableLocalDataCollections,
  type PeerGrantMetadataRecord,
  type ConversationListQuery,
  type MessageListQuery,
  LOCAL_DATA_TRANSCRIPT_SESSION_LIMIT,
  LOCAL_DATA_TRANSCRIPT_SEGMENT_LIMIT,
  LOCAL_DATA_TRANSCRIPT_SESSION_QUERY_MAX,
  LOCAL_DATA_TRANSCRIPT_SEGMENT_QUERY_MAX,
  LOCAL_DATA_TRANSCRIPT_DELETE_LIMIT
} from '@aurora/client/local-data'

import {
  BrowserStorageLockCoordinator,
  deriveBrowserStorageOwnerKey,
  IndexedDbBrowserStorageLeaseStore,
  type BrowserStorageLeaseStore,
  type BrowserStorageLockManagerLike,
  type BrowserStorageWriterLock
} from './browser-storage-lock'

export interface BrowserIndexedDbDocumentStore {
  load(): Promise<StoredBrowserLocalDataDocument | null>
  save(document: StoredBrowserLocalDataDocument): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
}

export interface BrowserIndexedDbLocalDataBackendOptions {
  readonly origin?: string
  readonly indexedDB?: IDBFactory
  readonly documentStore?: BrowserIndexedDbDocumentStore
  readonly leaseStore?: BrowserStorageLeaseStore | null
  readonly locks?: BrowserStorageLockManagerLike | null
  readonly ownerId?: string
  readonly nowMs?: () => number
  readonly leaseDurationMs?: number
}

export interface StoredBrowserLocalDataDocument {
  readonly formatVersion: 1
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  readonly migrationLedger: Array<{ readonly version: number; readonly checksum: string }>
  readonly records: LocalDataRecordCollections
}

export class BrowserIndexedDbLocalDataBackend implements LocalDataBackend {
  readonly kind = 'indexeddb' as const
  readonly persistent = true
  readonly sqlite = false
  private readonly origin: string
  private readonly indexedDB: IDBFactory | undefined
  private readonly injectedDocumentStore: BrowserIndexedDbDocumentStore | undefined
  private readonly injectedLeaseStore: BrowserStorageLeaseStore | null | undefined
  private readonly locks: BrowserStorageLockManagerLike | null | undefined
  private readonly ownerId: string | undefined
  private readonly nowMs: () => number
  private readonly leaseDurationMs: number | undefined
  private session: BrowserIndexedDbLocalDataSession | null = null
  private closed = false
  private lastStatus: LocalDataBackendStatus = {
    kind: 'indexeddb',
    persistent: true,
    sqlite: false,
    profileId: null,
    schemaVersion: null,
    migrationState: 'idle'
  }

  constructor(options: BrowserIndexedDbLocalDataBackendOptions = {}) {
    this.origin = canonicalOrigin(options.origin)
    this.indexedDB = options.indexedDB
    this.injectedDocumentStore = options.documentStore
    this.injectedLeaseStore = options.leaseStore
    this.locks = options.locks
    this.ownerId = options.ownerId
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.leaseDurationMs = options.leaseDurationMs
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.closed) throw new LocalDataError('session_closed', 'Browser local data backend is closed')
    const canonicalProfileId = parseLocalDataId(profileId, 'identity.profile')
    const canonicalLocalNodeId = parseLocalDataId(localNodeId, 'identity.local_node')
    if (this.session !== null) {
      if (this.session.profileId !== canonicalProfileId || this.session.localNodeId !== canonicalLocalNodeId) {
        throw new LocalDataError('unsupported_backend', 'Browser local data is already open for writing', { reason: 'owner_exists' })
      }
      return this.session
    }

    const documentStore = this.injectedDocumentStore ?? new IndexedDbBrowserLocalDataDocumentStore({
      ...(this.indexedDB === undefined ? {} : { indexedDB: this.indexedDB }),
      databaseName: deriveBrowserLocalDataDatabaseName(this.origin, canonicalLocalNodeId)
    })
    const leaseStore = this.injectedLeaseStore === undefined
      ? safeDefaultLeaseStore(this.indexedDB)
      : this.injectedLeaseStore
    const lockOptions = {
      origin: this.origin,
      localNodeId: canonicalLocalNodeId,
      ...(this.ownerId === undefined ? {} : { ownerId: this.ownerId }),
      ...(this.locks === undefined ? {} : { locks: this.locks }),
      leaseStore,
      nowMs: this.nowMs,
      ...(this.leaseDurationMs === undefined ? {} : { leaseDurationMs: this.leaseDurationMs })
    }
    const writerLock = await new BrowserStorageLockCoordinator(lockOptions).acquire()

    this.lastStatus = { ...this.lastStatus, profileId: canonicalProfileId, migrationState: 'running' }
    try {
      const document = await this.openDocument(documentStore, canonicalProfileId, canonicalLocalNodeId)
      this.session = new BrowserIndexedDbLocalDataSession({
        profileId: canonicalProfileId,
        localNodeId: canonicalLocalNodeId,
        schemaVersion: localDataMigrationManifest.latestVersion,
        records: cloneLocalDataCollections(document.records),
        documentStore,
        writerLock,
        nowMs: this.nowMs,
        closeBackendSession: () => {
          this.session = null
        }
      })
      if (writerLock.status.mode === 'web-locks') {
        await this.session.transcripts.recoverActiveSessions(this.nowMs())
      }
      this.lastStatus = {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: canonicalProfileId,
        schemaVersion: localDataMigrationManifest.latestVersion,
        migrationState: 'idle'
      }
      return this.session
    } catch (error) {
      this.session = null
      await writerLock.release()
      await documentStore.close()
      const degradedReason = error instanceof LocalDataError ? error.metadata?.reason : 'open_failed'
      this.lastStatus = {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: canonicalProfileId,
        schemaVersion: null,
        migrationState: 'failed',
        ...(degradedReason === undefined ? {} : { degradedReason })
      }
      throw error
    }
  }

  async status(): Promise<LocalDataBackendStatus> {
    if (this.session !== null) {
      return {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: this.session.profileId,
        schemaVersion: this.session.schemaVersion,
        migrationState: 'idle'
      }
    }
    return this.lastStatus
  }

  async close(): Promise<void> {
    this.closed = true
    await this.session?.close()
    this.session = null
  }

  private async openDocument(
    store: BrowserIndexedDbDocumentStore,
    profileId: string,
    localNodeId: string,
  ): Promise<StoredBrowserLocalDataDocument> {
    const existing = parseStoredDocument(await store.load())
    if (existing === null) {
      const fresh = createStoredDocument(profileId, localNodeId)
      await store.save(fresh)
      return fresh
    }
    if (existing.localNodeId !== localNodeId) {
      throw new LocalDataError('identity_mismatch', 'Browser local data identity does not match the open session')
    }
    if (existing.schemaVersion > localDataMigrationManifest.latestVersion) {
      throw new LocalDataError('invalid_record', 'Browser local data was created by a newer Aurora version', { reason: 'future_schema' })
    }
    assertStoredMigrationChecksums(localDataMigrationManifest, existing.migrationLedger)
    if (existing.migrationLedger.length !== existing.schemaVersion) {
      throw new LocalDataError('migration_integrity', 'Browser local data upgrade needs a reset before continuing', { reason: 'partial_upgrade_requires_reset' })
    }
    if (existing.schemaVersion < localDataMigrationManifest.latestVersion) {
      const upgraded = {
        ...existing,
        profileId,
        schemaVersion: localDataMigrationManifest.latestVersion,
        migrationLedger: currentMigrationLedger(),
        records: cloneLocalDataCollections(existing.records)
      }
      validateStoredCollectionsForLocalNode(upgraded.records, localNodeId)
      await store.save(upgraded)
      return upgraded
    }
    const current = {
      ...existing,
      profileId,
      schemaVersion: localDataMigrationManifest.latestVersion,
      records: cloneLocalDataCollections(existing.records)
    }
    validateStoredCollectionsForLocalNode(current.records, localNodeId)
    if (current.profileId !== existing.profileId || current.schemaVersion !== existing.schemaVersion) await store.save(current)
    return current
  }
}

export class IndexedDbBrowserLocalDataDocumentStore implements BrowserIndexedDbDocumentStore {
  private readonly indexedDB: IDBFactory
  private readonly databaseName: string
  private readonly storeName: string
  private readonly documentKey: string
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(options: { indexedDB?: IDBFactory; databaseName: string; storeName?: string; documentKey?: string }) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!indexedDB) throw new LocalDataError('unsupported_backend', 'Browser local data is unavailable', { reason: 'indexeddb_unavailable' })
    this.indexedDB = indexedDB
    this.databaseName = options.databaseName
    this.storeName = options.storeName ?? 'documents'
    this.documentKey = options.documentKey ?? 'local-data'
  }

  async load(): Promise<StoredBrowserLocalDataDocument | null> {
    return (await this.request('readonly', (store) => store.get(this.documentKey)) as StoredBrowserLocalDataDocument | undefined) ?? null
  }

  async save(document: StoredBrowserLocalDataDocument): Promise<void> {
    await this.request('readwrite', (store) => store.put(document, this.documentKey))
  }

  async clear(): Promise<void> {
    await this.request('readwrite', (store) => store.delete(this.documentKey))
  }

  async close(): Promise<void> {
    if (this.databasePromise !== null) (await this.databasePromise).close()
    this.databasePromise = null
  }

  private async request<T>(mode: IDBTransactionMode, build: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.database()
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(this.storeName, mode)
      const request = build(tx.objectStore(this.storeName))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(request.error ?? new Error('browser local data request failed'))
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('browser local data transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('browser local data transaction aborted'))
    })
  }

  private async database(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) return await this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('browser local data open failed'))
      request.onblocked = () => reject(new Error('browser local data upgrade blocked'))
    })
    return await this.databasePromise
  }
}

interface BrowserIndexedDbLocalDataSessionOptions {
  profileId: string
  localNodeId: string
  schemaVersion: number
  records: MutableLocalDataCollections
  documentStore: BrowserIndexedDbDocumentStore
  writerLock: BrowserStorageWriterLock
  nowMs: () => number
  closeBackendSession: () => void
}

export class BrowserIndexedDbLocalDataSession implements LocalDataSession {
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  readonly conversations: BrowserConversationRepository
  readonly memory: BrowserLightweightMemoryRepository
  readonly localTools: BrowserLocalToolStateRepository
  readonly peerGrants: BrowserPeerGrantMetadataRepository
  readonly localAudit: BrowserLocalAuditRepository
  readonly transcripts: BrowserTranscriptArchiveRepository
  private readonly documentStore: BrowserIndexedDbDocumentStore
  private readonly writerLock: BrowserStorageWriterLock
  private readonly nowMs: () => number
  private readonly closeBackendSession: () => void
  private collections: MutableLocalDataCollections
  private operationQueue: Promise<unknown> = Promise.resolve()
  private activeTransactionToken: TransactionToken | null = null
  private closed = false

  constructor(options: BrowserIndexedDbLocalDataSessionOptions) {
    this.profileId = options.profileId
    this.localNodeId = options.localNodeId
    this.schemaVersion = options.schemaVersion
    this.collections = options.records
    this.documentStore = options.documentStore
    this.writerLock = options.writerLock
    this.nowMs = options.nowMs
    this.closeBackendSession = options.closeBackendSession
    this.conversations = new BrowserConversationRepository(this, { kind: 'queued' })
    this.memory = new BrowserLightweightMemoryRepository(this, { kind: 'queued' })
    this.localTools = new BrowserLocalToolStateRepository(this, { kind: 'queued' })
    this.peerGrants = new BrowserPeerGrantMetadataRepository(this, { kind: 'queued' })
    this.localAudit = new BrowserLocalAuditRepository(this, { kind: 'queued' })
    this.transcripts = new BrowserTranscriptArchiveRepository(this, { kind: 'queued' })
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    if (this.activeTransactionToken !== null) throw transactionScopeError('nested_transaction')
    return await this.enqueueOperation(async () => {
      this.assertOpen()
      this.writerLock.assertWritable()
      const snapshot = cloneLocalDataCollections(this.collections)
      const token: TransactionToken = { active: true, dirty: false }
      this.activeTransactionToken = token
      try {
        const result = await work(this.createTransactionRepositories(token))
        if (token.dirty) await this.persist()
        return result
      } catch (error) {
        this.collections = snapshot
        throw error
      } finally {
        token.active = false
        if (this.activeTransactionToken === token) this.activeTransactionToken = null
      }
    })
  }

  async exportV1(): Promise<LocalDataExportV1> {
    return await this.enqueueOperation(() => {
      this.assertOpen()
      return buildLocalDataExportV1({
        sourceBackend: 'indexeddb',
        schemaVersion: this.schemaVersion,
        profileId: this.profileId,
        localNodeId: this.localNodeId,
        exportedAtMs: this.nowMs(),
        records: scopedCollections(this.collections, this.profileId, this.localNodeId)
      })
    })
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    return await this.enqueueOperation(async () => {
      this.assertOpen()
      this.writerLock.assertWritable()
  const parsed = parseLocalDataExportV1(document)
      if (parsed.profileId !== this.profileId || parsed.localNodeId !== this.localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the open session')
      }
      if (parsed.schemaVersion > this.schemaVersion) {
        throw new LocalDataError('invalid_record', 'Local data export schema is newer than the open session', { reason: 'future_schema' })
      }
      validateImportedCollections(parsed.records, this.profileId, this.localNodeId)
      assertNoScopedKeyCollisions(this.collections, parsed.records, this.profileId, this.localNodeId)
      const snapshot = cloneLocalDataCollections(this.collections)
      this.collections = replaceScopedCollections(this.collections, parsed.records, this.profileId, this.localNodeId)
      try {
        await this.persist()
      } catch (error) {
        this.collections = snapshot
        throw error
      }
      return {
        imported: true,
        recordCounts: parsed.recordCounts,
        collectionHashes: parsed.collectionHashes
      }
    })
  }

  async clear(): Promise<void> {
    await this.enqueueOperation(async () => {
      this.assertOpen()
      this.writerLock.assertWritable()
      this.collections = replaceScopedCollections(this.collections, emptyLocalDataCollections(), this.profileId, this.localNodeId)
      await this.persist()
    })
  }

  async close(): Promise<void> {
    await this.enqueueOperation(async () => {
      if (this.closed) return
      this.closed = true
      this.collections = emptyLocalDataCollections()
      await this.writerLock.release()
      await this.documentStore.close()
      this.closeBackendSession()
    })
  }

  assertOpen(): void {
    assertOpen(this.closed)
  }

  assertIdentity(profileId: string, localNodeId: string): void {
    if (profileId !== this.profileId || localNodeId !== this.localNodeId) {
      throw new LocalDataError('identity_mismatch', 'Local data record identity does not match the open session')
    }
  }

  get mutable(): MutableLocalDataCollections {
    this.assertOpen()
    return this.collections
  }

  canRecoverTranscriptSessions(): boolean {
    return this.writerLock.status.mode === 'web-locks'
  }

  async withRepositoryAccess<T>(access: RepositoryAccess, mutation: boolean, work: () => T | Promise<T>): Promise<T> {
    if (access.kind === 'transaction') {
      this.assertTransactionToken(access.token)
      this.assertOpen()
      if (mutation) {
        this.writerLock.assertWritable()
        access.token.dirty = true
      }
      return await work()
    }
    return await this.enqueueOperation(async () => {
      this.assertOpen()
      if (mutation) this.writerLock.assertWritable()
      const result = await work()
      if (mutation) await this.persist()
      return result
    })
  }

  private async enqueueOperation<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await work()
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return await result
  }

  private async persist(): Promise<void> {
    await this.writerLock.renew()
    await this.documentStore.save({
      formatVersion: 1,
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      schemaVersion: this.schemaVersion,
      migrationLedger: currentMigrationLedger(),
      records: cloneLocalDataCollections(this.collections)
    })
  }

  private createTransactionRepositories(token: TransactionToken): LocalDataRepositories {
    const access: RepositoryAccess = { kind: 'transaction', token }
    return {
      conversations: new BrowserConversationRepository(this, access),
      memory: new BrowserLightweightMemoryRepository(this, access),
      localTools: new BrowserLocalToolStateRepository(this, access),
      peerGrants: new BrowserPeerGrantMetadataRepository(this, access),
      localAudit: new BrowserLocalAuditRepository(this, access),
      transcripts: new BrowserTranscriptArchiveRepository(this, access)
    }
  }

  private assertTransactionToken(token: TransactionToken): void {
    if (!token.active || this.activeTransactionToken !== token) throw transactionScopeError('expired_transaction_repository')
  }
}

interface TransactionToken {
  active: boolean
  dirty: boolean
}

type RepositoryAccess =
  | { kind: 'queued' }
  | { kind: 'transaction'; token: TransactionToken }

export class BrowserTranscriptArchiveRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async createSession(input: TranscriptSessionRecord): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseTranscriptSessionRecord(input)
      assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      if (record.lifecycle !== 'active') throw transcriptError('transcript_create_requires_active')
      if (this.session.mutable.transcriptSessions.some((item) => item.id === record.id)) throw transcriptError('duplicate_transcript_session_id')
      if (this.session.mutable.transcriptSessions.length >= LOCAL_DATA_TRANSCRIPT_SESSION_LIMIT) throw transcriptError('transcript_session_limit')
      this.session.mutable.transcriptSessions.push(record)
      return clone(record)
    })
  }

  async startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const id = parseLocalDataId(sessionId, 'transcript.session_id')
      const start = requireTranscriptTimestamp(startedAtMs, 'transcript_started_at')
      const existing = this.findSession(id)
      if (existing === undefined) throw transcriptError('transcript_session_missing')
      if (existing.lifecycle !== 'active') throw new LocalDataError('session_closed', 'Transcript session is already terminal')
      if (start < existing.createdAtMs) throw transcriptError('transcript_started_before_created')
      const updated = parseTranscriptSessionRecord({ ...existing, startedAtMs: Math.min(existing.startedAtMs, start) })
      this.replaceSession(id, updated)
      return clone(updated)
    })
  }

  async appendSegment(input: TranscriptSegmentRecord): Promise<AppendTranscriptSegmentResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseTranscriptSegmentRecord(input)
      assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
      const parent = this.findSession(record.sessionId)
      if (parent === undefined) throw transcriptError('transcript_session_missing')
      const existing = this.session.mutable.transcriptSegments.find((item) => item.id === record.id)
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(record)) return { appended: false, record: clone(existing) }
        throw transcriptError('transcript_segment_replay_conflict')
      }
      if (parent.lifecycle !== 'active') throw new LocalDataError('session_closed', 'Transcript session is already terminal')
      if (record.startAtMs < parent.startedAtMs) throw transcriptError('transcript_segment_before_session')
      if (this.session.mutable.transcriptSegments.some((item) => item.sessionId === record.sessionId && item.sequence === record.sequence)) throw transcriptError('duplicate_transcript_sequence')
      if (this.session.mutable.transcriptSegments.length >= LOCAL_DATA_TRANSCRIPT_SEGMENT_LIMIT) throw transcriptError('transcript_segment_limit')
      this.session.mutable.transcriptSegments.push(record)
      return { appended: true, record: clone(record) }
    })
  }

  async getSession(sessionId: string): Promise<TranscriptSessionRecord | null> {
    const id = parseLocalDataId(sessionId, 'transcript.session_id')
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.findSession(id) ?? null))
  }

  async listSessions(options: TranscriptSessionListQuery = {}): Promise<TranscriptSessionRecord[]> {
    validateTranscriptSessionQuery(options)
    return await this.session.withRepositoryAccess(this.access, false, () => {
      return clone(this.session.mutable.transcriptSessions
        .filter((record) => record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs || compareUtf8(a.id, b.id))
        .filter((record) => options.cursor === undefined || record.createdAtMs < options.cursor.createdAtMs || (record.createdAtMs === options.cursor.createdAtMs && compareUtf8(record.id, options.cursor.id) > 0))
        .slice(0, options.limit ?? 100))
    })
  }

  async listSegments(sessionId: string, options: TranscriptSegmentListQuery = {}): Promise<TranscriptSegmentRecord[]> {
    const id = parseLocalDataId(sessionId, 'transcript.session_id')
    validateTranscriptSegmentQuery(options)
    return await this.session.withRepositoryAccess(this.access, false, () => {
      if (this.findSession(id) === undefined) return []
      return clone(this.session.mutable.transcriptSegments
        .filter((record) => record.sessionId === id && (options.afterSequence === undefined || record.sequence > options.afterSequence))
        .sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id))
        .slice(0, options.limit ?? 500))
    })
  }

  async finalizeSession(input: FinalizeTranscriptSessionInput): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const id = parseLocalDataId(input.sessionId, 'transcript.session_id')
      if (input.lifecycle !== 'completed' && input.lifecycle !== 'interrupted' && input.lifecycle !== 'failed') throw transcriptError('transcript_lifecycle')
      const endedAtMs = requireTranscriptTimestamp(input.endedAtMs, 'transcript_ended_at')
      const existing = this.findSession(id)
      if (existing === undefined) throw transcriptError('transcript_session_missing')
      if (existing.lifecycle !== 'active') {
        if (existing.lifecycle === input.lifecycle && existing.endedAtMs === endedAtMs && existing.terminalReason === input.terminalReason) return clone(existing)
        throw new LocalDataError('session_closed', 'Transcript session is already terminal')
      }
      const updated = parseTranscriptSessionRecord({ ...existing, lifecycle: input.lifecycle, endedAtMs, terminalReason: input.terminalReason })
      this.replaceSession(id, updated)
      return clone(updated)
    })
  }

  async recoverActiveSessions(nowMs: number, terminalReason = 'process_restart'): Promise<RecoverTranscriptSessionsResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const endedAtMs = requireTranscriptTimestamp(nowMs, 'transcript_recovery_now')
      const hasActiveSessions = this.session.mutable.transcriptSessions.some((record) => record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId && record.lifecycle === 'active')
      if (!this.session.canRecoverTranscriptSessions() && hasActiveSessions) {
        throw new LocalDataError('unsupported_backend', 'Transcript recovery requires exclusive browser ownership', { reason: 'owner_exists' })
      }
      let interrupted = 0
      for (const record of this.session.mutable.transcriptSessions) {
        if (record.profileId !== this.session.profileId || record.localNodeId !== this.session.localNodeId || record.lifecycle !== 'active') continue
        this.replaceSession(record.id, parseTranscriptSessionRecord({
          ...record,
          endedAtMs: Math.max(endedAtMs, record.startedAtMs),
          lifecycle: 'interrupted',
          terminalReason
        }))
        interrupted += 1
      }
      return { interrupted }
    })
  }

  async deleteSession(sessionId: string): Promise<DeleteTranscriptSessionResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const id = parseLocalDataId(sessionId, 'transcript.session_id')
      const index = this.session.mutable.transcriptSessions.findIndex((record) => record.id === id && record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId)
      if (index < 0) return { deleted: false, deletedSegments: 0 }
      this.session.mutable.transcriptSessions.splice(index, 1)
      const before = this.session.mutable.transcriptSegments.length
      this.session.mutable.transcriptSegments = this.session.mutable.transcriptSegments.filter((record) => record.sessionId !== id)
      return { deleted: true, deletedSegments: before - this.session.mutable.transcriptSegments.length }
    })
  }

  async deleteExpiredSessions(nowMs: number, limit: number): Promise<DeleteExpiredTranscriptSessionsResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const cutoffMs = requireTranscriptTimestamp(nowMs, 'transcript_delete_now')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOCAL_DATA_TRANSCRIPT_DELETE_LIMIT) throw transcriptError('transcript_delete_limit')
      const expiredIds = this.session.mutable.transcriptSessions
        .filter((record) => record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId && record.expiresAtMs !== null && record.expiresAtMs <= cutoffMs)
        .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || compareUtf8(a.id, b.id))
        .slice(0, limit)
        .map((record) => record.id)
      const expired = new Set(expiredIds)
      this.session.mutable.transcriptSessions = this.session.mutable.transcriptSessions.filter((record) => !expired.has(record.id))
      const before = this.session.mutable.transcriptSegments.length
      this.session.mutable.transcriptSegments = this.session.mutable.transcriptSegments.filter((record) => !expired.has(record.sessionId))
      return { deletedSessions: expired.size, deletedSegments: before - this.session.mutable.transcriptSegments.length }
    })
  }

  private findSession(id: string): TranscriptSessionRecord | undefined {
    return this.session.mutable.transcriptSessions.find((record) => record.id === id && record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId)
  }

  private replaceSession(id: string, record: TranscriptSessionRecord): void {
    const index = this.session.mutable.transcriptSessions.findIndex((item) => item.id === id)
    if (index < 0) throw transcriptError('transcript_session_missing')
    this.session.mutable.transcriptSessions[index] = record
  }
}

export class BrowserConversationRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async upsertConversation(input: ConversationRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseConversationRecord(input)
      assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      assertNoScopedKeyCollision(
        this.session.mutable.conversations.find((item) => item.id === record.id),
        this.session.profileId,
        this.session.localNodeId
      )
      upsert(this.session.mutable.conversations, record, (item) => item.id === record.id)
    })
  }

  async appendMessage(input: ConversationMessageRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseConversationMessageRecord(input)
      assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
      if (!this.session.mutable.conversations.some((conversation) =>
        conversation.id === record.conversationId
        && conversation.profileId === this.session.profileId
        && conversation.localNodeId === this.session.localNodeId
      )) {
        throw new LocalDataError('invalid_record', 'Message conversation does not exist')
      }
      if (this.session.mutable.messages.some((message) => message.conversationId === record.conversationId && message.sequence === record.sequence && message.id !== record.id)) {
        throw new LocalDataError('invalid_record', 'Message sequence must be unique within a conversation', { reason: 'duplicate_message_sequence' })
      }
      assertNoMessageIdCollision(this.session.mutable, record, this.session.profileId, this.session.localNodeId)
      upsert(this.session.mutable.messages, record, (item) => item.id === record.id)
    })
  }

  async deleteConversation(conversationId: string): Promise<DeleteConversationResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const conversationIndex = this.session.mutable.conversations.findIndex((conversation) =>
        conversation.id === conversationId
        && conversation.profileId === this.session.profileId
        && conversation.localNodeId === this.session.localNodeId
      )
      if (conversationIndex === -1) return { deleted: false, deletedMessages: 0 }
      this.session.mutable.conversations.splice(conversationIndex, 1)
      let deletedMessages = 0
      this.session.mutable.messages = this.session.mutable.messages.filter((message) => {
        if (message.conversationId !== conversationId) return true
        deletedMessages += 1
        return false
      })
      return { deleted: true, deletedMessages }
    })
  }

  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    parseLocalDataId(conversationId, 'query.conversation_id')
    return await this.session.withRepositoryAccess(this.access, false, () => clone(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId).find((record) => record.id === conversationId) ?? null))
  }

  async getMessage(conversationId: string, messageId: string): Promise<ConversationMessageRecord | null> {
    parseLocalDataId(conversationId, 'query.conversation_id'); parseLocalDataId(messageId, 'query.message_id')
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const scoped = this.session.mutable.conversations.some((record) => record.id === conversationId && record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId)
      return scoped ? clone(this.session.mutable.messages.find((record) => record.conversationId === conversationId && record.id === messageId) ?? null) : null
    })
  }

  async getLatestMessageSequence(conversationId: string): Promise<number | null> {
    parseLocalDataId(conversationId, 'query.conversation_id')
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const scoped = this.session.mutable.conversations.some((record) => record.id === conversationId && record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId)
      if (!scoped) return null
      const values = this.session.mutable.messages.filter((record) => record.conversationId === conversationId).map((record) => record.sequence)
      return values.reduce<number | null>((latest, value) => latest === null || value > latest ? value : latest, null)
    })
  }

  async listConversations(options?: ConversationListQuery): Promise<ConversationRecord[]> {
    if (options !== undefined && hasQueryOptions(options)) validateConversationQuery(options)
    return await this.session.withRepositoryAccess(this.access, false, () => {
      let records = scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId)
      if (options !== undefined && hasQueryOptions(options)) {
        records = records.filter((record) => options.includeArchived !== false || record.archivedAtMs === null).filter((record) => options.cursor === undefined || record.updatedAtMs < options.cursor.updatedAtMs || (record.updatedAtMs === options.cursor.updatedAtMs && compareUtf8(record.id, options.cursor.id) > 0)).sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id))
        if (options.limit !== undefined) records = records.slice(0, options.limit)
      }
      records = records.sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id))
      return clone(records)
    })
  }

  async listMessageCounts(conversationIds?: readonly string[]): Promise<Record<string, number>> {
    if (conversationIds !== undefined) { validateConversationIds(conversationIds); if (conversationIds.length === 0) return {} }
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const counts: Record<string, number> = {}
      const allowed = new Set(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId).map((conversation) => conversation.id))
      const selected = conversationIds === undefined ? allowed : boundedIds(conversationIds, allowed)
      for (const message of this.session.mutable.messages) {
        if (!selected.has(message.conversationId)) continue
        counts[message.conversationId] = (counts[message.conversationId] ?? 0) + 1
      }
      return counts
    })
  }

  async listFirstUserMessages(conversationIds?: readonly string[]): Promise<Record<string, ConversationMessageRecord>> {
    if (conversationIds !== undefined) { validateConversationIds(conversationIds); if (conversationIds.length === 0) return {} }
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const allowed = new Set(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId).map((conversation) => conversation.id))
      const selectedConversationIds = conversationIds === undefined ? allowed : boundedIds(conversationIds, allowed)
      const firstByConversation = new Map<string, ConversationMessageRecord>()
      for (const message of this.session.mutable.messages) {
        if (message.role !== 'user' || !selectedConversationIds.has(message.conversationId)) continue
        const current = firstByConversation.get(message.conversationId)
        if (current === undefined || message.sequence < current.sequence || (message.sequence === current.sequence && compareUtf8(message.id, current.id) < 0)) {
          firstByConversation.set(message.conversationId, message)
        }
      }
      return Object.fromEntries(Array.from(firstByConversation.entries(), ([conversationId, message]) => [conversationId, clone(message)]))
    })
  }

  async listMessages(conversationId: string, options?: MessageListQuery): Promise<ConversationMessageRecord[]> {
    parseLocalDataId(conversationId, 'query.conversation_id'); if (options !== undefined && hasQueryOptions(options)) validateMessageQuery(options)
    return await this.session.withRepositoryAccess(this.access, false, () => {
      if (!this.session.mutable.conversations.some((conversation) => conversation.id === conversationId && conversation.profileId === this.session.profileId && conversation.localNodeId === this.session.localNodeId)) return []
      let records = this.session.mutable.messages.filter((message) => message.conversationId === conversationId && (options?.afterSequence === undefined || message.sequence > options.afterSequence) && (options?.beforeSequence === undefined || message.sequence < options.beforeSequence))
        .sort((a, b) => (options?.direction === 'desc' ? b.sequence - a.sequence : a.sequence - b.sequence) || compareUtf8(a.id, b.id))
      if (options !== undefined && hasQueryOptions(options) && options.limit !== undefined) records = records.slice(0, options.limit)
      return clone(records)
    })
  }
}

export class BrowserLightweightMemoryRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async upsertMemoryItem(input: LightweightMemoryRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseLightweightMemoryRecord(input)
      assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      assertNoScopedKeyCollision(
        this.session.mutable.memoryItems.find((item) => item.id === record.id),
        this.session.profileId,
        this.session.localNodeId
      )
      upsert(this.session.mutable.memoryItems, record, (item) => item.id === record.id)
    })
  }

  async deleteMemoryItem(memoryItemId: string): Promise<DeleteRecordResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const before = this.session.mutable.memoryItems.length
      this.session.mutable.memoryItems = this.session.mutable.memoryItems.filter((record) =>
        record.id !== memoryItemId
        || record.profileId !== this.session.profileId
        || record.localNodeId !== this.session.localNodeId
      )
      return { deleted: this.session.mutable.memoryItems.length !== before }
    })
  }

  async deleteExpiredMemoryItems(scope: LocalDataScope, nowMs: number, limit: number): Promise<DeleteExpiredMemoryItemsResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      this.session.assertIdentity(scope.profileId, scope.localNodeId)
      const cutoffMs = requireDeleteNowMs(nowMs)
      const normalizedLimit = requireDeleteLimit(limit)
      const expiredIds = this.session.mutable.memoryItems
        .filter((record) =>
          record.profileId === scope.profileId
          && record.localNodeId === scope.localNodeId
          && record.expiresAtMs !== null
          && record.expiresAtMs <= cutoffMs
        )
        .sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || compareUtf8(a.id, b.id))
        .slice(0, normalizedLimit)
        .map((record) => record.id)
      const expiredIdSet = new Set(expiredIds)
      this.session.mutable.memoryItems = this.session.mutable.memoryItems.filter((record) => !expiredIdSet.has(record.id))
      return { deleted: expiredIdSet.size }
    })
  }

  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.memoryItems.filter((record) =>
      record.profileId === this.session.profileId
      && record.localNodeId === this.session.localNodeId
      && (namespace === undefined || record.namespace === namespace)
    ))
      .sort((a, b) => compareUtf8(a.namespace, b.namespace) || compareUtf8(a.id, b.id)))
  }
}

export class BrowserLocalToolStateRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async upsertLocalToolState(input: LocalToolStateRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseLocalToolStateRecord(input)
      assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      upsert(this.session.mutable.localToolStates, record, (item) => item.profileId === record.profileId && item.localNodeId === record.localNodeId && item.toolContractId === record.toolContractId)
    })
  }

  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.localToolStates.filter((record) =>
      record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId
    )).sort((a, b) => compareUtf8(a.toolContractId, b.toolContractId)))
  }
}

export class BrowserPeerGrantMetadataRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async upsertPeerGrant(input: PeerGrantMetadataRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parsePeerGrantMetadataRecord(input)
      assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      assertNoScopedKeyCollision(
        this.session.mutable.peerGrantMetadata.find((item) => item.grantId === record.grantId),
        this.session.profileId,
        this.session.localNodeId
      )
      upsert(this.session.mutable.peerGrantMetadata, record, (item) => item.grantId === record.grantId)
    })
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.peerGrantMetadata.filter((record) =>
      record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId
    )).sort((a, b) => compareUtf8(a.claimantPeerId, b.claimantPeerId) || compareUtf8(a.tokenId, b.tokenId)))
  }
}

export class BrowserLocalAuditRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async appendAudit(input: LocalAuditRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseLocalAuditRecord(input)
      assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      assertNoScopedKeyCollision(
        this.session.mutable.localAudit.find((item) => item.id === record.id),
        this.session.profileId,
        this.session.localNodeId
      )
      if (this.session.mutable.localAudit.some((item) => item.id === record.id)) {
        throw new LocalDataError('invalid_record', 'Audit record IDs must be unique')
      }
      this.session.mutable.localAudit.push(record)
    })
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.localAudit.filter((record) =>
      record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId
    )).sort((a, b) => b.createdAtMs - a.createdAtMs || compareUtf8(a.id, b.id)))
  }
}

export function deriveBrowserLocalDataDatabaseName(origin: string, localNodeId: string): string {
  return deriveBrowserStorageOwnerKey(origin, localNodeId).replace('aurora:browser-local-data:', 'aurora-local-data-')
}

function safeDefaultLeaseStore(indexedDB: IDBFactory | undefined): BrowserStorageLeaseStore | null {
  try {
    return new IndexedDbBrowserStorageLeaseStore({
      ...(indexedDB === undefined ? {} : { indexedDB })
    })
  } catch {
    return null
  }
}

function parseStoredDocument(value: unknown): StoredBrowserLocalDataDocument | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalDataError('invalid_record', 'Browser local data document is invalid', { reason: 'document_shape' })
  }
  const record = value as Partial<StoredBrowserLocalDataDocument>
  if (record.formatVersion !== 1) throw new LocalDataError('invalid_record', 'Browser local data document version is unsupported', { reason: 'document_version' })
  const schemaVersion = requireSafeVersion(record.schemaVersion)
  const rawCollections = record.records
  if (rawCollections === null || typeof rawCollections !== 'object' || Array.isArray(rawCollections)) {
    throw new LocalDataError('migration_integrity', 'Browser local data records are invalid')
  }
  const collections = rawCollections as Record<string, unknown>
  const hasTranscriptSessions = collections.transcriptSessions !== undefined
  const hasTranscriptSegments = collections.transcriptSegments !== undefined
  let normalizedCollections = rawCollections as LocalDataRecordCollections
  if (schemaVersion < localDataMigrationManifest.latestVersion && !hasTranscriptSessions && !hasTranscriptSegments) {
    normalizedCollections = {
      ...collections,
      transcriptSessions: [],
      transcriptSegments: []
    } as unknown as LocalDataRecordCollections
  } else if (!hasTranscriptSessions || !hasTranscriptSegments) {
    throw new LocalDataError('migration_integrity', 'Browser local data transcript collections are incomplete')
  }
  return {
    formatVersion: 1,
    profileId: parseLocalDataId(record.profileId, 'identity.profile'),
    localNodeId: parseLocalDataId(record.localNodeId, 'identity.local_node'),
    schemaVersion,
    migrationLedger: requireMigrationLedger(record.migrationLedger),
    records: cloneLocalDataCollections(normalizedCollections)
  }
}

function createStoredDocument(profileId: string, localNodeId: string): StoredBrowserLocalDataDocument {
  return {
    formatVersion: 1,
    profileId,
    localNodeId,
    schemaVersion: localDataMigrationManifest.latestVersion,
    migrationLedger: currentMigrationLedger(),
    records: emptyLocalDataCollections()
  }
}

function currentMigrationLedger(): Array<{ readonly version: number; readonly checksum: string }> {
  return localDataMigrationManifest.migrations.map((migration) => ({
    version: migration.version,
    checksum: migration.checksum
  }))
}

function requireMigrationLedger(value: unknown): Array<{ readonly version: number; readonly checksum: string }> {
  if (!Array.isArray(value)) throw new LocalDataError('migration_integrity', 'Browser local data migration state is invalid')
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new LocalDataError('migration_integrity', 'Browser local data migration entry is invalid')
    }
    const record = item as { version?: unknown; checksum?: unknown }
    if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version)) {
      throw new LocalDataError('migration_integrity', 'Browser local data migration version is invalid')
    }
    if (typeof record.checksum !== 'string') {
      throw new LocalDataError('migration_integrity', 'Browser local data migration checksum is invalid')
    }
    return { version: record.version, checksum: record.checksum }
  })
}

function requireSafeVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalDataError('invalid_record', 'Browser local data schema version is invalid', { reason: 'schema_version' })
  }
  return value
}

function validateImportedCollections(records: LocalDataRecordCollections, profileId: string, localNodeId: string): void {
  const conversationIds = requireUnique(records.conversations.map((record) => record.id), 'duplicate_conversation_id')
  requireUnique(records.messages.map((record) => record.id), 'duplicate_message_id')
  requireUnique(records.memoryItems.map((record) => record.id), 'duplicate_memory_id')
  requireUnique(records.localToolStates.map((record) => `${record.profileId}\u0000${record.localNodeId}\u0000${record.toolContractId}`), 'duplicate_tool_state')
  requireUnique(records.peerGrantMetadata.map((record) => record.grantId), 'duplicate_grant_id')
  requireUnique(records.localAudit.map((record) => record.id), 'duplicate_audit_id')
  requireUnique(records.transcriptSessions.map((record) => record.id), 'duplicate_transcript_session_id')
  requireUnique(records.transcriptSegments.map((record) => record.id), 'duplicate_transcript_segment_id')
  for (const record of records.conversations) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
  for (const record of records.messages) assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
  for (const record of records.memoryItems) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
  for (const record of records.localToolStates) assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
  for (const record of records.peerGrantMetadata) assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
  for (const record of records.localAudit) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
  for (const record of records.transcriptSessions) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
  for (const record of records.transcriptSegments) assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
  for (const record of records.conversations) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.memoryItems) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localToolStates) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.peerGrantMetadata) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localAudit) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.transcriptSessions) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  const sessionIds = new Set(records.transcriptSessions.map((record) => record.id))
  const transcriptSequences = new Set<string>()
  for (const record of records.transcriptSegments) {
    if (!sessionIds.has(record.sessionId)) throw transcriptError('transcript_segment_session_missing')
    const sequenceKey = `${record.sessionId}\u0000${record.sequence}`
    if (transcriptSequences.has(sequenceKey)) throw transcriptError('duplicate_transcript_sequence')
    transcriptSequences.add(sequenceKey)
  }
  const messageSequences = new Set<string>()
  for (const record of records.messages) {
    if (!conversationIds.has(record.conversationId)) {
      throw new LocalDataError('invalid_record', 'Imported message conversation does not exist', { reason: 'message_conversation_missing' })
    }
    const sequenceKey = `${record.conversationId}\u0000${record.sequence}`
    if (messageSequences.has(sequenceKey)) {
      throw new LocalDataError('invalid_record', 'Imported message sequence must be unique within a conversation', { reason: 'duplicate_message_sequence' })
    }
    messageSequences.add(sequenceKey)
  }
}

function validateStoredCollectionsForLocalNode(records: LocalDataRecordCollections, localNodeId: string): void {
  validateCollectionShape(records)
  for (const record of records.conversations) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.memoryItems) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.localToolStates) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.peerGrantMetadata) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.localAudit) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.transcriptSessions) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
}

function validateCollectionShape(records: LocalDataRecordCollections): void {
  const conversationIds = requireUnique(records.conversations.map((record) => record.id), 'duplicate_conversation_id')
  requireUnique(records.messages.map((record) => record.id), 'duplicate_message_id')
  requireUnique(records.memoryItems.map((record) => record.id), 'duplicate_memory_id')
  requireUnique(records.localToolStates.map((record) => `${record.profileId}\u0000${record.localNodeId}\u0000${record.toolContractId}`), 'duplicate_tool_state')
  requireUnique(records.peerGrantMetadata.map((record) => record.grantId), 'duplicate_grant_id')
  requireUnique(records.localAudit.map((record) => record.id), 'duplicate_audit_id')
  requireUnique(records.transcriptSessions.map((record) => record.id), 'duplicate_transcript_session_id')
  requireUnique(records.transcriptSegments.map((record) => record.id), 'duplicate_transcript_segment_id')
  for (const record of records.conversations) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
  for (const record of records.messages) assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
  for (const record of records.memoryItems) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
  for (const record of records.localToolStates) assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
  for (const record of records.peerGrantMetadata) assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
  for (const record of records.localAudit) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
  for (const record of records.transcriptSessions) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
  for (const record of records.transcriptSegments) assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
  const messageSequences = new Set<string>()
  for (const record of records.messages) {
    if (!conversationIds.has(record.conversationId)) {
      throw new LocalDataError('invalid_record', 'Imported message conversation does not exist', { reason: 'message_conversation_missing' })
    }
    const sequenceKey = `${record.conversationId}\u0000${record.sequence}`
    if (messageSequences.has(sequenceKey)) {
      throw new LocalDataError('invalid_record', 'Imported message sequence must be unique within a conversation', { reason: 'duplicate_message_sequence' })
    }
    messageSequences.add(sequenceKey)
  }
  const transcriptSessionIds = new Set(records.transcriptSessions.map((record) => record.id))
  const transcriptSequences = new Set<string>()
  for (const record of records.transcriptSegments) {
    if (!transcriptSessionIds.has(record.sessionId)) throw transcriptError('transcript_segment_session_missing')
    const sequenceKey = `${record.sessionId}\u0000${record.sequence}`
    if (transcriptSequences.has(sequenceKey)) throw transcriptError('duplicate_transcript_sequence')
    transcriptSequences.add(sequenceKey)
  }
}

function requireStoredRecordLocalNode(recordLocalNodeId: string, localNodeId: string): void {
  if (recordLocalNodeId !== localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Browser local data local node does not match stored local data', { reason: 'local_node_owner_mismatch' })
  }
}

function assertNoScopedKeyCollisions(
  current: LocalDataRecordCollections,
  incoming: LocalDataRecordCollections,
  profileId: string,
  localNodeId: string
): void {
  for (const record of incoming.conversations) {
    assertNoScopedKeyCollision(current.conversations.find((item) => item.id === record.id), profileId, localNodeId)
  }
  for (const record of incoming.messages) {
    assertNoMessageIdCollision(current, record, profileId, localNodeId)
  }
  for (const record of incoming.memoryItems) {
    assertNoScopedKeyCollision(current.memoryItems.find((item) => item.id === record.id), profileId, localNodeId)
  }
  for (const record of incoming.peerGrantMetadata) {
    assertNoScopedKeyCollision(current.peerGrantMetadata.find((item) => item.grantId === record.grantId), profileId, localNodeId)
  }
  for (const record of incoming.localAudit) {
    assertNoScopedKeyCollision(current.localAudit.find((item) => item.id === record.id), profileId, localNodeId)
  }
  for (const record of incoming.transcriptSessions) {
    assertNoScopedKeyCollision(current.transcriptSessions.find((item) => item.id === record.id), profileId, localNodeId)
  }
  for (const record of incoming.transcriptSegments) {
    const existing = current.transcriptSegments.find((item) => item.id === record.id)
    if (existing !== undefined && existing.sessionId !== record.sessionId) throw scopedKeyCollision()
  }
}

function assertNoScopedKeyCollision(
  existing: { readonly profileId: string; readonly localNodeId: string } | undefined,
  profileId: string,
  localNodeId: string
): void {
  if (existing !== undefined && (existing.profileId !== profileId || existing.localNodeId !== localNodeId)) {
    throw scopedKeyCollision()
  }
}

function assertNoMessageIdCollision(
  records: LocalDataRecordCollections,
  record: ConversationMessageRecord,
  profileId: string,
  localNodeId: string
): void {
  const existing = records.messages.find((item) => item.id === record.id)
  if (existing === undefined) return
  if (existing.conversationId === record.conversationId) return
  const existingConversation = records.conversations.find((item) => item.id === existing.conversationId)
  if (existingConversation === undefined || existingConversation.profileId !== profileId || existingConversation.localNodeId !== localNodeId) {
    throw scopedKeyCollision()
  }
    throw new LocalDataError('invalid_record', 'Message IDs must be unique', { reason: 'duplicate_message_id' })
}

function scopedKeyCollision(): LocalDataError {
  return new LocalDataError('identity_mismatch', 'Local data record ID is already owned by another profile on this device', { reason: 'profile_scope_collision' })
}

function requireRecordIdentity(recordProfileId: string, recordLocalNodeId: string, profileId: string, localNodeId: string): void {
  if (recordProfileId !== profileId || recordLocalNodeId !== localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Imported local data record identity does not match the open session')
  }
}

function requireUnique(values: string[], reason: string): Set<string> {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new LocalDataError('invalid_record', 'Imported local data records must have unique repository keys', { reason })
    seen.add(value)
  }
  return seen
}

function assertSafeLocalDataIds(values: string[], boundaryId: string): void {
  for (const value of values) {
    if (value.includes('..') || value.includes('\\') || /\.db(?:$|[/?#])/iu.test(value) || /(?:^|[/])python(?:$|[/])/iu.test(value) || /(?:^|[/])app[/]services(?:$|[/])/iu.test(value)) {
      throw new LocalDataError('invalid_record', `Invalid local data boundary: ${boundaryId}`, {
        boundaryId,
        validation: 'redacted',
        issues: [{ code: 'hostile_identifier', path: '' }]
      })
    }
  }
}

function scopedCollections(records: LocalDataRecordCollections, profileId: string, localNodeId: string): LocalDataRecordCollections {
  const conversations = scopedConversations(records, profileId, localNodeId)
  const conversationIds = new Set(conversations.map((record) => record.id))
  const transcriptSessions = records.transcriptSessions.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId)
  const transcriptSessionIds = new Set(transcriptSessions.map((record) => record.id))
  return {
    conversations,
    messages: records.messages.filter((record) => conversationIds.has(record.conversationId)),
    memoryItems: records.memoryItems.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    localToolStates: records.localToolStates.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    peerGrantMetadata: records.peerGrantMetadata.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    localAudit: records.localAudit.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    transcriptSessions,
    transcriptSegments: records.transcriptSegments.filter((record) => transcriptSessionIds.has(record.sessionId))
  }
}

function scopedConversations(records: LocalDataRecordCollections, profileId: string, localNodeId: string): ConversationRecord[] {
  return records.conversations.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId)
}

function replaceScopedCollections(
  current: LocalDataRecordCollections,
  replacement: LocalDataRecordCollections,
  profileId: string,
  localNodeId: string
): MutableLocalDataCollections {
  const scopedConversationIds = new Set(scopedConversations(current, profileId, localNodeId).map((record) => record.id))
  const scopedTranscriptSessionIds = new Set(current.transcriptSessions
    .filter((record) => record.profileId === profileId && record.localNodeId === localNodeId)
    .map((record) => record.id))
  return cloneLocalDataCollections({
    conversations: [
      ...current.conversations.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.conversations
    ],
    messages: [
      ...current.messages.filter((record) => !scopedConversationIds.has(record.conversationId)),
      ...replacement.messages
    ],
    memoryItems: [
      ...current.memoryItems.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.memoryItems
    ],
    localToolStates: [
      ...current.localToolStates.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.localToolStates
    ],
    peerGrantMetadata: [
      ...current.peerGrantMetadata.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.peerGrantMetadata
    ],
    localAudit: [
      ...current.localAudit.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.localAudit
    ],
    transcriptSessions: [
      ...current.transcriptSessions.filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...replacement.transcriptSessions
    ],
    transcriptSegments: [
      ...current.transcriptSegments.filter((record) => !scopedTranscriptSessionIds.has(record.sessionId)),
      ...replacement.transcriptSegments
    ]
  })
}

function emptyLocalDataCollections(): MutableLocalDataCollections {
  return {
    conversations: [],
    messages: [],
    memoryItems: [],
    localToolStates: [],
    peerGrantMetadata: [],
    localAudit: [],
    transcriptSessions: [],
    transcriptSegments: []
  }
}

function cloneLocalDataCollections(collections: LocalDataRecordCollections): MutableLocalDataCollections {
  return {
    conversations: collections.conversations.map((record) => structuredClone(record)),
    messages: collections.messages.map((record) => structuredClone(record)),
    memoryItems: collections.memoryItems.map((record) => structuredClone(record)),
    localToolStates: collections.localToolStates.map((record) => structuredClone(record)),
    peerGrantMetadata: collections.peerGrantMetadata.map((record) => structuredClone(record)),
    localAudit: collections.localAudit.map((record) => structuredClone(record)),
    transcriptSessions: collections.transcriptSessions.map((record) => structuredClone(record)),
    transcriptSegments: collections.transcriptSegments.map((record) => structuredClone(record))
  }
}

function upsert<T>(items: T[], record: T, predicate: (item: T) => boolean): void {
  const index = items.findIndex(predicate)
  if (index === -1) items.push(record)
  else items[index] = record
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireDeleteNowMs(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new LocalDataError('invalid_record', 'Delete cutoff must be a non-negative safe integer', { reason: 'delete_now_ms' })
  }
  return nowMs
}

function requireDeleteLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new LocalDataError('invalid_record', 'Delete limit must be a positive safe integer', { reason: 'delete_limit' })
  }
  return limit
}

function requireTranscriptTimestamp(value: number, reason: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw transcriptError(reason)
  return value
}

function validateTranscriptSessionQuery(options: TranscriptSessionListQuery): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_TRANSCRIPT_SESSION_QUERY_MAX)) throw transcriptError('transcript_session_limit')
  if (options.cursor !== undefined) {
    requireTranscriptTimestamp(options.cursor.createdAtMs, 'transcript_session_cursor_created_at')
    parseLocalDataId(options.cursor.id, 'transcript_session_cursor_id')
  }
}

function validateTranscriptSegmentQuery(options: TranscriptSegmentListQuery): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_TRANSCRIPT_SEGMENT_QUERY_MAX)) throw transcriptError('transcript_segment_limit')
  if (options.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0 || Object.is(options.afterSequence, -0))) throw transcriptError('transcript_segment_after_sequence')
}

function transcriptError(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Invalid transcript archive operation', { reason })
}

function validateConversationQuery(options: ConversationListQuery): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 501)) throw new LocalDataError('invalid_record', 'Invalid conversation query', { reason: 'conversation_limit' })
  if (typeof options.includeArchived !== 'boolean' && options.includeArchived !== undefined) throw new LocalDataError('invalid_record', 'Invalid archive filter', { reason: 'include_archived' })
  if (options.cursor !== undefined) {
    if (!Number.isSafeInteger(options.cursor.updatedAtMs) || options.cursor.updatedAtMs < 0 || Object.is(options.cursor.updatedAtMs, -0)) throw new LocalDataError('invalid_record', 'Invalid conversation cursor timestamp', { reason: 'conversation_cursor_updated_at' })
    parseLocalDataId(options.cursor.id, 'conversation_cursor_id')
  }
}

function validateMessageQuery(options: MessageListQuery): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 2001)) throw new LocalDataError('invalid_record', 'Invalid message query', { reason: 'message_limit' })
  if (options.beforeSequence !== undefined && options.afterSequence !== undefined) throw new LocalDataError('invalid_record', 'Message bounds are ambiguous', { reason: 'ambiguous_message_cursor' })
  if (options.beforeSequence !== undefined && (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 0)) throw new LocalDataError('invalid_record', 'Invalid message bound', { reason: 'message_before_sequence' })
  if (options.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)) throw new LocalDataError('invalid_record', 'Invalid message bound', { reason: 'message_after_sequence' })
  if (options.direction !== undefined && options.direction !== 'asc' && options.direction !== 'desc') throw new LocalDataError('invalid_record', 'Invalid message direction', { reason: 'message_direction' })
}
function hasQueryOptions(options: object): boolean { return Object.values(options).some((value) => value !== undefined) }

function boundedIds(ids: readonly string[], allowed: Set<string>): Set<string> {
  validateConversationIds(ids)
  if (ids.length === 0) return new Set()
  return new Set(ids.filter((id) => allowed.has(id)))
}

function validateConversationIds(ids: readonly string[]): void {
  if (ids.length > 500) throw new LocalDataError('invalid_record', 'Invalid conversation ID set', { reason: 'conversation_id_set_limit' })
  if (ids.some((id) => !localDataIdSchema.safeParse(id).success)) throw new LocalDataError('invalid_record', 'Invalid conversation ID set', { reason: 'conversation_id_set' })
}

function transactionScopeError(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Invalid local data boundary: transaction.scope', {
    boundaryId: 'transaction.scope',
    validation: 'redacted',
    issues: [{ code: reason, path: '' }]
  })
}

function parseLocalDataId(value: unknown, boundaryId: string): string {
  const parsed = localDataIdSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new LocalDataError('invalid_record', `Invalid local data boundary: ${boundaryId}`, {
    boundaryId,
    validation: 'redacted',
    issues: parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map((item) => String(item)).join('.')
    }))
  })
}

function canonicalOrigin(origin: string | undefined): string {
  const candidate = origin ?? globalThis.location?.origin ?? 'browser://unknown'
  try {
    return new URL(candidate).origin
  } catch {
    return candidate
  }
}
