import { describe, expect, it, vi } from 'vitest'
import {
  LocalDataError,
  MemoryLocalDataBackend,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataSession
} from '@aurora/client/local-data'

import { createLocalDataBackend } from './create-local-data-backend'
import type { BrowserLocalDataBackendPointer, BrowserLocalDataBackendPointerStore } from './browser-backend-transfer'
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
    selectedBackend,
    committedAtMs: 1000
  }
}
