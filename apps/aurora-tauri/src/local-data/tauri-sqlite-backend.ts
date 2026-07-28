import Database from '@tauri-apps/plugin-sql'
import {
  buildLocalDataExportV1,
  localDataMigrationManifest,
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
  type LocalDataRecordCollections,
  type LocalDataRepositories,
  type LocalDataSession,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'

const TAURI_LOCAL_DATA_DB_URL = 'sqlite:aurora-lightweight.db'
const CURRENT_SCHEMA_VERSION = localDataMigrationManifest.latestVersion

interface TauriSqlDatabase {
  execute(query: string, bindValues?: readonly unknown[]): Promise<unknown>
  select<T = Record<string, unknown>>(query: string, bindValues?: readonly unknown[]): Promise<T[]>
  close(): Promise<unknown>
}

export interface TauriSqliteLocalDataBackendOptions {
  readonly loadDatabase?: (url: string) => Promise<TauriSqlDatabase>
  readonly nowMs?: () => number
}

type RepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.listConversations' }
  | { readonly kind: 'conversations.listMessages'; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.listMemoryItems'; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates' }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants' }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit' }

export class TauriSqliteLocalDataBackend implements LocalDataBackend {
  readonly kind = 'sqlite-tauri' as const
  readonly persistent = true
  readonly sqlite = true
  private readonly loadDatabase: (url: string) => Promise<TauriSqlDatabase>
  private readonly nowMs: () => number
  private db: TauriSqlDatabase | null = null
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
    this.loadDatabase = options.loadDatabase ?? ((url) => Database.load(url) as Promise<TauriSqlDatabase>)
    this.nowMs = options.nowMs ?? (() => Date.now())
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.session !== null) {
      if (this.session.profileId !== profileId || this.session.localNodeId !== localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Tauri local data backend is already open for another identity')
      }
      return this.session
    }
    this.statusValue = { ...this.statusValue, migrationState: 'running' }
    const db = await this.loadDatabase(TAURI_LOCAL_DATA_DB_URL)
    this.db = db
    try {
      await run(db, 'PRAGMA foreign_keys = ON;')
      await validateMigrations(db)
      await ensureDatabaseIdentity(db, localNodeId)
      await validateForeignKeys(db)
      const schemaVersion = await getUserVersion(db)
      this.session = new TauriSqliteLocalDataSession(profileId, localNodeId, schemaVersion, db, this.nowMs)
      this.statusValue = {
        kind: 'sqlite-tauri',
        persistent: true,
        sqlite: true,
        profileId,
        schemaVersion,
        migrationState: 'idle'
      }
      return this.session
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        profileId: null,
        schemaVersion: null,
        migrationState: 'failed',
        degradedReason: error instanceof LocalDataError ? error.metadata?.reason : 'open_failed'
      }
      await db.close().catch(() => undefined)
      this.db = null
      throw error
    }
  }

  async status(): Promise<LocalDataBackendStatus> {
    return this.statusValue
  }

  async close(): Promise<void> {
    await this.session?.markClosed()
    this.session = null
    await this.db?.execute('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined)
    await this.db?.close().catch(() => undefined)
    this.db = null
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
  private queue: Promise<unknown> = Promise.resolve()
  private activeTransaction = false
  private closed = false

  constructor(
    readonly profileId: string,
    readonly localNodeId: string,
    readonly schemaVersion: number,
    private readonly db: TauriSqlDatabase,
    private readonly nowMs: () => number,
    private readonly txToken?: symbol
  ) {
    this.conversations = new TauriConversationRepository(this)
    this.memory = new TauriMemoryRepository(this)
    this.localTools = new TauriLocalToolStateRepository(this)
    this.peerGrants = new TauriPeerGrantRepository(this)
    this.localAudit = new TauriLocalAuditRepository(this)
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.activeTransaction) throw transactionScopeError('nested_transaction')
    return await this.enqueue(async () => {
      this.assertOpen()
      this.activeTransaction = true
      const token = Symbol('tauri-local-data-transaction')
      const txSession = new TauriSqliteLocalDataSession(this.profileId, this.localNodeId, this.schemaVersion, this.db, this.nowMs, token)
      await run(this.db, 'BEGIN IMMEDIATE;')
      try {
        const result = await work(txSession)
        await run(this.db, 'COMMIT;')
        return result
      } catch (error) {
        await run(this.db, 'ROLLBACK;').catch(() => undefined)
        throw error
      } finally {
        await txSession.markClosed()
        this.activeTransaction = false
      }
    })
  }

  async exportV1(): Promise<LocalDataExportV1> {
    return await this.withAccess(() => exportV1(this.db, this.profileId, this.localNodeId, this.schemaVersion, this.nowMs()))
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    return await this.withAccess(async () => {
      const parsed = parseLocalDataExportV1(document)
      if (parsed.profileId !== this.profileId || parsed.localNodeId !== this.localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the open session')
      }
      if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new LocalDataError('invalid_record', 'Local data export schema is newer than the open session', { reason: 'future_schema' })
      }
      await run(this.db, 'BEGIN IMMEDIATE;')
      try {
        await deleteCurrentScope(this.db, this.profileId, this.localNodeId)
        for (const record of parsed.records.conversations) await executeRepositoryOperation(this, { kind: 'conversations.upsertConversation', record })
        for (const record of parsed.records.messages) await executeRepositoryOperation(this, { kind: 'conversations.appendMessage', record })
        for (const record of parsed.records.memoryItems) await executeRepositoryOperation(this, { kind: 'memory.upsertMemoryItem', record })
        for (const record of parsed.records.localToolStates) await executeRepositoryOperation(this, { kind: 'localTools.upsertLocalToolState', record })
        for (const record of parsed.records.peerGrantMetadata) await executeRepositoryOperation(this, { kind: 'peerGrants.upsertPeerGrant', record })
        for (const record of parsed.records.localAudit) await executeRepositoryOperation(this, { kind: 'localAudit.appendAudit', record })
        await validateForeignKeys(this.db)
        await run(this.db, 'COMMIT;')
      } catch (error) {
        await run(this.db, 'ROLLBACK;').catch(() => undefined)
        throw error
      }
      const exported = await exportV1(this.db, this.profileId, this.localNodeId, this.schemaVersion, this.nowMs())
      return {
        imported: true,
        recordCounts: exported.recordCounts,
        collectionHashes: exported.collectionHashes
      }
    })
  }

  async close(): Promise<void> {
    await this.markClosed()
  }

  async markClosed(): Promise<void> {
    this.closed = true
  }

  async withAccess<T>(work: () => Promise<T>): Promise<T> {
    if (this.txToken !== undefined) {
      this.assertOpen()
      return await work()
    }
    return await this.enqueue(async () => {
      this.assertOpen()
      return await work()
    })
  }

  assertOpen(): void {
    if (this.closed) throw new LocalDataError('session_closed', 'Local data session is closed')
  }

  assertIdentity(profileId: string, localNodeId: string): void {
    if (profileId !== this.profileId || localNodeId !== this.localNodeId) {
      throw new LocalDataError('identity_mismatch', 'Local data record identity does not match the open session')
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

class TauriConversationRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertConversation(record: ConversationRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'conversations.upsertConversation', record }))
  }
  async appendMessage(record: ConversationMessageRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'conversations.appendMessage', record }))
  }
  async listConversations(): Promise<ConversationRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'conversations.listConversations' }) as Promise<ConversationRecord[]>)
  }
  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'conversations.listMessages', conversationId }) as Promise<ConversationMessageRecord[]>)
  }
}

class TauriMemoryRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertMemoryItem(record: LightweightMemoryRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'memory.upsertMemoryItem', record }))
  }
  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, namespace === undefined ? { kind: 'memory.listMemoryItems' } : { kind: 'memory.listMemoryItems', namespace }) as Promise<LightweightMemoryRecord[]>)
  }
}

class TauriLocalToolStateRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertLocalToolState(record: LocalToolStateRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'localTools.upsertLocalToolState', record }))
  }
  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'localTools.listLocalToolStates' }) as Promise<LocalToolStateRecord[]>)
  }
}

class TauriPeerGrantRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async upsertPeerGrant(record: PeerGrantMetadataRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'peerGrants.upsertPeerGrant', record }))
  }
  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'peerGrants.listPeerGrants' }) as Promise<PeerGrantMetadataRecord[]>)
  }
}

class TauriLocalAuditRepository {
  constructor(private readonly session: TauriSqliteLocalDataSession) {}
  async appendAudit(record: LocalAuditRecord): Promise<void> {
    await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'localAudit.appendAudit', record }))
  }
  async listAudit(): Promise<LocalAuditRecord[]> {
    return await this.session.withAccess(() => executeRepositoryOperation(this.session, { kind: 'localAudit.listAudit' }) as Promise<LocalAuditRecord[]>)
  }
}

