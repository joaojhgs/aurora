import type {
  ConversationMessageRecord,
  ConversationRecord,
  LightweightMemoryRecord,
  LocalAuditRecord,
  LocalDataRecordCollections,
  LocalToolStateRecord,
  PeerGrantMetadataRecord,
  TranscriptLifecycle,
  TranscriptSegmentRecord,
  TranscriptSessionRecord
} from './records.zod.js'
import type { LocalDataScope } from './provenance.js'

export interface ConversationRepository {
  upsertConversation(record: ConversationRecord): Promise<void>
  appendMessage(record: ConversationMessageRecord): Promise<void>
  deleteConversation(conversationId: string): Promise<DeleteConversationResult>
  listConversations(): Promise<ConversationRecord[]>
  /** Returns message counts keyed by conversation for the active local scope. */
  listMessageCounts(): Promise<Record<string, number>>
  /** Returns the earliest user message keyed by conversation for title previews. */
  listFirstUserMessages(): Promise<Record<string, ConversationMessageRecord>>
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

export interface TranscriptRepository {
  createSession(record: TranscriptSessionRecord): Promise<TranscriptSessionRecord>
  startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord>
  appendSegment(record: TranscriptSegmentRecord): Promise<TranscriptAppendResult>
  getSession(sessionId: string): Promise<TranscriptSessionRecord | null>
  listSessions(): Promise<TranscriptSessionRecord[]>
  listSegments(sessionId: string): Promise<TranscriptSegmentRecord[]>
  finalizeSession(sessionId: string, lifecycle: Exclude<TranscriptLifecycle, 'active'>, endedAtMs: number, terminalReason: string): Promise<TranscriptSessionRecord>
  recoverActiveSessions(nowMs: number, terminalReason?: string): Promise<TranscriptRecoveryResult>
  deleteSession(sessionId: string): Promise<DeleteTranscriptSessionResult>
  deleteExpiredSessions(nowMs: number, limit: number): Promise<TranscriptRetentionResult>
}

export interface TranscriptAppendResult {
  readonly appended: boolean
  readonly record: TranscriptSegmentRecord
}

export interface TranscriptRecoveryResult {
  readonly interrupted: number
}

export interface DeleteTranscriptSessionResult {
  readonly deleted: boolean
  readonly deletedSegments: number
}

export interface TranscriptRetentionResult {
  readonly deletedSessions: number
  readonly deletedSegments: number
}

export interface LocalDataRepositories {
  readonly conversations: ConversationRepository
  readonly memory: LightweightMemoryRepository
  readonly localTools: LocalToolStateRepository
  readonly peerGrants: PeerGrantMetadataRepository
  readonly localAudit: LocalAuditRepository
  readonly transcripts: TranscriptRepository
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
    localAudit: [],
    transcriptSessions: [],
    transcriptSegments: []
  }
}

export function cloneLocalDataCollections(collections: LocalDataRecordCollections): MutableLocalDataCollections {
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
