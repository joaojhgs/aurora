import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLocalDataExportV1,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type LightweightMemoryRecord,
  type LocalAuditRecord,
  type PeerGrantMetadataRecord
} from '@aurora/client/local-data'

import {
  assertExistingSqliteLocalNodeOwnership,
  handleBrowserSqliteWorkerMessage,
  type BrowserSqliteRepositoryOperation,
  type BrowserSqliteWorkerResponse
} from './browser-sqlite-worker.js'

describe('browser sqlite worker protocol guardrails', () => {
  it('redacts unknown commands and oversized messages without exposing SQL', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    await handleBrowserSqliteWorkerMessage(
      { id: 'unknown-1', command: 'rawSql', sql: 'SELECT bearer FROM secrets' },
      (response) => responses.push(response)
    )

    expect(responses[0]).toMatchObject({
      id: 'unknown-1',
      result: {
        ok: false,
        error: {
          code: 'invalid_record',
          metadata: { reason: 'rawSql' }
        }
      }
    })
    expect(JSON.stringify(responses)).not.toContain('SELECT bearer')

    const oversized: BrowserSqliteWorkerResponse[] = []
    await expect(handleBrowserSqliteWorkerMessage(
      { id: 'large-1', command: 'status', payload: 'A'.repeat(3 * 1024 * 1024) },
      (response) => oversized.push(response)
    )).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'message_too_large' }
    })
  })

  it('acknowledges cancellation requests by correlation id', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    await handleBrowserSqliteWorkerMessage(
      { id: 'cancel-1', command: 'cancel', targetId: 'open-1' },
      (response) => responses.push(response)
    )
    expect(responses).toEqual([{
      id: 'cancel-1',
      result: { ok: true, value: { cancelled: true } }
    }])
  })

  it('rejects cross-node existing rows before import deletes or overwrites colliding IDs', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    const db = new FakeSqliteDatabase({
      'SELECT id FROM aurora_conversations WHERE local_node_id IS NULL OR local_node_id <> ? LIMIT 1;': [{ id: 'conversation-1' }]
    })
    await handleBrowserSqliteWorkerMessage(
      {
        id: 'import-cross-profile-1',
        command: 'importV1',
        document: buildLocalDataExportV1({
          sourceBackend: 'indexeddb',
          schemaVersion: 3,
          profileId: 'profile-1',
          localNodeId: 'node-1',
          exportedAtMs: 1000,
          records: {
            conversations: [{
              id: 'conversation-1',
              profileId: 'profile-1',
              localNodeId: 'node-1',
              titleEnvelope: envelopeFixture,
              createdAtMs: 1000,
              updatedAtMs: 1000,
              archivedAtMs: null
            }],
            messages: [],
            memoryItems: [],
            localToolStates: [],
            peerGrantMetadata: [],
            localAudit: []
          }
        })
      },
      (response) => responses.push(response),
      {
        db,
        profileId: 'profile-1',
        localNodeId: 'node-1',
        schemaVersion: 3,
        migrationState: 'idle',
        closed: false,
        activeTransactionId: null,
        operationQueue: Promise.resolve(),
        cancelled: new Set()
      } as never
    )

    expect(responses).toEqual([{
      id: 'import-cross-profile-1',
      result: {
        ok: false,
        error: {
          code: 'identity_mismatch',
          message: 'Local data database local node does not match the open session',
          metadata: { reason: 'local_node_owner_mismatch' }
        }
      }
    }])
    expect(db.statements.some((statement) => /\bDELETE\b/iu.test(statement))).toBe(false)
    expect(db.statements.some((statement) => /\bINSERT\b/iu.test(statement))).toBe(false)
  })

  it('rejects same-node different-profile global ID collisions before sqlite writes', async () => {
    for (const testCase of sqliteCollisionCases()) {
      const db = new SnapshotSqliteDatabase(testCase.state)
      const before = db.snapshot()
      const responses: BrowserSqliteWorkerResponse[] = []
      await handleBrowserSqliteWorkerMessage(
        {
          id: testCase.name,
          command: 'repo',
          operation: testCase.operation
        },
        (response) => responses.push(response),
        openWorkerState(db, 'profile-2', 'node-1') as never
      )

      expect(responses).toEqual([{
        id: testCase.name,
        result: {
          ok: false,
          error: {
            code: 'identity_mismatch',
            message: 'Local data record ID is already owned by another profile on this device',
            metadata: { reason: 'profile_scope_collision' }
          }
        }
      }])
      expect(db.snapshot()).toEqual(before)
      expect(db.statements.some(isWriteStatement)).toBe(false)
    }
  })

  it('rejects same-node different-profile import collisions before sqlite delete or insert', async () => {
    const db = new SnapshotSqliteDatabase({
      userVersion: 3,
      schema: {
        aurora_conversations: ['id', 'profile_id', 'local_node_id'],
        aurora_memory_items: ['id', 'profile_id', 'local_node_id']
      },
      ledger: [],
      identity: { singleton_id: 1, local_node_id: 'node-1', created_at_ms: 1000 },
      records: {
        aurora_conversations: [{ id: 'conversation-1', profile_id: 'profile-1', local_node_id: 'node-1' }],
        aurora_memory_items: [{ id: 'memory-1', profile_id: 'profile-1', local_node_id: 'node-1' }]
      }
    })
    const before = db.snapshot()
    const responses: BrowserSqliteWorkerResponse[] = []
    await handleBrowserSqliteWorkerMessage(
      {
        id: 'import-profile-collision',
        command: 'importV1',
        document: buildLocalDataExportV1({
          sourceBackend: 'indexeddb',
          schemaVersion: 3,
          profileId: 'profile-2',
          localNodeId: 'node-1',
          exportedAtMs: 1000,
          records: {
            conversations: [],
            messages: [],
            memoryItems: [memoryFixture({ profileId: 'profile-2' })],
            localToolStates: [],
            peerGrantMetadata: [],
            localAudit: []
          }
        })
      },
      (response) => responses.push(response),
      openWorkerState(db, 'profile-2', 'node-1') as never
    )

    expect(responses).toEqual([{
      id: 'import-profile-collision',
      result: {
        ok: false,
        error: {
          code: 'identity_mismatch',
          message: 'Local data record ID is already owned by another profile on this device',
          metadata: { reason: 'profile_scope_collision' }
        }
      }
    }])
    expect(db.snapshot()).toEqual(before)
    expect(db.statements.some(isWriteStatement)).toBe(false)
  })

  it('preflights existing local-node ownership without changing schema, ledger, identity, user_version, or records', () => {
    for (const testCase of [
      {
        name: 'different-profile-same-node',
        record: { id: 'conversation-1', profile_id: 'profile-2', local_node_id: 'node-1', title_envelope_json: '{}' },
        reason: null
      },
      {
        name: 'same-profile-different-node',
        record: { id: 'conversation-1', profile_id: 'profile-1', local_node_id: 'node-2', title_envelope_json: '{}' },
        reason: 'local_node_owner_mismatch'
      },
      {
        name: 'different-profile-different-node',
        record: { id: 'conversation-1', profile_id: 'profile-2', local_node_id: 'node-2', title_envelope_json: '{}' },
        reason: 'local_node_owner_mismatch'
      }
    ]) {
      const db = new SnapshotSqliteDatabase({
        userVersion: 1,
        schema: {
          aurora_schema_migrations: ['version', 'name', 'checksum', 'applied_at_ms'],
          aurora_database_identity: ['singleton_id', 'local_node_id', 'created_at_ms'],
          aurora_conversations: ['id', 'profile_id', 'local_node_id', 'title_envelope_json']
        },
        ledger: [{ version: 1, checksum: 'a'.repeat(64) }],
        identity: { singleton_id: 1, local_node_id: 'node-1', created_at_ms: 1000 },
        records: {
          aurora_conversations: [testCase.record]
        }
      })
      if (testCase.reason === null) {
        const before = db.snapshot()
        expect(() => assertExistingSqliteLocalNodeOwnership(db, 'node-1')).not.toThrow()
        expect(db.snapshot()).toEqual(before)
        expect(db.statements.some(isWriteStatement)).toBe(false)
      } else {
        assertPreflightRejectsWithoutMutation(db, testCase.reason)
      }
    }
  })

  it('fails closed without mutation when nonempty legacy tables cannot establish exact ownership', () => {
    for (const testCase of [
      {
        name: 'missing-profile',
        schema: { aurora_conversations: ['id', 'local_node_id'] },
        record: { id: 'conversation-legacy', local_node_id: 'node-1' }
      },
      {
        name: 'missing-node',
        schema: { aurora_memory_items: ['id', 'profile_id'] },
        record: { id: 'memory-legacy', profile_id: 'profile-1' }
      },
      {
        name: 'missing-both',
        schema: { aurora_local_audit: ['id'] },
        record: { id: 'audit-legacy' }
      }
    ]) {
      const tableName = Object.keys(testCase.schema)[0] ?? 'aurora_conversations'
      const db = new SnapshotSqliteDatabase({
        userVersion: 1,
        schema: testCase.schema,
        ledger: [],
        identity: null,
        records: {
          [tableName]: [testCase.record]
        }
      })
      assertPreflightRejectsWithoutMutation(db, 'local_node_owner_ambiguous')
    }
  })

  it('allows empty or ownership-establishable legacy schemas through read-only local-node ownership preflight', () => {
    const empty = new SnapshotSqliteDatabase({
      userVersion: 0,
      schema: {},
      ledger: [],
      identity: null,
      records: {}
    })
    expect(() => assertExistingSqliteLocalNodeOwnership(empty, 'node-1')).not.toThrow()
    const emptySnapshot: SnapshotSqliteState = {
      userVersion: 0,
      schema: {},
      ledger: [],
      identity: null,
      records: {}
    }
    expect(empty.snapshot()).toEqual(emptySnapshot)

    const legacy = new SnapshotSqliteDatabase({
      userVersion: 1,
      schema: {
        aurora_conversations: ['profile_id', 'local_node_id']
      },
      ledger: [],
      identity: null,
      records: {
        aurora_conversations: [{ profile_id: 'profile-1', local_node_id: 'node-1' }]
      }
    })
    const beforeLegacy = legacy.snapshot()
    expect(() => assertExistingSqliteLocalNodeOwnership(legacy, 'node-1')).not.toThrow()
    expect(legacy.snapshot()).toEqual(beforeLegacy)
    expect(legacy.statements.some(isWriteStatement)).toBe(false)
  })

  it('keeps sqlite wasm imports private to approved local-data adapters', () => {
    const root = process.cwd()
    const offenders: string[] = []
    for (const file of walk(join(root, 'src'))) {
      const rel = relative(root, file)
      const source = readFileSync(file, 'utf8')
      const importsSqlite = source.includes('@sqlite.org/sqlite-wasm') || source.includes('installOpfsSAHPoolVfs')
      if (!importsSqlite) continue
      if (
        rel !== 'src/local-data/browser-sqlite-worker.ts'
        && rel !== 'src/local-data/browser-sqlite-worker-client.ts'
      ) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})

class FakeSqliteDatabase {
  readonly statements: string[] = []

  constructor(private readonly rowsBySql: Record<string, Array<Record<string, unknown>>>) {}

  exec(input: string | { readonly sql: string; readonly returnValue?: string }): unknown {
    const sql = typeof input === 'string' ? input : input.sql
    this.statements.push(sql)
    if (typeof input !== 'string' && input.returnValue === 'resultRows') return this.rowsBySql[sql] ?? []
    return undefined
  }
}

interface SnapshotSqliteState {
  userVersion: number
  schema: Record<string, string[]>
  ledger: Array<Record<string, unknown>>
  identity: Record<string, unknown> | null
  records: Record<string, Array<Record<string, unknown>>>
}

class SnapshotSqliteDatabase {
  readonly statements: string[] = []
  private readonly state: SnapshotSqliteState

  constructor(state: SnapshotSqliteState) {
    this.state = structuredClone(state)
  }

  close(): void {}

  exec(input: string | {
    readonly sql: string
    readonly bind?: readonly unknown[] | Record<string, unknown>
    readonly returnValue?: 'resultRows'
    readonly rowMode?: 'object'
  }): unknown {
    const sql = typeof input === 'string' ? input : input.sql
    this.statements.push(sql)
    if (typeof input === 'string' || input.returnValue !== 'resultRows') return undefined
    if (sql === 'PRAGMA user_version;') return [{ user_version: this.state.userVersion }]
    if (sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;") {
      const bind = Array.isArray(input.bind) ? input.bind : []
      const tableName = String(bind[0] ?? '')
      return this.state.schema[tableName] === undefined ? [] : [{ name: tableName }]
    }
    const tableInfoMatch = /^PRAGMA table_info\("([^"]+)"\);$/u.exec(sql)
    if (tableInfoMatch !== null) {
      const tableName = tableInfoMatch[1] ?? ''
      return (this.state.schema[tableName] ?? []).map((name: string) => ({ name }))
    }
    const tableRowsMatch = /^SELECT 1 FROM "([^"]+)" LIMIT 1;$/u.exec(sql)
    if (tableRowsMatch !== null) {
      return (this.state.records[tableRowsMatch[1] ?? ''] ?? []).length > 0 ? [{ 1: 1 }] : []
    }
    const ownershipMatch = /^SELECT 1 FROM "([^"]+)" WHERE "([^"]+)" IS NULL OR "[^"]+" <> \? LIMIT 1;$/u.exec(sql)
    if (ownershipMatch !== null) {
      const tableName = ownershipMatch[1] ?? ''
      const columnName = ownershipMatch[2] ?? ''
      const bind = Array.isArray(input.bind) ? input.bind : []
      const expectedValue = bind[0]
      return (this.state.records[tableName] ?? [])
        .filter((record) => record[columnName] === null || record[columnName] === undefined || record[columnName] !== expectedValue)
        .slice(0, 1)
        .map(() => ({ 1: 1 }))
    }
    const scopedKeyMatch = /^SELECT profile_id, local_node_id FROM "([^"]+)" WHERE "([^"]+)" = \? LIMIT 1;$/u.exec(sql)
    if (scopedKeyMatch !== null) {
      const tableName = scopedKeyMatch[1] ?? ''
      const idColumn = scopedKeyMatch[2] ?? ''
      const bind = Array.isArray(input.bind) ? input.bind : []
      return (this.state.records[tableName] ?? [])
        .filter((record) => record[idColumn] === bind[0])
        .slice(0, 1)
        .map((record) => ({
          profile_id: record.profile_id,
          local_node_id: record.local_node_id
        }))
    }
    if (sql === 'SELECT messages.conversation_id, conversations.profile_id, conversations.local_node_id FROM aurora_messages messages LEFT JOIN aurora_conversations conversations ON conversations.id = messages.conversation_id WHERE messages.id = ? LIMIT 1;') {
      const bind = Array.isArray(input.bind) ? input.bind : []
      const message = (this.state.records.aurora_messages ?? []).find((record) => record.id === bind[0])
      if (message === undefined) return []
      const conversation = (this.state.records.aurora_conversations ?? []).find((record) => record.id === message.conversation_id)
      return [{
        conversation_id: message.conversation_id,
        profile_id: conversation?.profile_id ?? null,
        local_node_id: conversation?.local_node_id ?? null
      }]
    }
    if (sql === 'SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?;') {
      const bind = Array.isArray(input.bind) ? input.bind : []
      return (this.state.records.aurora_conversations ?? [])
        .filter((record) => record.id === bind[0] && record.profile_id === bind[1] && record.local_node_id === bind[2])
        .map((record) => ({ id: record.id }))
    }
    if (sql === 'SELECT singleton_id, local_node_id FROM aurora_database_identity ORDER BY singleton_id ASC;') {
      return this.state.identity === null ? [] : [structuredClone(this.state.identity)]
    }
    if (sql === 'SELECT version, checksum FROM aurora_schema_migrations ORDER BY version ASC;') {
      return structuredClone(this.state.ledger)
    }
    return []
  }

  snapshot(): SnapshotSqliteState {
    return structuredClone(this.state)
  }
}

