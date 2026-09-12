import { describe, expect, it, vi } from 'vitest'
import {
  localDataMigrationManifest,
  MemoryLocalDataBackend,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataSession
} from '@aurora/client/local-data'

import { createLocalDataBackend } from './create-local-data-backend'
import { LocalStorageBrowserLocalDataBackendPointerStore, type BrowserLocalDataBackendPointer, type BrowserLocalDataBackendPointerStore } from './browser-backend-transfer'
import type { BrowserSqliteOwnership, BrowserSqliteOwnershipLock } from './browser-sqlite-opfs'
import type { BrowserSqliteProtocolWorker } from './browser-sqlite-worker-client'
import type { BrowserSqliteWorkerRequest, BrowserSqliteWorkerResponse } from './browser-sqlite-worker'

describe('createLocalDataBackend pointer selection', () => {
  it('opens the committed IndexedDB pointer without probing SQLite', async () => {
    const health: unknown[] = []
    const indexedDbBackend = new KindOverrideBackend('indexeddb')
    const backend = await createLocalDataBackend('profile-1', 'node-1', {
      pointerStore: new MapPointerStore(pointer('indexeddb')),
      indexedDbBackend,
      lock: new ThrowIfUsedLock(),
      onStorageHealth: (status) => health.push(status)
    })

    expect(backend).toBe(indexedDbBackend)
    expect(health).toEqual([{
      selectedBackend: 'indexeddb',
      sqliteAttempted: false,
      sqliteAvailable: false,
      fallbackReason: null
    }])
  })

  it('fails closed when a committed SQLite pointer cannot reopen and does not fall back to IndexedDB', async () => {
    installBrowserStorageProbe()
    const health: unknown[] = []
    const indexedDbBackend = new KindOverrideBackend('indexeddb')

    await expect(createLocalDataBackend('profile-1', 'node-1', {
      pointerStore: new MapPointerStore(pointer('sqlite-wasm-opfs')),
      indexedDbBackend,
      lock: new DeniedLock(),
      createWorker: () => new NoopWorker(),
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm',
      onStorageHealth: (status) => health.push(status)
    })).rejects.toMatchObject({
      code: 'unsupported_backend',
      metadata: { reason: 'unsupported_backend' }
    })
    expect(indexedDbBackend.openCount).toBe(0)
    expect(health).toEqual([{
      selectedBackend: 'sqlite-wasm-opfs',
      sqliteAttempted: true,
      sqliteAvailable: false,
      fallbackReason: 'committed_backend_open_failed'
    }])
  })

  it('fails closed on a present invalid pointer without probing, fallback, or rewrite', async () => {
    const storage = new MapStorage()
    const rawPointer = JSON.stringify({ ...pointer('indexeddb'), selectedBackend: 'memory' })
    storage.setItem('factory.pointer:profile-1:node-1', rawPointer)
    const indexedDbBackend = new KindOverrideBackend('indexeddb')

    await expect(createLocalDataBackend('profile-1', 'node-1', {
      pointerStore: new LocalStorageBrowserLocalDataBackendPointerStore({ storage, keyPrefix: 'factory.pointer' }),
      indexedDbBackend,
      lock: new ThrowIfUsedLock()
    })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'pointer_backend' }
    })
    expect(indexedDbBackend.openCount).toBe(0)
    expect(storage.getItem('factory.pointer:profile-1:node-1')).toBe(rawPointer)
  })

  it('does not fallback or write a pointer when uncommitted SQLite open hits local-node ownership rejection', async () => {
    installBrowserStorageProbe()
    const pointerStore = new CountingPointerStore(null)
    const indexedDbBackend = new KindOverrideBackend('indexeddb')

    await expect(createLocalDataBackend('profile-1', 'node-1', {
      pointerStore,
      indexedDbBackend,
      lock: new GrantedLock(),
      createWorker: () => new ErrorOpenWorker('identity_mismatch', 'local_node_owner_mismatch'),
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })).rejects.toMatchObject({
      code: 'identity_mismatch',
      metadata: { reason: 'local_node_owner_mismatch' }
    })
    expect(indexedDbBackend.openCount).toBe(0)
    expect(pointerStore.writes).toBe(0)
  })

  it('does not fallback or rewrite a committed pointer when SQLite open hits ownership integrity rejection', async () => {
    installBrowserStorageProbe()
    const pointerStore = new CountingPointerStore(pointer('sqlite-wasm-opfs'))
    const indexedDbBackend = new KindOverrideBackend('indexeddb')

    await expect(createLocalDataBackend('profile-1', 'node-1', {
      pointerStore,
      indexedDbBackend,
      lock: new GrantedLock(),
      createWorker: () => new ErrorOpenWorker('migration_integrity', 'local_node_owner_ambiguous'),
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })).rejects.toMatchObject({
      code: 'migration_integrity',
      metadata: { reason: 'local_node_owner_ambiguous' }
    })
    expect(indexedDbBackend.openCount).toBe(0)
    expect(pointerStore.writes).toBe(0)
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'sqlite-wasm-opfs' })
  })

  it.each([
    ['migration_integrity', 'migration_sql_checksum'],
    ['migration_integrity', 'ledger_user_version_mismatch'],
    ['migration_order', 'migration_sequence_gap']
  ])('fails closed on uncommitted SQLite %s:%s without opening IndexedDB or writing a pointer', async (code, reason) => {
    installBrowserStorageProbe()
    const pointerStore = new CountingPointerStore(null)
    const indexedDbBackend = new KindOverrideBackend('indexeddb')

    await expect(createLocalDataBackend('profile-1', 'node-1', {
      pointerStore,
      indexedDbBackend,
      lock: new GrantedLock(),
      createWorker: () => new ErrorOpenWorker(code, reason),
      wasmAssetUrl: 'http://127.0.0.1/sqlite3.wasm'
    })).rejects.toMatchObject({
      code,
      metadata: { reason }
    })
    expect(indexedDbBackend.openCount).toBe(0)
    expect(pointerStore.writes).toBe(0)
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toBeNull()
  })
})

