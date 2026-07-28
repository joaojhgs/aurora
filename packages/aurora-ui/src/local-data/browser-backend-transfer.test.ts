import { describe, expect, it } from 'vitest'
import {
  buildLocalDataExportV1,
  MemoryLocalDataBackend,
  LocalDataError,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type LightweightMemoryRecord,
  type LocalDataBackend,
  type LocalDataBackendKind,
  type LocalDataBackendStatus,
  type LocalDataExportV1,
  type LocalDataImportResult,
  type LocalDataRepositories,
  type LocalDataSession
} from '@aurora/client/local-data'

import {
  LocalStorageBrowserLocalDataBackendPointerStore,
  transferBrowserLocalDataBackend,
  type BrowserLocalDataBackendPointer,
  type BrowserLocalDataBackendPointerStore,
  type BrowserTransferableBackendKind
} from './browser-backend-transfer'

describe('browser backend transfer', () => {
  it('commits a copied IndexedDB source to SQLite only after close, reopen, and export comparison', async () => {
    const pointerStore = new MapPointerStore()
    const source = new DurableFakeBackend('indexeddb')
    const targetState = new DurableState()
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.conversations.upsertConversation(conversationFixture())
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    const result = await transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs', targetState),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs', targetState),
      pointerStore,
      nowMs: () => 2000
    })

    expect(result.committedBackend).toBe('sqlite-wasm-opfs')
    expect(result.recordCounts).toMatchObject({ conversations: 1, memoryItems: 1 })
    expect(await pointerStore.read('profile-1', 'node-1')).toMatchObject({
      selectedBackend: 'sqlite-wasm-opfs',
      committedAtMs: 2000
    })
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
  })

  it('commits a copied SQLite source to IndexedDB and retains the source', async () => {
    const pointerStore = new MapPointerStore()
    const source = new DurableFakeBackend('sqlite-wasm-opfs')
    const targetState = new DurableState()
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture({ id: 'memory-sqlite' }))

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('indexeddb', targetState),
      reopenTargetBackend: () => new DurableFakeBackend('indexeddb', targetState),
      pointerStore
    })).resolves.toMatchObject({ committedBackend: 'indexeddb' })

    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-sqlite' })])
  })

  it('rejects tampered source exports before import and leaves the pointer unchanged', async () => {
    const pointerStore = new MapPointerStore(pointer('indexeddb'))
    const source = new DurableFakeBackend('indexeddb', undefined, { tamperExportCounts: true })
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs'),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs'),
      pointerStore
    })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'record_count_mismatch' }
    })
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'indexeddb' })
  })

  it('rejects wrong identity exports without mutating pointer or source', async () => {
    const pointerStore = new MapPointerStore(pointer('indexeddb'))
    const source = new DurableFakeBackend('indexeddb', undefined, { exportProfileId: 'profile-2' })
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs'),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs'),
      pointerStore
    })).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'indexeddb' })
  })

  it('keeps the pointer unchanged when target import fails after a partial write', async () => {
    const pointerStore = new MapPointerStore(pointer('indexeddb'))
    const source = new DurableFakeBackend('indexeddb')
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs', undefined, { failAfterImport: true }),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs'),
      pointerStore
    })).rejects.toMatchObject({
      code: 'migration_integrity',
      metadata: { reason: 'partial_import' }
    })
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'indexeddb' })
  })

  it('keeps source and pointer when the reopened target export does not match', async () => {
    const pointerStore = new MapPointerStore(pointer('indexeddb'))
    const source = new DurableFakeBackend('indexeddb')
    const targetState = new DurableState()
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs', targetState),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs', targetState, { tamperExportRecords: true }),
      pointerStore
    })).rejects.toMatchObject({
      code: 'migration_integrity',
      metadata: { reason: 'reopen_export_mismatch' }
    })
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'indexeddb' })
  })

  it('keeps source and pointer when pointer commit fails after target verification', async () => {
    const pointerStore = new MapPointerStore(pointer('indexeddb'))
    pointerStore.failWrites = true
    const source = new DurableFakeBackend('indexeddb')
    const targetState = new DurableState()
    const sourceSession = await source.open('profile-1', 'node-1')
    await sourceSession.memory.upsertMemoryItem(memoryFixture())

    await expect(transferBrowserLocalDataBackend({
      profileId: 'profile-1',
      localNodeId: 'node-1',
      sourceBackend: source,
      targetBackend: new DurableFakeBackend('sqlite-wasm-opfs', targetState),
      reopenTargetBackend: () => new DurableFakeBackend('sqlite-wasm-opfs', targetState),
      pointerStore
    })).rejects.toThrow(/pointer write failed/u)
    await expect(sourceSession.memory.listMemoryItems()).resolves.toEqual([memoryFixture()])
    await expect(pointerStore.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'indexeddb' })
  })

  it('round trips pointer values through localStorage-compatible storage', async () => {
    const storage = new MapStorage()
    const store = new LocalStorageBrowserLocalDataBackendPointerStore({ storage, keyPrefix: 'test.pointer' })
    await store.write(pointer('sqlite-wasm-opfs'))

    await expect(store.read('profile-1', 'node-1')).resolves.toMatchObject({ selectedBackend: 'sqlite-wasm-opfs' })
    await expect(store.read('profile-2', 'node-1')).resolves.toBeNull()
  })
})

class DurableState {
  exportDocument: LocalDataExportV1 | null = null
}

class DurableFakeBackend implements LocalDataBackend {
  readonly persistent = true
  readonly sqlite: boolean
  private readonly state: DurableState
  private session: DurableFakeSession | null = null
  private closed = false

