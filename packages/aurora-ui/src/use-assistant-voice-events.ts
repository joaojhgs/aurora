import type { AssistantStreamUpdate, VoiceRuntimeEvent } from '@aurora/client'
import type { NativeDesktopVoiceStatus } from './native-desktop-voice'
import {
  applyAssistantAudioChunkUpdate,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  metadataStringValue,
} from './assistant-session-persistence'
import { voiceRuntimeEventKey } from './assistant-browser-voice-runtime'
import {
  isAuthoritativeCoordinatorSessionStart,
  isAuthoritativeVoiceTranscriptEvent,
  isLocalVoiceEventSource,
  mergeTranscriptText,
  nativeDesktopVoiceCaptureStatus,
  shouldApplyVoiceRuntimeEvent,
  shouldApplyVoiceSessionEndEvent,
  shouldIgnoreForeignVoiceSessionEvent,
} from './assistant-voice-runtime-helpers'
import type { AssistantVoiceEventController, AssistantVoiceEventControllerOptions } from './assistant-voice-event-controller-types'

export function createAssistantVoiceEventController(options: AssistantVoiceEventControllerOptions): AssistantVoiceEventController {
  function clearVoiceResponseTimeout() {
    if (options.voiceResponseTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(options.voiceResponseTimeoutRef.current)
    }
    options.voiceResponseTimeoutRef.current = null
  }

  function markVoiceAssistantFailed(pendingId: string, failureCopy: string) {
    options.setLastError(failureCopy)
    options.setVoiceCaptureStatus('error')
    options.setStreamState((current) => ({
      status: 'lost',
      lastEventId: current.lastEventId,
      message: failureCopy
    }))
    options.voicePendingAssistantIdRef.current = null
    options.setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
    options.activeVoiceSessionRef.current = null
    options.ownedVoiceSessionIdsRef.current.clear()
    options.coordinatorVoiceSessionIdsRef.current.clear()
    options.setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? { ...message, text: failureCopy, status: 'failed', error: failureCopy }
          : message
      )
    }))
  }

  function armVoiceResponseTimeout(pendingId: string) {
    clearVoiceResponseTimeout()
    if (typeof window === 'undefined') return
    options.voiceResponseTimeoutRef.current = window.setTimeout(() => {
      if (options.voicePendingAssistantIdRef.current !== pendingId) return
      markVoiceAssistantFailed(pendingId, 'Aurora did not return a voice response before the response timeout. Retry will resend the final transcript.')
    }, 120_000)
  }
  function voiceRuntimeErrorCopy(reason: string | null | undefined): string | null {
    if (!reason) return null
    return options.productAssistantErrorCopy(new Error(reason))
  }

  function applyVoiceRuntimeEvent(event: VoiceRuntimeEvent) {
    const eventKey = voiceRuntimeEventKey(event)
    if (event.kind !== 'audio_level') {
      if (options.appliedVoiceEventIdsRef.current.has(eventKey)) return
      options.appliedVoiceEventIdsRef.current.add(eventKey)
    }
    if (event.kind === 'audio_level') {
      if (!shouldApplyVoiceRuntimeEvent(event, options.activeVoiceSessionRef.current, options.voiceCaptureStatusRef.current)) return
      options.setVoiceWaveformBars(event.bars?.length ? event.bars : options.waveformBarsFromLevel(event.level ?? 0, event.peak ?? event.level ?? 0))
      if (event.sessionId) {
        options.ownedVoiceSessionIdsRef.current.add(event.sessionId)
        options.activeVoiceSessionRef.current = event.sessionId
      }
      return
    }
    if (event.kind === 'wakeword_detected') {
      options.setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: event.text ? `Wake word heard: ${event.text}` : 'Wake word heard.'
      }))
      return
    }
    if (event.kind === 'session_started') {
      if (event.sessionId) {
        const activeSessionId = options.activeVoiceSessionRef.current
        if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, options.voiceCaptureStatusRef.current)) return
        if (!options.ownedVoiceSessionIdsRef.current.has(event.sessionId) && !isLocalVoiceEventSource(event)) return
        options.ownedVoiceSessionIdsRef.current.add(event.sessionId)
        if (isAuthoritativeCoordinatorSessionStart(event)) {
          options.coordinatorVoiceSessionIdsRef.current.add(event.sessionId)
        }
        options.activeVoiceSessionRef.current = event.sessionId
      }
      options.voiceTranscriptPreviewRef.current = ''
      options.setText('')
      options.setVoiceCaptureStatus('listening')
      options.setStreamState((current) => ({ ...current, status: 'streaming', message: event.text ? `Wake word heard: ${event.text}` : 'Aurora is listening.' }))
      return
    }
    if (event.kind === 'transcription_partial') {
      if (!isAuthoritativeVoiceTranscriptEvent(event)) return
      const transcriptSessionId = event.sessionId ?? options.activeVoiceSessionRef.current
      if (!transcriptSessionId || !options.coordinatorVoiceSessionIdsRef.current.has(transcriptSessionId)) return
      if (!shouldApplyVoiceRuntimeEvent(event, options.activeVoiceSessionRef.current, options.voiceCaptureStatusRef.current)) return
      if (event.sessionId) {
        options.ownedVoiceSessionIdsRef.current.add(event.sessionId)
        options.activeVoiceSessionRef.current = event.sessionId
      }
      if (event.text) {
        const preview = mergeTranscriptText(options.voiceTranscriptPreviewRef.current, event.text, { appendOnMiss: false })
        options.voiceTranscriptPreviewRef.current = preview
        options.setText(preview)
      }
      options.setVoiceCaptureStatus('listening')
      return
    }
    if (event.kind === 'transcription_final') {
      if (!isAuthoritativeVoiceTranscriptEvent(event)) return
      const transcriptSessionId = event.sessionId ?? options.activeVoiceSessionRef.current
      if (!transcriptSessionId || !options.coordinatorVoiceSessionIdsRef.current.has(transcriptSessionId)) return
      if (!shouldApplyVoiceRuntimeEvent(event, options.activeVoiceSessionRef.current, options.voiceCaptureStatusRef.current)) return
      if (event.sessionId) {
        options.ownedVoiceSessionIdsRef.current.add(event.sessionId)
        options.activeVoiceSessionRef.current = event.sessionId
      }
      const transcript = mergeTranscriptText(options.voiceTranscriptPreviewRef.current, event.text ?? '', { appendOnMiss: false }).trim()
      options.setVoiceCaptureStatus('idle')
      options.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
      if (!transcript) {
        options.setVoiceCaptureStatus('idle')
        return
      }
      const userId = `voice-user-${event.sessionId ?? eventKey}`
      const pendingId = event.sessionId ?? `voice-assistant-${eventKey}`
      options.voicePendingAssistantIdRef.current = pendingId
      options.browserVoiceRemoteTtsAudioSeenRef.current = false
      options.setVoiceResponsePendingId(pendingId)
      armVoiceResponseTimeout(pendingId)
      options.voiceTranscriptPreviewRef.current = ''
      options.setText('')
      options.setLastPrompt(transcript)
      options.setSession((current) => {
        const hasUser = current.messages.some((message) => message.id === userId)
        const hasPending = current.messages.some((message) => message.id === pendingId)
        return {
          sessionId: event.sessionId ?? current.sessionId,
          messages: [
            ...current.messages,
            ...(hasUser ? [] : [{
              id: userId,
              role: 'user' as const,
              text: transcript,
              createdAt: event.occurredAt,
              status: 'sent' as const
            }]),
            ...(hasPending ? [] : [{
              id: pendingId,
              role: 'assistant' as const,
              text: 'Aurora is processing your voice request…',
              createdAt: new Date().toISOString(),
              status: 'streaming' as const,
              modelLabel: options.modelLabel ?? options.runtimeSelectedModelLabel ?? null,
              providerLabel: options.runtimeProviderLabel ?? options.routeProviderLabel,
              routeLabel: options.localExecutionMessageLabel
            }])
          ]
        }
      })
      return
    }
    if (event.kind === 'session_ended') {
      if (!shouldApplyVoiceSessionEndEvent(event, options.activeVoiceSessionRef.current, options.voiceCaptureStatusRef.current)) return
      options.setSpeakingMessageId(null)
      options.setVoiceCaptureStatus('idle')
      options.activeVoiceSessionRef.current = null
      options.ownedVoiceSessionIdsRef.current.clear()
      options.coordinatorVoiceSessionIdsRef.current.clear()
      return
    }
    if (event.kind === 'tts_started') {
      options.settleVoicePendingFromObservedText(event.text ?? null, 'tts_started')
      options.settleSubstantiveStreamingAssistantMessages('tts_started')
      if (options.voiceCaptureStatusRef.current !== 'listening') {
        options.setVoiceCaptureStatus('idle')
      }
      if (!options.speakingMessageIdRef.current && options.lastAssistantMessageIdRef.current) {
        options.setSpeakingMessageId(options.lastAssistantMessageIdRef.current)
      }
      return
    }
    if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') {
      if (event.kind === 'tts_stopped') options.setSpeakingMessageId(null)
      if (options.voiceCaptureStatusRef.current !== 'listening') options.setVoiceCaptureStatus('idle')
      return
    }
    if (event.kind === 'tts_error') {
      options.setSpeakingMessageId(null)
      const failureCopy = voiceRuntimeErrorCopy(event.reason)
      if (failureCopy) options.setLastError(failureCopy)
      options.setVoiceCaptureStatus('idle')
      return
    }
    if (event.state === 'denied' || event.state === 'error' || event.state === 'timeout' || event.state === 'disconnected') {
      options.setVoiceCaptureStatus(event.state === 'denied' ? 'permission-denied' : 'error')
      const failureCopy = voiceRuntimeErrorCopy(event.reason)
      if (failureCopy) options.setLastError(failureCopy)
    }
  }
  function applyVoiceAssistantResponse(update: AssistantStreamUpdate) {
    const pendingId = options.voicePendingAssistantIdRef.current
    if (update.modelLabel) options.setModelLabel(update.modelLabel)
    const providerLabel = metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? options.runtimeProviderLabel ?? options.routeProviderLabel
    if (providerLabel) options.setRuntimeProviderLabel(providerLabel)
    if (!pendingId && options.supportsPersistedSessions && update.sessionId && (update.kind === 'completed' || update.kind === 'fallback')) {
      options.setVoiceCaptureStatus('idle')
      options.setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      options.activeVoiceSessionRef.current = null
      options.ownedVoiceSessionIdsRef.current.clear()
      options.coordinatorVoiceSessionIdsRef.current.clear()
      options.setStreamState((current) => ({ ...current, status: 'idle', message: 'Voice response was saved to the active chat.' }))
      void options.openPersistedSession(update.sessionId, false)
      return
    }
    if (update.kind === 'failed' || update.kind === 'transport_lost') {
      const failureCopy = options.productAssistantErrorCopy(update.error ?? new Error(update.text || 'Voice assistant response failed.'))
      options.setLastError(failureCopy)
      options.setVoiceCaptureStatus('error')
      options.voicePendingAssistantIdRef.current = null
      options.setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      options.activeVoiceSessionRef.current = null
      options.ownedVoiceSessionIdsRef.current.clear()
      options.coordinatorVoiceSessionIdsRef.current.clear()
      if (!pendingId) return
      options.setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? { ...message, text: failureCopy, status: 'failed', error: failureCopy } : message
        )
      }))
      return
    }
    const textDelta = update.textDelta || update.text
    if (update.kind === 'delta' && pendingId) {
      options.setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantStreamDelta(message, { ...update, textDelta }) : message
        )
      }))
      return
    }
    if (update.kind === 'tool' && pendingId) {
      options.setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantToolUpdate(message, update, 'Aurora is processing your voice request…') : message
        )
      }))
      return
    }
    if (update.kind === 'tts_audio_chunk') {
      const hasPlayableAudio = update.ttsAudio?.final !== true && Boolean(update.ttsAudio?.audioData)
      if (hasPlayableAudio && pendingId && !options.speakingMessageIdRef.current) options.setSpeakingMessageId(pendingId)
      options.enqueueStreamedTtsAudio(update)
      if (pendingId) {
        options.setSession((current) => ({
          ...current,
          messages: current.messages.map((message) =>
            message.id === pendingId ? applyAssistantAudioChunkUpdate(message, update) : message
          )
        }))
      }
      options.setVoiceCaptureStatus('idle')
      options.setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      options.setStreamState((current) => ({
        ...current,
        status: 'idle',
        message: update.ttsAudio?.final
          ? 'Aurora finished speaking.'
          : hasPlayableAudio
            ? 'Aurora is speaking.'
            : current.message
      }))
      return
    }
    if (update.kind !== 'completed' && update.kind !== 'fallback') return
    const shouldSpeakWithBrowserTts = Boolean(
      options.browserLocalTtsVoiceId
      && !options.browserVoiceRemoteTtsAudioSeenRef.current
      && update.text.trim()
    )
    options.setVoiceCaptureStatus('idle')
    options.voicePendingAssistantIdRef.current = null
    options.setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
    options.activeVoiceSessionRef.current = null
    options.ownedVoiceSessionIdsRef.current.clear()
    options.coordinatorVoiceSessionIdsRef.current.clear()
    options.setStreamState((current) => ({ ...current, status: 'idle', message: 'Voice response received from Aurora.' }))
    const finalAssistantId = pendingId ?? update.messageId ?? `assistant-voice-${Date.now()}`
    const terminalCreatedAt = new Date().toISOString()
    options.setLastResult({
      id: finalAssistantId,
      role: 'assistant',
      text: update.text,
      createdAt: terminalCreatedAt
    })
    options.lastAssistantMessageIdRef.current = finalAssistantId
    options.setSession((current) => {
      const existing = current.messages.find((message) => message.id === finalAssistantId)
      const assistantMessage = applyAssistantTerminalUpdate({
        id: finalAssistantId,
        role: 'assistant',
        text: '',
        createdAt: terminalCreatedAt,
        status: 'streaming',
        modelLabel: update.modelLabel ?? options.modelLabel,
        providerLabel,
        routeLabel: options.localExecutionMessageLabel,
        ...(existing || {})
      }, update)
      const replaced = current.messages.some((message) => message.id === assistantMessage.id)
      return {
        sessionId: update.sessionId ?? current.sessionId,
        messages: replaced
          ? current.messages.map((message) => message.id === assistantMessage.id ? assistantMessage : message)
          : [...current.messages, assistantMessage]
      }
    })
    if (shouldSpeakWithBrowserTts) {
      void options.synthesizeBrowserReadAloud(update.text, pendingId ?? update.messageId ?? options.lastAssistantMessageIdRef.current)
        .then((played) => {
          if (played) options.setStreamState((current) => ({ ...current, message: 'Aurora is speaking.' }))
        })
        .catch(() => undefined)
    }
  }
  function applyNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus) {
    options.nativeVoiceStatusRef.current = status
    options.nativeVoiceGenerationRef.current = status.generation
    options.setNativeVoiceStatusState(status)
    options.setVoiceCaptureStatus(nativeDesktopVoiceCaptureStatus(status.phase))
    if (!status.available || status.phase === 'unavailable') {
      options.nativeDesktopBackgroundWakeActiveRef.current = false
      options.setNativeDesktopBackgroundWakeActive(false)
      options.activeVoiceSessionRef.current = null
      options.ownedVoiceSessionIdsRef.current.clear()
      options.coordinatorVoiceSessionIdsRef.current.clear()
      options.setSpeakingMessageId(null)
      return
    }
    if (status.generation !== null) {
      const sessionId = `native-desktop-${status.generation}`
      options.activeVoiceSessionRef.current = sessionId
      options.ownedVoiceSessionIdsRef.current.add(sessionId)
    }
    if (status.phase === 'idle' || status.phase === 'stopping' || status.phase === 'faulted') {
      options.nativeDesktopBackgroundWakeActiveRef.current = false
      options.setNativeDesktopBackgroundWakeActive(false)
      options.activeVoiceSessionRef.current = null
      options.ownedVoiceSessionIdsRef.current.clear()
      options.coordinatorVoiceSessionIdsRef.current.clear()
      options.setSpeakingMessageId(null)
    }
    if (status.phase === 'listening') {
      options.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is listening.' }))
    } else if (status.phase === 'processing') {
      options.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    } else if (status.phase === 'speaking') {
      options.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is speaking.' }))
    } else if (status.phase === 'faulted') {
      options.setLastError('Voice could not start. Check this device and try again.')
      options.setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not start. Check this device and try again.' }))
    }
  }
  function maybeCancelDeferredNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus): boolean {
    const reason = options.nativeVoicePendingCancelReasonRef.current
      ?? (options.assistantViewDisposedRef.current ? 'shutdown' : null)
    if (reason === null) return false
    if (status.generation !== null && options.nativeVoiceAvailable) {
      void options.cancelNativeDesktopVoiceGeneration(status.generation, reason)
    }
    return true
  }
  return {
    applyVoiceRuntimeEvent,
    applyVoiceAssistantResponse,
    applyNativeDesktopVoiceStatus,
    maybeCancelDeferredNativeDesktopVoiceStatus,
    armVoiceResponseTimeout,
    clearVoiceResponseTimeout,
    markVoiceAssistantFailed,
  }
}
