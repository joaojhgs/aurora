import {
  LocalDataError,
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
  type LocalDataRepositories,
  type LocalDataSession,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'
import { invokeAuroraLocalDataCommand } from './tauri-local-data-invoke.js'

export interface TauriSqliteLocalDataBackendOptions {
  readonly invokeCommand?: (command: string, args: Record<string, unknown>) => Promise<unknown>
}

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.listConversations'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'conversations.listMessages'; readonly profileId: string; readonly localNodeId: string; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.listMemoryItems'; readonly profileId: string; readonly localNodeId: string; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants'; readonly profileId: string; readonly localNodeId: string }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit'; readonly profileId: string; readonly localNodeId: string }

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
  private closed = false

  constructor(
    readonly profileId: string,
    readonly localNodeId: string,
    readonly schemaVersion: number,
    private readonly invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly txId?: string
  ) {
    this.conversations = new TauriConversationRepository(this)
    this.memory = new TauriMemoryRepository(this)
    this.localTools = new TauriLocalToolStateRepository(this)
    this.peerGrants = new TauriPeerGrantRepository(this)
    this.localAudit = new TauriLocalAuditRepository(this)
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    this.assertOpen()
    const txId = crypto.randomUUID()
    await this.invokeCommand('aurora_local_data_transaction_begin', { request: { txId } })
    const txSession = new TauriSqliteLocalDataSession(this.profileId, this.localNodeId, this.schemaVersion, this.invokeCommand, txId)
    try {
      const result = await work(txSession)
      await this.invokeCommand('aurora_local_data_transaction_commit', { request: { txId } })
      return result
    } catch (error) {
      await this.invokeCommand('aurora_local_data_transaction_rollback', { request: { txId } }).catch(() => undefined)
      throw error
    } finally {
      await txSession.markClosed()
    }
  }

  async exportV1(): Promise<LocalDataExportV1> {
    this.assertOpen()
    return parseLocalDataExportV1(await this.invokeCommand('aurora_local_data_export_v1', {}))
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    this.assertOpen()
    return await this.invokeCommand('aurora_local_data_import_v1', { request: { document: parseLocalDataExportV1(document) } }) as LocalDataImportResult
  }

  async close(): Promise<void> {
    await this.markClosed()
  }

  async markClosed(): Promise<void> {
    this.closed = true
  }

  async repositoryOperation<T>(operation: RepositoryOperation): Promise<T> {
    this.assertOpen()
    const value = await this.invokeCommand('aurora_local_data_repository_operation', {
      request: this.txId === undefined ? { operation } : { txId: this.txId, operation }
    })
    return value as T
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
  async listConversations(): Promise<ConversationRecord[]> {
    return (await this.session.repositoryOperation<ConversationRecord[]>({ kind: 'conversations.listConversations', profileId: this.session.profileId, localNodeId: this.session.localNodeId })).map(parseConversationRecord)
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

function parseStatus(value: unknown): LocalDataBackendStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tauri local data status')
  const status = value as LocalDataBackendStatus
  if (status.kind !== 'sqlite-tauri' || status.persistent !== true || status.sqlite !== true) throw new Error('Invalid Tauri local data status')
  return status
}
