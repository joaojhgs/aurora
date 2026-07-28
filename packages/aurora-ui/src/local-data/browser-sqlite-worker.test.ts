import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLocalDataExportV1, type EncryptedDataEnvelopeV1 } from '@aurora/client/local-data'

import {
  assertExistingSqliteProfileOwnership,
  handleBrowserSqliteWorkerMessage,
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

  it('rejects cross-profile existing rows before import deletes or overwrites colliding IDs', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    const db = new FakeSqliteDatabase({
      'SELECT id FROM aurora_conversations WHERE local_node_id = ? AND profile_id <> ? LIMIT 1;': [{ id: 'conversation-1' }]
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
          message: 'Local data database profile does not match the open session',
          metadata: { reason: 'profile_owner_mismatch' }
        }
      }
    }])
    expect(db.statements.some((statement) => /\bDELETE\b/iu.test(statement))).toBe(false)
    expect(db.statements.some((statement) => /\bINSERT\b/iu.test(statement))).toBe(false)
  })

  it('preflights existing profile ownership without changing schema, ledger, identity, user_version, or records', () => {
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
        aurora_conversations: [{
          id: 'conversation-1',
          profile_id: 'profile-2',
          local_node_id: 'node-1',
          title_envelope_json: '{}'
        }]
      }
    })
    const before = db.snapshot()

    expect(() => assertExistingSqliteProfileOwnership(db, 'profile-1', 'node-1')).toThrowError(
      expect.objectContaining({
        code: 'identity_mismatch',
        metadata: { reason: 'profile_owner_mismatch' }
      })
    )
    expect(db.snapshot()).toEqual(before)
    expect(db.statements.some((statement) => /\b(?:BEGIN|COMMIT|ROLLBACK|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)\b|PRAGMA\s+user_version\s*=/iu.test(statement))).toBe(false)
  })

  it('allows empty or partially old schemas through read-only profile ownership preflight', () => {
    const empty = new SnapshotSqliteDatabase({
      userVersion: 0,
      schema: {},
      ledger: [],
      identity: null,
      records: {}
    })
    expect(() => assertExistingSqliteProfileOwnership(empty, 'profile-1', 'node-1')).not.toThrow()
    expect(empty.snapshot()).toEqual({
      userVersion: 0,
      schema: {},
      ledger: [],
      identity: null,
      records: {}
    })

    const partial = new SnapshotSqliteDatabase({
      userVersion: 1,
      schema: {
        aurora_conversations: ['id', 'local_node_id']
      },
      ledger: [],
      identity: null,
      records: {
        aurora_conversations: [{ id: 'conversation-legacy', local_node_id: 'node-1' }]
      }
    })
    const beforePartial = partial.snapshot()
    expect(() => assertExistingSqliteProfileOwnership(partial, 'profile-1', 'node-1')).not.toThrow()
    expect(partial.snapshot()).toEqual(beforePartial)
    expect(partial.statements.some((statement) => /\b(?:CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)\b|PRAGMA\s+user_version\s*=/iu.test(statement))).toBe(false)
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
    const ownershipMatch = /^SELECT "([^"]+)" FROM "([^"]+)" WHERE local_node_id = \? AND profile_id <> \? LIMIT 1;$/u.exec(sql)
    if (ownershipMatch !== null) {
      const idColumn = ownershipMatch[1] ?? ''
      const tableName = ownershipMatch[2] ?? ''
      const bind = Array.isArray(input.bind) ? input.bind : []
      const localNodeId = bind[0]
      const profileId = bind[1]
      return (this.state.records[tableName] ?? [])
        .filter((record) => record.local_node_id === localNodeId && record.profile_id !== profileId)
        .slice(0, 1)
        .map((record) => ({ [idColumn]: record[idColumn] }))
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

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

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
