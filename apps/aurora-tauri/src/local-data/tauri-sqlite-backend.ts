import {
  LocalDataError,
  localDataIdSchema,
  parseLocalDataBoundary,
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
  type ConversationListQuery,
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
  type LocalDataRepositories,
  type LocalDataScope,
  type LocalDataSession,
  type LocalToolStateRecord,
  type MessageListQuery,
  type PeerGrantMetadataRecord,
  type TranscriptSessionRecord,
  type TranscriptSegmentRecord,
  type TranscriptSessionListQuery,
  type TranscriptSegmentListQuery,
  type FinalizeTranscriptSessionInput,
  type AppendTranscriptSegmentResult,
  type RecoverTranscriptSessionsResult,
  type DeleteTranscriptSessionResult,
  type DeleteExpiredTranscriptSessionsResult,
  LOCAL_DATA_TRANSCRIPT_SESSION_QUERY_MAX,
  LOCAL_DATA_TRANSCRIPT_SEGMENT_QUERY_MAX,
  LOCAL_DATA_TRANSCRIPT_DELETE_LIMIT
} from '../../../../packages/aurora-sdk/src/local-data/index.js'
import {
  LOCAL_DATA_CONVERSATION_ID_SET_MAX,
  LOCAL_DATA_CONVERSATION_QUERY_MAX,
  LOCAL_DATA_MESSAGE_QUERY_MAX
} from '../../../../packages/aurora-sdk/src/local-data/repositories.js'
import { invokeAuroraLocalDataCommand } from './tauri-local-data-invoke.js'

