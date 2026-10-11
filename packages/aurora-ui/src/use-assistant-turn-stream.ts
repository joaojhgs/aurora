import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AssistantMessage as SdkAssistantMessage, AssistantStreamUpdate, AuroraError } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import type {
  AssistantRuntimeHealth,
  AssistantStreamState,
  AssistantSessionSnapshot,
  AssistantUiMessage,
} from './assistant-view'
import type { AssistantTurnExecutionSelection, AssistantTurnsTtsCallbacks } from './use-assistant-turns'
import {
  applyAssistantAudioChunkUpdate,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  assistantMessageWithStreamingText,
  hasSubstantiveAssistantText,
  isAssistantPendingText,
  isAssistantPlaceholderText,
  metadataStringValue,
} from './assistant-session-persistence'
import { selectAssistantStreamingText, useAssistantStreamStore } from './state/assistant-stream-store'
import type { VoiceCaptureStatus } from './assistant-voice-model'
import { isAuroraErrorCode } from './assistant-session-model'

export interface AssistantTurnStreamController {
  readonly markAssistantTurnFailed: (pendingId: string, failureCopy: string) => void
  readonly applyAssistantStreamUpdate: (update: AssistantStreamUpdate, pendingId: string) => void
  readonly settleSubstantiveStreamingAssistantMessages: (reason: 'tts_started' | 'response_text_observed') => void
  readonly settleVoicePendingFromObservedText: (observedText: string | null, reason: 'tts_started' | 'assistant_response') => void
}

export interface CreateAssistantTurnStreamControllerParams {
  readonly route: RouteAvailability
  readonly runtimeHealth?: AssistantRuntimeHealth | undefined
  readonly session: AssistantSessionSnapshot
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly setLastResult: Dispatch<SetStateAction<SdkAssistantMessage | null>>
  readonly modelLabel: string | null
  readonly setModelLabel: Dispatch<SetStateAction<string | null>>
  readonly runtimeProviderLabel: string | null
  readonly setRuntimeProviderLabel: Dispatch<SetStateAction<string | null>>
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setVoiceCaptureStatus: (status: VoiceCaptureStatus) => void
  readonly setVoiceResponsePendingId: (pendingId: string | null) => void
  readonly selectedExecution: AssistantTurnExecutionSelection
  readonly localExecutionMessageLabel: string
  readonly usesLocalConversationHistory: boolean
  readonly productAssistantErrorCopy: (error: Error | AuroraError) => string
  readonly assistantStreamScopeId: string
  readonly assistantStreamScope: { scopeId: string }
  readonly activePendingIdRef: MutableRefObject<string | null>
  readonly lastStreamEventIdRef: MutableRefObject<string | null>
  readonly cancelledPendingIdsRef: MutableRefObject<Set<string>>
  readonly voicePendingAssistantIdRef: MutableRefObject<string | null>
  readonly activeVoiceSessionRef: MutableRefObject<string | null>
  readonly ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly clearVoiceResponseTimeout: () => void
  readonly ttsCallbacksRef: MutableRefObject<AssistantTurnsTtsCallbacks | null>
  readonly setActiveAssistantPendingId: Dispatch<SetStateAction<string | null>>
}

