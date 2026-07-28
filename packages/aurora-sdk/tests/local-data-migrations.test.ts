import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertStoredMigrationChecksums,
  buildLocalDataJsonSchemaArtifact,
  localDataMigrationManifest,
  validateLocalDataMigrationManifest
} from '../src/local-data/index.js'

describe('local-data SQLite migration manifest', () => {
  it('is contiguous, forward-only, checksummed, and tied to the lightweight database', () => {
    expect(localDataMigrationManifest.databaseName).toBe('aurora-lightweight.db')
    expect(localDataMigrationManifest.latestVersion).toBe(3)
    expect(localDataMigrationManifest.migrations.map((migration) => migration.version)).toEqual([1, 2, 3])
    expect(localDataMigrationManifest.migrations.every((migration) => migration.ledger_sql.includes('aurora_schema_migrations'))).toBe(true)

    for (const migration of localDataMigrationManifest.migrations) {
      const sql = readFileSync(resolve(process.cwd(), `src/local-data/migrations/sqlite/${migration.file}`), 'utf8')
      expect(createHash('sha256').update(sql).digest('hex')).toBe(migration.checksum)
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
        { ...localDataMigrationManifest.migrations[1], version: 3 }
      ]
    })).toThrow(/contiguous/u)

    expect(() => assertStoredMigrationChecksums(localDataMigrationManifest, [
      { version: 1, checksum: 'f'.repeat(64) }
    ])).toThrow(/checksum/u)
  })

  it('keeps the checked JSON Schema artifact generated from the Zod schemas', () => {
    const generated = JSON.parse(readFileSync(resolve(process.cwd(), 'src/local-data/generated/local-data.schema.json'), 'utf8'))
    expect(generated).toEqual(JSON.parse(JSON.stringify(buildLocalDataJsonSchemaArtifact())))
  })
})
