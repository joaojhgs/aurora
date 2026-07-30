// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import {
  MemoryLocalDataBackend,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type LightweightMemoryRecord,
  type LocalDataSession,
} from '@aurora/client/local-data'
import {
  buildShellSnapshot,
  type AuroraShellSnapshot,
  type RouteAvailability,
} from '@aurora/ui'

import type { AuroraBrowserRuntime } from '../aurora-client'
import { BrowserShellRuntimeProvider } from '../browser-shell-runtime'
import { MemoryClientPage } from './memory-client'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('MemoryClientPage local data wiring', () => {
  it('renders the This device panel from the browser runtime local-data services', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await enabledMemorySnapshot(client)
    const route = memoryRoute(snapshot)
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await seedLocalData(session)
    const runtime = browserRuntime(client, {
      localData: {
        backend,
        session,
        crypto: {
          encrypt: vi.fn(),
          decrypt: vi.fn(),
          rotateKey: vi.fn(),
        },
      },
      localNodeProviderStatus: {
        available: true,
        state: 'available',
        productMessage: 'This device is available for sharing.',
        registeredFeatureCount: 1,
        localDataWritable: true,
      },
    })
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider runtime={runtime} snapshot={snapshot}>
          <MemoryClientPage route={route} />
        </BrowserShellRuntimeProvider>,
      )
      await flushReactWork()
    })

    await waitForText(container, 'Memory on this device')
    expect(container.textContent).toContain('This device')
    expect(container.textContent).toContain('Conversation Local')
    expect(container.textContent).toContain('Collections from Connected Aurora device')
    expect(container.textContent).not.toContain('[object Object]')
    expect(renderedForbiddenCopy(container.textContent ?? '')).toEqual([])
  })

  it.each([
    ['remote-console', 'not-configured'] as const,
    ['second-tab', 'open-in-another-tab'] as const,
  ])('omits the local panel safely for %s browser state', async (_name, state) => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })
    const snapshot = await enabledMemorySnapshot(client)
    const route = memoryRoute(snapshot)
    const runtime = browserRuntime(client, {
      localNodeProviderStatus: {
        available: false,
        state,
        productMessage: state === 'open-in-another-tab'
          ? 'This device is already available from another open tab.'
          : 'This device is not set up for sharing.',
        registeredFeatureCount: 0,
        localDataWritable: false,
      },
    })
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider runtime={runtime} snapshot={snapshot}>
          <MemoryClientPage route={route} />
        </BrowserShellRuntimeProvider>,
      )
      await flushReactWork()
    })

    await waitForText(container, 'Memory & Knowledge')
    expect(container.textContent).not.toContain('Memory on this device')
    expect(container.textContent).not.toContain('Conversations on this device')
    expect(container.textContent).toContain('Collections from Connected Aurora device')
    expect(renderedForbiddenCopy(container.textContent ?? '')).toEqual([])
  })

  it('uses the hosted browser runtime context instead of a separate memory provider wrapper', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'memory-client.tsx'), 'utf8')

    expect(source).toContain('useBrowserShellRuntime')
    expect(source).toContain('runtime.localData')
    expect(source).toContain('LocalDataProvider')
    expect(source).not.toContain('createAuroraBrowserClient')
    expect(source).not.toMatch(/Test[A-Za-z]*LocalDataProvider/u)
  })
})

async function enabledMemorySnapshot(client: AuroraClient): Promise<AuroraShellSnapshot> {
  const snapshot = await buildShellSnapshot(client)
  return {
    ...snapshot,
    routes: snapshot.routes.map((route) => route.item.id === 'memory'
      ? {
          ...route,
          state: 'available-local',
          disabled: false,
          providerLabel: 'This device',
          blockers: [],
          routeable: true,
        }
      : route),
  }
}

function memoryRoute(snapshot: AuroraShellSnapshot): RouteAvailability {
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'memory')
  if (!route) throw new Error('missing memory route')
  return route
}

function browserRuntime(
  client: AuroraClient,
  overrides: Partial<AuroraBrowserRuntime> = {},
): AuroraBrowserRuntime {
  return {
    client,
    mode: 'http-only',
    runtimeMode: 'web-thin',
    demoMode: false,
    features: {
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
    },
    peer: {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ status: 'disabled' })),
      subscribe: vi.fn(() => () => undefined),
      importInvite: vi.fn(async () => undefined),
      approveSas: vi.fn(async () => undefined),
      rejectSas: vi.fn(async () => undefined),
      clearPersistedProfile: vi.fn(),
    },
    close: vi.fn(async () => undefined),
    localNodeProviderStatus: {
      available: false,
      state: 'not-configured',
      productMessage: 'This device is not set up for sharing.',
      registeredFeatureCount: 0,
      localDataWritable: false,
    },
    ...overrides,
  } as unknown as AuroraBrowserRuntime
}

function mountedRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  return { container, root }
}

async function flushReactWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (container.textContent?.includes(text)) return
    await act(async () => {
      await flushReactWork()
    })
  }
  throw new Error(`Timed out waiting for ${text}; saw ${container.textContent ?? ''}`)
}

async function seedLocalData(session: LocalDataSession): Promise<void> {
  await session.conversations.upsertConversation(conversationFixture({
    id: 'conversation-local',
    updatedAtMs: 1_000,
  }))
  await session.conversations.appendMessage(messageFixture({
    id: 'message-local',
    conversationId: 'conversation-local',
    sequence: 1,
  }))
  await session.memory.upsertMemoryItem(memoryFixture({
    id: 'memory-local',
    namespace: 'notes',
  }))
}

function conversationFixture(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conversation-1',
    profileId: 'profile-1',
    localNodeId: 'node-1',
    titleEnvelope: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    archivedAtMs: null,
    ...overrides,
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
    ...overrides,
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
    ...overrides,
  }
}

const envelopeFixture: EncryptedDataEnvelopeV1 = Object.freeze({
  version: 1,
  algorithm: 'AES-GCM-256',
  keyId: 'key-1',
  nonceB64Url: 'AAAAAAAAAAAAAAAA',
  ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
  createdAtMs: 1,
})

function renderedForbiddenCopy(value: string): string[] {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  const terms: Array<[string, RegExp]> = [
    ['proof', /\bproof\b/iu],
    ['evidence', /\bevidence\b/iu],
    ['fixture', /\bfixtures?\b/iu],
    ['implementation', /\bimplement(?:ation|ed|ing)?\b/iu],
    ['tested', /\btested\b/iu],
    ['debug', /\bdebug(?:ging)?\b/iu],
    ['fallback', /\bfall[-_]?back\b/iu],
    ['provider-consumer-role', /\b(?:provider|consumer|hybrid)\b/iu],
    ['manifest', /\bmanifest\b/iu],
    ['contract', /\bcontracts?\b/iu],
    ['protocol', /\bprotocol\b/iu],
    ['transport', /\btransport\b/iu],
    ['runtime', /\bruntime\b/iu],
    ['schema', /\bschema\b/iu],
    ['migration', /\bmigrations?\b/iu],
    ['sqlite', /\bsqlite\b/iu],
    ['indexeddb', /\bindexeddb\b/iu],
    ['opfs', /\bopfs\b/iu],
    ['sidecar', /\bsidecar\b/iu],
    ['thin', /\bthin\b/iu],
    ['http', /\bhttps?\b/iu],
    ['webrtc-wss', /\b(?:webrtc|wss?)\b/iu],
  ]
  return terms.flatMap(([id, pattern]) => pattern.test(normalized) ? [id] : [])
}
