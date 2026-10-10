import type {
  ConversationMessageRecord,
  ConversationRecord,
  LightweightMemoryRecord,
  LocalAuditRecord,
  LocalDataRecordCollections,
  LocalToolStateRecord,
  PeerGrantMetadataRecord,
  TranscriptLifecycle,
  TranscriptSessionRecord,
  TranscriptSegmentRecord
} from './records.zod.js'
import type { LocalDataScope } from './provenance.js'

export interface ConversationRepository {
  upsertConversation(record: ConversationRecord): Promise<void>
  /** Atomically inserts or updates a message; duplicate sequence uses `duplicate_message_sequence`, and cross-conversation ID reuse uses `duplicate_message_id`. */
  appendMessage(record: ConversationMessageRecord): Promise<void>
  deleteConversation(conversationId: string): Promise<DeleteConversationResult>
  getConversation(conversationId: string): Promise<ConversationRecord | null>
  getMessage(conversationId: string, messageId: string): Promise<ConversationMessageRecord | null>
  listConversations(options?: ConversationListQuery): Promise<ConversationRecord[]>
  /** Returns message counts keyed by conversation for the active local scope. */
  listMessageCounts(conversationIds?: readonly string[]): Promise<Record<string, number>>
  /** Returns the earliest user message keyed by conversation for title previews. */
  listFirstUserMessages(conversationIds?: readonly string[]): Promise<Record<string, ConversationMessageRecord>>
  listMessages(conversationId: string, options?: MessageListQuery): Promise<ConversationMessageRecord[]>
  getLatestMessageSequence(conversationId: string): Promise<number | null>
}

export interface ConversationCursor {
  readonly updatedAtMs: number
  readonly id: string
}

export interface ConversationListQuery {
  readonly limit?: number
  readonly includeArchived?: boolean
  readonly cursor?: ConversationCursor
}

export type MessageListDirection = 'asc' | 'desc'

export interface MessageListQuery {
  readonly limit?: number
  readonly beforeSequence?: number
  readonly afterSequence?: number
  readonly direction?: MessageListDirection
}

export const LOCAL_DATA_CONVERSATION_QUERY_MAX = 501
export const LOCAL_DATA_MESSAGE_QUERY_MAX = 2_001
export const LOCAL_DATA_CONVERSATION_ID_SET_MAX = 500

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

export interface TranscriptArchiveRepository {
  createSession(record: TranscriptSessionRecord): Promise<TranscriptSessionRecord>
  startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord>
  appendSegment(record: TranscriptSegmentRecord): Promise<AppendTranscriptSegmentResult>
  getSession(sessionId: string): Promise<TranscriptSessionRecord | null>
  listSessions(options?: TranscriptSessionListQuery): Promise<TranscriptSessionRecord[]>
  listSegments(sessionId: string, options?: TranscriptSegmentListQuery): Promise<TranscriptSegmentRecord[]>
  finalizeSession(input: FinalizeTranscriptSessionInput): Promise<TranscriptSessionRecord>
  recoverActiveSessions(nowMs: number, terminalReason?: string): Promise<RecoverTranscriptSessionsResult>
  deleteSession(sessionId: string): Promise<DeleteTranscriptSessionResult>
  deleteExpiredSessions(nowMs: number, limit: number): Promise<DeleteExpiredTranscriptSessionsResult>
}

export interface TranscriptSessionCursor {
  readonly createdAtMs: number
  readonly id: string
}

export interface TranscriptSessionListQuery {
  readonly limit?: number
  readonly cursor?: TranscriptSessionCursor
}

export interface TranscriptSegmentListQuery {
  readonly limit?: number
  readonly afterSequence?: number
}

export interface FinalizeTranscriptSessionInput {
  readonly sessionId: string
  readonly lifecycle: Extract<TranscriptLifecycle, 'completed' | 'interrupted' | 'failed'>
  readonly endedAtMs: number
  readonly terminalReason: string
}

export interface AppendTranscriptSegmentResult {
  readonly appended: boolean
  readonly record: TranscriptSegmentRecord
}

export interface RecoverTranscriptSessionsResult {
  readonly interrupted: number
}

export interface DeleteTranscriptSessionResult {
  readonly deleted: boolean
  readonly deletedSegments: number
}

export interface DeleteExpiredTranscriptSessionsResult {
  readonly deletedSessions: number
  readonly deletedSegments: number
}

export const LOCAL_DATA_TRANSCRIPT_SESSION_LIMIT = 5_000
export const LOCAL_DATA_TRANSCRIPT_SEGMENT_LIMIT = 100_000
export const LOCAL_DATA_TRANSCRIPT_DELETE_LIMIT = 1_000
export const LOCAL_DATA_TRANSCRIPT_SESSION_QUERY_MAX = 500
export const LOCAL_DATA_TRANSCRIPT_SEGMENT_QUERY_MAX = 2_000

export interface LocalDataRepositories {
  readonly conversations: ConversationRepository
  readonly memory: LightweightMemoryRepository
  readonly localTools: LocalToolStateRepository
  readonly peerGrants: PeerGrantMetadataRepository
  readonly localAudit: LocalAuditRepository
  readonly transcripts: TranscriptArchiveRepository
}

export interface MutableLocalDataCollections extends LocalDataRecordCollections {
  conversations: ConversationRecord[]
  messages: ConversationMessageRecord[]
  memoryItems: LightweightMemoryRecord[]
  localToolStates: LocalToolStateRecord[]
  peerGrantMetadata: PeerGrantMetadataRecord[]
  localAudit: LocalAuditRecord[]
  transcriptSessions: TranscriptSessionRecord[]
  transcriptSegments: TranscriptSegmentRecord[]
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
    transcriptSessions: collections.transcriptSessions.map((record) => structuredClone(record)),
    transcriptSegments: collections.transcriptSegments.map((record) => structuredClone(record))
  }
}
