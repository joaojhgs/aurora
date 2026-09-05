// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import {
  MemoryLocalDataBackend,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type LightweightMemoryRecord,
  type LocalDataBackend,
  type LocalDataBackendStatus,
  type LocalDataExportV1,
  type LocalDataImportResult,
  type LocalDataRecordCollections,
  type LocalDataRepositories,
  type LocalDataSession
} from '@aurora/client/local-data'

import { buildMemoryViewModel, MemoryView } from '../memory-view.js'
import { buildShellSnapshot, type RouteAvailability } from '../shell-data.js'
import { findForbiddenProductionCopyTerms } from '../product-copy-forbidden-terms.js'
import { BrowserIndexedDbLocalDataBackend } from './browser-indexeddb.js'
import { FakeWebLocks, MapBrowserLocalDataDocumentStore } from './__tests__/local-data-test-helpers.js'
import { LocalDataProvider, useLocalData } from './local-data-provider.js'
import { describeBrowserStorageHealth } from './storage-health.js'
import { LocalDataMemoryPanel, StorageHealthView, type StorageHealthProductError } from './storage-health-view.js'
import { useLightweightMemory, type UseLightweightMemoryResult } from './use-lightweight-memory.js'
import { useLocalConversations, type UseLocalConversationsResult } from './use-local-conversations.js'

describe('LocalDataProvider', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('opens exact profile and local-node scope, switches safely, and ignores stale opens after unmount', async () => {
    const first = new DelayedBackend()
    const second = new DelayedBackend()
    const backends = [first, second]
    const factory = vi.fn((_profileId: string, _localNodeId: string) => backends.shift() ?? second)
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(
        <LocalDataProvider profileId="profile-1" localNodeId="node-1" backendFactory={factory}>
          <ProviderProbe />
        </LocalDataProvider>
      )
    })
    await act(async () => {
      root.render(
        <LocalDataProvider profileId="profile-2" localNodeId="node-2" backendFactory={factory}>
          <ProviderProbe />
        </LocalDataProvider>
      )
    })
    await act(async () => {
      second.resolveOpen()
      await flushReactWork()
    })

    expect(container.textContent).toContain('ready:profile-2:node-2')
    expect(container.textContent).not.toContain('profile-1')

    await act(async () => {
      root.unmount()
      first.resolveOpen()
      await flushReactWork()
    })

    expect(first.closeCount).toBeGreaterThan(0)
    expect(second.closeCount).toBeGreaterThan(0)
  })
})

describe('local conversation and lightweight memory hooks', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads stable local conversation order, supports archive/delete, and rejects cross-scope writes', async () => {
    const store = new MapBrowserLocalDataDocumentStore()
    await seedLocalData(store, async (session) => {
      await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-z', updatedAtMs: 900 }))
      await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-a', updatedAtMs: 1_000 }))
      await session.conversations.appendMessage(messageFixture({ id: 'message-later', conversationId: 'conversation-a', sequence: 2 }))
      await session.conversations.appendMessage(messageFixture({ id: 'message-earlier', conversationId: 'conversation-a', sequence: 1 }))
      await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-archived', updatedAtMs: 1_100, archivedAtMs: 1_100 }))
    })
    const { container, root } = mountedRoot()
    let latest: UseLocalConversationsResult | null = null

    await act(async () => {
      root.render(
        <LocalDataProvider profileId="profile-1" localNodeId="node-1" backendFactory={persistentBackendFactory(store)}>
          <ConversationsProbe onChange={(value) => { latest = value }} />
        </LocalDataProvider>
      )
      await flushReactWork()
    })

    await waitForText(container, 'conversation-a|conversation-z')
    expect(container.textContent).toContain('message-earlier,message-later')
    expect(container.textContent).not.toContain('conversation-archived')

    await act(async () => {
      await latest?.archiveConversation('conversation-a', 1_200)
      await flushReactWork()
    })
    expect(container.textContent).not.toContain('conversation-a')

    await act(async () => {
      await latest?.deleteConversation('conversation-z')
      await flushReactWork()
    })
    expect(container.textContent).not.toContain('conversation-z')

    await act(async () => {
      await latest?.upsertConversation(conversationFixture({ id: 'conversation-remote', profileId: 'profile-remote' }))
      await flushReactWork()
    })
    expect(container.textContent).toContain('Your existing local data was not changed. Try again.')

    root.unmount()
  })

  it('loads local memory by provenance, excludes expired entries, cleans up by bound, and searches scoped metadata', async () => {
    const store = new MapBrowserLocalDataDocumentStore()
    await seedLocalData(store, async (session) => {
      await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-live', namespace: 'notes', updatedAtMs: 1_000, expiresAtMs: null }))
      await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-old-a', namespace: 'notes', updatedAtMs: 800, expiresAtMs: 900 }))
      await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-old-b', namespace: 'notes', updatedAtMs: 700, expiresAtMs: 900 }))
    })
    const { container, root } = mountedRoot()
    let latest: UseLightweightMemoryResult | null = null
    let deleted = -1

    await act(async () => {
      root.render(
        <LocalDataProvider profileId="profile-1" localNodeId="node-1" backendFactory={persistentBackendFactory(store)}>
          <MemoryProbe onChange={(value) => { latest = value }} />
        </LocalDataProvider>
      )
      await flushReactWork()
    })

    await waitForText(container, 'memory-live')
    expect(container.textContent).not.toContain('memory-old-a')

    await act(async () => {
      deleted = await latest?.cleanupExpired(1_000, 1) ?? -1
      await latest?.search('notes')
      await flushReactWork()
    })

    expect(deleted).toBe(1)
    expect(container.textContent).toContain('search:1')
    expect(container.textContent).toContain('memory-live')
    root.unmount()
  })
})

