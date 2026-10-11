import { useCallback, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AssistantStreamUpdate } from '@aurora/client'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type { NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { AuroraBrowserVoiceRuntimeInstance } from './assistant-browser-voice-runtime'
import type { BrowserVoiceTurnSettlement } from './use-assistant-browser-capture'
import {
  createAssistantCaptureController,
  type AssistantCaptureController,
  type AssistantCaptureControllerContext,
} from './use-assistant-capture-controller'
import type {
  AssistantVoiceEventController,
  AssistantVoiceEventControllerOptions,
} from './assistant-voice-event-controller-types'
import { createAssistantVoiceEventController } from './use-assistant-voice-events'
import type { AssistantTurnsTtsCallbacks } from './use-assistant-turns'

export interface AssistantControllerBridgeConnectOptions {
  readonly voiceEvents: AssistantVoiceEventControllerOptions
  readonly capture: AssistantCaptureControllerContext
}

export interface AssistantControllerBridge {
  readonly browserVoiceRuntimeRef: MutableRefObject<AuroraBrowserVoiceRuntimeInstance | null>
  readonly browserVoiceRuntimeEventUnsubscribeRef: MutableRefObject<(() => void) | null>
  readonly browserVoiceOperationTokenRef: MutableRefObject<number>
  readonly browserVoiceTurnSettlementRef: MutableRefObject<BrowserVoiceTurnSettlement | null>
  readonly captureControllerRef: MutableRefObject<AssistantCaptureController | null>
  readonly assistantViewDisposedRef: MutableRefObject<boolean>
  readonly assistantTurnsTtsCallbacksRef: MutableRefObject<AssistantTurnsTtsCallbacks | null>
  readonly assistantVoiceEventControllerRef: MutableRefObject<AssistantVoiceEventController | null>
  readonly localConfirmationOrchestratorsRef: MutableRefObject<Map<string, LightweightOrchestrator>>
  readonly connect: (options: AssistantControllerBridgeConnectOptions) => void
  readonly applyVoiceRuntimeEvent: AssistantVoiceEventController['applyVoiceRuntimeEvent']
  readonly applyVoiceAssistantResponse: AssistantVoiceEventController['applyVoiceAssistantResponse']
  readonly applyNativeDesktopVoiceStatus: AssistantVoiceEventController['applyNativeDesktopVoiceStatus']
  readonly maybeCancelDeferredNativeDesktopVoiceStatus: AssistantVoiceEventController['maybeCancelDeferredNativeDesktopVoiceStatus']
  readonly armVoiceResponseTimeout: AssistantVoiceEventController['armVoiceResponseTimeout']
  readonly clearVoiceResponseTimeout: AssistantVoiceEventController['clearVoiceResponseTimeout']
  readonly markVoiceAssistantFailed: AssistantVoiceEventController['markVoiceAssistantFailed']
  readonly toggleNativeDesktopBackgroundWake: () => Promise<boolean>
  readonly cancelNativeDesktopVoiceGeneration: (generation: number, reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  readonly cancelNativeDesktopVoice: (reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  readonly cancelNativeMobileVoice: (options?: { updateUi?: boolean }) => Promise<boolean>
  readonly releaseBrowserVoiceCaptureForLifecycle: () => void
  readonly releaseBrowserVoiceCaptureForReason: (reason: string) => void
  readonly cancelBrowserVoiceCaptureForReason: (reason: string) => Promise<void>
  readonly browserVoiceRuntime: () => Promise<AuroraBrowserVoiceRuntimeInstance>
  readonly clearBrowserVoiceRuntimeEventSubscription: () => void
  readonly cancelBrowserVoiceRuntime: (reason: string) => Promise<void>
  readonly settleBrowserVoiceTurn: (
    token: number,
    outcome: 'complete' | 'abandon' | 'cancel',
    reason?: string,
  ) => Promise<{ claimed: boolean; succeeded: boolean; current: boolean }>
  readonly waitForBrowserVoiceTurnSettlement: (token: number) => Promise<void>
  readonly disposeBrowserVoiceRuntime: () => Promise<void>
  readonly toggleLocalCapture: () => Promise<void>
  readonly isBrowserVoiceTurnSettling: () => boolean
}

export function useAssistantControllerBridge(): AssistantControllerBridge {
  const browserVoiceRuntimeRef = useRef<AuroraBrowserVoiceRuntimeInstance | null>(null)
  const browserVoiceRuntimeEventUnsubscribeRef = useRef<(() => void) | null>(null)
  const browserVoiceOperationTokenRef = useRef(0)
  const browserVoiceTurnSettlementRef = useRef<BrowserVoiceTurnSettlement | null>(null)
  const captureControllerRef = useRef<AssistantCaptureController | null>(null)
  const assistantViewDisposedRef = useRef(false)
  const assistantTurnsTtsCallbacksRef = useRef<AssistantTurnsTtsCallbacks | null>(null)
  const assistantVoiceEventControllerRef = useRef<AssistantVoiceEventController | null>(null)
  const localConfirmationOrchestratorsRef = useRef<Map<string, LightweightOrchestrator>>(new Map())

  const currentCaptureController = useCallback((): AssistantCaptureController | null => captureControllerRef.current, [])

  const connect = useCallback((options: AssistantControllerBridgeConnectOptions) => {
    assistantVoiceEventControllerRef.current = createAssistantVoiceEventController(options.voiceEvents)
    captureControllerRef.current = createAssistantCaptureController(options.capture)
  }, [])

  const applyVoiceRuntimeEvent = useCallback<AssistantVoiceEventController['applyVoiceRuntimeEvent']>((event) => {
    assistantVoiceEventControllerRef.current?.applyVoiceRuntimeEvent(event)
  }, [])

  const applyVoiceAssistantResponse = useCallback<AssistantVoiceEventController['applyVoiceAssistantResponse']>((update: AssistantStreamUpdate) => {
    assistantVoiceEventControllerRef.current?.applyVoiceAssistantResponse(update)
  }, [])

  const applyNativeDesktopVoiceStatus = useCallback<AssistantVoiceEventController['applyNativeDesktopVoiceStatus']>((status: NativeDesktopVoiceStatus) => {
    assistantVoiceEventControllerRef.current?.applyNativeDesktopVoiceStatus(status)
  }, [])

  const maybeCancelDeferredNativeDesktopVoiceStatus = useCallback<AssistantVoiceEventController['maybeCancelDeferredNativeDesktopVoiceStatus']>((status: NativeDesktopVoiceStatus) => {
    return assistantVoiceEventControllerRef.current?.maybeCancelDeferredNativeDesktopVoiceStatus(status) ?? false
  }, [])

  const armVoiceResponseTimeout = useCallback<AssistantVoiceEventController['armVoiceResponseTimeout']>((pendingId: string) => {
    assistantVoiceEventControllerRef.current?.armVoiceResponseTimeout(pendingId)
  }, [])

  const clearVoiceResponseTimeout = useCallback<AssistantVoiceEventController['clearVoiceResponseTimeout']>(() => {
    assistantVoiceEventControllerRef.current?.clearVoiceResponseTimeout()
  }, [])

  const markVoiceAssistantFailed = useCallback<AssistantVoiceEventController['markVoiceAssistantFailed']>((pendingId: string, failureCopy: string) => {
    assistantVoiceEventControllerRef.current?.markVoiceAssistantFailed(pendingId, failureCopy)
  }, [])

  const toggleNativeDesktopBackgroundWake = useCallback(async (): Promise<boolean> => {
    return await currentCaptureController()?.toggleNativeDesktopBackgroundWake() ?? false
  }, [currentCaptureController])

  const cancelNativeDesktopVoiceGeneration = useCallback(async (generation: number, reason: NativeDesktopVoiceStopReason): Promise<boolean> => {
    return await currentCaptureController()?.cancelNativeDesktopVoiceGeneration(generation, reason) ?? false
  }, [currentCaptureController])

  const cancelNativeDesktopVoice = useCallback(async (reason: NativeDesktopVoiceStopReason): Promise<boolean> => {
    return await currentCaptureController()?.cancelNativeDesktopVoice(reason) ?? false
  }, [currentCaptureController])

  const cancelNativeMobileVoice = useCallback(async (options: { updateUi?: boolean } = {}): Promise<boolean> => {
    return await currentCaptureController()?.cancelNativeMobileVoice(options) ?? false
  }, [currentCaptureController])

  const releaseBrowserVoiceCaptureForLifecycle = useCallback(() => {
    currentCaptureController()?.releaseBrowserVoiceCaptureForLifecycle()
  }, [currentCaptureController])

  const releaseBrowserVoiceCaptureForReason = useCallback((reason: string) => {
    currentCaptureController()?.releaseBrowserVoiceCaptureForReason(reason)
  }, [currentCaptureController])

  const cancelBrowserVoiceCaptureForReason = useCallback(async (reason: string): Promise<void> => {
    await currentCaptureController()?.cancelBrowserVoiceCaptureForReason(reason)
  }, [currentCaptureController])

  const browserVoiceRuntime = useCallback(async (): Promise<AuroraBrowserVoiceRuntimeInstance> => {
    const controller = currentCaptureController()
    if (!controller) throw new Error('Voice is starting. Try again.')
    return await controller.browserVoiceRuntime()
  }, [currentCaptureController])

  const clearBrowserVoiceRuntimeEventSubscription = useCallback(() => {
    currentCaptureController()?.clearBrowserVoiceRuntimeEventSubscription()
  }, [currentCaptureController])

  const cancelBrowserVoiceRuntime = useCallback(async (reason: string): Promise<void> => {
    await currentCaptureController()?.cancelBrowserVoiceRuntime(reason)
  }, [currentCaptureController])

  const settleBrowserVoiceTurn = useCallback(async (
    token: number,
    outcome: 'complete' | 'abandon' | 'cancel',
    reason = 'cancelled',
  ): Promise<{ claimed: boolean; succeeded: boolean; current: boolean }> => {
    return await currentCaptureController()?.settleBrowserVoiceTurn(token, outcome, reason)
      ?? { claimed: false, succeeded: true, current: browserVoiceOperationTokenRef.current === token }
  }, [currentCaptureController])

  const waitForBrowserVoiceTurnSettlement = useCallback(async (token: number): Promise<void> => {
    await currentCaptureController()?.waitForBrowserVoiceTurnSettlement(token)
  }, [currentCaptureController])

  const disposeBrowserVoiceRuntime = useCallback(async (): Promise<void> => {
    await currentCaptureController()?.disposeBrowserVoiceRuntime()
  }, [currentCaptureController])

  const toggleLocalCapture = useCallback(async (): Promise<void> => {
    await currentCaptureController()?.toggleLocalCapture()
  }, [currentCaptureController])

  const isBrowserVoiceTurnSettling = useCallback((): boolean => {
    return browserVoiceTurnSettlementRef.current?.state === 'settling'
  }, [])

  return {
    browserVoiceRuntimeRef,
    browserVoiceRuntimeEventUnsubscribeRef,
    browserVoiceOperationTokenRef,
    browserVoiceTurnSettlementRef,
    captureControllerRef,
    assistantViewDisposedRef,
    assistantTurnsTtsCallbacksRef,
    assistantVoiceEventControllerRef,
    localConfirmationOrchestratorsRef,
    connect,
    applyVoiceRuntimeEvent,
    applyVoiceAssistantResponse,
    applyNativeDesktopVoiceStatus,
    maybeCancelDeferredNativeDesktopVoiceStatus,
    armVoiceResponseTimeout,
    clearVoiceResponseTimeout,
    markVoiceAssistantFailed,
    toggleNativeDesktopBackgroundWake,
    cancelNativeDesktopVoiceGeneration,
    cancelNativeDesktopVoice,
    cancelNativeMobileVoice,
    releaseBrowserVoiceCaptureForLifecycle,
    releaseBrowserVoiceCaptureForReason,
    cancelBrowserVoiceCaptureForReason,
    browserVoiceRuntime,
    clearBrowserVoiceRuntimeEventSubscription,
    cancelBrowserVoiceRuntime,
    settleBrowserVoiceTurn,
    waitForBrowserVoiceTurnSettlement,
    disposeBrowserVoiceRuntime,
    toggleLocalCapture,
    isBrowserVoiceTurnSettling,
  }
}
