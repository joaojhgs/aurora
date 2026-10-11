import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AssistantMessage, AssistantStreamUpdate, AuroraError, VoiceRuntimeEvent } from '@aurora/client'
import type { NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { AssistantStreamState } from './assistant-view'
import type { VoiceCaptureStatus } from './assistant-voice-model'
import type { AssistantUiMessage } from './assistant-session-persistence'

export interface AssistantVoiceEventController {
  applyVoiceRuntimeEvent(event: VoiceRuntimeEvent): void
  applyVoiceAssistantResponse(update: AssistantStreamUpdate): void
  applyNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus): void
  maybeCancelDeferredNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus): boolean
  armVoiceResponseTimeout(pendingId: string): void
  clearVoiceResponseTimeout(): void
  markVoiceAssistantFailed(pendingId: string, failureCopy: string): void
}

export interface AssistantVoiceEventControllerOptions {
  readonly routeProviderLabel: string | null
  readonly runtimeProviderLabel: string | null
  readonly modelLabel: string | null
  readonly runtimeSelectedModelLabel: string | null | undefined
  readonly localExecutionMessageLabel: string
  readonly supportsPersistedSessions: boolean
  readonly browserLocalTtsVoiceId: string | undefined
  readonly activeVoiceSessionRef: MutableRefObject<string | null>
  readonly ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly appliedVoiceEventIdsRef: MutableRefObject<Set<string>>
  readonly voicePendingAssistantIdRef: MutableRefObject<string | null>
  readonly voiceTranscriptPreviewRef: MutableRefObject<string>
  readonly voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  readonly voiceResponseTimeoutRef: MutableRefObject<number | null>
  readonly nativeVoiceStatusRef: MutableRefObject<NativeDesktopVoiceStatus | null>
  readonly nativeVoiceGenerationRef: MutableRefObject<number | null>
  readonly nativeDesktopBackgroundWakeActiveRef: MutableRefObject<boolean>
  readonly nativeVoicePendingCancelReasonRef: MutableRefObject<NativeDesktopVoiceStopReason | null>
  readonly assistantViewDisposedRef: MutableRefObject<boolean>
  readonly browserVoiceRemoteTtsAudioSeenRef: MutableRefObject<boolean>
  readonly speakingMessageIdRef: MutableRefObject<string | null>
  readonly lastAssistantMessageIdRef: MutableRefObject<string | null>
  readonly nativeVoiceAvailable: boolean
  readonly setVoiceWaveformBars: (bars: number[]) => void
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setVoiceCaptureStatus: (status: VoiceCaptureStatus) => void
  readonly setNativeVoiceStatusState: (status: NativeDesktopVoiceStatus | null) => void
  readonly setNativeDesktopBackgroundWakeActive: (active: boolean) => void
  readonly setSpeakingMessageId: (messageId: string | null) => void
  readonly setText: (text: string) => void
  readonly setLastPrompt: (prompt: string | null) => void
  readonly setLastError: (error: string | null) => void
  readonly setLastResult: (message: AssistantMessage | null) => void
  readonly setModelLabel: (label: string | null) => void
  readonly setRuntimeProviderLabel: (label: string | null) => void
  readonly setVoiceResponsePendingId: (pendingId: string | null) => void
  readonly setSession: Dispatch<SetStateAction<{ sessionId: string | null; messages: AssistantUiMessage[] }>>
  readonly productAssistantErrorCopy: (error: Error | AuroraError) => string
  readonly waveformBarsFromLevel: (level: number, peak: number) => number[]
  readonly settleVoicePendingFromObservedText: (observedText: string | null, reason: 'tts_started' | 'assistant_response') => void
  readonly settleSubstantiveStreamingAssistantMessages: (reason: 'tts_started' | 'response_text_observed') => void
  readonly enqueueStreamedTtsAudio: (update: AssistantStreamUpdate) => void
  readonly synthesizeBrowserReadAloud: (textToSpeak: string, messageId?: string | null) => Promise<boolean>
  readonly openPersistedSession: (sessionId: string, activate?: boolean) => Promise<void>
  readonly cancelNativeDesktopVoiceGeneration: (generation: number, reason: NativeDesktopVoiceStopReason) => Promise<boolean>
}
