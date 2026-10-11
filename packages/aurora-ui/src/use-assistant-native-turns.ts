import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AssistantStreamUpdate, AuroraEvent } from '@aurora/client'
import type { AssistantConversationRow, AssistantModelChoice, AssistantSessionSnapshot, AssistantStreamState, AssistantUiMessage } from './assistant-view'
import type { RouteAvailability } from './shell-data'
import type { LocalAssistantHistoryDependencies } from './use-assistant-history'
import type { NativeMobileVoiceBackgroundResult } from './native-mobile-voice'
import {
  loadLocalAssistantConversationMessagesPage,
  updateLocalConversationRowTitle,
} from './use-assistant-history'
import { useAssistantStreamStore } from './state/assistant-stream-store'
import {
  isNativeAssistantSubjectSnapshot,
  isNativeAssistantTerminalEvent,
  nativeAssistantEventIdentity,
  nativeAssistantEventPersisted,
  nativeAssistantEventPersistenceErrorCode,
  nativeAssistantEventToStreamUpdate,
  nativeAssistantLifecycleMessage,
  nativeAssistantPendingTurnDecision,
  nativeAssistantSnapshotRecoveryDecision,
  nativeAssistantSubjectSnapshotToEvent,
  type NativeAssistantPendingTurnRecord,
} from './native-assistant-events'

