import type {
  ConversationMessageRecord,
  ConversationRecord,
  LightweightMemoryRecord,
  LocalAuditRecord,
  LocalDataRecordCollections,
  LocalToolStateRecord,
  PeerGrantMetadataRecord
} from './records.zod.js'
import type { LocalDataScope } from './provenance.js'

export interface ConversationRepository {
  upsertConversation(record: ConversationRecord): Promise<void>
  appendMessage(record: ConversationMessageRecord): Promise<void>
  deleteConversation(conversationId: string): Promise<DeleteConversationResult>
  listConversations(): Promise<ConversationRecord[]>
  /** Returns message counts keyed by conversation for the active local scope. */
  listMessageCounts(): Promise<Record<string, number>>
  listMessages(conversationId: string): Promise<ConversationMessageRecord[]>
}

export interface LightweightMemoryRepository {
  upsertMemoryItem(record: LightweightMemoryRecord): Promise<void>
  deleteMemoryItem(memoryItemId: string): Promise<DeleteRecordResult>
  deleteExpiredMemoryItems(scope: LocalDataScope, nowMs: number, limit: number): Promise<DeleteExpiredMemoryItemsResult>
  listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]>
}

export interface DeleteConversationResult {
  readonly deleted: boolean
  readonly deletedMessages: number
}

export interface DeleteRecordResult {
  readonly deleted: boolean
}

export interface DeleteExpiredMemoryItemsResult {
  readonly deleted: number
}

export interface LocalToolStateRepository {
  upsertLocalToolState(record: LocalToolStateRecord): Promise<void>
  listLocalToolStates(): Promise<LocalToolStateRecord[]>
}

export interface PeerGrantMetadataRepository {
  upsertPeerGrant(record: PeerGrantMetadataRecord): Promise<void>
  listPeerGrants(): Promise<PeerGrantMetadataRecord[]>
}

export interface LocalAuditRepository {
  appendAudit(record: LocalAuditRecord): Promise<void>
  listAudit(): Promise<LocalAuditRecord[]>
}

export interface LocalDataRepositories {
  readonly conversations: ConversationRepository
  readonly memory: LightweightMemoryRepository
  readonly localTools: LocalToolStateRepository
  readonly peerGrants: PeerGrantMetadataRepository
  readonly localAudit: LocalAuditRepository
}

export interface MutableLocalDataCollections extends LocalDataRecordCollections {
  conversations: ConversationRecord[]
  messages: ConversationMessageRecord[]
  memoryItems: LightweightMemoryRecord[]
  localToolStates: LocalToolStateRecord[]
  peerGrantMetadata: PeerGrantMetadataRecord[]
  localAudit: LocalAuditRecord[]
}

export function emptyLocalDataCollections(): MutableLocalDataCollections {
  return {
    conversations: [],
    messages: [],
    memoryItems: [],
    localToolStates: [],
    peerGrantMetadata: [],
    localAudit: []
  }
}

export function cloneLocalDataCollections(collections: LocalDataRecordCollections): MutableLocalDataCollections {
  return {
    conversations: collections.conversations.map((record) => structuredClone(record)),
    messages: collections.messages.map((record) => structuredClone(record)),
    memoryItems: collections.memoryItems.map((record) => structuredClone(record)),
    localToolStates: collections.localToolStates.map((record) => structuredClone(record)),
    peerGrantMetadata: collections.peerGrantMetadata.map((record) => structuredClone(record)),
    localAudit: collections.localAudit.map((record) => structuredClone(record))
  }
}
