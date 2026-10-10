'use client'

import { useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AuroraClient, AssistantStreamUpdate, AuroraError, VoiceRuntimeEvent } from '@aurora/client'
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'
import { isRemoteRouteCandidate, routePolicyFromRoute } from './use-assistant-execution'
import { AURORA_RELEASE_FOCUSED_MEDIA_EVENT } from './platform-surface'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { AuroraBrowserSpeechPacksRuntimeStatus } from './browser-speech-pack'
import type {
  AssistantStreamState,
  AssistantVoiceModel,
  VoiceCaptureStatus,
  VoiceControlModel,
} from './assistant-view'

export type ReadyBrowserSpeechPacksRuntimeStatus = Extract<AuroraBrowserSpeechPacksRuntimeStatus, { state: 'ready' }>

export interface UseAssistantVoiceLifecycleCallbacks {
  setText: (text: string) => void
  setLastError: Dispatch<SetStateAction<string | null>>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  productAssistantErrorCopy: (error: AuroraError | Error) => string
  applyNativeDesktopVoiceStatus: (status: NativeDesktopVoiceStatus) => void
  maybeCancelDeferredNativeDesktopVoiceStatus: (status: NativeDesktopVoiceStatus) => boolean
  applyVoiceRuntimeEvent: (event: VoiceRuntimeEvent) => void
  applyVoiceAssistantResponse: (update: AssistantStreamUpdate) => void
  markVoiceAssistantFailed: (pendingId: string, failureCopy: string) => void
  cancelNativeDesktopVoice: (reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  cancelNativeMobileVoice: (options?: { updateUi?: boolean }) => Promise<boolean>
  cancelBrowserVoiceCaptureForReason: (reason: string) => Promise<void>
  releaseBrowserVoiceCaptureForLifecycle: () => void
  toggleLocalCapture: () => Promise<void>
  isBrowserVoiceTurnSettling: () => boolean
}

export interface AssistantVoiceModelBuilderInput {
  client: AuroraClient
  route: RouteAvailability
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  surfaceProfile?: AuroraSurfaceProfile | undefined
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  nativeDesktopVoiceStatus?: NativeDesktopVoiceStatus | null | undefined
  nativeDesktopBackgroundWakeActive?: boolean | undefined
  nativeMobileBackgroundWakeActive?: boolean | undefined
  nativeMobileBackgroundWakeSupported?: boolean | undefined
  voiceEvents?: VoiceRuntimeEvent[] | undefined
  waveformBars?: number[] | undefined
}

export interface UseAssistantVoiceOptions {
  client: AuroraClient
  route: RouteAvailability
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform: string
  nativeAvailable: boolean
  nativePermissions: Array<{ name: string; granted: boolean }>
  nativeCapabilities: Array<{ name: string; enabled: boolean }>
  recentVoiceEvents: VoiceRuntimeEvent[]
  surfaceProfile: AuroraSurfaceProfile
  nativeMobileVoice: NativeMobileVoicePort | null
  browserSpeechPacks: AuroraBrowserSpeechPacksRuntimeStatus | null
  lifecycleCallbacks: UseAssistantVoiceLifecycleCallbacks
  buildVoiceModel: (input: AssistantVoiceModelBuilderInput) => AssistantVoiceModel
  remoteAudioConsentRouteKey: (route: RouteAvailability) => string
  idleWaveformBars: () => number[]
}

export interface UseAssistantVoiceResult {
  voiceConsentGranted: boolean
  setVoiceConsentGrantedState: (granted: boolean) => void
  voiceCaptureStatus: VoiceCaptureStatus
  setVoiceCaptureStatus: (next: VoiceCaptureStatus) => void
  voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  voiceResponsePendingId: string | null
  setVoiceResponsePendingId: (pendingId: string | null) => void
  voiceEvents: VoiceRuntimeEvent[]
  setVoiceEvents: Dispatch<SetStateAction<VoiceRuntimeEvent[]>>
  voiceWaveformBars: number[]
  setVoiceWaveformBars: Dispatch<SetStateAction<number[]>>
  voiceElapsedSeconds: number
  setVoiceElapsedSeconds: Dispatch<SetStateAction<number>>
  nativeVoiceStatusState: NativeDesktopVoiceStatus | null
  setNativeVoiceStatusState: (status: NativeDesktopVoiceStatus | null) => void
  nativeDesktopBackgroundWakeActive: boolean
  setNativeDesktopBackgroundWakeActive: (active: boolean) => void
  nativeMobileBackgroundWakeActive: boolean
  setNativeMobileBackgroundWakeActive: (active: boolean) => void
  activeVoiceSessionRef: MutableRefObject<string | null>
  ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  voiceSessionStartedAtRef: MutableRefObject<number | null>
  appliedVoiceEventIdsRef: MutableRefObject<Set<string>>
  voicePendingAssistantIdRef: MutableRefObject<string | null>
  voiceTranscriptPreviewRef: MutableRefObject<string>
  voiceConsentGrantedRef: MutableRefObject<boolean>
  voiceConsentRouteKeyRef: MutableRefObject<string | null>
  nativeVoiceStatusRef: MutableRefObject<NativeDesktopVoiceStatus | null>
  nativeVoiceGenerationRef: MutableRefObject<number | null>
  nativeDesktopBackgroundWakeActiveRef: MutableRefObject<boolean>
  nativeVoiceOperationTokenRef: MutableRefObject<number>
  nativeVoicePendingCancelReasonRef: MutableRefObject<NativeDesktopVoiceStopReason | null>
  nativeVoiceCancelledGenerationsRef: MutableRefObject<Set<number>>
  nativeMobileVoiceOperationTokenRef: MutableRefObject<number>
  nativeMobileVoiceStartInFlightRef: MutableRefObject<boolean>
  nativeMobileBackgroundWakeActiveRef: MutableRefObject<boolean>
  voiceToggleInFlightRef: MutableRefObject<boolean>
  voiceResponseTimeoutRef: MutableRefObject<number | null>
  browserVoiceLocalTranscriptRef: MutableRefObject<string>
  usesNativeDesktopVoice: boolean
  usesNativeMobileVoice: boolean
  usesFocusedBrowserVoiceRuntime: boolean
  receivesCoordinatorVoiceEvents: boolean
  nativeMobileBackgroundOwnsMicrophone: boolean
  voiceCaptureButtonLabel: string
  browserSpeechPacksRevision: string
  readyBrowserSpeechPacks: ReadyBrowserSpeechPacksRuntimeStatus | null
  browserLocalTtsVoiceId: string | undefined
  voiceModel: AssistantVoiceModel
  handsFreeControl: VoiceControlModel | undefined
  voiceConsentRouteKey: string
  connectedVoiceAccessGranted: boolean
  setRemoteAudioConsent: (granted: boolean) => void
  remoteAudioConsentForCurrentRoute: (route?: RouteAvailability) => boolean | null
  toggleRemoteAudioConsent: () => Promise<void>
  remoteAudioConsentPending: boolean
  requestVoiceToggle: () => void
  handsFreeActive: boolean
}

export function useAssistantVoice({
  client,
  route,
  voiceRoutes,
  nativePlatform,
  nativeAvailable,
  nativePermissions,
  nativeCapabilities,
  recentVoiceEvents,
  surfaceProfile,
  nativeMobileVoice,
  browserSpeechPacks,
  lifecycleCallbacks,
  buildVoiceModel,
  remoteAudioConsentRouteKey,
  idleWaveformBars,
}: UseAssistantVoiceOptions): UseAssistantVoiceResult {
  const [voiceConsentGranted, setVoiceConsentGrantedState] = useState(false)
  const [remoteAudioConsentPending, setRemoteAudioConsentPending] = useState(false)
  const [voiceCaptureStatusState, setVoiceCaptureStatusState] = useState<VoiceCaptureStatus>('idle')
  const [voiceResponsePendingId, setVoiceResponsePendingId] = useState<string | null>(null)
  const [voiceEvents, setVoiceEvents] = useState<VoiceRuntimeEvent[]>(recentVoiceEvents)
  const [voiceWaveformBars, setVoiceWaveformBars] = useState<number[]>(() => idleWaveformBars())
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0)
  const [nativeVoiceStatusState, setNativeVoiceStatusState] = useState<NativeDesktopVoiceStatus | null>(null)
  const [nativeDesktopBackgroundWakeActive, setNativeDesktopBackgroundWakeActive] = useState(false)
  const [nativeMobileBackgroundWakeActive, setNativeMobileBackgroundWakeActive] = useState(false)
  const activeVoiceSessionRef = useRef<string | null>(null)
  const ownedVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const coordinatorVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const voiceSessionStartedAtRef = useRef<number | null>(null)
  const appliedVoiceEventIdsRef = useRef<Set<string>>(new Set())
  const voiceCaptureStatusRef = useRef<VoiceCaptureStatus>('idle')
  const voicePendingAssistantIdRef = useRef<string | null>(null)
  const voiceTranscriptPreviewRef = useRef('')
  const voiceConsentGrantedRef = useRef(false)
  const voiceConsentRouteKeyRef = useRef<string | null>(null)
  const nativeVoiceStatusRef = useRef<NativeDesktopVoiceStatus | null>(null)
  const nativeVoiceGenerationRef = useRef<number | null>(null)
  const nativeDesktopBackgroundWakeActiveRef = useRef(false)
  const nativeVoiceOperationTokenRef = useRef(0)
  const nativeVoicePendingCancelReasonRef = useRef<NativeDesktopVoiceStopReason | null>(null)
  const nativeVoiceCancelledGenerationsRef = useRef<Set<number>>(new Set())
  const nativeMobileVoiceOperationTokenRef = useRef(0)
  const nativeMobileVoiceStartInFlightRef = useRef(false)
  const nativeMobileBackgroundWakeActiveRef = useRef(false)
  const voiceToggleInFlightRef = useRef(false)
  const remoteAudioConsentInFlightRef = useRef(false)
  const voiceResponseTimeoutRef = useRef<number | null>(null)
  const browserVoiceLocalTranscriptRef = useRef('')
  const lifecycleCallbacksRef = useRef(lifecycleCallbacks)
  lifecycleCallbacksRef.current = lifecycleCallbacks

