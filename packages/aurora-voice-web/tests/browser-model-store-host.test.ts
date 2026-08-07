import { describe, expect, it } from 'vitest'
import {
  AuroraBrowserModelStoreError,
  AuroraBrowserModelStoreHost,
  IndexedDbBrowserModelStorePort,
  createBrowserModelStorePort,
  type AuroraBrowserModelStorePort,
  type AuroraBrowserModelStoreSnapshot,
  type AuroraBrowserStoreBackendKind,
  type AuroraBrowserStorageEstimate
} from '../src/browser-model-store-host.js'

class FakeBrowserPort implements AuroraBrowserModelStorePort {
  snapshot: AuroraBrowserModelStoreSnapshot | null = null
  readonly blobs = new Map<string, Uint8Array>()
  estimate: AuroraBrowserStorageEstimate = { quota: 10_000, usage: 0, persisted: true }
  appendCalls = 0
  copyCalls = 0
  fullReadCalls = 0
  rangeReadCalls = 0
  writeCalls = 0

  constructor(readonly kind: AuroraBrowserStoreBackendKind = 'indexeddb') {}

  async storageEstimate(): Promise<AuroraBrowserStorageEstimate> {
    const usage = [...this.blobs.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
    return { ...this.estimate, usage: this.estimate.usage ?? usage }
  }

  async readSnapshot(): Promise<AuroraBrowserModelStoreSnapshot | null> {
    return this.snapshot === null ? null : cloneSnapshot(this.snapshot)
  }

  async writeSnapshot(snapshot: AuroraBrowserModelStoreSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot)
  }

  async readBlob(physicalKey: string): Promise<Uint8Array | null> {
    this.fullReadCalls += 1
    const bytes = this.blobs.get(physicalKey)
    return bytes ? new Uint8Array(bytes) : null
  }

  async statBlob(physicalKey: string): Promise<number | null> {
    return this.blobs.get(physicalKey)?.byteLength ?? null
  }

  async writeBlob(physicalKey: string, bytes: Uint8Array): Promise<void> {
    this.writeCalls += 1
    this.blobs.set(physicalKey, new Uint8Array(bytes))
  }

  async appendBlob(physicalKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    this.appendCalls += 1
    const current = this.blobs.get(physicalKey) ?? new Uint8Array()
    if (current.byteLength !== offset) throw new Error('append_offset')
    const next = new Uint8Array(current.byteLength + bytes.byteLength)
    next.set(current, 0)
    next.set(bytes, current.byteLength)
    this.blobs.set(physicalKey, next)
  }

  async readBlobChunk(physicalKey: string, offset: number, maxBytes: number): Promise<Uint8Array | null> {
    this.rangeReadCalls += 1
    const bytes = this.blobs.get(physicalKey)
    return bytes ? bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes)) : null
  }

  async copyBlob(fromPhysicalKey: string, toPhysicalKey: string, expectedBytes: number): Promise<void> {
    this.copyCalls += 1
    const bytes = this.blobs.get(fromPhysicalKey)
    if (!bytes || bytes.byteLength !== expectedBytes) throw new Error('corrupt')
    this.blobs.set(toPhysicalKey, new Uint8Array(bytes))
  }

  async deleteBlob(physicalKey: string): Promise<void> {
    this.blobs.delete(physicalKey)
  }

  async listBlobKeys(): Promise<readonly string[]> {
    return [...this.blobs.keys()].sort()
  }
}

class UnavailablePort extends FakeBrowserPort {
  override async storageEstimate(): Promise<AuroraBrowserStorageEstimate> {
    throw new Error('private mode raw failure')
  }
}

