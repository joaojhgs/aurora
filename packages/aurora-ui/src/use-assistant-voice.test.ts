// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuroraClient, VoiceRuntimeEvent } from '@aurora/client'
import { getAuroraSurfaceProfile } from './platform-surface'
import type { RouteAvailability } from './shell-data'
import type { AssistantStreamState, AssistantVoiceModel } from './assistant-view'
import {
  useAssistantVoice,
  useAssistantVoiceLifecycle,
  type AssistantVoiceModelBuilderInput,
  type UseAssistantVoiceOptions,
  type UseAssistantVoiceResult,
} from './use-assistant-voice'
import { createAssistantVoiceEventController } from './use-assistant-voice-events'
import type { AssistantVoiceEventControllerOptions } from './assistant-voice-event-controller-types'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAssistantVoice', () => {
  it('keeps the capture status ref synchronized with the rendered button state', async () => {
    const harness = await renderVoiceHarness()

    expect(harness.result.voiceCaptureStatus).toBe('idle')
    expect(harness.result.voiceCaptureStatusRef.current).toBe('idle')
    expect(harness.result.voiceCaptureButtonLabel).toBe('Push to talk')
    expect(harness.result.voiceModel.captureStatus).toBe('idle')

    await act(async () => {
      harness.result.setVoiceCaptureStatus('listening')
      await flushPromises()
    })

    expect(harness.result.voiceCaptureStatus).toBe('listening')
    expect(harness.result.voiceCaptureStatusRef.current).toBe('listening')
    expect(harness.result.voiceCaptureButtonLabel).toBe('Stop listening')
    expect(harness.result.voiceModel.captureStatus).toBe('listening')
  })

  it('grants connected voice access only for the current remote audio route', async () => {
    const harness = await renderVoiceHarness({ remoteRouteId: 'first-route' })

    await act(async () => {
      harness.result.voiceConsentRouteKeyRef.current = harness.result.voiceConsentRouteKey
      harness.result.voiceConsentGrantedRef.current = true
      harness.result.setVoiceConsentGrantedState(true)
      await flushPromises()
    })

    expect(harness.result.connectedVoiceAccessGranted).toBe(true)

    await act(async () => {
      harness.rerender({ remoteRouteId: 'second-route' })
      await flushPromises()
    })

    expect(harness.result.voiceConsentGranted).toBe(true)
    expect(harness.result.connectedVoiceAccessGranted).toBe(false)
  })

  it('serializes consent revocation and releases the guard when cancellation rejects', async () => {
    let rejectCancellation!: (reason?: unknown) => void
    const cancellation = new Promise<void>((_, reject) => { rejectCancellation = reject })
    const callbacks = voiceLifecycleCallbacks()
    callbacks.cancelBrowserVoiceCaptureForReason = vi.fn(() => cancellation)
    const remoteRoute = { ...routeAvailability('remote-audio'), state: 'available-remote' as const }
    const harness = await renderVoiceHarness({
      lifecycleCallbacks: callbacks,
      surfaceProfile: getAuroraSurfaceProfile({ transportKind: 'http' }),
      buildVoiceModel: (input) => voiceModel(input, remoteRoute),
    })

    await act(async () => {
      harness.result.setVoiceCaptureStatus('listening')
      harness.result.setRemoteAudioConsent(true)
      await flushPromises()
    })

    const first = harness.result.toggleRemoteAudioConsent()
    const second = harness.result.toggleRemoteAudioConsent()
    await act(async () => { await Promise.resolve() })

    expect(callbacks.cancelBrowserVoiceCaptureForReason).toHaveBeenCalledTimes(1)
    expect(harness.result.remoteAudioConsentPending).toBe(true)

    rejectCancellation(new Error('capture already stopped'))
    await act(async () => {
      await expect(first).rejects.toThrow('capture already stopped')
      await second
      await flushPromises()
    })

    expect(harness.result.remoteAudioConsentPending).toBe(false)
  })

  it('marks native mobile background voice as microphone owner only while background wake is active', async () => {
    const nativeMobileVoice = {
      backgroundStatus: vi.fn(),
      startBackground: vi.fn(),
      stopBackground: vi.fn(),
    }
    const harness = await renderVoiceHarness({
      nativeMobileVoice: nativeMobileVoice as unknown as UseAssistantVoiceOptions['nativeMobileVoice'],
      surfaceProfile: nativeMobileVoiceSurfaceProfile(),
    })

    expect(harness.result.usesNativeMobileVoice).toBe(true)
    expect(harness.result.nativeMobileBackgroundOwnsMicrophone).toBe(false)

    await act(async () => {
      harness.result.setNativeMobileBackgroundWakeActive(true)
      await flushPromises()
    })

    expect(harness.result.nativeMobileBackgroundOwnsMicrophone).toBe(true)
    expect(harness.result.voiceModel.controls.find((control) => control.id === 'background-wake')?.enabled).toBe(true)
  })

  it('derives browser local TTS voice id only from ready speech packs', async () => {
    const harness = await renderVoiceHarness({
      browserSpeechPacks: {
        state: 'ready',
        revision: 'ready-revision',
        packs: [],
        capabilities: { vad: true, kws: false, stt: true, tts: true },
        modelBindings: { files: [], models: {} },
        ttsVoiceId: 'local-voice',
      } as unknown as UseAssistantVoiceOptions['browserSpeechPacks'],
    })

    expect(harness.result.browserSpeechPacksRevision).toBe('ready-revision')
    expect(harness.result.browserLocalTtsVoiceId).toBe('local-voice')

    await act(async () => {
      harness.rerender({
        browserSpeechPacks: {
          state: 'absent',
          revision: 'loading-revision',
          packs: [],
          capabilities: { vad: false, kws: false, stt: false, tts: true },
        },
      })
      await flushPromises()
    })

    expect(harness.result.browserSpeechPacksRevision).toBe('loading-revision')
    expect(harness.result.readyBrowserSpeechPacks).toBeNull()
    expect(harness.result.browserLocalTtsVoiceId).toBeUndefined()
  })

  it('merges lifecycle voice events with original dedupe identity', async () => {
    const first = voiceRuntimeEvent({ id: 'event-1', sequence: 7, text: 'first' })
    const duplicate = voiceRuntimeEvent({ id: 'event-1', sequence: 7, text: 'duplicate' })
    const second = voiceRuntimeEvent({ id: null, sequence: 8, text: 'second' })
    const harness = await renderVoiceLifecycleHarness({ recentVoiceEvents: [first] })

    expect(harness.result.voiceEvents.map((event) => event.text)).toEqual(['first'])

    await act(async () => {
      harness.rerender({ recentVoiceEvents: [duplicate, second] })
      await flushPromises()
    })

    expect(harness.result.voiceEvents.map((event) => event.text)).toEqual(['duplicate', 'second'])
    expect(harness.result.voiceEvents.map((event) => event.id)).toEqual(['event-1', null])
  })

  it('maps raw voice runtime error reasons through product-safe copy', () => {
    const setLastError = vi.fn()
    const productAssistantErrorCopy = vi.fn(() => 'Voice could not continue. Try again.')
    const controller = createAssistantVoiceEventController(voiceEventControllerOptions({
      setLastError,
      productAssistantErrorCopy,
    }))

    controller.applyVoiceRuntimeEvent({
      ...voiceRuntimeEvent({ id: 'hostile-tts-error', sequence: 1, text: '' }),
      id: 'hostile-tts-error',
      kind: 'tts_error',
      topic: 'voice.tts.error',
      sessionId: 'voice-session',
      state: 'error',
      reason: 'tts_error SQLITE_BUSY /tmp/aurora/raw-audio.wav stack=internal',
      occurredAt: '2026-09-16T00:00:00.000Z',
    } as VoiceRuntimeEvent)

    expect(productAssistantErrorCopy).toHaveBeenCalledWith(expect.any(Error))
    expect(setLastError).toHaveBeenCalledWith('Voice could not continue. Try again.')
    expect(setLastError).not.toHaveBeenCalledWith(expect.stringContaining('SQLITE_BUSY'))
  })

  it('maps raw disconnected voice event reasons through product-safe copy', () => {
    const setLastError = vi.fn()
    const productAssistantErrorCopy = vi.fn(() => 'Voice connection was interrupted. Try again.')
    const controller = createAssistantVoiceEventController(voiceEventControllerOptions({
      setLastError,
      productAssistantErrorCopy,
    }))

    controller.applyVoiceRuntimeEvent({
      ...voiceRuntimeEvent({ id: 'hostile-disconnect', sequence: 2, text: '' }),
      id: 'hostile-disconnect',
      kind: 'audio_denied',
      topic: 'audio.denied',
      sessionId: 'voice-session',
      state: 'denied',
      reason: 'websocket close 1011 transport stack trace peer=abc',
      occurredAt: '2026-09-16T00:00:00.000Z',
    } as VoiceRuntimeEvent)

    expect(productAssistantErrorCopy).toHaveBeenCalledWith(expect.any(Error))
    expect(setLastError).toHaveBeenCalledWith('Voice connection was interrupted. Try again.')
    expect(setLastError).not.toHaveBeenCalledWith(expect.stringContaining('websocket close'))
  })

  it('reports coordinator voice response stream loss for the active pending voice turn', async () => {
    const callbacks = voiceLifecycleCallbacks()
    let failResponseStream!: () => void
    const responseStreamFailed = new Promise<void>((resolve) => { failResponseStream = resolve })
    const assistant = {
      streamVoiceEvents: vi.fn(async function* () {}),
      streamVoiceAssistantResponses: vi.fn(async function* () {
        await responseStreamFailed
        throw new Error('voice response stream lost')
      }),
    }
    const harness = await renderVoiceLifecycleHarness({
      client: { transport: { kind: 'http' }, assistant } as unknown as AuroraClient,
      lifecycleCallbacks: callbacks,
      surfaceProfile: coordinatorVoiceSurfaceProfile(),
    })

    await act(async () => {
      harness.result.voicePendingAssistantIdRef.current = 'voice-pending'
      failResponseStream()
      await flushPromises()
    })

    expect(callbacks.markVoiceAssistantFailed).toHaveBeenCalledWith(
      'voice-pending',
      'Voice response stream disconnected before Aurora returned a final response.'
    )
  })
})

