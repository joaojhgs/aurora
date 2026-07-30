import { LocalDataError } from '@aurora/client/local-data'

export const BROWSER_STORAGE_LOCK_DATABASE_NAME = 'aurora-browser-storage-locks'
export const BROWSER_STORAGE_LOCK_STORE_NAME = 'leases'

export type BrowserStorageLockMode = 'web-locks' | 'indexeddb-lease'
export type BrowserStorageLockFailureReason =
  | 'owner_exists'
  | 'lease_store_unavailable'
  | 'lock_api_unavailable'
  | 'lease_lost'

export interface BrowserStorageLockStatus {
  readonly acquired: boolean
  readonly mode: BrowserStorageLockMode
  readonly lockKey: string
  readonly ownerId: string
  readonly expiresAtMs: number | null
  readonly failureReason?: BrowserStorageLockFailureReason
}

export interface BrowserStorageWriterLock {
  readonly status: BrowserStorageLockStatus
  assertWritable(): void
  renew(): Promise<BrowserStorageLockStatus>
  release(): Promise<void>
}

export interface BrowserStorageLeaseRecord {
  readonly lockKey: string
  readonly ownerId: string
  readonly expiresAtMs: number
}

export interface BrowserStorageLeaseStore {
  get(lockKey: string): Promise<BrowserStorageLeaseRecord | null>
  compareAndSet(lockKey: string, expectedOwnerId: string | null, next: BrowserStorageLeaseRecord): Promise<boolean>
  delete(lockKey: string, ownerId: string): Promise<void>
  close(): Promise<void>
}

export interface BrowserStorageLockManagerLike {
  request<T>(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown | null) => T | Promise<T>,
  ): Promise<T>
}

export interface BrowserStorageLockCoordinatorOptions {
  readonly origin?: string
  readonly localNodeId: string
  readonly ownerId?: string
  readonly locks?: BrowserStorageLockManagerLike | null
  readonly leaseStore?: BrowserStorageLeaseStore | null
  readonly nowMs?: () => number
  readonly leaseDurationMs?: number
}

export class BrowserStorageLockCoordinator {
  private readonly origin: string
  private readonly localNodeId: string
  private readonly ownerId: string
  private readonly locks: BrowserStorageLockManagerLike | null
  private readonly leaseStore: BrowserStorageLeaseStore | null
  private readonly nowMs: () => number
  private readonly leaseDurationMs: number

  constructor(options: BrowserStorageLockCoordinatorOptions) {
    this.origin = canonicalOrigin(options.origin)
    this.localNodeId = options.localNodeId
    this.ownerId = options.ownerId ?? randomOwnerId()
    this.locks = options.locks === undefined ? defaultLockManager() : options.locks
    this.leaseStore = options.leaseStore ?? null
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.leaseDurationMs = options.leaseDurationMs ?? 15_000
  }

  get lockKey(): string {
    return deriveBrowserStorageOwnerKey(this.origin, this.localNodeId)
  }

  async acquire(): Promise<BrowserStorageWriterLock> {
    if (this.locks !== null) {
      const webLock = await tryAcquireWebLock(this.locks, this.lockKey, this.ownerId)
      if (webLock !== null) return webLock
      throw lockError('owner_exists')
    }
    if (this.leaseStore === null) throw lockError('lease_store_unavailable')
    return await this.acquireLease()
  }

  private async acquireLease(): Promise<BrowserStorageWriterLock> {
    const leaseStore = this.leaseStore
    if (leaseStore === null) throw lockError('lease_store_unavailable')
    const expiresAtMs = this.nowMs() + this.leaseDurationMs
    const existing = await leaseStore.get(this.lockKey)
    const expectedOwnerId = existing?.ownerId ?? null
    if (existing !== null && existing.expiresAtMs > this.nowMs() && existing.ownerId !== this.ownerId) {
      throw lockError('owner_exists')
    }
    const acquired = await leaseStore.compareAndSet(this.lockKey, expectedOwnerId, {
      lockKey: this.lockKey,
      ownerId: this.ownerId,
      expiresAtMs
    })
    if (!acquired) throw lockError('owner_exists')
    return new IndexedDbLeaseWriterLock({
      lockKey: this.lockKey,
      ownerId: this.ownerId,
      expiresAtMs,
      leaseStore,
      nowMs: this.nowMs,
      leaseDurationMs: this.leaseDurationMs
    })
  }
}

