import {
  buildLocalDataExportV1,
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
} from '@aurora/client/local-data'

import {
  deriveBrowserSqliteStorageIdentity,
  probeBrowserSqliteOpfs,
  type BrowserSqliteProbeFailureReason,
  type BrowserSqliteOwnership,
  type BrowserSqliteOwnershipLock,
  type BrowserSqliteStorageIdentity
} from './browser-sqlite-opfs.js'
import type {
  BrowserSqliteMigrationSql,
  BrowserSqliteRepositoryOperation,
  BrowserSqliteWorkerRequest,
  BrowserSqliteWorkerResponse
} from './browser-sqlite-worker.js'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTBOUND_BYTES = 2 * 1024 * 1024

export interface BrowserSqliteLocalDataBackendOptions {
  readonly createWorker?: BrowserSqliteWorkerConstructor
  readonly lock?: BrowserSqliteOwnershipLock
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly wasmAssetUrl?: string
}

export type BrowserSqliteWorkerConstructor = () => BrowserSqliteProtocolWorker

export interface BrowserSqliteProtocolWorker {
  onmessage: ((event: MessageEvent<BrowserSqliteWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: BrowserSqliteWorkerRequest): void
  terminate(): void
}

export class BrowserSqliteLocalDataBackend implements LocalDataBackend {
  readonly kind = 'sqlite-wasm-opfs' as const
  readonly persistent = true
  readonly sqlite = true
  private readonly createWorker: BrowserSqliteWorkerConstructor
  private readonly lock: BrowserSqliteOwnershipLock | undefined
  private readonly timeoutMs: number
  private readonly signal: AbortSignal | undefined
  private readonly wasmAssetUrl: string
  private client: BrowserSqliteWorkerClient | null = null
  private session: BrowserSqliteLocalDataSession | null = null
  private statusValue: LocalDataBackendStatus = {
    kind: 'sqlite-wasm-opfs',
    persistent: true,
    sqlite: true,
    profileId: null,
    schemaVersion: null,
    migrationState: 'idle'
  }

  constructor(options: BrowserSqliteLocalDataBackendOptions = {}) {
    this.createWorker = options.createWorker ?? createDefaultBrowserSqliteWorker
    this.lock = options.lock
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.signal = options.signal
    this.wasmAssetUrl = options.wasmAssetUrl ?? new URL('@sqlite.org/sqlite-wasm/sqlite3.wasm', import.meta.url).href
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.session !== null) {
      if (this.session.profileId !== profileId || this.session.localNodeId !== localNodeId) {
        throw new LocalDataError('identity_mismatch', 'Browser local data backend is already open for another identity')
      }
      return this.session
    }
    const probe = await probeBrowserSqliteOpfs(localNodeId, {
      ...(this.lock === undefined ? {} : { lock: this.lock }),
      workerFactory: this.createWorker,
      wasmAssetUrl: this.wasmAssetUrl,
      ...(this.signal === undefined ? {} : { signal: this.signal })
    })
    if (!probe.ok) {
      this.statusValue = {
        ...this.statusValue,
        migrationState: 'failed',
        degradedReason: probe.reason
      }
      throw new LocalDataError('unsupported_backend', 'Browser local data SQLite is unavailable', { reason: probe.reason })
    }
    const worker = this.createWorker()
    const client = new BrowserSqliteWorkerClient(worker, {
      timeoutMs: this.timeoutMs,
      ownership: probe.ownership
    })
    try {
      const status = await client.open(profileId, localNodeId, probe.identity, browserSqliteMigrationSql, this.wasmAssetUrl)
      this.statusValue = status
      this.client = client
      this.session = new BrowserSqliteLocalDataSession(profileId, localNodeId, status.schemaVersion ?? 0, client)
      return this.session
    } catch (error) {
      await client.close().catch(() => undefined)
      this.statusValue = {
        ...this.statusValue,
        profileId: null,
        schemaVersion: null,
        migrationState: 'failed',
        degradedReason: fallbackReasonFromError(error)
      }
      throw error
    }
  }

  async status(): Promise<LocalDataBackendStatus> {
    if (this.client !== null) {
      this.statusValue = await this.client.status()
    }
    return this.statusValue
  }

  async close(): Promise<void> {
    await this.session?.markClosed()
    this.session = null
    await this.client?.close()
    this.client = null
    this.statusValue = {
      kind: 'sqlite-wasm-opfs',
      persistent: true,
      sqlite: true,
      profileId: null,
      schemaVersion: null,
      migrationState: 'idle'
    }
  }
}