describe('AuroraBrowserModelStoreHost', () => {
  it('prefers real OPFS calls when safely available and falls back to IndexedDB', async () => {
    const opfsRoot = new FakeOpfsDirectory()
    const opfs = await createBrowserModelStorePort({
      isSecureContext: true,
      navigator: {
        storage: {
          getDirectory: async () => opfsRoot,
          estimate: async () => ({ quota: 10_000, usage: 0 }),
          persisted: async () => true
        }
      },
      indexedDB: fakeIndexedDb(),
      crypto
    })
    expect(opfs.kind).toBe('opfs')
    const host = new AuroraBrowserModelStoreHost(opfs)
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2]))
    expect(opfsRoot.directoryCalls).toContain('blobs')
    expect(opfsRoot.fileCalls).toContain('aurora.voice.web.model-store.snapshot.v1')

    const idb = await createBrowserModelStorePort({
      isSecureContext: false,
      indexedDB: fakeIndexedDb()
    })
    expect(idb.kind).toBe('indexeddb')
  })

  it('falls back to IndexedDB when OPFS open fails', async () => {
    const port = await createBrowserModelStorePort({
      isSecureContext: true,
      navigator: {
        storage: {
          getDirectory: async () => {
            throw new DOMException('blocked', 'SecurityError')
          }
        }
      },
      indexedDB: fakeIndexedDb(),
      crypto
    })
    expect(port.kind).toBe('indexeddb')
  })

  it('propagates OPFS transient reads instead of treating them as missing files', async () => {
    const root = new FakeOpfsDirectory()
    const port = await createBrowserModelStorePort({
      isSecureContext: true,
      navigator: {
        storage: {
          getDirectory: async () => root,
          estimate: async () => ({ quota: 10_000, usage: 0 }),
          persisted: async () => true
        }
      },
      crypto
    })
    const host = new AuroraBrowserModelStoreHost(port)
    await host.appendStaging('pack@file', 0, new Uint8Array([1]))
    await host.promoteStagingAtomic('pack@file')
    const blobs = root.directories.get('blobs')
    if (!blobs) throw new Error('missing blobs dir')
    blobs.transientReadFailure = true
    await expect(host.promotedStat('pack@file')).rejects.toMatchObject({ code: 'storage' })
    blobs.transientReadFailure = false
    await expect(host.promotedStat('pack@file')).resolves.toEqual({ byteLength: 1, sha256: null })
  })

  it('fails closed when browser storage is unavailable or private', async () => {
    await expect(createBrowserModelStorePort({ isSecureContext: false })).rejects.toMatchObject({
      code: 'unavailable'
    })
    const host = new AuroraBrowserModelStoreHost(new UnavailablePort())
    await expect(host.persistenceReport()).resolves.toEqual({
      available: false,
      persistent: false,
      quotaBytes: null,
      usedBytes: 0
    })
  })

  it('writes JSON transactionally and returns deterministic prefixed lists', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await host.writeJson('pack.b@meta', '{"b":true}')
    await host.writeJson('pack.a@meta', '{"a":true}')
    await host.writeJson('other@meta', '{}')

    await expect(host.readJson('pack.a@meta')).resolves.toBe('{"a":true}')
    await expect(host.listJsonKeys('pack.')).resolves.toEqual(['pack.a@meta', 'pack.b@meta'])
  })

  it('checks internal quota before allocating staging bytes', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port, { maxTotalBytes: 4, maxChunkBytes: 8 })
    const chunk = new Uint8Array([1, 2, 3, 4, 5])
    await expect(host.appendStaging('pack@file', 0, chunk)).rejects.toMatchObject({ code: 'quota' })
    expect(port.blobs.size).toBe(0)
  })

  it('checks reported browser quota before writing bytes', async () => {
    const port = new FakeBrowserPort()
    port.estimate = { quota: 4, usage: 4, persisted: true }
    const host = new AuroraBrowserModelStoreHost(port, { maxTotalBytes: 100, maxChunkBytes: 8 })
    await expect(host.appendStaging('pack@file', 0, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'quota'
    })
    expect(port.writeCalls).toBe(0)
    expect(port.appendCalls).toBe(0)
    expect(port.blobs.size).toBe(0)
  })

  it('requires exact append offsets', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2]))
    await expect(host.appendStaging('pack@file', 1, new Uint8Array([3]))).rejects.toMatchObject({
      code: 'append_offset'
    })
    await expect(host.stagingLen('pack@file')).resolves.toBe(2)
  })

  it('appends and reads chunks through bounded port operations', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2]))
    await host.appendStaging('pack@file', 2, new Uint8Array([3, 4]))
    expect(port.appendCalls).toBe(2)
    expect(port.fullReadCalls).toBe(0)
    await expect(host.readStagingChunk('pack@file', 1, 2)).resolves.toEqual({
      bytes: new Uint8Array([2, 3]),
      offset: 1,
      complete: false
    })
    expect(port.rangeReadCalls).toBe(1)
    expect(port.fullReadCalls).toBe(0)
  })

  it('uses opaque WebCrypto SHA-256 physical names for distinct writes', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.writeJson('pack-a@meta', '{}')
    await host.writeJson('pack-a@meta', '{"updated":true}')
    const keys = await port.listBlobKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^aurora-json-[a-f0-9]{64}$/)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).not.toContain('pack-a')
  })

  it('survives interrupted JSON replacement for same and different sizes', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.writeJson('pack@meta', 'one')
    const first = (await port.readSnapshot())?.json[0]
    if (!first) throw new Error('missing json')
    await host.writeJson('pack@meta', 'two')
    await expect(host.readJson('pack@meta')).resolves.toBe('two')
    expect(port.blobs.has(first.physicalKey)).toBe(false)
    const second = (await port.readSnapshot())?.json[0]
    if (!second) throw new Error('missing replacement')
    port.blobs.set(first.physicalKey, new Uint8Array([111, 108, 100]))
    port.snapshot = { ...(await port.readSnapshot())!, json: [first] }
    await expect(new AuroraBrowserModelStoreHost(port).readJson('pack@meta')).resolves.toBe('old')
    port.snapshot = { ...(await port.readSnapshot())!, json: [second] }
    await host.writeJson('pack@meta', 'different-size')
    await expect(host.readJson('pack@meta')).resolves.toBe('different-size')
  })

  it('keeps partial promotion invisible and recovers interrupted commits', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2, 3]))

    const snapshot = await port.readSnapshot()
    expect(snapshot?.staging).toHaveLength(1)
    const staging = snapshot?.staging[0]
    if (!staging) throw new Error('missing staging')
    port.snapshot = {
      ...snapshot,
      journal: {
        key: 'pack@file',
        stagingPhysicalKey: staging.physicalKey,
        promotedPhysicalKey: 'aurora-promoted-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        byteLength: 3,
        phase: 'staging'
      }
    }
    await expect(host.promotedStat('pack@file')).resolves.toBeNull()

    port.blobs.set('aurora-promoted-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', new Uint8Array([1, 2, 3]))
    const recovered = new AuroraBrowserModelStoreHost(port)
    await expect(recovered.promotedStat('pack@file')).resolves.toEqual({ byteLength: 3, sha256: null })
    await expect(recovered.listPromotedKeys()).resolves.toEqual(['pack@file'])
  })

  it('replacement promotion remaps to the new staged blob instead of old same-size bytes', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 1, 1]))
    await host.promoteStagingAtomic('pack@file')
    const oldEntry = (await port.readSnapshot())?.promoted[0]
    if (!oldEntry) throw new Error('missing old')
    await host.appendStaging('pack@file', 0, new Uint8Array([2, 2, 2]))
    const newStaging = (await port.readSnapshot())?.staging[0]
    if (!newStaging) throw new Error('missing new')
    await host.promoteStagingAtomic('pack@file')
    const promoted = (await port.readSnapshot())?.promoted[0]
    expect(promoted?.physicalKey).toBe(newStaging.physicalKey)
    expect(promoted?.physicalKey).not.toBe(oldEntry.physicalKey)
    await expect(host.readPromotedChunk('pack@file', 0, 8)).resolves.toEqual({
      bytes: new Uint8Array([2, 2, 2]),
      offset: 0,
      complete: true
    })
    expect(port.blobs.has(oldEntry.physicalKey)).toBe(false)
    expect(port.copyCalls).toBe(0)
  })

  it('retries promotion recovery after transient storage failure', async () => {
    const port = new FlakyRecoveryPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2, 3]))
    await host.promoteStagingAtomic('pack@file')
    const snapshot = await port.readSnapshot()
    const promoted = snapshot?.promoted[0]
    if (!promoted) throw new Error('missing promoted')
    port.snapshot = {
      ...snapshot,
      staging: [{ key: 'pack@file', physicalKey: 'aurora-staging-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', byteLength: 3, packId: 'pack' }],
      promoted: [],
      journal: {
        key: 'pack@file',
        stagingPhysicalKey: 'aurora-staging-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        promotedPhysicalKey: promoted.physicalKey,
        byteLength: 3,
        phase: 'committed'
      }
    }
    port.failNextRead = true
    await expect(new AuroraBrowserModelStoreHost(port).promotedStat('pack@file')).rejects.toMatchObject({
      code: 'storage'
    })
    await expect(new AuroraBrowserModelStoreHost(port).promotedStat('pack@file')).resolves.toEqual({
      byteLength: 3,
      sha256: null
    })
  })

  it('surfaces referenced missing JSON and promoted blobs as redacted eviction', async () => {
    const port = new FakeBrowserPort()
    const host = new AuroraBrowserModelStoreHost(port)
    await host.writeJson('pack@meta', '{}')
    const jsonEntry = (await port.readSnapshot())?.json[0]
    if (!jsonEntry) throw new Error('missing json')
    port.blobs.delete(jsonEntry.physicalKey)
    await expect(host.readJson('pack@meta')).rejects.toMatchObject({ code: 'evicted' })

    await host.appendStaging('pack@file', 0, new Uint8Array([1]))
    await host.promoteStagingAtomic('pack@file')
    const promoted = (await port.readSnapshot())?.promoted[0]
    if (!promoted) throw new Error('missing promoted')
    port.blobs.delete(promoted.physicalKey)
    await expect(host.promotedStat('pack@file')).rejects.toMatchObject({ code: 'evicted' })
  })

  it('stores IndexedDB binary data as Uint8Array and chunk records, not Blob values', async () => {
    const indexedDB = new FakeIndexedDb()
    const port = new IndexedDbBrowserModelStorePort({
      indexedDB: indexedDB.factory(),
      navigator: { storage: { estimate: async () => ({ quota: 10_000, usage: 0 }) } }
    })
    const key = 'aurora-promoted-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await port.writeBlob(key, new Uint8Array([1, 2]))
    expect(indexedDB.store('blobs').get(key)).toBeInstanceOf(Uint8Array)
    await port.deleteBlob(key)
    await port.appendBlob(key, 0, new Uint8Array([3, 4]))
    await port.appendBlob(key, 2, new Uint8Array([5]))
    const record = indexedDB.store('blobs').get(key)
    expect(record).toMatchObject({ kind: 'aurora-chunked-v1', byteLength: 3 })
    expect(record).not.toBeInstanceOf(Blob)
    expect(indexedDB.store('blobs').get(`${key}.chunk.0`)).toBeInstanceOf(Uint8Array)
    expect(indexedDB.store('blobs').get(`${key}.chunk.1`)).toBeInstanceOf(Uint8Array)
    await expect(port.readBlobChunk(key, 1, 2)).resolves.toEqual(new Uint8Array([4, 5]))
    await expect(port.statBlob(key)).resolves.toBe(3)
    const copyKey = 'aurora-promoted-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    await port.copyBlob(key, copyKey, 3)
    await port.deleteBlob(copyKey)
    await expect(port.readBlob(key)).resolves.toEqual(new Uint8Array([3, 4, 5]))
  })

  it('reads legacy IndexedDB Blob records and rejects corrupt chunk records', async () => {
    const indexedDB = new FakeIndexedDb()
    const key = 'aurora-promoted-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    indexedDB.store('blobs').set(key, new Blob([new Uint8Array([7, 8, 9])]))
    const port = new IndexedDbBrowserModelStorePort({ indexedDB: indexedDB.factory() })
    await expect(port.readBlob(key)).resolves.toEqual(new Uint8Array([7, 8, 9]))
    await expect(port.readBlobChunk(key, 1, 4)).resolves.toEqual(new Uint8Array([8, 9]))
    await expect(port.statBlob(key)).resolves.toBe(3)

    const corruptKey = 'aurora-promoted-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    indexedDB.store('blobs').set(corruptKey, {
      kind: 'aurora-chunked-v1',
      byteLength: 1,
      chunks: [`${corruptKey}.chunk.0`]
    })
    await expect(port.readBlob(corruptKey)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('returns exact chunk EOF semantics for staging and promoted data', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await host.appendStaging('pack@file', 0, new Uint8Array([1, 2, 3, 4]))
    await expect(host.readStagingChunk('pack@file', 1, 2)).resolves.toEqual({
      bytes: new Uint8Array([2, 3]),
      offset: 1,
      complete: false
    })
    await expect(host.readStagingChunk('pack@file', 4, 2)).resolves.toEqual({
      bytes: new Uint8Array(),
      offset: 4,
      complete: true
    })
    await host.promoteStagingAtomic('pack@file')
    await expect(host.readPromotedChunk('pack@file', 2, 8)).resolves.toEqual({
      bytes: new Uint8Array([3, 4]),
      offset: 2,
      complete: true
    })
  })

  it('lists promoted keys deterministically and removes only one pack scope', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await host.appendStaging('pack-b@file', 0, new Uint8Array([2]))
    await host.promoteStagingAtomic('pack-b@file')
    await host.appendStaging('pack-a@file', 0, new Uint8Array([1]))
    await host.promoteStagingAtomic('pack-a@file')
    await host.appendStaging('pack-a@other', 0, new Uint8Array([3]))

    await expect(host.listPromotedKeys()).resolves.toEqual(['pack-a@file', 'pack-b@file'])
    await host.removePackData('pack-a')
    await expect(host.listPromotedKeys()).resolves.toEqual(['pack-b@file'])
    await expect(host.stagingLen('pack-a@other')).resolves.toBe(0)
  })

  it('rejects traversal-like keys and makes delete idempotent', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await expect(host.writeJson('../secret', '{}')).rejects.toMatchObject({ code: 'key' })
    await expect(host.appendStaging('pack/path', 0, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'key'
    })
    await expect(host.deleteJson('missing@key')).resolves.toBeUndefined()
    await expect(host.deletePromoted('missing@key')).resolves.toBeUndefined()
  })

  it('serializes redacted errors without raw bytes keys or storage names', async () => {
    const host = new AuroraBrowserModelStoreHost(new FakeBrowserPort())
    await host.appendStaging('sensitive-pack@voice.bin', 0, new Uint8Array([9, 8, 7]))
    const error = await host
      .appendStaging('sensitive-pack@voice.bin', 99, new Uint8Array([6]))
      .then(
        () => null,
        (caught: unknown) => caught
      )
    expect(error).toBeInstanceOf(AuroraBrowserModelStoreError)
    const serialized = JSON.stringify({ name: (error as Error).name, message: (error as Error).message, code: (error as AuroraBrowserModelStoreError).code })
    expect(serialized).toContain('append_offset')
    expect(serialized).not.toContain('sensitive-pack')
    expect(serialized).not.toContain('voice.bin')
    expect(serialized).not.toContain('9')
    expect(serialized).not.toContain('aurora-')
  })
})

