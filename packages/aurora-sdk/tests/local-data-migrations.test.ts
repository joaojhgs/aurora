import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertStoredMigrationChecksums,
  buildLocalDataJsonSchemaArtifact,
  canonicalLocalDataMigrationLedgerSql,
  localDataMigrationManifest,
  validateLocalDataMigrationManifest
} from '../src/local-data/index.js'

describe('local-data SQLite migration manifest', () => {
  it('is contiguous, forward-only, checksummed, and tied to the lightweight database', () => {
    expect(localDataMigrationManifest.databaseName).toBe('aurora-lightweight.db')
    expect(localDataMigrationManifest.latestVersion).toBe(3)
    expect(localDataMigrationManifest.migrations.map((migration) => migration.version)).toEqual([1, 2, 3])
    expect(localDataMigrationManifest.migrations.every((migration) => migration.ledger_sql.includes('aurora_schema_migrations'))).toBe(true)
    expect(localDataMigrationManifest.migrations.every((migration) => migration.ledger_sql.includes("CAST(strftime('%s','now') AS INTEGER) * 1000"))).toBe(true)
    expect(localDataMigrationManifest.migrations.every((migration) => migration.ledger_sql.includes(`PRAGMA user_version = ${migration.version}`))).toBe(true)
    expect(localDataMigrationManifest.migrations.every((migration) => !migration.ledger_sql.includes(':applied_at_ms'))).toBe(true)

    for (const migration of localDataMigrationManifest.migrations) {
      const sql = readFileSync(resolve(process.cwd(), `src/local-data/migrations/sqlite/${migration.file}`), 'utf8')
      expect(createHash('sha256').update(sql).digest('hex')).toBe(migration.checksum)
      expect(migration.ledger_sql).toBe(canonicalLocalDataMigrationLedgerSql(migration.version, migration.name, migration.checksum))
      expect(sql.toLowerCase()).not.toContain('python')
      expect(sql.toLowerCase()).not.toContain('app/services/db')
    }
  })

  it('fails closed for tampered manifests and stored prior checksums', () => {
    expect(() => validateLocalDataMigrationManifest({
      ...localDataMigrationManifest,
      latestVersion: 4
    })).toThrow(/latestVersion/u)
    expect(() => validateLocalDataMigrationManifest({
      ...localDataMigrationManifest,
      migrations: [
        localDataMigrationManifest.migrations[0],
        {
          ...localDataMigrationManifest.migrations[1],
          version: 3,
          ledger_sql: canonicalLocalDataMigrationLedgerSql(
            3,
            localDataMigrationManifest.migrations[1]?.name ?? '',
            localDataMigrationManifest.migrations[1]?.checksum ?? ''
          )
        }
      ]
    })).toThrow(/contiguous/u)
    expect(() => validateLocalDataMigrationManifest({
      ...localDataMigrationManifest,
      migrations: [
        { ...localDataMigrationManifest.migrations[0], ledger_sql: 'DROP TABLE local_conversations;' },
        ...localDataMigrationManifest.migrations.slice(1)
      ]
    })).toThrow(/canonical/u)
    expect(() => validateLocalDataMigrationManifest({
      ...localDataMigrationManifest,
      migrations: [
        {
          ...localDataMigrationManifest.migrations[0],
          ledger_sql: localDataMigrationManifest.migrations[0]?.ledger_sql.replace('PRAGMA user_version = 1;', 'PRAGMA user_version = 2;') ?? ''
        },
        ...localDataMigrationManifest.migrations.slice(1)
      ]
    })).toThrow(/canonical/u)

    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 1, checksum: 'f'.repeat(64) }
    ])).toThrow(/checksum/u)
    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 1, checksum: localDataMigrationManifest.migrations[0]?.checksum ?? '' },
      { version: 1, checksum: localDataMigrationManifest.migrations[0]?.checksum ?? '' }
    ])).toThrow(/duplicate/u)
    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 2, checksum: localDataMigrationManifest.migrations[1]?.checksum ?? '' }
    ])).toThrow(/contiguous prefix/u)
    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 1, checksum: localDataMigrationManifest.migrations[0]?.checksum ?? '' },
      { version: 3, checksum: localDataMigrationManifest.migrations[2]?.checksum ?? '' }
    ])).toThrow(/contiguous prefix/u)
    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 1, checksum: localDataMigrationManifest.migrations[0]?.checksum ?? '' },
      { version: 4, checksum: '0'.repeat(64) }
    ])).toThrow(/contiguous prefix/u)
  })

  it('keeps the checked JSON Schema artifact generated from the Zod schemas', () => {
    const generated = JSON.parse(readFileSync(resolve(process.cwd(), 'src/local-data/generated/local-data.schema.json'), 'utf8'))
    expect(generated).toEqual(JSON.parse(JSON.stringify(buildLocalDataJsonSchemaArtifact())))
  })

  it('renders all generator outputs before replacing existing files', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'aurora-local-data-generator-'))
    try {
      const migrationsDir = resolve(temp, 'migrations')
      const manifestOutput = resolve(temp, 'manifest.json')
      const tsOutput = resolve(temp, 'migration-manifest.ts')
      const schemaOutput = resolve(temp, 'local-data.schema.json')
      const rustOutput = resolve(temp, 'local_data_migrations.rs')
      writeFileSync(resolve(temp, 'keep'), '')
      writeFileSync(manifestOutput, 'sentinel-manifest')
      writeFileSync(tsOutput, 'sentinel-ts')
      writeFileSync(schemaOutput, 'sentinel-schema')
      writeFileSync(rustOutput, 'sentinel-rust')
      rmSync(migrationsDir, { force: true, recursive: true })
      writeFileSync(resolve(temp, 'bad-name.sql'), 'SELECT 1;')

      const result = spawnSync('python3', [
        resolve(process.cwd(), '../../scripts/generate_local_data_migration_manifest.py'),
        '--migrations-dir', temp,
        '--manifest-output', manifestOutput,
        '--ts-output', tsOutput,
        '--schema-output', schemaOutput,
        '--rust-output', rustOutput
      ], {
        cwd: process.cwd(),
        encoding: 'utf8'
      })

      expect(result.status).not.toBe(0)
      expect(readFileSync(manifestOutput, 'utf8')).toBe('sentinel-manifest')
      expect(readFileSync(tsOutput, 'utf8')).toBe('sentinel-ts')
      expect(readFileSync(schemaOutput, 'utf8')).toBe('sentinel-schema')
      expect(readFileSync(rustOutput, 'utf8')).toBe('sentinel-rust')
      expect(existsSync(resolve(process.cwd(), 'src/local-data/migrations/sqlite/manifest.rust.json'))).toBe(false)
    } finally {
      rmSync(temp, { force: true, recursive: true })
    }
  })
})
