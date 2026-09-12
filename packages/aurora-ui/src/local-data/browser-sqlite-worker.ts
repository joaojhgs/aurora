import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
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
  type LocalDataBackendKind,
  type LocalDataExportV1,
  type LocalDataMigrationManifest,
  type LocalDataRepositories,
  type LocalDataScope,
  type LocalDataSession,
  type LocalDataRecordCollections,
  type LocalAuditRecord,
  type LocalToolStateRecord,
  type LightweightMemoryRecord,
  type PeerGrantMetadataRecord
} from '@aurora/client/local-data'

import { sha256Hex, type BrowserSqliteStorageIdentity } from './browser-sqlite-opfs'
import { browserSqliteRequestByteLimit } from './browser-sqlite-worker-limits'

type WorkerResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RedactedWorkerError }

export type BrowserSqliteWorkerRequest =
  | { readonly id: string; readonly command: 'open'; readonly profileId: string; readonly localNodeId: string; readonly identity: BrowserSqliteStorageIdentity; readonly migrationSql: readonly BrowserSqliteMigrationSql[]; readonly wasmAssetUrl: string }
  | { readonly id: string; readonly command: 'status' }
  | { readonly id: string; readonly command: 'close' }
  | { readonly id: string; readonly command: 'cancel'; readonly targetId: string }
  | { readonly id: string; readonly command: 'beginTransaction'; readonly txId: string }
  | { readonly id: string; readonly command: 'commitTransaction'; readonly txId: string }
  | { readonly id: string; readonly command: 'rollbackTransaction'; readonly txId: string }
  | { readonly id: string; readonly command: 'repo'; readonly operation: BrowserSqliteRepositoryOperation; readonly txId?: string }
  | { readonly id: string; readonly command: 'exportV1' }
  | { readonly id: string; readonly command: 'importV1'; readonly document: LocalDataExportV1 }

export interface BrowserSqliteWorkerResponse {
  readonly id: string
  readonly result: WorkerResult
}

export interface BrowserSqliteMigrationSql {
  readonly version: number
  readonly sql: string
}

export type BrowserSqliteRepositoryOperation =
  | { readonly kind: 'conversations.upsertConversation'; readonly record: ConversationRecord }
  | { readonly kind: 'conversations.appendMessage'; readonly record: ConversationMessageRecord }
  | { readonly kind: 'conversations.deleteConversation'; readonly conversationId: string }
  | { readonly kind: 'conversations.listConversations' }
  | { readonly kind: 'conversations.listMessageCounts' }
  | { readonly kind: 'conversations.listFirstUserMessages' }
  | { readonly kind: 'conversations.listMessages'; readonly conversationId: string }
  | { readonly kind: 'memory.upsertMemoryItem'; readonly record: LightweightMemoryRecord }
  | { readonly kind: 'memory.deleteMemoryItem'; readonly memoryItemId: string }
  | { readonly kind: 'memory.deleteExpiredMemoryItems'; readonly scope: LocalDataScope; readonly nowMs: number; readonly limit: number }
  | { readonly kind: 'memory.listMemoryItems'; readonly namespace?: string }
  | { readonly kind: 'localTools.upsertLocalToolState'; readonly record: LocalToolStateRecord }
  | { readonly kind: 'localTools.listLocalToolStates' }
  | { readonly kind: 'peerGrants.upsertPeerGrant'; readonly record: PeerGrantMetadataRecord }
  | { readonly kind: 'peerGrants.listPeerGrants' }
  | { readonly kind: 'localAudit.appendAudit'; readonly record: LocalAuditRecord }
  | { readonly kind: 'localAudit.listAudit' }

interface RedactedWorkerError {
  readonly code: string
  readonly message: string
  readonly metadata?: { readonly reason?: string; readonly boundaryId?: string; readonly validation?: 'redacted' }
}

interface BrowserSqliteWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(response: BrowserSqliteWorkerResponse): void
}

interface WorkerState {
  db: SqliteDatabase | null
  profileId: string | null
  localNodeId: string | null
  schemaVersion: number | null
  migrationState: 'idle' | 'running' | 'failed'
  closed: boolean
  activeTransactionId: string | null
  operationQueue: Promise<unknown>
  cancelled: Set<string>
}

type SqliteDatabase = {
  exec: (options: string | { sql: string; bind?: readonly unknown[] | Record<string, unknown>; returnValue?: 'resultRows'; rowMode?: 'object' }) => unknown
  close: () => void
}

type SqliteModule = {
  installOpfsSAHPoolVfs: (options: { directory: string; name?: string; clearOnInit?: boolean }) => Promise<{ OpfsSAHPoolDb: new (filename: string) => SqliteDatabase }>
}

const CURRENT_SCHEMA_VERSION = localDataMigrationManifest.latestVersion

const state: WorkerState = {
  db: null,
  profileId: null,
  localNodeId: null,
  schemaVersion: null,
  migrationState: 'idle',
  closed: false,
  activeTransactionId: null,
  operationQueue: Promise.resolve(),
  cancelled: new Set()
}

if (typeof self !== 'undefined' && typeof (self as BrowserSqliteWorkerScope).postMessage === 'function') {
  const scope = self as BrowserSqliteWorkerScope
  scope.onmessage = (event: MessageEvent<unknown>) => {
    void handleBrowserSqliteWorkerMessage(event.data, scope.postMessage.bind(scope), state)
  }
}

