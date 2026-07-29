import { LocalDataError, type LocalDataBackend } from '@aurora/client/local-data'

import { BrowserIndexedDbLocalDataBackend } from './browser-indexeddb.js'
import { BrowserSqliteLocalDataBackend, fallbackReasonFromError, type BrowserSqliteLocalDataBackendOptions } from './browser-sqlite-worker-client.js'
import {
  commitBrowserLocalDataBackendPointer,
  LocalStorageBrowserLocalDataBackendPointerStore,
  type BrowserLocalDataBackendPointerStore,
  type BrowserTransferableBackendKind
} from './browser-backend-transfer.js'

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
  | 'committed_backend_open_failed'

export interface CreateLocalDataBackendOptions extends BrowserSqliteLocalDataBackendOptions {
  readonly indexedDbBackend?: LocalDataBackend
  readonly pointerStore?: BrowserLocalDataBackendPointerStore | null
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
  options: CreateLocalDataBackendOptions = {}
): Promise<LocalDataBackend> {
  const pointerStore = options.pointerStore === undefined
    ? defaultPointerStore()
    : options.pointerStore
  const pointer = await pointerStore?.read(profileId, localNodeId)
  if (pointer !== null && pointer !== undefined) {
    return await openCommittedBackend(profileId, localNodeId, pointer.selectedBackend, options)
  }

  const sqliteBackend = new BrowserSqliteLocalDataBackend(options)
  try {
    await sqliteBackend.open(profileId, localNodeId)
    await commitSelectedBackendPointer(pointerStore, profileId, localNodeId, 'sqlite-wasm-opfs')
    options.onStorageHealth?.({
      selectedBackend: 'sqlite-wasm-opfs',
      sqliteAttempted: true,
      sqliteAvailable: true,
      fallbackReason: null
    })
    return sqliteBackend
  } catch (error) {
    await sqliteBackend.close().catch(() => undefined)
    if (isTerminalSqliteOpenError(error)) throw error
    const fallbackReason = fallbackReasonFromError(error)
    const fallback = options.indexedDbBackend ?? new BrowserIndexedDbLocalDataBackend()
    try {
      await fallback.open(profileId, localNodeId)
      if (fallback.kind === 'indexeddb') {
        await commitSelectedBackendPointer(pointerStore, profileId, localNodeId, 'indexeddb')
      }
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

function defaultPointerStore(): BrowserLocalDataBackendPointerStore | null {
  return typeof globalThis.localStorage === 'undefined'
    ? null
    : new LocalStorageBrowserLocalDataBackendPointerStore()
}

async function openCommittedBackend(
  profileId: string,
  localNodeId: string,
  selectedBackend: BrowserTransferableBackendKind,
  options: CreateLocalDataBackendOptions
): Promise<LocalDataBackend> {
  const backend = selectedBackend === 'sqlite-wasm-opfs'
    ? new BrowserSqliteLocalDataBackend(options)
    : options.indexedDbBackend ?? new BrowserIndexedDbLocalDataBackend()
  try {
    await backend.open(profileId, localNodeId)
  } catch (error) {
    await backend.close().catch(() => undefined)
    options.onStorageHealth?.({
      selectedBackend,
      sqliteAttempted: selectedBackend === 'sqlite-wasm-opfs',
      sqliteAvailable: false,
      fallbackReason: 'committed_backend_open_failed'
    })
    if (isTerminalSqliteOpenError(error)) throw error
    throw new LocalDataError('unsupported_backend', 'Local data storage is unavailable', {
      reason: error instanceof LocalDataError ? error.code : 'committed_backend_open_failed'
    })
  }
  options.onStorageHealth?.({
    selectedBackend,
    sqliteAttempted: selectedBackend === 'sqlite-wasm-opfs',
    sqliteAvailable: selectedBackend === 'sqlite-wasm-opfs',
    fallbackReason: null
  })
  return backend
}

async function commitSelectedBackendPointer(
  pointerStore: BrowserLocalDataBackendPointerStore | null,
  profileId: string,
  localNodeId: string,
  selectedBackend: BrowserTransferableBackendKind
): Promise<void> {
  if (pointerStore === null) return
  await commitBrowserLocalDataBackendPointer(pointerStore, {
    profileId,
    localNodeId,
    selectedBackend
  }).catch(() => undefined)
}

function isTerminalSqliteOpenError(error: unknown): boolean {
  if (!(error instanceof LocalDataError)) return false
  if (error.code === 'identity_mismatch') return true
  if (error.code !== 'migration_integrity' && error.code !== 'invalid_record') return false
  const reason = error.metadata?.reason
  return reason === 'local_node_owner_mismatch'
    || reason === 'local_node_owner_ambiguous'
    || reason === 'profile_owner_mismatch'
    || reason === 'profile_owner_ambiguous'
    || reason === 'identity_missing'
    || reason === 'identity_invalid'
    || reason === 'identity_table_missing'
}
