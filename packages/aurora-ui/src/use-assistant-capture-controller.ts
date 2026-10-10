import type { AuroraClient, AssistantRoutePolicy, AuroraError } from '@aurora/client'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { RouteAvailability } from './shell-data'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { AssistantStreamState, AssistantVoiceModel, VoiceCaptureStatus } from './assistant-view'
import type { ReadyBrowserSpeechPacksRuntimeStatus } from './use-assistant-voice'
import { createBrowserCaptureController, type BrowserVoiceTurnSettlement } from './use-assistant-browser-capture'
import { createNativeDesktopCaptureController, createNativeMobileCaptureController } from './use-assistant-native-capture'
import type { AuroraBrowserVoiceRuntimeInstance } from './assistant-browser-voice-runtime'

export interface AssistantCaptureControllerContext {
  client: AuroraClient
  surfaceProfile: AuroraSurfaceProfile
  nativeVoice: NativeDesktopVoicePort | null
  nativeMobileVoice: NativeMobileVoicePort | null
  readyBrowserSpeechPacks: ReadyBrowserSpeechPacksRuntimeStatus | null
  voiceModel: AssistantVoiceModel
  usesNativeDesktopVoice: boolean
  usesNativeMobileVoice: boolean
  usesFocusedBrowserVoiceRuntime: boolean
  assistantViewDisposedRef: MutableRefObject<boolean>
  activeVoiceSessionRef: MutableRefObject<string | null>
  ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  voicePendingAssistantIdRef: MutableRefObject<string | null>
  voiceTranscriptPreviewRef: MutableRefObject<string>
  voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  nativeVoiceStatusRef: MutableRefObject<NativeDesktopVoiceStatus | null>
  nativeVoiceGenerationRef: MutableRefObject<number | null>
  nativeDesktopBackgroundWakeActiveRef: MutableRefObject<boolean>
  nativeVoiceOperationTokenRef: MutableRefObject<number>
  nativeVoicePendingCancelReasonRef: MutableRefObject<NativeDesktopVoiceStopReason | null>
  nativeVoiceCancelledGenerationsRef: MutableRefObject<Set<number>>
  nativeMobileVoiceOperationTokenRef: MutableRefObject<number>
  nativeMobileVoiceStartInFlightRef: MutableRefObject<boolean>
  nativeMobileBackgroundWakeActiveRef: MutableRefObject<boolean>
  browserVoiceRuntimeRef: MutableRefObject<AuroraBrowserVoiceRuntimeInstance | null>
  browserVoiceRuntimeEventUnsubscribeRef: MutableRefObject<(() => void) | null>
  browserVoiceOperationTokenRef: MutableRefObject<number>
  browserVoiceTurnSettlementRef: MutableRefObject<BrowserVoiceTurnSettlement | null>
  browserVoiceLocalTranscriptRef: MutableRefObject<string>
  setText: (text: string) => void
  setLastError: Dispatch<SetStateAction<string | null>>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  setVoiceCaptureStatus: (next: VoiceCaptureStatus) => void
  setVoiceEvents: Dispatch<SetStateAction<import('@aurora/client').VoiceRuntimeEvent[]>>
  setVoiceResponsePendingId: (pendingId: string | null) => void
  setVoiceWaveformBars: Dispatch<SetStateAction<number[]>>
  setNativeVoiceStatusState: (status: NativeDesktopVoiceStatus | null) => void
  setNativeDesktopBackgroundWakeActive: (active: boolean) => void
  setNativeMobileBackgroundWakeActive: (active: boolean) => void
  remoteAudioConsentForCurrentRoute: (route?: RouteAvailability) => boolean | null
  defaultVoiceRoutePolicy: (route: RouteAvailability) => AssistantRoutePolicy | null
  routePolicyFromRoute: (route: RouteAvailability) => AssistantRoutePolicy
  productAssistantErrorCopy: (error: AuroraError | Error) => string
  applyNativeDesktopVoiceStatus: (status: NativeDesktopVoiceStatus) => void
  interruptTtsForVoiceCapture: () => Promise<void>
  startAssistantTurn: (prompt: string) => Promise<boolean>
  waveformBarsFromLevel: (level: number, peak: number) => number[]
  mergeVoiceRuntimeEvents: (...groups: import('@aurora/client').VoiceRuntimeEvent[][]) => import('@aurora/client').VoiceRuntimeEvent[]
}

