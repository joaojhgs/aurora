import {
  LocalDataError,
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
  type LocalDataRepositories,
  type LocalDataScope,
  type LocalDataSession,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord,
  type DeleteTranscriptSessionResult,
  type TranscriptAppendResult,
  type TranscriptLifecycle,
  type TranscriptRecoveryResult,
  type TranscriptRetentionResult,
  type TranscriptSegmentRecord,
  type TranscriptSessionRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'
import { invokeAuroraLocalDataCommand } from './tauri-local-data-invoke.js'

export interface TauriSqliteLocalDataBackendOptions {
  readonly invokeCommand?: (command: string, args: Record<string, unknown>) => Promise<unknown>
}

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.deleteConversation'; readonly conversationId: string }
  | { readonly kind: 'conversations.listConversations'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'conversations.listMessageCounts'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'conversations.listFirstUserMessages'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'conversations.listMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
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
  | { readonly kind: 'transcripts.startSession'; readonly sessionId: string; readonly startedAtMs: number }
  | { readonly kind: 'transcripts.appendSegment'; readonly record: TranscriptSegmentRecord }
  | { readonly kind: 'transcripts.getSession'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.listSessions'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'transcripts.listSegments'; readonly profileId: string; readonly localNodeId: string; readonly sessionId: string }
  | { readonly kind: 'transcripts.finalizeSession'; readonly sessionId: string; readonly lifecycle: Exclude<TranscriptLifecycle, 'active'>; readonly endedAtMs: number; readonly terminalReason: string }
  | { readonly kind: 'transcripts.recoverActiveSessions'; readonly profileId: string; readonly localNodeId: string; readonly nowMs: number; readonly terminalReason?: string }
  | { readonly kind: 'transcripts.deleteSession'; readonly sessionId: string }
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
  private opening: { readonly profileId: string; readonly localNodeId: string; readonly promise: Promise<LocalDataSession> } | null = null
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

    if (this.opening !== null) {
      if (this.opening.profileId !== profileId || this.opening.localNodeId !== localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Tauri local data backend is already opening for another identity')
      }
      return await this.opening.promise
    }

    const promise = this.openReady(profileId, localNodeId)
    this.opening = { profileId, localNodeId, promise }
    try {
      return await promise
    } finally {
      if (this.opening?.promise === promise) this.opening = null
    }
  }

  private async openReady(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    let nativeOpened = false
    try {
      const status = await this.invokeCommand('aurora_local_data_open', { request: { profileId, localNodeId } })
      nativeOpened = true
      this.statusValue = parseStatus(status)
      const provisionalSession = new TauriSqliteLocalDataSession(profileId, localNodeId, this.statusValue.schemaVersion ?? 0, this.invokeCommand)
      await provisionalSession.recoverActiveTranscripts(Date.now())
      this.session = provisionalSession
      return provisionalSession
    } catch (error) {
      if (nativeOpened) await this.invokeCommand('aurora_local_data_close', {}).catch(() => undefined)
      this.session = null
      this.statusValue = {
        kind: 'sqlite-tauri',
        persistent: true,
        sqlite: true,
        profileId: null,
        schemaVersion: null,
        migrationState: 'failed',
        ...(error instanceof LocalDataError && error.metadata?.reason === undefined ? {} : { degradedReason: error instanceof LocalDataError ? error.metadata?.reason : 'open_failed' })
      }
      throw error
    }
  }

  async status(): Promise<LocalDataBackendStatus> {
    this.statusValue = parseStatus(await this.invokeCommand('aurora_local_data_status', {}))
    return this.statusValue
  }

  async close(): Promise<void> {
    await this.opening?.promise.catch(() => undefined)
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
  readonly transcripts: TauriTranscriptRepository
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
    this.transcripts = new TauriTranscriptRepository(this)
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

  async recoverActiveTranscripts(nowMs: number, terminalReason = 'process_restart'): Promise<TranscriptRecoveryResult> {
    return await this.transcripts.recoverActiveSessions(nowMs, terminalReason)
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
      return await this.invokeCommand('aurora_local_data_repository_operation', { request }) as T
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
  async listConversations(): Promise<ConversationRecord[]> {
    return (await this.session.repositoryOperation<ConversationRecord[]>({ kind: 'conversations.listConversations', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parseConversationRecord)
  }
  async listMessageCounts(): Promise<Record<string, number>> {
    return await this.session.repositoryOperation<Record<string, number>>({ kind: 'conversations.listMessageCounts', profileId: this.session.profileId, localNodeId: this.session.localNodeId })
  }
  async listFirstUserMessages(): Promise<Record<string, ConversationMessageRecord>> {
    const messages = await this.session.repositoryOperation<Record<string, ConversationMessageRecord>>({ kind: 'conversations.listFirstUserMessages', profileId: this.session.profileId, localNodeId: this.session.localNodeId })
    return Object.fromEntries(Object.entries(messages).map(([conversationId, message]) => [conversationId, parseConversationMessageRecord(message)]))
  }
  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return (await this.session.repositoryOperation<ConversationMessageRecord[]>({ kind: 'conversations.listMessages', profileId: this.session.profileId, localNodeId: this.session.localNodeId, conversationId })).map(parseConversationMessageRecord)
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

class TauriTranscriptRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async createSession(record: TranscriptSessionRecord): Promise<TranscriptSessionRecord> {
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.createSession', record: parseTranscriptSessionRecord(record) }))
  }
  async startSession(sessionId: string, startedAtMs: number): Promise<TranscriptSessionRecord> {
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.startSession', sessionId, startedAtMs }))
  }
  async appendSegment(record: TranscriptSegmentRecord): Promise<TranscriptAppendResult> {
    const result = await this.session.repositoryOperation<TranscriptAppendResult>({ kind: 'transcripts.appendSegment', record: parseTranscriptSegmentRecord(record) })
    return { appended: result.appended, record: parseTranscriptSegmentRecord(result.record) }
  }
  async getSession(sessionId: string): Promise<TranscriptSessionRecord | null> {
    const result = await this.session.repositoryOperation<TranscriptSessionRecord | null>({ kind: 'transcripts.getSession', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId })
    return result === null ? null : parseTranscriptSessionRecord(result)
  }
  async listSessions(): Promise<TranscriptSessionRecord[]> {
    return (await this.session.repositoryOperation<TranscriptSessionRecord[]>({ kind: 'transcripts.listSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parseTranscriptSessionRecord)
  }
  async listSegments(sessionId: string): Promise<TranscriptSegmentRecord[]> {
    return (await this.session.repositoryOperation<TranscriptSegmentRecord[]>({ kind: 'transcripts.listSegments', profileId: this.session.profileId, localNodeId: this.session.localNodeId, sessionId })).map(parseTranscriptSegmentRecord)
  }
  async finalizeSession(sessionId: string, lifecycle: Exclude<TranscriptLifecycle, 'active'>, endedAtMs: number, terminalReason: string): Promise<TranscriptSessionRecord> {
    return parseTranscriptSessionRecord(await this.session.repositoryOperation({ kind: 'transcripts.finalizeSession', sessionId, lifecycle, endedAtMs, terminalReason }))
  }
  async recoverActiveSessions(nowMs: number, terminalReason = 'process_restart'): Promise<TranscriptRecoveryResult> {
    return await this.session.repositoryOperation<TranscriptRecoveryResult>({ kind: 'transcripts.recoverActiveSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId, nowMs, terminalReason })
  }
  async deleteSession(sessionId: string): Promise<DeleteTranscriptSessionResult> {
    return await this.session.repositoryOperation<DeleteTranscriptSessionResult>({ kind: 'transcripts.deleteSession', sessionId })
  }
  async deleteExpiredSessions(nowMs: number, limit: number): Promise<TranscriptRetentionResult> {
    return await this.session.repositoryOperation<TranscriptRetentionResult>({ kind: 'transcripts.deleteExpiredSessions', profileId: this.session.profileId, localNodeId: this.session.localNodeId, nowMs, limit })
  }
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