async function renderVoiceHarness(overrides: VoiceHarnessOverrides = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  let result!: UseAssistantVoiceResult
  let currentOverrides = overrides
  function Harness({ options }: { options: VoiceHarnessOverrides }) {
    result = useAssistantVoice(voiceOptions(options))
    return null
  }
  const rerender = (next: VoiceHarnessOverrides) => {
    currentOverrides = { ...currentOverrides, ...next }
    root.render(createElement(Harness, { options: currentOverrides }))
  }

  await act(async () => {
    rerender(overrides)
    await flushPromises()
  })

  return {
    get result() { return result },
    rerender,
  }
}


async function renderVoiceLifecycleHarness(overrides: VoiceHarnessOverrides = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  let result!: UseAssistantVoiceResult
  let currentOverrides = overrides
  function Harness({ options }: { options: VoiceHarnessOverrides }) {
    const hookOptions = voiceOptions(options)
    result = useAssistantVoice(hookOptions)
    useAssistantVoiceLifecycle({
      client: hookOptions.client,
      recentVoiceEvents: hookOptions.recentVoiceEvents,
      surfaceProfile: hookOptions.surfaceProfile,
      nativeVoice: null,
      nativeMobileVoice: hookOptions.nativeMobileVoice,
      sessionAuthScope: 'authenticated:test',
      voice: result,
      lifecycleCallbacks: hookOptions.lifecycleCallbacks,
    })
    return null
  }
  const rerender = (next: VoiceHarnessOverrides) => {
    currentOverrides = { ...currentOverrides, ...next }
    root.render(createElement(Harness, { options: currentOverrides }))
  }

  await act(async () => {
    rerender(overrides)
    await flushPromises()
  })

  return {
    get result() { return result },
    rerender,
  }
}