export function createAssistantCaptureController(ctx: AssistantCaptureControllerContext) {
  const nativeDesktop = createNativeDesktopCaptureController(ctx)
  const nativeMobile = createNativeMobileCaptureController(ctx)
  const browser = createBrowserCaptureController(ctx)

  async function startCoordinatorPushToTalk(sessionId: string, options: { fallback?: boolean } = {}): Promise<boolean> {
    ctx.activeVoiceSessionRef.current = sessionId
    ctx.ownedVoiceSessionIdsRef.current.add(sessionId)
    ctx.setVoiceCaptureStatus('listening')
    ctx.setStreamState((current) => ({
      ...current,
      status: 'streaming',
      message: options.fallback
        ? 'Focused microphone access was unavailable; Aurora is listening on this computer instead.'
        : 'Starting microphone listening on this computer...'
    }))
    try {
      const started = await ctx.client.assistant.startVoiceListen({
        sessionId,
        timeoutMs: 8_000,
        routePolicy: ctx.routePolicyFromRoute(ctx.voiceModel.transcriptionRoute)
      })
      if (!started.ok) {
        ctx.activeVoiceSessionRef.current = null
        ctx.ownedVoiceSessionIdsRef.current.delete(sessionId)
        ctx.setLastError(ctx.productAssistantErrorCopy(started.error))
        ctx.setVoiceCaptureStatus('error')
        ctx.setStreamState((current) => ({ ...current, status: 'lost', message: ctx.productAssistantErrorCopy(started.error) }))
        return false
      }
      ctx.activeVoiceSessionRef.current = started.data.sessionId
      ctx.ownedVoiceSessionIdsRef.current.add(started.data.sessionId)
      ctx.coordinatorVoiceSessionIdsRef.current.add(started.data.sessionId)
      ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is listening on this computer.' }))
      return true
    } catch (error) {
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.delete(sessionId)
      const message = ctx.productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error)))
      ctx.setLastError(message)
      ctx.setVoiceCaptureStatus('error')
      ctx.setStreamState((current) => ({ ...current, status: 'lost', message }))
      return false
    }
  }

  async function toggleLocalCapture() {
    const currentCaptureStatus = ctx.voiceCaptureStatusRef.current
    if (ctx.usesNativeDesktopVoice && currentCaptureStatus === 'error' && ctx.nativeVoiceGenerationRef.current !== null) {
      await nativeDesktop.cancelNativeDesktopVoice('user_request')
      return
    }
    if (currentCaptureStatus === 'listening') {
      if (ctx.usesNativeDesktopVoice) {
        if (ctx.nativeDesktopBackgroundWakeActiveRef.current) {
          await nativeDesktop.cancelNativeDesktopVoice('user_request')
          return
        }
        await nativeDesktop.finishNativeDesktopVoice()
        return
      }
      if (ctx.usesNativeMobileVoice) {
        await nativeMobile.finishNativeMobileVoice()
        return
      }
      const sessionId = ctx.activeVoiceSessionRef.current
      if (ctx.usesFocusedBrowserVoiceRuntime) {
        await browser.stopBrowserVoiceCapture()
        ctx.coordinatorVoiceSessionIdsRef.current.clear()
        ctx.voicePendingAssistantIdRef.current = null
        ctx.setVoiceResponsePendingId(null)
        return
      }
      const coordinatorOwnsCapture = Boolean(sessionId && ctx.coordinatorVoiceSessionIdsRef.current.has(sessionId))
      if (sessionId && coordinatorOwnsCapture) {
        const stopped = await ctx.client.assistant.stopVoiceListen({
          sessionId,
          reason: 'user_request',
          routePolicy: ctx.routePolicyFromRoute(ctx.voiceModel.transcriptionRoute)
        })
        if (!stopped.ok) ctx.setLastError(ctx.productAssistantErrorCopy(stopped.error))
      }
      ctx.setVoiceCaptureStatus('idle')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      ctx.coordinatorVoiceSessionIdsRef.current.clear()
      ctx.voicePendingAssistantIdRef.current = null
      ctx.setVoiceResponsePendingId(null)
      return
    }
    const sessionId = `voice-${Date.now()}`
    ctx.voiceTranscriptPreviewRef.current = ''
    ctx.setLastError(null)
    if (ctx.surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'unavailable') {
      ctx.setVoiceCaptureStatus('no-device')
      ctx.setLastError('Voice is unavailable on this device right now.')
      return
    }
    if (ctx.remoteAudioConsentForCurrentRoute(ctx.voiceModel.transcriptionRoute) === null) return
    if (!ctx.defaultVoiceRoutePolicy(ctx.voiceModel.transcriptionRoute)) return
    if (ctx.usesNativeDesktopVoice) {
      await nativeDesktop.startNativeDesktopVoice()
      return
    }
    if (ctx.usesNativeMobileVoice) {
      await ctx.interruptTtsForVoiceCapture()
      await nativeMobile.startNativeMobileVoice()
      return
    }
    void ctx.interruptTtsForVoiceCapture()
    if (!ctx.surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) {
      await startCoordinatorPushToTalk(sessionId)
      return
    }
    if (ctx.usesFocusedBrowserVoiceRuntime) {
      await browser.startBrowserVoiceCapture(sessionId)
      return
    }
    ctx.setVoiceCaptureStatus('no-device')
    ctx.setLastError('Voice is unavailable on this device right now.')
  }

  return {
    ...nativeDesktop,
    ...nativeMobile,
    ...browser,
    startCoordinatorPushToTalk,
    toggleLocalCapture,
  }
}

export type AssistantCaptureController = ReturnType<typeof createAssistantCaptureController>