  function setVoiceCaptureStatus(next: VoiceCaptureStatus) {
    voiceCaptureStatusRef.current = next
    setVoiceCaptureStatusState(next)
  }

  const usesNativeDesktopVoice = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop'
  const usesNativeMobileVoice = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'mobile-native'
  const usesFocusedBrowserVoiceRuntime = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'webview-focused'
  const receivesCoordinatorVoiceEvents = surfaceProfile.voiceCapture.wakewordOwner === 'coordinator-daemon'
  const nativeMobileBackgroundOwnsMicrophone = usesNativeMobileVoice && nativeMobileBackgroundWakeActive
  const voiceCaptureButtonLabel = voiceCaptureStatusState === 'listening' ? 'Stop listening' : 'Push to talk'
  const browserSpeechPacksRevision = browserSpeechPacks?.revision ?? 'none'
  const readyBrowserSpeechPacks: ReadyBrowserSpeechPacksRuntimeStatus | null = browserSpeechPacks?.state === 'ready' ? browserSpeechPacks : null
  const browserLocalTtsVoiceId = readyBrowserSpeechPacks?.capabilities.tts ? readyBrowserSpeechPacks.ttsVoiceId : undefined
  const voiceModel = useMemo(
    () => buildVoiceModel({
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      surfaceProfile,
      captureStatus: voiceCaptureStatusState,
      consentGranted: voiceConsentGranted,
      nativeDesktopVoiceStatus: nativeVoiceStatusState,
      nativeDesktopBackgroundWakeActive,
      nativeMobileBackgroundWakeActive,
      nativeMobileBackgroundWakeSupported: usesNativeMobileVoice
        && typeof nativeMobileVoice?.backgroundStatus === 'function'
        && typeof nativeMobileVoice?.startBackground === 'function'
        && typeof nativeMobileVoice?.stopBackground === 'function',
      voiceEvents,
      waveformBars: voiceWaveformBars
    }),
    [
      buildVoiceModel,
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      surfaceProfile,
      voiceCaptureStatusState,
      voiceConsentGranted,
      nativeVoiceStatusState,
      nativeDesktopBackgroundWakeActive,
      nativeMobileBackgroundWakeActive,
      nativeMobileVoice,
      usesNativeMobileVoice,
      voiceEvents,
      voiceWaveformBars
    ]
  )
  const handsFreeControl = voiceModel.controls.find((control) => control.id === 'background-wake')
  const voiceConsentRouteKey = useMemo(
    () => remoteAudioConsentRouteKey(voiceModel.remoteAudioRoute),
    [remoteAudioConsentRouteKey, voiceModel.remoteAudioRoute]
  )
  const connectedVoiceAccessGranted = voiceConsentGranted && voiceConsentRouteKeyRef.current === voiceConsentRouteKey


