import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason, NativeDesktopVoiceTrigger } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { RouteAvailability } from './shell-data'
import type { AssistantStreamState, AssistantVoiceModel, VoiceCaptureStatus } from './assistant-view'

type VoiceStatusSetter = (next: VoiceCaptureStatus) => void

export interface NativeCaptureSharedContext {
  assistantViewDisposedRef: MutableRefObject<boolean>
  activeVoiceSessionRef: MutableRefObject<string | null>
  ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  voiceTranscriptPreviewRef: MutableRefObject<string>
  setText: (text: string) => void
  setLastError: Dispatch<SetStateAction<string | null>>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  setVoiceCaptureStatus: VoiceStatusSetter
  startAssistantTurn: (prompt: string) => Promise<boolean>
  remoteAudioConsentForCurrentRoute: (route?: RouteAvailability) => boolean | null
  voiceModel: AssistantVoiceModel
}

export interface NativeDesktopCaptureContext extends NativeCaptureSharedContext {
  nativeVoice: NativeDesktopVoicePort | null
  nativeVoiceStatusRef: MutableRefObject<NativeDesktopVoiceStatus | null>
  nativeVoiceGenerationRef: MutableRefObject<number | null>
  nativeDesktopBackgroundWakeActiveRef: MutableRefObject<boolean>
  nativeVoiceOperationTokenRef: MutableRefObject<number>
  nativeVoicePendingCancelReasonRef: MutableRefObject<NativeDesktopVoiceStopReason | null>
  nativeVoiceCancelledGenerationsRef: MutableRefObject<Set<number>>
  setNativeVoiceStatusState: (status: NativeDesktopVoiceStatus | null) => void
  setNativeDesktopBackgroundWakeActive: (active: boolean) => void
  applyNativeDesktopVoiceStatus: (status: NativeDesktopVoiceStatus) => void
}

export interface NativeMobileCaptureContext extends NativeCaptureSharedContext {
  nativeMobileVoice: NativeMobileVoicePort | null
  nativeMobileVoiceOperationTokenRef: MutableRefObject<number>
  nativeMobileVoiceStartInFlightRef: MutableRefObject<boolean>
  nativeMobileBackgroundWakeActiveRef: MutableRefObject<boolean>
  setNativeMobileBackgroundWakeActive: (active: boolean) => void
}