  constructor(
    readonly kind: BrowserTransferableBackendKind,
    state = new DurableState(),
    private readonly faults: {
      readonly tamperExportCounts?: boolean
      readonly tamperExportRecords?: boolean
      readonly exportProfileId?: string
      readonly failAfterImport?: boolean
    } = {}
  ) {
    this.sqlite = kind === 'sqlite-wasm-opfs'
    this.state = state
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    if (this.closed) throw new Error('backend closed')
    if (this.session !== null) return this.session
    const memory = new MemoryLocalDataBackend({ nowMs: () => 1000 })
    const session = await memory.open(profileId, localNodeId)
    if (this.state.exportDocument !== null) await session.importV1(this.state.exportDocument)
    this.session = new DurableFakeSession(this.kind, session, async () => {
      this.state.exportDocument = await exportAsKind(session, this.kind)
      await memory.close()
      this.session = null
    }, this.faults)
    return this.session
  }

  async status(): Promise<LocalDataBackendStatus> {
    return {
      kind: this.kind,
      persistent: true,
      sqlite: this.sqlite,
      profileId: this.session?.profileId ?? null,
      schemaVersion: this.session?.schemaVersion ?? null,
      migrationState: 'idle'
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.session?.close()
    this.session = null
  }
}

class DurableFakeSession implements LocalDataSession {
  readonly profileId: string
  readonly localNodeId: string
  readonly schemaVersion: number
  readonly conversations: LocalDataSession['conversations']
  readonly memory: LocalDataSession['memory']
  readonly localTools: LocalDataSession['localTools']
  readonly peerGrants: LocalDataSession['peerGrants']
  readonly localAudit: LocalDataSession['localAudit']

  constructor(
    private readonly kind: BrowserTransferableBackendKind,
    private readonly inner: LocalDataSession,
    private readonly closeInner: () => Promise<void>,
    private readonly faults: {
      readonly tamperExportCounts?: boolean
      readonly tamperExportRecords?: boolean
      readonly exportProfileId?: string
      readonly failAfterImport?: boolean
    }
  ) {
    this.profileId = inner.profileId
    this.localNodeId = inner.localNodeId
    this.schemaVersion = inner.schemaVersion
    this.conversations = inner.conversations
    this.memory = inner.memory
    this.localTools = inner.localTools
    this.peerGrants = inner.peerGrants
    this.localAudit = inner.localAudit
  }

  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    return await this.inner.transaction(work)
  }

  async exportV1(): Promise<LocalDataExportV1> {
    const exported = await exportAsKind(this.inner, this.kind)
    if (this.faults.exportProfileId !== undefined) {
      return buildLocalDataExportV1({
        sourceBackend: this.kind,
        schemaVersion: exported.schemaVersion,
        profileId: this.faults.exportProfileId,
        localNodeId: exported.localNodeId,
        exportedAtMs: exported.exportedAtMs,
        records: exported.records
      })
    }
    if (this.faults.tamperExportRecords === true) {
      return buildLocalDataExportV1({
        sourceBackend: this.kind,
        schemaVersion: exported.schemaVersion,
        profileId: exported.profileId,
        localNodeId: exported.localNodeId,
        exportedAtMs: exported.exportedAtMs,
        records: { ...exported.records, memoryItems: [] }
      })
    }
    if (this.faults.tamperExportCounts === true) {
      return {
        ...exported,
        recordCounts: { ...exported.recordCounts, memoryItems: exported.recordCounts.memoryItems + 1 }
      }
    }
    return exported
  }

  async importV1(document: LocalDataExportV1): Promise<LocalDataImportResult> {
    const result = await this.inner.importV1(document)
    if (this.faults.failAfterImport === true) {
      throw new LocalDataError('migration_integrity', 'Partial import failed', { reason: 'partial_import' })
    }
    return result
  }

  async close(): Promise<void> {
    await this.closeInner()
  }
}

async function exportAsKind(session: LocalDataSession, kind: LocalDataBackendKind): Promise<LocalDataExportV1> {
  const exported = await session.exportV1()
  return buildLocalDataExportV1({
    sourceBackend: kind,
    schemaVersion: exported.schemaVersion,
    profileId: exported.profileId,
    localNodeId: exported.localNodeId,
    exportedAtMs: exported.exportedAtMs,
    records: exported.records
  })
}

class MapPointerStore implements BrowserLocalDataBackendPointerStore {
  private current: BrowserLocalDataBackendPointer | null
  failWrites = false

  constructor(initial: BrowserLocalDataBackendPointer | null = null) {
    this.current = initial
  }

  async read(profileId: string, localNodeId: string): Promise<BrowserLocalDataBackendPointer | null> {
    if (this.current?.profileId !== profileId || this.current.localNodeId !== localNodeId) return null
    return this.current
  }

  async write(pointerValue: BrowserLocalDataBackendPointer): Promise<void> {
    if (this.failWrites) throw new Error('pointer write failed')
    this.current = pointerValue
  }
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

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-local-structured-data-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1000
})

function conversationFixture(): ConversationRecord {
  return {
    id: 'conversation-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    titleEnvelope: envelopeFixture,
    createdAtMs: 1000,
    updatedAtMs: 1100,
    archivedAtMs: null
  }
}

function memoryFixture(overrides: Partial<LightweightMemoryRecord> = {}): LightweightMemoryRecord {
  return {
    id: 'memory-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    namespace: 'notes',
    payloadEnvelope: envelopeFixture,
    sourceType: 'conversation',
    sourceId: 'conversation-1',
    createdAtMs: 1100,
    updatedAtMs: 1200,
    expiresAtMs: null,
    ...overrides
  }
}

function pointer(selectedBackend: BrowserTransferableBackendKind): BrowserLocalDataBackendPointer {
  return {
    version: 1,
    profileId: 'profile-1',
    localNodeId: 'node-1',
    selectedBackend,
    committedAtMs: 1000
  }
}
