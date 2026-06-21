'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { RotateCcw, SendHorizontal, StopCircle, WifiOff } from 'lucide-react'
import type {
  AssistantMessage as SdkAssistantMessage,
  AssistantRoutePolicy,
  AssistantStreamUpdate,
  AuroraClient,
  AuroraError,
  AuroraResponse
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { RouteSheet } from './route-sheet'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface AssistantViewProps {
  client: AuroraClient
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
  storageKey?: string
}

export type AssistantUiMessageStatus = 'sent' | 'sending' | 'streaming' | 'failed' | 'cancelled'

export interface AssistantUiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  status: AssistantUiMessageStatus
  error?: string | undefined
}

export interface AssistantSessionSnapshot {
  sessionId: string | null
  messages: AssistantUiMessage[]
}

export type AssistantStreamStatus = 'idle' | 'streaming' | 'fallback' | 'lost' | 'cancelled'

export interface AssistantStreamState {
  status: AssistantStreamStatus
  lastEventId: string | null
  message: string | null
}

export interface AssistantControlState {
  canSend: boolean
  canCancel: boolean
  cancelReason: string
}

const defaultStorageKey = 'aurora.assistant.session.v1'

export function AssistantView({ client, route, cancellationRoute, storageKey = defaultStorageKey }: AssistantViewProps) {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => emptyAssistantSession())
  const [text, setText] = useState('')
  const [lastResult, setLastResult] = useState<SdkAssistantMessage | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [lastPrompt, setLastPrompt] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<AssistantStreamState>(() => idleAssistantStreamState())
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activePendingIdRef = useRef<string | null>(null)
  const cancelledPendingIdsRef = useRef<Set<string>>(new Set())
  const routePolicy = useMemo(() => routePolicyFromRoute(route), [route])
  const isSending = session.messages.some((message) => message.status === 'sending')
  const isStreaming = session.messages.some((message) => message.status === 'streaming')
  const controls = assistantControlsForRoute(route, cancellationRoute, isSending || isStreaming)
  const canSend = controls.canSend

  useEffect(() => {
    setSession(loadAssistantSession(storageKey))
  }, [storageKey])

  useEffect(() => {
    persistAssistantSession(storageKey, session)
  }, [session, storageKey])

  useEffect(() => () => abortRef.current?.abort(), [])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = text.trim()
    if (!prompt || !canSend) return
    await startAssistantTurn(prompt)
  }

  async function startAssistantTurn(prompt: string, replayFrom: string | null = null) {
    const now = new Date().toISOString()
    const userMessage: AssistantUiMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: prompt,
      createdAt: now,
      status: 'sent'
    }
    const pendingMessage: AssistantUiMessage = {
      id: `assistant-pending-${Date.now()}`,
      role: 'assistant',
      text: replayFrom ? 'Replaying stream from last backend event...' : 'Waiting for Aurora stream...',
      createdAt: now,
      status: 'streaming'
    }

    setText('')
    setLastPrompt(prompt)
    setLastError(null)
    setStreamState({ status: 'streaming', lastEventId: replayFrom, message: replayFrom ? 'Replaying from last known event.' : null })
    setSession((current) => ({
      ...current,
      messages: [...current.messages, userMessage, pendingMessage]
    }))

    const abort = new AbortController()
    abortRef.current = abort
    activePendingIdRef.current = pendingMessage.id
    cancelledPendingIdsRef.current.delete(pendingMessage.id)
    for await (const update of client.assistant.streamMessage({
      text: prompt,
      sessionId: session.sessionId,
      routePolicy,
      signal: abort.signal,
      replayFrom
    })) {
      applyAssistantStreamUpdate(update, pendingMessage.id)
      if (update.kind === 'completed' || update.kind === 'failed' || update.kind === 'fallback' || update.kind === 'transport_lost') {
        break
      }
    }
    if (abortRef.current === abort) abortRef.current = null
    if (activePendingIdRef.current === pendingMessage.id) activePendingIdRef.current = null
  }

  function applyAssistantResult(result: AuroraResponse<import('@aurora/client').AssistantSendMessageResult>, pendingId: string) {
    if (result.ok) {
      setLastResult(result.data.response)
      setModelLabel(result.data.modelLabel)
      setSession((current) => ({
        sessionId: result.data.sessionId,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                id: result.data.response.id,
                role: 'assistant',
                text: result.data.response.text,
                createdAt: result.data.response.createdAt,
                status: 'sent'
              }
            : message
        )
      }))
      return
    }

    const error = assistantErrorMessage(result.error)
    setLastError(error)
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? {
              ...message,
              text: error,
              status: 'failed',
              error
            }
          : message
      )
    }))
  }

  function applyAssistantStreamUpdate(update: AssistantStreamUpdate, pendingId: string) {
    if (cancelledPendingIdsRef.current.has(pendingId)) return
    if (update.eventId) {
      setStreamState((current) => ({ ...current, lastEventId: update.eventId }))
    }
    if (update.modelLabel) setModelLabel(update.modelLabel)
    if (update.kind === 'transport_lost') {
      const error = assistantErrorMessage(update.error ?? new Error('Assistant stream disconnected.'))
      setLastError(error)
      setStreamState((current) => ({
        status: 'lost',
        lastEventId: current.lastEventId,
        message: 'Stream disconnected. Replay will request events after the last backend event when the transport supports it.'
      }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                text: message.text.trim() ? message.text : error,
                status: 'failed',
                error
              }
            : message
        )
      }))
      return
    }
    if (update.kind === 'failed') {
      const error = assistantErrorMessage(update.error ?? new Error(update.text))
      setLastError(error)
      setStreamState((current) => ({ ...current, status: 'lost', message: error }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                text: error,
                status: 'failed',
                error
              }
            : message
        )
      }))
      return
    }
    if (update.kind === 'fallback') {
      setStreamState((current) => ({
        status: 'fallback',
        lastEventId: update.eventId ?? current.lastEventId,
        message: 'Streaming was unavailable; Aurora returned a final non-streaming response.'
      }))
    }
    if (update.kind === 'completed' || update.kind === 'fallback') {
      setLastResult({
        id: update.eventId ?? `assistant-${Date.now()}`,
        role: 'assistant',
        text: update.text,
        createdAt: new Date().toISOString()
      })
      setSession((current) => ({
        sessionId: update.sessionId ?? current.sessionId ?? session.sessionId,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantTerminalUpdate(message, update) : message
        )
      }))
      if (update.kind === 'completed') {
        setStreamState((current) => ({ ...current, status: 'idle', message: 'Final assistant event received.' }))
      }
      return
    }
    if (update.kind === 'delta') {
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantStreamDelta(message, update) : message
        )
      }))
    }
  }

  async function onCancel() {
    if (!controls.canCancel) return
    const pendingId = activePendingIdRef.current
    if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
    abortRef.current?.abort()
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      reason: 'user_interrupt'
    })
    if (result.ok) {
      setStreamState((current) => ({ ...current, status: 'cancelled', message: `Interrupt ${result.data.status}` }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.status === 'streaming' || message.status === 'sending'
            ? { ...message, status: 'cancelled', text: message.text.trim() ? message.text : 'Stopped by user.' }
            : message
        )
      }))
      return
    }
    setLastError(assistantErrorMessage(result.error))
  }

  async function retryLastPrompt(replay = false) {
    if (!lastPrompt || !canSend) return
    await startAssistantTurn(replay ? lastPrompt : lastPrompt, replay ? streamState.lastEventId : null)
  }

  return (
    <section className="aui-assistant" aria-labelledby="assistant-title">
      <header className="aui-assistant-header">
        <div>
          <p className="aui-kicker">Assistant</p>
          <h1 id="assistant-title">Text chat</h1>
        </div>
        <div className="aui-assistant-badges" aria-label="Assistant backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={route.item.privacyClass} />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={modelLabel ? `model ${modelLabel}` : 'model pending'} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={streamState.status === 'idle' ? 'stream ready' : `stream ${streamState.status}`} />
          {session.sessionId ? <EvidenceBadge label={`session ${session.sessionId}`} /> : null}
        </div>
      </header>

      {streamState.status === 'lost' || streamState.status === 'fallback' ? (
        <div className="aui-stream-banner" role="status" aria-live="polite">
          <WifiOff size={17} aria-hidden />
          <span>{streamState.message}</span>
          <button type="button" onClick={() => void retryLastPrompt(true)} disabled={!lastPrompt || !canSend}>
            <RotateCcw size={15} aria-hidden />
            <span>Replay</span>
          </button>
        </div>
      ) : null}

      <div className="aui-assistant-grid">
        <div className="aui-chat-panel" aria-live="polite">
          {session.messages.length === 0 ? (
            <div className="aui-chat-empty">
              <h2>Start with a prompt</h2>
              <p>Responses appear only after the SDK returns final Orchestrator output.</p>
            </div>
          ) : (
            session.messages.map((message) => <ChatBubble key={message.id} message={message} />)
          )}
        </div>

        <aside className="aui-route-panel" aria-label="Assistant route and privacy details">
          <h2>Route</h2>
          <dl>
            <div><dt>Provider</dt><dd>{route.providerLabel}</dd></div>
            <div><dt>Availability</dt><dd>{route.state}</dd></div>
            <div><dt>Privacy</dt><dd>{route.item.privacyClass}</dd></div>
            <div><dt>Selector</dt><dd>{route.selectorRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Approval</dt><dd>{route.approvalRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Cancellation</dt><dd>{controls.canCancel ? 'supported' : controls.cancelReason}</dd></div>
            <div><dt>Last stream event</dt><dd>{streamState.lastEventId ?? 'none'}</dd></div>
            <div><dt>Model</dt><dd>{modelLabel ?? (lastResult ? 'not reported' : 'pending backend response')}</dd></div>
          </dl>
          <p>{route.explanation}</p>
          {route.disabled ? <p role="alert">Assistant send is disabled: {route.blockers.join(', ') || 'capability unavailable'}.</p> : null}
          {lastError ? <p role="alert">{lastError}</p> : null}
          <RouteSheet
            client={client}
            title="Assistant route preview"
            description="The SDK evaluates where this prompt can run before dispatch."
            payload={{
              message: text.trim() || '<pending prompt>',
              session_id: session.sessionId,
              route_surface: route.item.id
            }}
            routeRequest={{
              topic: `${route.item.capabilityModule}.${route.item.capabilityMethod ?? ''}`,
              method: route.item.capabilityMethod ?? null,
              include_candidates: true
            }}
            privacyClass={route.item.privacyClass}
            auditReceiptTarget={route.providerLabel}
            requiresAdminAction={route.requiresAdminAction}
          />
        </aside>
      </div>

      <form className="aui-assistant-form" onSubmit={onSubmit}>
        <label htmlFor="assistant-prompt">Prompt</label>
        <textarea
          id="assistant-prompt"
          ref={textAreaRef}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          disabled={!canSend}
          placeholder={route.disabled ? 'Assistant capability is unavailable' : 'Ask Aurora...'}
          rows={3}
        />
        <button type="button" className="aui-secondary-button" onClick={onCancel} disabled={!controls.canCancel} aria-label="Stop assistant generation">
          <StopCircle size={17} aria-hidden />
          <span>Stop</span>
        </button>
        <button type="button" className="aui-secondary-button" onClick={() => void retryLastPrompt(false)} disabled={!lastPrompt || !canSend} aria-label="Retry last assistant prompt">
          <RotateCcw size={17} aria-hidden />
          <span>Retry</span>
        </button>
        <button type="submit" disabled={!canSend || text.trim().length === 0} aria-label="Send assistant prompt">
          <SendHorizontal size={17} aria-hidden />
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}

export function emptyAssistantSession(): AssistantSessionSnapshot {
  return { sessionId: null, messages: [] }
}

export function idleAssistantStreamState(): AssistantStreamState {
  return { status: 'idle', lastEventId: null, message: null }
}

export function loadAssistantSession(storageKey: string): AssistantSessionSnapshot {
  if (typeof window === 'undefined') return emptyAssistantSession()
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyAssistantSession()
    const parsed = JSON.parse(raw) as Partial<AssistantSessionSnapshot>
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isAssistantUiMessage) : []
    }
  } catch {
    return emptyAssistantSession()
  }
}

