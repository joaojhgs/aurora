'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, Paperclip, RotateCcw, SendHorizontal, Share2, StopCircle, Trash2, WifiOff } from 'lucide-react'
import type {
  AttachmentContextIngestResponse,
  AttachmentContextItem,
  AttachmentContextItemResult,
  AttachmentContextPrivacyClass,
  AttachmentContextSourceChannel,
  AttachmentContextStatus,
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

export type AttachmentTrayStatus =
  | 'staged'
  | 'uploading'
  | 'accepted'
  | 'redacted'
  | 'stored'
  | 'unsupported'
  | 'rejected'
  | 'error'

export interface AssistantAttachmentDraft {
  id: string
  kind: 'text' | 'url' | 'file' | 'image'
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  sourceChannel: AttachmentContextSourceChannel
  sourceDisplayName: string
  privacyClass: AttachmentContextPrivacyClass
  status: AttachmentTrayStatus
  progress: number
  message: string
  reasonCode?: string | null
  redacted: boolean
}

const defaultStorageKey = 'aurora.assistant.session.v1'
const defaultContextLimits = {
  max_items: 8,
  max_item_bytes: 262_144,
  max_total_bytes: 1_048_576,
  max_text_chars: 120_000
}

export function AssistantView({ client, route, cancellationRoute, storageKey = defaultStorageKey }: AssistantViewProps) {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => emptyAssistantSession())
  const [text, setText] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [sharedTextDraft, setSharedTextDraft] = useState('')
  const [privacyClass, setPrivacyClass] = useState<AttachmentContextPrivacyClass>('personal')
  const [sourceChannel, setSourceChannel] = useState<AttachmentContextSourceChannel>('chat')
  const [attachments, setAttachments] = useState<AssistantAttachmentDraft[]>([])
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
  const hasContextUpload = attachments.some((attachment) => attachment.status === 'uploading')
  const controls = assistantControlsForRoute(route, cancellationRoute, isSending || isStreaming || hasContextUpload)
  const canSend = controls.canSend
  const canAttach = !route.disabled && !isSending && !isStreaming && !hasContextUpload
  const attachmentsAwaitingValidation = attachments.filter((attachment) =>
    attachment.status === 'staged' || attachment.status === 'error'
  )
  const contextSummary = summarizeAttachments(attachments)

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
    const contextResult = await ingestPendingAttachments()
    if (contextResult === 'blocked') return
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

  async function ingestPendingAttachments(): Promise<'ready' | 'blocked'> {
    if (attachments.some((attachment) => attachment.status === 'rejected' || attachment.status === 'unsupported')) {
      setLastError('Remove rejected or unsupported context items before sending.')
      return 'blocked'
    }
    const pending = attachments.filter((attachment) => attachment.status === 'staged' || attachment.status === 'error')
    if (pending.length === 0) return 'ready'

    setLastError(null)
    setAttachments((current) =>
      current.map((attachment) =>
        pending.some((candidate) => candidate.id === attachment.id)
          ? { ...attachment, status: 'uploading', progress: 48, message: 'Uploading context metadata through AuroraClient' }
          : attachment
      )
    )

    const result = await client.assistant.ingestContext({
      items: pending.map(attachmentToContextItem),
      session_id: session.sessionId,
      namespace: 'assistant.attachments',
      storage_policy: 'ephemeral',
      privacy_class: privacyClass,
      limits: defaultContextLimits
    })

    if (!result.ok) {
      const message = assistantErrorMessage(result.error)
      setLastError(message)
      setAttachments((current) =>
        current.map((attachment) =>
          pending.some((candidate) => candidate.id === attachment.id)
            ? { ...attachment, status: 'error', progress: 0, message }
            : attachment
        )
      )
      return 'blocked'
    }

    applyContextIngestResult(pending, result.data)
    return result.data.accepted && !result.data.rejected ? 'ready' : 'blocked'
  }

  function applyContextIngestResult(
    pending: AssistantAttachmentDraft[],
    response: AttachmentContextIngestResponse
  ) {
    const outcomes = mapContextIngestOutcomesByPendingIndex(response)
    setAttachments((current) =>
      current.map((attachment) => {
        const pendingIndex = pending.findIndex((candidate) => candidate.id === attachment.id)
        if (pendingIndex === -1) return attachment
        const outcome = outcomes.get(pendingIndex)
        if (!outcome) {
          return { ...attachment, status: 'error', progress: 0, message: 'No backend outcome was returned for this context item.' }
        }
        return {
          ...attachment,
          status: attachmentStatusFromBackend(outcome.status),
          progress: isAcceptedContextStatus(outcome.status) ? 100 : 0,
          message: outcome.message || outcome.reason_code || 'Context ingestion completed.',
          reasonCode: outcome.reason_code,
          redacted: outcome.redacted
        }
      })
    )
    if (response.rejected) {
      setLastError('Some context items were rejected or unsupported. Remove or revise them before retrying.')
    }
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

  function addUrlAttachment() {
    const value = urlDraft.trim()
    if (!value || !canAttach) return
    setAttachments((current) => [...current, createAttachmentDraft({
      kind: 'url',
      label: urlLabel(value),
      detail: value,
      url: value,
      sourceChannel,
      privacyClass
    })])
    setUrlDraft('')
  }

  function addSharedTextAttachment() {
    const value = sharedTextDraft.trim()
    if (!value || !canAttach) return
    setAttachments((current) => [...current, createAttachmentDraft({
      kind: 'text',
      label: 'Shared text',
      detail: `${value.length} characters`,
      contentText: value,
      sourceChannel,
      privacyClass
    })])
    setSharedTextDraft('')
  }

  async function onFileInput(files: FileList | null) {
    if (!files || !canAttach) return
    const next = await Promise.all([...files].map((file) => fileToAttachmentDraft(file, sourceChannel, privacyClass)))
    setAttachments((current) => [...current, ...next])
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
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
          <EvidenceBadge label={`${contextSummary.ready} context ready`} />
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
            <div><dt>Context</dt><dd>{contextSummary.ready} ready, {contextSummary.blocked} blocked</dd></div>
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

      <section className="aui-attachment-panel" aria-labelledby="assistant-context-title">
        <div className="aui-attachment-head">
          <div>
            <p className="aui-kicker">Context intake</p>
            <h2 id="assistant-context-title">Attachments and shared content</h2>
          </div>
          <div className="aui-assistant-badges" aria-label="Context route and privacy evidence">
            <PrivacyBadge privacy={privacyClass} />
            <EvidenceBadge label={route.providerLabel} />
            <EvidenceBadge label={sourceLabel(sourceChannel)} />
          </div>
        </div>

        <div className="aui-attachment-controls">
          <label>
            Privacy label
            <select
              value={privacyClass}
              onChange={(event) => setPrivacyClass(event.currentTarget.value as AttachmentContextPrivacyClass)}
              disabled={!canAttach}
            >
              <option value="public">Public</option>
              <option value="personal">Personal</option>
              <option value="sensitive">Sensitive</option>
              <option value="secret">Secret</option>
              <option value="credential">Credential</option>
              <option value="raw-audio">Raw audio</option>
            </select>
          </label>
          <label>
            Share source
            <select
              value={sourceChannel}
              onChange={(event) => setSourceChannel(event.currentTarget.value as AttachmentContextSourceChannel)}
              disabled={!canAttach}
            >
              <option value="chat">Chat composer</option>
              <option value="desktop">Desktop drop</option>
              <option value="mobile_share_sheet">Mobile share sheet</option>
              <option value="deep_link">Deep link</option>
              <option value="browser_extension">Browser extension</option>
            </select>
          </label>
          <label>
            URL
            <span className="aui-inline-action">
              <input
                value={urlDraft}
                onChange={(event) => setUrlDraft(event.currentTarget.value)}
                disabled={!canAttach}
                placeholder="https://example.com/context"
              />
              <button type="button" onClick={addUrlAttachment} disabled={!canAttach || !urlDraft.trim()}>
                <Link size={16} aria-hidden />
                Add URL
              </button>
            </span>
          </label>
          <label>
            Shared text
            <span className="aui-inline-action">
              <textarea
                value={sharedTextDraft}
                onChange={(event) => setSharedTextDraft(event.currentTarget.value)}
                disabled={!canAttach}
                placeholder="Paste shared text or screenshot OCR"
                rows={2}
              />
              <button type="button" onClick={addSharedTextAttachment} disabled={!canAttach || !sharedTextDraft.trim()}>
                <Share2 size={16} aria-hidden />
                Add text
              </button>
            </span>
          </label>
          <label className="aui-file-picker">
            <Paperclip size={16} aria-hidden />
            <span>Add files or images</span>
            <input
              type="file"
              multiple
              disabled={!canAttach}
              onChange={(event) => {
                void onFileInput(event.currentTarget.files)
                event.currentTarget.value = ''
              }}
            />
          </label>
        </div>

        <p className="aui-attachment-note">
          Native mobile share payloads remain disabled until the Android and iOS native manifests advertise them; staged items still use the backend ingestion contract through AuroraClient.
        </p>

        {attachments.length === 0 ? (
          <div className="aui-attachment-empty">No context attached.</div>
        ) : (
          <ul className="aui-attachment-list" aria-label="Attached context items">
            {attachments.map((attachment) => (
              <li key={attachment.id} className={`aui-attachment-item aui-attachment-${attachment.status}`}>
                <div>
                  <strong>{attachment.label}</strong>
                  <span>{attachment.detail}</span>
                  <small>{sourceLabel(attachment.sourceChannel)} / {attachment.privacyClass} / {attachment.message}</small>
                  {attachment.status === 'uploading' ? <progress value={attachment.progress} max={100}>{attachment.progress}%</progress> : null}
                </div>
                <StatusBadge state={attachmentStateBadge(attachment.status)} />
                <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.label}`}>
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachmentsAwaitingValidation.length > 0 ? <p className="aui-attachment-note">{attachmentsAwaitingValidation.length} item(s) will be validated before the prompt is sent.</p> : null}
      </section>

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
        <button type="submit" disabled={!canSend || hasContextUpload || text.trim().length === 0} aria-label="Send assistant prompt">
          <SendHorizontal size={17} aria-hidden />
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}

export function attachmentToContextItem(attachment: AssistantAttachmentDraft): AttachmentContextItem {
  const source = {
    channel: attachment.sourceChannel,
    display_name: attachment.sourceDisplayName,
    mime_type: attachment.mimeType ?? null,
    uri: attachment.url ?? null,
    shared_at: new Date().toISOString()
  }
  return {
    kind: attachment.kind,
    content_text: attachment.contentText ?? null,
    url: attachment.url ?? null,
    title: attachment.label,
    filename: attachment.filename ?? null,
    mime_type: attachment.mimeType ?? null,
    size_bytes: attachment.sizeBytes ?? null,
    source,
    metadata: {
      ui_status: attachment.status,
      route_privacy_class: attachment.privacyClass
    }
  }
}

export function attachmentStatusFromBackend(status: AttachmentContextStatus): AttachmentTrayStatus {
  if (status === 'accepted' || status === 'redacted' || status === 'stored') return status
  if (status === 'unsupported') return 'unsupported'
  return 'rejected'
}

export function isAcceptedContextStatus(status: AttachmentContextStatus): boolean {
  return status === 'accepted' || status === 'redacted' || status === 'stored'
}

export function contextIngestOutcomeIndex(itemId: string): number | null {
  const productionMatch = /^context-(\d+)-.+$/.exec(itemId)
  if (productionMatch) return Number(productionMatch[1])
  const mockMatch = /^mock-context-(\d+)$/.exec(itemId)
  if (mockMatch) return Number(mockMatch[1])
  return null
}

export function mapContextIngestOutcomesByPendingIndex(
  response: Pick<AttachmentContextIngestResponse, 'accepted_items' | 'rejected_items'>
): Map<number, AttachmentContextItemResult> {
  const outcomes = new Map<number, AttachmentContextItemResult>()
  for (const outcome of [...response.accepted_items, ...response.rejected_items]) {
    const index = contextIngestOutcomeIndex(outcome.item_id)
    if (index === null) continue
    outcomes.set(index, outcome)
  }
  return outcomes
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

function createAttachmentDraft(input: {
  kind: AssistantAttachmentDraft['kind']
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  sourceChannel: AttachmentContextSourceChannel
  privacyClass: AttachmentContextPrivacyClass
}): AssistantAttachmentDraft {
  return {
    id: `context-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    contentText: input.contentText ?? null,
    url: input.url ?? null,
    filename: input.filename ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    sourceChannel: input.sourceChannel,
    sourceDisplayName: sourceLabel(input.sourceChannel),
    privacyClass: input.privacyClass,
    status: input.kind === 'image' && !input.contentText ? 'unsupported' : 'staged',
    progress: 0,
    message: input.kind === 'image' && !input.contentText
      ? 'Image binaries require OCR or native payload support before ingestion.'
      : 'Staged for backend validation.',
    reasonCode: null,
    redacted: false
  }
}

async function fileToAttachmentDraft(
  file: File,
  sourceChannel: AttachmentContextSourceChannel,
  privacyClass: AttachmentContextPrivacyClass
): Promise<AssistantAttachmentDraft> {
  const isTextLike = file.type.startsWith('text/') || ['application/json', 'application/xml'].includes(file.type)
  const isImage = file.type.startsWith('image/')
  let contentText: string | null = null
  if (isTextLike) {
    contentText = await file.text()
  }
  return createAttachmentDraft({
    kind: isImage ? 'image' : 'file',
    label: file.name,
    detail: `${file.type || 'unknown type'} / ${formatBytes(file.size)}`,
    contentText,
    filename: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
    sourceChannel,
    privacyClass
  })
}

function summarizeAttachments(attachments: AssistantAttachmentDraft[]): { ready: number; blocked: number } {
  return attachments.reduce(
    (summary, attachment) => {
      if (['accepted', 'redacted', 'stored'].includes(attachment.status)) summary.ready += 1
      if (['unsupported', 'rejected', 'error'].includes(attachment.status)) summary.blocked += 1
      return summary
    },
    { ready: 0, blocked: 0 }
  )
}

function attachmentStateBadge(status: AttachmentTrayStatus) {
  if (status === 'accepted' || status === 'stored' || status === 'redacted') return 'available-local' as const
  if (status === 'uploading' || status === 'staged') return 'pending' as const
  if (status === 'unsupported') return 'unsupported' as const
  return 'denied' as const
}

function sourceLabel(source: AttachmentContextSourceChannel): string {
  if (source === 'mobile_share_sheet') return 'mobile share sheet'
  if (source === 'deep_link') return 'deep link'
  if (source === 'browser_extension') return 'browser extension'
  if (source === 'desktop') return 'desktop'
  if (source === 'api') return 'API'
  return 'chat composer'
}

function urlLabel(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return 'URL context'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
