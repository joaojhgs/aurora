import { describe, expect, it, vi } from 'vitest'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoicePort, NativeMobileVoiceStatus } from './native-mobile-voice'
import type { RouteAvailability } from './shell-data'
import type { AssistantStreamState, AssistantVoiceModel, VoiceCaptureStatus } from './assistant-view'
import {
  createNativeDesktopCaptureController,
  createNativeMobileCaptureController,
  type NativeCaptureSharedContext,
  type NativeDesktopCaptureContext,
  type NativeMobileCaptureContext,
} from './use-assistant-native-capture'

describe('native assistant capture controllers', () => {
  it('cancels a delayed native desktop start when the view is disposed before native returns', async () => {
    const start = deferred<NativeDesktopVoiceStatus>()
    const nativeVoice = desktopVoice({ start: vi.fn(() => start.promise) })
    const harness = nativeDesktopHarness({ nativeVoice })
    const controller = createNativeDesktopCaptureController(harness.context)

    const started = controller.startNativeDesktopVoice()
    harness.context.assistantViewDisposedRef.current = true
    start.resolve(desktopStatus({ generation: 7, phase: 'listening' }))

    await expect(started).resolves.toBe(false)
    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 7, reason: 'shutdown' })
    expect(harness.context.nativeVoiceGenerationRef.current).toBeNull()
    expect(harness.context.nativeVoiceStatusRef.current).toBeNull()
    expect(harness.voiceStatuses).not.toContain('error')
    expect(harness.context.ownedVoiceSessionIdsRef.current.size).toBe(0)
  })

  it('retries detached native desktop cancellation after shutdown ownership is lost', async () => {
    const start = deferred<NativeDesktopVoiceStatus>()
    const cancel = vi.fn()
      .mockRejectedValueOnce(new Error('native owner not ready'))
      .mockRejectedValueOnce(new Error('native owner still stopping'))
      .mockResolvedValueOnce(desktopStatus({ generation: 9, phase: 'idle' }))
    const nativeVoice = desktopVoice({ start: vi.fn(() => start.promise), cancel })
    const harness = nativeDesktopHarness({ nativeVoice })
    const controller = createNativeDesktopCaptureController(harness.context)

    const started = controller.startNativeDesktopVoice()
    harness.context.assistantViewDisposedRef.current = true
    start.resolve(desktopStatus({ generation: 9, phase: 'listening' }))

    await expect(started).resolves.toBe(false)
    await flushPromises()

    expect(cancel).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenNthCalledWith(1, { generation: 9, reason: 'shutdown' })
    expect(cancel).toHaveBeenNthCalledWith(2, { generation: 9, reason: 'shutdown' })
    expect(cancel).toHaveBeenNthCalledWith(3, { generation: 9, reason: 'shutdown' })
    expect(harness.context.nativeVoiceCancelledGenerationsRef.current.has(9)).toBe(true)
    expect(harness.context.nativeDesktopBackgroundWakeActiveRef.current).toBe(false)
  })

  it('does not let a stale native mobile start claim the active voice session', async () => {
    const start = deferred<NativeMobileVoiceStatus>()
    const nativeMobileVoice = mobileVoice({ start: vi.fn(() => start.promise) })
    const harness = nativeMobileHarness({ nativeMobileVoice })
    const controller = createNativeMobileCaptureController(harness.context)

    const started = controller.startNativeMobileVoice()
    harness.context.nativeMobileVoiceOperationTokenRef.current += 1
    start.resolve(mobileStatus({ phase: 'listening', running: true, captureActive: true }))

    await expect(started).resolves.toBe(false)
    expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1)
    expect(harness.context.activeVoiceSessionRef.current).toBeNull()
    expect(harness.context.ownedVoiceSessionIdsRef.current.size).toBe(0)
    expect(harness.voiceStatuses).not.toContain('listening')
  })

  it('keeps failed mobile cancellation scoped to the caller update policy', async () => {
    const nativeMobileVoice = mobileVoice({ cancel: vi.fn(async () => { throw new Error('cancel failed') }) })
    const harness = nativeMobileHarness({ nativeMobileVoice })
    harness.context.activeVoiceSessionRef.current = 'native-mobile-focused'
    harness.context.ownedVoiceSessionIdsRef.current.add('native-mobile-focused')
    const controller = createNativeMobileCaptureController(harness.context)

    await expect(controller.cancelNativeMobileVoice({ updateUi: false })).resolves.toBe(false)

    expect(harness.voiceStatuses).toEqual([])
    expect(harness.lastErrors).toEqual([])
    expect(harness.context.activeVoiceSessionRef.current).toBe('native-mobile-focused')
    expect(harness.context.ownedVoiceSessionIdsRef.current.has('native-mobile-focused')).toBe(true)
  })
})