function cloneSnapshot(snapshot: AuroraBrowserModelStoreSnapshot): AuroraBrowserModelStoreSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as AuroraBrowserModelStoreSnapshot
}

function fakeIndexedDb(): IDBFactory {
  return {
    open: () => {
      throw new Error('not used by selection tests')
    }
  } as unknown as IDBFactory
}

class FakeIndexedDb {
  readonly stores = new Map<string, Map<string, unknown>>()

  factory(): IDBFactory {
    return {
      open: (_name: string, _version?: number) => this.open()
    } as unknown as IDBFactory
  }

  store(name: string): Map<string, unknown> {
    let store = this.stores.get(name)
    if (!store) {
      store = new Map<string, unknown>()
      this.stores.set(name, store)
    }
    return store
  }

  private open(): IDBOpenDBRequest {
    const request: Partial<IDBOpenDBRequest> = {}
    const db = new FakeIdbDatabase(this)
    Object.defineProperty(request, 'result', { value: db })
    queueMicrotask(() => {
      request.onupgradeneeded?.call(request as IDBOpenDBRequest, {} as IDBVersionChangeEvent)
      request.onsuccess?.call(request as IDBOpenDBRequest, {} as Event)
    })
    return request as IDBOpenDBRequest
  }
}

class FakeIdbDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.owner.stores.has(name)
  } as DOMStringList

  constructor(private readonly owner: FakeIndexedDb) {}

  createObjectStore(name: string): void {
    this.owner.store(name)
  }

  transaction(storeName: string): IDBTransaction {
    return new FakeIdbTransaction(this.owner.store(storeName)) as unknown as IDBTransaction
  }
}

