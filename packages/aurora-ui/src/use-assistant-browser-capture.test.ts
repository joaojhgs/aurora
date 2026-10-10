// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient, VoiceRuntimeEvent } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import type { AssistantStreamState, AssistantVoiceModel, VoiceCaptureStatus } from './assistant-view'
import type { ReadyBrowserSpeechPacksRuntimeStatus } from './use-assistant-voice'
import type { AuroraBrowserCapturedAudio, AuroraBrowserVoiceRuntimeInstance } from './assistant-browser-voice-runtime'
import {
  createBrowserCaptureController,
  type BrowserCaptureControllerContext,
  type BrowserVoiceTurnSettlement,
} from './use-assistant-browser-capture'

describe('browser assistant capture controller', () => {
  it('claims a browser settlement once while concurrent callers observe the settled owner', async () => {
    const runtime = browserRuntime()
    const harness = browserHarness({ runtime })
    harness.context.browserVoiceOperationTokenRef.current = 4
    harness.context.browserVoiceTurnSettlementRef.current = { token: 4, state: 'open', outcome: null, promise: null }
    const controller = createBrowserCaptureController(harness.context)

    const first = controller.settleBrowserVoiceTurn(4, 'complete')
    const second = controller.settleBrowserVoiceTurn(4, 'complete')

    await expect(first).resolves.toEqual({ claimed: true, succeeded: true, current: true })
    await expect(second).resolves.toEqual({ claimed: false, succeeded: true, current: true })
    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
    expect(harness.context.browserVoiceTurnSettlementRef.current?.state).toBe('settled')
  })

  it('uses fallback cancel plus forced dispose when browser completion cannot close the turn', async () => {
    const runtime = browserRuntime({
      completeTurn: vi.fn(async () => { throw new Error('complete failed') }),
      cancel: vi.fn(async () => { throw new Error('cancel failed') }),
    })
    const unsubscribe = vi.fn()
    const harness = browserHarness({ runtime, unsubscribe })
    harness.context.browserVoiceOperationTokenRef.current = 5
    harness.context.browserVoiceTurnSettlementRef.current = { token: 5, state: 'open', outcome: null, promise: null }
    const controller = createBrowserCaptureController(harness.context)

    await expect(controller.settleBrowserVoiceTurn(5, 'complete')).resolves.toEqual({ claimed: true, succeeded: false, current: true })

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).toHaveBeenCalledWith('turn_completed_failed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(harness.context.browserVoiceRuntimeRef.current).toBeNull()
  })

  it('marks lifecycle loss as a lost focused capture and cancels the runtime', async () => {
    const runtime = browserRuntime()
    const harness = browserHarness({ runtime })
    harness.context.voiceCaptureStatusRef.current = 'listening'
    harness.context.activeVoiceSessionRef.current = 'browser-session'
    harness.context.ownedVoiceSessionIdsRef.current.add('browser-session')
    harness.context.coordinatorVoiceSessionIdsRef.current.add('browser-session')
    harness.context.voicePendingAssistantIdRef.current = 'pending-assistant'
    harness.context.browserVoiceOperationTokenRef.current = 7
    const controller = createBrowserCaptureController(harness.context)

    controller.releaseBrowserVoiceCaptureForLifecycle()
    await flushPromises()

    expect(runtime.cancel).toHaveBeenCalledWith('lifecycle_lost')
    expect(harness.voiceStatuses).toContain('idle')
    expect(harness.context.activeVoiceSessionRef.current).toBeNull()
    expect(harness.context.ownedVoiceSessionIdsRef.current.size).toBe(0)
    expect(harness.context.coordinatorVoiceSessionIdsRef.current.size).toBe(0)
    expect(harness.context.voicePendingAssistantIdRef.current).toBeNull()
    expect(harness.responsePendingIds).toContain(null)
    expect(harness.streamStates[harness.streamStates.length - 1]).toMatchObject({
      status: 'lost',
      message: 'Microphone listening stopped because Aurora was no longer the active window.',
    })
  })

  it('abandons stale captured browser audio without starting an assistant turn', async () => {
    const runtime = browserRuntime({
      stop: vi.fn(async () => {
        harness.context.browserVoiceOperationTokenRef.current += 1
        return capturedAudio({ sampleCount: 2, pcm: new Int16Array([1, 2]) })
      }),
    })
    const harness = browserHarness({ runtime })
    harness.context.browserVoiceOperationTokenRef.current = 11
    harness.context.browserVoiceTurnSettlementRef.current = { token: 11, state: 'open', outcome: null, promise: null }
    const controller = createBrowserCaptureController(harness.context)

    await controller.stopBrowserVoiceCapture()

    expect(runtime.abandonTurn).toHaveBeenCalledTimes(1)
    expect(harness.context.startAssistantTurn).not.toHaveBeenCalled()
    expect(harness.client.assistant.transcribeVoiceAudio).not.toHaveBeenCalled()
  })

  it('uses the selected connected-device speech route instead of a local transcript', async () => {
    const harness = browserHarness({
      readyBrowserSpeechPacks: {
        state: 'ready',
        packs: [],
        modelBindings: { files: [], models: [] },
        capabilities: { stt: true, tts: false, kws: false, vad: false },
        revision: 'test',
      } as ReadyBrowserSpeechPacksRuntimeStatus,
    })
    harness.context.browserVoiceLocalTranscriptRef.current = 'local transcript'
    harness.context.routePolicyFromRoute = vi.fn(() => ({ peerId: 'peer-a' }))
    harness.context.browserVoiceOperationTokenRef.current = 3
    harness.context.browserVoiceTurnSettlementRef.current = { token: 3, state: 'open', outcome: null, promise: null }
    const controller = createBrowserCaptureController(harness.context)

    await controller.stopBrowserVoiceCapture()

    expect(harness.client.assistant.transcribeVoiceAudio).toHaveBeenCalledWith(expect.objectContaining({
      routePolicy: { peerId: 'peer-a' },
    }))
    expect(harness.context.startAssistantTurn).toHaveBeenCalledWith('transcribed speech')
    expect(harness.runtime.completeTurn).toHaveBeenCalledTimes(1)
  })
})