export async function handleBrowserSqliteWorkerMessage(
  rawMessage: unknown,
  postMessage: (response: BrowserSqliteWorkerResponse) => void,
  workerState: WorkerState = state
): Promise<void> {
  const request = parseWorkerRequest(rawMessage)
  if (request.command === 'cancel') {
    workerState.cancelled.add(request.targetId)
    postMessage({ id: request.id, result: { ok: true, value: { cancelled: true } } })
    return
  }
  const run = async (): Promise<unknown> => {
    if (workerState.cancelled.has(request.id)) throw new LocalDataError('session_closed', 'Local data operation was cancelled', { reason: 'cancelled' })
    return executeWorkerRequest(request, workerState)
  }
  const resultPromise = workerState.operationQueue.then(run, run)
  workerState.operationQueue = resultPromise.then(() => undefined, () => undefined)
  const result = await resultPromise.then(
    (value): WorkerResult => ({ ok: true, value }),
    (error): WorkerResult => ({ ok: false, error: redactWorkerError(error) })
  )
  workerState.cancelled.delete(request.id)
  postMessage({ id: request.id, result })
}

async function executeWorkerRequest(request: BrowserSqliteWorkerRequest, workerState: WorkerState): Promise<unknown> {
  switch (request.command) {
    case 'open':
      return openDatabase(request, workerState)
    case 'status':
      return status(workerState)
    case 'close':
      return closeDatabase(workerState)
    case 'beginTransaction':
      assertOpenState(workerState)
      if (workerState.activeTransactionId !== null) throw transactionScopeError('nested_transaction')
      exec(workerState.db, 'BEGIN IMMEDIATE;')
      workerState.activeTransactionId = request.txId
      return { txId: request.txId }
    case 'commitTransaction':
      assertTransaction(workerState, request.txId)
      exec(workerState.db, 'COMMIT;')
      workerState.activeTransactionId = null
      return { committed: true }
    case 'rollbackTransaction':
      assertTransaction(workerState, request.txId)
      exec(workerState.db, 'ROLLBACK;')
      workerState.activeTransactionId = null
      return { rolledBack: true }
    case 'repo':
      if (request.txId !== undefined) assertTransaction(workerState, request.txId)
      return executeRepositoryOperation(workerState, request.operation)
    case 'exportV1':
      return exportV1(workerState)
    case 'importV1':
      return importV1(workerState, request.document)
    case 'cancel':
      return { cancelled: true }
    default:
      return assertNever(request)
  }
}

async function openDatabase(request: Extract<BrowserSqliteWorkerRequest, { command: 'open' }>, workerState: WorkerState): Promise<unknown> {
  if (workerState.db !== null) {
    if (workerState.profileId !== request.profileId || workerState.localNodeId !== request.localNodeId) {
      throw new LocalDataError('identity_mismatch', 'Local data database is already open for another identity')
    }
    return status(workerState)
  }
  workerState.migrationState = 'running'
  let openedDb: SqliteDatabase | null = null
  try {
    const initSqlite = sqlite3InitModule as unknown as (options: { locateFile: (path: string) => string }) => Promise<unknown>
    const sqlite3 = await initSqlite({
      locateFile: (path: string) => path.endsWith('.wasm') ? request.wasmAssetUrl : path
    }) as unknown as SqliteModule
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      directory: request.identity.sahPoolDirectory,
      clearOnInit: false
    })
    const db = new pool.OpfsSAHPoolDb(request.identity.databaseName)
    openedDb = db
    const initialUserVersion = getUserVersion(db)
    const hadIdentityTable = tableExists(db, 'aurora_database_identity')
    assertExistingSqliteLocalNodeOwnership(db, request.localNodeId)
    workerState.db = db
    workerState.profileId = request.profileId
    workerState.localNodeId = request.localNodeId
    exec(db, 'PRAGMA foreign_keys = ON;')
    applyMigrations(db, localDataMigrationManifest, request.migrationSql)
    ensureDatabaseIdentity(db, request.localNodeId, !hadIdentityTable && initialUserVersion === 0)
    assertDatabaseLocalNodeOwnership(db, request.localNodeId)
    validateForeignKeys(db)
    workerState.schemaVersion = getUserVersion(db)
    workerState.migrationState = 'idle'
    return status(workerState)
  } catch (error) {
    workerState.migrationState = 'failed'
    try {
      ;(workerState.db ?? openedDb)?.close()
    } catch {
      // Ignore close failures after initialization errors.
    }
    workerState.db = null
    workerState.profileId = null
    workerState.localNodeId = null
    workerState.schemaVersion = null
    throw error
  }
}

function closeDatabase(workerState: WorkerState): unknown {
  if (workerState.activeTransactionId !== null) {
    try {
      exec(workerState.db, 'ROLLBACK;')
    } catch {
      // Ignore rollback failure during close.
    }
  }
  workerState.activeTransactionId = null
  workerState.db?.close()
  workerState.db = null
  workerState.closed = true
  workerState.profileId = null
  workerState.localNodeId = null
  workerState.schemaVersion = null
  return { closed: true }
}

function status(workerState: WorkerState): unknown {
  return {
    kind: 'sqlite-wasm-opfs' satisfies LocalDataBackendKind,
    persistent: true,
    sqlite: true,
    profileId: workerState.profileId,
    schemaVersion: workerState.schemaVersion,
    migrationState: workerState.migrationState
  }
}