export class IndexedDbBrowserStorageLeaseStore implements BrowserStorageLeaseStore {
  private readonly databaseName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(options: { indexedDB?: IDBFactory; databaseName?: string; storeName?: string } = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!indexedDB) throw new LocalDataError('unsupported_backend', 'Browser local data ownership is unavailable', { reason: 'lease_store_unavailable' })
    this.indexedDB = indexedDB
    this.databaseName = options.databaseName ?? BROWSER_STORAGE_LOCK_DATABASE_NAME
    this.storeName = options.storeName ?? BROWSER_STORAGE_LOCK_STORE_NAME
  }

  async get(lockKey: string): Promise<BrowserStorageLeaseRecord | null> {
    return (await this.request('readonly', (store) => store.get(lockKey)) as BrowserStorageLeaseRecord | undefined) ?? null
  }

  async compareAndSet(lockKey: string, expectedOwnerId: string | null, next: BrowserStorageLeaseRecord): Promise<boolean> {
    const database = await this.database()
    return await new Promise<boolean>((resolve, reject) => {
      const tx = database.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const read = store.get(lockKey)
      let accepted = false
      read.onsuccess = () => {
        const existing = read.result as BrowserStorageLeaseRecord | undefined
        const owner = existing?.ownerId ?? null
        if (owner !== expectedOwnerId) return
        accepted = true
        store.put(next, lockKey)
      }
      read.onerror = () => reject(read.error ?? new Error('lease read failed'))
      tx.oncomplete = () => resolve(accepted)
      tx.onerror = () => reject(tx.error ?? new Error('lease transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('lease transaction aborted'))
    })
  }

  async delete(lockKey: string, ownerId: string): Promise<void> {
    const database = await this.database()
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      const read = store.get(lockKey)
      read.onsuccess = () => {
        const existing = read.result as BrowserStorageLeaseRecord | undefined
        if (existing?.ownerId === ownerId) store.delete(lockKey)
      }
      read.onerror = () => reject(read.error ?? new Error('lease read failed'))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('lease transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('lease transaction aborted'))
    })
  }

  async close(): Promise<void> {
    if (this.databasePromise !== null) (await this.databasePromise).close()
    this.databasePromise = null
  }

  private async request<T>(mode: IDBTransactionMode, build: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.database()
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(this.storeName, mode)
      const request = build(tx.objectStore(this.storeName))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(request.error ?? new Error('lease request failed'))
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('lease transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('lease transaction aborted'))
    })
  }

  private async database(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) return await this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('lease database open failed'))
      request.onblocked = () => reject(new Error('lease database upgrade blocked'))
    })
    return await this.databasePromise
  }
}

export async function deleteBrowserStorageLeaseRecord(
  lockKey: string,
  options: { readonly indexedDB?: IDBFactory; readonly databaseName?: string; readonly storeName?: string } = {},
): Promise<void> {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  if (!indexedDB) throw new LocalDataError('unsupported_backend', 'Browser local data ownership is unavailable', { reason: 'lease_store_unavailable' })
  const databaseName = options.databaseName ?? BROWSER_STORAGE_LOCK_DATABASE_NAME
  const storeName = options.storeName ?? BROWSER_STORAGE_LOCK_STORE_NAME
  const database = await openStorageLockDatabase(indexedDB, databaseName, storeName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(lockKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('lease cleanup transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('lease cleanup transaction aborted'))
    })
  } finally {
    database.close()
  }
}

async function openStorageLockDatabase(indexedDB: IDBFactory, databaseName: string, storeName: string): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('lease cleanup database open failed'))
    request.onblocked = () => reject(new Error('lease cleanup database open blocked'))
  })
}

class WebLocksWriterLock implements BrowserStorageWriterLock {
  private released = false
  private readonly releaseHeldLock: () => void
  private readonly held: Promise<unknown>

  constructor(
    readonly status: BrowserStorageLockStatus,
    releaseHeldLock: () => void,
    held: Promise<unknown>,
  ) {
    this.releaseHeldLock = releaseHeldLock
    this.held = held
  }