function browserHarness(overrides: { runtime?: AuroraBrowserVoiceRuntimeInstance; unsubscribe?: () => void; readyBrowserSpeechPacks?: ReadyBrowserSpeechPacksRuntimeStatus | null } = {}) {
  let streamState: AssistantStreamState = { status: 'idle', message: '', lastEventId: null }
  let voiceEvents: VoiceRuntimeEvent[] = []
  const voiceStatuses: VoiceCaptureStatus[] = []
  const streamStates: AssistantStreamState[] = []
  const responsePendingIds: Array<string | null> = []
  const runtime = overrides.runtime ?? browserRuntime()
  const client = {
    assistant: {
      transcribeVoiceAudio: vi.fn(async () => ({ ok: true, data: { text: 'transcribed speech' } })),
    },
  } as unknown as AuroraClient & { assistant: { transcribeVoiceAudio: ReturnType<typeof vi.fn> } }
  const context: BrowserCaptureControllerContext = {
    client,
    readyBrowserSpeechPacks: overrides.readyBrowserSpeechPacks ?? null,
    voiceModel: voiceModel(),
    browserVoiceRuntimeRef: ref(runtime),
    browserVoiceRuntimeEventUnsubscribeRef: ref(overrides.unsubscribe ?? vi.fn()),
    browserVoiceOperationTokenRef: ref(0),
    browserVoiceTurnSettlementRef: ref<BrowserVoiceTurnSettlement | null>(null),
    browserVoiceLocalTranscriptRef: ref(''),
    activeVoiceSessionRef: ref<string | null>(null),
    ownedVoiceSessionIdsRef: ref(new Set<string>()),
    coordinatorVoiceSessionIdsRef: ref(new Set<string>()),
    voicePendingAssistantIdRef: ref<string | null>(null),
    voiceCaptureStatusRef: ref<VoiceCaptureStatus>('idle'),
    voiceTranscriptPreviewRef: ref(''),
    setText: vi.fn(),
    setLastError: vi.fn(),
    setStreamState: (next) => {
      streamState = resolveState(next, streamState)
      streamStates.push(streamState)
    },
    setVoiceCaptureStatus: (status) => {
      context.voiceCaptureStatusRef.current = status
      voiceStatuses.push(status)
    },
    setVoiceEvents: (next) => { voiceEvents = resolveState(next, voiceEvents) },
    setVoiceResponsePendingId: (pendingId) => { responsePendingIds.push(pendingId) },
    setVoiceWaveformBars: vi.fn(),
    waveformBarsFromLevel: vi.fn(() => [8, 16, 8]),
    mergeVoiceRuntimeEvents: (...groups) => groups.flat(),
    routePolicyFromRoute: vi.fn(() => ({} as ReturnType<BrowserCaptureControllerContext['routePolicyFromRoute']>)),
    productAssistantErrorCopy: (error) => error instanceof Error ? error.message : 'Assistant error',
    startAssistantTurn: vi.fn(async () => true),
  }
  return { context, runtime, client, voiceStatuses, streamStates, responsePendingIds, get voiceEvents() { return voiceEvents } }
}

function browserRuntime(overrides: Partial<AuroraBrowserVoiceRuntimeInstance> = {}): AuroraBrowserVoiceRuntimeInstance {
  return {
    start: vi.fn(async () => ({ sessionId: 'browser-session' })),
    stop: vi.fn(async () => capturedAudio()),
    completeTurn: vi.fn(async () => undefined),
    abandonTurn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    onEvent: vi.fn(() => vi.fn()),
    ...overrides,
  } as unknown as AuroraBrowserVoiceRuntimeInstance
}


function capturedAudio(overrides: Partial<NonNullable<AuroraBrowserCapturedAudio>> = {}): NonNullable<AuroraBrowserCapturedAudio> {
  return {
    sessionId: 'browser-session',
    generation: 1,
    sampleRateHz: 16000,
    channels: 1,
    sampleCount: 1,
    durationMs: 20,
    pcm: new Int16Array([1]),
    redacted: true,
    ...overrides,
  }
}

function voiceModel(): AssistantVoiceModel {
  const route = routeAvailability('voice-route')
  return {
    captureStatus: 'idle',
    consentGranted: true,
    privacyClass: 'raw-audio',
    retentionPolicy: 'Session only',
    sessionTtl: 'This conversation',
    transport: 'Local',
    platformTruth: 'Test',
    visualizerSourceLabel: 'Microphone',
    targetLabel: 'Aurora',
    chips: [],
    controls: [],
    events: [],
    routeSheetRoute: route,
    remoteAudioRoute: route,
    transcriptionRoute: route,
    speechRoute: route,
    waveformBars: [],
  }
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
  }
}

function ref<T>(current: T) {
  return { current }
}

function resolveState<T>(next: SetStateActionShim<T>, current: T): T {
  return typeof next === 'function' ? (next as (value: T) => T)(current) : next
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

type SetStateActionShim<T> = T | ((current: T) => T)