export interface AssistantNativeTurnController {
  readonly showNativeMobileBackgroundTurn: (result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
  readonly reconcileNativeAssistantPersistence: (key: string, result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
  readonly handleNativeAssistantSnapshot: (snapshot: { subjects?: unknown[] | undefined }) => Promise<ReturnType<typeof nativeAssistantSnapshotRecoveryDecision>>
  readonly handleNativeAssistantEvent: (event: AuroraEvent<unknown>) => Promise<boolean>
}

export interface CreateAssistantNativeTurnControllerParams {
  readonly route: RouteAvailability
  readonly sessionRef: MutableRefObject<AssistantSessionSnapshot>
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly setLocalConversationRows: Dispatch<SetStateAction<AssistantConversationRow[]>>
  readonly setText: Dispatch<SetStateAction<string>>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly setSessionIndexError: Dispatch<SetStateAction<string | null>>
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly selectedModelChoice: AssistantModelChoice
  readonly runtimeProviderLabel: string | null
  readonly localExecutionMessageLabel: string
  readonly localHistory: LocalAssistantHistoryDependencies | null
  readonly assistantStreamScope: { scopeId: string }
  readonly voiceTranscriptPreviewRef: MutableRefObject<string>
  readonly activePendingIdRef: MutableRefObject<string | null>
  readonly cancelledPendingIdsRef: MutableRefObject<Set<string>>
  readonly nativeBackgroundPendingTurnsRef: MutableRefObject<Map<string, NativeAssistantPendingTurnRecord>>
  readonly nativeBackgroundTerminalKeysRef: MutableRefObject<Set<string>>
  readonly nativeBackgroundReconciledKeysRef: MutableRefObject<Set<string>>
  readonly applyAssistantStreamUpdate: (update: AssistantStreamUpdate, pendingId: string) => void
  readonly setActiveAssistantPendingId: Dispatch<SetStateAction<string | null>>
}

export function createAssistantNativeTurnController(params: CreateAssistantNativeTurnControllerParams): AssistantNativeTurnController {
  const {
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
  } = params

async function showNativeMobileBackgroundTurn(result: NativeMobileVoiceBackgroundResult): Promise<boolean> {
  if (!result.persisted || !result.conversationId || !localHistory) {
    setSessionIndexError('This voice request could not be saved. Try again.')
    return false
  }
  try {
    const messages = (await loadLocalAssistantConversationMessagesPage(localHistory, result.conversationId)).messages
    setLocalConversationRows((rows) => updateLocalConversationRowTitle(rows, result.conversationId!, messages))
    const activeSessionId = sessionRef.current.sessionId
    const canOpenBackgroundConversation = (!activeSessionId || activeSessionId === result.conversationId)
      && !activePendingIdRef.current
    if (canOpenBackgroundConversation) {
      setSession({ sessionId: result.conversationId, messages })
    }
    setSessionIndexError(null)
    return true
  } catch {
    setSessionIndexError('This voice request was saved but could not be opened yet.')
    return true
  }
}

async function reconcileNativeAssistantPersistence(key: string, result: NativeMobileVoiceBackgroundResult): Promise<boolean> {
  if (nativeBackgroundReconciledKeysRef.current.has(key)) return true
  nativeBackgroundReconciledKeysRef.current.add(key)
  const opened = await showNativeMobileBackgroundTurn(result)
  if (!opened) nativeBackgroundReconciledKeysRef.current.delete(key)
  return opened
}

function ensureNativeAssistantPendingTurn(event: AuroraEvent<unknown>): string | null {
  const identity = nativeAssistantEventIdentity(event)
  if (!identity) return null
  const activeSessionId = sessionRef.current.sessionId
  const existing = nativeBackgroundPendingTurnsRef.current.get(identity.key)
  const decision = nativeAssistantPendingTurnDecision({
    activeConversationId: activeSessionId,
    identity,
    existing,
  })
  if (!decision.accepted || !decision.pendingId) return null
  if (existing) {
    if (decision.conversationId && existing.conversationId !== decision.conversationId) {
      nativeBackgroundPendingTurnsRef.current.set(identity.key, {
        ...existing,
        conversationId: decision.conversationId,
        transcript: identity.transcript?.trim() ?? existing.transcript,
      })
      setSession((current) => current.sessionId === existing.pendingId
        ? { ...current, sessionId: decision.conversationId }
        : current)
    }
    return existing.pendingId
  }
  const update = nativeAssistantEventToStreamUpdate(event)
  const isSnapshotEvent = event.id?.startsWith('native:snapshot:') === true
  const initialAssistantText = isSnapshotEvent || update?.kind === 'completed' || update?.kind === 'failed'
    ? update?.text.trim() || 'Aurora is responding.'
    : 'Aurora is responding.'
  const initialStreamingText = isSnapshotEvent && update?.kind === 'delta' ? update.text : ''
  const transcript = identity.transcript?.trim() ?? null
  const now = new Date().toISOString()
  const pendingId = decision.pendingId
  const pendingMessage: AssistantUiMessage = {
    id: pendingId,
    role: 'assistant',
    text: initialAssistantText,
    createdAt: now,
    status: update?.kind === 'completed' ? 'sent' : update?.kind === 'failed' ? 'failed' : 'streaming',
    modelLabel: update?.modelLabel ?? selectedModelChoice.model.name,
    providerLabel: selectedModelChoice.provider ? 'Selected model source' : runtimeProviderLabel ?? route.providerLabel,
    routeLabel: localExecutionMessageLabel,
    executionPeerId: null
  }
  const userMessage: AssistantUiMessage | null = transcript
    ? {
        id: `user-${pendingId}`,
        role: 'user',
        text: transcript,
        createdAt: now,
        status: 'sent'
      }
    : null
  nativeBackgroundPendingTurnsRef.current.set(identity.key, {
    pendingId,
    conversationId: decision.conversationId,
    transcript
  })
  voiceTranscriptPreviewRef.current = ''
  setText('')
  if (pendingMessage.status === 'streaming') {
    useAssistantStreamStore.getState().begin(pendingId, assistantStreamScope)
    if (initialStreamingText) useAssistantStreamStore.getState().setText(initialStreamingText, assistantStreamScope)
    useAssistantStreamStore.getState().markStreaming(assistantStreamScope)
  }
  setSession((current) => {
    const hasUser = userMessage ? current.messages.some((message) => message.id === userMessage.id) : true
    const hasPending = current.messages.some((message) => message.id === pendingMessage.id)
    const messages = [
      ...current.messages,
      ...(userMessage && !hasUser ? [userMessage] : []),
      ...(hasPending ? [] : [pendingMessage])
    ]
    return {
      sessionId: current.sessionId ?? decision.conversationId ?? pendingId,
      messages
    }
  })
  return pendingId
}

async function handleNativeAssistantSnapshot(snapshot: { subjects?: unknown[] | undefined }) {
  let applied = false
  for (const subject of snapshot.subjects ?? []) {
    if (!isNativeAssistantSubjectSnapshot(subject)) continue
    applied = await handleNativeAssistantEvent(nativeAssistantSubjectSnapshotToEvent(subject)) || applied
  }
  return nativeAssistantSnapshotRecoveryDecision(applied)
}

async function handleNativeAssistantEvent(event: AuroraEvent<unknown>): Promise<boolean> {
  const identity = nativeAssistantEventIdentity(event)
  if (!identity) return false
  const existing = nativeBackgroundPendingTurnsRef.current.get(identity.key)
  const decision = nativeAssistantPendingTurnDecision({
    activeConversationId: sessionRef.current.sessionId,
    identity,
    existing,
  })
  if (!decision.accepted || !decision.pendingId) return false
  if (cancelledPendingIdsRef.current.has(decision.pendingId)) {
    if (isNativeAssistantTerminalEvent(event)) nativeBackgroundTerminalKeysRef.current.add(identity.key)
    return true
  }
  const pendingId = ensureNativeAssistantPendingTurn(event)
  if (!pendingId) return false
  const lifecycleMessage = nativeAssistantLifecycleMessage(event)
  if (lifecycleMessage) {
    setStreamState((current) => ({ ...current, status: event.kind.endsWith('.failed') ? 'lost' : 'streaming', message: lifecycleMessage }))
  }
  const update = nativeAssistantEventToStreamUpdate(event)
  if (update) {
    if (event.id?.startsWith('native:snapshot:') && update.kind === 'delta') {
      useAssistantStreamStore.getState().begin(pendingId, assistantStreamScope)
      useAssistantStreamStore.getState().setText(update.text, assistantStreamScope)
      useAssistantStreamStore.getState().markStreaming(assistantStreamScope)
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) => message.id === pendingId ? { ...message, text: update.text, status: 'streaming' } : message)
      }))
    } else {
      applyAssistantStreamUpdate(update, pendingId)
    }
    if (update.kind === 'completed' || update.kind === 'failed') {
      useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
    }
  }
  if (!isNativeAssistantTerminalEvent(event)) return true
  nativeBackgroundTerminalKeysRef.current.add(identity.key)
  if (activePendingIdRef.current === pendingId) {
    activePendingIdRef.current = null
    setActiveAssistantPendingId(null)
  }
  const persisted = nativeAssistantEventPersisted(event)
  const persistenceErrorCode = nativeAssistantEventPersistenceErrorCode(event)
  if (persisted && identity.conversationId) {
    await reconcileNativeAssistantPersistence(identity.key, {
      generation: identity.generation ?? -1,
      transcript: identity.transcript ?? nativeBackgroundPendingTurnsRef.current.get(identity.key)?.transcript ?? '',
      assistantText: update?.kind === 'completed' ? update.text : null,
      errorCode: event.kind.endsWith('.failed') ? event.kind : null,
      persisted,
      conversationId: identity.conversationId,
      persistenceErrorCode
    })
  } else if (event.kind.endsWith('.failed')) {
    setLastError('Aurora could not complete the voice request.')
  }
  return true
}


  return {
    showNativeMobileBackgroundTurn,
    reconcileNativeAssistantPersistence,
    handleNativeAssistantSnapshot,
    handleNativeAssistantEvent,
  }
}
