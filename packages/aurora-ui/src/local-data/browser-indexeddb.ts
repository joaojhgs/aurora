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
  parseTranscriptSegmentRecord,
  parseTranscriptSessionRecord,
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
  type MutableLocalDataCollections,
  type PeerGrantMetadataRecord,
  type TranscriptAppendResult,
  type TranscriptLifecycle,
  type TranscriptRecoveryResult,
  type TranscriptRetentionResult,
  type TranscriptSegmentRecord,
  type TranscriptSessionRecord
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
  private opening: { readonly profileId: string; readonly localNodeId: string; readonly promise: Promise<LocalDataSession> } | null = null
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

    if (this.opening !== null) {
      if (this.opening.profileId !== canonicalProfileId || this.opening.localNodeId !== canonicalLocalNodeId) {
        throw new LocalDataError('unsupported_backend', 'Browser local data is already opening for another identity', { reason: 'owner_exists' })
      }
      return await this.opening.promise
    }

    const promise = this.openReady(canonicalProfileId, canonicalLocalNodeId)
    this.opening = { profileId: canonicalProfileId, localNodeId: canonicalLocalNodeId, promise }
    try {
      return await promise
    } finally {
      if (this.opening?.promise === promise) this.opening = null
    }
  }

  private async openReady(canonicalProfileId: string, canonicalLocalNodeId: string): Promise<LocalDataSession> {

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
    let provisionalSession: BrowserIndexedDbLocalDataSession | null = null
    try {
      const document = await this.openDocument(documentStore, canonicalProfileId, canonicalLocalNodeId)
      provisionalSession = new BrowserIndexedDbLocalDataSession({
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
      await provisionalSession.recoverActiveTranscripts(this.nowMs())
      if (this.closed) throw new LocalDataError('session_closed', 'Browser local data backend is closed')
      this.session = provisionalSession
      this.lastStatus = {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: canonicalProfileId,
        schemaVersion: localDataMigrationManifest.latestVersion,
        migrationState: 'idle'
      }
      return provisionalSession
    } catch (error) {
      if (provisionalSession !== null) {
        await provisionalSession.close().catch(() => undefined)
      } else {
        await writerLock.release().catch(() => undefined)
        await documentStore.close().catch(() => undefined)
      }
      this.session = null
      const degradedReason = error instanceof LocalDataError ? error.metadata?.reason : 'open_failed'
      this.lastStatus = {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: null,
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
    await this.opening?.promise.catch(() => undefined)
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
    if (existing.migrationLedger.length !== localDataMigrationManifest.latestVersion) {
      if (hasAnyRecords(existing.records)) {
        throw new LocalDataError('migration_integrity', 'Browser local data upgrade needs a reset before continuing', { reason: 'partial_upgrade_requires_reset' })
      }
      const upgraded = createStoredDocument(profileId, localNodeId)
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
  readonly transcripts: BrowserTranscriptRepository
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
    this.transcripts = new BrowserTranscriptRepository(this, { kind: 'queued' })
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

  async recoverActiveTranscripts(nowMs: number, terminalReason = 'process_restart'): Promise<TranscriptRecoveryResult> {
    return await this.transcripts.recoverActiveSessions(nowMs, terminalReason)
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
      transcripts: new BrowserTranscriptRepository(this, access)
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
        throw new LocalDataError('invalid_record', 'Message sequence must be unique within a conversation')
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

  async listConversations(): Promise<ConversationRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id)))
  }

  async listMessageCounts(): Promise<Record<string, number>> {
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const counts: Record<string, number> = {}
      const conversationIds = new Set(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId).map((conversation) => conversation.id))
      for (const message of this.session.mutable.messages) {
        if (!conversationIds.has(message.conversationId)) continue
        counts[message.conversationId] = (counts[message.conversationId] ?? 0) + 1
      }
      return counts
    })
  }

  async listFirstUserMessages(): Promise<Record<string, ConversationMessageRecord>> {
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const conversationIds = new Set(scopedConversations(this.session.mutable, this.session.profileId, this.session.localNodeId).map((conversation) => conversation.id))
      const firstByConversation = new Map<string, ConversationMessageRecord>()
      for (const message of this.session.mutable.messages) {
        if (message.role !== 'user' || !conversationIds.has(message.conversationId)) continue
        const current = firstByConversation.get(message.conversationId)
        if (current === undefined || message.sequence < current.sequence || (message.sequence === current.sequence && compareUtf8(message.id, current.id) < 0)) {
          firstByConversation.set(message.conversationId, message)
        }
      }
      return Object.fromEntries(Array.from(firstByConversation.entries(), ([conversationId, message]) => [conversationId, clone(message)]))
    })
  }

  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => {
      if (!this.session.mutable.conversations.some((conversation) => conversation.id === conversationId && conversation.profileId === this.session.profileId && conversation.localNodeId === this.session.localNodeId)) return []
      return clone(this.session.mutable.messages.filter((message) => message.conversationId === conversationId))
        .sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id))
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