describe('local data product UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders storage states with product-safe copy across surface profiles', () => {
    const backend = {
      kind: 'indexeddb' as const,
      persistent: true,
      sqlite: false,
      profileId: 'profile-1',
      schemaVersion: 3,
      migrationState: 'idle' as const
    }
    const states = [
      describeBrowserStorageHealth({ backend, ownerAvailable: true, internalState: 'ready_persistent' }),
      describeBrowserStorageHealth({ backend: { ...backend, persistent: false, kind: 'memory' as const }, ownerAvailable: true, internalState: 'ready_memory' }),
      describeBrowserStorageHealth({ backend, ownerAvailable: false, internalState: 'owner_blocked' }),
      describeBrowserStorageHealth({ backend, ownerAvailable: true, internalState: 'needs_attention' })
    ]

    for (const profile of ['web', 'desktop', 'android', 'ios']) {
      const text = visibleText(renderToStaticMarkup(
        <div aria-label={profile}>
          {states.map((health) => <StorageHealthView key={`${profile}-${health.outcome}-${health.internalState}`} health={health} />)}
        </div>
      ))
      expect(text).toContain('Saved on this device')
      expect(text).toContain('Temporary session')
      expect(text).toContain('Local features are already active in another Aurora window')
      expect(text).toContain('Your existing local data was not changed. Try again.')
      expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
      expect(text).not.toContain('[object Object]')
    }
  })

  it('does not render raw storage error text even when a caller bypasses the structured boundary', () => {
    const health = describeBrowserStorageHealth({
      backend: {
        kind: 'indexeddb',
        persistent: true,
        sqlite: false,
        profileId: 'profile-1',
        schemaVersion: 3,
        migrationState: 'failed'
      },
      ownerAvailable: true,
      internalState: 'needs_attention'
    })
    const raw = 'schema migration fallback IndexedDB backend failed'
    const text = visibleText(renderToStaticMarkup(
      <StorageHealthView health={health} error={raw as unknown as StorageHealthProductError} />
    ))

    expect(text).toContain('Your existing local data was not changed. Try again.')
    expect(text).not.toContain(raw)
    expect(text).not.toContain('schema')
    expect(text).not.toContain('migration')
    expect(text).not.toContain('fallback')
    expect(text).not.toContain('IndexedDB')
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })

  it('adds a This device panel to Memory without replacing connected-device history', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const route = await enabledRoute(client, 'memory')
    const remoteModel = await buildMemoryViewModel(client, route)
    const store = new MapBrowserLocalDataDocumentStore()
    await seedLocalData(store, async (session) => {
      await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-local', updatedAtMs: 1_000 }))
      await session.conversations.appendMessage(messageFixture({ id: 'message-local', conversationId: 'conversation-local', sequence: 1 }))
      await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-local', namespace: 'notes' }))
    })
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(
        <LocalDataProvider profileId="profile-1" localNodeId="node-1" backendFactory={persistentBackendFactory(store)}>
          <MemoryView client={client} route={route} initialModel={remoteModel} />
        </LocalDataProvider>
      )
      await flushReactWork()
    })

    await waitForText(container, 'This device')
    expect(container.textContent).toContain('Connected Aurora device')
    expect(container.textContent).toContain('Conversation Local')
    expect(container.textContent).toContain('Memory on this device')
    expect(container.textContent).not.toContain('[object Object]')
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '').map((term) => term.id)).toEqual([])
    root.unmount()
  })
})

function ProviderProbe() {
  const localData = useLocalData()
  return <div>{localData.state}:{localData.profileId}:{localData.localNodeId}:{localData.storageHealth.product.title}</div>
}

function ConversationsProbe({ onChange }: { readonly onChange: (value: UseLocalConversationsResult) => void }) {
  const conversations = useLocalConversations()
  useEffect(() => onChange(conversations), [conversations, onChange])
  const ids = conversations.summaries.map((summary) => summary.record.id).join('|')
  const first = conversations.selectedConversationId
  const messages = first ? conversations.messagesByConversation.get(first)?.map((message) => message.id).join(',') : ''
  return <div>{conversations.error ?? ids}:{messages}</div>
}

