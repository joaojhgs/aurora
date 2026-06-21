'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { SendHorizontal } from 'lucide-react'
import type {
  AssistantMessage as SdkAssistantMessage,
  AssistantRoutePolicy,
  AuroraClient,
  AuroraError,
  AuroraResponse
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface AssistantViewProps {
  client: AuroraClient
  route: RouteAvailability
  storageKey?: string
}

export type AssistantUiMessageStatus = 'sent' | 'sending' | 'failed'

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

const defaultStorageKey = 'aurora.assistant.session.v1'

export function AssistantView({ client, route, storageKey = defaultStorageKey }: AssistantViewProps) {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => emptyAssistantSession())
  const [text, setText] = useState('')
  const [lastResult, setLastResult] = useState<SdkAssistantMessage | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const routePolicy = useMemo(() => routePolicyFromRoute(route), [route])
  const isSending = session.messages.some((message) => message.status === 'sending')
  const canSend = !route.disabled && !isSending

  useEffect(() => {
    setSession(loadAssistantSession(storageKey))
  }, [storageKey])

  useEffect(() => {
    persistAssistantSession(storageKey, session)
  }, [session, storageKey])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = text.trim()
    if (!prompt || !canSend) return

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
      text: 'Waiting for Aurora response...',
      createdAt: now,
      status: 'sending'
    }

    setText('')
    setLastError(null)
    setSession((current) => ({
      ...current,
      messages: [...current.messages, userMessage, pendingMessage]
    }))

    const result = await client.assistant.sendMessage({
      text: prompt,
      sessionId: session.sessionId,
      routePolicy
    })
    applyAssistantResult(result, pendingMessage.id)
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
          {session.sessionId ? <EvidenceBadge label={`session ${session.sessionId}`} /> : null}
        </div>
      </header>

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
            <div><dt>Model</dt><dd>{modelLabel ?? (lastResult ? 'not reported' : 'pending backend response')}</dd></div>
          </dl>
          <p>{route.explanation}</p>
          {route.disabled ? <p role="alert">Assistant send is disabled: {route.blockers.join(', ') || 'capability unavailable'}.</p> : null}
          {lastError ? <p role="alert">{lastError}</p> : null}
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

export function assistantErrorMessage(error: AuroraError): string {
  if (error.code === 'timeout') return 'Aurora timed out before returning a final assistant response.'
  if (error.code === 'auth' || error.code === 'permission') return 'Assistant request denied by authentication or permissions.'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'Assistant service is unavailable in this backend or deployment mode.'
  if (error.code === 'privacy_blocked') return 'Assistant route is blocked by privacy policy until required consent or selector evidence exists.'
  return error.message || 'Assistant request failed.'
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
    (message.status === 'sent' || message.status === 'sending' || message.status === 'failed')
  )
}