interface VoiceHarnessOverrides extends Partial<UseAssistantVoiceOptions> {
  remoteRouteId?: string
}

function voiceOptions(overrides: VoiceHarnessOverrides): UseAssistantVoiceOptions {
  const route = routeAvailability('assistant-route')
  const remoteAudioRoute = routeAvailability(overrides.remoteRouteId ?? 'remote-audio')
  return {
    client: clientStub,
    route,
    voiceRoutes: {
      transcription: routeAvailability('transcription'),
      wakeProcess: routeAvailability('wake-process'),
      wakeControl: routeAvailability('wake-control'),
      ttsSynthesize: routeAvailability('tts-synthesize'),
      ttsStop: routeAvailability('tts-stop'),
    },
    nativePlatform: 'web',
    nativeAvailable: false,
    nativePermissions: [],
    nativeCapabilities: [],
    recentVoiceEvents: [],
    surfaceProfile: getAuroraSurfaceProfile({ transportKind: 'http' }),
    nativeMobileVoice: null,
    browserSpeechPacks: null,
    lifecycleCallbacks: voiceLifecycleCallbacks(),
    buildVoiceModel: (input) => voiceModel(input, remoteAudioRoute),
    remoteAudioConsentRouteKey: (candidateRoute) => candidateRoute.item.id,
    idleWaveformBars: () => [0.12, 0.24, 0.12],
    ...overrides,
  }
}

