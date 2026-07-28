import { describe, expect, it } from 'vitest'

import { deriveBrowserSqliteStorageIdentity, rejectsPythonServiceDatabaseName } from './browser-sqlite-opfs.js'

describe('browser sqlite OPFS identity', () => {
  it('derives one physical database identity from the stable local node only', () => {
    const first = deriveBrowserSqliteStorageIdentity('Node-1')
    const sameNodeDifferentProfile = deriveBrowserSqliteStorageIdentity('Node-1')
    const differentNode = deriveBrowserSqliteStorageIdentity('Node-2')

    expect(first).toEqual(sameNodeDifferentProfile)
    expect(first.browserStorageIdentity).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.sahPoolDirectory).toBe(`/aurora/nodes/${first.browserStorageIdentity}/`)
    expect(first.databaseName).toBe('/aurora-lightweight.db')
    expect(differentNode.browserStorageIdentity).not.toBe(first.browserStorageIdentity)
  })

  it('rejects path traversal and Python service database names before storage access', () => {
    expect(() => deriveBrowserSqliteStorageIdentity('../aurora.db')).toThrow(/python_database_rejected|invalid_identity/u)
    expect(() => deriveBrowserSqliteStorageIdentity('/tmp/aurora.sqlite')).toThrow(/invalid_identity/u)
    expect(rejectsPythonServiceDatabaseName('app/services/db/aurora.sqlite')).toBe(true)
    expect(rejectsPythonServiceDatabaseName('profile-1')).toBe(false)
  })
})