export function persistAssistantSession(storageKey: string, session: AssistantSessionSnapshot): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(session))
}

export function routePolicyFromRoute(route: RouteAvailability): AssistantRoutePolicy {
  const provider = route.candidateProviders.find((candidate) => candidate.selectable) ?? route.candidateProviders[0]
  return {
    providerId: provider?.id ?? null,
    peerId: null,
    serviceInstanceId: null,
    routeState: route.state,
    fallbackBehavior: route.state === 'degraded' ? 'backend-reported degraded route' : null,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired
  }
}

export function assistantErrorMessage(error: AuroraError | Error): string {
  if ('code' in error && error.code === 'timeout') return 'Aurora timed out before returning a final assistant response.'
  if ('code' in error && (error.code === 'auth' || error.code === 'permission')) return 'Assistant request denied by authentication or permissions.'
  if ('code' in error && (error.code === 'unavailable_service' || error.code === 'unsupported_feature')) return 'Assistant service is unavailable in this backend or deployment mode.'
  if ('code' in error && error.code === 'privacy_blocked') return 'Assistant route is blocked by privacy policy until required consent or selector evidence exists.'
  if ('code' in error && error.code === 'transport_loss') return 'Assistant stream disconnected before Aurora sent a final event.'
  return error.message || 'Assistant request failed.'
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
      cancelReason: 'unsupported: missing Orchestrator.Interrupt capability evidence'
    }
  }
  if (cancellationRoute.disabled) {
    return {
      canSend,
      canCancel: false,
      cancelReason: cancellationRoute.blockers.join(', ') || 'unsupported by backend capability state'
    }
  }
  return {
    canSend,
    canCancel: true,
    cancelReason: 'supported by Orchestrator.Interrupt'
  }
}

export function applyAssistantStreamDelta(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  const currentText = message.text === 'Waiting for Aurora stream...' || message.text === 'Replaying stream from last backend event...'
    ? ''
    : message.text
  return {
    ...message,
    text: `${currentText}${update.textDelta}`,
    status: 'streaming'
  }
}

export function applyAssistantTerminalUpdate(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  return {
    id: update.eventId ?? message.id,
    role: 'assistant',
    text: update.text,
    createdAt: message.createdAt,
    status: 'sent'
  }
}

function ChatBubble({ message }: { message: AssistantUiMessage }) {
  return (
    <article className={`aui-chat-bubble aui-chat-${message.role} aui-chat-${message.status}`}>
      <header>
        <strong>{message.role === 'user' ? 'You' : 'Aurora'}</strong>
        <span>{message.status}</span>
      </header>
      <p>{message.text}</p>
    </article>
  )
}

function isAssistantUiMessage(value: unknown): value is AssistantUiMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<AssistantUiMessage>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.text === 'string' &&
    typeof message.createdAt === 'string' &&
    (message.status === 'sent' ||
      message.status === 'sending' ||
      message.status === 'streaming' ||
      message.status === 'failed' ||
      message.status === 'cancelled')
  )
}