export class BrowserTranscriptRepository {
  constructor(
    private readonly session: BrowserIndexedDbLocalDataSession,
    private readonly access: RepositoryAccess,
  ) {}

  async createSession(input: TranscriptSessionRecord): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseTranscriptSessionRecord(input)
      assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
      this.session.assertIdentity(record.profileId, record.localNodeId)
      const sessions = this.session.mutable.transcriptSessions ??= []
      if (sessions.some((item) => item.id === record.id)) throw new LocalDataError('invalid_record', 'Transcript session IDs must be unique')
      this.session.mutable.transcriptSegments ??= []
      sessions.push(record)
      return clone(record)
    })
  }

  async startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const record = this.findSession(sessionId)
      if (record.lifecycle !== 'active') throw new LocalDataError('session_closed', 'Transcript session is already terminal')
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < record.createdAtMs) throw new LocalDataError('invalid_record', 'Transcript start time is invalid')
      record.startedAtMs = Math.min(record.startedAtMs, startedAtMs)
      return clone(record)
    })
  }

  async appendSegment(input: TranscriptSegmentRecord): Promise<TranscriptAppendResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseTranscriptSegmentRecord(input)
      assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
      const session = this.findSession(record.sessionId)
      if (session.lifecycle !== 'active') throw new LocalDataError('session_closed', 'Cannot append to a terminal transcript session')
      if (record.startAtMs < session.startedAtMs) throw new LocalDataError('invalid_record', 'Transcript segment starts before the session')
      const segments = this.session.mutable.transcriptSegments ??= []
      const existing = segments.find((item) => item.id === record.id)
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new LocalDataError('invalid_record', 'Transcript segment replay conflicts with the stored segment')
        return { appended: false, record: clone(existing) }
      }
      if (segments.some((item) => item.sessionId === record.sessionId && item.sequence === record.sequence)) throw new LocalDataError('invalid_record', 'Transcript segment sequence must be unique within a session')
      segments.push(record)
      return { appended: true, record: clone(record) }
    })
  }

  async getSession(sessionId: string): Promise<TranscriptSessionRecord | null> {
    return await this.session.withRepositoryAccess(this.access, false, () => {
      const record = this.findScopedSession(sessionId)
      return record === undefined ? null : clone(record)
    })
  }

  async listSessions(): Promise<TranscriptSessionRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone((this.session.mutable.transcriptSessions ?? []).filter((record) => this.isScoped(record))).sort((a, b) => b.createdAtMs - a.createdAtMs || compareUtf8(a.id, b.id)))
  }

  async listSegments(sessionId: string): Promise<TranscriptSegmentRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => {
      if (this.findScopedSession(sessionId) === undefined) return []
      return clone((this.session.mutable.transcriptSegments ?? []).filter((item) => item.sessionId === sessionId)).sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id))
    })
  }

  async finalizeSession(sessionId: string, lifecycle: Exclude<TranscriptLifecycle, 'active'>, endedAtMs: number, terminalReason: string): Promise<TranscriptSessionRecord> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      if (terminalReason.trim().length === 0) throw new LocalDataError('invalid_record', 'Transcript terminal reason is required')
      const record = this.findSession(sessionId)
      if (record.lifecycle !== 'active') {
        if (record.lifecycle === lifecycle && record.endedAtMs === endedAtMs && record.terminalReason === terminalReason) return clone(record)
        throw new LocalDataError('session_closed', 'Transcript session is already finalized')
      }
      const finalized = parseTranscriptSessionRecord({ ...record, lifecycle, endedAtMs, terminalReason })
      const index = (this.session.mutable.transcriptSessions ?? []).findIndex((item) => item.id === sessionId)
      this.session.mutable.transcriptSessions![index] = finalized
      return clone(finalized)
    })
  }

  async recoverActiveSessions(nowMs: number, terminalReason = 'process_restart'): Promise<TranscriptRecoveryResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      const sessions = this.session.mutable.transcriptSessions ?? []
      const active = sessions.filter((record) => record.lifecycle === 'active' && this.isScoped(record))
      for (const record of active) {
        const index = sessions.findIndex((item) => item.id === record.id)
        sessions[index] = parseTranscriptSessionRecord({ ...record, lifecycle: 'interrupted', endedAtMs: Math.max(nowMs, record.startedAtMs), terminalReason })
      }
      return { interrupted: active.length }
    })
  }

  async deleteSession(sessionId: string): Promise<{ deleted: boolean; deletedSegments: number }> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      if (this.findScopedSession(sessionId) === undefined) return { deleted: false, deletedSegments: 0 }
      const sessions = this.session.mutable.transcriptSessions ?? []
      this.session.mutable.transcriptSessions = sessions.filter((record) => record.id !== sessionId || !this.isScoped(record))
      const segments = this.session.mutable.transcriptSegments ?? []
      this.session.mutable.transcriptSegments = segments.filter((record) => record.sessionId !== sessionId)
      return { deleted: true, deletedSegments: segments.length - this.session.mutable.transcriptSegments.length }
    })
  }

  async deleteExpiredSessions(nowMs: number, limit: number): Promise<TranscriptRetentionResult> {
    return await this.session.withRepositoryAccess(this.access, true, () => {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new LocalDataError('invalid_record', 'Transcript retention bounds are invalid')
      const sessions = this.session.mutable.transcriptSessions ?? []
      const expired = sessions.filter((record) => this.isScoped(record) && record.expiresAtMs !== null && record.expiresAtMs <= nowMs).sort((a, b) => (a.expiresAtMs ?? 0) - (b.expiresAtMs ?? 0) || compareUtf8(a.id, b.id)).slice(0, limit)
      const ids = new Set(expired.map((record) => record.id))
      const segments = this.session.mutable.transcriptSegments ?? []
      this.session.mutable.transcriptSessions = sessions.filter((record) => !ids.has(record.id))
      this.session.mutable.transcriptSegments = segments.filter((record) => !ids.has(record.sessionId))
      return { deletedSessions: expired.length, deletedSegments: segments.length - this.session.mutable.transcriptSegments.length }
    })
  }

  private findSession(sessionId: string): TranscriptSessionRecord {
    const record = (this.session.mutable.transcriptSessions ?? []).find((item) => item.id === sessionId)
    if (record === undefined) throw new LocalDataError('invalid_record', 'Transcript session does not exist')
    this.session.assertIdentity(record.profileId, record.localNodeId)
    return record
  }

  private findScopedSession(sessionId: string): TranscriptSessionRecord | undefined {
    return (this.session.mutable.transcriptSessions ?? []).find((record) => record.id === sessionId && this.isScoped(record))
  }

  private isScoped(record: TranscriptSessionRecord): boolean {
    return record.profileId === this.session.profileId && record.localNodeId === this.session.localNodeId
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
  return {
    formatVersion: 1,
    profileId: parseLocalDataId(record.profileId, 'identity.profile'),
    localNodeId: parseLocalDataId(record.localNodeId, 'identity.local_node'),
    schemaVersion: requireSafeVersion(record.schemaVersion),
    migrationLedger: requireMigrationLedger(record.migrationLedger),
    records: cloneLocalDataCollections(record.records as LocalDataRecordCollections)
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
  const transcriptSessionIds = requireUnique((records.transcriptSessions ?? []).map((record) => record.id), 'duplicate_transcript_session_id')
  requireUnique((records.transcriptSegments ?? []).map((record) => record.id), 'duplicate_transcript_segment_id')
  for (const record of records.conversations) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
  for (const record of records.messages) assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
  for (const record of records.memoryItems) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
  for (const record of records.localToolStates) assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
  for (const record of records.peerGrantMetadata) assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
  for (const record of records.localAudit) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
  for (const record of records.transcriptSessions ?? []) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
  for (const record of records.transcriptSegments ?? []) assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
  for (const record of records.conversations) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.memoryItems) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localToolStates) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.peerGrantMetadata) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localAudit) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.transcriptSessions ?? []) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
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
  const transcriptSequences = new Set<string>()
  for (const record of records.transcriptSegments ?? []) {
    if (!transcriptSessionIds.has(record.sessionId)) {
      throw new LocalDataError('invalid_record', 'Imported transcript segment session does not exist', { reason: 'transcript_session_missing' })
    }
    const sequenceKey = `${record.sessionId}\u0000${record.sequence}`
    if (transcriptSequences.has(sequenceKey)) {
      throw new LocalDataError('invalid_record', 'Imported transcript segment sequence must be unique within a session', { reason: 'duplicate_transcript_sequence' })
    }
    transcriptSequences.add(sequenceKey)
  }
}

