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
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataExportV1,
  type LocalDataImportResult,
  type LocalDataRecordCollections,
  type LocalDataRepositories,
  type LocalDataSession,
  type LocalToolStateRecord,
  type MutableLocalDataCollections,
  type PeerGrantMetadataRecord
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
    if (hasAnyRecords(existing.records) && existing.profileId !== profileId) {
      throw new LocalDataError('identity_mismatch', 'Browser local data profile does not match stored local data')
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
    validateImportedCollections(current.records, profileId, localNodeId)
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
        records: this.collections
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
      const snapshot = cloneLocalDataCollections(this.collections)
      this.collections = cloneLocalDataCollections(parsed.records)
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
      this.collections = emptyLocalDataCollections()
      await this.documentStore.clear()
      await this.documentStore.save(createStoredDocument(this.profileId, this.localNodeId))
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
      localAudit: new BrowserLocalAuditRepository(this, access)
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
      upsert(this.session.mutable.conversations, record, (item) => item.id === record.id)
    })
  }

  async appendMessage(input: ConversationMessageRecord): Promise<void> {
    await this.session.withRepositoryAccess(this.access, true, () => {
      const record = parseConversationMessageRecord(input)
      assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
      if (!this.session.mutable.conversations.some((conversation) => conversation.id === record.conversationId)) {
        throw new LocalDataError('invalid_record', 'Message conversation does not exist')
      }
      if (this.session.mutable.messages.some((message) => message.conversationId === record.conversationId && message.sequence === record.sequence && message.id !== record.id)) {
        throw new LocalDataError('invalid_record', 'Message sequence must be unique within a conversation')
      }
      upsert(this.session.mutable.messages, record, (item) => item.id === record.id)
    })
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.conversations).sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id)))
  }

  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.messages.filter((message) => message.conversationId === conversationId))
      .sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id)))
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
      upsert(this.session.mutable.memoryItems, record, (item) => item.id === record.id)
    })
  }

  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.memoryItems.filter((record) => namespace === undefined || record.namespace === namespace))
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
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.localToolStates).sort((a, b) => compareUtf8(a.toolContractId, b.toolContractId)))
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
      upsert(this.session.mutable.peerGrantMetadata, record, (item) => item.grantId === record.grantId)
    })
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.peerGrantMetadata).sort((a, b) => compareUtf8(a.claimantPeerId, b.claimantPeerId) || compareUtf8(a.tokenId, b.tokenId)))
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
      if (this.session.mutable.localAudit.some((item) => item.id === record.id)) {
        throw new LocalDataError('invalid_record', 'Audit record IDs must be unique')
      }
      this.session.mutable.localAudit.push(record)
    })
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return await this.session.withRepositoryAccess(this.access, false, () => clone(this.session.mutable.localAudit).sort((a, b) => b.createdAtMs - a.createdAtMs || compareUtf8(a.id, b.id)))
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
  for (const record of records.conversations) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId], 'record.conversation')
  for (const record of records.messages) assertSafeLocalDataIds([record.id, record.conversationId], 'record.conversation_message')
  for (const record of records.memoryItems) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.namespace], 'record.lightweight_memory')
  for (const record of records.localToolStates) assertSafeLocalDataIds([record.profileId, record.localNodeId, record.toolContractId], 'record.local_tool_state')
  for (const record of records.peerGrantMetadata) assertSafeLocalDataIds([record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId], 'record.peer_grant_metadata')
  for (const record of records.localAudit) assertSafeLocalDataIds([record.id, record.profileId, record.localNodeId, record.action, record.decision, record.resultStatus], 'record.local_audit')
  for (const record of records.conversations) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.memoryItems) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localToolStates) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.peerGrantMetadata) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
  for (const record of records.localAudit) requireRecordIdentity(record.profileId, record.localNodeId, profileId, localNodeId)
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
}

function emptyLocalDataCollections(): MutableLocalDataCollections {
  return {
    conversations: [],
    messages: [],
    memoryItems: [],
    localToolStates: [],
    peerGrantMetadata: [],
    localAudit: []
  }
}

function cloneLocalDataCollections(collections: LocalDataRecordCollections): MutableLocalDataCollections {
  return {
    conversations: collections.conversations.map((record) => structuredClone(record)),
    messages: collections.messages.map((record) => structuredClone(record)),
    memoryItems: collections.memoryItems.map((record) => structuredClone(record)),
    localToolStates: collections.localToolStates.map((record) => structuredClone(record)),
    peerGrantMetadata: collections.peerGrantMetadata.map((record) => structuredClone(record)),
    localAudit: collections.localAudit.map((record) => structuredClone(record))
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
