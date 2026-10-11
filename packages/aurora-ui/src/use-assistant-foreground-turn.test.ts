import { describe, expect, it, vi } from 'vitest'
import { AuroraError } from '@aurora/client'
import { productAssistantErrorCopy } from './assistant-view-copy'
import {
  createAssistantTurnStreamController,
  type CreateAssistantTurnStreamControllerParams,
} from './use-assistant-turn-stream'
import type {
  AssistantRoutePolicy,
  AssistantStreamMessageRequest,
  AssistantStreamUpdate,
  AuroraClient,
} from '@aurora/client'
import { getAuroraSurfaceProfile } from './platform-surface'
import type { AssistantModelChoice, AssistantSessionSnapshot } from './assistant-view'
import type { RouteAvailability, RouteProviderCandidate } from './shell-data'
import {
  createAssistantForegroundTurnController,
  type CreateAssistantForegroundTurnControllerParams,
} from './use-assistant-foreground-turn'

describe('assistant foreground optional TTS stream subscription', () => {
  it('omits optional audio when the shell has no stream route', async () => {
    const result = await runForegroundTurn({})

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it.each([
    ['missing', streamRoute('unsupported', [])],
    ['denied', streamRoute('denied', [streamCandidate('assistant-peer', { state: 'denied', selectable: false })])],
    ['stale', streamRoute('stale', [streamCandidate('assistant-peer', { state: 'stale', selectable: false })])],
  ])('continues the text stream without requesting optional audio when TTS is %s', async (_label, ttsStreamRoute) => {
    const result = await runForegroundTurn({ ttsStreamRoute })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it('omits optional audio when TTS availability belongs to a different peer', async () => {
    const result = await runForegroundTurn({
      ttsStreamRoute: streamRoute('available-remote', [streamCandidate('other-peer')]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it('requests optional audio when the selected assistant peer exports the ready stream', async () => {
    const result = await runForegroundTurn({
      ttsStreamRoute: streamRoute('available-remote', [streamCandidate('assistant-peer')]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBe(true)
  })

  it('fails closed when execution and route policy identify different peers', async () => {
    const result = await runForegroundTurn({
      routePolicyPeerId: 'policy-peer',
      ttsStreamRoute: streamRoute('available-remote', [streamCandidate('policy-peer')]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it('fails closed when the route policy provider identity conflicts with execution peer', async () => {
    const result = await runForegroundTurn({
      executionPeerId: 'assistant-peer',
      routePolicyPeerId: null,
      routePolicyProviderId: 'mesh:policy-peer:Orchestrator',
      ttsStreamRoute: streamRoute('available-remote', [streamCandidate('assistant-peer')]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it('uses the connected host graph route and rejects another provider', async () => {
    const homeRoute = streamRoute('available-local', [localStreamCandidate()])
    const home = await runForegroundTurn({
      executionPeerId: null,
      routePolicyPeerId: null,
      transportHost: true,
      ttsStreamRoute: homeRoute,
    })
    const otherProvider = await runForegroundTurn({
      executionPeerId: null,
      routePolicyPeerId: null,
      transportHost: true,
      ttsStreamRoute: streamRoute('available-remote', [streamCandidate('other-peer')]),
    })

    expect(home.request.clientTtsPlayback).toBe(true)
    expect(otherProvider.completed).toBe(true)
    expect(otherProvider.request.clientTtsPlayback).toBeUndefined()
  })

  it('rejects a connected-host graph route when policy provider identity points to a peer', async () => {
    const result = await runForegroundTurn({
      executionPeerId: null,
      routePolicyPeerId: null,
      routePolicyProviderId: 'mesh:other-peer:Orchestrator',
      transportHost: true,
      ttsStreamRoute: streamRoute('available-local', [localStreamCandidate()]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBeUndefined()
  })

  it('keeps local-sidecar playback opt-in disabled even when a stream route is available', async () => {
    const result = await runForegroundTurn({
      surfaceProfile: getAuroraSurfaceProfile({ runtimeMode: 'desktop-local', transportKind: 'tauri-local' }),
      ttsStreamRoute: streamRoute('available-local', [localStreamCandidate()]),
    })

    expect(result.completed).toBe(true)
    expect(result.request.clientTtsPlayback).toBe(false)
  })

  it('keeps a canonical local failure code while rendering only safe error copy', async () => {
    const rawBackendDetail = 'private backend detail sentinel'
    const failure = new AuroraError({ code: 'timeout', message: rawBackendDetail })
    const result = await runForegroundTurn({ localFailure: failure })

    expect(result.completed).toBe(false)
    expect(result.markAssistantTurnFailed).toHaveBeenCalledWith(
      expect.any(String),
      'Aurora timed out before returning a final assistant response.',
      'timeout',
    )
    expect(result.failedMessage).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
      error: 'Aurora timed out before returning a final assistant response.',
    })
    expect(JSON.stringify(result.failedMessage)).not.toContain(rawBackendDetail)
  })
})

interface ForegroundTurnOptions {
  ttsStreamRoute?: RouteAvailability
  surfaceProfile?: ReturnType<typeof getAuroraSurfaceProfile>
  executionPeerId?: string | null
  routePolicyPeerId?: string | null
  routePolicyProviderId?: string
  transportHost?: boolean
  localFailure?: AuroraError
}

async function runForegroundTurn(options: ForegroundTurnOptions) {
  const requests: AssistantStreamMessageRequest[] = []
  const client = {
    assistant: {
      streamMessage: vi.fn(async function* (request: AssistantStreamMessageRequest) {
        requests.push(request)
        yield completedUpdate()
      }),
    },
  } as unknown as AuroraClient
  const route = assistantRoute()
  let sessionState: AssistantSessionSnapshot = { sessionId: null, messages: [] }
  const setSession = vi.fn((update: (current: AssistantSessionSnapshot) => AssistantSessionSnapshot) => {
    sessionState = update(sessionState)
  })
  const assistantStreamScope = { scopeId: 'foreground-tts-readiness-test' }
  const failureStreamController = options.localFailure
    ? createAssistantTurnStreamController({
        setSession,
        setLastError: vi.fn(),
        setStreamState: vi.fn(),
        lastStreamEventIdRef: { current: null },
        assistantStreamScope,
        assistantStreamScopeId: assistantStreamScope.scopeId,
      } as unknown as CreateAssistantTurnStreamControllerParams)
    : null
  const markAssistantTurnFailed = vi.fn(failureStreamController?.markAssistantTurnFailed ?? vi.fn())
  const params = {
    client,
    route,
    surfaceProfile: options.surfaceProfile ?? getAuroraSurfaceProfile({ transportKind: 'http' }),
    session: sessionState,
    setSession,
    abortRef: { current: null },
    setText: vi.fn(),
    setLastPrompt: vi.fn(),
    setLastError: vi.fn(),
    setLastResult: vi.fn(),
    setModelLabel: vi.fn(),
    runtimeProviderLabel: null,
    setStreamState: vi.fn(),
    setSessionIndexError: vi.fn(),
    selectedExecution: {
      mode: options.localFailure ? 'local' as const : 'dispatch' as const,
      runner: options.localFailure ? 'lightweight-local' as const : 'aurora-route' as const,
      label: options.localFailure ? 'This device' : 'Connected Aurora device',
      executionPeerId: options.localFailure ? null : options.executionPeerId === undefined ? 'assistant-peer' : options.executionPeerId,
      transportHost: options.transportHost === true,
    },
    selectedModelChoice: modelChoice(),
    routePolicy: routePolicy(
      options.routePolicyPeerId === undefined ? 'assistant-peer' : options.routePolicyPeerId,
      options.routePolicyProviderId
    ),
    inferencePolicy: null,
    localExecutionMessageLabel: 'This device',
    localOrchestrator: options.localFailure
      ? { runTurn: vi.fn().mockRejectedValue(options.localFailure) }
      : null,
    localConfirmationOrchestratorsRef: { current: new Map() },
    localHistory: null,
    supportsPersistedSessions: false,
    usesLocalConversationHistory: false,
    createPersistedChatSession: vi.fn(async () => null),
    refreshPersistedSessionIndex: vi.fn(async () => undefined),
    refreshLocalSessionIndex: vi.fn(async () => undefined),
    productAssistantErrorCopy: options.localFailure ? productAssistantErrorCopy : (error: Error) => error.message,
    assistantStreamScope,
    activePendingIdRef: { current: null },
    lastStreamEventIdRef: { current: null },
    cancelledPendingIdsRef: { current: new Set<string>() },
    setActiveAssistantPendingId: vi.fn(),
    applyAssistantStreamUpdate: vi.fn(),
    markAssistantTurnFailed,
    ...(options.ttsStreamRoute ? { ttsStreamRoute: options.ttsStreamRoute } : {}),
  } as unknown as CreateAssistantForegroundTurnControllerParams

  const controller = createAssistantForegroundTurnController(params)
  const completed = await controller.startAssistantTurn('Say hello')
  const request = requests[0]
  if (!request && !options.localFailure) throw new Error('foreground turn did not open its assistant stream')
  const failedMessage = sessionState.messages.find((message) => message.status === 'failed')
  return { completed, request: request!, failedMessage, markAssistantTurnFailed }
}

function streamRoute(state: RouteAvailability['state'], candidates: RouteProviderCandidate[]): RouteAvailability {
  return {
    item: {
      id: 'voice-tts-stream',
      label: 'Spoken replies',
      href: '/',
      capabilityModule: 'TTS',
      capabilityMethod: 'StreamStart',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'SPEECH_STREAMING',
    },
    state,
    explanation: 'TTS audio stream route',
    providerLabel: 'Connected Aurora device',
    blockers: [],
    repairActions: [],
    candidateProviders: candidates,
    evidenceSources: ['capability-graph'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: state === 'available-local' || state === 'available-remote',
    disabled: state !== 'available-local' && state !== 'available-remote',
    requiresAdminAction: false,
  }
}

function streamCandidate(
  peerId: string,
  overrides: Partial<RouteProviderCandidate> = {},
): RouteProviderCandidate {
  return {
    id: `mesh:${peerId}:TTS`,
    providerId: `mesh:${peerId}:TTS`,
    providerKind: 'mesh',
    peerId,
    serviceInstanceId: `tts-${peerId}`,
    label: 'Connected Aurora device',
    state: 'available-remote',
    selectable: true,
    reason: 'TTS audio stream is available.',
    requiredAction: null,
    ...overrides,
  }
}

function localStreamCandidate(): RouteProviderCandidate {
  return {
    id: 'local:TTS',
    providerId: 'local:TTS',
    providerKind: 'local',
    peerId: null,
    serviceInstanceId: 'tts-local',
    label: 'This device',
    state: 'available-local',
    selectable: true,
    reason: 'TTS audio stream is available.',
    requiredAction: null,
  }
}

function assistantRoute(): RouteAvailability {
  return {
    item: {
      id: 'assistant',
      label: 'Assistant',
      href: '/',
      capabilityModule: 'Orchestrator',
      capabilityMethod: 'ExternalUserInput',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'ASSISTANT-PROMPT',
    },
    state: 'available-remote',
    explanation: 'Assistant is available.',
    providerLabel: 'Connected Aurora device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['capability-graph'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function routePolicy(peerId: string | null, providerId?: string): AssistantRoutePolicy {
  return {
    providerId: providerId ?? (peerId ? `mesh:${peerId}:Orchestrator` : 'local:Orchestrator'),
    peerId,
    serviceInstanceId: peerId ? `orchestrator-${peerId}` : 'orchestrator-local',
    routeState: peerId ? 'available-remote' : 'available-local',
    fallbackBehavior: null,
    privacyClass: 'personal',
    selectorRequired: false,
    approvalRequired: false,
  }
}

function modelChoice(): AssistantModelChoice {
  return {
    id: 'model',
    model: { id: 'model', name: 'Aurora model', provider: 'aurora' },
    provider: null,
    runtimeModel: null,
    automatic: true,
  } as AssistantModelChoice
}

function completedUpdate(): AssistantStreamUpdate {
  return {
    kind: 'completed',
    eventId: 'event-completed',
    messageId: 'assistant-message',
    sessionId: 'session',
    text: 'Hello.',
    textDelta: 'Hello.',
    modelLabel: 'Aurora model',
    error: null,
    audit: {} as AssistantStreamUpdate['audit'],
    metadata: {},
    tool: null,
    ttsAudio: null,
  }
}