function validateStoredCollectionsForLocalNode(records: LocalDataRecordCollections, localNodeId: string): void {
  validateCollectionShape(records)
  for (const record of records.conversations) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.memoryItems) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.localToolStates) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.peerGrantMetadata) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.localAudit) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
  for (const record of records.transcriptSessions ?? []) requireStoredRecordLocalNode(record.localNodeId, localNodeId)
}

function validateCollectionShape(records: LocalDataRecordCollections): void {
  const conversationIds = requireUnique(records.conversations.map((record) => record.id), 'duplicate_conversation_id')
  requireUnique(records.messages.map((record) => record.id), 'duplicate_message_id')
  requireUnique(records.memoryItems.map((record) => record.id), 'duplicate_memory_id')
  requireUnique(records.localToolStates.map((record) => `${record.profileId}\u0000${record.localNodeId}\u0000${record.toolContractId}`), 'duplicate_tool_state')
  requireUnique(records.peerGrantMetadata.map((record) => record.grantId), 'duplicate_grant_id')
  requireUnique(records.localAudit.map((record) => record.id), 'duplicate_audit_id')
  const transcriptSessionIds = requireUnique((records.transcriptSessions ?? []).map((record) => record.id), 'duplicate_transcript_session_id')
  requireUnique((records.transcriptSegments ?? []).map((record) => record.id), 'duplicate_transcript_segment_id')
  for (const record of records.conversations) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
  for (const record of records.messages) assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
  for (const record of records.memoryItems) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
  for (const record of records.localToolStates) assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
  for (const record of records.peerGrantMetadata) assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
  for (const record of records.localAudit) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
  for (const record of records.transcriptSessions ?? []) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.transcript_session')
  for (const record of records.transcriptSegments ?? []) assertSafeLocalDataIds([record.id, record.sessionId], 'record.transcript_segment')
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
  const transcriptSequences = new Set<string>()
  for (const record of records.transcriptSegments ?? []) {
    if (!transcriptSessionIds.has(record.sessionId)) {
      throw new LocalDataError('invalid_record', 'Transcript segment session does not exist', { reason: 'transcript_session_missing' })
    }
    const sequenceKey = `${record.sessionId}\u0000${record.sequence}`
    if (transcriptSequences.has(sequenceKey)) {
      throw new LocalDataError('invalid_record', 'Transcript segment sequence must be unique within a session', { reason: 'duplicate_transcript_sequence' })
    }
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
  for (const record of incoming.transcriptSessions ?? []) {
    assertNoScopedKeyCollision(current.transcriptSessions?.find((item) => item.id === record.id), profileId, localNodeId)
  }
  for (const record of incoming.transcriptSegments ?? []) {
    const existing = current.transcriptSegments?.find((item) => item.id === record.id)
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
  throw new LocalDataError('invalid_record', 'Message IDs must be unique')
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

function hasAnyRecords(records: LocalDataRecordCollections): boolean {
  return records.conversations.length
    + records.messages.length
    + records.memoryItems.length
    + records.localToolStates.length
    + records.peerGrantMetadata.length
    + records.localAudit.length > 0
    || (records.transcriptSessions ?? []).length > 0
    || (records.transcriptSegments ?? []).length > 0
}

function scopedCollections(records: LocalDataRecordCollections, profileId: string, localNodeId: string): LocalDataRecordCollections {
  const conversations = scopedConversations(records, profileId, localNodeId)
  const conversationIds = new Set(conversations.map((record) => record.id))
  const transcriptSessions = (records.transcriptSessions ?? []).filter((record) => record.profileId === profileId && record.localNodeId === localNodeId)
  const transcriptSessionIds = new Set(transcriptSessions.map((record) => record.id))
  return {
    conversations,
    messages: records.messages.filter((record) => conversationIds.has(record.conversationId)),
    memoryItems: records.memoryItems.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    localToolStates: records.localToolStates.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    peerGrantMetadata: records.peerGrantMetadata.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    localAudit: records.localAudit.filter((record) => record.profileId === profileId && record.localNodeId === localNodeId),
    transcriptSessions,
    transcriptSegments: (records.transcriptSegments ?? []).filter((record) => transcriptSessionIds.has(record.sessionId))
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
  const scopedTranscriptSessionIds = new Set((current.transcriptSessions ?? [])
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
      ...(current.transcriptSessions ?? []).filter((record) => record.profileId !== profileId || record.localNodeId !== localNodeId),
      ...(replacement.transcriptSessions ?? [])
    ],
    transcriptSegments: [
      ...(current.transcriptSegments ?? []).filter((record) => !scopedTranscriptSessionIds.has(record.sessionId)),
      ...(replacement.transcriptSegments ?? [])
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
    transcriptSessions: (collections.transcriptSessions ?? []).map((record) => structuredClone(record)),
    transcriptSegments: (collections.transcriptSegments ?? []).map((record) => structuredClone(record))
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