  function setRemoteAudioConsent(granted: boolean) {
    voiceConsentGrantedRef.current = granted
    voiceConsentRouteKeyRef.current = granted ? voiceConsentRouteKey : null
    setVoiceConsentGrantedState(granted)
  }

  function remoteAudioConsentForCurrentRoute(routeToCheck = voiceModel.remoteAudioRoute): boolean | null {
    if (!requiresRemoteAudioConsent(routeToCheck)) return false
    if (
      voiceConsentGrantedRef.current &&
      voiceConsentRouteKeyRef.current === remoteAudioConsentRouteKey(routeToCheck)
    ) return true
    const message = 'Review connected voice access before starting speech.'
    const callbacks = lifecycleCallbacksRef.current
    callbacks.setLastError(message)
    setVoiceCaptureStatus('idle')
    callbacks.setStreamState((current) => ({ ...current, status: 'lost', message }))
    return null
  }

  async function toggleRemoteAudioConsent() {
    if (remoteAudioConsentInFlightRef.current) return
    remoteAudioConsentInFlightRef.current = true
    setRemoteAudioConsentPending(true)
    try {
      if (voiceConsentGrantedRef.current && voiceConsentRouteKeyRef.current === voiceConsentRouteKey) {
        await stopActiveRemoteAudioForConsentRevoke()
        setRemoteAudioConsent(false)
        return
      }
      lifecycleCallbacksRef.current.setLastError(null)
      setRemoteAudioConsent(true)
    } finally {
      remoteAudioConsentInFlightRef.current = false
      setRemoteAudioConsentPending(false)
    }
  }

