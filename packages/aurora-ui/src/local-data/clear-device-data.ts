import type { LocalDataBackend } from '@aurora/client/local-data'

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
  | 'active-handles'
  | 'peer-vault'
  | 'peer-profile'
  | 'local-data-indexeddb'
  | 'local-data-opfs'
  | 'backend-pointer'
  | 'storage-lock'
  | 'envelope-key-vault'

export interface BrowserClearDeviceDataStepResult {
  readonly step: BrowserClearDeviceDataStepName
  readonly ok: boolean
  readonly target: string
  readonly skipped?: boolean
  readonly reason?: string
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
  const profileId = options.profileId
  const localNodeId = options.localNodeId
  const origin = canonicalOrigin(options.origin)
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  const pointerStore = options.pointerStore === undefined
    ? defaultPointerStore(options.metadataStorage)
    : options.pointerStore
  const steps: BrowserClearDeviceDataStepResult[] = []

  await recordStep(steps, 'active-handles', `${profileId}/${localNodeId}`, async () => {
    if (options.peerStore !== null && options.peerStore !== undefined) {
      await options.peerStore.clear()
      await options.peerStore.close()
    }
    for (const backend of options.localDataBackends ?? []) await backend.close()
    for (const closeable of options.closeables ?? []) await closeable.close()
  })

  await recordStep(steps, 'peer-profile', 'browser-peer-profile-metadata', async () => {
    clearBrowserPeerProfileMetadata({
      origin,
      ...(options.metadataStorage === undefined ? {} : { metadataStorage: options.metadataStorage }),
    })
  })

  await recordStep(steps, 'backend-pointer', `${profileId}/${localNodeId}`, async () => {
    if (pointerStore === null) throw new Error('backend pointer store unavailable')
    if (typeof pointerStore.delete !== 'function') throw new Error('backend pointer cleanup unavailable')
    await pointerStore.delete(profileId, localNodeId)
  })

  await recordStep(steps, 'storage-lock', deriveBrowserStorageOwnerKey(origin, localNodeId), async () => {
    requireIndexedDb(indexedDB)
    await deleteBrowserStorageLeaseRecord(deriveBrowserStorageOwnerKey(origin, localNodeId), { indexedDB })
  })

  await recordStep(steps, 'envelope-key-vault', deriveBrowserEnvelopeCryptoDatabaseName(origin, localNodeId), async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, deriveBrowserEnvelopeCryptoDatabaseName(origin, localNodeId))
  })

  await recordStep(steps, 'local-data-indexeddb', deriveBrowserLocalDataDatabaseName(origin, localNodeId), async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, deriveBrowserLocalDataDatabaseName(origin, localNodeId))
  })

  await recordStep(steps, 'peer-vault', BROWSER_PEER_VAULT_DATABASE_NAME, async () => {
    requireIndexedDb(indexedDB)
    await deleteIndexedDbDatabase(indexedDB, BROWSER_PEER_VAULT_DATABASE_NAME)
  })

  await recordStep(steps, 'local-data-opfs', deriveBrowserSqliteStorageIdentity(localNodeId).sahPoolDirectory, async () => {
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
      reason: errorReason(error),
    })
  }
}

async function deleteIndexedDbDatabase(indexedDB: IDBFactory, databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB delete failed: ${databaseName}`))
    request.onblocked = () => reject(new Error(`IndexedDB delete blocked: ${databaseName}`))
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
  if (indexedDB === undefined) throw new Error('IndexedDB unavailable')
}

function canonicalOrigin(origin: string | undefined): string {
  const candidate = origin ?? globalThis.location?.origin ?? 'browser://unknown'
  try {
    return new URL(candidate).origin
  } catch {
    return candidate
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}