class FakeIdbTransaction {
  oncomplete: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(private readonly values: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return new FakeIdbObjectStore(this.values, this) as unknown as IDBObjectStore
  }
}

class FakeIdbObjectStore {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly transaction: FakeIdbTransaction
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request: Partial<IDBRequest> = {}
    Object.defineProperty(request, 'result', { get: () => this.values.get(String(key)) })
    queueMicrotask(() => request.onsuccess?.call(request as IDBRequest, {} as Event))
    return request as IDBRequest
  }

  put(value: unknown, key?: IDBValidKey): IDBRequest {
    if (key === undefined) throw new Error('key required')
    this.values.set(String(key), value)
    queueMicrotask(() => this.transaction.oncomplete?.({} as Event))
    return {} as IDBRequest
  }

  delete(key: IDBValidKey): IDBRequest {
    this.values.delete(String(key))
    queueMicrotask(() => this.transaction.oncomplete?.({} as Event))
    return {} as IDBRequest
  }

  getAllKeys(): IDBRequest {
    const request: Partial<IDBRequest> = {}
    Object.defineProperty(request, 'result', { value: [...this.values.keys()] })
    queueMicrotask(() => request.onsuccess?.call(request as IDBRequest, {} as Event))
    return request as IDBRequest
  }
}