  async function stopActiveRemoteAudioForConsentRevoke() {
    if (!requiresRemoteAudioConsent(voiceModel.remoteAudioRoute)) return
    if (!['listening', 'processing', 'speaking'].includes(voiceCaptureStatusRef.current)) return
    const callbacks = lifecycleCallbacksRef.current
    if (usesNativeDesktopVoice) {
      await callbacks.cancelNativeDesktopVoice('user_request')
    } else if (usesNativeMobileVoice) {
      await callbacks.cancelNativeMobileVoice()
    } else if (usesFocusedBrowserVoiceRuntime) {
      await callbacks.cancelBrowserVoiceCaptureForReason('consent_revoked')
    } else {
      const sessionId = activeVoiceSessionRef.current
      if (sessionId && coordinatorVoiceSessionIdsRef.current.has(sessionId)) {
        const stopped = await client.assistant.stopVoiceListen({
          sessionId,
          reason: 'user_request',
          routePolicy: routePolicyFromRoute(voiceModel.transcriptionRoute)
        })
        if (!stopped.ok) callbacks.setLastError(callbacks.productAssistantErrorCopy(stopped.error))
      }
    }
    setVoiceCaptureStatus('idle')
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
  }

  function requestVoiceToggle() {
    const waitingForHostedSettlement = usesFocusedBrowserVoiceRuntime
      && voiceCaptureStatusRef.current === 'idle'
      && lifecycleCallbacksRef.current.isBrowserVoiceTurnSettling()
    if (voiceToggleInFlightRef.current && !waitingForHostedSettlement) return
    voiceToggleInFlightRef.current = true
    const unlock = typeof window === 'undefined'
      ? null
      : window.setTimeout(() => {
          voiceToggleInFlightRef.current = false
        }, 12_000)
    void lifecycleCallbacksRef.current.toggleLocalCapture().finally(() => {
      if (unlock !== null) window.clearTimeout(unlock)
      voiceToggleInFlightRef.current = false
    })
  }