  assertWritable(): void {
    if (this.released) throw lockError('lease_lost')
  }

  async renew(): Promise<BrowserStorageLockStatus> {
    this.assertWritable()
    return this.status
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.releaseHeldLock()
    await this.held
  }
}

class IndexedDbLeaseWriterLock implements BrowserStorageWriterLock {
  private released = false
  status: BrowserStorageLockStatus
  private readonly leaseStore: BrowserStorageLeaseStore
  private readonly nowMs: () => number
  private readonly leaseDurationMs: number

  constructor(options: {
    lockKey: string
    ownerId: string
    expiresAtMs: number
    leaseStore: BrowserStorageLeaseStore
    nowMs: () => number
    leaseDurationMs: number
  }) {
    this.leaseStore = options.leaseStore
    this.nowMs = options.nowMs
    this.leaseDurationMs = options.leaseDurationMs
    this.status = {
      acquired: true,
      mode: 'indexeddb-lease',
      lockKey: options.lockKey,
      ownerId: options.ownerId,
      expiresAtMs: options.expiresAtMs
    }
  }

  assertWritable(): void {
    if (this.released || this.status.expiresAtMs === null || this.status.expiresAtMs <= this.nowMs()) throw lockError('lease_lost')
  }

  async renew(): Promise<BrowserStorageLockStatus> {
    this.assertWritable()
    const expiresAtMs = this.nowMs() + this.leaseDurationMs
    const renewed = await this.leaseStore.compareAndSet(this.status.lockKey, this.status.ownerId, {
      lockKey: this.status.lockKey,
      ownerId: this.status.ownerId,
      expiresAtMs
    })
    if (!renewed) throw lockError('lease_lost')
    this.status = { ...this.status, expiresAtMs }
    return this.status
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.leaseStore.delete(this.status.lockKey, this.status.ownerId)
  }
}

async function tryAcquireWebLock(
  locks: BrowserStorageLockManagerLike,
  lockKey: string,
  ownerId: string,
): Promise<BrowserStorageWriterLock | null> {
  let signalSettled = false
  let resolveSignal: (value: { release: () => void } | null) => void = () => {}
  let rejectSignal: (reason: unknown) => void = () => {}
  const signal = new Promise<{ release: () => void } | null>((resolve, reject) => {
    resolveSignal = (value) => {
      signalSettled = true
      resolve(value)
    }
    rejectSignal = (reason) => {
      signalSettled = true
      reject(reason)
    }
  })
  const held = Promise.resolve()
    .then(async () => await locks.request(lockKey, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (lock === null) {
        resolveSignal(null)
        return false
      }
      let releaseHeldLock: () => void = () => {}
      const releasePromise = new Promise<void>((resolve) => {
        releaseHeldLock = resolve
      })
      resolveSignal({ release: releaseHeldLock })
      await releasePromise
      return true
    }))
    .then(() => undefined, (error: unknown) => {
      if (!signalSettled) rejectSignal(error)
    })
  const acquired = await signal
  if (acquired === null) {
    await held
    return null
  }
  return new WebLocksWriterLock({
    acquired: true,
    mode: 'web-locks',
    lockKey,
    ownerId,
    expiresAtMs: null
  }, acquired.release, held)
}

export function deriveBrowserStorageOwnerKey(origin: string, localNodeId: string): string {
  return `aurora:browser-local-data:${stableHash(`${canonicalOrigin(origin)}\u0000${localNodeId}`)}`
}

function canonicalOrigin(origin: string | undefined): string {
  const candidate = origin ?? globalThis.location?.origin ?? 'browser://unknown'
  try {
    return new URL(candidate).origin
  } catch {
    return candidate
  }
}

function defaultLockManager(): BrowserStorageLockManagerLike | null {
  const navigatorLocks = globalThis.navigator?.locks as BrowserStorageLockManagerLike | undefined
  return navigatorLocks ?? null
}

function randomOwnerId(): string {
  return `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function lockError(reason: BrowserStorageLockFailureReason): LocalDataError {
  return new LocalDataError('unsupported_backend', 'Browser local data is already open for writing', { reason })
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