function assertPreflightRejectsWithoutMutation(db: SnapshotSqliteDatabase, reason: string): void {
  const before = db.snapshot()
  expect(() => assertExistingSqliteLocalNodeOwnership(db, 'node-1')).toThrowError(
    expect.objectContaining({
      code: 'identity_mismatch',
      metadata: { reason }
    })
  )
  expect(db.snapshot()).toEqual(before)
  expect(db.statements.some(isWriteStatement)).toBe(false)
}

function isWriteStatement(statement: string): boolean {
  return /\b(?:BEGIN|COMMIT|ROLLBACK|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)\b|PRAGMA\s+user_version\s*=/iu.test(statement)
}

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

function openWorkerState(db: SnapshotSqliteDatabase, profileId: string, localNodeId: string) {
  return {
    db,
    profileId,
    localNodeId,
    schemaVersion: 3,
    migrationState: 'idle',
    closed: false,
    activeTransactionId: null,
    operationQueue: Promise.resolve(),
    cancelled: new Set<string>()
  }
}

function sqliteCollisionCases(): Array<{
  name: string
  state: SnapshotSqliteState
  operation: BrowserSqliteRepositoryOperation
}> {
  return [
    {
      name: 'conversation-id-collision',
      state: stateWithRows({
        aurora_conversations: [{ id: 'conversation-1', profile_id: 'profile-1', local_node_id: 'node-1' }]
      }),
      operation: { kind: 'conversations.upsertConversation', record: conversationFixture({ profileId: 'profile-2' }) }
    },
    {
      name: 'message-id-collision',
      state: stateWithRows({
        aurora_conversations: [
          { id: 'conversation-1', profile_id: 'profile-1', local_node_id: 'node-1' },
          { id: 'conversation-2', profile_id: 'profile-2', local_node_id: 'node-1' }
        ],
        aurora_messages: [{ id: 'message-1', conversation_id: 'conversation-1', sequence: 0 }]
      }),
      operation: {
        kind: 'conversations.appendMessage',
        record: messageFixture({ conversationId: 'conversation-2' })
      }
    },
    {
      name: 'memory-id-collision',
      state: stateWithRows({
        aurora_memory_items: [{ id: 'memory-1', profile_id: 'profile-1', local_node_id: 'node-1' }]
      }),
      operation: { kind: 'memory.upsertMemoryItem', record: memoryFixture({ profileId: 'profile-2' }) }
    },
    {
      name: 'grant-id-collision',
      state: stateWithRows({
        aurora_peer_grant_metadata: [{ grant_id: 'grant-1', profile_id: 'profile-1', local_node_id: 'node-1' }]
      }),
      operation: { kind: 'peerGrants.upsertPeerGrant', record: peerGrantFixture({ profileId: 'profile-2' }) }
    },
    {
      name: 'audit-id-collision',
      state: stateWithRows({
        aurora_local_audit: [{ id: 'audit-1', profile_id: 'profile-1', local_node_id: 'node-1' }]
      }),
      operation: { kind: 'localAudit.appendAudit', record: auditFixture({ profileId: 'profile-2' }) }
    }
  ]
}

