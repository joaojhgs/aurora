'use client'

import { buildAssistantVoiceModel } from './assistant-voice-model'
export { buildAssistantVoiceModel } from './assistant-voice-model'
export type {
  AssistantVoiceModel,
  VoiceCapabilityChip,
  VoiceCaptureStatus,
  VoiceControlModel,
  VoiceEventRow,
} from './assistant-voice-model'

import { useMemo, useRef, useState } from 'react'
import type { AttachmentContextPrivacyClass, AssistantMessage as SdkAssistantMessage } from '@aurora/client'
import type { AssistantStreamState, AssistantViewProps } from './assistant-view-types'
import { routePolicyFromRoute, useAssistantExecution } from './use-assistant-execution'
import { assistantConversationRows, useAssistantHistory } from './use-assistant-history'
import type { AssistantSessionSnapshot } from './assistant-session-persistence'
import { AuroraQueryProvider, useAuroraQueryScope, useAuroraStateScopeId } from './query'
import { useAssistantTts } from './use-assistant-tts'
import { useAssistantSessionActions } from './use-assistant-session-actions'
import { useAssistantAttachments } from './use-assistant-attachments'
import { useAssistantTurns } from './use-assistant-turns'
import { useAssistantVoice, useAssistantVoiceLifecycle } from './use-assistant-voice'
import { useNativeAssistantEvents } from './native-assistant-events'
import { AssistantViewShell } from './assistant-view-shell'
import { idleWaveformBars, mergeVoiceRuntimeEvents, waveformBarsFromLevel } from './assistant-voice-runtime-helpers'
import { useAssistantControllerBridge } from './use-assistant-controller-bridge'
import { productAssistantErrorCopy } from './assistant-view-copy'
import {
  assistantAttachmentPickerAccept,
  defaultAssistantStorageKey,
  emptyNativeCapabilityList,
  emptyNativePermissionList,
  emptyVoiceEventList,
  idleAssistantStreamState,
} from './assistant-view-types'
import {
  useAssistantNativeBackgroundResultPoll,
  useAssistantViewCleanupLifecycle,
} from './use-assistant-view-lifecycle'
import { remoteAudioConsentRouteKey } from './assistant-route-consent'
import {
  assistantVoiceLifecycleCallbacks,
  useAssistantDefaultVoiceRoutePolicy,
  useAssistantLocalRuntime,
  useAssistantRemoteAudioConsentReset,
  useAssistantSurfaceProfile,
} from './use-assistant-view-coordination'

export {
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantModelChoiceGroups,
  assistantModelChoices,
  assistantModelSourceGroups,
  defaultAssistantModelChoiceId,
  mergeAssistantModelCatalogs,
  routePolicyFromRoute,
} from './use-assistant-execution'

export { assistantMessageRuntimeLabel } from './assistant-message'
export {
  attachmentStateBadge,
  attachmentStatusFromBackend,
  attachmentToContextItem,
  contextIngestOutcomeIndex,
  createAttachmentDraft,
  fileToAttachmentDraft,
  formatBytes,
  imageMimeTypeFromFile,
  isAcceptedContextStatus,
  mapContextIngestOutcomesByPendingIndex,
  revokeAttachmentPreview,
  sourceLabel,
  summarizeAttachments,
  urlLabel,
  validateAssistantAttachmentFile,
} from './assistant-attachments'
export type { AssistantAttachmentDraft, AttachmentTrayStatus } from './assistant-attachments'
export {
  applyAssistantAudioChunkUpdate,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  assistantSessionFromPersisted,
  defaultAssistantSessionForTransport,
  emptyAssistantSession,
  isAssistantStreamHardTerminal,
  loadAssistantSession,
  persistAssistantSession,
  sortSessionsByModification,
  upsertSessionByModification,
} from './assistant-session-persistence'
export type {
  AssistantApprovalGrantScope,
  AssistantSessionSnapshot,
  AssistantToolCallCard,
  AssistantUiMessage,
  AssistantUiMessageStatus,
} from './assistant-session-persistence'
export type {
  AssistantControlState,
  AssistantConversationRow,
  AssistantExecutionOption,
  AssistantModelChoice,
  AssistantModelChoiceGroup,
  AssistantModelSourceGroup,
  AssistantRuntimeHealth,
  AssistantStreamState,
  AssistantStreamStatus,
  AssistantViewProps,
} from './assistant-view-types'