class KindOverrideBackend implements LocalDataBackend {
  readonly persistent = true
  readonly sqlite: boolean
  private readonly inner = new MemoryLocalDataBackend()
  openCount = 0

  constructor(readonly kind: 'indexeddb') {
    this.sqlite = false
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    this.openCount += 1
    return await this.inner.open(profileId, localNodeId)
  }

  async status(): Promise<LocalDataBackendStatus> {
    const status = await this.inner.status()
    return { ...status, kind: this.kind, persistent: true, sqlite: this.sqlite }
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}

class MapPointerStore implements BrowserLocalDataBackendPointerStore {
  constructor(private readonly current: BrowserLocalDataBackendPointer | null) {}

  async read(profileId: string, localNodeId: string): Promise<BrowserLocalDataBackendPointer | null> {
    if (this.current?.profileId !== profileId || this.current.localNodeId !== localNodeId) return null
    return this.current
  }

  async write(): Promise<void> {
    throw new Error('write not expected')
  }
}

class CountingPointerStore implements BrowserLocalDataBackendPointerStore {
  writes = 0

  constructor(private current: BrowserLocalDataBackendPointer | null) {}

  async read(profileId: string, localNodeId: string): Promise<BrowserLocalDataBackendPointer | null> {
    if (this.current?.profileId !== profileId || this.current.localNodeId !== localNodeId) return null
    return this.current
  }

  async write(pointerValue: BrowserLocalDataBackendPointer): Promise<void> {
    this.writes += 1
    this.current = pointerValue
  }
}

class ThrowIfUsedLock implements BrowserSqliteOwnershipLock {
  async acquire(): Promise<BrowserSqliteOwnership> {
    throw new Error('SQLite should not be probed')
  }
}

class DeniedLock implements BrowserSqliteOwnershipLock {
  async acquire(): Promise<BrowserSqliteOwnership> {
    throw new Error('busy')
  }
}

class GrantedLock implements BrowserSqliteOwnershipLock {
  async acquire(key: string): Promise<BrowserSqliteOwnership> {
    return { key, ownerId: 'owner-1', release: async () => undefined }
  }
}

class NoopWorker implements BrowserSqliteProtocolWorker {
  onmessage: ((event: MessageEvent<BrowserSqliteWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage(message: BrowserSqliteWorkerRequest): void {
    this.onmessage?.({
      data: {
        id: message.id,
        result: {
          ok: false,
          error: {
            code: 'unsupported_backend',
            message: 'not available'
          }
        }
      }
    } as MessageEvent<BrowserSqliteWorkerResponse>)
  }

  terminate(): void {}
}

class ErrorOpenWorker implements BrowserSqliteProtocolWorker {
  onmessage: ((event: MessageEvent<BrowserSqliteWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(private readonly code: string, private readonly reason: string) {}

  postMessage(message: BrowserSqliteWorkerRequest): void {
    this.onmessage?.({
      data: {
        id: message.id,
        result: {
          ok: false,
          error: {
            code: this.code,
            message: 'ownership rejected',
            metadata: { reason: this.reason }
          }
        }
      }
    } as MessageEvent<BrowserSqliteWorkerResponse>)
  }

  terminate(): void {}
}

class MapStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserStorageProbe(): void {
  vi.stubGlobal('location', {
    href: 'http://127.0.0.1/',
    origin: 'http://127.0.0.1'
  })
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({}),
      persist: async () => true
    }
  })
}

function pointer(selectedBackend: 'indexeddb' | 'sqlite-wasm-opfs'): BrowserLocalDataBackendPointer {
  return {
    version: 1,
    profileId: 'profile-1',
    localNodeId: 'node-1',
    schemaVersion: localDataMigrationManifest.latestVersion,
    selectedBackend,
    committedAtMs: 1000
  }
}