export class BrowserSqliteWorkerClient {
  private readonly worker: BrowserSqliteProtocolWorker
  private readonly timeoutMs: number
  private readonly ownership: BrowserSqliteOwnership
  private readonly pending = new Map<string, PendingRequest>()
  private sequence = 0
  private closed = false

  constructor(worker: BrowserSqliteProtocolWorker, options: { timeoutMs: number; ownership: BrowserSqliteOwnership }) {
    this.worker = worker
    this.timeoutMs = options.timeoutMs
    this.ownership = options.ownership
    worker.onmessage = (event) => this.handleMessage(event.data)
    worker.onerror = () => this.rejectAll(new LocalDataError('unsupported_backend', 'Browser local data worker failed', { reason: 'worker_error' }))
  }

  async open(
    profileId: string,
    localNodeId: string,
    identity: BrowserSqliteStorageIdentity,
    migrationSql: readonly BrowserSqliteMigrationSql[],
    wasmAssetUrl: string
  ): Promise<LocalDataBackendStatus> {
    return await this.request<LocalDataBackendStatus>({ command: 'open', profileId, localNodeId, identity, migrationSql, wasmAssetUrl })
  }

  async status(): Promise<LocalDataBackendStatus> {
    return await this.request<LocalDataBackendStatus>({ command: 'status' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.request<{ closed: true }>({ command: 'close' }).catch(() => undefined)
    this.rejectAll(new LocalDataError('session_closed', 'Browser local data worker is closed'))
    this.worker.terminate()
    await this.ownership.release()
  }

  async beginTransaction(txId: string): Promise<void> {
    await this.request({ command: 'beginTransaction', txId })
  }

  async commitTransaction(txId: string): Promise<void> {
    await this.request({ command: 'commitTransaction', txId })
  }

  async rollbackTransaction(txId: string): Promise<void> {
    await this.request({ command: 'rollbackTransaction', txId })
  }

  async repositoryOperation<T>(operation: BrowserSqliteRepositoryOperation, txId?: string): Promise<T> {
    return await this.request<T>(txId === undefined ? { command: 'repo', operation } : { command: 'repo', operation, txId })
  }

  async exportV1(): Promise<LocalDataExportV1> {
    return parseLocalDataExportV1(await this.request({ command: 'exportV1' }))
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    return await this.request<LocalDataImportResult>({ command: 'importV1', document })
  }

  async cancel(requestId: string): Promise<void> {
    await this.request({ command: 'cancel', targetId: requestId })
  }

  private async request<T>(message: BrowserSqliteWorkerRequestWithoutId): Promise<T> {
    if (this.closed && message.command !== 'close') {
      throw new LocalDataError('session_closed', 'Browser local data worker is closed')
    }
    const id = `browser-sqlite-${++this.sequence}`
    const request = { ...message, id } as BrowserSqliteWorkerRequest
    const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
    if (bytes > MAX_OUTBOUND_BYTES) {
      throw new LocalDataError('invalid_record', 'Browser local data request is too large', { reason: 'message_too_large' })
    }
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        void this.cancel(id).catch(() => undefined)
        reject(new LocalDataError('unsupported_backend', 'Browser local data request timed out', { reason: 'timeout' }))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })
      try {
        this.worker.postMessage(request)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private handleMessage(response: BrowserSqliteWorkerResponse): void {
    const pending = this.pending.get(response.id)
    if (pending === undefined) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if (response.result.ok) {
      pending.resolve(response.result.value)
    } else {
      pending.reject(new LocalDataError(
        normalizeErrorCode(response.result.error.code),
        response.result.error.message,
        response.result.error.metadata
      ))
    }
  }

  private rejectAll(error: LocalDataError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
  timeout: ReturnType<typeof setTimeout>
}

class BrowserSqliteLocalDataSession implements LocalDataSession {
  readonly conversations: BrowserSqliteConversationRepository
  readonly memory: BrowserSqliteMemoryRepository
  readonly localTools: BrowserSqliteLocalToolStateRepository
  readonly peerGrants: BrowserSqlitePeerGrantRepository
  readonly localAudit: BrowserSqliteLocalAuditRepository
  private closed = false

  constructor(
    readonly profileId: string,
    readonly localNodeId: string,
    readonly schemaVersion: number,
    private readonly client: BrowserSqliteWorkerClient,
    private readonly txId?: string
  ) {
    this.conversations = new BrowserSqliteConversationRepository(client, txId)
    this.memory = new BrowserSqliteMemoryRepository(client, txId)
    this.localTools = new BrowserSqliteLocalToolStateRepository(client, txId)
    this.peerGrants = new BrowserSqlitePeerGrantRepository(client, txId)
    this.localAudit = new BrowserSqliteLocalAuditRepository(client, txId)
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    this.assertOpen()
    const txId = crypto.randomUUID()
    await this.client.beginTransaction(txId)
    const txSession = new BrowserSqliteLocalDataSession(this.profileId, this.localNodeId, this.schemaVersion, this.client, txId)
    try {
      const result = await work(txSession)
      await this.client.commitTransaction(txId)
      return result
    } catch (error) {
      await this.client.rollbackTransaction(txId).catch(() => undefined)
      throw error
    } finally {
      await txSession.markClosed()
    }
  }

  async exportV1(): Promise<LocalDataExportV1> {
    this.assertOpen()
    return await this.client.exportV1()
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    this.assertOpen()
    return await this.client.importV1(document)
  }

  async close(): Promise<void> {
    await this.markClosed()
    if (this.txId === undefined) await this.client.close()
  }

  async markClosed(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new LocalDataError('session_closed', 'Local data session is closed')
  }
}

class BrowserSqliteConversationRepository {
  constructor(private readonly client: BrowserSqliteWorkerClient, private readonly txId?: string) {}

  async upsertConversation(record: ConversationRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'conversations.upsertConversation', record: parseConversationRecord(record) }, this.txId)
  }

  async appendMessage(record: ConversationMessageRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'conversations.appendMessage', record: parseConversationMessageRecord(record) }, this.txId)
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return (await this.client.repositoryOperation<ConversationRecord[]>({ kind: 'conversations.listConversations' }, this.txId)).map(parseConversationRecord)
  }

  async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    return (await this.client.repositoryOperation<ConversationMessageRecord[]>({ kind: 'conversations.listMessages', conversationId }, this.txId)).map(parseConversationMessageRecord)
  }
}

