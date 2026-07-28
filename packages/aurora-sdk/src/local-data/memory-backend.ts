import type { LocalDataBackend, LocalDataBackendStatus } from './backend.js'
import { LocalDataError } from './backend.js'
import { buildLocalDataExportV1, compareUtf8, parseLocalDataExportV1, type LocalDataExportV1, type LocalDataImportResult } from './export-v1.js'
import {
  cloneLocalDataCollections,
  emptyLocalDataCollections,
  type LocalDataRepositories,
  type MutableLocalDataCollections
} from './repositories.js'
import {
  parseConversationMessageRecord,
  parseConversationRecord,
  parseLightweightMemoryRecord,
  parseLocalAuditRecord,
  parseLocalToolStateRecord,
  parsePeerGrantMetadataRecord,
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalDataRecordCollections,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord,
  localDataIdSchema
} from './records.zod.js'
import { assertOpen, type LocalDataSession } from './session.js'
import { parseLocalDataBoundary } from './validation.js'

export interface MemoryLocalDataBackendOptions {
  nowMs?: () => number
  schemaVersion?: number
}

export class MemoryLocalDataBackend implements LocalDataBackend {
  readonly kind = 'memory' as const
  readonly persistent = false
  readonly sqlite = false
  private readonly nowMs: () => number
  private readonly schemaVersion: number
  private session: MemoryLocalDataSession | null = null
  private closed = false

  constructor(options: MemoryLocalDataBackendOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.schemaVersion = options.schemaVersion ?? 3
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.closed) throw new LocalDataError('session_closed', 'Memory local data backend is closed')
    const canonicalProfileId = parseLocalDataBoundary(localDataIdSchema, profileId, 'identity.profile')
    const canonicalLocalNodeId = parseLocalDataBoundary(localDataIdSchema, localNodeId, 'identity.local_node')
    if (this.session !== null && (this.session.profileId !== profileId || this.session.localNodeId !== localNodeId)) {
      throw new LocalDataError('memory_session_only', 'Memory local data backend owns only the current session identity')
    }
    this.session ??= new MemoryLocalDataSession({
      profileId: canonicalProfileId,
      localNodeId: canonicalLocalNodeId,
      schemaVersion: this.schemaVersion,
      nowMs: this.nowMs,
      closeBackendSession: () => {
        this.session = null
      }
    })
    return this.session
  }

  async status(): Promise<LocalDataBackendStatus> {
    return {
      kind: this.kind,
      persistent: false,
      sqlite: false,
      profileId: this.session?.profileId ?? null,
      schemaVersion: this.session?.schemaVersion ?? null,
      migrationState: 'idle',
      degradedReason: 'memory_session_only'
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.session?.close()
    this.session = null
  }
}

interface MemoryLocalDataSessionOptions {
  profileId: string
  localNodeId: string
  schemaVersion: number
  nowMs: () => number
  closeBackendSession: () => void
}

class MemoryLocalDataSession implements LocalDataSession {
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  readonly conversations: MemoryConversationRepository
  readonly memory: MemoryLightweightMemoryRepository
  readonly localTools: MemoryLocalToolStateRepository
  readonly peerGrants: MemoryPeerGrantMetadataRepository
  readonly localAudit: MemoryLocalAuditRepository
  private readonly transactionRepositories: LocalDataRepositories
  private readonly nowMs: () => number
  private readonly closeBackendSession: () => void
  private collections: MutableLocalDataCollections
  private operationQueue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: MemoryLocalDataSessionOptions) {
    this.profileId = options.profileId
    this.localNodeId = options.localNodeId
    this.schemaVersion = options.schemaVersion
    this.nowMs = options.nowMs
    this.closeBackendSession = options.closeBackendSession
    this.collections = emptyLocalDataCollections()
    this.conversations = new MemoryConversationRepository(this, 'queued')
    this.memory = new MemoryLightweightMemoryRepository(this, 'queued')
    this.localTools = new MemoryLocalToolStateRepository(this, 'queued')
    this.peerGrants = new MemoryPeerGrantMetadataRepository(this, 'queued')
    this.localAudit = new MemoryLocalAuditRepository(this, 'queued')
    this.transactionRepositories = {
      conversations: new MemoryConversationRepository(this, 'direct'),
      memory: new MemoryLightweightMemoryRepository(this, 'direct'),
      localTools: new MemoryLocalToolStateRepository(this, 'direct'),
      peerGrants: new MemoryPeerGrantMetadataRepository(this, 'direct'),
      localAudit: new MemoryLocalAuditRepository(this, 'direct')
    }
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    return this.enqueueOperation(async () => {
      this.assertOpen()
      const snapshot = cloneLocalDataCollections(this.collections)
      try {
        return await work(this.transactionRepositories)
      } catch (error) {
        this.collections = snapshot
        throw error
      }
    })
  }

  async exportV1(): Promise<LocalDataExportV1> {
    return this.enqueueOperation(() => {
      this.assertOpen()
      return buildLocalDataExportV1({
        sourceBackend: 'memory',
        schemaVersion: this.schemaVersion,
        profileId: this.profileId,
        localNodeId: this.localNodeId,
        exportedAtMs: this.nowMs(),
        records: this.collections
      })
    })
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    return this.enqueueOperation(() => {
      this.assertOpen()
      const parsed = parseLocalDataExportV1(document)
      if (parsed.profileId !== this.profileId || parsed.localNodeId !== this.localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the open session')
      }
      if (parsed.schemaVersion > this.schemaVersion) {
        throw new LocalDataError('invalid_record', 'Local data export schema is newer than the open session', { reason: 'future_schema' })
      }
      validateImportedCollections(parsed.records, this.profileId, this.localNodeId)
      this.collections = cloneLocalDataCollections(parsed.records)
      return {
        imported: true,
        recordCounts: parsed.recordCounts,
        collectionHashes: parsed.collectionHashes
      }
    })
  }

  async close(): Promise<void> {
    await this.enqueueOperation(() => {
      this.closed = true
      this.collections = emptyLocalDataCollections()
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

  withRepositoryAccess<T>(access: RepositoryAccess, work: () => T | Promise<T>): Promise<T> {
    if (access === 'direct') {
      this.assertOpen()
      return Promise.resolve(work())
    }
    return this.enqueueOperation(async () => {
      this.assertOpen()
      return work()
    })
  }

  private enqueueOperation<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await work()
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

type RepositoryAccess = 'queued' | 'direct'

class MemoryConversationRepository {
  constructor(
    private readonly session: MemoryLocalDataSession,
    private readonly access: RepositoryAccess
  ) {}

  async upsertConversation(input: ConversationRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parseConversationRecord(input)
      this.session.assertIdentity(record.profileId, record.localNodeId)
      upsert(this.session.mutable.conversations, record, (item) => item.id === record.id)
    })
  }

  async appendMessage(input: ConversationMessageRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parseConversationMessageRecord(input)
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
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.conversations).sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id)))
  }

  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.messages.filter((message) => message.conversationId === conversationId))
      .sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id)))
  }
}