function ensureDatabaseIdentity(db: SqliteDatabase, localNodeId: string, freshDatabase: boolean): void {
  if (!tableExists(db, 'aurora_database_identity')) {
    throw new LocalDataError('migration_integrity', 'Local data identity table is missing', { reason: 'identity_table_missing' })
  }
  const rows = selectObjects<{ singleton_id: number; local_node_id: string }>(db, 'SELECT singleton_id, local_node_id FROM aurora_database_identity ORDER BY singleton_id ASC;')
  if (rows.length === 0) {
    if (!freshDatabase) {
      throw new LocalDataError('identity_mismatch', 'Local data database identity is missing', { reason: 'identity_missing' })
    }
    run(db, 'INSERT INTO aurora_database_identity (singleton_id, local_node_id, created_at_ms) VALUES (1, ?, ?);', [localNodeId, Date.now()])
    return
  }
  if (rows.length !== 1 || rows[0]?.singleton_id !== 1) {
    throw new LocalDataError('identity_mismatch', 'Local data database identity is invalid', { reason: 'identity_invalid' })
  }
  if (rows[0].local_node_id !== localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Local data database identity does not match this device')
  }
}

function applyMigrations(db: SqliteDatabase, manifest: LocalDataMigrationManifest, migrationSql: readonly BrowserSqliteMigrationSql[]): void {
  const userVersion = getUserVersion(db)
  if (userVersion > manifest.latestVersion) {
    throw new LocalDataError('migration_integrity', 'Local data schema is newer than this application', { reason: 'future_schema' })
  }
  const ledgerRows = getStoredLedgerRows(db)
  validateStoredLedger(manifest, ledgerRows)
  if (ledgerRows.length !== userVersion && userVersion !== 0) {
    throw new LocalDataError('migration_integrity', 'Local data migration ledger does not match database version', { reason: 'ledger_user_version_mismatch' })
  }
  const sqlByVersion = new Map(migrationSql.map((entry) => [entry.version, entry.sql]))
  for (const migration of manifest.migrations.slice(ledgerRows.length)) {
    const sql = sqlByVersion.get(migration.version)
    if (sql === undefined) throw new LocalDataError('migration_integrity', 'Migration SQL is missing', { reason: 'missing_sql' })
    if (sha256Hex(sql) !== migration.checksum) {
      throw new LocalDataError('migration_integrity', 'Migration SQL does not match immutable manifest checksum', { reason: 'migration_sql_checksum' })
    }
    exec(db, 'BEGIN IMMEDIATE;')
    try {
      exec(db, sql)
      exec(db, migration.ledger_sql)
      exec(db, 'COMMIT;')
    } catch (error) {
      exec(db, 'ROLLBACK;')
      throw error
    }
  }
}

function getStoredLedgerRows(db: SqliteDatabase): Array<{ version: number; checksum: string }> {
  if (!tableExists(db, 'aurora_schema_migrations')) return []
  return selectObjects<{ version: number; checksum: string }>(db, 'SELECT version, checksum FROM aurora_schema_migrations ORDER BY version ASC;')
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  return selectObjects<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;", [tableName]).length > 0
}

function columnExists(db: SqliteDatabase, tableName: string, columnName: string): boolean {
  return selectObjects<{ name: string }>(db, `PRAGMA table_info(${quoteIdentifier(tableName)});`).some((row) => row.name === columnName)
}

function tableHasColumns(db: SqliteDatabase, tableName: string, columnNames: readonly string[]): boolean {
  if (!tableExists(db, tableName)) return false
  return columnNames.every((columnName) => columnExists(db, tableName, columnName))
}

function validateStoredLedger(manifest: LocalDataMigrationManifest, stored: Array<{ version: number; checksum: string }>): void {
  let expectedVersion = 1
  const seen = new Set<number>()
  for (const row of stored) {
    if (!Number.isSafeInteger(row.version) || row.version < 1 || seen.has(row.version) || row.version !== expectedVersion) {
      throw new LocalDataError('migration_integrity', 'Stored migration ledger is invalid')
    }
    seen.add(row.version)
    const entry = manifest.migrations[row.version - 1]
    if (entry === undefined || entry.checksum !== row.checksum) {
      throw new LocalDataError('migration_integrity', 'Stored migration checksum does not match immutable manifest')
    }
    expectedVersion += 1
  }
}

function getUserVersion(db: SqliteDatabase): number {
  const row = selectObjects<{ user_version: number }>(db, 'PRAGMA user_version;')[0]
  return row?.user_version ?? 0
}

function validateForeignKeys(db: SqliteDatabase): void {
  const failures = selectObjects<Record<string, unknown>>(db, 'PRAGMA foreign_key_check;')
  if (failures.length > 0) {
    throw new LocalDataError('migration_integrity', 'Local data foreign key check failed', { reason: 'foreign_key_check' })
  }
}

