import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AssistantInferencePolicy, AssistantMessage as SdkAssistantMessage, AssistantRoutePolicy, AssistantStreamMessageRequest, AssistantStreamUpdate, AuroraClient, AuroraError } from '@aurora/client'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type { RouteAvailability } from './shell-data'
import type { AssistantModelChoice, AssistantSessionSnapshot, AssistantStreamState, AssistantUiMessage } from './assistant-view'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { LocalAssistantHistoryDependencies } from './use-assistant-history'
import {
  enrichLatestLocalAssistantMessage,
  loadLocalAssistantConversationMessagesPage,
  persistConnectedAssistantTurnToLocalHistory,
  persistLatestLocalAssistantRuntime,
  preserveActiveAssistantTurnIds,
} from './use-assistant-history'
import {
  ASSISTANT_RECONNECTING_TEXT,
  ASSISTANT_RESPONDING_TEXT,
  assistantToolCallFromUpdate,
  isAssistantStreamHardTerminal,
  lightweightConfirmationToolCard,
  metadataStringValue,
} from './assistant-session-persistence'
import { useAssistantStreamStore } from './state/assistant-stream-store'
import type { AssistantTurnExecutionSelection } from './use-assistant-turns'
import { peerIdFromProviderIdentity } from './assistant-execution-routing'

export interface AssistantForegroundTurnController {
  readonly startAssistantTurn: (prompt: string, replayFrom?: string | null) => Promise<boolean>
}

export interface CreateAssistantForegroundTurnControllerParams {
  readonly client: AuroraClient
  readonly route: RouteAvailability
  readonly surfaceProfile: AuroraSurfaceProfile
  readonly session: AssistantSessionSnapshot
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly abortRef: MutableRefObject<AbortController | null>
  readonly setText: Dispatch<SetStateAction<string>>
  readonly setLastPrompt: Dispatch<SetStateAction<string | null>>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly setLastResult: Dispatch<SetStateAction<SdkAssistantMessage | null>>
  readonly setModelLabel: Dispatch<SetStateAction<string | null>>
  readonly runtimeProviderLabel: string | null
  readonly setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  readonly setSessionIndexError: Dispatch<SetStateAction<string | null>>
  readonly selectedExecution: AssistantTurnExecutionSelection
  readonly selectedModelChoice: AssistantModelChoice
  readonly routePolicy: AssistantRoutePolicy | null
  readonly ttsStreamRoute?: RouteAvailability | undefined
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
  readonly productAssistantErrorCopy: (error: Error | AuroraError) => string
  readonly assistantStreamScope: { scopeId: string }
  readonly activePendingIdRef: MutableRefObject<string | null>
  readonly lastStreamEventIdRef: MutableRefObject<string | null>
  readonly cancelledPendingIdsRef: MutableRefObject<Set<string>>
  readonly setActiveAssistantPendingId: Dispatch<SetStateAction<string | null>>
  readonly applyAssistantStreamUpdate: (update: AssistantStreamUpdate, pendingId: string) => void
  readonly markAssistantTurnFailed: (pendingId: string, failureCopy: string) => void
}