async function executeRepositoryOperation(session: TauriSqliteLocalDataSession, operation: RepositoryOperation): Promise<unknown> {
  const db = (session as unknown as { db: TauriSqlDatabase }).db
  switch (operation.kind) {
    case 'conversations.upsertConversation': {
      const record = parseConversationRecord(operation.record)
      session.assertIdentity(record.profileId, record.localNodeId)
      await run(db, 'INSERT INTO aurora_conversations (id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, title_envelope_json = excluded.title_envelope_json, created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms, archived_at_ms = excluded.archived_at_ms;', [record.id, record.profileId, record.localNodeId, jsonOrNull(record.titleEnvelope), record.createdAtMs, record.updatedAtMs, record.archivedAtMs])
      return undefined
    }
    case 'conversations.appendMessage': {
      const record = parseConversationMessageRecord(operation.record)
      await requireConversationInScope(db, session.profileId, session.localNodeId, record.conversationId)
      await run(db, 'INSERT INTO aurora_messages (id, conversation_id, sequence, role, content_envelope_json, tool_envelope_json, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, sequence = excluded.sequence, role = excluded.role, content_envelope_json = excluded.content_envelope_json, tool_envelope_json = excluded.tool_envelope_json, status = excluded.status, created_at_ms = excluded.created_at_ms;', [record.id, record.conversationId, record.sequence, record.role, jsonOrNull(record.contentEnvelope), jsonOrNull(record.toolEnvelope), record.status, record.createdAtMs])
      return undefined
    }
    case 'conversations.listConversations':
      return (await select<ConversationRow>(db, 'SELECT * FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ? ORDER BY updated_at_ms DESC, id ASC;', [session.profileId, session.localNodeId])).map(rowToConversation)
    case 'conversations.listMessages':
      return (await select<MessageRow>(db, 'SELECT messages.* FROM aurora_messages messages JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE messages.conversation_id = ? AND conversations.profile_id = ? AND conversations.local_node_id = ? ORDER BY messages.sequence ASC, messages.id ASC;', [operation.conversationId, session.profileId, session.localNodeId])).map(rowToMessage)
    case 'memory.upsertMemoryItem': {
      const record = parseLightweightMemoryRecord(operation.record)
      session.assertIdentity(record.profileId, record.localNodeId)
      await run(db, 'INSERT INTO aurora_memory_items (id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, namespace = excluded.namespace, payload_envelope_json = excluded.payload_envelope_json, source_type = excluded.source_type, source_id = excluded.source_id, created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms;', [record.id, record.profileId, record.localNodeId, record.namespace, JSON.stringify(record.payloadEnvelope), record.sourceType, record.sourceId, record.createdAtMs, record.updatedAtMs, record.expiresAtMs])
      return undefined
    }
    case 'memory.listMemoryItems':
      return (operation.namespace === undefined
        ? await select<MemoryRow>(db, 'SELECT * FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? ORDER BY namespace ASC, id ASC;', [session.profileId, session.localNodeId])
        : await select<MemoryRow>(db, 'SELECT * FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? AND namespace = ? ORDER BY namespace ASC, id ASC;', [session.profileId, session.localNodeId, operation.namespace])).map(rowToMemory)
    case 'localTools.upsertLocalToolState': {
      const record = parseLocalToolStateRecord(operation.record)
      session.assertIdentity(record.profileId, record.localNodeId)
      await run(db, 'INSERT INTO aurora_local_tool_state (profile_id, local_node_id, tool_contract_id, descriptor_json, descriptor_hash, enabled, settings_envelope_json, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, local_node_id, tool_contract_id) DO UPDATE SET descriptor_json = excluded.descriptor_json, descriptor_hash = excluded.descriptor_hash, enabled = excluded.enabled, settings_envelope_json = excluded.settings_envelope_json, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms;', [record.profileId, record.localNodeId, record.toolContractId, JSON.stringify(record.descriptorJson), record.descriptorHash, record.enabled ? 1 : 0, jsonOrNull(record.settingsEnvelope), record.revision, record.updatedAtMs])
      return undefined
    }
    case 'localTools.listLocalToolStates':
      return (await select<LocalToolRow>(db, 'SELECT * FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ? ORDER BY tool_contract_id ASC;', [session.profileId, session.localNodeId])).map(rowToLocalTool)
    case 'peerGrants.upsertPeerGrant': {
      const record = parsePeerGrantMetadataRecord(operation.record)
      session.assertIdentity(record.profileId, record.localNodeId)
      await run(db, 'INSERT INTO aurora_peer_grant_metadata (grant_id, profile_id, local_node_id, claimant_peer_id, token_id, scope_envelope_json, revision, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, claimant_peer_id = excluded.claimant_peer_id, token_id = excluded.token_id, scope_envelope_json = excluded.scope_envelope_json, revision = excluded.revision, created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms, revoked_at_ms = excluded.revoked_at_ms;', [record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId, JSON.stringify(record.scopeEnvelope), record.revision, record.createdAtMs, record.expiresAtMs, record.revokedAtMs])
      return undefined
    }
    case 'peerGrants.listPeerGrants':
      return (await select<PeerGrantRow>(db, 'SELECT * FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ? ORDER BY claimant_peer_id ASC, token_id ASC;', [session.profileId, session.localNodeId])).map(rowToPeerGrant)
    case 'localAudit.appendAudit': {
      const record = parseLocalAuditRecord(operation.record)
      session.assertIdentity(record.profileId, record.localNodeId)
      await run(db, 'INSERT INTO aurora_local_audit (id, profile_id, local_node_id, peer_id, action, decision, result_status, connection_epoch, method_id, tool_contract_id, correlation_id, redacted_detail_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);', [record.id, record.profileId, record.localNodeId, record.peerId, record.action, record.decision, record.resultStatus, record.connectionEpoch, record.methodId, record.toolContractId, record.correlationId, JSON.stringify(record.redactedDetailJson), record.createdAtMs])
      return undefined
    }
    case 'localAudit.listAudit':
      return (await select<AuditRow>(db, 'SELECT * FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ? ORDER BY created_at_ms DESC, id ASC;', [session.profileId, session.localNodeId])).map(rowToAudit)
  }
}