class MemoryLightweightMemoryRepository {
  constructor(
    private readonly session: MemoryLocalDataSession,
    private readonly access: RepositoryAccess
  ) {}

  async upsertMemoryItem(input: LightweightMemoryRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parseLightweightMemoryRecord(input)
      this.session.assertIdentity(record.profileId, record.localNodeId)
      upsert(this.session.mutable.memoryItems, record, (item) => item.id === record.id)
    })
  }

  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.memoryItems.filter((record) => namespace === undefined || record.namespace === namespace))
      .sort((a, b) => compareUtf8(a.namespace, b.namespace) || compareUtf8(a.id, b.id)))
  }
}

class MemoryLocalToolStateRepository {
  constructor(
    private readonly session: MemoryLocalDataSession,
    private readonly access: RepositoryAccess
  ) {}

  async upsertLocalToolState(input: LocalToolStateRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parseLocalToolStateRecord(input)
      this.session.assertIdentity(record.profileId, record.localNodeId)
      upsert(this.session.mutable.localToolStates, record, (item) => item.profileId === record.profileId && item.localNodeId === record.localNodeId && item.toolContractId === record.toolContractId)
    })
  }

  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.localToolStates).sort((a, b) => compareUtf8(a.toolContractId, b.toolContractId)))
  }
}

class MemoryPeerGrantMetadataRepository {
  constructor(
    private readonly session: MemoryLocalDataSession,
    private readonly access: RepositoryAccess
  ) {}

  async upsertPeerGrant(input: PeerGrantMetadataRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parsePeerGrantMetadataRecord(input)
      this.session.assertIdentity(record.profileId, record.localNodeId)
      upsert(this.session.mutable.peerGrantMetadata, record, (item) => item.grantId === record.grantId)
    })
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.peerGrantMetadata).sort((a, b) => compareUtf8(a.claimantPeerId, b.claimantPeerId) || compareUtf8(a.tokenId, b.tokenId)))
  }
}

class MemoryLocalAuditRepository {
  constructor(
    private readonly session: MemoryLocalDataSession,
    private readonly access: RepositoryAccess
  ) {}

  async appendAudit(input: LocalAuditRecord): Promise<void> {
    return this.session.withRepositoryAccess(this.access, () => {
      const record = parseLocalAuditRecord(input)
      this.session.assertIdentity(record.profileId, record.localNodeId)
      if (this.session.mutable.localAudit.some((item) => item.id === record.id)) {
        throw new LocalDataError('invalid_record', 'Audit record IDs must be unique')
      }
      this.session.mutable.localAudit.push(record)
    })
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return this.session.withRepositoryAccess(this.access, () => clone(this.session.mutable.localAudit).sort((a, b) => b.createdAtMs - a.createdAtMs || compareUtf8(a.id, b.id)))
  }
}

function upsert<T>(items: T[], record: T, predicate: (item: T) => boolean): void {
  const index = items.findIndex(predicate)
  if (index === -1) {
    items.push(record)
  } else {
    items[index] = record
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validateImportedCollections(records: LocalDataRecordCollections, profileId: string, localNodeId: string): void {
  const conversationIds = requireUnique(records.conversations.map((record) => record.id), 'duplicate_conversation_id')
  const messageIds = requireUnique(records.messages.map((record) => record.id), 'duplicate_message_id')
  const memoryIds = requireUnique(records.memoryItems.map((record) => record.id), 'duplicate_memory_id')
  const toolStateKeys = requireUnique(records.localToolStates.map((record) => `${record.profileId}\u0000${record.localNodeId}\u0000${record.toolContractId}`), 'duplicate_tool_state')
  const grantIds = requireUnique(records.peerGrantMetadata.map((record) => record.grantId), 'duplicate_grant_id')
  const auditIds = requireUnique(records.localAudit.map((record) => record.id), 'duplicate_audit_id')
  void messageIds
  void memoryIds
  void toolStateKeys
  void grantIds
  void auditIds
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
    if (seen.has(value)) {
      throw new LocalDataError('invalid_record', 'Imported local data records must have unique repository keys', { reason })
    }
    seen.add(value)
  }
  return seen
}
