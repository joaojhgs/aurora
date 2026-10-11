// @vitest-environment jsdom
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AssistantRoutePolicy, AuroraClient, AuroraEvent } from '@aurora/client'
import type { AssistantModelChoice, AssistantSessionSnapshot, AssistantStreamState } from './assistant-view'
import type { AssistantTurnsController, AssistantTurnsTtsCallbacks } from './use-assistant-turns'
import { useAssistantTurns } from './use-assistant-turns'
import { getAuroraSurfaceProfile } from './platform-surface'
import type { RouteAvailability } from './shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAssistantTurns native assistant reconciliation', () => {
  it('does not create a pending turn for a cancelled replayed native snapshot', async () => {
    const harness = await renderTurnsHarness()

    harness.result.cancelledPendingIdsRef.current.add('request-cancelled-before-create')
    await act(async () => {
      await harness.result.handleNativeAssistantEvent(nativeAssistantEvent('assistant.delta', {
        id: 'native:snapshot:voice-turn-cancelled',
        generation: 70,
        requestId: 'request-cancelled-before-create',
        accumulatedText: 'Cancelled replay text',
        textDelta: 'Cancelled replay text',
      }))
      await flushPromises()
    })

    expect(harness.session.messages.some((message) => message.id === 'request-cancelled-before-create')).toBe(false)
    expect(harness.streamStates).toEqual([])
  })

  it('does not attach a provisional native event to an unrelated selected conversation', async () => {
    const harness = await renderTurnsHarness({ initialSession: { sessionId: 'conversation-selected', messages: [] } })

    await act(async () => {
      await harness.result.handleNativeAssistantEvent(nativeAssistantEvent('voice.turn.started', {
        generation: 71,
        requestId: 'request-background-provisional',
        transcript: 'Unrelated background request',
        status: 'requesting',
      }))
      await flushPromises()
    })

    expect(harness.session).toEqual({ sessionId: 'conversation-selected', messages: [] })
    expect(harness.streamStates).toEqual([])
  })

  it('does not revive a cancelled native pending turn from a late snapshot delta', async () => {
    const harness = await renderTurnsHarness()

    await act(async () => {
      await harness.result.handleNativeAssistantEvent(nativeAssistantEvent('voice.turn.started', {
        generation: 7,
        requestId: 'request-cancelled',
        transcript: 'cancel this request',
        status: 'requesting',
      }))
      await flushPromises()
    })
    expect(harness.session.messages.some((message) => message.id === 'request-cancelled')).toBe(true)
    harness.streamStates.splice(0)

    harness.result.cancelledPendingIdsRef.current.add('request-cancelled')
    await act(async () => {
      await harness.result.handleNativeAssistantEvent(nativeAssistantEvent('assistant.delta', {
        id: 'native:snapshot:voice-turn-7',
        generation: 7,
        requestId: 'request-cancelled',
        accumulatedText: 'Should not revive cancelled text',
        textDelta: 'Should not revive cancelled text',
      }))
      await flushPromises()
    })

    expect(harness.session.messages.find((message) => message.id === 'request-cancelled')?.text).toBe('Aurora is responding.')
    expect(harness.streamStates).toEqual([])
  })
})