async function validateMigrations(db: TauriSqlDatabase): Promise<void> {
  const userVersion = await getUserVersion(db)
  if (userVersion > CURRENT_SCHEMA_VERSION) throw new LocalDataError('migration_integrity', 'Local data schema is newer than this application', { reason: 'future_schema' })
  const rows = await getStoredLedgerRows(db)
  let expectedVersion = 1
  for (const row of rows) {
    const entry = localDataMigrationManifest.migrations[row.version - 1]
    if (row.version !== expectedVersion || entry === undefined || entry.checksum !== row.checksum) {
      throw new LocalDataError('migration_integrity', 'Stored migration checksum does not match immutable manifest')
    }
    expectedVersion += 1
  }
  if (rows.length !== userVersion) {
    throw new LocalDataError('migration_integrity', 'Local data migration ledger does not match database version', { reason: 'ledger_user_version_mismatch' })
  }
}

async function ensureDatabaseIdentity(db: TauriSqlDatabase, localNodeId: string): Promise<void> {
  const rows = await select<{ singleton_id: number; local_node_id: string }>(db, 'SELECT singleton_id, local_node_id FROM aurora_database_identity ORDER BY singleton_id ASC;')
  if (rows.length === 0) {
    await run(db, 'INSERT INTO aurora_database_identity (singleton_id, local_node_id, created_at_ms) VALUES (1, ?, ?);', [localNodeId, Date.now()])
    return
  }
  if (rows.length !== 1 || rows[0]?.singleton_id !== 1) throw new LocalDataError('identity_mismatch', 'Local data database identity is invalid', { reason: 'identity_invalid' })
  if (rows[0].local_node_id !== localNodeId) throw new LocalDataError('identity_mismatch', 'Local data database identity does not match this device')
}

