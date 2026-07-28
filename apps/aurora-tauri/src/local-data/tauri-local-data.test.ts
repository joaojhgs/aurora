import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildEnvelopeAad,
  localDataMigrationManifest,
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type LocalToolStateRecord,
  type PeerGrantMetadataRecord
} from '../../../../packages/aurora-sdk/src/local-data/index.js'

import { TauriEnvelopeCryptoPort } from './tauri-envelope-crypto.js'
import { TauriSqliteLocalDataBackend, type TauriSqliteLocalDataBackendOptions } from './tauri-sqlite-backend.js'

describe('Tauri local data adapter', () => {
  it('opens the preloaded SQLite database, validates migrations, and stores scoped records through bound parameters', async () => {
    const db = new FakeTauriSqlDatabase()
    const backend = new TauriSqliteLocalDataBackend({
      loadDatabase: async (url) => {
        expect(url).toBe('sqlite:aurora-lightweight.db')
        return db
      },
      nowMs: () => 1234
    } satisfies TauriSqliteLocalDataBackendOptions)
    const session = await backend.open('profile-1', 'node-1')

    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.localTools.upsertLocalToolState(localToolStateFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())
    await session.localAudit.appendAudit(auditFixture())

    await expect(session.conversations.listConversations()).resolves.toEqual([conversationFixture()])
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([messageFixture()])
    await expect(session.memory.listMemoryItems('notes')).resolves.toEqual([memoryFixture()])
    await expect(session.localTools.listLocalToolStates()).resolves.toEqual([localToolStateFixture()])
    await expect(session.peerGrants.listPeerGrants()).resolves.toEqual([peerGrantFixture()])
    await expect(session.localAudit.listAudit()).resolves.toEqual([auditFixture()])
    await expect(backend.open('profile-2', 'node-1')).rejects.toMatchObject({ code: 'identity_mismatch' })

    expect(db.executions.filter((entry) => entry.sql.includes('INSERT INTO aurora_')).every((entry) => Array.isArray(entry.bind) && entry.bind.length > 0)).toBe(true)
    expect(JSON.stringify(db.executions)).not.toContain('python')
    await backend.close()
    expect(db.closed).toBe(true)
  })

  it('rolls back failed transactions and rejects foreign profile records', async () => {
    const db = new FakeTauriSqlDatabase()
    const session = await new TauriSqliteLocalDataBackend({ loadDatabase: async () => db }).open('profile-1', 'node-1')
    await expect(session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'rollback-memory' }))
      throw new Error('rollback')
    })).rejects.toThrow(/rollback/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])
    await expect(session.memory.upsertMemoryItem(memoryFixture({ profileId: 'profile-2' }))).rejects.toMatchObject({ code: 'identity_mismatch' })
  })

  it('keeps SQL and native crypto private to the local-data adapter', () => {
    const repoRoot = resolve(process.cwd(), '../..')
    const sourceRoot = resolve(process.cwd(), 'src')
    const offenders: string[] = []
    for (const file of walk(sourceRoot)) {
      const rel = relative(process.cwd(), file)
      const source = readFileSync(file, 'utf8')
      if (source.includes('@tauri-apps/plugin-sql') && rel !== 'src/local-data/tauri-sqlite-backend.ts') offenders.push(rel)
      if (/executeSql|rawSql|python.*db/iu.test(source)) offenders.push(rel)
      for (const match of source.matchAll(/sqlite:[^'"`\s]+/giu)) {
        if (match[0] !== 'sqlite:aurora-lightweight.db') offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
    const config = readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    expect(config).toContain('"sqlite:aurora-lightweight.db"')
    expect(config).not.toContain('sqlite:aurora.db')
    const capability = readFileSync(resolve(process.cwd(), 'src-tauri/capabilities/aurora-main.json'), 'utf8')
    expect(capability).toContain('sql:allow-load')
    expect(capability).toContain('sql:allow-execute')
    expect(capability).toContain('aurora-local-data-envelope-crypto')
    const manifestSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs'), 'utf8')
    expect(manifestSource).toContain('add_migrations(LOCAL_DATA_DB_URL, local_data_sql_migrations())')
    expect(manifestSource).not.toMatch(/native.*capabilit.*local_data_envelope/iu)
  })

  it('invokes only narrow native envelope commands and validates shared envelope output', async () => {
    const aad = buildEnvelopeAad({
      table: 'aurora_memory_items',
      recordId: 'memory-1',
      field: 'payloadEnvelope',
      profileId: 'profile-1',
      localNodeId: 'node-1'
    })
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const port = new TauriEnvelopeCryptoPort({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      invokeCommand: async (command, args) => {
        calls.push({ command, args })
        if (command === 'aurora_local_data_envelope_decrypt') return { plaintextB64Url: 'c2VjcmV0' }
        if (command === 'aurora_local_data_envelope_rotate') return { previousKeyId: 'old', newKeyId: 'new' }
        return envelopeFixture
      }
    })

    await expect(port.encrypt('local-structured-data', new TextEncoder().encode('secret'), aad)).resolves.toEqual(envelopeFixture)
    await expect(port.decrypt(envelopeFixture, aad)).resolves.toEqual(new TextEncoder().encode('secret'))
    await expect(port.rotateKey('local-structured-data')).resolves.toEqual({ previousKeyId: 'old', newKeyId: 'new' })
    expect(calls.map((call) => call.command)).toEqual([
      'aurora_local_data_envelope_encrypt',
      'aurora_local_data_envelope_decrypt',
      'aurora_local_data_envelope_rotate'
    ])
    expect(JSON.stringify(calls)).not.toContain('rawKey')
  })

  it('wires Android Keystore and iOS Keychain envelope crypto without raw key output', () => {
    const repoRoot = resolve(process.cwd(), '../..')
    const kotlin = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'), 'utf8')
    const swiftPlugin = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift'), 'utf8')
    const swiftStorage = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift'), 'utf8')

    for (const command of ['localDataEnvelopeEncrypt', 'localDataEnvelopeDecrypt', 'localDataEnvelopeRotate']) {
      expect(kotlin).toContain(`fun ${command}`)
      expect(swiftPlugin).toContain(`func ${command}`)
    }
    expect(kotlin).toContain('AES/GCM/NoPadding')
    expect(kotlin).toContain('setKeySize(256)')
    expect(kotlin).toContain('cipher.updateAAD')
    expect(kotlin).toContain('LOCAL_DATA_ENVELOPE_KEY_PREFIX')
    expect(swiftStorage).toContain('AES.GCM.seal')
    expect(swiftStorage).toContain('AES.GCM.open')
    expect(swiftStorage).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly')
    expect(swiftStorage).toContain('aurora.local-data-envelope.')
    expect(`${kotlin}\n${swiftStorage}`).not.toMatch(/rawKey|keyBytes|plaintextKey/u)
  })
})

class FakeTauriSqlDatabase {
  executions: Array<{ sql: string; bind: readonly unknown[] }> = []
  closed = false
  private identity: string | null = null
  private conversations: ConversationRecord[] = []
  private messages: ConversationMessageRecord[] = []
  private memory: LightweightMemoryRecord[] = []
  private tools: LocalToolStateRecord[] = []
  private grants: PeerGrantMetadataRecord[] = []
  private audit: LocalAuditRecord[] = []
  private snapshot: Omit<FakeTauriSqlDatabase, 'executions' | 'closed' | 'execute' | 'select' | 'close'> | null = null

  async execute(sql: string, bind: readonly unknown[] = []): Promise<void> {
    this.executions.push({ sql, bind })
    if (sql === 'BEGIN IMMEDIATE;') {
      this.snapshot = structuredClone({ identity: this.identity, conversations: this.conversations, messages: this.messages, memory: this.memory, tools: this.tools, grants: this.grants, audit: this.audit, snapshot: null })
      return
    }
    if (sql === 'ROLLBACK;' && this.snapshot !== null) {
      Object.assign(this, this.snapshot)
      this.snapshot = null
      return
    }
    if (sql === 'COMMIT;') {
      this.snapshot = null
      return
    }
    if (sql.startsWith('INSERT INTO aurora_database_identity')) this.identity = bind[0] as string
    if (sql.startsWith('INSERT INTO aurora_conversations')) upsert(this.conversations, conversationFixture({ id: bind[0] as string, profileId: bind[1] as string, localNodeId: bind[2] as string }))
    if (sql.startsWith('INSERT INTO aurora_messages')) upsert(this.messages, messageFixture({ id: bind[0] as string, conversationId: bind[1] as string }))
    if (sql.startsWith('INSERT INTO aurora_memory_items')) upsert(this.memory, memoryFixture({ id: bind[0] as string, profileId: bind[1] as string, localNodeId: bind[2] as string, namespace: bind[3] as string }))
    if (sql.startsWith('INSERT INTO aurora_local_tool_state')) upsert(this.tools, localToolStateFixture({ profileId: bind[0] as string, localNodeId: bind[1] as string, toolContractId: bind[2] as string }))
    if (sql.startsWith('INSERT INTO aurora_peer_grant_metadata')) upsert(this.grants, peerGrantFixture({ grantId: bind[0] as string, profileId: bind[1] as string, localNodeId: bind[2] as string }))
    if (sql.startsWith('INSERT INTO aurora_local_audit')) this.audit.unshift(auditFixture({ id: bind[0] as string, profileId: bind[1] as string, localNodeId: bind[2] as string }))
    if (sql.startsWith('DELETE FROM aurora_')) {
      this.conversations = []
      this.messages = []
      this.memory = []
      this.tools = []
      this.grants = []
      this.audit = []
    }
  }

  async select<T>(sql: string, bind: readonly unknown[] = []): Promise<T[]> {
    this.executions.push({ sql, bind })
    if (sql === 'PRAGMA user_version;') return [{ user_version: localDataMigrationManifest.latestVersion }] as T[]
    if (sql.startsWith('SELECT version, checksum FROM aurora_schema_migrations')) {
      return localDataMigrationManifest.migrations.map(({ version, checksum }) => ({ version, checksum })) as T[]
    }
    if (sql.startsWith('SELECT singleton_id')) return this.identity === null ? [] : [{ singleton_id: 1, local_node_id: this.identity }] as T[]
    if (sql === 'PRAGMA foreign_key_check;') return []
    if (sql.startsWith('SELECT id FROM aurora_conversations')) return this.conversations.some((record) => record.id === bind[0] && record.profileId === bind[1] && record.localNodeId === bind[2]) ? [{ id: bind[0] }] as T[] : []
    if (sql.includes('FROM aurora_conversations')) return this.conversations.filter((record) => record.profileId === bind[0] && record.localNodeId === bind[1]).map(conversationRow) as T[]
    if (sql.includes('FROM aurora_messages')) return this.messages.map(messageRow) as T[]
    if (sql.includes('FROM aurora_memory_items')) return this.memory.filter((record) => record.profileId === bind[0] && record.localNodeId === bind[1] && (bind[2] === undefined || record.namespace === bind[2])).map(memoryRow) as T[]
    if (sql.includes('FROM aurora_local_tool_state')) return this.tools.map(toolRow) as T[]
    if (sql.includes('FROM aurora_peer_grant_metadata')) return this.grants.map(grantRow) as T[]
    if (sql.includes('FROM aurora_local_audit')) return this.audit.map(auditRow) as T[]
    return []
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

const envelopeFixture = {
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'aurora.local-data-envelope.v1.profile.node.local-structured-data.k1',
  nonceB64Url: 'MTIzNDU2Nzg5MDEy',
  ciphertextAndTagB64Url: 'Y2lwaGVydGV4dC1hbmQtdGFn',
  createdAtMs: 1000
} as const

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return { id: 'conversation-1', profileId: 'profile-1', localNodeId: 'node-1', titleEnvelope: null, createdAtMs: 1, updatedAtMs: 2, archivedAtMs: null, ...overrides }
}
function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  return { id: 'message-1', conversationId: 'conversation-1', sequence: 0, role: 'user', contentEnvelope: null, toolEnvelope: null, status: 'complete', createdAtMs: 3, ...overrides }
}
function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
  return { id: 'memory-1', profileId: 'profile-1', localNodeId: 'node-1', namespace: 'notes', payloadEnvelope: envelopeFixture, sourceType: null, sourceId: null, createdAtMs: 4, updatedAtMs: 5, expiresAtMs: null, ...overrides }
}
function localToolStateFixture(overrides: Partial<LocalToolStateRecord> = {}): LocalToolStateRecord {
  return { profileId: 'profile-1', localNodeId: 'node-1', toolContractId: 'Tooling.Search', descriptorJson: { id: 'Tooling.Search' }, descriptorHash: 'a'.repeat(64), enabled: true, settingsEnvelope: null, revision: 1, updatedAtMs: 6, ...overrides }
}
function peerGrantFixture(overrides: Partial<PeerGrantMetadataRecord> = {}): PeerGrantMetadataRecord {
  return { grantId: 'grant-1', profileId: 'profile-1', localNodeId: 'node-1', claimantPeerId: 'peer-1', tokenId: 'token-1', scopeEnvelope: envelopeFixture, revision: 1, createdAtMs: 7, expiresAtMs: null, revokedAtMs: null, ...overrides }
}
function auditFixture(overrides: Partial<LocalAuditRecord> = {}): LocalAuditRecord {
  return { id: 'audit-1', profileId: 'profile-1', localNodeId: 'node-1', peerId: null, action: 'read', decision: 'allow', resultStatus: 'success', connectionEpoch: null, methodId: null, toolContractId: null, correlationId: null, redactedDetailJson: {}, createdAtMs: 8, ...overrides }
}

function conversationRow(record: ConversationRecord) { return { id: record.id, profile_id: record.profileId, local_node_id: record.localNodeId, title_envelope_json: null, created_at_ms: record.createdAtMs, updated_at_ms: record.updatedAtMs, archived_at_ms: record.archivedAtMs } }
function messageRow(record: ConversationMessageRecord) { return { id: record.id, conversation_id: record.conversationId, sequence: record.sequence, role: record.role, content_envelope_json: null, tool_envelope_json: null, status: record.status, created_at_ms: record.createdAtMs } }
function memoryRow(record: LightweightMemoryRecord) { return { id: record.id, profile_id: record.profileId, local_node_id: record.localNodeId, namespace: record.namespace, payload_envelope_json: JSON.stringify(record.payloadEnvelope), source_type: record.sourceType, source_id: record.sourceId, created_at_ms: record.createdAtMs, updated_at_ms: record.updatedAtMs, expires_at_ms: record.expiresAtMs } }
function toolRow(record: LocalToolStateRecord) { return { profile_id: record.profileId, local_node_id: record.localNodeId, tool_contract_id: record.toolContractId, descriptor_json: JSON.stringify(record.descriptorJson), descriptor_hash: record.descriptorHash, enabled: record.enabled ? 1 : 0, settings_envelope_json: null, revision: record.revision, updated_at_ms: record.updatedAtMs } }
function grantRow(record: PeerGrantMetadataRecord) { return { grant_id: record.grantId, profile_id: record.profileId, local_node_id: record.localNodeId, claimant_peer_id: record.claimantPeerId, token_id: record.tokenId, scope_envelope_json: JSON.stringify(record.scopeEnvelope), revision: record.revision, created_at_ms: record.createdAtMs, expires_at_ms: record.expiresAtMs, revoked_at_ms: record.revokedAtMs } }
function auditRow(record: LocalAuditRecord) { return { id: record.id, profile_id: record.profileId, local_node_id: record.localNodeId, peer_id: record.peerId, action: record.action, decision: record.decision, result_status: record.resultStatus, connection_epoch: record.connectionEpoch, method_id: record.methodId, tool_contract_id: record.toolContractId, correlation_id: record.correlationId, redacted_detail_json: JSON.stringify(record.redactedDetailJson), created_at_ms: record.createdAtMs } }

function upsert<T extends { id?: string; grantId?: string; toolContractId?: string }>(records: T[], next: T): void {
  const id = next.id ?? next.grantId ?? next.toolContractId
  const index = records.findIndex((record) => (record.id ?? record.grantId ?? record.toolContractId) === id)
  if (index === -1) records.push(next)
  else records[index] = next
}

function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walk(path))
    else if (/\.(?:ts|tsx)$/u.test(entry) && !/\.test\.(?:ts|tsx)$/u.test(entry)) files.push(path)
  }
  return files
}
