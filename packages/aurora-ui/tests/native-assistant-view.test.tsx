// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  ORCHESTRATOR_METHODS,
  ORCHESTRATOR_MODEL_METHODS,
  modelRuntimeCatalogFixture,
  type AuroraEvent,
  type AuroraEventSubscription,
} from '@aurora/client'
import type {
  LightweightAssistantProvider,
  LightweightToolClientPort,
} from '@aurora/client/lightweight-orchestrator'
import {
  buildEnvelopeAad,
  MemoryLocalDataBackend,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LocalDataSession,
} from '@aurora/client/local-data'

import { AssistantView } from '../src/assistant-view'
import type { LightweightAssistantDependencies } from '../src/local-assistant/lightweight-assistant'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []
const scope = Object.freeze({ profileId: 'profile-native-assistant', localNodeId: 'node-native-assistant' })

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = () => undefined
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('mounted AssistantView native assistant events', () => {
  it('keeps a provisional native turn mounted when a later event assigns the real conversation', async () => {
    const events = new NativeAssistantEventHarness()
    const envelopeCrypto = new TestEnvelopeCryptoPort()
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await seedConversation(localData, envelopeCrypto, {
      conversationId: 'conversation-assigned',
      userId: 'native-user-assigned',
      assistantId: 'native-assistant-assigned',
      transcript: 'capture the assigned note',
      response: 'Final native assigned answer.',
      createdAtMs: 100,
    })
    const container = await renderNativeAssistant({ events, localData, envelopeCrypto })
    await events.waitForSubscription()

    await events.emit(nativeEvent('voice.turn.started', {
      generation: 41,
      requestId: 'request-provisional',
      transcript: 'capture the assigned note',
      status: 'requesting',
    }))
    await waitUntil(() => container.textContent?.includes('capture the assigned note') === true)

    await events.emit(nativeEvent('assistant.delta', {
      generation: 41,
      requestId: 'request-provisional',
      conversationId: 'conversation-assigned',
      transcript: 'capture the assigned note',
      accumulatedText: 'Draft native assigned answer',
      textDelta: 'Draft native assigned answer',
      status: 'speaking',
    }))
    await waitUntil(() => container.textContent?.includes('Draft native assigned answer') === true)

    await events.emit(nativeEvent('assistant.completed', {
      generation: 41,
      requestId: 'request-provisional',
      conversationId: 'conversation-assigned',
      transcript: 'capture the assigned note',
      assistantText: 'Final native assigned answer.',
      status: 'finalized',
      terminal: true,
      persisted: true,
    }))
    await waitUntil(() => container.textContent?.includes('Final native assigned answer.') === true)

    expect(container.querySelectorAll('[data-slot="message"][data-align="start"] [data-slot="bubble-content"] p')).toHaveLength(1)
    expect(container.textContent).toContain('capture the assigned note')
    expect(container.textContent).not.toContain('Draft native assigned answer')
    expect(activeConversationText(container)).toContain('capture the assigned note')
  })

  it('ignores native events for another selected conversation before changing messages or status copy', async () => {
    const events = new NativeAssistantEventHarness()
    const envelopeCrypto = new TestEnvelopeCryptoPort()
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await seedConversation(localData, envelopeCrypto, {
      conversationId: 'conversation-selected',
      userId: 'selected-user',
      assistantId: 'selected-assistant',
      transcript: 'selected prompt',
      response: 'Selected conversation answer.',
      createdAtMs: 200,
    })
    await seedConversation(localData, envelopeCrypto, {
      conversationId: 'conversation-other',
      userId: 'other-user',
      assistantId: 'other-assistant',
      transcript: 'other prompt',
      response: 'Other conversation saved answer.',
      createdAtMs: 100,
    })
    const container = await renderNativeAssistant({
      events,
      localData,
      envelopeCrypto,
      initialSessionId: 'conversation-selected',
    })
    await waitUntil(() => container.textContent?.includes('Selected conversation answer.') === true)
    await events.waitForSubscription()
    const beforeText = visibleConversationText(container)
    const beforeStatus = statusText(container)

    await events.emit(nativeEvent('assistant.delta', {
      generation: 42,
      requestId: 'request-other',
      conversationId: 'conversation-other',
      transcript: 'other prompt',
      textDelta: 'Background answer that should not mount',
      accumulatedText: 'Background answer that should not mount',
      status: 'speaking',
    }))
    await flushReactWork()

    expect(visibleConversationText(container)).toBe(beforeText)
    expect(statusText(container)).toBe(beforeStatus)
    expect(container.textContent).toContain('Selected conversation answer.')
    expect(container.textContent).not.toContain('Background answer that should not mount')
    expect(activeConversationText(container)).toContain('selected prompt')
  })
})