export function createNativeDesktopCaptureController(ctx: NativeDesktopCaptureContext) {
  async function startNativeDesktopVoice(trigger: NativeDesktopVoiceTrigger = 'focused_push_to_talk'): Promise<boolean> {
    const remoteAudioConsent = ctx.remoteAudioConsentForCurrentRoute(ctx.voiceModel.transcriptionRoute)
    if (remoteAudioConsent === null) return false
    if (!ctx.nativeVoice) {
      ctx.nativeVoiceStatusRef.current = null
      ctx.nativeVoiceGenerationRef.current = null
      ctx.setNativeVoiceStatusState(null)
      ctx.nativeDesktopBackgroundWakeActiveRef.current = false
      ctx.setNativeDesktopBackgroundWakeActive(false)
      ctx.setVoiceCaptureStatus('no-device')
      ctx.setLastError('Voice is unavailable in this desktop app.')
      ctx.setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice is unavailable in this desktop app.' }))
      return false
    }
    const token = ctx.nativeVoiceOperationTokenRef.current + 1
    ctx.nativeVoiceOperationTokenRef.current = token
    ctx.nativeVoicePendingCancelReasonRef.current = null
    ctx.nativeVoiceCancelledGenerationsRef.current.clear()
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: trigger === 'background_wake' ? 'Starting hands-free voice...' : 'Starting voice...' }))
    try {
      const status = await ctx.nativeVoice.start({ trigger, remoteAudioConsent })
      const pendingReason = ctx.nativeVoicePendingCancelReasonRef.current
      if (ctx.assistantViewDisposedRef.current || ctx.nativeVoiceOperationTokenRef.current !== token || pendingReason !== null) {
        const reason = pendingReason ?? (ctx.assistantViewDisposedRef.current ? 'shutdown' : 'user_request')
        let cancelled = status.generation === null
        if (status.generation !== null) {
          cancelled = await cancelNativeDesktopVoiceGeneration(status.generation, reason)
          if (!cancelled && ctx.assistantViewDisposedRef.current && reason === 'shutdown') {
            void retryDetachedNativeDesktopVoiceCancel(ctx.nativeVoice, status.generation, reason)
          }
        }
        if (ctx.nativeVoiceOperationTokenRef.current === token) {
          if (cancelled) {
            ctx.nativeVoiceGenerationRef.current = null
            ctx.nativeVoiceStatusRef.current = null
            ctx.setNativeVoiceStatusState(null)
            ctx.nativeDesktopBackgroundWakeActiveRef.current = false
            ctx.setNativeDesktopBackgroundWakeActive(false)
            ctx.nativeVoicePendingCancelReasonRef.current = null
            if (!ctx.assistantViewDisposedRef.current) {
              ctx.setVoiceCaptureStatus('idle')
              ctx.activeVoiceSessionRef.current = null
              ctx.ownedVoiceSessionIdsRef.current.clear()
              ctx.coordinatorVoiceSessionIdsRef.current.clear()
            }
          } else {
            ctx.nativeVoiceGenerationRef.current = status.generation
            ctx.nativeVoiceStatusRef.current = status
            if (status.generation !== null) {
              const sessionId = `native-desktop-${status.generation}`
              ctx.activeVoiceSessionRef.current = sessionId
              ctx.ownedVoiceSessionIdsRef.current.add(sessionId)
            }
            if (!ctx.assistantViewDisposedRef.current) {
              ctx.setVoiceCaptureStatus('error')
              ctx.setLastError('Voice could not stop cleanly. Try again.')
              ctx.setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not stop cleanly. Try again.' }))
            }
          }
        }
        return false
      }
      ctx.applyNativeDesktopVoiceStatus(status)
      if (trigger === 'background_wake' && status.available && status.phase !== 'unavailable' && status.phase !== 'faulted' && status.generation !== null) {
        ctx.nativeDesktopBackgroundWakeActiveRef.current = true
        ctx.setNativeDesktopBackgroundWakeActive(true)
      }
      if (!status.available || status.phase === 'unavailable') {
        ctx.setLastError('Voice is unavailable in this desktop app.')
        ctx.setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice is unavailable in this desktop app.' }))
        return false
      }
      if (status.phase === 'faulted') return false
      return true
    } catch {
      ctx.nativeVoiceStatusRef.current = null
      ctx.nativeVoiceGenerationRef.current = null
      ctx.setNativeVoiceStatusState(null)
      ctx.nativeDesktopBackgroundWakeActiveRef.current = false
      ctx.setNativeDesktopBackgroundWakeActive(false)
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      ctx.coordinatorVoiceSessionIdsRef.current.clear()
      if (!ctx.assistantViewDisposedRef.current && ctx.nativeVoiceOperationTokenRef.current === token) {
        ctx.setVoiceCaptureStatus('error')
        ctx.setLastError('Voice could not start. Check this device and try again.')
        ctx.setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not start. Check this device and try again.' }))
      }
      return false
    }
  }

  async function finishNativeDesktopVoice(): Promise<boolean> {
    const generation = ctx.nativeVoiceGenerationRef.current
    if (!ctx.nativeVoice || generation === null) {
      ctx.setVoiceCaptureStatus('idle')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      return false
    }
    ctx.setVoiceCaptureStatus('processing')
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    try {
      ctx.applyNativeDesktopVoiceStatus(await ctx.nativeVoice.finish({ generation, reason: 'user_request' }))
      ctx.nativeDesktopBackgroundWakeActiveRef.current = false
      ctx.setNativeDesktopBackgroundWakeActive(false)
      return true
    } catch {
      ctx.setVoiceCaptureStatus('error')
      ctx.setLastError('Voice could not stop cleanly. Try again.')
      return false
    }
  }

  async function toggleNativeDesktopBackgroundWake(): Promise<boolean> {
    const control = ctx.voiceModel.controls.find((candidate) => candidate.id === 'background-wake')
    if (!control?.enabled && !ctx.nativeDesktopBackgroundWakeActiveRef.current) return false
    if (ctx.nativeDesktopBackgroundWakeActiveRef.current) return cancelNativeDesktopVoice('user_request')
    return startNativeDesktopVoice('background_wake')
  }

  async function cancelNativeDesktopVoiceGeneration(generation: number, reason: NativeDesktopVoiceStopReason): Promise<boolean> {
    if (!ctx.nativeVoice || ctx.nativeVoiceCancelledGenerationsRef.current.has(generation)) return false
    try {
      await ctx.nativeVoice.cancel({ generation, reason })
      ctx.nativeVoiceCancelledGenerationsRef.current.add(generation)
      ctx.nativeDesktopBackgroundWakeActiveRef.current = false
      ctx.setNativeDesktopBackgroundWakeActive(false)
      return true
    } catch {
      return false
    }
  }

  async function retryDetachedNativeDesktopVoiceCancel(port: NativeDesktopVoicePort, generation: number, reason: NativeDesktopVoiceStopReason): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await Promise.resolve()
      try {
        await port.cancel({ generation, reason })
        ctx.nativeVoiceCancelledGenerationsRef.current.add(generation)
        ctx.nativeDesktopBackgroundWakeActiveRef.current = false
        ctx.setNativeDesktopBackgroundWakeActive(false)
        return true
      } catch {}
    }
    return false
  }

  async function cancelNativeDesktopVoice(reason: NativeDesktopVoiceStopReason): Promise<boolean> {
    ctx.nativeVoicePendingCancelReasonRef.current = reason
    const generation = ctx.nativeVoiceGenerationRef.current
    if (!ctx.nativeVoice || generation === null) return false
    ctx.nativeVoiceOperationTokenRef.current += 1
    try {
      const status = await ctx.nativeVoice.cancel({ generation, reason })
      ctx.nativeVoiceCancelledGenerationsRef.current.add(generation)
      ctx.nativeDesktopBackgroundWakeActiveRef.current = false
      ctx.setNativeDesktopBackgroundWakeActive(false)
      ctx.applyNativeDesktopVoiceStatus(status)
      ctx.nativeVoicePendingCancelReasonRef.current = null
      return true
    } catch {
      ctx.setVoiceCaptureStatus('error')
      ctx.setLastError('Voice could not stop cleanly. Try again.')
      return false
    }
  }

  return {
    startNativeDesktopVoice,
    finishNativeDesktopVoice,
    toggleNativeDesktopBackgroundWake,
    cancelNativeDesktopVoice,
    cancelNativeDesktopVoiceGeneration,
    retryDetachedNativeDesktopVoiceCancel,
  }
}

