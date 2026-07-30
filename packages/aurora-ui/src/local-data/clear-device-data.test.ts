import { describe, expect, it } from 'vitest'
import {
  localDataMigrationManifest,
} from '@aurora/client/local-data'

import {
  IndexedDbBrowserVaultStorage,
  type BrowserWebRtcCredentialStore,
} from '../browser-peer-persistence'
import { BROWSER_PEER_VAULT_DATABASE_NAME } from '../browser-peer-persistence-keys'
import {
  BrowserEnvelopeCryptoPort,
  deriveBrowserEnvelopeCryptoDatabaseName,
} from './browser-envelope-crypto'
import {
  IndexedDbBrowserLocalDataDocumentStore,
  deriveBrowserLocalDataDatabaseName,
} from './browser-indexeddb'
import { deriveBrowserSqliteStorageIdentity } from './browser-sqlite-opfs'
import {
  IndexedDbBrowserStorageLeaseStore,
  deriveBrowserStorageOwnerKey,
} from './browser-storage-lock'
import { LocalStorageBrowserLocalDataBackendPointerStore } from './browser-backend-transfer'
import { clearBrowserDeviceData } from './clear-device-data'
import { MemoryIndexedDbFactory } from './__tests__/browser-envelope-crypto-test-helpers'

const origin = 'https://aurora.example.test/app'
const canonicalOrigin = 'https://aurora.example.test'
const profileId = 'profile-clear'
const localNodeId = 'node-clear'

describe('clearBrowserDeviceData', () => {
  it('closes active handles and deletes only Aurora-owned browser data for the scoped device', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const metadataStorage = new MapStorage()
    const opfs = new FakeOpfsRoot()
    const storageIdentity = deriveBrowserSqliteStorageIdentity(localNodeId)
    opfs.ensureDirectory(['aurora', 'nodes', storageIdentity.browserStorageIdentity])

    await seedLocalDataDocument(indexedDB)
    const envelope = await seedEnvelopeKey(indexedDB)
    await seedPeerVault(indexedDB)
    await seedStorageLease(indexedDB)
    const pointerStore = new LocalStorageBrowserLocalDataBackendPointerStore({ storage: metadataStorage })
    await pointerStore.write({
      version: 1,
      profileId,
      localNodeId,
      schemaVersion: localDataMigrationManifest.latestVersion,
      selectedBackend: 'indexeddb',
      committedAtMs: 1_000,
    })
    metadataStorage.setItem('aurora.webThin.profile.v1', '{"mode":"webrtc-only"}')
    metadataStorage.setItem('third.party.preference', 'kept')
    await createUnrelatedDatabase(indexedDB)
    const peerState = { cleared: false, closed: false }
    const peerStore = {
      clear: async () => { peerState.cleared = true },
      close: async () => { peerState.closed = true },
    } as unknown as BrowserWebRtcCredentialStore

    const result = await clearBrowserDeviceData({
      profileId,
      localNodeId,
      origin,
      indexedDB: indexedDB as unknown as IDBFactory,
      metadataStorage,
      storageManager: opfs.storageManager,
      peerStore,
      pointerStore,
    })

    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.steps.map((step) => step.step)).toEqual([
      'active-handles',
      'peer-profile',
      'backend-pointer',
      'storage-lock',
      'envelope-key-vault',
      'local-data-indexeddb',
      'peer-vault',
      'local-data-opfs',
    ])
    expect(peerState.cleared).toBe(true)
    expect(peerState.closed).toBe(true)
    expect(indexedDB.databases.has(deriveBrowserEnvelopeCryptoDatabaseName(canonicalOrigin, localNodeId))).toBe(false)
    expect(indexedDB.databases.has(deriveBrowserLocalDataDatabaseName(canonicalOrigin, localNodeId))).toBe(false)
    expect(indexedDB.databases.has(BROWSER_PEER_VAULT_DATABASE_NAME)).toBe(false)
    expect(indexedDB.databases.has('third-party-owned-db')).toBe(true)
    expect(metadataStorage.getItem('aurora.localData.backendPointer:profile-clear:node-clear')).toBeNull()
    expect(metadataStorage.getItem('aurora.webThin.profile.v1')).toBeNull()
    expect(metadataStorage.getItem('third.party.preference')).toBe('kept')
    expect(opfs.removedPaths).toEqual([`aurora/nodes/${storageIdentity.browserStorageIdentity}`])

    const reopened = new BrowserEnvelopeCryptoPort({
      origin: canonicalOrigin,
      profileId,
      localNodeId,
      indexedDB: indexedDB as unknown as IDBFactory,
      crypto: globalThis.crypto,
      nowMs: () => 2_000,
    })
    await expect(reopened.decrypt(envelope, new TextEncoder().encode('aad'))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'missing_key' },
    })
    await reopened.close()
  })

  it('reports failed storage deletion structurally and never returns success on partial cleanup', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const metadataStorage = new MapStorage()
    await seedLocalDataDocument(indexedDB)
    await seedEnvelopeKey(indexedDB)
    const envelopeDatabaseName = deriveBrowserEnvelopeCryptoDatabaseName(canonicalOrigin, localNodeId)
    indexedDB.failDeleteDatabaseNames.set(envelopeDatabaseName, new Error('delete denied'))

    const result = await clearBrowserDeviceData({
      profileId,
      localNodeId,
      origin,
      indexedDB: indexedDB as unknown as IDBFactory,
      metadataStorage,
      storageManager: new FakeOpfsRoot().storageManager,
      pointerStore: null,
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([
      expect.objectContaining({
        step: 'backend-pointer',
        ok: false,
        reason: 'backend pointer store unavailable',
      }),
      expect.objectContaining({
        step: 'envelope-key-vault',
        ok: false,
        target: envelopeDatabaseName,
        reason: 'delete denied',
      }),
    ])
    expect(indexedDB.databases.has(envelopeDatabaseName)).toBe(true)
  })
})