async function renderNativeAssistant({
  events,
  localData,
  envelopeCrypto,
  initialSessionId = null,
}: {
  events: NativeAssistantEventHarness
  localData: LocalDataSession
  envelopeCrypto: EnvelopeCryptoPort
  initialSessionId?: string | null
}): Promise<HTMLElement> {
  const transport = MockAuroraTransport.empty()
    .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
  const client = new AuroraClient({ transport })
  client.auth.setApiKeySystem()
  Object.defineProperty(client, 'events', {
    configurable: true,
    value: events.client,
  })
  const localAssistant: LightweightAssistantDependencies = {
    provider: unusedProvider(),
    tools: unusedToolPort(),
    localData,
    envelopeCrypto,
    scope,
    availableTools: [],
    ids: idSequence(),
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <AssistantView
        client={client}
        route={connectedRoute()}
        executionHost="connected-device"
        localAssistant={localAssistant}
        surfaceProfile={getAuroraSurfaceProfile({
          runtimeMode: 'mobile-native',
          transportKind: 'native-mobile',
          nativePlatform: 'android',
          nativeVoiceAvailable: true,
          nativeWakewordAvailable: true,
          localSpeechPackState: 'ready',
          localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
        })}
        nativeAvailable
        nativePlatform="android"
        initialSession={{ sessionId: initialSessionId, messages: [] }}
      />
    )
    await flushReactWork()
  })
  await waitUntil(() => document.querySelector('[aria-label="Model: Configured default"]') !== null)
  return container
}

class NativeAssistantEventHarness {
  private readonly pending: Array<AuroraEvent<unknown>> = []
  private readonly waiters: Array<(event: AuroraEvent<unknown> | null) => void> = []
  private readonly subscriptionWaiters: Array<() => void> = []
  private closed = false
  private subscriptionSeen = false

  readonly client = {
    subscribe: vi.fn((): AuroraEventSubscription<unknown> => {
      this.subscriptionSeen = true
      for (const waiter of this.subscriptionWaiters.splice(0)) waiter()
      return {
        ready: Promise.resolve(),
        closed: new Promise<void>((resolve) => {
          this.closeSubscription = resolve
        }),
        close: () => this.close(),
        [Symbol.asyncIterator]: () => this.iterator(),
      }
    }),
    snapshot: vi.fn(async () => ({
      events: [],
      lastSequenceId: null,
      replayComplete: true,
      subjects: [],
    })),
  }

  private closeSubscription: () => void = () => undefined

  async emit(event: AuroraEvent<unknown>): Promise<void> {
    await act(async () => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(event)
      else this.pending.push(event)
      await flushReactWork()
    })
  }

  async waitForSubscription(): Promise<void> {
    if (this.subscriptionSeen) return
    await waitUntil(() => this.subscriptionSeen)
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.closeSubscription()
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  private iterator(): AsyncIterator<AuroraEvent<unknown>> {
    return {
      next: async () => {
        if (this.pending.length > 0) {
          return { done: false, value: this.pending.shift()! }
        }
        if (this.closed) return { done: true, value: undefined }
        const event = await new Promise<AuroraEvent<unknown> | null>((resolve) => {
          this.waiters.push(resolve)
        })
        return event === null ? { done: true, value: undefined } : { done: false, value: event }
      },
    }
  }
}

