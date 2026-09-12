import type {
  BrowserIndexedDbDocumentStore,
  StoredBrowserLocalDataDocument
} from '../browser-indexeddb'
import type {
  BrowserStorageLeaseRecord,
  BrowserStorageLeaseStore,
  BrowserStorageLockManagerLike
} from '../browser-storage-lock'

export class MapBrowserLocalDataDocumentStore implements BrowserIndexedDbDocumentStore {
  private document: StoredBrowserLocalDataDocument | null
  readonly saves: StoredBrowserLocalDataDocument[] = []

  constructor(initial: StoredBrowserLocalDataDocument | null = null) {
    this.document = initial === null ? null : structuredClone(initial)
  }

  async load(): Promise<StoredBrowserLocalDataDocument | null> {
    return this.document === null ? null : structuredClone(this.document)
  }

  async save(document: StoredBrowserLocalDataDocument): Promise<void> {
    this.document = structuredClone(document)
    this.saves.push(structuredClone(document))
  }

  async clear(): Promise<void> {
    this.document = null
  }

  async close(): Promise<void> {}
}

export class MapBrowserStorageLeaseStore implements BrowserStorageLeaseStore {
  readonly leases = new Map<string, BrowserStorageLeaseRecord>()

  async get(lockKey: string): Promise<BrowserStorageLeaseRecord | null> {
    const lease = this.leases.get(lockKey)
    return lease === undefined ? null : { ...lease }
  }

  async compareAndSet(lockKey: string, expectedOwnerId: string | null, next: BrowserStorageLeaseRecord): Promise<boolean> {
    const currentOwner = this.leases.get(lockKey)?.ownerId ?? null
    if (currentOwner !== expectedOwnerId) return false
    this.leases.set(lockKey, { ...next })
    return true
  }

  async delete(lockKey: string, ownerId: string): Promise<void> {
    if (this.leases.get(lockKey)?.ownerId === ownerId) this.leases.delete(lockKey)
  }

  async close(): Promise<void> {}
}

export class FakeWebLocks implements BrowserStorageLockManagerLike {
  readonly held = new Set<string>()
  asyncCallback = false
  failBeforeCallback: Error | null = null

  async request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => T | Promise<T>,
  ): Promise<T> {
    if (this.failBeforeCallback !== null) throw this.failBeforeCallback
    if (this.asyncCallback) await new Promise((resolve) => setTimeout(resolve, 0))
    if (this.held.has(name)) {
      if (options.ifAvailable) return await callback(null)
      throw new Error('lock is already held')
    }
    this.held.add(name)
    try {
      return await callback({})
    } finally {
      this.held.delete(name)
    }
  }
}
