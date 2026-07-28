import type { LocalDataBackend, LocalDataBackendStatus } from './backend.js'
import { LocalDataError } from './backend.js'
import { buildLocalDataExportV1, parseLocalDataExportV1, type LocalDataExportV1, type LocalDataImportResult } from './export-v1.js'
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
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from './records.zod.js'
import { assertOpen, type LocalDataSession } from './session.js'

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
    if (this.session !== null && (this.session.profileId !== profileId || this.session.localNodeId !== localNodeId)) {
      throw new LocalDataError('memory_session_only', 'Memory local data backend owns only the current session identity')
    }
    this.session ??= new MemoryLocalDataSession({
      profileId,
      localNodeId,
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
  private readonly nowMs: () => number
  private readonly closeBackendSession: () => void
  private collections: MutableLocalDataCollections
  private closed = false

  constructor(options: MemoryLocalDataSessionOptions) {
    this.profileId = options.profileId
    this.localNodeId = options.localNodeId
    this.schemaVersion = options.schemaVersion
    this.nowMs = options.nowMs
    this.closeBackendSession = options.closeBackendSession
    this.collections = emptyLocalDataCollections()
    this.conversations = new MemoryConversationRepository(this)
    this.memory = new MemoryLightweightMemoryRepository(this)
    this.localTools = new MemoryLocalToolStateRepository(this)
    this.peerGrants = new MemoryPeerGrantMetadataRepository(this)
    this.localAudit = new MemoryLocalAuditRepository(this)
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    this.assertOpen()
    const snapshot = cloneLocalDataCollections(this.collections)
    try {
      return await work(this)
    } catch (error) {
      this.collections = snapshot
      throw error
    }
  }

  async exportV1(): Promise<LocalDataExportV1> {
    this.assertOpen()
    return buildLocalDataExportV1({
      sourceBackend: 'memory',
      schemaVersion: this.schemaVersion,
      profileId: this.profileId,
      localNodeId: this.localNodeId,
      exportedAtMs: this.nowMs(),
      records: this.collections
    })
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    this.assertOpen()
    const parsed = parseLocalDataExportV1(document)
    if (parsed.profileId !== this.profileId || parsed.localNodeId !== this.localNodeId) {
      throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the open session')
    }
    this.collections = cloneLocalDataCollections(parsed.records)
    return {
      imported: true,
      recordCounts: parsed.recordCounts,
      collectionHashes: parsed.collectionHashes
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.collections = emptyLocalDataCollections()
    this.closeBackendSession()
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
}

class MemoryConversationRepository {
  constructor(private readonly session: MemoryLocalDataSession) {}

  async upsertConversation(input: ConversationRecord): Promise<void> {
    const record = parseConversationRecord(input)
    this.session.assertIdentity(record.profileId, record.localNodeId)
    upsert(this.session.mutable.conversations, record, (item) => item.id === record.id)
  }

  async appendMessage(input: ConversationMessageRecord): Promise<void> {
    const record = parseConversationMessageRecord(input)
    if (!this.session.mutable.conversations.some((conversation) => conversation.id === record.conversationId)) {
      throw new LocalDataError('invalid_record', 'Message conversation does not exist')
    }
    if (this.session.mutable.messages.some((message) => message.conversationId === record.conversationId && message.sequence === record.sequence && message.id !== record.id)) {
      throw new LocalDataError('invalid_record', 'Message sequence must be unique within a conversation')
    }
    upsert(this.session.mutable.messages, record, (item) => item.id === record.id)
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return clone(this.session.mutable.conversations).sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
  }

  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return clone(this.session.mutable.messages.filter((message) => message.conversationId === conversationId))
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
  }
}

class MemoryLightweightMemoryRepository {
  constructor(private readonly session: MemoryLocalDataSession) {}

  async upsertMemoryItem(input: LightweightMemoryRecord): Promise<void> {
    const record = parseLightweightMemoryRecord(input)
    this.session.assertIdentity(record.profileId, record.localNodeId)
    upsert(this.session.mutable.memoryItems, record, (item) => item.id === record.id)
  }

  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return clone(this.session.mutable.memoryItems.filter((record) => namespace === undefined || record.namespace === namespace))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))
  }
}

class MemoryLocalToolStateRepository {
  constructor(private readonly session: MemoryLocalDataSession) {}

  async upsertLocalToolState(input: LocalToolStateRecord): Promise<void> {
    const record = parseLocalToolStateRecord(input)
    this.session.assertIdentity(record.profileId, record.localNodeId)
    upsert(this.session.mutable.localToolStates, record, (item) => item.profileId === record.profileId && item.localNodeId === record.localNodeId && item.toolContractId === record.toolContractId)
  }

  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return clone(this.session.mutable.localToolStates).sort((a, b) => a.toolContractId.localeCompare(b.toolContractId))
  }
}

class MemoryPeerGrantMetadataRepository {
  constructor(private readonly session: MemoryLocalDataSession) {}

  async upsertPeerGrant(input: PeerGrantMetadataRecord): Promise<void> {
    const record = parsePeerGrantMetadataRecord(input)
    this.session.assertIdentity(record.profileId, record.localNodeId)
    upsert(this.session.mutable.peerGrantMetadata, record, (item) => item.grantId === record.grantId)
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return clone(this.session.mutable.peerGrantMetadata).sort((a, b) => a.claimantPeerId.localeCompare(b.claimantPeerId) || a.tokenId.localeCompare(b.tokenId))
  }
}

class MemoryLocalAuditRepository {
  constructor(private readonly session: MemoryLocalDataSession) {}

  async appendAudit(input: LocalAuditRecord): Promise<void> {
    const record = parseLocalAuditRecord(input)
    this.session.assertIdentity(record.profileId, record.localNodeId)
    if (this.session.mutable.localAudit.some((item) => item.id === record.id)) {
      throw new LocalDataError('invalid_record', 'Audit record IDs must be unique')
    }
    this.session.mutable.localAudit.push(record)
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return clone(this.session.mutable.localAudit).sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id))
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