export function createNativeMobileCaptureController(ctx: NativeMobileCaptureContext) {
  function nativeMobileVoiceStartFailureCopy(reasonCode: string | null | undefined): string {
    switch (reasonCode) {
      case 'local_speech_setup_required':
      case 'voice_route_profile_missing':
      case 'native_voice_runtime_missing':
        return 'Finish voice setup on this device, then try again.'
      case 'microphone_permission_missing':
        return 'Allow microphone access for Aurora, then try again.'
      case 'notification_delivery_unavailable':
        return 'Allow notifications for Aurora so voice can stay active.'
      case 'foreground_service_manifest_missing':
        return 'This Android build cannot start device voice.'
      default:
        return 'Voice could not start. Check microphone access on this device.'
    }
  }

  async function startNativeMobileVoice(): Promise<boolean> {
    const remoteAudioConsent = ctx.remoteAudioConsentForCurrentRoute(ctx.voiceModel.transcriptionRoute)
    if (remoteAudioConsent === null) return false
    if (!ctx.nativeMobileVoice) {
      ctx.setVoiceCaptureStatus('no-device')
      ctx.setLastError('Voice is unavailable on this device.')
      return false
    }
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Starting voice...' }))
    const operationToken = ++ctx.nativeMobileVoiceOperationTokenRef.current
    ctx.nativeMobileVoiceStartInFlightRef.current = true
    try {
      const status = await ctx.nativeMobileVoice.start({ remoteAudioConsent })
      if (ctx.assistantViewDisposedRef.current || operationToken !== ctx.nativeMobileVoiceOperationTokenRef.current) {
        await ctx.nativeMobileVoice.cancel().catch(() => undefined)
        return false
      }
      if (!status.available || status.phase === 'unavailable' || status.phase === 'faulted') {
        ctx.setVoiceCaptureStatus('error')
        ctx.setLastError(nativeMobileVoiceStartFailureCopy(status.reasonCode))
        return false
      }
      ctx.setVoiceCaptureStatus('listening')
      ctx.nativeMobileBackgroundWakeActiveRef.current = false
      ctx.setNativeMobileBackgroundWakeActive(false)
      ctx.activeVoiceSessionRef.current = 'native-mobile-focused'
      ctx.ownedVoiceSessionIdsRef.current.add('native-mobile-focused')
      return true
    } catch {
      if (ctx.assistantViewDisposedRef.current || operationToken !== ctx.nativeMobileVoiceOperationTokenRef.current) return false
      ctx.setVoiceCaptureStatus('error')
      ctx.setLastError('Voice could not start. Check microphone access on this device.')
      return false
    } finally {
      if (operationToken === ctx.nativeMobileVoiceOperationTokenRef.current) ctx.nativeMobileVoiceStartInFlightRef.current = false
    }
  }

  async function finishNativeMobileVoice(): Promise<boolean> {
    if (!ctx.nativeMobileVoice) return false
    ctx.setVoiceCaptureStatus('processing')
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    try {
      const status = await ctx.nativeMobileVoice.finish()
      if (status.phase === 'faulted') {
        ctx.setVoiceCaptureStatus('error')
        ctx.setLastError(status.reasonCode === 'focused_voice_timeout' ? 'Voice transcription took too long. Try again.' : 'Voice could not finish cleanly. Try again.')
        return false
      }
      const transcript = ctx.nativeMobileVoice.takeTranscript ? await ctx.nativeMobileVoice.takeTranscript() : null
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      if (ctx.nativeMobileVoice.takeTranscript) {
        if (!transcript) {
          ctx.setVoiceCaptureStatus('idle')
          ctx.setLastError('No speech was transcribed from the recording.')
          return false
        }
        ctx.voiceTranscriptPreviewRef.current = ''
        ctx.setText('')
        const succeeded = await ctx.startAssistantTurn(transcript)
        ctx.setVoiceCaptureStatus(succeeded ? 'idle' : 'error')
        return succeeded
      }
      ctx.setVoiceCaptureStatus('idle')
      return true
    } catch {
      ctx.setVoiceCaptureStatus('error')
      ctx.setLastError('Voice could not finish cleanly. Try again.')
      return false
    }
  }

  async function cancelNativeMobileVoice(options: { updateUi?: boolean } = {}): Promise<boolean> {
    if (!ctx.nativeMobileVoice) return false
    ctx.nativeMobileVoiceOperationTokenRef.current += 1
    const updateUi = options.updateUi !== false
    try {
      await ctx.nativeMobileVoice.cancel()
      ctx.nativeMobileBackgroundWakeActiveRef.current = false
      ctx.setNativeMobileBackgroundWakeActive(false)
      if (updateUi) ctx.setVoiceCaptureStatus('idle')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      return true
    } catch {
      if (updateUi) {
        ctx.setVoiceCaptureStatus('error')
        ctx.setLastError('Voice could not stop cleanly. Try again.')
      }
      return false
    }
  }

  return {
    startNativeMobileVoice,
    finishNativeMobileVoice,
    cancelNativeMobileVoice,
    nativeMobileVoiceStartFailureCopy,
  }
}

export type NativeDesktopCaptureController = ReturnType<typeof createNativeDesktopCaptureController>
export type NativeMobileCaptureController = ReturnType<typeof createNativeMobileCaptureController>
