'use client'

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AssistantStreamUpdate, AuroraClient, AuroraError, VoiceRuntimeEvent } from '@aurora/client'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { RouteAvailability } from './shell-data'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { BrowserVoiceTurnSettlement } from './use-assistant-browser-capture'
import type { AuroraBrowserVoiceRuntimeInstance } from './assistant-browser-voice-runtime'
import type { AssistantVoiceEventController } from './assistant-voice-event-controller-types'
import { createAssistantVoiceEventController } from './use-assistant-voice-events'
import { createAssistantCaptureController, type AssistantCaptureController } from './use-assistant-capture-controller'
import type { AssistantSessionSnapshot, AssistantUiMessage } from './assistant-session-persistence'
import type { AssistantStreamState, VoiceCaptureStatus } from './assistant-view'
import type { AssistantVoiceModel } from './assistant-voice-model'
import type { ReadyBrowserSpeechPacks } from './use-assistant-voice'

interface AssistantControllerAssemblyOptions {
  readonly client: AuroraClient
  readonly routeProviderLabel: string
  readonly runtimeProviderLabel: string | null
  readonly modelLabel: string | null
  readonly runtimeSelectedModelLabel: string | null | undefined
  readonly localExecutionMessageLabel: string
  readonly supportsPersistedSessions: boolean
  readonly browserLocalTtsVoiceId: string | null
  readonly surfaceProfile: AuroraSurfaceProfile
  readonly nativeVoice: NativeDesktopVoicePort | null
  readonly nativeMobileVoice: NativeMobileVoicePort | null
  readonly readyBrowserSpeechPacks: ReadyBrowserSpeechPacks
  readonly voiceModel: AssistantVoiceModel
  readonly usesNativeDesktopVoice: boolean
  readonly usesNativeMobileVoice: boolean
  readonly usesFocusedBrowserVoiceRuntime: boolean
  readonly remoteAudioConsentForCurrentRoute: boolean
  readonly activeVoiceSessionRef: MutableRefObject<string | null>
  readonly ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly appliedVoiceEventIdsRef: MutableRefObject<Set<string>>
  readonly voicePendingAssistantIdRef: MutableRefObject<string | null>
  readonly voiceTranscriptPreviewRef: MutableRefObject<string>
  readonly voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  readonly voiceResponseTimeoutRef: MutableRefObject<number | null>
  readonly nativeVoiceStatusRef: MutableRefObject<NativeDesktopVoiceStatus | null>
  readonly nativeVoiceGenerationRef: MutableRefObject<number>
  readonly nativeDesktopBackgroundWakeActiveRef: MutableRefObject<boolean>
  readonly nativeVoiceOperationTokenRef: MutableRefObject<number>
  readonly nativeVoicePendingCancelReasonRef: MutableRefObject<NativeDesktopVoiceStopReason | null>
  readonly nativeVoiceCancelledGenerationsRef: MutableRefObject<Set<number>>
  readonly nativeMobileVoiceOperationTokenRef: MutableRefObject<number>
  readonly nativeMobileVoiceStartInFlightRef: MutableRefObject<boolean>
  readonly nativeMobileBackgroundWakeActiveRef: MutableRefObject<boolean>
  readonly assistantViewDisposedRef: MutableRefObject<boolean>
  readonly browserVoiceRuntimeRef: MutableRefObject<AuroraBrowserVoiceRuntimeInstance | null>
  readonly browserVoiceRuntimeEventUnsubscribeRef: MutableRefObject<(() => void) | null>
  readonly browserVoiceOperationTokenRef: MutableRefObject<number>
  readonly browserVoiceTurnSettlementRef: MutableRefObject<BrowserVoiceTurnSettlement | null>
  readonly browserVoiceLocalTranscriptRef: MutableRefObject<string>
  readonly browserVoiceRemoteTtsAudioSeenRef: MutableRefObject<Set<string>>
  readonly speakingMessageIdRef: MutableRefObject<string | null>
  readonly lastAssistantMessageIdRef: MutableRefObject<string | null>
  readonly voiceEventControllerRef: MutableRefObject<AssistantVoiceEventController | null>
  readonly captureControllerRef: MutableRefObject<AssistantCaptureController | null>
  readonly setVoiceWaveformBars: Dispatch<SetStateAction<number[]>>
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setVoiceCaptureStatus: Dispatch<SetStateAction<VoiceCaptureStatus>>
  readonly setNativeVoiceStatusState: Dispatch<SetStateAction<NativeDesktopVoiceStatus | null>>
  readonly setNativeDesktopBackgroundWakeActive: Dispatch<SetStateAction<boolean>>
  readonly setNativeMobileBackgroundWakeActive: Dispatch<SetStateAction<boolean>>
  readonly setSpeakingMessageId: Dispatch<SetStateAction<string | null>>
  readonly setText: Dispatch<SetStateAction<string>>
  readonly setLastPrompt: Dispatch<SetStateAction<string | null>>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly setLastResult: Dispatch<SetStateAction<import('@aurora/client').AssistantMessage | null>>
  readonly setModelLabel: Dispatch<SetStateAction<string | null>>
  readonly setRuntimeProviderLabel: Dispatch<SetStateAction<string | null>>
  readonly setVoiceResponsePendingId: Dispatch<SetStateAction<string | null>>
  readonly setVoiceEvents: Dispatch<SetStateAction<VoiceRuntimeEvent[]>>
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly productAssistantErrorCopy: (error: Error | AuroraError) => string
  readonly waveformBarsFromLevel: (level: number) => number[]
  readonly mergeVoiceRuntimeEvents: (events: VoiceRuntimeEvent[], next: VoiceRuntimeEvent) => VoiceRuntimeEvent[]
  readonly settleVoicePendingFromObservedText: (pendingId: string | null, text: string) => void
  readonly settleSubstantiveStreamingAssistantMessages: () => void
  readonly enqueueStreamedTtsAudio: (messageId: string, audio: import('@aurora/client').AssistantStreamAudioChunk) => void
  readonly synthesizeBrowserReadAloud: (message: AssistantUiMessage, options?: { allowRemote?: boolean }) => Promise<void>
  readonly openPersistedSession: (sessionId: string, activate?: boolean) => Promise<void>
  readonly cancelNativeDesktopVoiceGeneration: (generation: number, reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  readonly defaultVoiceRoutePolicy: (route: RouteAvailability) => import('@aurora/client').AssistantRoutePolicy | null
  readonly routePolicyFromRoute: (route: RouteAvailability) => import('@aurora/client').AssistantRoutePolicy
  readonly applyNativeDesktopVoiceStatus: (status: NativeDesktopVoiceStatus) => void
  readonly interruptTtsForVoiceCapture: () => void
  readonly startAssistantTurn: (prompt: string, replayFromEventId?: string | null) => Promise<void>
}

export function useAssistantControllerAssembly(options: AssistantControllerAssemblyOptions): void {
  options.voiceEventControllerRef.current = createAssistantVoiceEventController({
    routeProviderLabel: options.routeProviderLabel,
    runtimeProviderLabel: options.runtimeProviderLabel,
    modelLabel: options.modelLabel,
    runtimeSelectedModelLabel: options.runtimeSelectedModelLabel,
    localExecutionMessageLabel: options.localExecutionMessageLabel,
    supportsPersistedSessions: options.supportsPersistedSessions,
    browserLocalTtsVoiceId: options.browserLocalTtsVoiceId,
    activeVoiceSessionRef: options.activeVoiceSessionRef,
    ownedVoiceSessionIdsRef: options.ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef: options.coordinatorVoiceSessionIdsRef,
    appliedVoiceEventIdsRef: options.appliedVoiceEventIdsRef,
    voicePendingAssistantIdRef: options.voicePendingAssistantIdRef,
    voiceTranscriptPreviewRef: options.voiceTranscriptPreviewRef,
    voiceCaptureStatusRef: options.voiceCaptureStatusRef,
    voiceResponseTimeoutRef: options.voiceResponseTimeoutRef,
    nativeVoiceStatusRef: options.nativeVoiceStatusRef,
    nativeVoiceGenerationRef: options.nativeVoiceGenerationRef,
    nativeDesktopBackgroundWakeActiveRef: options.nativeDesktopBackgroundWakeActiveRef,
    nativeVoicePendingCancelReasonRef: options.nativeVoicePendingCancelReasonRef,
    assistantViewDisposedRef: options.assistantViewDisposedRef,
    browserVoiceRemoteTtsAudioSeenRef: options.browserVoiceRemoteTtsAudioSeenRef,
    speakingMessageIdRef: options.speakingMessageIdRef,
    lastAssistantMessageIdRef: options.lastAssistantMessageIdRef,
    nativeVoiceAvailable: Boolean(options.nativeVoice),
    setVoiceWaveformBars: options.setVoiceWaveformBars,
    setStreamState: options.setStreamState,
    setVoiceCaptureStatus: options.setVoiceCaptureStatus,
    setNativeVoiceStatusState: options.setNativeVoiceStatusState,
    setNativeDesktopBackgroundWakeActive: options.setNativeDesktopBackgroundWakeActive,
    setSpeakingMessageId: options.setSpeakingMessageId,
    setText: options.setText,
    setLastPrompt: options.setLastPrompt,
    setLastError: options.setLastError,
    setLastResult: options.setLastResult,
    setModelLabel: options.setModelLabel,
    setRuntimeProviderLabel: options.setRuntimeProviderLabel,
    setVoiceResponsePendingId: options.setVoiceResponsePendingId,
    setSession: options.setSession,
    productAssistantErrorCopy: options.productAssistantErrorCopy,
    waveformBarsFromLevel: options.waveformBarsFromLevel,
    settleVoicePendingFromObservedText: options.settleVoicePendingFromObservedText,
    settleSubstantiveStreamingAssistantMessages: options.settleSubstantiveStreamingAssistantMessages,
    enqueueStreamedTtsAudio: options.enqueueStreamedTtsAudio,
    synthesizeBrowserReadAloud: options.synthesizeBrowserReadAloud,
    openPersistedSession: options.openPersistedSession,
    cancelNativeDesktopVoiceGeneration: options.cancelNativeDesktopVoiceGeneration,
  })

  options.captureControllerRef.current = createAssistantCaptureController({
    client: options.client,
    surfaceProfile: options.surfaceProfile,
    nativeVoice: options.nativeVoice,
    nativeMobileVoice: options.nativeMobileVoice,
    readyBrowserSpeechPacks: options.readyBrowserSpeechPacks,
    voiceModel: options.voiceModel,
    usesNativeDesktopVoice: options.usesNativeDesktopVoice,
    usesNativeMobileVoice: options.usesNativeMobileVoice,
    usesFocusedBrowserVoiceRuntime: options.usesFocusedBrowserVoiceRuntime,
    assistantViewDisposedRef: options.assistantViewDisposedRef,
    activeVoiceSessionRef: options.activeVoiceSessionRef,
    ownedVoiceSessionIdsRef: options.ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef: options.coordinatorVoiceSessionIdsRef,
    voicePendingAssistantIdRef: options.voicePendingAssistantIdRef,
    voiceTranscriptPreviewRef: options.voiceTranscriptPreviewRef,
    voiceCaptureStatusRef: options.voiceCaptureStatusRef,
    nativeVoiceStatusRef: options.nativeVoiceStatusRef,
    nativeVoiceGenerationRef: options.nativeVoiceGenerationRef,
    nativeDesktopBackgroundWakeActiveRef: options.nativeDesktopBackgroundWakeActiveRef,
    nativeVoiceOperationTokenRef: options.nativeVoiceOperationTokenRef,
    nativeVoicePendingCancelReasonRef: options.nativeVoicePendingCancelReasonRef,
    nativeVoiceCancelledGenerationsRef: options.nativeVoiceCancelledGenerationsRef,
    nativeMobileVoiceOperationTokenRef: options.nativeMobileVoiceOperationTokenRef,
    nativeMobileVoiceStartInFlightRef: options.nativeMobileVoiceStartInFlightRef,
    nativeMobileBackgroundWakeActiveRef: options.nativeMobileBackgroundWakeActiveRef,
    browserVoiceRuntimeRef: options.browserVoiceRuntimeRef,
    browserVoiceRuntimeEventUnsubscribeRef: options.browserVoiceRuntimeEventUnsubscribeRef,
    browserVoiceOperationTokenRef: options.browserVoiceOperationTokenRef,
    browserVoiceTurnSettlementRef: options.browserVoiceTurnSettlementRef,
    browserVoiceLocalTranscriptRef: options.browserVoiceLocalTranscriptRef,
    setText: options.setText,
    setLastError: options.setLastError,
    setStreamState: options.setStreamState,
    setVoiceCaptureStatus: options.setVoiceCaptureStatus,
    setVoiceEvents: options.setVoiceEvents,
    setVoiceResponsePendingId: options.setVoiceResponsePendingId,
    setVoiceWaveformBars: options.setVoiceWaveformBars,
    setNativeVoiceStatusState: options.setNativeVoiceStatusState,
    setNativeDesktopBackgroundWakeActive: options.setNativeDesktopBackgroundWakeActive,
    setNativeMobileBackgroundWakeActive: options.setNativeMobileBackgroundWakeActive,
    remoteAudioConsentForCurrentRoute: options.remoteAudioConsentForCurrentRoute,
    defaultVoiceRoutePolicy: options.defaultVoiceRoutePolicy,
    routePolicyFromRoute: options.routePolicyFromRoute,
    productAssistantErrorCopy: options.productAssistantErrorCopy,
    applyNativeDesktopVoiceStatus: options.applyNativeDesktopVoiceStatus,
    interruptTtsForVoiceCapture: options.interruptTtsForVoiceCapture,
    startAssistantTurn: options.startAssistantTurn,
    waveformBarsFromLevel: options.waveformBarsFromLevel,
    mergeVoiceRuntimeEvents: options.mergeVoiceRuntimeEvents,
  })
}