export function createAssistantForegroundTurnController(params: CreateAssistantForegroundTurnControllerParams): AssistantForegroundTurnController {
  const {
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
    ttsStreamRoute,
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
  } = params

async function startAssistantTurn(prompt: string, replayFrom: string | null = null): Promise<boolean> {
  const now = new Date().toISOString()
  const requestId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  let turnSessionId = usesLocalConversationHistory || supportsPersistedSessions
    ? session.sessionId
    : null
  if (!turnSessionId && supportsPersistedSessions) {
    const created = await createPersistedChatSession()
    if (!created) return false
    turnSessionId = created.id
  }
  turnSessionId ??= requestId
  const userMessage: AssistantUiMessage = {
    id: `user-${requestId}`,
    role: 'user',
    text: prompt,
    createdAt: now,
    status: 'sent'
  }
  const pendingMessage: AssistantUiMessage = {
    id: requestId,
    role: 'assistant',
    text: replayFrom ? ASSISTANT_RECONNECTING_TEXT : ASSISTANT_RESPONDING_TEXT,
    createdAt: now,
    status: 'streaming',
    modelLabel: selectedModelChoice.model.name,
    providerLabel: selectedModelChoice.provider ? 'Selected model source' : runtimeProviderLabel ?? route.providerLabel,
    routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
    executionPeerId: selectedExecution.executionPeerId
  }

  setText('')
  setLastPrompt(prompt)
  setLastError(null)
  lastStreamEventIdRef.current = replayFrom
  setStreamState({ status: 'streaming', lastEventId: replayFrom, message: replayFrom ? 'Replaying from last known event.' : null })
  useAssistantStreamStore.getState().begin(pendingMessage.id, assistantStreamScope)
  useAssistantStreamStore.getState().markStreaming(assistantStreamScope)
  setSession((current) => ({
    ...current,
    sessionId: current.sessionId ?? turnSessionId,
    messages: [...current.messages, userMessage, pendingMessage]
  }))

  const abort = new AbortController()
  abortRef.current = abort
  activePendingIdRef.current = pendingMessage.id
  setActiveAssistantPendingId(pendingMessage.id)
  cancelledPendingIdsRef.current.delete(pendingMessage.id)
  let terminalSeen = false
  let turnSucceeded = false
  let completedRemoteUpdate: AssistantStreamUpdate | null = null
  let remoteToolEventSequence = 0
  try {
    if (selectedExecution.runner === 'lightweight-local') {
      if (!localOrchestrator) throw new Error('On-device assistant is unavailable.')
      const result = await localOrchestrator.runTurn({
        text: prompt,
        conversationId: turnSessionId,
        providerId: inferencePolicy?.runtimeProviderId ?? inferencePolicy?.providerId ?? null,
        modelId: inferencePolicy?.modelId ?? null,
        signal: abort.signal
      })
      terminalSeen = true
      turnSucceeded = result.status !== 'cancelled'
      await applyLightweightAssistantResult(result, pendingMessage.id, localOrchestrator)
    } else {
      const ttsPlaybackHint = clientTtsPlaybackHint({
        surfaceProfile,
        selectedExecution,
        routePolicy,
        ttsStreamRoute,
      })
      const streamRequest: AssistantStreamMessageRequest = {
        text: prompt,
        sessionId: turnSessionId,
        requestId,
        routePolicy,
        signal: abort.signal,
        replayFrom,
        ...(ttsPlaybackHint === undefined ? {} : { clientTtsPlayback: ttsPlaybackHint }),
        ...(inferencePolicy === undefined ? {} : { inferencePolicy })
      }
      for await (const update of client.assistant.streamMessage(streamRequest)) {
        applyAssistantStreamUpdate(update, pendingMessage.id)
        if (update.kind === 'tool' && localHistory) {
          const toolRecordId = `${requestId}-connected-tool-${remoteToolEventSequence}`
          remoteToolEventSequence += 1
          try {
            await persistConnectedAssistantTurnToLocalHistory(localHistory, {
              conversationId: turnSessionId,
              requestId,
              prompt,
              response: null,
              runtime: null,
              toolEvents: [{
                recordId: toolRecordId,
                card: assistantToolCallFromUpdate(update),
                createdAtMs: Date.now(),
              }],
              createdAtMs: Date.parse(now),
            })
          } catch {
            setSessionIndexError('This activity could not be saved on this device.')
          }
        }
        if (update.kind === 'completed' || update.kind === 'fallback') {
          completedRemoteUpdate = update
          turnSucceeded = true
        }
        if (update.kind === 'completed') {
          terminalSeen = true
          continue
        }
        if (isAssistantStreamHardTerminal(update)) {
          terminalSeen = true
          break
        }
      }
      if (completedRemoteUpdate && localHistory) {
        try {
          await persistConnectedAssistantTurnToLocalHistory(localHistory, {
            conversationId: turnSessionId,
            requestId,
            prompt,
            response: completedRemoteUpdate.text,
            runtime: {
              routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
              executionPeerId: selectedExecution.executionPeerId,
              modelLabel: completedRemoteUpdate.modelLabel ?? selectedModelChoice.model.name,
              providerLabel: metadataStringValue(completedRemoteUpdate.metadata, 'provider_label')
                ?? metadataStringValue(completedRemoteUpdate.metadata, 'provider')
                ?? selectedModelChoice.provider?.display_name
                ?? runtimeProviderLabel
                ?? null,
            },
            toolEvents: [],
            createdAtMs: Date.parse(now),
          })
        } catch {
          setSessionIndexError('This reply could not be saved on this device.')
        }
      }
    }
    if (!terminalSeen && !abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)) {
      markAssistantTurnFailed(pendingMessage.id, 'Assistant stream ended before Aurora returned a final response. Retry will resend the last prompt.')
    }
  } catch (error) {
    if (!abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)) {
      markAssistantTurnFailed(pendingMessage.id, productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
    }
  } finally {
    useAssistantStreamStore.getState().clear(pendingMessage.id, assistantStreamScope)
    if (abortRef.current === abort) abortRef.current = null
    if (activePendingIdRef.current === pendingMessage.id) activePendingIdRef.current = null
    setActiveAssistantPendingId((current) => current === pendingMessage.id ? null : current)
    if (usesLocalConversationHistory) {
      void refreshLocalSessionIndex(turnSessionId)
    } else {
      void refreshPersistedSessionIndex()
    }
  }
  return turnSucceeded && !abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)
}

function clientTtsPlaybackHint(params: {
  surfaceProfile: AuroraSurfaceProfile
  selectedExecution: AssistantTurnExecutionSelection
  routePolicy: AssistantRoutePolicy | null
  ttsStreamRoute: RouteAvailability | undefined
}): boolean | undefined {
  if (params.surfaceProfile.usesLocalSidecar) return false
  return hasUsableSelectedPeerTtsStream(params) ? true : undefined
}