function MemoryProbe({ onChange }: { readonly onChange: (value: UseLightweightMemoryResult) => void }) {
  const memory = useLightweightMemory({ nowMs: 1_000 })
  useEffect(() => onChange(memory), [memory, onChange])
  return <div>{memory.error ?? memory.items.map((item) => item.record.id).join('|')}:search:{memory.lastSearch?.summary.resultCount ?? 0}</div>
}

function mountedRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  return { container, root: createRoot(container) }
}

async function flushReactWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (container.textContent?.includes(text)) return
    await act(async () => {
      await flushReactWork()
    })
  }
  throw new Error(`Timed out waiting for ${text}; saw ${container.textContent ?? ''}`)
}

function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

async function enabledRoute(client: Aurora, id: string): Promise<RouteAvailability> {
  const snapshot = await buildShellSnapshot(client)
  const route = snapshot.routes.find((candidate) => candidate.item.id === id)
  if (!route) throw new Error(`missing route ${id}`)
  return {
    ...route,
    state: 'available-local',
    disabled: false,
    providerLabel: 'This device',
    blockers: [],
    routeable: true
  }
}

function persistentBackendFactory(store: MapBrowserLocalDataDocumentStore) {
  const locks = new FakeWebLocks()
  return () => new BrowserIndexedDbLocalDataBackend({
    documentStore: store,
    locks
  })
}

async function seedLocalData(
  store: MapBrowserLocalDataDocumentStore,
  seed: (session: LocalDataSession) => Promise<void>,
): Promise<void> {
  const backend = persistentBackendFactory(store)()
  const session = await backend.open('profile-1', 'node-1')
  await seed(session)
  await backend.close()
}

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1
})

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    titleEnvelope: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    archivedAtMs: null,
    ...overrides
  }
}

function messageFixture(overrides: Partial<ConversationMessageRecord> = {}): ConversationMessageRecord {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    sequence: 0,
    role: 'assistant',
    contentEnvelope: null,
    toolEnvelope: null,
    status: 'complete',
    createdAtMs: 3,
    ...overrides
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
    createdAtMs: 4,
    updatedAtMs: 5,
    expiresAtMs: null,
    ...overrides
  }
}

class DelayedBackend implements LocalDataBackend {
  readonly kind = 'memory' as const
  readonly persistent = false
  readonly sqlite = false
  private readonly inner = new MemoryLocalDataBackend()
  private readonly openPromise: Promise<void>
  private resolveOpenPromise: () => void = () => undefined
  closeCount = 0

  constructor() {
    this.openPromise = new Promise((resolve) => {
      this.resolveOpenPromise = resolve
    })
  }

  resolveOpen(): void {
    this.resolveOpenPromise()
  }

  async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
    await this.openPromise
    return await this.inner.open(profileId, localNodeId)
  }

  async status(): Promise<LocalDataBackendStatus> {
    return await this.inner.status()
  }

  async close(): Promise<void> {
    this.closeCount += 1
    await this.inner.close().catch(() => undefined)
  }
}

class UnusedSession implements LocalDataSession {
  readonly profileId = 'unused'
  readonly localNodeId = 'unused'
  readonly schemaVersion = 0
  readonly conversations: LocalDataRepositories['conversations'] = {
    upsertConversation: async () => undefined,
    appendMessage: async () => undefined,
    deleteConversation: async () => ({ deleted: false, deletedMessages: 0 }),
    listConversations: async () => [],
    listMessageCounts: async () => ({}),
    listFirstUserMessages: async () => ({}),
    listMessages: async () => []
  }
  readonly memory: LocalDataRepositories['memory'] = {
    upsertMemoryItem: async () => undefined,
    deleteMemoryItem: async () => ({ deleted: false }),
    deleteExpiredMemoryItems: async (_scope, _nowMs, _limit) => ({ deleted: 0 }),
    listMemoryItems: async () => []
  }
  readonly localTools: LocalDataRepositories['localTools'] = {
    upsertLocalToolState: async () => undefined,
    listLocalToolStates: async () => []
  }
  readonly peerGrants: LocalDataRepositories['peerGrants'] = {
    upsertPeerGrant: async () => undefined,
    listPeerGrants: async () => []
  }
  readonly localAudit: LocalDataRepositories['localAudit'] = {
    appendAudit: async () => undefined,
    listAudit: async () => []
  }
  async transaction<T>(work: (repositories: LocalDataRepositories) => Promise<T>): Promise<T> {
    return await work(this)
  }
  async exportV1(): Promise<LocalDataExportV1> {
    throw new Error('unused')
  }
  async importV1(_document: LocalDataExportV1): Promise<LocalDataImportResult> {
    throw new Error('unused')
  }
  async close(): Promise<void> {}
}

void UnusedSession