async function getStoredLedgerRows(db: TauriSqlDatabase): Promise<Array<{ version: number; checksum: string }>> {
  return await select<{ version: number; checksum: string }>(db, 'SELECT version, checksum FROM aurora_schema_migrations ORDER BY version ASC;')
}

async function getUserVersion(db: TauriSqlDatabase): Promise<number> {
  const row = (await select<{ user_version: number }>(db, 'PRAGMA user_version;'))[0]
  return row?.user_version ?? 0
}

async function validateForeignKeys(db: TauriSqlDatabase): Promise<void> {
  const failures = await select<Record<string, unknown>>(db, 'PRAGMA foreign_key_check;')
  if (failures.length > 0) throw new LocalDataError('migration_integrity', 'Local data foreign key check failed', { reason: 'foreign_key_check' })
}

async function deleteCurrentScope(db: TauriSqlDatabase, profileId: string, localNodeId: string): Promise<void> {
  await run(db, 'DELETE FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ?;', [profileId, localNodeId])
  await run(db, 'DELETE FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ?;', [profileId, localNodeId])
  await run(db, 'DELETE FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ?;', [profileId, localNodeId])
  await run(db, 'DELETE FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ?;', [profileId, localNodeId])
  await run(db, 'DELETE FROM aurora_messages WHERE conversation_id IN (SELECT id FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?);', [profileId, localNodeId])
  await run(db, 'DELETE FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?;', [profileId, localNodeId])
}

async function exportV1(db: TauriSqlDatabase, profileId: string, localNodeId: string, schemaVersion: number, exportedAtMs: number): Promise<LocalDataExportV1> {
  const records: LocalDataRecordCollections = {
    conversations: (await select<ConversationRow>(db, 'SELECT * FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ? ORDER BY updated_at_ms DESC, id ASC;', [profileId, localNodeId])).map(rowToConversation),
    messages: (await select<MessageRow>(db, 'SELECT messages.* FROM aurora_messages messages JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE conversations.profile_id = ? AND conversations.local_node_id = ? ORDER BY messages.conversation_id ASC, messages.sequence ASC, messages.id ASC;', [profileId, localNodeId])).map(rowToMessage),
    memoryItems: (await select<MemoryRow>(db, 'SELECT * FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? ORDER BY namespace ASC, id ASC;', [profileId, localNodeId])).map(rowToMemory),
    localToolStates: (await select<LocalToolRow>(db, 'SELECT * FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ? ORDER BY tool_contract_id ASC;', [profileId, localNodeId])).map(rowToLocalTool),
    peerGrantMetadata: (await select<PeerGrantRow>(db, 'SELECT * FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ? ORDER BY claimant_peer_id ASC, token_id ASC;', [profileId, localNodeId])).map(rowToPeerGrant),
    localAudit: (await select<AuditRow>(db, 'SELECT * FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ? ORDER BY created_at_ms DESC, id ASC;', [profileId, localNodeId])).map(rowToAudit)
  }
  return buildLocalDataExportV1({ sourceBackend: 'sqlite-tauri', schemaVersion, profileId, localNodeId, exportedAtMs, records })
}

async function requireConversationInScope(db: TauriSqlDatabase, profileId: string, localNodeId: string, conversationId: string): Promise<void> {
  const rows = await select<{ id: string }>(db, 'SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [conversationId, profileId, localNodeId])
  if (rows.length !== 1) throw new LocalDataError('invalid_record', 'Message conversation does not exist')
}

async function run(db: TauriSqlDatabase, sql: string, bind: readonly unknown[] = []): Promise<void> {
  await db.execute(sql, bind)
}

async function select<T extends Record<string, unknown>>(db: TauriSqlDatabase, sql: string, bind: readonly unknown[] = []): Promise<T[]> {
  return await db.select<T>(sql, bind)
}

function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value)
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T
}