function hasUsableSelectedPeerTtsStream(params: {
  selectedExecution: AssistantTurnExecutionSelection
  routePolicy: AssistantRoutePolicy | null
  ttsStreamRoute: RouteAvailability | undefined
}): boolean {
  const { selectedExecution, routePolicy, ttsStreamRoute } = params
  if (!ttsStreamRoute || !ttsStreamRoute.routeable || ttsStreamRoute.disabled) return false
  if (
    ttsStreamRoute.item.capabilityModule !== 'TTS'
    || ttsStreamRoute.item.capabilityMethod !== 'StreamStart'
  ) return false

  const executionPeerId = nonEmptyPeerId(selectedExecution.executionPeerId)
  const policyPeerId = routePolicyPeerIdentity(routePolicy)
  if (executionPeerId && policyPeerId && executionPeerId !== policyPeerId) return false

  const candidates = ttsStreamRoute.candidateProviders.filter((candidate) =>
    candidate.selectable
    && (candidate.state === 'available-local' || candidate.state === 'available-remote')
  )
  if (selectedExecution.transportHost) {
    if (executionPeerId || policyPeerId) return false
    return candidates.some((candidate) => candidate.providerKind === 'local' && candidate.peerId == null)
  }

  const selectedPeerId = executionPeerId ?? policyPeerId
  if (selectedPeerId) {
    return candidates.some((candidate) => candidate.peerId === selectedPeerId)
  }

  if (selectedExecution.mode !== 'local' || routePolicy?.peerId) return false
  return candidates.some((candidate) => candidate.providerKind === 'local' && candidate.peerId == null)
}

function nonEmptyPeerId(peerId: string | null): string | null {
  return typeof peerId === 'string' && peerId.trim() ? peerId : null
}

function routePolicyPeerIdentity(routePolicy: AssistantRoutePolicy | null): string | null {
  const explicitPeerId = nonEmptyPeerId(routePolicy?.peerId ?? null)
  if (explicitPeerId) return explicitPeerId
  const providerId = routePolicy?.providerId
  return providerId ? peerIdFromProviderIdentity(providerId) : null
}

async function applyLightweightAssistantResult(
  result: Awaited<ReturnType<LightweightOrchestrator['runTurn']>>,
  pendingId: string,
  orchestrator: LightweightOrchestrator
): Promise<void> {
  if (result.status === 'awaiting_confirmation' && result.confirmation) {
    const confirmation = result.confirmation
    localConfirmationOrchestratorsRef.current.set(confirmation.token, orchestrator)
    setSession((current) => ({
      sessionId: result.conversationId,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? {
              ...message,
              text: result.assistantText.trim() || 'Aurora needs your approval before continuing.',
              status: 'sent',
              toolCalls: [lightweightConfirmationToolCard(confirmation)],
              routeLabel: localExecutionMessageLabel,
              executionPeerId: null
            }
          : message
      )
    }))
    setStreamState({ status: 'idle', lastEventId: null, message: 'Aurora needs your approval before continuing.' })
    return
  }
  if (result.status === 'cancelled') {
    setSession((current) => ({
      sessionId: result.conversationId,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? { ...message, text: 'Stopped by user.', status: 'cancelled' }
          : message
      )
    }))
    setStreamState({ status: 'cancelled', lastEventId: null, message: 'Aurora stopped responding.' })
    return
  }
  const completedText = result.assistantText.trim()
  const createdAt = new Date().toISOString()
  let persistedMessages: AssistantUiMessage[] | null = null
  if (localHistory) {
    try {
      await persistLatestLocalAssistantRuntime(localHistory, {
        conversationId: result.conversationId,
        ...(result.assistantMessageId === undefined ? {} : { assistantMessageId: result.assistantMessageId }),
        runtime: {
          routeLabel: localExecutionMessageLabel,
          executionPeerId: null,
          modelLabel: selectedModelChoice.model.name,
          providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
        },
      })
      persistedMessages = (await loadLocalAssistantConversationMessagesPage(localHistory, result.conversationId)).messages
    } catch {
      persistedMessages = null
    }
  }
  setLastResult({ id: pendingId, role: 'assistant', text: completedText, createdAt })
  setModelLabel(selectedModelChoice.model.name)
  setSession((current) => {
    const enrichedPersistedMessages = persistedMessages
      ? enrichLatestLocalAssistantMessage(persistedMessages, {
          text: completedText,
          modelLabel: selectedModelChoice.model.name,
          providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
          routeLabel: localExecutionMessageLabel,
        })
      : null
    return {
      sessionId: result.conversationId,
      messages: enrichedPersistedMessages
        ? preserveActiveAssistantTurnIds(enrichedPersistedMessages, current.messages, pendingId)
        : current.messages.map((message) =>
            message.id === pendingId
              ? {
                  ...message,
                  text: completedText,
                  createdAt,
                  status: 'sent',
                  modelLabel: selectedModelChoice.model.name,
                  providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
                  routeLabel: localExecutionMessageLabel,
                  executionPeerId: null
                }
              : message
          )
    }
  })
  setStreamState({ status: 'idle', lastEventId: null, message: 'Aurora finished responding.' })
}

  return { startAssistantTurn }
}