async function seedLocalDataDocument(indexedDB: MemoryIndexedDbFactory): Promise<void> {
  const store = new IndexedDbBrowserLocalDataDocumentStore({
    indexedDB: indexedDB as unknown as IDBFactory,
    databaseName: deriveBrowserLocalDataDatabaseName(canonicalOrigin, localNodeId),
  })
  await store.save({
    formatVersion: 1,
    profileId,
    localNodeId,
    schemaVersion: localDataMigrationManifest.latestVersion,
    migrationLedger: localDataMigrationManifest.migrations.map((migration) => ({
      version: migration.version,
      checksum: migration.checksum,
    })),
    records: {
      conversations: [],
      messages: [],
      memoryItems: [],
      localToolStates: [],
      peerGrantMetadata: [],
      localAudit: [],
    },
  })
  await store.close()
}

async function seedEnvelopeKey(indexedDB: MemoryIndexedDbFactory) {
  const port = new BrowserEnvelopeCryptoPort({
    origin: canonicalOrigin,
    profileId,
    localNodeId,
    indexedDB: indexedDB as unknown as IDBFactory,
    crypto: globalThis.crypto,
    nowMs: () => 1_000,
  })
  const envelope = await port.encrypt('local-structured-data', new TextEncoder().encode('secret'), new TextEncoder().encode('aad'))
  await port.close()
  return envelope
}

async function seedPeerVault(indexedDB: MemoryIndexedDbFactory): Promise<void> {
  const storage = new IndexedDbBrowserVaultStorage({
    indexedDB: indexedDB as unknown as IDBFactory,
    databaseName: BROWSER_PEER_VAULT_DATABASE_NAME,
  })
  await storage.set('credential:peer-1', { redacted: true })
  await storage.close()
}

async function seedStorageLease(indexedDB: MemoryIndexedDbFactory): Promise<void> {
  const leaseStore = new IndexedDbBrowserStorageLeaseStore({ indexedDB: indexedDB as unknown as IDBFactory })
  await leaseStore.compareAndSet(deriveBrowserStorageOwnerKey(canonicalOrigin, localNodeId), null, {
    lockKey: deriveBrowserStorageOwnerKey(canonicalOrigin, localNodeId),
    ownerId: 'owner-1',
    expiresAtMs: 9_999,
  })
  await leaseStore.close()
}

async function createUnrelatedDatabase(indexedDB: MemoryIndexedDbFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('third-party-owned-db', 1)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error ?? new Error('unrelated db open failed'))
  })
}

class MapStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class FakeOpfsRoot {
  readonly removedPaths: string[] = []
  readonly root = new FakeDirectory('', '', this.removedPaths)
  readonly storageManager = {
    getDirectory: async () => this.root,
  }

  ensureDirectory(path: readonly string[]): void {
    let current = this.root
    for (const segment of path) current = current.ensure(segment)
  }
}

class FakeDirectory {
  private readonly children = new Map<string, FakeDirectory>()

  constructor(
    private readonly name = '',
    private readonly parentPath = '',
    private readonly removedPaths: string[] | null = null,
  ) {}

  ensure(name: string): FakeDirectory {
    let child = this.children.get(name)
    if (child === undefined) {
      child = new FakeDirectory(name, this.path(), this.removedPaths)
      this.children.set(name, child)
    }
    return child
  }

  async getDirectoryHandle(name: string): Promise<FakeDirectory> {
    const child = this.children.get(name)
    if (child === undefined) throw new DOMException('missing directory', 'NotFoundError')
    return child
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException('missing directory', 'NotFoundError')
    this.removedPaths?.push(this.path(name))
  }

  private path(childName?: string): string {
    const current = this.parentPath.length === 0 ? this.name : `${this.parentPath}/${this.name}`
    if (childName === undefined) return current
    return current.length === 0 ? childName : `${current}/${childName}`
  }
}