class FlakyRecoveryPort extends FakeBrowserPort {
  failNextRead = false

  override async readBlob(physicalKey: string): Promise<Uint8Array | null> {
    if (this.failNextRead) {
      this.failNextRead = false
      throw new Error(`raw ${physicalKey}`)
    }
    return super.readBlob(physicalKey)
  }
}

class FakeOpfsDirectory {
  readonly files = new Map<string, Uint8Array>()
  readonly directories = new Map<string, FakeOpfsDirectory>()
  readonly fileCalls: string[] = []
  readonly directoryCalls: string[] = []
  transientReadFailure = false

  async getDirectoryHandle(name: string, _options?: { create?: boolean }): Promise<FakeOpfsDirectory> {
    this.directoryCalls.push(name)
    let directory = this.directories.get(name)
    if (!directory) {
      directory = new FakeOpfsDirectory()
      this.directories.set(name, directory)
    }
    return directory
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeOpfsFileHandle> {
    this.fileCalls.push(name)
    if (!this.files.has(name)) {
      if (options?.create !== true) throw new DOMException('not found', 'NotFoundError')
      this.files.set(name, new Uint8Array())
    }
    return new FakeOpfsFileHandle(this.files, name, this)
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.has(name) && !this.directories.has(name)) throw new DOMException('not found', 'NotFoundError')
    this.files.delete(name)
    this.directories.delete(name)
  }