const clientStub = {
  transport: { kind: 'http' },
} as unknown as AuroraClient

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

function voiceModel(input: AssistantVoiceModelBuilderInput, remoteAudioRoute: RouteAvailability): AssistantVoiceModel {
  const handsFreeSupported = input.nativeMobileBackgroundWakeSupported === true || input.nativeDesktopBackgroundWakeActive === true
  return {
    captureStatus: input.captureStatus,
    consentGranted: input.consentGranted,
    privacyClass: 'raw-audio',
    retentionPolicy: 'Session only',
    sessionTtl: 'This conversation',
    transport: 'Local',
    platformTruth: input.surfaceProfile?.label ?? 'Unknown',
    visualizerSourceLabel: 'Microphone',
    targetLabel: 'Aurora',
    chips: [],
    controls: [
      {
        id: 'background-wake',
        label: 'Hands-free',
        state: handsFreeSupported ? 'available-local' : 'pending',
        enabled: handsFreeSupported,
        reason: handsFreeSupported ? 'Available' : 'Not available',
        route: null,
      },
    ],
    events: [],
    routeSheetRoute: input.route,
    remoteAudioRoute,
    transcriptionRoute: input.voiceRoutes?.transcription ?? input.route,
    speechRoute: input.voiceRoutes?.ttsSynthesize ?? input.route,
    waveformBars: input.waveformBars ?? [],
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}



function voiceRuntimeEvent(input: { id: string | null; sequence: number; text: string }): VoiceRuntimeEvent {
  return {
    id: input.id,
    kind: 'transcription_partial',
    topic: 'voice.transcription.partial',
    sessionId: 'voice-session',
    state: 'running',
    text: input.text,
    occurredAt: '2026-09-16T00:00:00.000Z',
    raw: { sequence: input.sequence },
  } as unknown as VoiceRuntimeEvent
}


function nativeMobileVoiceSurfaceProfile() {
  const base = getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'android' })
  return {
    ...base,
    voiceCapture: {
      ...base.voiceCapture,
      focusedPushToTalkOwner: 'mobile-native' as const,
    },
  }
}

function coordinatorVoiceSurfaceProfile() {
  const base = getAuroraSurfaceProfile({ transportKind: 'http' })
  return {
    ...base,
    voiceCapture: {
      ...base.voiceCapture,
      wakewordOwner: 'coordinator-daemon' as const,
    },
  }
}

