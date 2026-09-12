import { localDataIdSchema, type LocalDataBackend } from '@aurora/client/local-data'

import {
  BROWSER_PEER_VAULT_DATABASE_NAME,
  clearBrowserPeerProfileMetadata,
} from '../browser-peer-persistence-keys'
import type { BrowserWebRtcCredentialStore } from '../browser-peer-persistence'
import {
  LocalStorageBrowserLocalDataBackendPointerStore,
  type BrowserLocalDataBackendPointerStore,
} from './browser-backend-transfer'
import { deriveBrowserEnvelopeCryptoDatabaseName } from './browser-envelope-crypto'
import { deriveBrowserLocalDataDatabaseName } from './browser-indexeddb'
import { deriveBrowserSqliteStorageIdentity } from './browser-sqlite-opfs'
import {
  deleteBrowserStorageLeaseRecord,
  deriveBrowserStorageOwnerKey,
} from './browser-storage-lock'

export type BrowserClearDeviceDataStepName =
  | 'invalid-scope'
  | 'active-handles'
  | 'peer-vault'
  | 'peer-profile'
  | 'local-data-indexeddb'
  | 'local-data-opfs'
  | 'backend-pointer'
  | 'storage-lock'
  | 'envelope-key-vault'

export type BrowserClearDeviceDataFailureReason =
  | 'invalid_scope'
  | 'active_handle_close_failed'
  | 'peer_profile_cleanup_failed'
  | 'backend_pointer_unavailable'
  | 'backend_pointer_cleanup_failed'
  | 'indexeddb_unavailable'
  | 'storage_lock_unavailable'
  | 'storage_lock_cleanup_failed'
  | 'storage_delete_failed'
  | 'storage_delete_blocked'
  | 'opfs_unavailable'
  | 'opfs_cleanup_failed'
  | 'unknown_failure'

export interface BrowserClearDeviceDataStepResult {
  readonly step: BrowserClearDeviceDataStepName
  readonly ok: boolean
  readonly target: string
  readonly skipped?: boolean
  readonly reason?: BrowserClearDeviceDataFailureReason
}

export interface BrowserClearDeviceDataResult {
  readonly ok: boolean
  readonly profileId: string
  readonly localNodeId: string
  readonly steps: readonly BrowserClearDeviceDataStepResult[]
  readonly failures: readonly BrowserClearDeviceDataStepResult[]
}

export interface BrowserClearDeviceDataOptions {
  readonly profileId: string
  readonly localNodeId: string
  readonly origin?: string
  readonly indexedDB?: IDBFactory
  readonly metadataStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  readonly storageManager?: BrowserClearStorageManager | null
  readonly peerStore?: BrowserWebRtcCredentialStore | null
  readonly localDataBackends?: readonly LocalDataBackend[]
  readonly closeables?: readonly { close(): Promise<void> | void }[]
  readonly pointerStore?: BrowserLocalDataBackendPointerStore | null
}

interface BrowserClearStorageManager {
  getDirectory?: () => Promise<BrowserClearDirectoryHandle>
}

interface BrowserClearDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserClearDirectoryHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

export async function clearBrowserDeviceData(options: BrowserClearDeviceDataOptions): Promise<BrowserClearDeviceDataResult> {
  const scope = deriveClearScope(options)
  if (!scope.ok) return scope.result
  const { profileId, localNodeId, origin, targets } = scope
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  const pointerStore = options.pointerStore === undefined
    ? defaultPointerStore(options.metadataStorage)
    : options.pointerStore
  const steps: BrowserClearDeviceDataStepResult[] = []

  await recordStep(steps, 'active-handles', targets.activeHandles, 'active_handle_close_failed', async () => {
    if (options.peerStore !== null && options.peerStore !== undefined) {
      await options.peerStore.clear()
      await options.peerStore.close()
    }
    for (const backend of options.localDataBackends ?? []) await backend.close()
    for (const closeable of options.closeables ?? []) await closeable.close()
  })

  await recordStep(steps, 'peer-profile', targets.peerProfile, 'peer_profile_cleanup_failed', async () => {
    clearBrowserPeerProfileMetadata({
      origin,
      ...(options.metadataStorage === undefined ? {} : { metadataStorage: options.metadataStorage }),
    })
  })

  await recordStep(steps, 'backend-pointer', targets.backendPointer, 'backend_pointer_cleanup_failed', async () => {
    if (pointerStore === null) throw new ClearDeviceDataFailure('backend_pointer_unavailable')
    if (typeof pointerStore.delete !== 'function') throw new ClearDeviceDataFailure('backend_pointer_cleanup_failed')
    await pointerStore.delete(profileId, localNodeId)
  })

  await recordStep(steps, 'storage-lock', targets.storageLock, 'storage_lock_cleanup_failed', async () => {
    requireIndexedDb(indexedDB)
    await deleteBrowserStorageLeaseRecord(targets.storageLock, { indexedDB })
  })

  await recordStep(steps, 'envelope-key-vault', targets.envelopeKeyVault, 'storage_delete_failed', async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, targets.envelopeKeyVault)
  })

  await recordStep(steps, 'local-data-indexeddb', targets.localDataIndexedDb, 'storage_delete_failed', async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, targets.localDataIndexedDb)
  })

  await recordStep(steps, 'peer-vault', targets.peerVault, 'storage_delete_failed', async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, targets.peerVault)
  })

  await recordStep(steps, 'local-data-opfs', targets.localDataOpfs, 'opfs_cleanup_failed', async () => {
    await removeBrowserSqliteOpfsNodeDirectory(localNodeId, options.storageManager)
  })

  const failures = steps.filter((step) => !step.ok)
  return {
    ok: failures.length === 0,
    profileId,
    localNodeId,
    steps,
    failures,
  }
}

