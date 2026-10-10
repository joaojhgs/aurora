import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type {
  AssistantInferencePolicy,
  AssistantRoutePolicy,
  AssistantStreamUpdate,
  AssistantMessage as SdkAssistantMessage,
  AuroraClient,
  AuroraEvent,
} from '@aurora/client'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'
import type {
  AssistantConversationRow,
  AssistantModelChoice,
  AssistantRuntimeHealth,
  AssistantStreamState,
  AssistantSessionSnapshot,
} from './assistant-view'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { LocalAssistantHistoryDependencies } from './use-assistant-history'
import type { NativeMobileVoiceBackgroundResult } from './native-mobile-voice'
import {
  nativeAssistantSnapshotRecoveryDecision,
  type NativeAssistantPendingTurnRecord,
} from './native-assistant-events'
import { createAssistantTurnStreamController } from './use-assistant-turn-stream'
import { createAssistantNativeTurnController } from './use-assistant-native-turns'
import { createAssistantForegroundTurnController } from './use-assistant-foreground-turn'

export interface AssistantTurnsTtsCallbacks {
  readonly lastAssistantMessageIdRef: MutableRefObject<string | null>
  readonly speakingMessageIdRef: MutableRefObject<string | null>
  readonly setSpeakingMessageId: (messageId: string | null) => void
  readonly enqueueStreamedTtsAudio: (update: AssistantStreamUpdate) => void
}

export interface AssistantTurnExecutionSelection {
  readonly mode: 'local' | 'dispatch'
  readonly runner: 'aurora-route' | 'lightweight-local'
  readonly label: string
  readonly executionPeerId: string | null
  readonly transportHost?: boolean
}

export interface UseAssistantTurnsParams {
  readonly client: AuroraClient
  readonly route: RouteAvailability
  readonly runtimeHealth?: AssistantRuntimeHealth | undefined
  readonly surfaceProfile: AuroraSurfaceProfile
  readonly session: AssistantSessionSnapshot
  readonly sessionRef: MutableRefObject<AssistantSessionSnapshot>
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly setLocalConversationRows: Dispatch<SetStateAction<AssistantConversationRow[]>>
  readonly abortRef: MutableRefObject<AbortController | null>
  readonly setText: Dispatch<SetStateAction<string>>
  readonly setLastPrompt: Dispatch<SetStateAction<string | null>>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly setLastResult: Dispatch<SetStateAction<SdkAssistantMessage | null>>
  readonly modelLabel: string | null
  readonly setModelLabel: Dispatch<SetStateAction<string | null>>
  readonly runtimeProviderLabel: string | null
  readonly setRuntimeProviderLabel: Dispatch<SetStateAction<string | null>>
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setSessionIndexError: Dispatch<SetStateAction<string | null>>
  readonly setVoiceCaptureStatus: (status: import('./assistant-voice-model').VoiceCaptureStatus) => void
  readonly setVoiceResponsePendingId: (pendingId: string | null) => void
  readonly selectedExecution: AssistantTurnExecutionSelection
  readonly selectedModelChoice: AssistantModelChoice
  readonly routePolicy: AssistantRoutePolicy
  readonly voiceRoutes?: AssistantVoiceRoutes | undefined
  readonly inferencePolicy: AssistantInferencePolicy | null | undefined
  readonly localExecutionMessageLabel: string
  readonly localOrchestrator: LightweightOrchestrator | null
  readonly localConfirmationOrchestratorsRef: MutableRefObject<Map<string, LightweightOrchestrator>>
  readonly localHistory: LocalAssistantHistoryDependencies | null
  readonly supportsPersistedSessions: boolean
  readonly usesLocalConversationHistory: boolean
  readonly createPersistedChatSession: () => Promise<{ id: string } | null>
  readonly refreshPersistedSessionIndex: () => Promise<void>
  readonly refreshLocalSessionIndex: (conversationId?: string) => Promise<void>
  readonly productAssistantErrorCopy: (error: Error | import('@aurora/client').AuroraError) => string
  readonly assistantStreamScopeId: string
  readonly assistantStreamScope: { scopeId: string }
  readonly voiceTranscriptPreviewRef: MutableRefObject<string>
  readonly voicePendingAssistantIdRef: MutableRefObject<string | null>
  readonly activeVoiceSessionRef: MutableRefObject<string | null>
  readonly ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly clearVoiceResponseTimeout: () => void
  readonly ttsCallbacksRef: MutableRefObject<AssistantTurnsTtsCallbacks | null>
}