class BrowserSqliteMemoryRepository {
  constructor(private readonly client: BrowserSqliteWorkerClient, private readonly txId?: string) {}

  async upsertMemoryItem(record: LightweightMemoryRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'memory.upsertMemoryItem', record: parseLightweightMemoryRecord(record) }, this.txId)
  }

  async listMemoryItems(namespace?: string): Promise<LightweightMemoryRecord[]> {
    return (await this.client.repositoryOperation<LightweightMemoryRecord[]>(
      namespace === undefined ? { kind: 'memory.listMemoryItems' } : { kind: 'memory.listMemoryItems', namespace },
      this.txId
    )).map(parseLightweightMemoryRecord)
  }
}

class BrowserSqliteLocalToolStateRepository {
  constructor(private readonly client: BrowserSqliteWorkerClient, private readonly txId?: string) {}

  async upsertLocalToolState(record: LocalToolStateRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'localTools.upsertLocalToolState', record: parseLocalToolStateRecord(record) }, this.txId)
  }

  async listLocalToolStates(): Promise<LocalToolStateRecord[]> {
    return (await this.client.repositoryOperation<LocalToolStateRecord[]>({ kind: 'localTools.listLocalToolStates' }, this.txId)).map(parseLocalToolStateRecord)
  }
}

class BrowserSqlitePeerGrantRepository {
  constructor(private readonly client: BrowserSqliteWorkerClient, private readonly txId?: string) {}

  async upsertPeerGrant(record: PeerGrantMetadataRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'peerGrants.upsertPeerGrant', record: parsePeerGrantMetadataRecord(record) }, this.txId)
  }

  async listPeerGrants(): Promise<PeerGrantMetadataRecord[]> {
    return (await this.client.repositoryOperation<PeerGrantMetadataRecord[]>({ kind: 'peerGrants.listPeerGrants' }, this.txId)).map(parsePeerGrantMetadataRecord)
  }
}

class BrowserSqliteLocalAuditRepository {
  constructor(private readonly client: BrowserSqliteWorkerClient, private readonly txId?: string) {}

  async appendAudit(record: LocalAuditRecord): Promise<void> {
    await this.client.repositoryOperation({ kind: 'localAudit.appendAudit', record: parseLocalAuditRecord(record) }, this.txId)
  }

  async listAudit(): Promise<LocalAuditRecord[]> {
    return (await this.client.repositoryOperation<LocalAuditRecord[]>({ kind: 'localAudit.listAudit' }, this.txId)).map(parseLocalAuditRecord)
  }
}