  async *keys(): AsyncIterable<string> {
    for (const key of this.files.keys()) yield key
  }
}

class FakeOpfsFileHandle {
  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly name: string,
    private readonly owner: FakeOpfsDirectory
  ) {}

  async getFile(): Promise<Blob> {
    if (this.owner.transientReadFailure) throw new Error('permission denied /tmp/raw-path')
    return new Blob([this.files.get(this.name) ?? new Uint8Array()])
  }

  async createWritable(_options?: { keepExistingData?: boolean }): Promise<FakeOpfsWritable> {
    return new FakeOpfsWritable(this.files, this.name)
  }
}

class FakeOpfsWritable {
  private bytes: Uint8Array

  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly name: string
  ) {
    this.bytes = new Uint8Array(files.get(name) ?? new Uint8Array())
  }

  async write(data: BufferSource | Blob | string | { type: 'write'; position: number; data: BufferSource }): Promise<void> {
    if (isWriteCommand(data)) {
      const chunk = bytesFromBufferSource(data.data)
      const next = new Uint8Array(Math.max(this.bytes.byteLength, data.position + chunk.byteLength))
      next.set(this.bytes, 0)
      next.set(chunk, data.position)
      this.bytes = next
      return
    }
    const chunk = bytesFromBufferSource(data as BufferSource)
    this.bytes = new Uint8Array(chunk)
  }

  async truncate(size: number): Promise<void> {
    this.bytes = this.bytes.slice(0, size)
  }

  async close(): Promise<void> {
    this.files.set(this.name, new Uint8Array(this.bytes))
  }
}

function isWriteCommand(data: unknown): data is { type: 'write'; position: number; data: BufferSource } {
  return typeof data === 'object' && data !== null && 'type' in data && (data as { type?: unknown }).type === 'write'
}

function bytesFromBufferSource(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
}