function voiceEventControllerOptions(overrides: Partial<AssistantVoiceEventControllerOptions> = {}): AssistantVoiceEventControllerOptions {
  const streamState: AssistantStreamState = { status: 'idle', lastEventId: null, message: null }
  return {
    routeProviderLabel: 'Aurora',
    runtimeProviderLabel: null,
    modelLabel: null,
    runtimeSelectedModelLabel: null,
    localExecutionMessageLabel: 'This device',
    supportsPersistedSessions: false,
    browserLocalTtsVoiceId: undefined,
    activeVoiceSessionRef: { current: null },
    ownedVoiceSessionIdsRef: { current: new Set() },
    coordinatorVoiceSessionIdsRef: { current: new Set() },
    appliedVoiceEventIdsRef: { current: new Set() },
    voicePendingAssistantIdRef: { current: null },
    voiceTranscriptPreviewRef: { current: '' },
    voiceCaptureStatusRef: { current: 'idle' },
    voiceResponseTimeoutRef: { current: null },
    nativeVoiceStatusRef: { current: null },
    nativeVoiceGenerationRef: { current: null },
    nativeDesktopBackgroundWakeActiveRef: { current: false },
    nativeVoicePendingCancelReasonRef: { current: null },
    assistantViewDisposedRef: { current: false },
    browserVoiceRemoteTtsAudioSeenRef: { current: false },
    speakingMessageIdRef: { current: null },
    lastAssistantMessageIdRef: { current: null },
    nativeVoiceAvailable: false,
    setVoiceWaveformBars: vi.fn(),
    setStreamState: vi.fn((update) => typeof update === 'function' ? update(streamState) : update),
    setVoiceCaptureStatus: vi.fn(),
    setNativeVoiceStatusState: vi.fn(),
    setNativeDesktopBackgroundWakeActive: vi.fn(),
    setSpeakingMessageId: vi.fn(),
    setText: vi.fn(),
    setLastPrompt: vi.fn(),
    setLastError: vi.fn(),
    setLastResult: vi.fn(),
    setModelLabel: vi.fn(),
    setRuntimeProviderLabel: vi.fn(),
    setVoiceResponsePendingId: vi.fn(),
    setSession: vi.fn(),
    productAssistantErrorCopy: vi.fn(() => 'Assistant request failed. Try again.'),
    waveformBarsFromLevel: () => [0.1, 0.2, 0.1],
    settleVoicePendingFromObservedText: vi.fn(),
    settleSubstantiveStreamingAssistantMessages: vi.fn(),
    enqueueStreamedTtsAudio: vi.fn(),
    synthesizeBrowserReadAloud: vi.fn(async () => false),
    openPersistedSession: vi.fn(async () => undefined),
    cancelNativeDesktopVoiceGeneration: vi.fn(async () => true),
    ...overrides,
  }
}

function voiceLifecycleCallbacks(): UseAssistantVoiceOptions['lifecycleCallbacks'] {
  const setStreamState = vi.fn((update: SetStateActionShim<AssistantStreamState>) => update)
  return {
    setText: vi.fn(),
    setLastError: vi.fn(),
    setStreamState: setStreamState as unknown as UseAssistantVoiceOptions['lifecycleCallbacks']['setStreamState'],
    productAssistantErrorCopy: (error) => error instanceof Error ? error.message : String(error),
    applyNativeDesktopVoiceStatus: vi.fn(),
    maybeCancelDeferredNativeDesktopVoiceStatus: vi.fn(() => false),
    applyVoiceRuntimeEvent: vi.fn(),
    applyVoiceAssistantResponse: vi.fn(),
    markVoiceAssistantFailed: vi.fn(),
    cancelNativeDesktopVoice: vi.fn(async () => true),
    cancelNativeMobileVoice: vi.fn(async () => true),
    cancelBrowserVoiceCaptureForReason: vi.fn(async () => undefined),
    releaseBrowserVoiceCaptureForLifecycle: vi.fn(),
    toggleLocalCapture: vi.fn(async () => undefined),
    isBrowserVoiceTurnSettling: vi.fn(() => false),
  }
}

type SetStateActionShim<T> = T | ((current: T) => T)
