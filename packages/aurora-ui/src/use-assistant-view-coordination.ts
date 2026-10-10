'use client'

import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import type { AssistantRoutePolicy, AuroraClient } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import { routePolicyFromRoute } from './use-assistant-execution'
import { resolveLocalAssistantHistoryDependencies } from './use-assistant-history'
import type { AssistantStreamState } from './assistant-view-types'
import type { AssistantControllerBridge } from './use-assistant-controller-bridge'
import type { UseAssistantVoiceResult, UseAssistantVoiceLifecycleCallbacks } from './use-assistant-voice'
import {
  createLightweightAssistantOrchestrator,
  isLightweightLocalAssistantAvailable,
  type LightweightAssistantDependencies,
} from './local-assistant/lightweight-assistant'
import { productAssistantErrorCopy } from './assistant-view-copy'

export function useAssistantSurfaceProfile({
  client,
  nativePlatform,
  providedSurfaceProfile,
}: {
  client: AuroraClient
  nativePlatform: string
  providedSurfaceProfile?: AuroraSurfaceProfile | undefined
}): AuroraSurfaceProfile {
  return useMemo(() => providedSurfaceProfile ?? getAuroraSurfaceProfile({
    runtimeMode: client.transport.kind === 'tauri-local' ? 'desktop-local' : client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: client.transport.kind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent
  }), [client.transport.kind, nativePlatform, providedSurfaceProfile])
}

export function useAssistantLocalRuntime({
  localAssistant,
  executionHost,
}: {
  localAssistant: LightweightAssistantDependencies | null
  executionHost: 'this-device' | 'connected-device'
}) {
  const localAssistantAvailable = localAssistant !== null && isLightweightLocalAssistantAvailable(localAssistant)
  const localOrchestrator = useMemo(
    () => localAssistant === null ? null : createLightweightAssistantOrchestrator(localAssistant),
    [localAssistant]
  )
  const localHistory = useMemo(
    () => resolveLocalAssistantHistoryDependencies(localAssistant, executionHost),
    [
      executionHost,
      localAssistant?.localData,
      localAssistant?.envelopeCrypto,
      localAssistant?.scope?.localNodeId,
      localAssistant?.scope?.profileId,
    ]
  )
  return { localAssistantAvailable, localOrchestrator, localHistory }
}

export function useAssistantDefaultVoiceRoutePolicy({
  setLastError,
  setVoiceCaptureStatus,
  setStreamState,
}: {
  setLastError: (message: string | null) => void
  setVoiceCaptureStatus: (status: import('./assistant-voice-model').VoiceCaptureStatus) => void
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
}): (route: RouteAvailability) => AssistantRoutePolicy | null {
  return useCallback((route: RouteAvailability): AssistantRoutePolicy | null => {
    const routePolicy = routePolicyFromRoute(route)
    if (
      route.selectorRequired
      && !routePolicy.providerId
      && !routePolicy.peerId
      && !routePolicy.serviceInstanceId
    ) {
      const message = 'Choose a connected voice device before starting speech.'
      setLastError(message)
      setVoiceCaptureStatus('idle')
      setStreamState((current) => ({ ...current, status: 'lost', message }))
      return null
    }
    return routePolicy
  }, [setLastError, setStreamState, setVoiceCaptureStatus])
}

export function useAssistantRemoteAudioConsentReset(voice: UseAssistantVoiceResult): void {
  const {
    setRemoteAudioConsent,
    voiceConsentGranted,
    voiceConsentRouteKey,
    voiceConsentRouteKeyRef,
  } = voice
  useEffect(() => {
    if (!voiceConsentGranted) return
    if (voiceConsentRouteKeyRef.current === voiceConsentRouteKey) return
    setRemoteAudioConsent(false)
  }, [setRemoteAudioConsent, voiceConsentGranted, voiceConsentRouteKey, voiceConsentRouteKeyRef])
}

export function assistantVoiceLifecycleCallbacks({
  setText,
  setLastError,
  setStreamState,
  bridge,
}: {
  setText: Dispatch<SetStateAction<string>>
  setLastError: Dispatch<SetStateAction<string | null>>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  bridge: Pick<AssistantControllerBridge, 'applyNativeDesktopVoiceStatus' | 'maybeCancelDeferredNativeDesktopVoiceStatus' | 'applyVoiceRuntimeEvent' | 'applyVoiceAssistantResponse' | 'markVoiceAssistantFailed' | 'cancelNativeDesktopVoice' | 'cancelNativeMobileVoice' | 'cancelBrowserVoiceCaptureForReason' | 'releaseBrowserVoiceCaptureForLifecycle' | 'toggleLocalCapture' | 'isBrowserVoiceTurnSettling'>
}): UseAssistantVoiceLifecycleCallbacks {
  return {
    setText,
    setLastError,
    setStreamState,
    productAssistantErrorCopy,
    applyNativeDesktopVoiceStatus: bridge.applyNativeDesktopVoiceStatus,
    maybeCancelDeferredNativeDesktopVoiceStatus: bridge.maybeCancelDeferredNativeDesktopVoiceStatus,
    applyVoiceRuntimeEvent: bridge.applyVoiceRuntimeEvent,
    applyVoiceAssistantResponse: bridge.applyVoiceAssistantResponse,
    markVoiceAssistantFailed: bridge.markVoiceAssistantFailed,
    cancelNativeDesktopVoice: bridge.cancelNativeDesktopVoice,
    cancelNativeMobileVoice: bridge.cancelNativeMobileVoice,
    cancelBrowserVoiceCaptureForReason: bridge.cancelBrowserVoiceCaptureForReason,
    releaseBrowserVoiceCaptureForLifecycle: bridge.releaseBrowserVoiceCaptureForLifecycle,
    toggleLocalCapture: bridge.toggleLocalCapture,
    isBrowserVoiceTurnSettling: bridge.isBrowserVoiceTurnSettling,
  }
}