async function seedConversation(
  localData: LocalDataSession,
  envelopeCrypto: EnvelopeCryptoPort,
  input: {
    conversationId: string
    userId: string
    assistantId: string
    transcript: string
    response: string
    createdAtMs: number
  },
): Promise<void> {
  await localData.conversations.upsertConversation({
    id: input.conversationId,
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
    titleEnvelope: null,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs + 2,
    archivedAtMs: null,
  })
  for (const [id, sequence, role, text] of [
    [input.userId, 0, 'user', input.transcript],
    [input.assistantId, 1, 'assistant', input.response],
  ] as const) {
    await localData.conversations.appendMessage({
      id,
      conversationId: input.conversationId,
      sequence,
      role,
      contentEnvelope: await envelopeCrypto.encrypt(
        'local-structured-data',
        new TextEncoder().encode(text),
        buildEnvelopeAad({
          table: 'aurora_messages',
          recordId: id,
          field: 'content_envelope_json',
          profileId: scope.profileId,
          localNodeId: scope.localNodeId,
        }),
      ),
      toolEnvelope: null,
      status: 'complete',
      createdAtMs: input.createdAtMs + sequence,
    })
  }
}

function nativeEvent(kind: string, payload: Record<string, unknown>): AuroraEvent<unknown> {
  return {
    id: `native:${kind}:${String(payload.generation ?? payload.requestId ?? Date.now())}`,
    kind,
    topic: 'Voice.Turn',
    method: null,
    busTopic: 'Voice.Turn',
    payload,
    audit: {
      correlationId: typeof payload.requestId === 'string' ? payload.requestId : null,
      eventKind: kind,
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: null,
      busTopic: 'Voice.Turn',
      toolId: null,
      resourceId: null,
      status: null,
      transport: 'native',
      redaction: {
        secretsRedacted: true,
        redactedFields: [],
        source: 'transport',
        warnings: [],
      },
    },
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'transport',
      warnings: [],
    },
    receivedAt: '2026-09-16T00:00:00.000Z',
  }
}

function connectedRoute(): RouteAvailability {
  return {
    item: { id: 'assistant', label: 'Assistant', privacyClass: 'personal' },
    state: 'available-local',
    explanation: 'Assistant is available from Home Aurora.',
    providerLabel: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
    blockers: [],
    repairActions: [],
    candidateProviders: [{
      id: 'local:home-aurora:Orchestrator',
      providerId: 'local:home-aurora:Orchestrator',
      providerKind: 'local',
      peerId: 'peer-home',
      nodeName: 'Home Aurora',
      serviceInstanceId: 'local:home-aurora:Orchestrator',
      label: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
      state: 'available-local',
      selectable: true,
      reason: 'available',
      requiredAction: null,
    }],
    evidenceSources: [ORCHESTRATOR_METHODS.externalUserInput],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  } as unknown as RouteAvailability
}

function unusedProvider(): LightweightAssistantProvider {
  return {
    async complete(): Promise<never> {
      throw new Error('Native assistant events must not dispatch a foreground local provider request.')
    },
  }
}

function unusedToolPort(): LightweightToolClientPort {
  const unused = async (): Promise<never> => {
    throw new Error('No tool call was expected in this test.')
  }
  return {
    prepareExecution: unused,
    requestApproval: unused,
    confirmExecution: unused,
    execute: unused,
  }
}

function idSequence(): () => string {
  let next = 0
  return () => `native-assistant-view-${next++}`
}

function activeConversationText(container: HTMLElement): string {
  return container.querySelector<HTMLButtonElement>('[aria-label="Assistant conversation list"] button[aria-current="true"]')?.textContent ?? ''
}

function visibleConversationText(container: HTMLElement): string {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="message"]')]
    .map((message) => message.textContent ?? '')
    .join('\n')
}

function statusText(container: HTMLElement): string {
  return container.querySelector('[aria-label="Assistant status"]')?.textContent ?? ''
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for native Assistant view state: ${document.body.textContent ?? ''}`)
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

async function flushReactWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

class TestEnvelopeCryptoPort implements EnvelopeCryptoPort {
  private readonly plaintextByKeyId = new Map<string, Uint8Array>()
  private readonly aadByKeyId = new Map<string, Uint8Array>()
  private nextKey = 0

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    const keyId = `test-${keyPurpose}-${this.nextKey++}`
    this.plaintextByKeyId.set(keyId, new Uint8Array(plaintext))
    this.aadByKeyId.set(keyId, new Uint8Array(aad))
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId,
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAtMs: Date.now(),
    }
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    expect([...aad]).toEqual([...(this.aadByKeyId.get(envelope.keyId) ?? [])])
    return new Uint8Array(this.plaintextByKeyId.get(envelope.keyId) ?? [])
  }

  async rotateKey(): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'test-old', newKeyId: 'test-new' }
  }
}