  return {
    voiceConsentGranted,
    setVoiceConsentGrantedState,
    voiceCaptureStatus: voiceCaptureStatusState,
    setVoiceCaptureStatus,
    voiceCaptureStatusRef,
    voiceResponsePendingId,
    setVoiceResponsePendingId,
    voiceEvents,
    setVoiceEvents,
    voiceWaveformBars,
    setVoiceWaveformBars,
    voiceElapsedSeconds,
    setVoiceElapsedSeconds,
    nativeVoiceStatusState,
    setNativeVoiceStatusState,
    nativeDesktopBackgroundWakeActive,
    setNativeDesktopBackgroundWakeActive,
    nativeMobileBackgroundWakeActive,
    setNativeMobileBackgroundWakeActive,
    activeVoiceSessionRef,
    ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef,
    voiceSessionStartedAtRef,
    appliedVoiceEventIdsRef,
    voicePendingAssistantIdRef,
    voiceTranscriptPreviewRef,
    voiceConsentGrantedRef,
    voiceConsentRouteKeyRef,
    nativeVoiceStatusRef,
    nativeVoiceGenerationRef,
    nativeDesktopBackgroundWakeActiveRef,
    nativeVoiceOperationTokenRef,
    nativeVoicePendingCancelReasonRef,
    nativeVoiceCancelledGenerationsRef,
    nativeMobileVoiceOperationTokenRef,
    nativeMobileVoiceStartInFlightRef,
    nativeMobileBackgroundWakeActiveRef,
    voiceToggleInFlightRef,
    voiceResponseTimeoutRef,
    browserVoiceLocalTranscriptRef,
    usesNativeDesktopVoice,
    usesNativeMobileVoice,
    usesFocusedBrowserVoiceRuntime,
    receivesCoordinatorVoiceEvents,
    nativeMobileBackgroundOwnsMicrophone,
    voiceCaptureButtonLabel,
    browserSpeechPacksRevision,
    readyBrowserSpeechPacks,
    browserLocalTtsVoiceId,
    voiceModel,
    handsFreeControl,
    voiceConsentRouteKey,
    connectedVoiceAccessGranted,
    setRemoteAudioConsent,
    remoteAudioConsentForCurrentRoute,
    toggleRemoteAudioConsent,
    remoteAudioConsentPending,
    requestVoiceToggle,
    handsFreeActive: nativeDesktopBackgroundWakeActive,
  }
}

function requiresRemoteAudioConsent(route: RouteAvailability): boolean {
  return route.state === 'available-remote'
    || route.selectorRequired
    || (route.state !== 'available-local' && route.candidateProviders.some(isRemoteRouteCandidate))
}

export { useAssistantVoiceLifecycle } from './use-assistant-voice-lifecycle'
