interface MemoryDatabaseState {
  readonly stores: Map<string, Map<IDBValidKey, unknown>>
}

export class MemoryIndexedDbFactory {
  readonly databases = new Map<string, MemoryDatabaseState>()
  readonly failDeleteDatabaseNames = new Map<string, Error>()

  open(name: string, _version?: number): IDBOpenDBRequest {
    const request = new MemoryOpenRequest()
    queueMicrotask(() => {
      let state = this.databases.get(name)
      const isNew = state === undefined
      if (state === undefined) {
        state = { stores: new Map() }
        this.databases.set(name, state)
      }
      request.result = new MemoryDatabase(state) as unknown as IDBDatabase
      if (isNew) request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
      request.onsuccess?.(new Event('success'))
    })
    return request as unknown as IDBOpenDBRequest
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    const request = new MemoryOpenRequest()
    queueMicrotask(() => {
      const failure = this.failDeleteDatabaseNames.get(name)
      if (failure !== undefined) {
        request.error = new DOMException(failure.message)
        request.onerror?.(new Event('error'))
        return
      }
      this.databases.delete(name)
      request.result = undefined as unknown as IDBDatabase
      request.onsuccess?.(new Event('success'))
    })
    return request as unknown as IDBOpenDBRequest
  }
}

class MemoryOpenRequest {
  result!: IDBDatabase
  error: DOMException | null = null
  onsuccess: ((event: Event) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
  onblocked: ((event: IDBVersionChangeEvent) => unknown) | null = null
  onupgradeneeded: ((event: IDBVersionChangeEvent) => unknown) | null = null
}

class MemoryDatabase {
  readonly objectStoreNames: Pick<DOMStringList, 'contains'> = {
    contains: (name: string) => this.state.stores.has(name)
  }

  constructor(private readonly state: MemoryDatabaseState) {}

  createObjectStore(name: string): IDBObjectStore {
    if (!this.state.stores.has(name)) this.state.stores.set(name, new Map())
    return new MemoryObjectStore(this.state.stores.get(name)!) as unknown as IDBObjectStore
  }

  transaction(storeNames: string | string[], _mode?: IDBTransactionMode): IDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames]
    return new MemoryTransaction(this.state, names) as unknown as IDBTransaction
  }

  close(): void {}
}

class MemoryTransaction {
  error: DOMException | null = null
  oncomplete: ((event: Event) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
  onabort: ((event: Event) => unknown) | null = null
  private pending = 0
  private completeQueued = false

  constructor(
    private readonly state: MemoryDatabaseState,
    private readonly storeNames: readonly string[],
  ) {}

  objectStore(name: string): IDBObjectStore {
    if (!this.storeNames.includes(name)) throw new Error(`Object store ${name} is not in transaction`)
    const store = this.state.stores.get(name)
    if (store === undefined) throw new Error(`Object store ${name} does not exist`)
    return new MemoryObjectStore(store, this) as unknown as IDBObjectStore
  }

  abort(): void {
    this.onabort?.(new Event('abort'))
  }

  track(requestWork: () => unknown): MemoryRequest {
    this.pending += 1
    const request = new MemoryRequest()
    queueMicrotask(() => {
      try {
        request.result = requestWork()
        request.onsuccess?.(new Event('success'))
      } catch (error) {
        request.error = error instanceof DOMException ? error : new DOMException('IndexedDB request failed')
        request.onerror?.(new Event('error'))
        this.onerror?.(new Event('error'))
      } finally {
        this.pending -= 1
        this.queueComplete()
      }
    })
    return request
  }

  private queueComplete(): void {
    if (this.pending > 0 || this.completeQueued) return
    this.completeQueued = true
    setTimeout(() => {
      this.completeQueued = false
      if (this.pending === 0) this.oncomplete?.(new Event('complete'))
    }, 0)
  }
}

class MemoryObjectStore {
  constructor(
    private readonly records: Map<IDBValidKey, unknown>,
    private readonly transaction?: MemoryTransaction,
  ) {}

  get(key: IDBValidKey): IDBRequest<unknown> {
    return this.request(() => structuredClone(this.records.get(key)))
  }

  put(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    return this.request(() => {
      if (key === undefined) throw new Error('Memory IndexedDB object store requires explicit keys')
      this.records.set(key, structuredClone(value))
      return key
    })
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.request(() => {
      this.records.delete(key)
      return undefined
    })
  }

  private request<T>(work: () => T): IDBRequest<T> {
    if (this.transaction !== undefined) return this.transaction.track(work) as unknown as IDBRequest<T>
    const request = new MemoryRequest()
    queueMicrotask(() => {
      request.result = work()
      request.onsuccess?.(new Event('success'))
    })
    return request as unknown as IDBRequest<T>
  }
}

class MemoryRequest {
  result: unknown
  error: DOMException | null = null
  onsuccess: ((event: Event) => unknown) | null = null
  onerror: ((event: Event) => unknown) | null = null
}

export async function deleteMemoryDatabase(indexedDB: MemoryIndexedDbFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Memory IndexedDB delete failed'))
  })
}

export function deriveTestBrowserEnvelopeCryptoDatabaseName(origin: string, localNodeId: string): string {
  return `aurora-local-data-envelope-${stableHash(`${canonicalOrigin(origin)}\u0000${localNodeId}`)}`
}

function canonicalOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  } catch {
    return origin
  }
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, '0')
}