function executeRepositoryOperation(workerState: WorkerState, operation: BrowserSqliteRepositoryOperation): unknown {
  assertOpenState(workerState)
  const db = workerState.db
  switch (operation.kind) {
    case 'conversations.upsertConversation': {
      const record = parseConversationRecord(operation.record)
      assertRecordIdentity(workerState, record.profileId, record.localNodeId)
      assertNoSqliteScopedKeyCollision(db, 'aurora_conversations', 'id', record.id, workerState)
      run(db, 'INSERT INTO aurora_conversations (id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, title_envelope_json = excluded.title_envelope_json, created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms, archived_at_ms = excluded.archived_at_ms;', [
        record.id, record.profileId, record.localNodeId, jsonOrNull(record.titleEnvelope), record.createdAtMs, record.updatedAtMs, record.archivedAtMs
      ])
      return undefined
    }
    case 'conversations.appendMessage': {
      const record = parseConversationMessageRecord(operation.record)
      requireConversationInScope(db, workerState, record.conversationId)
      assertNoSqliteMessageIdCollision(db, record, workerState)
      run(db, 'INSERT INTO aurora_messages (id, conversation_id, sequence, role, content_envelope_json, tool_envelope_json, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, sequence = excluded.sequence, role = excluded.role, content_envelope_json = excluded.content_envelope_json, tool_envelope_json = excluded.tool_envelope_json, status = excluded.status, created_at_ms = excluded.created_at_ms;', [
        record.id, record.conversationId, record.sequence, record.role, jsonOrNull(record.contentEnvelope), jsonOrNull(record.toolEnvelope), record.status, record.createdAtMs
      ])
      return undefined
    }
    case 'conversations.listConversations':
      return selectObjects<ConversationRow>(db, 'SELECT * FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ? ORDER BY updated_at_ms DESC, id ASC;', [workerState.profileId, workerState.localNodeId]).map(rowToConversation)
    case 'conversations.listMessageCounts':
      return Object.fromEntries(selectObjects<{ conversation_id: string; count: number }>(
        db,
        'SELECT messages.conversation_id, COUNT(*) AS count FROM aurora_messages messages INNER JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE conversations.profile_id = ? AND conversations.local_node_id = ? GROUP BY messages.conversation_id;',
        [workerState.profileId, workerState.localNodeId]
      ).map((row) => [row.conversation_id, Number(row.count)]))
    case 'conversations.listFirstUserMessages':
      return Object.fromEntries(selectObjects<MessageRow>(
        db,
        'SELECT messages.* FROM aurora_messages messages INNER JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE conversations.profile_id = ? AND conversations.local_node_id = ? AND messages.role = ? AND NOT EXISTS (SELECT 1 FROM aurora_messages earlier WHERE earlier.conversation_id = messages.conversation_id AND earlier.role = ? AND (earlier.sequence < messages.sequence OR (earlier.sequence = messages.sequence AND earlier.id < messages.id))) ORDER BY messages.conversation_id ASC, messages.sequence ASC, messages.id ASC;',
        [workerState.profileId, workerState.localNodeId, 'user', 'user']
      ).map((row) => [row.conversation_id, rowToMessage(row)]))
    case 'conversations.listMessages':
      return selectObjects<MessageRow>(db, 'SELECT messages.* FROM aurora_messages messages JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE messages.conversation_id = ? AND conversations.profile_id = ? AND conversations.local_node_id = ? ORDER BY messages.sequence ASC, messages.id ASC;', [operation.conversationId, workerState.profileId, workerState.localNodeId]).map(rowToMessage)
    case 'conversations.deleteConversation': {
      const rows = selectObjects<{ id: string }>(db, 'SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [operation.conversationId, workerState.profileId, workerState.localNodeId])
      if (rows.length === 0) return { deleted: false, deletedMessages: 0 }
      const messageCount = selectCount(db, 'SELECT COUNT(*) AS count FROM aurora_messages WHERE conversation_id = ?;', [operation.conversationId])
      run(db, 'DELETE FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [operation.conversationId, workerState.profileId, workerState.localNodeId])
      return { deleted: true, deletedMessages: messageCount }
    }
    case 'memory.upsertMemoryItem': {
      const record = parseLightweightMemoryRecord(operation.record)
      assertRecordIdentity(workerState, record.profileId, record.localNodeId)
      assertNoSqliteScopedKeyCollision(db, 'aurora_memory_items', 'id', record.id, workerState)
      run(db, 'INSERT INTO aurora_memory_items (id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, namespace = excluded.namespace, payload_envelope_json = excluded.payload_envelope_json, source_type = excluded.source_type, source_id = excluded.source_id, created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms;', [
        record.id, record.profileId, record.localNodeId, record.namespace, JSON.stringify(record.payloadEnvelope), record.sourceType, record.sourceId, record.createdAtMs, record.updatedAtMs, record.expiresAtMs
      ])
      return undefined
    }
    case 'memory.deleteMemoryItem': {
      const rows = selectObjects<{ id: string }>(db, 'SELECT id FROM aurora_memory_items WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [operation.memoryItemId, workerState.profileId, workerState.localNodeId])
      if (rows.length === 0) return { deleted: false }
      run(db, 'DELETE FROM aurora_memory_items WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [operation.memoryItemId, workerState.profileId, workerState.localNodeId])
      return { deleted: true }
    }
    case 'memory.deleteExpiredMemoryItems': {
      assertRecordIdentity(workerState, operation.scope.profileId, operation.scope.localNodeId)
      const cutoffMs = requireDeleteNowMs(operation.nowMs)
      const normalizedLimit = requireDeleteLimit(operation.limit)
      const rows = selectObjects<{ id: string }>(
        db,
        'SELECT id FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? AND expires_at_ms IS NOT NULL AND expires_at_ms <= ? ORDER BY expires_at_ms ASC, id ASC LIMIT ?;',
        [operation.scope.profileId, operation.scope.localNodeId, cutoffMs, normalizedLimit]
      )
      for (const row of rows) {
        run(db, 'DELETE FROM aurora_memory_items WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [row.id, operation.scope.profileId, operation.scope.localNodeId])
      }
      return { deleted: rows.length }
    }
    case 'memory.listMemoryItems': {
      const rows = operation.namespace === undefined
        ? selectObjects<MemoryRow>(db, 'SELECT * FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? ORDER BY namespace ASC, id ASC;', [workerState.profileId, workerState.localNodeId])
        : selectObjects<MemoryRow>(db, 'SELECT * FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? AND namespace = ? ORDER BY namespace ASC, id ASC;', [workerState.profileId, workerState.localNodeId, operation.namespace])
      return rows.map(rowToMemory)
    }
    case 'localTools.upsertLocalToolState': {
      const record = parseLocalToolStateRecord(operation.record)
      assertRecordIdentity(workerState, record.profileId, record.localNodeId)
      run(db, 'INSERT INTO aurora_local_tool_state (profile_id, local_node_id, tool_contract_id, descriptor_json, descriptor_hash, enabled, settings_envelope_json, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, local_node_id, tool_contract_id) DO UPDATE SET descriptor_json = excluded.descriptor_json, descriptor_hash = excluded.descriptor_hash, enabled = excluded.enabled, settings_envelope_json = excluded.settings_envelope_json, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms;', [
        record.profileId, record.localNodeId, record.toolContractId, JSON.stringify(record.descriptorJson), record.descriptorHash, record.enabled ? 1 : 0, jsonOrNull(record.settingsEnvelope), record.revision, record.updatedAtMs
      ])
      return undefined
    }
    case 'localTools.listLocalToolStates':
      return selectObjects<LocalToolRow>(db, 'SELECT * FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ? ORDER BY tool_contract_id ASC;', [workerState.profileId, workerState.localNodeId]).map(rowToLocalTool)
    case 'peerGrants.upsertPeerGrant': {
      const record = parsePeerGrantMetadataRecord(operation.record)
      assertRecordIdentity(workerState, record.profileId, record.localNodeId)
      assertNoSqliteScopedKeyCollision(db, 'aurora_peer_grant_metadata', 'grant_id', record.grantId, workerState)
      run(db, 'INSERT INTO aurora_peer_grant_metadata (grant_id, profile_id, local_node_id, claimant_peer_id, token_id, scope_envelope_json, revision, created_at_ms, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET profile_id = excluded.profile_id, local_node_id = excluded.local_node_id, claimant_peer_id = excluded.claimant_peer_id, token_id = excluded.token_id, scope_envelope_json = excluded.scope_envelope_json, revision = excluded.revision, created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms, revoked_at_ms = excluded.revoked_at_ms;', [
        record.grantId, record.profileId, record.localNodeId, record.claimantPeerId, record.tokenId, JSON.stringify(record.scopeEnvelope), record.revision, record.createdAtMs, record.expiresAtMs, record.revokedAtMs
      ])
      return undefined
    }
    case 'peerGrants.listPeerGrants':
      return selectObjects<PeerGrantRow>(db, 'SELECT * FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ? ORDER BY claimant_peer_id ASC, token_id ASC;', [workerState.profileId, workerState.localNodeId]).map(rowToPeerGrant)
    case 'localAudit.appendAudit': {
      const record = parseLocalAuditRecord(operation.record)
      assertRecordIdentity(workerState, record.profileId, record.localNodeId)
      assertNoSqliteScopedKeyCollision(db, 'aurora_local_audit', 'id', record.id, workerState)
      run(db, 'INSERT INTO aurora_local_audit (id, profile_id, local_node_id, peer_id, action, decision, result_status, connection_epoch, method_id, tool_contract_id, correlation_id, redacted_detail_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);', [
        record.id, record.profileId, record.localNodeId, record.peerId, record.action, record.decision, record.resultStatus, record.connectionEpoch, record.methodId, record.toolContractId, record.correlationId, JSON.stringify(record.redactedDetailJson), record.createdAtMs
      ])
      return undefined
    }
    case 'localAudit.listAudit':
      return selectObjects<AuditRow>(db, 'SELECT * FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ? ORDER BY created_at_ms DESC, id ASC;', [workerState.profileId, workerState.localNodeId]).map(rowToAudit)
    default:
      return assertNever(operation)
  }
}

function exportV1(workerState: WorkerState): LocalDataExportV1 {
  assertOpenState(workerState)
  const repositories = createSynchronousRepositories(workerState)
  const records: LocalDataRecordCollections = {
    conversations: repositories.conversations.listConversationsSync(),
    messages: repositories.conversations.listAllMessagesSync(),
    memoryItems: repositories.memory.listMemoryItemsSync(),
    localToolStates: repositories.localTools.listLocalToolStatesSync(),
    peerGrantMetadata: repositories.peerGrants.listPeerGrantsSync(),
    localAudit: repositories.localAudit.listAuditSync()
  }
  return buildLocalDataExportV1({
    sourceBackend: 'sqlite-wasm-opfs',
    schemaVersion: workerState.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    profileId: requireIdentity(workerState.profileId),
    localNodeId: requireIdentity(workerState.localNodeId),
    exportedAtMs: Date.now(),
    records
  })
}

function importV1(workerState: WorkerState, document: LocalDataExportV1): unknown {
  assertOpenState(workerState)
  const parsed = parseLocalDataExportV1(document)
  if (parsed.profileId !== workerState.profileId || parsed.localNodeId !== workerState.localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Local data export identity does not match the open session')
  }
  if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new LocalDataError('invalid_record', 'Local data export schema is newer than the open session', { reason: 'future_schema' })
  }
  assertDatabaseLocalNodeOwnership(workerState.db, workerState.localNodeId)
  assertNoSqliteImportScopedKeyCollisions(workerState.db, parsed.records, workerState)
  exec(workerState.db, 'BEGIN IMMEDIATE;')
  try {
    run(workerState.db, 'DELETE FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ?;', [workerState.profileId, workerState.localNodeId])
    run(workerState.db, 'DELETE FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ?;', [workerState.profileId, workerState.localNodeId])
    run(workerState.db, 'DELETE FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ?;', [workerState.profileId, workerState.localNodeId])
    run(workerState.db, 'DELETE FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ?;', [workerState.profileId, workerState.localNodeId])
    run(workerState.db, 'DELETE FROM aurora_messages WHERE conversation_id IN (SELECT id FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?);', [workerState.profileId, workerState.localNodeId])
    run(workerState.db, 'DELETE FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?;', [workerState.profileId, workerState.localNodeId])
    for (const record of parsed.records.conversations) executeRepositoryOperation(workerState, { kind: 'conversations.upsertConversation', record })
    for (const record of parsed.records.messages) executeRepositoryOperation(workerState, { kind: 'conversations.appendMessage', record })
    for (const record of parsed.records.memoryItems) executeRepositoryOperation(workerState, { kind: 'memory.upsertMemoryItem', record })
    for (const record of parsed.records.localToolStates) executeRepositoryOperation(workerState, { kind: 'localTools.upsertLocalToolState', record })
    for (const record of parsed.records.peerGrantMetadata) executeRepositoryOperation(workerState, { kind: 'peerGrants.upsertPeerGrant', record })
    for (const record of parsed.records.localAudit) executeRepositoryOperation(workerState, { kind: 'localAudit.appendAudit', record })
    validateForeignKeys(workerState.db)
    exec(workerState.db, 'COMMIT;')
  } catch (error) {
    exec(workerState.db, 'ROLLBACK;')
    throw error
  }
  const exported = exportV1(workerState)
  return {
    imported: true,
    recordCounts: exported.recordCounts,
    collectionHashes: exported.collectionHashes
  }
}

function createSynchronousRepositories(workerState: WorkerState) {
  return {
    conversations: {
      listConversationsSync: () => executeRepositoryOperation(workerState, { kind: 'conversations.listConversations' }) as ConversationRecord[],
      listAllMessagesSync: () => selectObjects<MessageRow>(workerState.db, 'SELECT messages.* FROM aurora_messages messages JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE conversations.profile_id = ? AND conversations.local_node_id = ? ORDER BY messages.conversation_id ASC, messages.sequence ASC, messages.id ASC;', [workerState.profileId, workerState.localNodeId]).map(rowToMessage)
    },
    memory: {
      listMemoryItemsSync: () => executeRepositoryOperation(workerState, { kind: 'memory.listMemoryItems' }) as LightweightMemoryRecord[]
    },
    localTools: {
      listLocalToolStatesSync: () => executeRepositoryOperation(workerState, { kind: 'localTools.listLocalToolStates' }) as LocalToolStateRecord[]
    },
    peerGrants: {
      listPeerGrantsSync: () => executeRepositoryOperation(workerState, { kind: 'peerGrants.listPeerGrants' }) as PeerGrantMetadataRecord[]
    },
    localAudit: {
      listAuditSync: () => executeRepositoryOperation(workerState, { kind: 'localAudit.listAudit' }) as LocalAuditRecord[]
    }
  }
}

function run(db: SqliteDatabase | null, sql: string, bind: readonly unknown[] = []): void {
  if (db === null) throw new LocalDataError('session_closed', 'Local data database is closed')
  db.exec({ sql, bind })
}

function exec(db: SqliteDatabase | null, sql: string): void {
  if (db === null) throw new LocalDataError('session_closed', 'Local data database is closed')
  db.exec(sql)
}

function selectObjects<T extends Record<string, unknown>>(db: SqliteDatabase | null, sql: string, bind: readonly unknown[] = []): T[] {
  if (db === null) throw new LocalDataError('session_closed', 'Local data database is closed')
  return db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' }) as T[]
}

function selectCount(db: SqliteDatabase | null, sql: string, bind: readonly unknown[] = []): number {
  const row = selectObjects<{ count: number }>(db, sql, bind)[0]
  return row?.count ?? 0
}

function assertOpenState(workerState: WorkerState): asserts workerState is WorkerState & { db: SqliteDatabase; profileId: string; localNodeId: string } {
  if (workerState.db === null || workerState.profileId === null || workerState.localNodeId === null) {
    throw new LocalDataError('session_closed', 'Local data database is closed')
  }
}

function assertTransaction(workerState: WorkerState, txId: string): void {
  assertOpenState(workerState)
  if (workerState.activeTransactionId !== txId) throw transactionScopeError('expired_transaction_repository')
}

function assertRecordIdentity(workerState: WorkerState, profileId: string, localNodeId: string): void {
  if (profileId !== workerState.profileId || localNodeId !== workerState.localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Local data record identity does not match the open session')
  }
}

function assertNoSqliteImportScopedKeyCollisions(
  db: SqliteDatabase,
  records: LocalDataRecordCollections,
  workerState: WorkerState & { profileId: string; localNodeId: string }
): void {
  for (const record of records.conversations) {
    assertRecordIdentity(workerState, record.profileId, record.localNodeId)
    assertNoSqliteScopedKeyCollision(db, 'aurora_conversations', 'id', record.id, workerState)
  }
  for (const record of records.messages) {
    assertNoSqliteMessageIdCollision(db, record, workerState)
  }
  for (const record of records.memoryItems) {
    assertRecordIdentity(workerState, record.profileId, record.localNodeId)
    assertNoSqliteScopedKeyCollision(db, 'aurora_memory_items', 'id', record.id, workerState)
  }
  for (const record of records.localToolStates) {
    assertRecordIdentity(workerState, record.profileId, record.localNodeId)
  }
  for (const record of records.peerGrantMetadata) {
    assertRecordIdentity(workerState, record.profileId, record.localNodeId)
    assertNoSqliteScopedKeyCollision(db, 'aurora_peer_grant_metadata', 'grant_id', record.grantId, workerState)
  }
  for (const record of records.localAudit) {
    assertRecordIdentity(workerState, record.profileId, record.localNodeId)
    assertNoSqliteScopedKeyCollision(db, 'aurora_local_audit', 'id', record.id, workerState)
  }
}

function assertNoSqliteScopedKeyCollision(
  db: SqliteDatabase,
  tableName: string,
  idColumn: string,
  id: string,
  workerState: WorkerState & { profileId: string; localNodeId: string }
): void {
  const rows = selectObjects<{ profile_id: string; local_node_id: string }>(
    db,
    `SELECT profile_id, local_node_id FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(idColumn)} = ? LIMIT 1;`,
    [id]
  )
  const existing = rows[0]
  if (existing !== undefined && (existing.profile_id !== workerState.profileId || existing.local_node_id !== workerState.localNodeId)) {
    throw scopedKeyCollision()
  }
}

function assertNoSqliteMessageIdCollision(
  db: SqliteDatabase,
  record: ConversationMessageRecord,
  workerState: WorkerState & { profileId: string; localNodeId: string }
): void {
  const rows = selectObjects<{ conversation_id: string; profile_id: string | null; local_node_id: string | null }>(
    db,
    'SELECT messages.conversation_id, conversations.profile_id, conversations.local_node_id FROM aurora_messages messages LEFT JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE messages.id = ? LIMIT 1;',
    [record.id]
  )
  const existing = rows[0]
  if (existing === undefined || existing.conversation_id === record.conversationId) return
  if (existing.profile_id !== workerState.profileId || existing.local_node_id !== workerState.localNodeId) {
    throw scopedKeyCollision()
  }
  throw new LocalDataError('invalid_record', 'Message IDs must be unique')
}

function assertDatabaseLocalNodeOwnership(db: SqliteDatabase | null, localNodeId: string): void {
  const checks: Array<{ readonly source: string; readonly sql: string }> = [
    { source: 'conversations', sql: 'SELECT id FROM aurora_conversations WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;' },
    { source: 'memory', sql: 'SELECT id FROM aurora_memory_items WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;' },
    { source: 'local_tools', sql: 'SELECT tool_contract_id FROM aurora_local_tool_state WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;' },
    { source: 'peer_grants', sql: 'SELECT grant_id FROM aurora_peer_grant_metadata WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;' },
    { source: 'local_audit', sql: 'SELECT id FROM aurora_local_audit WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;' }
  ]
  for (const check of checks) {
    if (selectObjects<Record<string, unknown>>(db, check.sql, [localNodeId]).length > 0) {
      throw localNodeOwnerMismatch()
    }
  }
}

export function assertExistingSqliteLocalNodeOwnership(db: SqliteDatabase, localNodeId: string): void {
  const checks: Array<{ readonly tableName: string; readonly idColumn: string }> = [
    { tableName: 'aurora_conversations', idColumn: 'id' },
    { tableName: 'aurora_memory_items', idColumn: 'id' },
    { tableName: 'aurora_local_tool_state', idColumn: 'tool_contract_id' },
    { tableName: 'aurora_peer_grant_metadata', idColumn: 'grant_id' },
    { tableName: 'aurora_local_audit', idColumn: 'id' }
  ]
  for (const check of checks) {
    if (!tableExists(db, check.tableName) || !tableHasRows(db, check.tableName)) continue
    const hasProfileId = columnExists(db, check.tableName, 'profile_id')
    const hasLocalNodeId = columnExists(db, check.tableName, 'local_node_id')
    if (!hasProfileId || !hasLocalNodeId) throw ambiguousProfileOwnership()
    if (hasMismatchedLocalNodeColumn(db, check.tableName, localNodeId)) throw localNodeOwnerMismatch()
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function tableHasRows(db: SqliteDatabase, tableName: string): boolean {
  return selectObjects<Record<string, unknown>>(db, `SELECT 1 FROM ${quoteIdentifier(tableName)} LIMIT 1;`).length > 0
}

function hasMismatchedLocalNodeColumn(db: SqliteDatabase, tableName: string, expectedValue: string): boolean {
  const column = quoteIdentifier('local_node_id')
  return selectObjects<Record<string, unknown>>(
    db,
    `SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE ${column} IS NULL OR ${column} <> ? LIMIT 1;`,
    [expectedValue]
  ).length > 0
}

function localNodeOwnerMismatch(): LocalDataError {
  return new LocalDataError('identity_mismatch', 'Local data database local node does not match the open session', { reason: 'local_node_owner_mismatch' })
}

function scopedKeyCollision(): LocalDataError {
  return new LocalDataError('identity_mismatch', 'Local data record ID is already owned by another profile on this device', { reason: 'profile_scope_collision' })
}

function ambiguousProfileOwnership(): LocalDataError {
  return new LocalDataError('identity_mismatch', 'Local data database local node ownership is incomplete', { reason: 'local_node_owner_ambiguous' })
}

function requireIdentity(value: string | null): string {
  if (value === null) throw new LocalDataError('session_closed', 'Local data database is closed')
  return value
}

function requireDeleteNowMs(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new LocalDataError('invalid_record', 'Delete cutoff must be a non-negative safe integer', { reason: 'delete_now_ms' })
  }
  return nowMs
}

function requireDeleteLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new LocalDataError('invalid_record', 'Delete limit must be a positive safe integer', { reason: 'delete_limit' })
  }
  return limit
}

function requireConversationInScope(db: SqliteDatabase, workerState: WorkerState & { profileId: string; localNodeId: string }, conversationId: string): void {
  const rows = selectObjects<{ id: string }>(db, 'SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?;', [conversationId, workerState.profileId, workerState.localNodeId])
  if (rows.length !== 1) {
    throw new LocalDataError('invalid_record', 'Message conversation does not exist')
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value)
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T
}

interface ConversationRow extends Record<string, unknown> {
  id: string
  profile_id: string
  local_node_id: string
  title_envelope_json: string | null
  created_at_ms: number
  updated_at_ms: number
  archived_at_ms: number | null
}

interface MessageRow extends Record<string, unknown> {
  id: string
  conversation_id: string
  sequence: number
  role: ConversationMessageRecord['role']
  content_envelope_json: string | null
  tool_envelope_json: string | null
  status: ConversationMessageRecord['status']
  created_at_ms: number
}

interface MemoryRow extends Record<string, unknown> {
  id: string
  profile_id: string
  local_node_id: string
  namespace: string
  payload_envelope_json: string
  source_type: string | null
  source_id: string | null
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number | null
}

interface LocalToolRow extends Record<string, unknown> {
  profile_id: string
  local_node_id: string
  tool_contract_id: string
  descriptor_json: string
  descriptor_hash: string
  enabled: number
  settings_envelope_json: string | null
  revision: number
  updated_at_ms: number
}

interface PeerGrantRow extends Record<string, unknown> {
  grant_id: string
  profile_id: string
  local_node_id: string
  claimant_peer_id: string
  token_id: string
  scope_envelope_json: string
  revision: number
  created_at_ms: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
}

interface AuditRow extends Record<string, unknown> {
  id: string
  profile_id: string
  local_node_id: string
  peer_id: string | null
  action: string
  decision: string
  result_status: string
  connection_epoch: string | null
  method_id: string | null
  tool_contract_id: string | null
  correlation_id: string | null
  redacted_detail_json: string
  created_at_ms: number
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return parseConversationRecord({
    id: row.id,
    profileId: row.profile_id,
    localNodeId: row.local_node_id,
    titleEnvelope: parseJson(row.title_envelope_json),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    archivedAtMs: row.archived_at_ms
  })
}

function rowToMessage(row: MessageRow): ConversationMessageRecord {
  return parseConversationMessageRecord({
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    contentEnvelope: parseJson(row.content_envelope_json),
    toolEnvelope: parseJson(row.tool_envelope_json),
    status: row.status,
    createdAtMs: row.created_at_ms
  })
}

function rowToMemory(row: MemoryRow): LightweightMemoryRecord {
  return parseLightweightMemoryRecord({
    id: row.id,
    profileId: row.profile_id,
    localNodeId: row.local_node_id,
    namespace: row.namespace,
    payloadEnvelope: JSON.parse(row.payload_envelope_json),
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms
  })
}

function rowToLocalTool(row: LocalToolRow): LocalToolStateRecord {
  return parseLocalToolStateRecord({
    profileId: row.profile_id,
    localNodeId: row.local_node_id,
    toolContractId: row.tool_contract_id,
    descriptorJson: JSON.parse(row.descriptor_json),
    descriptorHash: row.descriptor_hash,
    enabled: row.enabled === 1,
    settingsEnvelope: parseJson(row.settings_envelope_json),
    revision: row.revision,
    updatedAtMs: row.updated_at_ms
  })
}

function rowToPeerGrant(row: PeerGrantRow): PeerGrantMetadataRecord {
  return parsePeerGrantMetadataRecord({
    grantId: row.grant_id,
    profileId: row.profile_id,
    localNodeId: row.local_node_id,
    claimantPeerId: row.claimant_peer_id,
    tokenId: row.token_id,
    scopeEnvelope: JSON.parse(row.scope_envelope_json),
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms
  })
}

function rowToAudit(row: AuditRow): LocalAuditRecord {
  return parseLocalAuditRecord({
    id: row.id,
    profileId: row.profile_id,
    localNodeId: row.local_node_id,
    peerId: row.peer_id,
    action: row.action,
    decision: row.decision,
    resultStatus: row.result_status,
    connectionEpoch: row.connection_epoch,
    methodId: row.method_id,
    toolContractId: row.tool_contract_id,
    correlationId: row.correlation_id,
    redactedDetailJson: JSON.parse(row.redacted_detail_json),
    createdAtMs: row.created_at_ms
  })
}

function parseWorkerRequest(value: unknown): BrowserSqliteWorkerRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalDataError('invalid_record', 'Local data worker request is invalid', { reason: 'invalid_message' })
  }
  const request = value as BrowserSqliteWorkerRequest
  if (typeof request.id !== 'string' || request.id.length < 1 || typeof request.command !== 'string') {
    throw new LocalDataError('invalid_record', 'Local data worker request is invalid', { reason: 'invalid_message' })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (bytes > browserSqliteRequestByteLimit(request.command)) {
    throw new LocalDataError('invalid_record', 'Local data worker request is too large', { reason: 'message_too_large' })
  }
  return request
}

function redactWorkerError(error: unknown): RedactedWorkerError {
  if (error instanceof LocalDataError) {
    const metadata = {
      ...(error.metadata?.reason === undefined ? {} : { reason: error.metadata.reason }),
      ...(error.metadata?.boundaryId === undefined ? {} : { boundaryId: error.metadata.boundaryId }),
      ...(error.metadata?.validation === undefined ? {} : { validation: error.metadata.validation })
    }
    return {
      code: error.code,
      message: error.message,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata })
    }
  }
  return {
    code: 'unsupported_backend',
    message: 'Local data storage is unavailable'
  }
}

function transactionScopeError(reason: string): LocalDataError {
  return new LocalDataError('invalid_record', 'Invalid local data boundary: transaction.scope', {
    boundaryId: 'transaction.scope',
    validation: 'redacted',
    issues: [{ code: reason, path: '' }]
  })
}

function assertNever(value: never): never {
  throw new LocalDataError('invalid_record', 'Unsupported local data worker command', { reason: String((value as { command?: unknown }).command ?? 'unknown') })
}

export type { LocalDataRepositories, LocalDataSession }