export interface TauriSqliteLocalDataBackendOptions {
  readonly invokeCommand?: (command: string, args: Record<string, unknown>) => Promise<unknown>
}

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.deleteConversation'; readonly conversationId: string }
  | { readonly kind: 'conversations.getConversation'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'conversations.getMessage'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string; readonly messageId: string }
  | { readonly kind: 'conversations.listConversations'; readonly profileId: string; readonly localNodeId: string; readonly options?: ConversationListQuery }
  | { readonly kind: 'conversations.listMessageCounts'; readonly profileId: string; readonly localNodeId: string; readonly conversationIds?: readonly string[] }
  | { readonly kind: 'conversations.listFirstUserMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationIds?: readonly string[] }
  | { readonly kind: 'conversations.listMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string; readonly options?: MessageListQuery }
  | { readonly kind: 'conversations.getLatestMessageSequence'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.deleteMemoryItem'; readonly memoryItemId: string }
  | { readonly kind: 'memory.deleteExpiredMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly limit: number }
  | { readonly kind: 'memory.listMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'transcripts.createSession'; readonly record: TranscriptSessionRecord }
  | { readonly kind: 'transcripts.startSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string; readonly startedAtMs: number }
  | { readonly kind: 'transcripts.appendSegment'; readonly record: TranscriptSegmentRecord }
  | { readonly kind: 'transcripts.getSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.listSessions'; readonly profileId: string; readonly localNodeId: string; readonly options?: TranscriptSessionListQuery }
  | { readonly kind: 'transcripts.listSegments'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string; readonly options?: TranscriptSegmentListQuery }
  | { readonly kind: 'transcripts.finalizeSession'; readonly profileId: string; readonly localNodeId: string; readonly input: FinalizeTranscriptSessionInput }
  | { readonly kind: 'transcripts.recoverActiveSessions'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly terminalReason?: string }
  | { readonly kind: 'transcripts.deleteSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.deleteExpiredSessions'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly limit: number }

interface TransactionToken {
  active: boolean
}

type RepositoryAccess =
  | { readonly kind: 'queued' }
  | { readonly kind: 'transaction'; readonly txId: string; readonly token: TransactionToken; readonly root: TauriSqliteLocalDataSession }

export class TauriSqliteLocalDataBackend implements LocalDataBackend {
  readonly kind = 'sqlite-tauri' as const
  readonly persistent = true
  readonly sqlite = true
  private readonly invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>
  private session: TauriSqliteLocalDataSession | null = null
  private statusValue: LocalDataBackendStatus = {
    kind: 'sqlite-tauri',
    persistent: true,
    sqlite: true,
    profileId: null,
    schemaVersion: null,
    migrationState: 'idle'
  }

  constructor(options: TauriSqliteLocalDataBackendOptions = {}) {
    this.invokeCommand = options.invokeCommand ?? invokeAuroraLocalDataCommand
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.session !== null) {
      if (this.session.profileId !== profileId || this.session.localNodeId !== localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Tauri local data backend is already open for another identity')
      }
      return this.session
    }
    const status = await this.invokeCommand('aurora_local_data_open', { request: { profileId, localNodeId } })
    this.statusValue = parseStatus(status)
    this.session = new TauriSqliteLocalDataSession(profileId, localNodeId, this.statusValue.schemaVersion ?? 0, this.invokeCommand)
    return this.session
  }

  async status(): Promise<LocalDataBackendStatus> {
    this.statusValue = parseStatus(await this.invokeCommand('aurora_local_data_status', {}))
    return this.statusValue
  }

  async close(): Promise<void> {
    await this.session?.markClosed()
    this.session = null
    await this.invokeCommand('aurora_local_data_close', {}).catch(() => undefined)
    this.statusValue = {
      kind: 'sqlite-tauri',
      persistent: true,
      sqlite: true,
      profileId: null,
      schemaVersion: null,
      migrationState: 'idle'
    }
  }
}

class TauriSqliteLocalDataSession implements LocalDataSession {
  readonly conversations: TauriConversationRepository
  readonly memory: TauriMemoryRepository
  readonly localTools: TauriLocalToolStateRepository
  readonly peerGrants: TauriPeerGrantRepository
  readonly localAudit: TauriLocalAuditRepository
  readonly transcripts: TauriTranscriptArchiveRepository
  private operationQueue: Promise<unknown> = Promise.resolve()
  private activeTransactionToken: TransactionToken | null = null
  private closed = false

  constructor(
    readonly profileId: string,
    readonly localNodeId: string,
    readonly schemaVersion: number,
    private readonly invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly access: RepositoryAccess = { kind: 'queued' }
  ) {
    this.conversations = new TauriConversationRepository(this)
    this.memory = new TauriMemoryRepository(this)
    this.localTools = new TauriLocalToolStateRepository(this)
    this.peerGrants = new TauriPeerGrantRepository(this)
    this.localAudit = new TauriLocalAuditRepository(this)
    this.transcripts = new TauriTranscriptArchiveRepository(this)
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    if (this.access.kind === 'transaction') throw transactionScopeError('nested_transaction')
    if (this.activeTransactionToken !== null) throw transactionScopeError('nested_transaction')
    return await this.enqueueOperation(async () => {
      this.assertOpen()
      if (this.activeTransactionToken !== null) throw transactionScopeError('nested_transaction')
      const begin = parseTransactionBeginResponse(await this.invokeCommand('aurora_local_data_transaction_begin', { request: {} }))
      const token: TransactionToken = { active: true }
      this.activeTransactionToken = token
      const txSession = new TauriSqliteLocalDataSession(this.profileId, this.localNodeId, this.schemaVersion, this.invokeCommand, {
        kind: 'transaction',
        txId: begin.txId,
        token,
        root: this
      })
      try {
        const result = await work(txSession)
        await this.invokeCommand('aurora_local_data_transaction_commit', { request: { txId: begin.txId } })
        return result
      } catch (error) {
        await this.invokeCommand('aurora_local_data_transaction_rollback', { request: { txId: begin.txId } }).catch(() => undefined)
        throw error
      } finally {
        token.active = false
        if (this.activeTransactionToken === token) this.activeTransactionToken = null
        await txSession.markClosed()
      }
    })
  }

  async exportV1(): Promise<LocalDataExportV1> {
    return await this.withRepositoryAccess(async () => parseLocalDataExportV1(await this.invokeCommand('aurora_local_data_export_v1', {})))
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    return await this.withRepositoryAccess(async () => await this.invokeCommand('aurora_local_data_import_v1', { request: { document: parseLocalDataExportV1(document) } }) as LocalDataImportResult)
  }

  async close(): Promise<void> {
    await this.enqueueOperation(() => {
      this.closed = true
    })
  }

  async markClosed(): Promise<void> {
    this.closed = true
  }

  async repositoryOperation<T>(operation: RepositoryOperation): Promise<T> {
    return await this.withRepositoryAccess(async () => {
      const request = this.access.kind === 'transaction'
        ? { txId: this.access.txId, operation }
        : { operation }
      try {
        return await this.invokeCommand('aurora_local_data_repository_operation', { request }) as T
      } catch (error) {
        throw parseNativeLocalDataError(error)
      }
    })
  }

  private async withRepositoryAccess<T>(work: () => Promise<T>): Promise<T> {
    if (this.access.kind === 'transaction') {
      this.access.root.assertTransactionToken(this.access.token)
      this.assertOpen()
      return await work()
    }
    return await this.enqueueOperation(async () => {
      this.assertOpen()
      return await work()
    })
  }

  private enqueueOperation<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await work()
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private assertTransactionToken(token: TransactionToken): void {
    if (!token.active || this.activeTransactionToken !== token) throw transactionScopeError('expired_transaction_repository')
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalDataError('session_closed', 'Local data session is closed')
  }
}

function queryError(reason: string): never { throw new LocalDataError('invalid_record', 'Invalid local history query', { reason }) }
function validateQueryId(value: string, reason: string): void {
  if (typeof value !== 'string') queryError(reason)
  parseLocalDataBoundary(localDataIdSchema, value, reason)
}
function validateConversationQuery(options?: ConversationListQuery): void {
  if (options?.includeArchived !== undefined && typeof options.includeArchived !== 'boolean') queryError('include_archived')
  if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_CONVERSATION_QUERY_MAX)) queryError('conversation_limit')
  if (options?.cursor !== undefined) { validateQueryId(options.cursor.id, 'conversation_cursor_id'); if (!Number.isSafeInteger(options.cursor.updatedAtMs) || options.cursor.updatedAtMs < 0) queryError('conversation_cursor_updated_at') }
}
function validateMessageQuery(options?: MessageListQuery): void {
  if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_MESSAGE_QUERY_MAX)) queryError('message_limit')
  if (options?.direction !== undefined && options.direction !== 'asc' && options.direction !== 'desc') queryError('message_direction')
  if (options?.beforeSequence !== undefined && options?.afterSequence !== undefined) queryError('ambiguous_message_cursor')
  if (options?.beforeSequence !== undefined && (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 0)) queryError('message_before_sequence')
  if (options?.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)) queryError('message_after_sequence')
}
function validateIdSetQuery(ids?: readonly string[]): void {
  if (ids !== undefined && ids.length > LOCAL_DATA_CONVERSATION_ID_SET_MAX) queryError('conversation_id_set_limit')
  for (const id of ids ?? []) validateQueryId(id, 'conversation.id')
}