export interface AssistantTurnsController {
  readonly activeAssistantPendingId: string | null
  readonly activePendingIdRef: MutableRefObject<string | null>
  readonly lastStreamEventIdRef: MutableRefObject<string | null>
  readonly cancelledPendingIdsRef: MutableRefObject<Set<string>>
  readonly nativeBackgroundPendingTurnsRef: MutableRefObject<Map<string, NativeAssistantPendingTurnRecord>>
  readonly nativeBackgroundTerminalKeysRef: MutableRefObject<Set<string>>
  readonly nativeBackgroundReconciledKeysRef: MutableRefObject<Set<string>>
  readonly startAssistantTurn: (prompt: string, replayFrom?: string | null) => Promise<boolean>
  readonly handleNativeAssistantSnapshot: (snapshot: { subjects?: unknown[] | undefined }) => Promise<ReturnType<typeof nativeAssistantSnapshotRecoveryDecision>>
  readonly handleNativeAssistantEvent: (event: AuroraEvent<unknown>) => Promise<boolean>
  readonly markAssistantTurnFailed: (pendingId: string, failureCopy: string) => void
  readonly applyAssistantStreamUpdate: (update: AssistantStreamUpdate, pendingId: string) => void
  readonly settleSubstantiveStreamingAssistantMessages: (reason: 'tts_started' | 'response_text_observed') => void
  readonly settleVoicePendingFromObservedText: (observedText: string | null, reason: 'tts_started' | 'assistant_response') => void
  readonly setActiveAssistantPendingId: Dispatch<SetStateAction<string | null>>
  readonly showNativeMobileBackgroundTurn: (result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
  readonly reconcileNativeAssistantPersistence: (key: string, result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
}

export function useAssistantTurns(params: UseAssistantTurnsParams): AssistantTurnsController {
  const {
    client,
    route,
    runtimeHealth,
    surfaceProfile,
    session,
    sessionRef,
    setSession,
    setLocalConversationRows,
    abortRef,
    setText,
    setLastPrompt,
    setLastError,
    setLastResult,
    modelLabel,
    setModelLabel,
    runtimeProviderLabel,
    setRuntimeProviderLabel,
    setStreamState,
    setSessionIndexError,
    setVoiceCaptureStatus,
    setVoiceResponsePendingId,
    selectedExecution,
    selectedModelChoice,
    routePolicy,
    voiceRoutes,
    inferencePolicy,
    localExecutionMessageLabel,
    localOrchestrator,
    localConfirmationOrchestratorsRef,
    localHistory,
    supportsPersistedSessions,
    usesLocalConversationHistory,
    createPersistedChatSession,
    refreshPersistedSessionIndex,
    refreshLocalSessionIndex,
    productAssistantErrorCopy,
    assistantStreamScopeId,
    assistantStreamScope,
    voiceTranscriptPreviewRef,
    voicePendingAssistantIdRef,
    activeVoiceSessionRef,
    ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef,
    clearVoiceResponseTimeout,
    ttsCallbacksRef,
  } = params
  const [activeAssistantPendingId, setActiveAssistantPendingId] = useState<string | null>(null)
  const activePendingIdRef = useRef<string | null>(null)
  const lastStreamEventIdRef = useRef<string | null>(null)
  const cancelledPendingIdsRef = useRef<Set<string>>(new Set())
  const nativeBackgroundPendingTurnsRef = useRef<Map<string, NativeAssistantPendingTurnRecord>>(new Map())
  const nativeBackgroundTerminalKeysRef = useRef<Set<string>>(new Set())
  const nativeBackgroundReconciledKeysRef = useRef<Set<string>>(new Set())
  const {
    markAssistantTurnFailed,
    applyAssistantStreamUpdate,
    settleSubstantiveStreamingAssistantMessages,
    settleVoicePendingFromObservedText,
  } = createAssistantTurnStreamController({
    route,
    runtimeHealth,
    session,
    setSession,
    setLastError,
    setLastResult,
    modelLabel,
    setModelLabel,
    runtimeProviderLabel,
    setRuntimeProviderLabel,
    setStreamState,
    setVoiceCaptureStatus,
    setVoiceResponsePendingId,
    selectedExecution,
    localExecutionMessageLabel,
    usesLocalConversationHistory,
    productAssistantErrorCopy,
    assistantStreamScopeId,
    assistantStreamScope,
    activePendingIdRef,
    lastStreamEventIdRef,
    cancelledPendingIdsRef,
    voicePendingAssistantIdRef,
    activeVoiceSessionRef,
    ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef,
    clearVoiceResponseTimeout,
    ttsCallbacksRef,
    setActiveAssistantPendingId,
  })

  const {
    showNativeMobileBackgroundTurn,
    reconcileNativeAssistantPersistence,
    handleNativeAssistantSnapshot,
    handleNativeAssistantEvent,
  } = createAssistantNativeTurnController({
    route,
    sessionRef,
    setSession,
    setLocalConversationRows,
    setText,
    setLastError,
    setSessionIndexError,
    setStreamState,
    selectedModelChoice,
    runtimeProviderLabel,
    localExecutionMessageLabel,
    localHistory,
    assistantStreamScope,
    voiceTranscriptPreviewRef,
    activePendingIdRef,
    cancelledPendingIdsRef,
    nativeBackgroundPendingTurnsRef,
    nativeBackgroundTerminalKeysRef,
    nativeBackgroundReconciledKeysRef,
    applyAssistantStreamUpdate,
    setActiveAssistantPendingId,
  })

  const { startAssistantTurn } = createAssistantForegroundTurnController({
    client,
    route,
    surfaceProfile,
    session,
    setSession,
    abortRef,
    setText,
    setLastPrompt,
    setLastError,
    setLastResult,
    setModelLabel,
    runtimeProviderLabel,
    setStreamState,
    setSessionIndexError,
    selectedExecution,
    selectedModelChoice,
    routePolicy,
    ttsStreamRoute: voiceRoutes?.ttsStream,
    inferencePolicy,
    localExecutionMessageLabel,
    localOrchestrator,
    localConfirmationOrchestratorsRef,
    localHistory,
    supportsPersistedSessions,
    usesLocalConversationHistory,
    createPersistedChatSession,
    refreshPersistedSessionIndex,
    refreshLocalSessionIndex,
    productAssistantErrorCopy,
    assistantStreamScope,
    activePendingIdRef,
    lastStreamEventIdRef,
    cancelledPendingIdsRef,
    setActiveAssistantPendingId,
    applyAssistantStreamUpdate,
    markAssistantTurnFailed,
  })



  return {
    activeAssistantPendingId,
    activePendingIdRef,
    lastStreamEventIdRef,
    cancelledPendingIdsRef,
    nativeBackgroundPendingTurnsRef,
    nativeBackgroundTerminalKeysRef,
    nativeBackgroundReconciledKeysRef,
    startAssistantTurn,
    handleNativeAssistantSnapshot,
    handleNativeAssistantEvent,
    markAssistantTurnFailed,
    applyAssistantStreamUpdate,
    settleSubstantiveStreamingAssistantMessages,
    settleVoicePendingFromObservedText,
    setActiveAssistantPendingId,
    showNativeMobileBackgroundTurn,
    reconcileNativeAssistantPersistence,
  }
}
