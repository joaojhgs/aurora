import { LocalDataError, type LocalDataBackend } from '@aurora/client/local-data'

import { BrowserSqliteLocalDataBackend, fallbackReasonFromError, type BrowserSqliteLocalDataBackendOptions } from './browser-sqlite-worker-client.js'

export type BrowserLocalDataFallbackReason =
  | 'worker_unavailable'
  | 'wasm_unavailable'
  | 'opfs_unavailable'
  | 'ownership_unavailable'
  | 'invalid_identity'
  | 'python_database_rejected'
  | 'storage_persistence_denied'
  | 'worker_open_failed'
  | 'migration_failed'

export interface CreateLocalDataBackendOptions extends BrowserSqliteLocalDataBackendOptions {
  readonly indexedDbBackend: LocalDataBackend
  readonly onStorageHealth?: (status: BrowserLocalDataStorageHealthInput) => void
}

export interface BrowserLocalDataStorageHealthInput {
  readonly selectedBackend: LocalDataBackend['kind']
  readonly sqliteAttempted: boolean
  readonly sqliteAvailable: boolean
  readonly fallbackReason: BrowserLocalDataFallbackReason | null
}

export async function createLocalDataBackend(
  profileId: string,
  localNodeId: string,
  options: CreateLocalDataBackendOptions
): Promise<LocalDataBackend> {
  const sqliteBackend = new BrowserSqliteLocalDataBackend(options)
  try {
    await sqliteBackend.open(profileId, localNodeId)
    options.onStorageHealth?.({
      selectedBackend: 'sqlite-wasm-opfs',
      sqliteAttempted: true,
      sqliteAvailable: true,
      fallbackReason: null
    })
    return sqliteBackend
  } catch (error) {
    await sqliteBackend.close().catch(() => undefined)
    const fallbackReason = fallbackReasonFromError(error)
    const fallback = options.indexedDbBackend
    try {
      await fallback.open(profileId, localNodeId)
    } catch (fallbackError) {
      throw new LocalDataError('unsupported_backend', 'Local data storage is unavailable', {
        reason: fallbackError instanceof LocalDataError ? fallbackError.code : 'indexeddb_open_failed'
      })
    }
    options.onStorageHealth?.({
      selectedBackend: fallback.kind,
      sqliteAttempted: true,
      sqliteAvailable: false,
      fallbackReason
    })
    return fallback
  }
}
