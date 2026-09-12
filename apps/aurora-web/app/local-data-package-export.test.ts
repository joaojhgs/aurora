import { describe, expect, it } from 'vitest'
import {
  BrowserIndexedDbLocalDataBackend,
  BrowserSqliteLocalDataBackend,
  createLocalDataBackend,
  deriveBrowserSqliteStorageIdentity,
  deriveBrowserStorageOwnerKey,
  describeBrowserStorageHealth,
} from '@aurora/ui/local-data'

describe('@aurora/ui local-data package export', () => {
  it('is importable from a workspace consumer package', () => {
    expect(new BrowserIndexedDbLocalDataBackend({ origin: 'https://aurora.example.test' }).kind).toBe('indexeddb')
    expect(BrowserSqliteLocalDataBackend).toBeTypeOf('function')
    expect(createLocalDataBackend).toBeTypeOf('function')
    expect(deriveBrowserSqliteStorageIdentity('node-1').databaseName).toBe('/aurora-lightweight.db')
    expect(deriveBrowserStorageOwnerKey('https://aurora.example.test/a', 'node-1'))
      .toBe(deriveBrowserStorageOwnerKey('https://aurora.example.test/b', 'node-1'))
    expect(describeBrowserStorageHealth({
      backend: {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: 'profile-1',
        schemaVersion: 3,
        migrationState: 'idle',
      },
      ownerAvailable: true,
    }).outcome).toBe('saved_on_this_device')
  })
})