async function renderTurnsHarness(options: { initialSession?: AssistantSessionSnapshot } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  let result!: AssistantTurnsController
  let currentSession: AssistantSessionSnapshot = options.initialSession ?? { sessionId: null, messages: [] }
  const streamStates: AssistantStreamState[] = []

  function Harness() {
    const [session, setSessionState] = useState<AssistantSessionSnapshot>(currentSession)
    const sessionRef = useRef(session)
    const abortRef = useRef<AbortController | null>(null)
    const voiceTranscriptPreviewRef = useRef('')
    const voicePendingAssistantIdRef = useRef<string | null>(null)
    const activeVoiceSessionRef = useRef<string | null>(null)
    const ownedVoiceSessionIdsRef = useRef(new Set<string>())
    const coordinatorVoiceSessionIdsRef = useRef(new Set<string>())
    const ttsCallbacksRef = useRef<AssistantTurnsTtsCallbacks | null>({
      lastAssistantMessageIdRef: useRef<string | null>(null),
      speakingMessageIdRef: useRef<string | null>(null),
      setSpeakingMessageId: vi.fn(),
      enqueueStreamedTtsAudio: vi.fn(),
    })
    useEffect(() => {
      sessionRef.current = session
      currentSession = session
    }, [session])
    result = useAssistantTurns({
      client: clientStub,
      route: routeAvailability('assistant'),
      runtimeHealth: undefined,
      surfaceProfile: getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'android' }),
      session,
      sessionRef,
      setSession: (next) => setSessionState((current) => {
        const resolved = typeof next === 'function' ? next(current) : next
        currentSession = resolved
        return resolved
      }),
      setLocalConversationRows: vi.fn(),
      abortRef,
      setText: vi.fn(),
      setLastPrompt: vi.fn(),
      setLastError: vi.fn(),
      setLastResult: vi.fn(),
      modelLabel: null,
      setModelLabel: vi.fn(),
      runtimeProviderLabel: null,
      setRuntimeProviderLabel: vi.fn(),
      setStreamState: (next) => {
        const current = streamStates[streamStates.length - 1] ?? { status: 'idle', lastEventId: null, message: null }
        streamStates.push(typeof next === 'function' ? next(current) : next)
      },
      setSessionIndexError: vi.fn(),
      setVoiceCaptureStatus: vi.fn(),
      setVoiceResponsePendingId: vi.fn(),
      selectedExecution: { mode: 'local', runner: 'aurora-route', label: 'Aurora', executionPeerId: null },
      selectedModelChoice: selectedModelChoice(),
      routePolicy: {} as AssistantRoutePolicy,
      inferencePolicy: null,
      localExecutionMessageLabel: 'This device',
      localOrchestrator: null,
      localConfirmationOrchestratorsRef: useRef(new Map()),
      localHistory: null,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: false,
      createPersistedChatSession: vi.fn(async () => null),
      refreshPersistedSessionIndex: vi.fn(async () => undefined),
      refreshLocalSessionIndex: vi.fn(async () => undefined),
      productAssistantErrorCopy: (error) => error instanceof Error ? error.message : String(error),
      assistantStreamScopeId: 'turns-test-scope',
      assistantStreamScope: { scopeId: 'turns-test-scope' },
      voiceTranscriptPreviewRef,
      voicePendingAssistantIdRef,
      activeVoiceSessionRef,
      ownedVoiceSessionIdsRef,
      coordinatorVoiceSessionIdsRef,
      clearVoiceResponseTimeout: vi.fn(),
      ttsCallbacksRef,
    })
    return null
  }

  await act(async () => {
    root.render(createElement(Harness))
    await flushPromises()
  })

  return {
    get result() { return result },
    get session() { return currentSession },
    streamStates,
  }
}

const clientStub = {
  transport: { kind: 'native-mobile' },
  assistant: {
    streamMessage: vi.fn(async function* () {}),
  },
} as unknown as AuroraClient

function selectedModelChoice(): AssistantModelChoice {
  return {
    id: 'model',
    model: { id: 'model', name: 'Aurora model', provider: 'aurora' },
    provider: null,
    runtimeModel: null,
    automatic: true,
  } as AssistantModelChoice
}

function routeAvailability(id: string): RouteAvailability {
  return {
    item: {
      id,
      label: id,
      href: `/${id}`,
      capabilityModule: 'Assistant',
      capabilityMethod: 'Voice',
      methodType: 'use',
      privacyClass: 'raw-audio',
      fallbackState: 'unsupported',
      adminGated: false,
      expectedTask: 'ASSISTANT-VOICE',
    },
    state: 'available-local',
    explanation: 'Ready',
    providerLabel: 'Aurora',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  } as RouteAvailability
}

function nativeAssistantEvent(kind: string, payload: Record<string, unknown>): AuroraEvent<unknown> {
  const id = typeof payload.id === 'string' ? payload.id : `event-${kind}`
  return {
    id,
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
      redaction: { secretsRedacted: true, redactedFields: [], source: 'transport', warnings: [] },
    },
    redaction: { secretsRedacted: true, redactedFields: [], source: 'transport', warnings: [] },
    receivedAt: '2026-09-16T00:00:00.000Z',
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