async function recordStep(
  steps: BrowserClearDeviceDataStepResult[],
  step: BrowserClearDeviceDataStepName,
  target: string,
  defaultReason: BrowserClearDeviceDataFailureReason,
  work: () => Promise<void> | void,
): Promise<void> {
  try {
    await work()
    steps.push({ step, ok: true, target })
  } catch (error) {
    steps.push({
      step,
      ok: false,
      target,
      reason: reasonCode(error, defaultReason),
    })
  }
}

async function deleteIndexedDbDatabase(indexedDB: IDBFactory, databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new ClearDeviceDataFailure('storage_delete_failed'))
    request.onblocked = () => reject(new ClearDeviceDataFailure('storage_delete_blocked'))
  })
}

async function removeBrowserSqliteOpfsNodeDirectory(
  localNodeId: string,
  storageManager: BrowserClearStorageManager | null | undefined,
): Promise<void> {
  const manager = storageManager === undefined
    ? globalThis.navigator?.storage as BrowserClearStorageManager | undefined
    : storageManager
  if (typeof manager?.getDirectory !== 'function') throw new Error('OPFS directory access unavailable')
  const identity = deriveBrowserSqliteStorageIdentity(localNodeId)
  const segments = identity.sahPoolDirectory.replace(/^\/+|\/+$/gu, '').split('/')
  if (segments.length !== 3 || segments[0] !== 'aurora' || segments[1] !== 'nodes' || segments[2] !== identity.browserStorageIdentity) {
    throw new Error('Refusing to clear unexpected OPFS directory')
  }
  let parent = await manager.getDirectory()
  for (const segment of segments.slice(0, -1)) {
    try {
      parent = await parent.getDirectoryHandle(segment)
    } catch {
      return
    }
  }
  try {
    await parent.removeEntry(segments[2]!, { recursive: true })
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
}

function defaultPointerStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined,
): BrowserLocalDataBackendPointerStore | null {
  const selected = storage === undefined ? browserLocalStorage() : storage
  return selected === null || selected === undefined
    ? null
    : new LocalStorageBrowserLocalDataBackendPointerStore({ storage: selected })
}

function browserLocalStorage(): (Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function requireIndexedDb(indexedDB: IDBFactory | undefined): asserts indexedDB is IDBFactory {
  if (indexedDB === undefined) throw new ClearDeviceDataFailure('indexeddb_unavailable')
}

type ClearScopeResult =
  | {
    ok: true
    profileId: string
    localNodeId: string
    origin: string
    targets: ClearDeviceDataTargets
  }
  | { ok: false; result: BrowserClearDeviceDataResult }

interface ClearDeviceDataTargets {
  readonly activeHandles: string
  readonly peerProfile: string
  readonly backendPointer: string
  readonly storageLock: string
  readonly envelopeKeyVault: string
  readonly localDataIndexedDb: string
  readonly peerVault: string
  readonly localDataOpfs: string
}

function deriveClearScope(options: BrowserClearDeviceDataOptions): ClearScopeResult {
  try {
    const profileId = canonicalLocalDataId(options.profileId)
    const localNodeId = canonicalLocalDataId(options.localNodeId)
    const origin = canonicalOrigin(options.origin)
    const sqliteIdentity = deriveBrowserSqliteStorageIdentity(localNodeId)
    return {
      ok: true,
      profileId,
      localNodeId,
      origin,
      targets: {
        activeHandles: 'browser-clear-device-active-handles',
        peerProfile: 'browser-peer-profile-metadata',
        backendPointer: 'browser-local-data-backend-pointer',
        storageLock: deriveBrowserStorageOwnerKey(origin, localNodeId),
        envelopeKeyVault: deriveBrowserEnvelopeCryptoDatabaseName(origin, localNodeId),
        localDataIndexedDb: deriveBrowserLocalDataDatabaseName(origin, localNodeId),
        peerVault: BROWSER_PEER_VAULT_DATABASE_NAME,
        localDataOpfs: sqliteIdentity.sahPoolDirectory,
      },
    }
  } catch {
    return invalidScopeResult(options.profileId, options.localNodeId)
  }
}

function invalidScopeResult(profileId: string, localNodeId: string): ClearScopeResult {
  const failure: BrowserClearDeviceDataStepResult = {
    step: 'invalid-scope',
    ok: false,
    target: 'browser-clear-device-scope',
    reason: 'invalid_scope',
  }
  return {
    ok: false,
    result: {
      ok: false,
      profileId,
      localNodeId,
      steps: [failure],
      failures: [failure],
    },
  }
}

function canonicalLocalDataId(value: string): string {
  const parsed = localDataIdSchema.safeParse(value)
  if (!parsed.success) throw new ClearDeviceDataFailure('invalid_scope')
  return parsed.data
}

function canonicalOrigin(origin: string | undefined): string {
  const candidate = origin ?? globalThis.location?.origin
  if (candidate === undefined || candidate.trim().length === 0) throw new ClearDeviceDataFailure('invalid_scope')
  const parsed = new URL(candidate)
  return parsed.origin
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

class ClearDeviceDataFailure extends Error {
  constructor(readonly reason: BrowserClearDeviceDataFailureReason) {
    super(reason)
  }
}

function reasonCode(error: unknown, fallback: BrowserClearDeviceDataFailureReason): BrowserClearDeviceDataFailureReason {
  if (error instanceof ClearDeviceDataFailure) return error.reason
  return fallback
}
