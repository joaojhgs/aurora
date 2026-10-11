'use client'

import type { FormEvent, KeyboardEvent, MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { AuroraClient, AuroraError } from '@aurora/client'
import { resolveAssistantToolApprovalAction } from './assistant-tool-approval-actions'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type { NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { RouteAvailability } from './shell-data'
import { useAssistantStreamStore } from './state/assistant-stream-store'
import {
  assistantMessageWithStreamingText,
  emptyAssistantSession,
  isAssistantPendingWork,
  type AssistantApprovalGrantScope,
  type AssistantSessionSnapshot,
  type AssistantToolCallCard,
} from './assistant-session-persistence'
import type {
  AssistantControlState,
  AssistantExecutionOption,
  AssistantStreamState,
  VoiceCaptureStatus,
} from './assistant-view'

interface AssistantSessionActionsOptions {
  readonly client: AuroraClient
  readonly route: RouteAvailability
  readonly cancellationRoute: RouteAvailability | undefined
  readonly selectedExecution: AssistantExecutionOption
  readonly localOrchestrator: LightweightOrchestrator | null
  readonly session: AssistantSessionSnapshot
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly supportsPersistedSessions: boolean
  readonly usesLocalConversationHistory: boolean
  readonly sessionIndexLoading: boolean
  readonly setSessionIndexLoading: (loading: boolean) => void
  readonly hasContextUpload: boolean
  readonly attachmentsLength: number
  readonly ingestPendingAttachments: (sessionId: string | null) => Promise<'ready' | 'blocked'>
  readonly activeAssistantPendingId: string | null
  readonly voiceCaptureStatus: VoiceCaptureStatus
  readonly voiceResponsePendingId: string | null
  readonly lastPrompt: string | null
  readonly streamState: AssistantStreamState
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setLastError: (message: string | null) => void
  readonly startAssistantTurn: (prompt: string, replayFromEventId?: string | null) => Promise<boolean>
  readonly activePendingIdRef: MutableRefObject<string | null>
  readonly cancelledPendingIdsRef: MutableRefObject<Set<string>>
  readonly abortRef: MutableRefObject<AbortController | null>
  readonly assistantStreamScopeId: string
  readonly assistantStreamScope: { scopeId: string }
  readonly setActiveAssistantPendingId: (pendingId: string | null) => void
  readonly usesNativeDesktopVoice: boolean
  readonly usesFocusedBrowserVoiceRuntime: boolean
  readonly browserVoiceOperationTokenRef: MutableRefObject<number>
  readonly activeVoiceSessionRef: MutableRefObject<string | null>
  readonly ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  readonly setVoiceCaptureStatus: (status: VoiceCaptureStatus) => void
  readonly toggleLocalCapture: () => Promise<void>
  readonly cancelNativeDesktopVoice: (reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  readonly settleBrowserVoiceTurn: (token: number, outcome: 'complete' | 'abandon' | 'cancel', reason?: string) => Promise<{ claimed: boolean; succeeded: boolean; current: boolean }>
  readonly createPersistedChatSession: () => Promise<{ id: string } | null>
  readonly resetConversationUi: (nextSession: AssistantSessionSnapshot) => void
  readonly setMobileHistoryOpen: (open: boolean) => void
  readonly textAreaRef: MutableRefObject<HTMLTextAreaElement | null>
  readonly text: string
  readonly setText: Dispatch<SetStateAction<string>>
  readonly localConfirmationOrchestratorsRef: MutableRefObject<Map<string, LightweightOrchestrator>>
  readonly productAssistantErrorCopy: (error: AuroraError | Error) => string
}

export interface AssistantSessionActions {
  readonly controls: AssistantControlState
  readonly canSend: boolean
  readonly canAttach: boolean
  readonly assistantBusy: boolean
  readonly voiceBusy: boolean
  readonly primaryComposerAction: 'send' | 'stop' | 'retry'
  readonly primaryComposerDisabled: boolean
  readonly primaryComposerLabel: string
  readonly primaryComposerAriaLabel: string
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  readonly retryLastPrompt: (replay?: boolean) => Promise<void>
  readonly onPrimaryComposerAction: () => Promise<void>
  readonly startNewConversation: () => Promise<void>
  readonly resolveAssistantToolApproval: (tool: AssistantToolCallCard, approve: boolean, grantScope: AssistantApprovalGrantScope) => Promise<void>
}

export function useAssistantSessionActions({
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
  attachmentsLength,
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
  browserVoiceOperationTokenRef,
  activeVoiceSessionRef,
  ownedVoiceSessionIdsRef,
  setVoiceCaptureStatus,
  toggleLocalCapture,
  cancelNativeDesktopVoice,
  settleBrowserVoiceTurn,
  createPersistedChatSession,
  resetConversationUi,
  setMobileHistoryOpen,
  textAreaRef,
  text,
  setText,
  localConfirmationOrchestratorsRef,
  productAssistantErrorCopy,
}: AssistantSessionActionsOptions): AssistantSessionActions {
  const sessionMessages = session.messages
  const latestAssistantMessage = [...sessionMessages].reverse().find((message) => message.role === 'assistant')
  const isSending = sessionMessages.some((message) => message.status === 'sending')
  const isStreaming = sessionMessages.some((message) => message.status === 'streaming')
  const controls = selectedExecution.runner === 'lightweight-local'
    ? {
        canSend: localOrchestrator !== null && !isSending && !isStreaming && !hasContextUpload,
        canCancel: isSending || isStreaming,
        cancelReason: isSending || isStreaming ? 'Stop is available for this response.' : 'no active response'
      }
    : assistantControlsForRoute(route, cancellationRoute, isSending || isStreaming || hasContextUpload)
  const canSend = controls.canSend && (!supportsPersistedSessions || Boolean(session.sessionId)) && !sessionIndexLoading
  const canAttach = controls.canSend && !isSending && !isStreaming && !hasContextUpload
  const assistantBusy = Boolean(activeAssistantPendingId) || isSending || sessionMessages.some(isAssistantPendingWork)
  const voiceBusy = voiceCaptureStatus === 'processing' || Boolean(voiceResponsePendingId)
  const retryableFailure = Boolean(lastPrompt) && (
    streamState.status === 'lost' ||
    streamState.status === 'cancelled' ||
    voiceCaptureStatus === 'error' ||
    latestAssistantMessage?.status === 'failed'
  )
  const hasFreshPrompt = text.trim().length > 0
  const primaryComposerAction: 'send' | 'stop' | 'retry' = retryableFailure && !hasFreshPrompt
    ? 'retry'
    : assistantBusy || voiceBusy
      ? 'stop'
      : 'send'
  const primaryComposerDisabled = primaryComposerAction === 'send'
    ? !canSend || hasContextUpload || text.trim().length === 0
    : primaryComposerAction === 'retry'
      ? !lastPrompt || !canSend
      : false
  const primaryComposerLabel = primaryComposerAction === 'retry' ? 'Retry' : primaryComposerAction === 'stop' ? 'Stop' : 'Send'
  const primaryComposerAriaLabel = primaryComposerAction === 'retry'
    ? 'Retry last assistant prompt'
    : primaryComposerAction === 'stop'
      ? 'Stop assistant generation'
      : 'Send assistant prompt'

  async function submitCurrentPrompt() {
    const prompt = text.trim()
    if (!prompt || !canSend || hasContextUpload) return
    if (attachmentsLength > 0 && await ingestPendingAttachments(session.sessionId) === 'blocked') return
    await startAssistantTurn(prompt)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await submitCurrentPrompt()
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault()
      insertComposerNewline()
      return
    }
    event.preventDefault()
    if (primaryComposerAction === 'send' && !primaryComposerDisabled) {
      void submitCurrentPrompt()
    }
  }

  function insertComposerNewline() {
    const element = textAreaRef.current
    if (!element) {
      setText((current) => `${current}\n`)
      return
    }
    const start = element.selectionStart
    const end = element.selectionEnd
    const next = `${text.slice(0, start)}\n${text.slice(end)}`
    setText(next)
    window.setTimeout(() => {
      element.selectionStart = start + 1
      element.selectionEnd = start + 1
    }, 0)
  }

  async function resolveAssistantToolApproval(
    tool: AssistantToolCallCard,
    approve: boolean,
    grantScope: AssistantApprovalGrantScope
  ) {
    await resolveAssistantToolApprovalAction({
      client,
      session,
      setSession,
      setStreamState,
      setLastError,
      localConfirmationOrchestratorsRef,
      formatError: productAssistantErrorCopy,
      tool,
      approve,
      grantScope,
    })
  }


  async function onCancel() {
    if (!controls.canCancel) return
    const pendingId = activePendingIdRef.current
    if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
    abortRef.current?.abort()
    if (selectedExecution.runner === 'lightweight-local') {
      localOrchestrator?.cancel()
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped responding.' }))
      cancelStreamingMessages()
      if (pendingId) {
        useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
      }
      return
    }
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      reason: 'user_interrupt'
    })
    if (result.ok) {
      setStreamState((current) => ({ ...current, status: 'cancelled', message: `Interrupt ${result.data.status}` }))
      cancelStreamingMessages()
      if (pendingId) {
        useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
      }
      return
    }
    setLastError(productAssistantErrorCopy(result.error))
  }

  function cancelStreamingMessages() {
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.status === 'streaming' || message.status === 'sending'
          ? (() => {
              const effectiveMessage = assistantMessageWithStreamingText(message, message.id, assistantStreamScopeId)
              return { ...effectiveMessage, status: 'cancelled' as const, text: effectiveMessage.text.trim() ? effectiveMessage.text : 'Stopped by user.' }
            })()
          : message
      )
    }))
  }

  async function retryLastPrompt(replay = false) {
    if (!lastPrompt || !canSend) return
    await startAssistantTurn(lastPrompt, replay ? streamState.lastEventId : null)
  }

  async function onPrimaryComposerAction() {
    if (primaryComposerAction === 'retry') {
      await retryLastPrompt(false)
      return
    }
    if (primaryComposerAction !== 'stop') return
    if (voiceCaptureStatus === 'listening') {
      await toggleLocalCapture()
      return
    }
    if (usesNativeDesktopVoice && (voiceCaptureStatus === 'processing' || voiceCaptureStatus === 'speaking')) {
      await cancelNativeDesktopVoice('user_request')
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped listening.' }))
      return
    }
    if (usesFocusedBrowserVoiceRuntime && voiceCaptureStatus === 'processing') {
      const token = browserVoiceOperationTokenRef.current
      browserVoiceOperationTokenRef.current = token + 1
      const pendingId = activePendingIdRef.current
      if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
      abortRef.current?.abort()
      if (selectedExecution.runner === 'lightweight-local') {
        localOrchestrator?.cancel()
      } else if (pendingId) {
        void client.assistant.cancel({
          sessionId: session.sessionId,
          reason: 'user_interrupt'
        }).catch(() => undefined)
      }
      await settleBrowserVoiceTurn(token, 'abandon', 'user_interrupt')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      activePendingIdRef.current = null
      setActiveAssistantPendingId(null)
      cancelStreamingMessages()
      if (pendingId) {
        useAssistantStreamStore.getState().clear(pendingId, assistantStreamScope)
      }
      setVoiceCaptureStatus('idle')
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped listening.' }))
      return
    }
    await onCancel()
  }

  async function startNewConversation() {
    if (usesLocalConversationHistory) {
      resetConversationUi(emptyAssistantSession())
    } else if (supportsPersistedSessions) {
      setSessionIndexLoading(true)
      const created = await createPersistedChatSession()
      setSessionIndexLoading(false)
      if (!created) return
      resetConversationUi({ sessionId: created.id, messages: [] })
    } else {
      resetConversationUi(emptyAssistantSession())
    }
    setMobileHistoryOpen(false)
    textAreaRef.current?.focus()
  }

  return {
    controls,
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
  }
}

export function assistantControlsForRoute(
  route: RouteAvailability,
  cancellationRoute: RouteAvailability | undefined,
  busy: boolean
): AssistantControlState {
  const canSend = !route.disabled && !busy
  if (!busy) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'no active response'
    }
  }
  if (!cancellationRoute) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'Stop is unavailable for this response.'
    }
  }
  if (cancellationRoute.disabled) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'Stop is unavailable for this response.'
    }
  }
  return {
    canSend,
    canCancel: true,
    cancelReason: 'Stop is available for this response.'
  }
}