export function createAssistantTurnStreamController(params: CreateAssistantTurnStreamControllerParams): AssistantTurnStreamController {
  const {
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
  } = params

function markAssistantTurnFailed(pendingId: string, failureCopy: string) {
  const streamedText = selectAssistantStreamingText(pendingId, assistantStreamScopeId)(useAssistantStreamStore.getState())
  setLastError(failureCopy)
  useAssistantStreamStore.getState().fail(failureCopy, assistantStreamScope)
  setStreamState({
    status: 'lost',
    lastEventId: lastStreamEventIdRef.current,
    message: failureCopy
  })
  setSession((current) => ({
    ...current,
    messages: current.messages.map((message) =>
      message.id === pendingId
        ? {
            ...message,
            text: (() => {
              const effectiveMessage = streamedText === null ? message : { ...message, text: streamedText }
              return effectiveMessage.text.trim() && !isAssistantPendingText(effectiveMessage.text)
                ? effectiveMessage.text
                : failureCopy
            })(),
            status: 'failed',
            error: failureCopy
          }
        : message
    )
  }))
  useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
}

function applyAssistantStreamUpdate(update: AssistantStreamUpdate, pendingId: string) {
  if (cancelledPendingIdsRef.current.has(pendingId)) return
  if (update.eventId) {
    lastStreamEventIdRef.current = update.eventId
    if (update.kind !== 'delta') {
      setStreamState((current) => ({ ...current, lastEventId: update.eventId }))
    }
  }
  if (update.modelLabel) setModelLabel(update.modelLabel)
  const updateProviderLabel = metadataStringValue(update.metadata ?? {}, 'provider_label') ?? metadataStringValue(update.metadata ?? {}, 'provider')
  if (updateProviderLabel) setRuntimeProviderLabel(updateProviderLabel)
  if (update.kind === 'connecting') {
    setStreamState((current) => ({ ...current, status: 'streaming', message: update.text }))
    if (selectAssistantStreamingText(pendingId, assistantStreamScopeId)(useAssistantStreamStore.getState()) === null) {
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) => message.id === pendingId ? { ...message, text: update.text } : message)
      }))
    }
    return
  }
  if (update.kind === 'tts_playback_error') {
    setLastError('Speech playback was unavailable. Use the message play control to try again.')
    setStreamState((current) => ({
      ...current,
      status: 'idle',
      message: 'Aurora finished responding. Speech playback was unavailable.'
    }))
    return
  }
  if (update.kind === 'transport_lost') {
    const streamedText = selectAssistantStreamingText(pendingId, assistantStreamScopeId)(useAssistantStreamStore.getState())
    const failureCopy = productAssistantErrorCopy(update.error ?? new Error('Assistant stream disconnected.'))
    useAssistantStreamStore.getState().fail(failureCopy, assistantStreamScope)
    setLastError(failureCopy)
    setStreamState({
      status: 'lost',
      lastEventId: lastStreamEventIdRef.current,
      message: 'The answer was interrupted. Replay will continue from the last saved update when available.'
    })
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? (() => {
              const effectiveMessage = streamedText === null ? message : { ...message, text: streamedText }
              return {
                ...effectiveMessage,
                text: effectiveMessage.text.trim() ? effectiveMessage.text : failureCopy,
                status: 'failed' as const,
                error: failureCopy,
                errorCode: isAuroraErrorCode(update.error?.code) ? update.error.code : undefined
              }
            })()
          : message
      )
    }))
    useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
    return
  }
  if (update.kind === 'tool') {
    setSession((current) => ({
      ...current,
      sessionId: usesLocalConversationHistory ? current.sessionId : update.sessionId ?? current.sessionId,
      messages: current.messages.map((message) =>
        message.id === pendingId ? applyAssistantToolUpdate(assistantMessageWithStreamingText(message, pendingId, assistantStreamScopeId), update) : message
      )
    }))
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora needs your approval before continuing.' }))
    return
  }
  if (update.kind === 'tts_audio_chunk') {
    const hasPlayableAudio = update.ttsAudio?.final !== true && Boolean(update.ttsAudio?.audioData)
    const tts = ttsCallbacksRef.current
    if (hasPlayableAudio && tts) {
      if (tts.lastAssistantMessageIdRef.current === null) tts.lastAssistantMessageIdRef.current = pendingId
      if (!tts.speakingMessageIdRef.current) tts.setSpeakingMessageId(tts.lastAssistantMessageIdRef.current)
    }
    tts?.enqueueStreamedTtsAudio(update)
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId ? applyAssistantAudioChunkUpdate(assistantMessageWithStreamingText(message, pendingId, assistantStreamScopeId), update) : message
      )
    }))
    setStreamState((current) => ({
      ...current,
      status: current.status === 'streaming' ? 'streaming' : current.status,
      message: update.ttsAudio?.final
        ? 'Aurora finished speaking.'
        : hasPlayableAudio
          ? 'Aurora is speaking.'
          : current.message
    }))
    return
  }
  if (update.kind === 'failed') {
    const streamedText = selectAssistantStreamingText(pendingId, assistantStreamScopeId)(useAssistantStreamStore.getState())
    const failureCopy = productAssistantErrorCopy(update.error ?? new Error(update.text))
    useAssistantStreamStore.getState().fail(failureCopy, assistantStreamScope)
    setLastError(failureCopy)
    setStreamState((current) => ({ ...current, status: 'lost', message: failureCopy }))
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? (() => {
              const effectiveMessage = streamedText === null ? message : { ...message, text: streamedText }
              return {
                ...effectiveMessage,
                text: effectiveMessage.text.trim() ? effectiveMessage.text : failureCopy,
                status: 'failed' as const,
                error: failureCopy,
                errorCode: isAuroraErrorCode(update.error?.code) ? update.error.code : undefined
              }
            })()
          : message
      )
    }))
    useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
    return
  }
  if (update.kind === 'fallback') {
    setStreamState({
      status: 'fallback',
      lastEventId: update.eventId ?? lastStreamEventIdRef.current,
      message: 'Aurora continued with a complete response.'
    })
  }
  if (update.kind === 'completed' || update.kind === 'fallback') {
    const finalAssistantId = pendingId
    setLastResult({
      id: finalAssistantId,
      role: 'assistant',
      text: update.text,
      createdAt: new Date().toISOString()
    })
    const tts = ttsCallbacksRef.current
    if (tts) tts.lastAssistantMessageIdRef.current = finalAssistantId
    setSession((current) => {
      const existing = current.messages.find((message) => message.id === finalAssistantId)
      const baseMessage: AssistantUiMessage = existing
        ? assistantMessageWithStreamingText(existing, finalAssistantId, assistantStreamScopeId)
        : {
            id: finalAssistantId,
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString(),
            status: 'streaming',
            modelLabel: modelLabel ?? runtimeHealth?.selectedModel ?? null,
            providerLabel: runtimeProviderLabel ?? route.providerLabel,
            routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
            executionPeerId: selectedExecution.executionPeerId
          }
      const terminalMessage = applyAssistantTerminalUpdate({
        ...baseMessage,
        modelLabel: update.modelLabel ?? baseMessage.modelLabel,
        providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? baseMessage.providerLabel,
        routeLabel: baseMessage.routeLabel ?? (selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label),
        executionPeerId: baseMessage.executionPeerId ?? selectedExecution.executionPeerId
      }, update)
      const replaced = current.messages.some((message) => message.id === terminalMessage.id)
      return {
        sessionId: usesLocalConversationHistory
          ? current.sessionId ?? session.sessionId
          : update.sessionId ?? current.sessionId ?? session.sessionId,
        messages: replaced
          ? current.messages.map((message) => message.id === terminalMessage.id ? terminalMessage : message)
          : [...current.messages, terminalMessage]
      }
    })
    useAssistantStreamStore.getState().begin(finalAssistantId, assistantStreamScope)
    useAssistantStreamStore.getState().setText(update.text, assistantStreamScope)
    useAssistantStreamStore.getState().complete(assistantStreamScope)
    if (update.kind === 'completed') {
      setStreamState((current) => ({ ...current, status: 'idle', message: 'Aurora finished responding.' }))
    }
    return
  }
  if (update.kind === 'delta') {
    useAssistantStreamStore.getState().append(update.textDelta, assistantStreamScope)
  }
}