export const browserSqliteMigrationSql: readonly BrowserSqliteMigrationSql[] = Object.freeze([
  {
    version: 1,
    sql: `PRAGMA foreign_keys = ON;

CREATE TABLE aurora_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE aurora_database_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  local_node_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE aurora_storage_meta (
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, key)
);

CREATE TABLE aurora_conversations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  title_envelope_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER
);

CREATE TABLE aurora_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES aurora_conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content_envelope_json TEXT,
  tool_envelope_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed', 'cancelled')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE aurora_memory_items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  payload_envelope_json TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER
);

CREATE INDEX idx_aurora_conversations_profile_node_updated
  ON aurora_conversations (profile_id, local_node_id, updated_at_ms DESC);

CREATE INDEX idx_aurora_memory_profile_node_namespace_expiry
  ON aurora_memory_items (profile_id, local_node_id, namespace, expires_at_ms);
`
  },
  {
    version: 2,
    sql: `PRAGMA foreign_keys = ON;

CREATE TABLE aurora_local_tool_state (
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  tool_contract_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  settings_envelope_json TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, local_node_id, tool_contract_id)
);

CREATE INDEX idx_aurora_local_tools_profile_node_enabled
  ON aurora_local_tool_state (profile_id, local_node_id, enabled);
`
  },
  {
    version: 3,
    sql: `PRAGMA foreign_keys = ON;

CREATE TABLE aurora_peer_grant_metadata (
  grant_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  claimant_peer_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  scope_envelope_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER
);

CREATE TABLE aurora_local_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  peer_id TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  result_status TEXT NOT NULL,
  connection_epoch TEXT,
  method_id TEXT,
  tool_contract_id TEXT,
  correlation_id TEXT,
  redacted_detail_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_aurora_grants_profile_node_claimant_active
  ON aurora_peer_grant_metadata (profile_id, local_node_id, claimant_peer_id, token_id, revoked_at_ms, expires_at_ms);

CREATE INDEX idx_aurora_audit_profile_node_created
  ON aurora_local_audit (profile_id, local_node_id, created_at_ms DESC);
`
  }
])

export function createDefaultBrowserSqliteWorker(): BrowserSqliteProtocolWorker {
  return new Worker(new URL('./browser-sqlite-worker.ts', import.meta.url), { type: 'module' })
}

export function createBrowserSqliteBackendForIdentity(localNodeId: string, options: BrowserSqliteLocalDataBackendOptions = {}): {
  backend: BrowserSqliteLocalDataBackend
  identity: BrowserSqliteStorageIdentity
} {
  return {
    backend: new BrowserSqliteLocalDataBackend(options),
    identity: deriveBrowserSqliteStorageIdentity(localNodeId)
  }
}

export function buildExportFromRepositories(input: {
  sourceBackend: 'sqlite-wasm-opfs'
  schemaVersion: number
  profileId: string
  localNodeId: string
  exportedAtMs: number
  records: Parameters<typeof buildLocalDataExportV1>[0]['records']
}): LocalDataExportV1 {
  return buildLocalDataExportV1(input)
}

function normalizeErrorCode(code: string): ConstructorParameters<typeof LocalDataError>[0] {
  switch (code) {
    case 'invalid_record':
    case 'session_closed':
    case 'unsupported_backend':
    case 'migration_integrity':
    case 'migration_order':
    case 'identity_mismatch':
    case 'memory_session_only':
      return code
    default:
      return 'unsupported_backend'
  }
}

export function fallbackReasonFromError(error: unknown): BrowserSqliteProbeFailureReason | 'worker_open_failed' | 'migration_failed' {
  if (error instanceof LocalDataError) {
    const reason = error.metadata?.reason
    if (isProbeFailureReason(reason)) return reason
    if (error.code === 'migration_integrity' || error.code === 'migration_order') return 'migration_failed'
  }
  return 'worker_open_failed'
}

function isProbeFailureReason(value: unknown): value is BrowserSqliteProbeFailureReason {
  return value === 'worker_unavailable'
    || value === 'wasm_unavailable'
    || value === 'opfs_unavailable'
    || value === 'ownership_unavailable'
    || value === 'invalid_identity'
    || value === 'python_database_rejected'
    || value === 'storage_persistence_denied'
}

type BrowserSqliteWorkerRequestWithoutId =
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'open' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'status' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'close' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'cancel' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'beginTransaction' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'commitTransaction' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'rollbackTransaction' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'repo' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'exportV1' }>, 'id'>
  | Omit<Extract<BrowserSqliteWorkerRequest, { command: 'importV1' }>, 'id'>