function nativeDesktopHarness(overrides: Partial<NativeDesktopCaptureContext> = {}) {
  const shared = sharedNativeContext()
  const voiceStatuses: VoiceCaptureStatus[] = []
  const nativeStatuses: Array<NativeDesktopVoiceStatus | null> = []
  const backgroundStates: boolean[] = []
  const context: NativeDesktopCaptureContext = {
    ...shared,
    nativeVoice: desktopVoice(),
    nativeVoiceStatusRef: ref<NativeDesktopVoiceStatus | null>(null),
    nativeVoiceGenerationRef: ref<number | null>(null),
    nativeDesktopBackgroundWakeActiveRef: ref(false),
    nativeVoiceOperationTokenRef: ref(0),
    nativeVoicePendingCancelReasonRef: ref<NativeDesktopVoiceStopReason | null>(null),
    nativeVoiceCancelledGenerationsRef: ref(new Set<number>()),
    setVoiceCaptureStatus: (status) => { voiceStatuses.push(status) },
    setNativeVoiceStatusState: (status) => { nativeStatuses.push(status) },
    setNativeDesktopBackgroundWakeActive: (active) => { backgroundStates.push(active) },
    applyNativeDesktopVoiceStatus: (status) => {
      context.nativeVoiceStatusRef.current = status
      context.nativeVoiceGenerationRef.current = status.generation
      nativeStatuses.push(status)
    },
    ...overrides,
  }
  return { context, voiceStatuses, nativeStatuses, backgroundStates }
}

function nativeMobileHarness(overrides: Partial<NativeMobileCaptureContext> = {}) {
  const shared = sharedNativeContext()
  const voiceStatuses: VoiceCaptureStatus[] = []
  const backgroundStates: boolean[] = []
  const lastErrors: Array<string | null> = []
  const context: NativeMobileCaptureContext = {
    ...shared,
    nativeMobileVoice: mobileVoice(),
    nativeMobileVoiceOperationTokenRef: ref(0),
    nativeMobileVoiceStartInFlightRef: ref(false),
    nativeMobileBackgroundWakeActiveRef: ref(false),
    setVoiceCaptureStatus: (status) => { voiceStatuses.push(status) },
    setNativeMobileBackgroundWakeActive: (active) => { backgroundStates.push(active) },
    setLastError: (next) => { lastErrors.push(resolveState(next, lastErrors.length > 0 ? lastErrors[lastErrors.length - 1] ?? null : null)) },
    ...overrides,
  }
  return { context, voiceStatuses, backgroundStates, lastErrors }
}

function sharedNativeContext(): NativeCaptureSharedContext {
  let streamState: AssistantStreamState = { status: 'idle', message: '', lastEventId: null }
  return {
    assistantViewDisposedRef: ref(false),
    activeVoiceSessionRef: ref<string | null>(null),
    ownedVoiceSessionIdsRef: ref(new Set<string>()),
    coordinatorVoiceSessionIdsRef: ref(new Set<string>()),
    voiceTranscriptPreviewRef: ref(''),
    setText: vi.fn(),
    setLastError: vi.fn(),
    setStreamState: (next) => { streamState = resolveState(next, streamState) },
    setVoiceCaptureStatus: vi.fn(),
    startAssistantTurn: vi.fn(async () => true),
    remoteAudioConsentForCurrentRoute: vi.fn(() => true),
    voiceModel: voiceModel(),
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
    controls: [{ id: 'background-wake', label: 'Hands-free', state: 'available-local', enabled: true, reason: 'Ready', route }],
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

function desktopVoice(overrides: Partial<NativeDesktopVoicePort> = {}): NativeDesktopVoicePort {
  return {
    status: vi.fn(async () => desktopStatus()),
    start: vi.fn(async () => desktopStatus({ generation: 1, phase: 'listening' })),
    finish: vi.fn(async () => desktopStatus({ generation: 1, phase: 'processing' })),
    cancel: vi.fn(async ({ generation }) => desktopStatus({ generation, phase: 'idle' })),
    subscribe: vi.fn(async () => vi.fn()),
    ...overrides,
  }
}

function mobileVoice(overrides: Partial<NativeMobileVoicePort> = {}): NativeMobileVoicePort {
  return {
    status: vi.fn(async () => mobileStatus()),
    start: vi.fn(async () => mobileStatus({ phase: 'listening', running: true, captureActive: true })),
    finish: vi.fn(async () => mobileStatus({ phase: 'processing', running: false, captureActive: false })),
    cancel: vi.fn(async () => mobileStatus()),
    ...overrides,
  }
}

function desktopStatus(overrides: Partial<NativeDesktopVoiceStatus> = {}): NativeDesktopVoiceStatus {
  return {
    available: true,
    phase: 'idle',
    generation: null,
    backgroundEligible: true,
    connection: 'this_device',
    reasonCode: null,
    redacted: true,
    ...overrides,
  }
}

function mobileStatus(overrides: Partial<NativeMobileVoiceStatus> = {}): NativeMobileVoiceStatus {
  return {
    available: true,
    phase: 'idle',
    running: false,
    captureActive: false,
    reasonCode: null,
    redacted: true,
    ...overrides,
  }
}

function ref<T>(current: T) {
  return { current }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function resolveState<T>(next: SetStateActionShim<T>, current: T): T {
  return typeof next === 'function' ? (next as (value: T) => T)(current) : next
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

type SetStateActionShim<T> = T | ((current: T) => T)