function stateWithRows(records: SnapshotSqliteState['records']): SnapshotSqliteState {
  return {
    userVersion: 3,
    schema: {
      aurora_conversations: ['id', 'profile_id', 'local_node_id'],
      aurora_messages: ['id', 'conversation_id', 'sequence'],
      aurora_memory_items: ['id', 'profile_id', 'local_node_id'],
      aurora_local_tool_state: ['profile_id', 'local_node_id', 'tool_contract_id'],
      aurora_peer_grant_metadata: ['grant_id', 'profile_id', 'local_node_id'],
      aurora_local_audit: ['id', 'profile_id', 'local_node_id']
    },
    ledger: [],
    identity: { singleton_id: 1, local_node_id: 'node-1', created_at_ms: 1000 },
    records
  }
}

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    titleEnvelope: envelopeFixture,
    createdAtMs: 1000,
    updatedAtMs: 1100,
    archivedAtMs: null,
    ...overrides
  }
}

function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    sequence: 0,
    role: 'user',
    contentEnvelope: envelopeFixture,
    toolEnvelope: null,
    status: 'complete',
    createdAtMs: 1200,
    ...overrides
  }
}

function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
  return {
    id: 'memory-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    namespace: 'notes',
    payloadEnvelope: envelopeFixture,
    sourceType: 'conversation',
    sourceId: 'conversation-1',
    createdAtMs: 1300,
    updatedAtMs: 1400,
    expiresAtMs: null,
    ...overrides
  }
}

function peerGrantFixture(overrides: Partial<PeerGrantMetadataRecord> = {}): PeerGrantMetadataRecord {
  return {
    grantId: 'grant-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    claimantPeerId: 'peer-1',
    tokenId: 'token-1',
    scopeEnvelope: envelopeFixture,
    revision: 0,
    createdAtMs: 1600,
    expiresAtMs: null,
    revokedAtMs: null,
    ...overrides
  }
}

function auditFixture(overrides: Partial<LocalAuditRecord> = {}): LocalAuditRecord {
  return {
    id: 'audit-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    peerId: 'peer-1',
    action: 'grant.check',
    decision: 'allow',
    resultStatus: 'complete',
    connectionEpoch: 'epoch-1',
    methodId: null,
    toolContractId: 'aurora.local.native.share_text.v1',
    correlationId: 'corr-1',
    redactedDetailJson: { secretsRedacted: true },
    createdAtMs: 1700,
    ...overrides
  }
}

function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...walk(path))
    } else if (/\.(?:ts|tsx)$/u.test(entry) && !/\.test\.(?:ts|tsx)$/u.test(entry)) {
      files.push(path)
    }
  }
  return files
}
