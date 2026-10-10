'use client'

import { useEffect, useRef } from 'react'
import type { AuroraClient, VoiceRuntimeEvent } from '@aurora/client'
import { AURORA_RELEASE_FOCUSED_MEDIA_EVENT } from './platform-surface'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { UseAssistantVoiceLifecycleCallbacks, UseAssistantVoiceResult } from './use-assistant-voice'

export function useAssistantVoiceLifecycle({
  client,
  recentVoiceEvents,
  surfaceProfile,
  nativeVoice,
  nativeMobileVoice,
  sessionAuthScope,
  voice,
  lifecycleCallbacks,
}: {
  client: AuroraClient
  recentVoiceEvents: VoiceRuntimeEvent[]
  surfaceProfile: AuroraSurfaceProfile
  nativeVoice: NativeDesktopVoicePort | null
  nativeMobileVoice: NativeMobileVoicePort | null
  sessionAuthScope: string
  voice: UseAssistantVoiceResult
  lifecycleCallbacks: UseAssistantVoiceLifecycleCallbacks
}) {
  const {
    voiceCaptureStatus,
    setVoiceCaptureStatus,
    voiceCaptureStatusRef,
    setVoiceEvents,
    setVoiceElapsedSeconds,
    setNativeVoiceStatusState,
    setNativeDesktopBackgroundWakeActive,
    setNativeMobileBackgroundWakeActive,
    activeVoiceSessionRef,
    ownedVoiceSessionIdsRef,
    voiceSessionStartedAtRef,
    coordinatorVoiceSessionIdsRef,
    voicePendingAssistantIdRef,
    nativeVoiceStatusRef,
    nativeVoiceGenerationRef,
    nativeDesktopBackgroundWakeActiveRef,
    nativeMobileBackgroundWakeActiveRef,
    nativeMobileVoiceStartInFlightRef,
    receivesCoordinatorVoiceEvents,
    usesNativeDesktopVoice,
    usesNativeMobileVoice,
  } = voice
  const lifecycleCallbacksRef = useRef(lifecycleCallbacks)
  lifecycleCallbacksRef.current = lifecycleCallbacks

  useEffect(() => {
    if (recentVoiceEvents.length === 0) return
    setVoiceEvents((current) => mergeVoiceRuntimeEvents(recentVoiceEvents, current).slice(0, 12))
  }, [recentVoiceEvents])

  useEffect(() => {
    voiceCaptureStatusRef.current = voiceCaptureStatus
  }, [voiceCaptureStatus])

  useEffect(() => {
    if (!usesNativeDesktopVoice) return
    let active = true
    let unsubscribe: (() => void) | null = null
    if (!nativeVoice) {
      nativeVoiceStatusRef.current = null
      nativeVoiceGenerationRef.current = null
      setNativeVoiceStatusState(null)
      nativeDesktopBackgroundWakeActiveRef.current = false
      setNativeDesktopBackgroundWakeActive(false)
      setVoiceCaptureStatus('no-device')
      lifecycleCallbacksRef.current.setLastError('Voice is unavailable in this desktop app.')
      return
    }
    void (async () => {
      try {
        const status = await nativeVoice.status()
        if (!active) return
        if (!lifecycleCallbacksRef.current.maybeCancelDeferredNativeDesktopVoiceStatus(status)) {
          lifecycleCallbacksRef.current.applyNativeDesktopVoiceStatus(status)
        }
        const nextUnsubscribe = await nativeVoice.subscribe((event) => {
          if (!active) return
          if (lifecycleCallbacksRef.current.maybeCancelDeferredNativeDesktopVoiceStatus(event.status)) return
          lifecycleCallbacksRef.current.applyNativeDesktopVoiceStatus(event.status)
        })
        if (!active) {
          nextUnsubscribe()
          return
        }
        unsubscribe = nextUnsubscribe
      } catch {
        if (!active) return
        nativeVoiceStatusRef.current = null
        nativeVoiceGenerationRef.current = null
        setNativeVoiceStatusState(null)
        nativeDesktopBackgroundWakeActiveRef.current = false
        setNativeDesktopBackgroundWakeActive(false)
        setVoiceCaptureStatus('error')
        lifecycleCallbacksRef.current.setLastError('Voice could not start. Check this device and try again.')
      }
    })()
    return () => {
      active = false
      if (unsubscribe) unsubscribe()
    }
  }, [nativeVoice, usesNativeDesktopVoice])

  useEffect(() => {
    if (!usesNativeMobileVoice || !nativeMobileVoice) return
    let active = true
    void nativeMobileVoice.status().then(async (status) => {
      if (!active) return
      if (status.backgroundActive === true) {
        nativeMobileBackgroundWakeActiveRef.current = true
        setNativeMobileBackgroundWakeActive(true)
      } else if (!status.available) {
        setVoiceCaptureStatus('no-device')
      } else if (status.phase === 'faulted') {
        setVoiceCaptureStatus('error')
      } else if (status.captureActive) {
        setVoiceCaptureStatus('listening')
      }
      const backgroundStatus = await nativeMobileVoice.backgroundStatus?.().catch(() => null)
      if (!active || !backgroundStatus) return
      const backgroundActive = backgroundStatus.backgroundActive === true
      nativeMobileBackgroundWakeActiveRef.current = backgroundActive
      setNativeMobileBackgroundWakeActive(backgroundActive)
    }).catch(() => {
      if (active) {
        setVoiceCaptureStatus('error')
      }
    })
    return () => {
      active = false
    }
  }, [nativeMobileVoice, usesNativeMobileVoice])

  useEffect(() => {
    if (!surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    const releaseFocusedCapture = (event?: Event) => {
      const hidden = document.visibilityState === 'hidden'
      const blurred = typeof document.hasFocus === 'function' && !document.hasFocus()
      const nativeRelease = event?.type === AURORA_RELEASE_FOCUSED_MEDIA_EVENT
      const shouldRelease = usesNativeMobileVoice
        ? hidden || nativeRelease
        : hidden || blurred || nativeRelease
      if (!shouldRelease) return
      const callbacks = lifecycleCallbacksRef.current
      if (usesNativeDesktopVoice) {
        if (nativeDesktopBackgroundWakeActiveRef.current) return
        void callbacks.cancelNativeDesktopVoice('window_hidden')
        return
      }
      if (usesNativeMobileVoice) {
        if (nativeMobileBackgroundWakeActiveRef.current) return
        const ownsFocusedMobileTurn = isUiOwnedNativeMobileFocusedTurnActive(
          activeVoiceSessionRef.current,
          nativeMobileVoiceStartInFlightRef.current
        )
        if (!ownsFocusedMobileTurn) return
        if (nativeRelease) {
          void callbacks.cancelNativeMobileVoice()
          return
        }
        void (async () => {
          const statusRequest = nativeMobileVoice?.status?.()
          const status = statusRequest
            ? await withTimeout(
                statusRequest,
                NATIVE_MOBILE_BACKGROUND_STATUS_TIMEOUT_MS,
                new Error('Native mobile status timed out')
              ).catch(() => null)
            : null
          if (status?.backgroundActive === true) {
            nativeMobileBackgroundWakeActiveRef.current = true
            setNativeMobileBackgroundWakeActive(true)
            return
          }
          if (status && !status.running) return
          const backgroundStatusRequest = nativeMobileVoice?.backgroundStatus?.()
          const backgroundStatus = backgroundStatusRequest
            ? await withTimeout(
                backgroundStatusRequest,
                NATIVE_MOBILE_BACKGROUND_STATUS_TIMEOUT_MS,
                new Error('Native mobile background status timed out')
              ).catch(() => null)
            : null
          if (backgroundStatus?.backgroundActive === true) {
            nativeMobileBackgroundWakeActiveRef.current = true
            setNativeMobileBackgroundWakeActive(true)
            return
          }
          if (nativeMobileBackgroundWakeActiveRef.current) return
          await callbacks.cancelNativeMobileVoice()
        })()
        return
      }
      callbacks.releaseBrowserVoiceCaptureForLifecycle()
    }
    document.addEventListener('visibilitychange', releaseFocusedCapture)
    window.addEventListener('blur', releaseFocusedCapture)
    window.addEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    return () => {
      document.removeEventListener('visibilitychange', releaseFocusedCapture)
      window.removeEventListener('blur', releaseFocusedCapture)
      window.removeEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    }
  }, [nativeMobileVoice, surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk, usesNativeDesktopVoice, usesNativeMobileVoice])

  useEffect(() => {
    const active = voiceCaptureStatus === 'listening' || voiceCaptureStatus === 'processing' || voiceCaptureStatus === 'speaking'
    if (!active) {
      voiceSessionStartedAtRef.current = null
      setVoiceElapsedSeconds(0)
      return
    }
    if (voiceSessionStartedAtRef.current === null) voiceSessionStartedAtRef.current = Date.now()
    const tick = () => {
      const startedAt = voiceSessionStartedAtRef.current ?? Date.now()
      setVoiceElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [voiceCaptureStatus])

  useEffect(() => {
    if (!receivesCoordinatorVoiceEvents) return
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        for await (const event of client.assistant.streamVoiceEvents({ signal: controller.signal })) {
          if (!active) return
          lifecycleCallbacksRef.current.applyVoiceRuntimeEvent(event)
          if (event.kind !== 'audio_level') {
            setVoiceEvents((current) => [event, ...current].slice(0, 12))
          }
        }
      } catch (error) {
        if (active) {
          const message = lifecycleCallbacksRef.current.productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error)))
          const currentVoiceState = voiceCaptureStatusRef.current
          if (currentVoiceState === 'listening' || currentVoiceState === 'processing' || currentVoiceState === 'speaking') {
            lifecycleCallbacksRef.current.setLastError(message)
            lifecycleCallbacksRef.current.setStreamState((current) => ({ ...current, status: 'lost', message }))
          }
          setVoiceEvents((current) => current)
        }
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [client, receivesCoordinatorVoiceEvents, sessionAuthScope])

  useEffect(() => {
    if (!receivesCoordinatorVoiceEvents) return
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        for await (const update of client.assistant.streamVoiceAssistantResponses({ signal: controller.signal })) {
          if (!active) return
          lifecycleCallbacksRef.current.applyVoiceAssistantResponse(update)
        }
      } catch {
        if (active) {
          const pendingId = voicePendingAssistantIdRef.current
          if (pendingId) {
            lifecycleCallbacksRef.current.markVoiceAssistantFailed(pendingId, 'Voice response stream disconnected before Aurora returned a final response.')
          } else {
            lifecycleCallbacksRef.current.setStreamState((current) => current)
          }
        }
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [client, receivesCoordinatorVoiceEvents, sessionAuthScope])

}


const NATIVE_MOBILE_BACKGROUND_STATUS_TIMEOUT_MS = 100

function mergeVoiceRuntimeEvents(...groups: VoiceRuntimeEvent[][]): VoiceRuntimeEvent[] {
  const seen = new Set<string>()
  const merged: VoiceRuntimeEvent[] = []
  for (const group of groups) {
    for (const event of group) {
      const key = voiceRuntimeEventKey(event)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(event)
    }
  }
  return merged
}

function voiceRuntimeEventKey(event: VoiceRuntimeEvent): string {
  const sequence = typeof event.raw.sequence === 'number' || typeof event.raw.sequence === 'string'
    ? String(event.raw.sequence)
    : null
  return event.id ?? `${event.kind}:${event.sessionId ?? 'session'}:${sequence ?? event.text ?? ''}:${event.occurredAt}`
}

function isUiOwnedNativeMobileFocusedTurnActive(
  activeSessionId: string | null,
  startInFlight: boolean
): boolean {
  return startInFlight || activeSessionId === 'native-mobile-focused'
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(timeoutError), ms)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}