function settleSubstantiveStreamingAssistantMessages(reason: 'tts_started' | 'response_text_observed') {
  let settledVoicePending = false
  let settledActivePending = false
  setSession((current) => {
    let changed = false
    const messages = current.messages.map((message) => {
      const effectiveMessage = assistantMessageWithStreamingText(message, message.id, assistantStreamScopeId)
      if ((effectiveMessage.status === 'streaming' || effectiveMessage.status === 'sending') && hasSubstantiveAssistantText(effectiveMessage)) {
        changed = true
        if (message.id === voicePendingAssistantIdRef.current) settledVoicePending = true
        if (message.id === activePendingIdRef.current) settledActivePending = true
        return { ...effectiveMessage, status: 'sent' as const }
      }
      return message
    })
    return changed ? { ...current, messages } : current
  })
  if (settledVoicePending) {
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
  }
  if (settledActivePending) {
    activePendingIdRef.current = null
    setActiveAssistantPendingId(null)
  }
  setStreamState((current) => current.status === 'streaming'
    ? { ...current, status: 'idle', message: reason === 'tts_started' ? 'Assistant response received; spoken response is separate.' : current.message }
    : current)
}

function settleVoicePendingFromObservedText(observedText: string | null, reason: 'tts_started' | 'assistant_response') {
  const pendingId = voicePendingAssistantIdRef.current
  const textFromPlayback = observedText?.trim()
  if (!pendingId || !textFromPlayback) return
  let settled = false
  setSession((current) => {
    let changed = false
    const messages = current.messages.map((message) => {
      if (message.id !== pendingId) return message
      changed = true
      settled = true
      return {
        ...message,
        text: isAssistantPlaceholderText(message.text) ? textFromPlayback : message.text,
        status: 'sent' as const
      }
    })
    return changed ? { ...current, messages } : current
  })
  if (!settled) return
  ttsCallbacksRef.current && (ttsCallbacksRef.current.lastAssistantMessageIdRef.current = pendingId)
  voicePendingAssistantIdRef.current = null
  setVoiceResponsePendingId(null)
  clearVoiceResponseTimeout()
  activeVoiceSessionRef.current = null
  ownedVoiceSessionIdsRef.current.clear()
  coordinatorVoiceSessionIdsRef.current.clear()
  setVoiceCaptureStatus('idle')
  setStreamState((current) => current.status === 'streaming'
    ? {
        ...current,
        status: 'idle',
        message: reason === 'tts_started'
          ? 'Assistant response received.'
          : 'Voice response received from Aurora.'
      }
    : current)
}

  return {
    markAssistantTurnFailed,
    applyAssistantStreamUpdate,
    settleSubstantiveStreamingAssistantMessages,
    settleVoicePendingFromObservedText,
  }
}