export function AssistantView(props: AssistantViewProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <AssistantQueryView {...props} />
  return (
    <AuroraQueryProvider client={props.client} surfaceProfile={props.surfaceProfile ?? null}>
      <AssistantQueryView {...props} />
    </AuroraQueryProvider>
  )
}

function AssistantQueryView({
  client,
  route,
  cancellationRoute,
  voiceRoutes,
  nativePlatform = 'not available',
  nativeAvailable = false,
  nativePermissions = emptyNativePermissionList,
  nativeCapabilities = emptyNativeCapabilityList,
  recentVoiceEvents = emptyVoiceEventList,
  storageKey = defaultAssistantStorageKey,
  initialSession,
  runtimeHealth,
  executionHost = 'this-device',
  localAssistant = null,
  surfaceProfile: providedSurfaceProfile,
  nativeVoice = null,
  nativeMobileVoice = null,
  browserSpeechPacks = null
}: AssistantViewProps) {
  const assistantStreamScopeId = useAuroraStateScopeId()
  const assistantStreamScope = useMemo(() => ({ scopeId: assistantStreamScopeId }), [assistantStreamScopeId])
  const [text, setText] = useState('')
  const [privacyClass] = useState<AttachmentContextPrivacyClass>('personal')
  const [lastResult, setLastResult] = useState<SdkAssistantMessage | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const [runtimeProviderLabel, setRuntimeProviderLabel] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [lastPrompt, setLastPrompt] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<AssistantStreamState>(() => idleAssistantStreamState())
  const assistantBridge = useAssistantControllerBridge()
  const {
    attachments,
    attachmentInputRef,
    hasContextUpload,
    contextSummary,
    clearAttachments,
    ingestPendingAttachments,
    openAttachmentPicker,
    onFileInput,
    removeAttachment,
  } = useAssistantAttachments({
    client,
    privacyClass,
    setLastError,
    formatError: productAssistantErrorCopy,
  })
  const surfaceProfile = useAssistantSurfaceProfile({ client, nativePlatform, providedSurfaceProfile })
  const voiceLifecycleCallbacks = assistantVoiceLifecycleCallbacks({
    setText,
    setLastError,
    setStreamState,
    bridge: assistantBridge,
  })
  const assistantVoice = useAssistantVoice({
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
    lifecycleCallbacks: voiceLifecycleCallbacks,
    buildVoiceModel: buildAssistantVoiceModel,
    remoteAudioConsentRouteKey,
    idleWaveformBars,
  })
  const {
    voiceCaptureStatus,
    setVoiceCaptureStatus,
    voiceResponsePendingId,
    voiceElapsedSeconds,
    usesNativeDesktopVoice,
    usesNativeMobileVoice,
    usesFocusedBrowserVoiceRuntime,
    nativeMobileBackgroundOwnsMicrophone,
    voiceCaptureButtonLabel,
    browserSpeechPacksRevision,
    browserLocalTtsVoiceId,
    voiceModel,
    handsFreeControl,
    connectedVoiceAccessGranted,
    remoteAudioConsentPending,
    toggleRemoteAudioConsent,
    requestVoiceToggle,
    handsFreeActive,
  } = assistantVoice
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const { localAssistantAvailable, localOrchestrator, localHistory } = useAssistantLocalRuntime({ localAssistant, executionHost })
  const {
    executionOptions,
    executionPeerLabels,
    selectedExecution,
    setExecutionOptionId,
    routePolicy,
    modelChoices,
    modelChoiceGroups,
    modelSourceGroups,
    selectedModelChoice,
    setSelectedModelChoiceId,
    modelSearchQuery,
    setModelSearchQuery,
    modelCatalogLoading,
    modelCatalogError,
    inferencePolicy,
    runtimeStrip,
    localExecutionMessageLabel,
  } = useAssistantExecution({
    client,
    route,
    runtimeHealth,
    executionHost,
    localExecutionAvailable: localAssistantAvailable,
    modelLabel,
    setModelLabel,
    setRuntimeProviderLabel,
    productAssistantErrorCopy,
  })
  const usesLocalConversationHistory = localHistory !== null
  const supportsPersistedSessions = !usesLocalConversationHistory
    && client.transport.kind !== 'mock'
    && client.transport.kind !== 'mesh'
  const {
    session,
    setSession,
    sessionRef,
    sessionIndex,
    localConversationRows,
    setLocalConversationRows,
    localConversationCursor,
    localConversationPageLoading,
    localConversationPageError,
    localMessagePageError,
    localMessageCursor,
    localMessagePageLoading,
    localHistoryScopeKey,
    sessionIndexLoading,
    setSessionIndexLoading,
    sessionIndexError,
    setSessionIndexError,
    mobileHistoryOpen,
    setMobileHistoryOpen,
    sessionAuthScope,
    openPersistedSession,
    openLocalSession,
    refreshPersistedSessionIndex,
    refreshLocalSessionIndex,
    loadMoreLocalSessions,
    loadOlderLocalMessages,
    createPersistedChatSession,
  } = useAssistantHistory({
    client,
    initialSession,
    storageKey,
    localHistory,
    supportsPersistedSessions,
    usesLocalConversationHistory,
    resetConversationUi,
    textAreaRef,
    setLastError,
    productAssistantErrorCopy,
  })
  const {
    activeAssistantPendingId,
    activePendingIdRef,
    lastStreamEventIdRef,
    cancelledPendingIdsRef,
    nativeBackgroundTerminalKeysRef,
    nativeBackgroundReconciledKeysRef,
    startAssistantTurn,
    handleNativeAssistantSnapshot,
    handleNativeAssistantEvent,
    settleSubstantiveStreamingAssistantMessages,
    settleVoicePendingFromObservedText,
    setActiveAssistantPendingId,
    showNativeMobileBackgroundTurn,
    reconcileNativeAssistantPersistence,
  } = useAssistantTurns({
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
    setVoiceResponsePendingId: assistantVoice.setVoiceResponsePendingId,
    selectedExecution,
    selectedModelChoice,
    routePolicy,
    voiceRoutes,
    inferencePolicy,
    localExecutionMessageLabel,
    localOrchestrator,
    localConfirmationOrchestratorsRef: assistantBridge.localConfirmationOrchestratorsRef,
    localHistory,
    supportsPersistedSessions,
    usesLocalConversationHistory,
    createPersistedChatSession,
    refreshPersistedSessionIndex,
    refreshLocalSessionIndex,
    productAssistantErrorCopy,
    assistantStreamScopeId,
    assistantStreamScope,
    voiceTranscriptPreviewRef: assistantVoice.voiceTranscriptPreviewRef,
    voicePendingAssistantIdRef: assistantVoice.voicePendingAssistantIdRef,
    activeVoiceSessionRef: assistantVoice.activeVoiceSessionRef,
    ownedVoiceSessionIdsRef: assistantVoice.ownedVoiceSessionIdsRef,
    coordinatorVoiceSessionIdsRef: assistantVoice.coordinatorVoiceSessionIdsRef,
    clearVoiceResponseTimeout: assistantBridge.clearVoiceResponseTimeout,
    ttsCallbacksRef: assistantBridge.assistantTurnsTtsCallbacksRef,
  })
  const conversationRows = usesLocalConversationHistory
    ? localConversationRows.map((row) => ({ ...row, active: row.id === session.sessionId }))
    : assistantConversationRows(session, sessionIndex, client.transport.kind)
  const sessionMessages = session.messages
  const {
    canSend,
    canAttach,
    assistantBusy,
    voiceBusy,
    primaryComposerAction,
    primaryComposerDisabled,
    primaryComposerLabel,
    primaryComposerAriaLabel,
    onSubmit,
    onComposerKeyDown,
    retryLastPrompt,
    onPrimaryComposerAction,
    startNewConversation,
    resolveAssistantToolApproval,
  } = useAssistantSessionActions({
    client,
    route,
    cancellationRoute,
    selectedExecution,
    localOrchestrator,
    session,
    setSession,
    supportsPersistedSessions,
    usesLocalConversationHistory,
    sessionIndexLoading,
    setSessionIndexLoading,
    hasContextUpload,
    attachmentsLength: attachments.length,
    ingestPendingAttachments,
    activeAssistantPendingId,
    voiceCaptureStatus,
    voiceResponsePendingId,
    lastPrompt,
    streamState,
    setStreamState,
    setLastError,
    startAssistantTurn,
    activePendingIdRef,
    cancelledPendingIdsRef,
    abortRef,
    assistantStreamScopeId,
    assistantStreamScope,
    setActiveAssistantPendingId,
    usesNativeDesktopVoice,
    usesFocusedBrowserVoiceRuntime,
    browserVoiceOperationTokenRef: assistantBridge.browserVoiceOperationTokenRef,
    activeVoiceSessionRef: assistantVoice.activeVoiceSessionRef,
    ownedVoiceSessionIdsRef: assistantVoice.ownedVoiceSessionIdsRef,
    setVoiceCaptureStatus,
    toggleLocalCapture: assistantBridge.toggleLocalCapture,
    cancelNativeDesktopVoice: assistantBridge.cancelNativeDesktopVoice,
    settleBrowserVoiceTurn: assistantBridge.settleBrowserVoiceTurn,
    createPersistedChatSession,
    resetConversationUi,
    setMobileHistoryOpen,
    textAreaRef,
    text,
    setText,
    localConfirmationOrchestratorsRef: assistantBridge.localConfirmationOrchestratorsRef,
    productAssistantErrorCopy,
  })
  const nativeAssistantEventState = useNativeAssistantEvents({
    client,
    enabled: usesNativeMobileVoice,
    lifecycleScopeKey: assistantStreamScopeId,
    onEvent: async (event) => { await handleNativeAssistantEvent(event) },
    onSnapshot: handleNativeAssistantSnapshot
  })
  const defaultVoiceRoutePolicy = useAssistantDefaultVoiceRoutePolicy({
    setLastError,
    setVoiceCaptureStatus,
    setStreamState,
  })
  const {
    speakingMessageId: speakingMessageIdState,
    speakingMessageIdRef,
    lastAssistantMessageIdRef,
    browserVoiceRemoteTtsAudioSeenRef,
    setSpeakingMessageId,
    enqueueStreamedTtsAudio,
    stopStreamedTtsPlayback,
    readAssistantMessageAloud,
    synthesizeBrowserReadAloud,
    interruptTtsForVoiceCapture,
    invalidateReadAloudFallback,
  } = useAssistantTts({
    client,
    sessionId: session.sessionId,
    usesLocalSidecar: surfaceProfile.usesLocalSidecar,
    browserLocalTtsVoiceId,
    resolveReadAloudRoutePolicy: () => defaultVoiceRoutePolicy(voiceModel.speechRoute),
    browserVoiceRuntime: assistantBridge.browserVoiceRuntime,
    cancelBrowserVoiceRuntime: assistantBridge.cancelBrowserVoiceRuntime,
    setStreamState,
    setLastError,
    productAssistantErrorCopy,
  })
  assistantBridge.assistantTurnsTtsCallbacksRef.current = {
    lastAssistantMessageIdRef,
    speakingMessageIdRef,
    setSpeakingMessageId,
    enqueueStreamedTtsAudio,
  }

  assistantBridge.connect({
    voiceEvents: {
      routeProviderLabel: route.providerLabel,
      runtimeProviderLabel,
      modelLabel,
      runtimeSelectedModelLabel: runtimeHealth?.selectedModel,
      localExecutionMessageLabel,
      supportsPersistedSessions,
      browserLocalTtsVoiceId,
      activeVoiceSessionRef: assistantVoice.activeVoiceSessionRef,
      ownedVoiceSessionIdsRef: assistantVoice.ownedVoiceSessionIdsRef,
      coordinatorVoiceSessionIdsRef: assistantVoice.coordinatorVoiceSessionIdsRef,
      appliedVoiceEventIdsRef: assistantVoice.appliedVoiceEventIdsRef,
      voicePendingAssistantIdRef: assistantVoice.voicePendingAssistantIdRef,
      voiceTranscriptPreviewRef: assistantVoice.voiceTranscriptPreviewRef,
      voiceCaptureStatusRef: assistantVoice.voiceCaptureStatusRef,
      voiceResponseTimeoutRef: assistantVoice.voiceResponseTimeoutRef,
      nativeVoiceStatusRef: assistantVoice.nativeVoiceStatusRef,
      nativeVoiceGenerationRef: assistantVoice.nativeVoiceGenerationRef,
      nativeDesktopBackgroundWakeActiveRef: assistantVoice.nativeDesktopBackgroundWakeActiveRef,
      nativeVoicePendingCancelReasonRef: assistantVoice.nativeVoicePendingCancelReasonRef,
      assistantViewDisposedRef: assistantBridge.assistantViewDisposedRef,
      browserVoiceRemoteTtsAudioSeenRef,
      speakingMessageIdRef,
      lastAssistantMessageIdRef,
      nativeVoiceAvailable: Boolean(nativeVoice),
      setVoiceWaveformBars: assistantVoice.setVoiceWaveformBars,
      setStreamState,
      setVoiceCaptureStatus,
      setNativeVoiceStatusState: assistantVoice.setNativeVoiceStatusState,
      setNativeDesktopBackgroundWakeActive: assistantVoice.setNativeDesktopBackgroundWakeActive,
      setSpeakingMessageId,
      setText,
      setLastPrompt,
      setLastError,
      setLastResult,
      setModelLabel,
      setRuntimeProviderLabel,
      setVoiceResponsePendingId: assistantVoice.setVoiceResponsePendingId,
      setSession,
      productAssistantErrorCopy,
      waveformBarsFromLevel,
      settleVoicePendingFromObservedText,
      settleSubstantiveStreamingAssistantMessages,
      enqueueStreamedTtsAudio,
      synthesizeBrowserReadAloud,
      openPersistedSession,
      cancelNativeDesktopVoiceGeneration: assistantBridge.cancelNativeDesktopVoiceGeneration,
    },
    capture: {
      client,
      surfaceProfile,
      nativeVoice,
      nativeMobileVoice,
      readyBrowserSpeechPacks: assistantVoice.readyBrowserSpeechPacks,
      voiceModel,
      usesNativeDesktopVoice,
      usesNativeMobileVoice,
      usesFocusedBrowserVoiceRuntime,
      assistantViewDisposedRef: assistantBridge.assistantViewDisposedRef,
      activeVoiceSessionRef: assistantVoice.activeVoiceSessionRef,
      ownedVoiceSessionIdsRef: assistantVoice.ownedVoiceSessionIdsRef,
      coordinatorVoiceSessionIdsRef: assistantVoice.coordinatorVoiceSessionIdsRef,
      voicePendingAssistantIdRef: assistantVoice.voicePendingAssistantIdRef,
      voiceTranscriptPreviewRef: assistantVoice.voiceTranscriptPreviewRef,
      voiceCaptureStatusRef: assistantVoice.voiceCaptureStatusRef,
      nativeVoiceStatusRef: assistantVoice.nativeVoiceStatusRef,
      nativeVoiceGenerationRef: assistantVoice.nativeVoiceGenerationRef,
      nativeDesktopBackgroundWakeActiveRef: assistantVoice.nativeDesktopBackgroundWakeActiveRef,
      nativeVoiceOperationTokenRef: assistantVoice.nativeVoiceOperationTokenRef,
      nativeVoicePendingCancelReasonRef: assistantVoice.nativeVoicePendingCancelReasonRef,
      nativeVoiceCancelledGenerationsRef: assistantVoice.nativeVoiceCancelledGenerationsRef,
      nativeMobileVoiceOperationTokenRef: assistantVoice.nativeMobileVoiceOperationTokenRef,
      nativeMobileVoiceStartInFlightRef: assistantVoice.nativeMobileVoiceStartInFlightRef,
      nativeMobileBackgroundWakeActiveRef: assistantVoice.nativeMobileBackgroundWakeActiveRef,
      browserVoiceRuntimeRef: assistantBridge.browserVoiceRuntimeRef,
      browserVoiceRuntimeEventUnsubscribeRef: assistantBridge.browserVoiceRuntimeEventUnsubscribeRef,
      browserVoiceOperationTokenRef: assistantBridge.browserVoiceOperationTokenRef,
      browserVoiceTurnSettlementRef: assistantBridge.browserVoiceTurnSettlementRef,
      browserVoiceLocalTranscriptRef: assistantVoice.browserVoiceLocalTranscriptRef,
      setText,
      setLastError,
      setStreamState,
      setVoiceCaptureStatus,
      setVoiceEvents: assistantVoice.setVoiceEvents,
      setVoiceResponsePendingId: assistantVoice.setVoiceResponsePendingId,
      setVoiceWaveformBars: assistantVoice.setVoiceWaveformBars,
      setNativeVoiceStatusState: assistantVoice.setNativeVoiceStatusState,
      setNativeDesktopBackgroundWakeActive: assistantVoice.setNativeDesktopBackgroundWakeActive,
      setNativeMobileBackgroundWakeActive: assistantVoice.setNativeMobileBackgroundWakeActive,
      remoteAudioConsentForCurrentRoute: assistantVoice.remoteAudioConsentForCurrentRoute,
      defaultVoiceRoutePolicy,
      routePolicyFromRoute,
      productAssistantErrorCopy,
      applyNativeDesktopVoiceStatus: assistantBridge.applyNativeDesktopVoiceStatus,
      interruptTtsForVoiceCapture,
      startAssistantTurn,
      waveformBarsFromLevel,
      mergeVoiceRuntimeEvents,
    },
  })
  useAssistantRemoteAudioConsentReset(assistantVoice)

  useAssistantViewCleanupLifecycle({
    browserSpeechPacksRevision,
    assistantViewDisposedRef: assistantBridge.assistantViewDisposedRef,
    abortRef,
    localConfirmationOrchestratorsRef: assistantBridge.localConfirmationOrchestratorsRef,
    clearVoiceResponseTimeout: assistantBridge.clearVoiceResponseTimeout,
    stopStreamedTtsPlayback,
    cancelNativeDesktopVoice: assistantBridge.cancelNativeDesktopVoice,
    nativeMobileBackgroundWakeActiveRef: assistantVoice.nativeMobileBackgroundWakeActiveRef,
    nativeMobileVoiceOperationTokenRef: assistantVoice.nativeMobileVoiceOperationTokenRef,
    nativeMobileVoiceStartInFlightRef: assistantVoice.nativeMobileVoiceStartInFlightRef,
    voiceCaptureStatusRef: assistantVoice.voiceCaptureStatusRef,
    cancelNativeMobileVoice: assistantBridge.cancelNativeMobileVoice,
    browserVoiceOperationTokenRef: assistantBridge.browserVoiceOperationTokenRef,
    settleBrowserVoiceTurn: assistantBridge.settleBrowserVoiceTurn,
    browserVoiceTurnSettlementRef: assistantBridge.browserVoiceTurnSettlementRef,
    waitForBrowserVoiceTurnSettlement: assistantBridge.waitForBrowserVoiceTurnSettlement,
    disposeBrowserVoiceRuntime: assistantBridge.disposeBrowserVoiceRuntime,
    invalidateReadAloudFallback,
    browserVoiceRuntimeRef: assistantBridge.browserVoiceRuntimeRef,
    clearBrowserVoiceRuntimeEventSubscription: assistantBridge.clearBrowserVoiceRuntimeEventSubscription,
  })

  useAssistantVoiceLifecycle({
    client,
    recentVoiceEvents,
    surfaceProfile,
    nativeVoice,
    nativeMobileVoice,
    sessionAuthScope,
    voice: assistantVoice,
    lifecycleCallbacks: voiceLifecycleCallbacks,
  })

  function resetConversationUi(nextSession: AssistantSessionSnapshot) {
    abortRef.current?.abort()
    assistantBridge.releaseBrowserVoiceCaptureForReason('conversation_reset')
    assistantVoice.activeVoiceSessionRef.current = null
    assistantVoice.ownedVoiceSessionIdsRef.current.clear()
    assistantVoice.coordinatorVoiceSessionIdsRef.current.clear()
    cancelledPendingIdsRef.current.clear()
    activePendingIdRef.current = null
    clearAttachments()
    setSession(nextSession)
    setLastResult(null)
    setLastError(null)
    setLastPrompt(null)
    setStreamState(idleAssistantStreamState())
    lastStreamEventIdRef.current = null
    assistantVoice.voiceTranscriptPreviewRef.current = ''
    setVoiceCaptureStatus('idle')
    setText('')
  }

  useAssistantNativeBackgroundResultPoll({
    localHistory,
    pollScopeKey: `${assistantStreamScopeId}:${client.transport.kind}:${nativePlatform ?? 'unknown'}`,
    usesNativeMobileVoice,
    nativeMobileVoice,
    nativeAssistantEventConsumerStatus: nativeAssistantEventState.status,
    nativeBackgroundTerminalKeysRef,
    nativeBackgroundReconciledKeysRef,
    voiceTranscriptPreviewRef: assistantVoice.voiceTranscriptPreviewRef,
    setText,
    reconcileNativeAssistantPersistence,
    showNativeMobileBackgroundTurn,
    setVoiceCaptureStatus,
    setLastError,
  })


  return (
    <AssistantViewShell
      runtimeStrip={runtimeStrip}
      streamState={streamState}
      lastPrompt={lastPrompt}
      canSend={canSend}
      onRetryLastPrompt={retryLastPrompt}
      conversationRows={conversationRows}
      conversationHasMore={usesLocalConversationHistory && localConversationCursor !== null}
      conversationPageLoading={localConversationPageLoading}
      conversationPageError={localConversationPageError}
      onLoadMoreConversations={loadMoreLocalSessions}
      sessionIndexLoading={sessionIndexLoading}
      sessionIndexError={sessionIndexError}
      conversationDisabled={assistantBusy || voiceBusy}
      newConversationDisabled={client.transport.kind === 'mesh' && !usesLocalConversationHistory}
      usesLocalConversationHistory={usesLocalConversationHistory}
      onOpenLocalSession={openLocalSession}
      onOpenPersistedSession={openPersistedSession}
      onNewConversation={startNewConversation}
      sessionMessages={sessionMessages}
      messagesHasMore={usesLocalConversationHistory && localMessageCursor !== null}
      messagePageLoading={localMessagePageLoading}
      messagePageError={localMessagePageError}
      onLoadOlderMessages={loadOlderLocalMessages}
      historyScopeKey={localHistoryScopeKey}
      conversationId={session.sessionId}
      onReadAssistantMessageAloud={readAssistantMessageAloud}
      onResolveAssistantToolApproval={resolveAssistantToolApproval}
      speakingMessageId={speakingMessageIdState}
      executionPeerLabels={executionPeerLabels}
      streamScopeId={assistantStreamScopeId}
      onSubmit={onSubmit}
      voiceCaptureStatus={voiceCaptureStatus}
      mobileHistoryOpen={mobileHistoryOpen}
      onMobileHistoryOpenChange={setMobileHistoryOpen}
      executionOptions={executionOptions}
      selectedExecution={selectedExecution}
      onExecutionOptionChange={setExecutionOptionId}
      modelChoices={modelChoices}
      selectedModelChoice={selectedModelChoice}
      onModelChoiceChange={setSelectedModelChoiceId}
      modelCatalogError={modelCatalogError}
      modelCatalogLoading={modelCatalogLoading}
      modelSearchQuery={modelSearchQuery}
      onModelSearchQueryChange={setModelSearchQuery}
      modelChoiceGroups={modelChoiceGroups}
      modelSourceGroups={modelSourceGroups}
      attachments={attachments}
      contextSummary={contextSummary}
      attachmentInputRef={attachmentInputRef}
      attachmentPickerAccept={assistantAttachmentPickerAccept}
      canAttach={canAttach}
      onFileInput={(files) => void onFileInput(files, canAttach)}
      onRemoveAttachment={removeAttachment}
      onOpenAttachmentPicker={() => void openAttachmentPicker(canAttach)}
      connectedVoiceAccessGranted={connectedVoiceAccessGranted}
      remoteAudioConsentPending={remoteAudioConsentPending}
      onToggleRemoteAudioConsent={toggleRemoteAudioConsent}
      textAreaRef={textAreaRef}
      text={text}
      onTextChange={setText}
      onComposerKeyDown={onComposerKeyDown}
      routeDisabled={route.disabled}
      voiceModel={voiceModel}
      voiceElapsedSeconds={voiceElapsedSeconds}
      nativeMobileBackgroundOwnsMicrophone={nativeMobileBackgroundOwnsMicrophone}
      onRequestVoiceToggle={requestVoiceToggle}
      voiceCaptureButtonLabel={voiceCaptureButtonLabel}
      usesNativeDesktopVoice={usesNativeDesktopVoice}
      handsFreeControl={handsFreeControl}
      handsFreeActive={handsFreeActive}
      onToggleNativeDesktopBackgroundWake={assistantBridge.toggleNativeDesktopBackgroundWake}
      primaryComposerAction={primaryComposerAction}
      primaryComposerDisabled={primaryComposerDisabled}
      primaryComposerAriaLabel={primaryComposerAriaLabel}
      primaryComposerLabel={primaryComposerLabel}
      onPrimaryComposerAction={onPrimaryComposerAction}
      lastError={lastError}
    />
  )
}

export { assistantControlsForRoute } from './use-assistant-session-actions'
export { idleAssistantStreamState } from './assistant-view-types'
export {
  assistantPrivacyClassCopy,
  assistantRemotePrivacyWarning,
  productAssistantErrorCopy,
  assistantErrorMessage,
} from './assistant-view-copy'
export { mergeTranscriptText, isAuthoritativeVoiceTranscriptEvent } from './assistant-voice-runtime-helpers'