interface ConversationRow extends Record<string, unknown> { id: string; profile_id: string; local_node_id: string; title_envelope_json: string | null; created_at_ms: number; updated_at_ms: number; archived_at_ms: number | null }
interface MessageRow extends Record<string, unknown> { id: string; conversation_id: string; sequence: number; role: ConversationMessageRecord['role']; content_envelope_json: string | null; tool_envelope_json: string | null; status: ConversationMessageRecord['status']; created_at_ms: number }
interface MemoryRow extends Record<string, unknown> { id: string; profile_id: string; local_node_id: string; namespace: string; payload_envelope_json: string; source_type: string | null; source_id: string | null; created_at_ms: number; updated_at_ms: number; expires_at_ms: number | null }
interface LocalToolRow extends Record<string, unknown> { profile_id: string; local_node_id: string; tool_contract_id: string; descriptor_json: string; descriptor_hash: string; enabled: number; settings_envelope_json: string | null; revision: number; updated_at_ms: number }
interface PeerGrantRow extends Record<string, unknown> { grant_id: string; profile_id: string; local_node_id: string; claimant_peer_id: string; token_id: string; scope_envelope_json: string; revision: number; created_at_ms: number; expires_at_ms: number | null; revoked_at_ms: number | null }
interface AuditRow extends Record<string, unknown> { id: string; profile_id: string; local_node_id: string; peer_id: string | null; action: string; decision: string; result_status: string; connection_epoch: string | null; method_id: string | null; tool_contract_id: string | null; correlation_id: string | null; redacted_detail_json: string; created_at_ms: number }

function rowToConversation(row: ConversationRow): ConversationRecord {
  return parseConversationRecord({ id: row.id, profileId: row.profile_id, localNodeId: row.local_node_id, titleEnvelope: parseJson(row.title_envelope_json), createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, archivedAtMs: row.archived_at_ms })
}
function rowToMessage(row: MessageRow): ConversationMessageRecord {
  return parseConversationMessageRecord({ id: row.id, conversationId: row.conversation_id, sequence: row.sequence, role: row.role, contentEnvelope: parseJson(row.content_envelope_json), toolEnvelope: parseJson(row.tool_envelope_json), status: row.status, createdAtMs: row.created_at_ms })
}
function rowToMemory(row: MemoryRow): LightweightMemoryRecord {
  return parseLightweightMemoryRecord({ id: row.id, profileId: row.profile_id, localNodeId: row.local_node_id, namespace: row.namespace, payloadEnvelope: JSON.parse(row.payload_envelope_json), sourceType: row.source_type, sourceId: row.source_id, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, expiresAtMs: row.expires_at_ms })
}
function rowToLocalTool(row: LocalToolRow): LocalToolStateRecord {
  return parseLocalToolStateRecord({ profileId: row.profile_id, localNodeId: row.local_node_id, toolContractId: row.tool_contract_id, descriptorJson: JSON.parse(row.descriptor_json), descriptorHash: row.descriptor_hash, enabled: row.enabled === 1, settingsEnvelope: parseJson(row.settings_envelope_json), revision: row.revision, updatedAtMs: row.updated_at_ms })
}
function rowToPeerGrant(row: PeerGrantRow): PeerGrantMetadataRecord {
  return parsePeerGrantMetadataRecord({ grantId: row.grant_id, profileId: row.profile_id, localNodeId: row.local_node_id, claimantPeerId: row.claimant_peer_id, tokenId: row.token_id, scopeEnvelope: JSON.parse(row.scope_envelope_json), revision: row.revision, createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms, revokedAtMs: row.revoked_at_ms })
}
function rowToAudit(row: AuditRow): LocalAuditRecord {
  return parseLocalAuditRecord({ id: row.id, profileId: row.profile_id, localNodeId: row.local_node_id, peerId: row.peer_id, action: row.action, decision: row.decision, resultStatus: row.result_status, connectionEpoch: row.connection_epoch, methodId: row.method_id, toolContractId: row.tool_contract_id, correlationId: row.correlation_id, redactedDetailJson: JSON.parse(row.redacted_detail_json), createdAtMs: row.created_at_ms })
}

function transactionScopeError(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Invalid local data boundary: transaction.scope', {
    boundaryId: 'transaction.scope',
    validation: 'redacted',
    issues: [{ code: reason, path: '' }]
  })
}