function parseNativeLocalDataError(error: unknown): unknown {
  if (error instanceof LocalDataError) return error
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; detail?: unknown } : {}
  if (value.code !== 'LocalData' && value.code !== 'local_data' && value.code !== 'invalid_record') return error
  const detail = value.detail && typeof value.detail === 'object' ? value.detail as { reason?: unknown; code?: unknown } : {}
  const message = typeof value.message === 'string' ? value.message : 'Tauri local data operation failed'
  const reason = typeof detail.reason === 'string' && new Set([
    'duplicate_message_id',
    'duplicate_message_sequence'
  ]).has(detail.reason) ? detail.reason : undefined
  if (reason === undefined) return error
  return new LocalDataError('invalid_record', message, { reason })
}

class TauriConversationRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertConversation(record: ConversationRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'conversations.upsertConversation', record: parseConversationRecord(record) })
  }
  async appendMessage(record: ConversationMessageRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'conversations.appendMessage', record: parseConversationMessageRecord(record) })
  }
  async deleteConversation(conversationId: string): Promise<DeleteConversationResult> {
    return await this.session.repositoryOperation<DeleteConversationResult>({ kind: 'conversations.deleteConversation', conversationId })
  }
  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    validateQueryId(conversationId, 'conversation.id')
    const value = await this.session.repositoryOperation<ConversationRecord | null>({ kind: 'conversations.getConversation', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationId })
    return value === null ? null : parseConversationRecord(value)
  }
  async getMessage(conversationId: string, messageId: string): Promise<ConversationMessageRecord | null> {
    validateQueryId(conversationId, 'conversation.id'); validateQueryId(messageId, 'message.id')
    const value = await this.session.repositoryOperation<ConversationMessageRecord | null>({ kind: 'conversations.getMessage', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationId, messageId })
    return value === null ? null : parseConversationMessageRecord(value)
  }
  async listConversations(options?: ConversationListQuery): Promise<ConversationRecord[]> {
    validateConversationQuery(options)
    return (await this.session.repositoryOperation<ConversationRecord[]>({ kind: 'conversations.listConversations', profileId: this.session.profileId, localNodeId: this.session.localNodeId, options })).map(parseConversationRecord)
  }
  async listMessageCounts(conversationIds?: readonly string[]): Promise<Record<string, number>> {
    validateIdSetQuery(conversationIds)
    return await this.session.repositoryOperation<Record<string, number>>({ kind: 'conversations.listMessageCounts', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationIds })
  }
  async listFirstUserMessages(conversationIds?: readonly string[]): Promise<Record<string, ConversationMessageRecord>> {
    validateIdSetQuery(conversationIds)
    const messages = await this.session.repositoryOperation<Record<string, ConversationMessageRecord>>({ kind: 'conversations.listFirstUserMessages', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationIds })
    return Object.fromEntries(Object.entries(messages).map(([conversationId, message]) => [conversationId, parseConversationMessageRecord(message)]))
  }
  async listMessages(conversationId: string, options?: MessageListQuery): Promise<ConversationMessageRecord[]> {
    validateQueryId(conversationId, 'conversation.id'); validateMessageQuery(options)
    return (await this.session.repositoryOperation<ConversationMessageRecord[]>({ kind: 'conversations.listMessages', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationId, options })).map(parseConversationMessageRecord)
  }
  async getLatestMessageSequence(conversationId: string): Promise<number | null> {
    validateQueryId(conversationId, 'conversation.id')
    return await this.session.repositoryOperation<number | null>({ kind: 'conversations.getLatestMessageSequence', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationId })
  }
}

class TauriMemoryRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertMemoryItem(record: LightweightMemoryRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'memory.upsertMemoryItem', record: parseLightweightMemoryRecord(record) })
  }
  async deleteMemoryItem(memoryItemId: string): Promise<DeleteRecordResult> {
    return await this.session.repositoryOperation<DeleteRecordResult>({ kind: 'memory.deleteMemoryItem', memoryItemId })
  }
  async deleteExpiredMemoryItems(scope: LocalDataScope, nowMs: number, limit: number): Promise<DeleteExpiredMemoryItemsResult> {
    return await this.session.repositoryOperation<DeleteExpiredMemoryItemsResult>({
      kind: 'memory.deleteExpiredMemoryItems',
      profileId: scope.profileId,
      localNodeId: scope.localNodeId,
      nowMs,
      limit
    })
  }
  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return (await this.session.repositoryOperation<LightweightMemoryRecord[]>(namespace === undefined
      ? { kind: 'memory.listMemoryItems', profileId: this.session.profileId, localNodeId: this.session.localNodeId }
      : { kind: 'memory.listMemoryItems', profileId: this.session.profileId, localNodeId: this.session.localNodeId, namespace })).map(parseLightweightMemoryRecord)
  }
}

class TauriLocalToolStateRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertLocalToolState(record: LocalToolStateRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'localTools.upsertLocalToolState', record: parseLocalToolStateRecord(record) })
  }
  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return (await this.session.repositoryOperation<LocalToolStateRecord[]>({ kind: 'localTools.listLocalToolStates', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parseLocalToolStateRecord)
  }
}

class TauriPeerGrantRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertPeerGrant(record: PeerGrantMetadataRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'peerGrants.upsertPeerGrant', record: parsePeerGrantMetadataRecord(record) })
  }
  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return (await this.session.repositoryOperation<PeerGrantMetadataRecord[]>({ kind: 'peerGrants.listPeerGrants', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parsePeerGrantMetadataRecord)
  }
}

class TauriLocalAuditRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async appendAudit(record: LocalAuditRecord): Promise<void> {
    await this.session.repositoryOperation({ kind: 'localAudit.appendAudit', record: parseLocalAuditRecord(record) })
  }
  async listAudit(): Promise<LocalAuditRecord[]> {
    return (await this.session.repositoryOperation<LocalAuditRecord[]>({ kind: 'localAudit.listAudit', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parseLocalAuditRecord)
  }
}

class TauriTranscriptArchiveRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}

  async createSession(record: TranscriptSessionRecord): Promise<TranscriptSessionRecord> {
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.createSession', record: parseTranscriptSessionRecord(record) }))
  }
  async startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord> {
    const id = validateTranscriptId(sessionId)
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.startSession', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId: id, startedAtMs: validateTranscriptTimestamp(startedAtMs, 'transcript_started_at') }))
  }
  async appendSegment(record: TranscriptSegmentRecord): Promise<AppendTranscriptSegmentResult> {
    const result = await this.session.repositoryOperation<AppendTranscriptSegmentResult>({ kind: 'transcripts.appendSegment', record: parseTranscriptSegmentRecord(record) })
    return { appended: result.appended, record: parseTranscriptSegmentRecord(result.record) }
  }
  async getSession(sessionId: string): Promise<TranscriptSessionRecord | null> {
    const record = await this.session.repositoryOperation<TranscriptSessionRecord | null>({ kind: 'transcripts.getSession', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId: validateTranscriptId(sessionId) })
    return record === null ? null : parseTranscriptSessionRecord(record)
  }
  async listSessions(options?: TranscriptSessionListQuery): Promise<TranscriptSessionRecord[]> {
    validateTranscriptSessionQuery(options)
    return (await this.session.repositoryOperation<TranscriptSessionRecord[]>({ kind: 'transcripts.listSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId, ...(options === undefined ? {} : { options }) })).map(parseTranscriptSessionRecord)
  }
  async listSegments(sessionId: string, options?: TranscriptSegmentListQuery): Promise<TranscriptSegmentRecord[]> {
    validateTranscriptSegmentQuery(options)
    return (await this.session.repositoryOperation<TranscriptSegmentRecord[]>({ kind: 'transcripts.listSegments', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId: validateTranscriptId(sessionId), ...(options === undefined ? {} : { options }) })).map(parseTranscriptSegmentRecord)
  }
  async finalizeSession(input: FinalizeTranscriptSessionInput): Promise<TranscriptSessionRecord> {
    validateTranscriptId(input.sessionId)
    if (input.lifecycle !== 'completed' && input.lifecycle !== 'interrupted' && input.lifecycle !== 'failed') queryError('transcript_lifecycle')
    validateTranscriptTimestamp(input.endedAtMs, 'transcript_ended_at')
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.finalizeSession', profileId: this.session.profileId, localNodeId: this.session.localNodeId, input }))
  }
  async recoverActiveSessions(nowMs: number, terminalReason?: string): Promise<RecoverTranscriptSessionsResult> {
    validateTranscriptTimestamp(nowMs, 'transcript_recovery_now')
    return await this.session.repositoryOperation({ kind: 'transcripts.recoverActiveSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId, nowMs, ...(terminalReason === undefined ? {} : { terminalReason }) })
  }
  async deleteSession(sessionId: string): Promise<DeleteTranscriptSessionResult> {
    return await this.session.repositoryOperation({ kind: 'transcripts.deleteSession', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId: validateTranscriptId(sessionId) })
  }
  async deleteExpiredSessions(nowMs: number, limit: number): Promise<DeleteExpiredTranscriptSessionsResult> {
    validateTranscriptTimestamp(nowMs, 'transcript_delete_now')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOCAL_DATA_TRANSCRIPT_DELETE_LIMIT) queryError('transcript_delete_limit')
    return await this.session.repositoryOperation({ kind: 'transcripts.deleteExpiredSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId, nowMs, limit })
  }
}

function validateTranscriptId(value: string): string {
  return parseLocalDataBoundary(localDataIdSchema, value, 'transcript.session_id')
}

function validateTranscriptTimestamp(value: number, reason: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) queryError(reason)
  return value
}

function validateTranscriptSessionQuery(options?: TranscriptSessionListQuery): void {
  if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_TRANSCRIPT_SESSION_QUERY_MAX)) queryError('transcript_session_limit')
  if (options?.cursor !== undefined) {
    validateTranscriptTimestamp(options.cursor.createdAtMs, 'transcript_session_cursor_created_at')
    validateTranscriptId(options.cursor.id)
  }
}

function validateTranscriptSegmentQuery(options?: TranscriptSegmentListQuery): void {
  if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > LOCAL_DATA_TRANSCRIPT_SEGMENT_QUERY_MAX)) queryError('transcript_segment_limit')
  if (options?.afterSequence !== undefined && (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0 || Object.is(options.afterSequence, -0))) queryError('transcript_segment_after_sequence')
}

function parseStatus(value: unknown): LocalDataBackendStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tauri local data status')
  const status = value as LocalDataBackendStatus
  if (status.kind !== 'sqlite-tauri' || status.persistent !== true || status.sqlite !== true) throw new Error('Invalid Tauri local data status')
  return status
}

function parseTransactionBeginResponse(value: unknown): { txId: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tauri local data transaction response')
  const txId = (value as { txId?: unknown }).txId
  if (typeof txId !== 'string' || !/^tx-[a-f0-9]{32}$/u.test(txId)) throw new Error('Invalid Tauri local data transaction response')
  return { txId }
}

function transactionScopeError(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Invalid local data boundary: transaction.scope', {
    boundaryId: 'transaction.scope',
    validation: 'redacted',
    issues: [{ code: reason, path: '' }]
  })
}
