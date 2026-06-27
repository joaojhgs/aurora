'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, Mic, Paperclip, Radio, RotateCcw, SendHorizontal, Share2, StopCircle, Trash2, Volume2, WifiOff } from 'lucide-react'
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
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'
import { RouteSheet } from './route-sheet'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface AssistantViewProps {
  client: AuroraClient
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
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

export type VoiceCaptureStatus = 'idle' | 'listening' | 'permission-denied' | 'no-device' | 'error'

export interface VoiceCapabilityChip {
  id: string
  label: string
  state: RouteAvailability['state']
  privacyClass: 'public' | 'personal' | 'sensitive' | 'secret' | 'raw-audio' | 'credential' | 'admin-critical'
  providerLabel: string
  detail: string
  blockers: string[]
  evidence: string[]
}

export interface VoiceControlModel {
  id: string
  label: string
  state: RouteAvailability['state']
  enabled: boolean
  reason: string
  route: RouteAvailability | null
}

export interface VoiceEventRow {
  id: string
  label: string
  state: RouteAvailability['state']
  detail: string
}

export interface AssistantVoiceModel {
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  privacyClass: 'raw-audio'
  retentionPolicy: string
  sessionTtl: string
  transport: string
  targetLabel: string
  chips: VoiceCapabilityChip[]
  controls: VoiceControlModel[]
  events: VoiceEventRow[]
  routeSheetRoute: RouteAvailability
  remoteAudioRoute: RouteAvailability
  waveformBars: number[]
}

const defaultStorageKey = 'aurora.assistant.session.v1'
const defaultContextLimits = {
  max_items: 8,
  max_item_bytes: 262_144,
  max_total_bytes: 1_048_576,
  max_text_chars: 120_000
}

export function AssistantView({
  client,
  route,
  cancellationRoute,
  voiceRoutes,
  nativePlatform = 'not available',
  nativeAvailable = false,
  nativePermissions = [],
  nativeCapabilities = [],
  storageKey = defaultStorageKey
}: AssistantViewProps) {
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
  const [voiceConsentGranted, setVoiceConsentGranted] = useState(false)
  const [voiceCaptureStatus, setVoiceCaptureStatus] = useState<VoiceCaptureStatus>('idle')
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
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
  const voiceModel = useMemo(
    () => buildAssistantVoiceModel({
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      captureStatus: voiceCaptureStatus,
      consentGranted: voiceConsentGranted
    }),
    [
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      voiceCaptureStatus,
      voiceConsentGranted
    ]
  )

  useEffect(() => {
    setSession(loadAssistantSession(storageKey))
  }, [storageKey])

  useEffect(() => {
    persistAssistantSession(storageKey, session)
  }, [session, storageKey])

  useEffect(() => () => {
    abortRef.current?.abort()
    stopLocalCapture()
  }, [])

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

  async function toggleLocalCapture() {
    if (voiceCaptureStatus === 'listening') {
      stopLocalCapture()
      setVoiceCaptureStatus('idle')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setVoiceCaptureStatus('no-device')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      voiceStreamRef.current = stream
      setVoiceCaptureStatus('listening')
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      setVoiceCaptureStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'permission-denied' : 'error')
    }
  }

  function stopLocalCapture() {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
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

      <VoiceModePanel
        client={client}
        model={voiceModel}
        captureStatus={voiceCaptureStatus}
        onToggleCapture={() => void toggleLocalCapture()}
        onToggleConsent={() => setVoiceConsentGranted((current) => !current)}
      />

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

export function buildAssistantVoiceModel(input: {
  client: AuroraClient
  route: RouteAvailability
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
}): AssistantVoiceModel {
  const transcription = input.voiceRoutes?.transcription ?? missingVoiceRoute('voice-transcription', 'Remote transcription', 'Transcription.Transcribe', 'raw-audio')
  const wakeProcess = input.voiceRoutes?.wakeProcess ?? missingVoiceRoute('voice-wake-process', 'Wake audio processing', 'WakeWord.ProcessAudio', 'raw-audio')
  const wakeControl = input.voiceRoutes?.wakeControl ?? missingVoiceRoute('voice-wake-control', 'Wake foreground control', 'WakeWord.Control', 'raw-audio')
  const ttsSynthesize = input.voiceRoutes?.ttsSynthesize ?? missingVoiceRoute('voice-tts-synthesize', 'TTS synthesis', 'TTS.Synthesize', 'personal')
  const ttsStop = input.voiceRoutes?.ttsStop ?? missingVoiceRoute('voice-tts-stop', 'TTS playback stop', 'TTS.Stop', 'personal')
  const nativeCapture = nativeCaptureState(input.nativeAvailable ?? false, input.nativePlatform ?? 'not available', input.nativePermissions ?? [], input.nativeCapabilities ?? [])
  const browserCaptureState = browserCaptureAvailability(input.client.transport.kind, input.captureStatus)
  const remoteAudioRoute = remoteAudioRouteFor(transcription, ttsSynthesize, wakeProcess)

  return {
    captureStatus: input.captureStatus,
    consentGranted: input.consentGranted,
    privacyClass: 'raw-audio',
    retentionPolicy: remoteAudioRoute.disabled ? 'not retained: route unavailable' : 'transient unless backend retention policy says otherwise',
    sessionTtl: input.consentGranted ? 'current UI session' : 'consent not granted',
    transport: input.client.transport.kind,
    targetLabel: remoteAudioRoute.providerLabel,
    chips: [
      {
        id: 'browser-capture',
        label: 'Browser capture',
        state: browserCaptureState.state,
        privacyClass: 'raw-audio',
        providerLabel: browserCaptureState.providerLabel,
        detail: browserCaptureState.detail,
        blockers: browserCaptureState.blockers,
        evidence: [input.client.transport.kind, 'browser getUserMedia']
      },
      nativeCapture,
      voiceChip('remote-processing', 'Remote processing', transcription, 'raw-audio', input.consentGranted
        ? 'Remote STT route has UI session consent.'
        : 'Remote STT route requires consent before audio leaves this device.'),
      voiceChip('wake', 'Wake and background', wakeControl.disabled ? wakeProcess : wakeControl, 'raw-audio', wakeDetail(input.nativePlatform ?? 'not available', wakeControl, wakeProcess)),
      voiceChip('tts', 'TTS synthesis', ttsSynthesize, 'personal', 'Batch synthesis is separate from playback hardware control.'),
      voiceChip('playback', 'Local playback', ttsStop, 'personal', 'Playback stop/control is separate from remote synthesis.')
    ],
    controls: [
      {
        id: 'push-to-talk',
        label: input.captureStatus === 'listening' ? 'Stop local capture' : 'Push to talk',
        state: browserCaptureState.state,
        enabled: browserCaptureState.state !== 'unsupported',
        reason: browserCaptureState.detail,
        route: null
      },
      {
        id: 'remote-consent',
        label: input.consentGranted ? 'Revoke audio consent' : 'Grant session consent',
        state: remoteAudioRoute.disabled ? remoteAudioRoute.state : input.consentGranted ? 'available-local' : 'privacy-blocked',
        enabled: !remoteAudioRoute.disabled || remoteAudioRoute.state === 'privacy-blocked',
        reason: input.consentGranted
          ? 'Consent can be revoked before starting another remote audio session.'
          : 'Required before raw audio is routed to a remote peer/provider.',
        route: remoteAudioRoute
      },
      voiceAction('remote-transcription', 'Start transcription', transcription, input.captureStatus, input.consentGranted),
      voiceAction('wakeword', 'Wake foreground', wakeControl.disabled ? wakeProcess : wakeControl, input.captureStatus, input.consentGranted),
      voiceAction('tts-synthesize', 'Synthesize speech', ttsSynthesize, input.captureStatus, input.consentGranted),
      voiceAction('playback-stop', 'Stop playback', ttsStop, input.captureStatus, input.consentGranted)
    ],
    events: voiceEventRows(input.captureStatus, transcription),
    routeSheetRoute: remoteAudioRoute,
    remoteAudioRoute,
    waveformBars: waveformBars(input.captureStatus)
  }
}

function VoiceModePanel({
  client,
  model,
  captureStatus,
  onToggleCapture,
  onToggleConsent
}: {
  client: AuroraClient
  model: AssistantVoiceModel
  captureStatus: VoiceCaptureStatus
  onToggleCapture: () => void
  onToggleConsent: () => void
}) {
  return (
    <section className="aui-voice-panel" aria-labelledby="assistant-voice-title">
      <header className="aui-voice-header">
        <div>
          <p className="aui-kicker">Voice</p>
          <h2 id="assistant-voice-title">Voice modes</h2>
        </div>
        <div className="aui-assistant-badges" aria-label="Voice evidence">
          <PrivacyBadge privacy={model.privacyClass} />
          <EvidenceBadge label={model.transport} />
          <EvidenceBadge label={model.consentGranted ? 'consent granted' : 'consent required'} />
          <EvidenceBadge label={model.targetLabel} />
        </div>
      </header>

      <div className="aui-voice-chip-grid" aria-label="Voice mode capability states">
        {model.chips.map((chip) => (
          <article key={chip.id} className="aui-voice-chip">
            <header>
              <strong>{chip.label}</strong>
              <StatusBadge state={chip.state} />
            </header>
            <p>{chip.detail}</p>
            <div className="aui-settings-inline">
              <PrivacyBadge privacy={chip.privacyClass} />
              <EvidenceBadge label={chip.providerLabel} />
            </div>
            <small>{chip.blockers.length > 0 ? chip.blockers.join(', ') : chip.evidence.join(', ')}</small>
          </article>
        ))}
      </div>

      <div className="aui-voice-body">
        <section className="aui-voice-controls" aria-labelledby="voice-controls-title">
          <h3 id="voice-controls-title">Session controls</h3>
          <div className="aui-waveform" role="img" aria-label={`Capture state ${captureStatus}`}>
            {model.waveformBars.map((height, index) => (
              <span key={`${height}-${index}`} style={{ height: `${height}%` }} />
            ))}
          </div>
          <div className="aui-voice-action-grid">
            {model.controls.map((control) => {
              const isCapture = control.id === 'push-to-talk'
              const isConsent = control.id === 'remote-consent'
              return (
                <button
                  key={control.id}
                  type="button"
                  disabled={!control.enabled}
                  onClick={isCapture ? onToggleCapture : isConsent ? onToggleConsent : undefined}
                >
                  {isCapture ? <Mic size={16} aria-hidden /> : control.id.includes('tts') || control.id.includes('playback') ? <Volume2 size={16} aria-hidden /> : <Radio size={16} aria-hidden />}
                  <span>{control.label}</span>
                </button>
              )
            })}
          </div>
          <ul className="aui-voice-reasons" aria-live="polite">
            {model.controls.map((control) => (
              <li key={control.id}>
                <StatusBadge state={control.state} />
                <span>{control.reason}</span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="aui-voice-privacy" aria-label="Audio route privacy details">
          <h3>Audio privacy</h3>
          <dl>
            <div><dt>Privacy class</dt><dd>{model.privacyClass}</dd></div>
            <div><dt>Peer/provider</dt><dd>{model.targetLabel}</dd></div>
            <div><dt>Transport</dt><dd>{model.transport}</dd></div>
            <div><dt>Retention</dt><dd>{model.retentionPolicy}</dd></div>
            <div><dt>Session TTL</dt><dd>{model.sessionTtl}</dd></div>
          </dl>
          <RouteSheet
            client={client}
            title="Audio route and consent"
            description="Raw audio leaves the local device only when the selected route, consent, privacy indicator, and target policy allow it."
            payload={{
              audio_privacy_class: model.privacyClass,
              capture_state: model.captureStatus,
              retention_policy: model.retentionPolicy,
              session_ttl: model.sessionTtl
            }}
            routeRequest={{
              topic: model.routeSheetRoute.item.capabilityMethod
                ? `${model.routeSheetRoute.item.capabilityModule}.${model.routeSheetRoute.item.capabilityMethod}`
                : model.routeSheetRoute.item.capabilityModule,
              method: model.routeSheetRoute.item.capabilityMethod ?? null,
              include_candidates: true
            }}
            dataClasses={['raw-audio', model.routeSheetRoute.item.privacyClass]}
            privacyClass="raw-audio"
            consentGranted={model.consentGranted}
            privacyIndicatorShown={model.captureStatus === 'listening' || model.consentGranted}
            auditReceiptTarget={model.targetLabel}
            requiresAdminAction={model.routeSheetRoute.requiresAdminAction}
          />
        </aside>
      </div>

      <section className="aui-voice-events" aria-labelledby="voice-events-title">
        <h3 id="voice-events-title">Voice event stream</h3>
        <ul>
          {model.events.map((event) => (
            <li key={event.id}>
              <StatusBadge state={event.state} />
              <strong>{event.label}</strong>
              <span>{event.detail}</span>
            </li>
          ))}
        </ul>
      </section>
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

function missingVoiceRoute(
  id: string,
  label: string,
  capability: string,
  privacyClass: VoiceCapabilityChip['privacyClass']
): RouteAvailability {
  const [capabilityModule, capabilityMethod] = capability.split('.')
  return {
    item: {
      id,
      label,
      href: '/',
      capabilityModule: capabilityModule ?? capability,
      capabilityMethod: capabilityMethod ?? capability,
      methodType: 'use' as const,
      privacyClass,
      fallbackState: 'unsupported' as const,
      adminGated: false,
      expectedTask: 'UIA-004'
    },
    state: 'unsupported',
    explanation: `${capability} capability evidence is not available in the SDK snapshot.`,
    providerLabel: 'UIA-004 pending',
    blockers: ['capability_not_advertised'],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['missing voice route'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: false
  }
}

function nativeCaptureState(
  nativeAvailable: boolean,
  nativePlatform: string,
  nativePermissions: Array<{ name: string; granted: boolean }>,
  nativeCapabilities: Array<{ name: string; enabled: boolean }>
): VoiceCapabilityChip {
  const permissionCandidates = nativePermissions.filter((entry) => voiceNativeKey(entry.name))
  const capabilityCandidates = nativeCapabilities.filter((entry) => voiceNativeKey(entry.name))
  const permission = permissionCandidates.find((entry) => !entry.granted) ?? permissionCandidates[0]
  const capability = capabilityCandidates.find((entry) => entry.enabled) ?? capabilityCandidates[0]
  const state = !nativeAvailable
    ? 'unsupported'
    : permission && !permission.granted
      ? 'privacy-blocked'
      : capability?.enabled
        ? 'available-local'
        : 'unsupported'
  return {
    id: 'native-capture',
    label: 'Native capture',
    state,
    privacyClass: 'raw-audio',
    providerLabel: nativeAvailable ? `native:${nativePlatform}` : 'native manifest missing',
    detail: state === 'available-local'
      ? 'SDK native manifest reports microphone or voice capture support.'
      : state === 'privacy-blocked'
        ? nativePlatform.toLowerCase().includes('ios')
          ? 'iOS foreground capture is blocked until microphone permission, raw-audio consent, and a visible stop/revoke path are available.'
          : 'Native capture is blocked until the platform microphone permission is granted.'
        : 'Tauri, Android, and iOS capture stay disabled until native manifest support lands.',
    blockers: state === 'available-local' ? [] : [permission && !permission.granted ? `native permission missing: ${permission.name}` : 'native voice capture unavailable'],
    evidence: nativeAvailable ? ['native-manifest'] : []
  }
}

function voiceNativeKey(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('microphone') || normalized.includes('voice') || normalized.includes('audio')
}

function browserCaptureAvailability(
  transportKind: string,
  captureStatus: VoiceCaptureStatus
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  if (transportKind === 'tauri-local' || transportKind === 'native-mobile') {
    return {
      state: 'unsupported',
      providerLabel: transportKind,
      detail: 'Native capture must come from the SDK native manifest for this transport.',
      blockers: ['native_manifest_required']
    }
  }
  if (captureStatus === 'listening') {
    return {
      state: 'available-local',
      providerLabel: 'browser getUserMedia',
      detail: 'Local browser microphone stream is active on this device.',
      blockers: []
    }
  }
  if (captureStatus === 'permission-denied') {
    return {
      state: 'denied',
      providerLabel: 'browser getUserMedia',
      detail: 'Browser microphone permission was denied.',
      blockers: ['browser_microphone_permission_denied']
    }
  }
  if (captureStatus === 'no-device') {
    return {
      state: 'unsupported',
      providerLabel: 'browser getUserMedia',
      detail: 'This runtime did not expose a browser microphone device API.',
      blockers: ['browser_microphone_api_missing']
    }
  }
  if (captureStatus === 'error') {
    return {
      state: 'degraded',
      providerLabel: 'browser getUserMedia',
      detail: 'Browser microphone capture failed; retry or inspect device settings.',
      blockers: ['browser_microphone_error']
    }
  }
  return {
    state: 'pending',
    providerLabel: 'browser getUserMedia',
    detail: 'Local capture waits for the browser permission prompt.',
    blockers: []
  }
}

function voiceChip(
  id: string,
  label: string,
  route: RouteAvailability,
  privacyClass: VoiceCapabilityChip['privacyClass'],
  detail: string
): VoiceCapabilityChip {
  return {
    id,
    label,
    state: route.state,
    privacyClass,
    providerLabel: route.providerLabel,
    detail,
    blockers: route.blockers,
    evidence: route.evidenceSources
  }
}

function wakeDetail(nativePlatform: string, wakeControl: RouteAvailability, wakeProcess: RouteAvailability): string {
  if (nativePlatform.toLowerCase().includes('ios')) {
    return 'iOS wake/background assistant behavior remains foreground-only or app-owned through Siri/Shortcuts/App Intents, widgets, share sheet, deep links, or notifications; system assistant ownership is unavailable.'
  }
  if (nativePlatform.toLowerCase().includes('android')) {
    return 'Android wake/background behavior requires foreground service and native plugin evidence.'
  }
  if (!wakeControl.disabled) return 'Wake control is foreground-capable through backend route evidence.'
  if (!wakeProcess.disabled) return 'Wake audio processing exists, but foreground/background control is not advertised.'
  return 'Wakeword remains unsupported until backend and native capture capability evidence exists.'
}

function remoteAudioRouteFor(...routes: RouteAvailability[]): RouteAvailability {
  return routes.find((route) => route.state === 'available-remote' || route.state === 'privacy-blocked') ??
    routes.find((route) => !route.disabled) ??
    routes[0]!
}

function voiceAction(
  id: string,
  label: string,
  route: RouteAvailability,
  captureStatus: VoiceCaptureStatus,
  consentGranted: boolean
): VoiceControlModel {
  if (route.disabled) {
    return {
      id,
      label,
      state: route.state,
      enabled: false,
      reason: route.blockers.join(', ') || route.explanation,
      route
    }
  }
  if ((route.state === 'available-remote' || route.selectorRequired) && !consentGranted) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Grant session consent before routing microphone/audio work to a remote peer.',
      route
    }
  }
  if ((id === 'remote-transcription' || id === 'wakeword') && captureStatus !== 'listening') {
    return {
      id,
      label,
      state: 'pending',
      enabled: false,
      reason: 'Start local capture before creating an audio session.',
      route
    }
  }
  return {
    id,
    label,
    state: route.state,
    enabled: false,
    reason: 'Capability route is visible; typed audio session start/status SDK wiring is still required before dispatch.',
    route
  }
}

function voiceEventRows(captureStatus: VoiceCaptureStatus, transcription: RouteAvailability): VoiceEventRow[] {
  const captureFailure: VoiceEventRow | null =
    captureStatus === 'permission-denied'
      ? { id: 'permission-loss', label: 'Local permission loss', state: 'denied', detail: 'Browser or native microphone permission was lost or denied.' }
      : captureStatus === 'no-device' || captureStatus === 'error'
        ? { id: 'capture-error', label: 'Capture error', state: captureStatus === 'no-device' ? 'unsupported' : 'degraded', detail: 'Local capture failed before audio could be routed.' }
        : null
  return [
    { id: 'partial', label: 'Partial transcription', state: transcription.disabled ? 'unsupported' : 'pending', detail: 'Incremental text remains tied to backend stream events.' },
    { id: 'final', label: 'Final transcription', state: transcription.disabled ? 'unsupported' : transcription.state, detail: 'Final text must come from Transcription backend evidence.' },
    { id: 'timeout', label: 'Timeout', state: 'degraded', detail: 'Timeouts remain visible as retryable voice session outcomes.' },
    { id: 'cancelled', label: 'Cancelled', state: 'pending', detail: 'Cancellation must revoke or stop the current audio session.' },
    { id: 'remote-denied', label: 'Remote denial', state: 'denied', detail: 'Policy, selector, or peer denial is shown without silent fallback.' },
    { id: 'peer-disconnect', label: 'Peer disconnect', state: 'stale', detail: 'Remote peer loss makes the current provider unselectable.' },
    ...(captureFailure ? [captureFailure] : [])
  ]
}

function waveformBars(captureStatus: VoiceCaptureStatus): number[] {
  if (captureStatus === 'listening') return [24, 48, 72, 52, 84, 38, 64, 46, 76, 30, 58, 42]
  if (captureStatus === 'permission-denied' || captureStatus === 'error') return [18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18]
  return [12, 20, 14, 22, 16, 18, 12, 20, 14, 22, 16, 18]
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
