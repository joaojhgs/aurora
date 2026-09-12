import { LocalDataError } from './backend.js'

export interface LocalDataMigrationManifestEntry {
  version: number
  name: string
  file: string
  checksum: string
  min_app_version: string
  requires_pre_migration_export: boolean
  ledger_sql: string
}

export interface LocalDataMigrationManifest {
  formatVersion: 1
  databaseName: 'aurora-lightweight.db'
  latestVersion: number
  migrations: LocalDataMigrationManifestEntry[]
}

export function validateLocalDataMigrationManifest(value: unknown): LocalDataMigrationManifest {
  const record = requireRecord(value, 'migration manifest')
  if (record.formatVersion !== 1) throw new LocalDataError('migration_integrity', 'Migration manifest format version is unsupported')
  if (record.databaseName !== 'aurora-lightweight.db') throw new LocalDataError('migration_integrity', 'Migration manifest database name is invalid')
  const migrations = requireArray(record.migrations, 'migrations').map(parseEntry)
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1
    if (migration.version !== expectedVersion) {
      throw new LocalDataError('migration_order', `Migration versions must be contiguous from 1; expected ${expectedVersion}`)
    }
    if (!migration.file.startsWith(String(migration.version).padStart(4, '0'))) {
      throw new LocalDataError('migration_order', 'Migration filename must start with its zero-padded version')
    }
  }
  const latestVersion = requireNonNegativeInt(record.latestVersion, 'latestVersion')
  if (latestVersion !== migrations.length) {
    throw new LocalDataError('migration_order', 'Migration latestVersion must match the final contiguous version')
  }
  return { formatVersion: 1, databaseName: 'aurora-lightweight.db', latestVersion, migrations }
}

export function assertStoredMigrationChecksums(
  manifest: LocalDataMigrationManifest,
  stored: Array<{ version: number; checksum: string }>,
): void {
  let expectedVersion = 1
  const seen = new Set<number>()
  for (const row of stored) {
    if (!Number.isSafeInteger(row.version) || row.version < 1) {
      throw new LocalDataError('migration_integrity', 'Stored migration version is invalid')
    }
    if (seen.has(row.version)) {
      throw new LocalDataError('migration_integrity', 'Stored migration ledger contains a duplicate version')
    }
    seen.add(row.version)
    if (row.version !== expectedVersion) {
      throw new LocalDataError('migration_integrity', 'Stored migration ledger must be a contiguous prefix from version 1')
    }
    const entry = manifest.migrations[row.version - 1]
    if (entry === undefined || entry.checksum !== row.checksum) {
      throw new LocalDataError('migration_integrity', 'Stored migration checksum does not match immutable manifest')
    }
    expectedVersion += 1
  }
}

function parseEntry(value: unknown): LocalDataMigrationManifestEntry {
  const record = requireRecord(value, 'migration')
  const version = requirePositiveInt(record.version, 'version')
  const name = requireName(record.name, 'name')
  const checksum = requireChecksum(record.checksum, 'checksum')
  return {
    version,
    name,
    file: requireFile(record.file, 'file'),
    checksum,
    min_app_version: requireString(record.min_app_version, 'min_app_version'),
    requires_pre_migration_export: requireBoolean(record.requires_pre_migration_export, 'requires_pre_migration_export'),
    ledger_sql: requireCanonicalLedgerSql(record.ledger_sql, version, name, checksum)
  }
}

export function canonicalLocalDataMigrationLedgerSql(version: number, name: string, checksum: string): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new LocalDataError('migration_integrity', 'version must be a positive integer')
  if (!/^[a-z0-9_]+$/u.test(name)) throw new LocalDataError('migration_integrity', 'name must be immutable snake case')
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new LocalDataError('migration_integrity', 'checksum must be a lowercase SHA-256 checksum')
  return (
    'INSERT INTO aurora_schema_migrations (version, name, checksum, applied_at_ms) '
    + `VALUES (${version}, '${name}', '${checksum}', CAST(strftime('%s','now') AS INTEGER) * 1000);\n`
    + `PRAGMA user_version = ${version};`
  )
}

function requireCanonicalLedgerSql(value: unknown, version: number, name: string, checksum: string): string {
  const parsed = requireString(value, 'ledger_sql')
  const canonical = canonicalLocalDataMigrationLedgerSql(version, name, checksum)
  if (parsed !== canonical) {
    throw new LocalDataError('migration_integrity', 'Migration ledger SQL must match the canonical validated statement')
  }
  return parsed
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new LocalDataError('migration_integrity', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new LocalDataError('migration_integrity', `${label} must be an array`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) throw new LocalDataError('migration_integrity', `${label} must be a string`)
  return value
}

function requireName(value: unknown, label: string): string {
  const parsed = requireString(value, label)
  if (!/^[a-z0-9_]+$/u.test(parsed)) throw new LocalDataError('migration_integrity', `${label} must be immutable snake case`)
  return parsed
}

function requireFile(value: unknown, label: string): string {
  const parsed = requireString(value, label)
  if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(parsed)) throw new LocalDataError('migration_integrity', `${label} must be a versioned SQL filename`)
  return parsed
}

function requireChecksum(value: unknown, label: string): string {
  const parsed = requireString(value, label)
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new LocalDataError('migration_integrity', `${label} must be a lowercase SHA-256 checksum`)
  return parsed
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new LocalDataError('migration_integrity', `${label} must be a boolean`)
  return value
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new LocalDataError('migration_integrity', `${label} must be a positive integer`)
  return value
}

function requireNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new LocalDataError('migration_integrity', `${label} must be a non-negative integer`)
  return value
}
