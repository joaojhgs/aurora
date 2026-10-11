import type { AssistantStreamUpdate, AuroraClient, AuroraEvent, AuroraError, AuditReceipt, JsonObject } from '@aurora/client'
import { useAuroraEvents, type AuroraEventsSnapshot, type AuroraEventsSnapshotRecoveryDecision, type UseAuroraEventsOptions } from './use-aurora-events'

export const NATIVE_ASSISTANT_EVENT_KINDS = [
  'voice.turn.started',
  'voice.turn.transcribing',
  'voice.turn.requesting',
  'voice.turn.speaking',
  'voice.turn.finalized',
  'voice.turn.failed',
  'assistant.delta',
  'assistant.tool',
  'assistant.completed',
  'assistant.failed',
  'tool.requested',
  'tool.running',
  'tool.completed',
  'tool.failed',
  'tool.requires_action',
  'native.events.gap'
] as const

export type NativeAssistantEventStatus = 'idle' | 'connecting' | 'streaming' | 'recovering' | 'closed' | 'unsupported' | 'error'

export interface NativeAssistantEventState {
  status: NativeAssistantEventStatus
  lastEventId: string | null
  lastSequenceId: string | null
  error: Error | null
}

export interface UseNativeAssistantEventsOptions {
  client: Pick<AuroraClient, 'events'> | null | undefined
  enabled: boolean
  subjects?: string[] | undefined
  lifecycleScopeKey?: string | null | undefined
  onEvent: (event: AuroraEvent<unknown>) => void | Promise<void>
  onSnapshot?: (snapshot: AuroraEventsSnapshot<unknown>) => AuroraEventsSnapshotRecoveryDecision | void | Promise<AuroraEventsSnapshotRecoveryDecision | void>
}

export interface NativeAssistantTurnIdentity {
  key: string
  generation: number | null
  requestId: string | null
  conversationId: string | null
  transcript: string | null
}

export interface NativeAssistantSubjectSnapshot {
  subject: string
  kind: string
  generation?: number | string | null | undefined
  sessionId?: string | null | undefined
  session_id?: string | null | undefined
  requestId?: string | null | undefined
  request_id?: string | null | undefined
  correlationId?: string | null | undefined
  correlation_id?: string | null | undefined
  conversationId?: string | null | undefined
  conversation_id?: string | null | undefined
  accumulatedText?: string | null | undefined
  accumulated_text?: string | null | undefined
  transcript?: string | null | undefined
  userText?: string | null | undefined
  user_text?: string | null | undefined
  inputText?: string | null | undefined
  input_text?: string | null | undefined
  status: string
  terminal: boolean
  persisted?: boolean | null | undefined
  persistenceErrorCode?: string | null | undefined
  persistence_error_code?: string | null | undefined
  updatedAt?: string | null | undefined
  updated_at?: string | null | undefined
}



export function nativeAssistantSnapshotRecoveryDecision(appliedRelevantState: boolean): AuroraEventsSnapshotRecoveryDecision | void {
  return appliedRelevantState ? { recovered: true, replayEvents: false } : undefined
}

export interface NativeAssistantPendingTurnRecord {
  pendingId: string
  conversationId: string | null
  transcript: string | null
}

export interface NativeAssistantPendingTurnDecision {
  accepted: boolean
  pendingId: string | null
  conversationId: string | null
}

export function nativeAssistantPendingTurnDecision(input: {
  activeConversationId: string | null
  identity: Pick<NativeAssistantTurnIdentity, 'key' | 'requestId' | 'conversationId' | 'transcript'>
  existing: NativeAssistantPendingTurnRecord | null | undefined
}): NativeAssistantPendingTurnDecision {
  const { activeConversationId, identity, existing } = input
  if (existing) {
    const nextConversationId = existing.conversationId ?? identity.conversationId ?? null
    if (
      activeConversationId
      && identity.conversationId
      && activeConversationId !== identity.conversationId
      && activeConversationId !== existing.pendingId
    ) {
      return { accepted: false, pendingId: null, conversationId: nextConversationId }
    }
    if (
      activeConversationId
      && existing.conversationId
      && activeConversationId !== existing.conversationId
      && activeConversationId !== existing.pendingId
    ) {
      return { accepted: false, pendingId: null, conversationId: nextConversationId }
    }
    return { accepted: true, pendingId: existing.pendingId, conversationId: nextConversationId }
  }
  if (activeConversationId && identity.conversationId && activeConversationId !== identity.conversationId) {
    return { accepted: false, pendingId: null, conversationId: identity.conversationId }
  }
  if (activeConversationId && !identity.conversationId) {
    return { accepted: false, pendingId: null, conversationId: null }
  }
  const pendingId = identity.requestId ?? `native-assistant-${identity.key}`
  return { accepted: true, pendingId, conversationId: identity.conversationId }
}

export function useNativeAssistantEvents({
  client,
  enabled,
  subjects,
  lifecycleScopeKey,
  onEvent,
  onSnapshot
}: UseNativeAssistantEventsOptions): NativeAssistantEventState {
  const eventOptions: UseAuroraEventsOptions<unknown> = {
    client,
    enabled,
    source: 'native',
    kinds: [...NATIVE_ASSISTANT_EVENT_KINDS],
    backfill: true,
    bootstrapSnapshot: true,
    reconnect: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 2_000 },
    maxEvents: 100,
    maxGapRecoveries: 2,
    lifecycleScopeKey,
    ...(subjects ? { subjects } : {}),
    ...(onSnapshot ? { onSnapshot } : {})
  }
  const state = useAuroraEvents<unknown>(eventOptions, onEvent)
  return {
    status: state.status,
    lastEventId: state.lastEventId,
    lastSequenceId: state.recovery.lastSequenceId,
    error: state.error
  }
}

export function nativeAssistantSubjectSnapshotToEvent(subject: NativeAssistantSubjectSnapshot): AuroraEvent<unknown> {
  const generation = numberValue(subject as unknown as Record<string, unknown>, 'generation')
  const requestId = stringValue(subject as unknown as Record<string, unknown>, 'requestId', 'request_id')
  const conversationId = stringValue(subject as unknown as Record<string, unknown>, 'conversationId', 'conversation_id', 'sessionId', 'session_id')
  const correlationId = stringValue(subject as unknown as Record<string, unknown>, 'correlationId', 'correlation_id') ?? requestId
  const accumulatedText = stringValue(subject as unknown as Record<string, unknown>, 'accumulatedText', 'accumulated_text')
  const transcript = stringValue(subject as unknown as Record<string, unknown>, 'transcript', 'userText', 'user_text', 'inputText', 'input_text')
  const persistenceErrorCode = stringValue(subject as unknown as Record<string, unknown>, 'persistenceErrorCode', 'persistence_error_code')
  const payload: Record<string, unknown> = {
    generation,
    requestId,
    conversationId,
    sessionId: conversationId,
    correlationId,
    accumulatedText,
    assistantText: accumulatedText,
    transcript,
    text: accumulatedText,
    status: subject.status,
    terminal: subject.terminal,
    persisted: subject.persisted ?? null,
    persistenceErrorCode,
    subject: subject.subject,
    updatedAt: subject.updatedAt ?? subject.updated_at ?? null
  }
  return {
    id: `native:snapshot:${subject.subject}`,
    kind: subject.kind,
    topic: 'Voice.Turn',
    method: null,
    busTopic: 'Voice.Turn',
    payload,
    audit: auditForNativeAssistantSubject(correlationId, subject.kind),
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'transport',
      warnings: []
    },
    receivedAt: subject.updatedAt ?? subject.updated_at ?? new Date().toISOString()
  }
}

export function isNativeAssistantSubjectSnapshot(value: unknown): value is NativeAssistantSubjectSnapshot {
  if (!isRecord(value)) return false
  return typeof value.subject === 'string'
    && typeof value.kind === 'string'
    && typeof value.status === 'string'
    && typeof value.terminal === 'boolean'
}

function auditForNativeAssistantSubject(correlationId: string | null, kind: string): AuditReceipt {
  return {
    correlationId,
    eventKind: kind,
    peerId: null,
    principalId: null,
    targetPeerId: null,
    method: null,
    busTopic: 'Voice.Turn',
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'native',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'transport',
      warnings: []
    }
  }
}

export function nativeAssistantEventIdentity(event: AuroraEvent<unknown>): NativeAssistantTurnIdentity | null {
  const payload = eventPayloadRecord(event)
  const body = assistantBodyRecord(payload)
  const generation = numberValue(payload, 'generation', 'generationId', 'generation_id') ?? numberValue(body, 'generation', 'generationId', 'generation_id')
  const requestId = stringValue(payload, 'requestId', 'request_id') ?? stringValue(body, 'requestId', 'request_id')
  const conversationId = stringValue(payload, 'conversationId', 'conversation_id', 'sessionId', 'session_id')
    ?? stringValue(body, 'conversationId', 'conversation_id', 'sessionId', 'session_id')
  const correlationId = event.audit.correlationId
    ?? stringValue(payload, 'correlationId', 'correlation_id')
    ?? stringValue(body, 'correlationId', 'correlation_id')
  const transcript = trimmedStringValue(payload, 'transcript', 'userText', 'user_text', 'inputText', 'input_text')
    ?? trimmedStringValue(body, 'transcript', 'userText', 'user_text', 'inputText', 'input_text')
  const key = generation !== null
    ? `generation:${generation}`
    : requestId
      ? `request:${requestId}`
      : correlationId
        ? `correlation:${correlationId}`
        : event.id
          ? `event:${event.id}`
          : null
  return key ? { key, generation, requestId, conversationId, transcript } : null
}

export function nativeAssistantEventPersisted(event: AuroraEvent<unknown>): boolean {
  const payload = eventPayloadRecord(event)
  return booleanValue(payload, 'persisted') === true
}

export function nativeAssistantEventPersistenceErrorCode(event: AuroraEvent<unknown>): string | null {
  return stringValue(eventPayloadRecord(event), 'persistenceErrorCode', 'persistence_error_code')
}

export function nativeAssistantEventToStreamUpdate(event: AuroraEvent<unknown>): AssistantStreamUpdate | null {
  if (event.kind.startsWith('tts.')) return null
  const payload = eventPayloadRecord(event)
  const body = assistantBodyRecord(payload)
  const identity = nativeAssistantEventIdentity(event)
  const metadata = metadataFromEvent(event, payload)
  const requestId = identity?.requestId ?? null
  const base = {
    eventId: event.id,
    messageId: stringValue(payload, 'messageId', 'message_id') ?? stringValue(body, 'messageId', 'message_id'),
    sessionId: identity?.conversationId ?? stringValue(payload, 'sessionId', 'session_id') ?? stringValue(body, 'sessionId', 'session_id'),
    modelLabel: stringValue(payload, 'modelLabel', 'model_label') ?? stringValue(body, 'modelLabel', 'model_label'),
    requestId,
    audit: event.audit,
    metadata,
    tool: null,
    ttsAudio: null
  }
  if (event.kind === 'assistant.delta') {
    const delta = stringValue(body, 'textDelta', 'text_delta', 'delta', 'contentDelta', 'content_delta') ?? stringValue(body, 'text', 'content') ?? ''
    return {
      ...base,
      kind: 'delta',
      text: stringValue(body, 'text', 'content') ?? delta,
      textDelta: delta,
      error: null
    }
  }
  if (event.kind === 'assistant.completed') {
    const text = stringValue(body, 'assistantText', 'assistant_text', 'accumulatedText', 'accumulated_text', 'text', 'content', 'finalText', 'final_text') ?? ''
    return {
      ...base,
      kind: 'completed',
      text,
      textDelta: '',
      error: null
    }
  }
  if (event.kind === 'assistant.failed') {
    const text = stringValue(body, 'errorMessage', 'error_message', 'reasonCode', 'reason_code', 'code', 'text', 'message') ?? 'Aurora could not complete a response.'
    return {
      ...base,
      kind: 'failed',
      text,
      textDelta: '',
      error: new Error(text) as AuroraError
    }
  }
  if (event.kind === 'assistant.tool' || event.kind.startsWith('tool.')) {
    const status = toolStatusFromNativeKind(event.kind, stringValue(body, 'status'))
    const name = stringValue(body, 'name', 'toolName', 'tool_name') ?? 'tool.requested'
    return {
      ...base,
      kind: 'tool',
      text: stringValue(body, 'summary', 'text') ?? '',
      textDelta: '',
      error: status === 'failed' ? new Error(stringValue(body, 'error', 'errorMessage', 'error_message') ?? 'Tool failed.') as AuroraError : null,
      tool: {
        id: stringValue(body, 'id', 'toolId', 'tool_id', 'toolCallId', 'tool_call_id') ?? event.id ?? `${name}-${status}`,
        name,
        status,
        riskClass: stringValue(body, 'riskClass', 'risk_class'),
        target: stringValue(body, 'target', 'provider'),
        dataLeavesDevice: booleanValue(body, 'dataLeavesDevice', 'data_leaves_device'),
        summary: stringValue(body, 'summary', 'text'),
        payloadPreview: objectValue(body, 'payloadPreview', 'payload_preview', 'redactedArgsPreview', 'redacted_args_preview'),
        resultPreview: objectOrStringValue(body, 'resultPreview', 'result_preview'),
        error: stringValue(body, 'error', 'errorMessage', 'error_message'),
        errorDetails: objectOrStringValue(body, 'errorDetails', 'error_details'),
        pendingId: stringValue(body, 'pendingId', 'pending_id'),
        approvalRequestId: stringValue(body, 'approvalRequestId', 'approval_request_id'),
        approvalExpiresAt: numberValue(body, 'approvalExpiresAt', 'approval_expires_at'),
        policyDecisionId: stringValue(body, 'policyDecisionId', 'policy_decision_id')
      }
    }
  }
  return null
}

export function nativeAssistantLifecycleMessage(event: AuroraEvent<unknown>): string | null {
  switch (event.kind) {
    case 'voice.turn.started':
    case 'voice.turn.transcribing':
      return 'Aurora is listening.'
    case 'voice.turn.requesting':
      return 'Aurora is responding.'
    case 'voice.turn.speaking':
      return 'Aurora is speaking.'
    case 'voice.turn.finalized':
      return 'Aurora finished responding.'
    case 'voice.turn.failed':
      return 'Aurora could not complete the voice request.'
    default:
      return null
  }
}

export function isNativeAssistantTerminalEvent(event: AuroraEvent<unknown>): boolean {
  return event.kind === 'assistant.completed'
    || event.kind === 'assistant.failed'
    || event.kind === 'voice.turn.finalized'
    || event.kind === 'voice.turn.failed'
}

function metadataFromEvent(event: AuroraEvent<unknown>, payload: Record<string, unknown>): JsonObject {
  const body = assistantBodyRecord(payload)
  const payloadMetadata = objectValue(payload, 'metadata')
  return {
    ...(payloadMetadata ?? {}),
    native_event_kind: event.kind,
    native_generation: numberValue(payload, 'generation', 'generationId', 'generation_id') ?? numberValue(body, 'generation', 'generationId', 'generation_id') ?? undefined,
    native_persistence_error_code: stringValue(payload, 'persistenceErrorCode', 'persistence_error_code') ?? undefined
  }
}

function toolStatusFromNativeKind(kind: string, payloadStatus: string | null): 'requested' | 'running' | 'completed' | 'failed' | 'requires_action' {
  if (payloadStatus === 'requested' || payloadStatus === 'running' || payloadStatus === 'completed' || payloadStatus === 'failed' || payloadStatus === 'requires_action') {
    return payloadStatus
  }
  if (kind === 'tool.completed') return 'completed'
  if (kind === 'tool.failed') return 'failed'
  if (kind === 'tool.running') return 'running'
  if (kind === 'tool.requires_action') return 'requires_action'
  return 'requested'
}

function eventPayloadRecord(event: AuroraEvent<unknown>): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {}
}

function assistantBodyRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return objectValue(payload, 'observation', 'result', 'error') ?? payload
}

function stringValue(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function trimmedStringValue(source: Record<string, unknown>, ...keys: string[]): string | null {
  const value = stringValue(source, ...keys)?.trim()
  return value ? value : null
}

function numberValue(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
    if (typeof value === 'string') {
      const numeric = Number(value)
      if (Number.isSafeInteger(numeric)) return numeric
    }
  }
  return null
}

function booleanValue(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

function objectValue(source: Record<string, unknown>, ...keys: string[]): JsonObject | null {
  for (const key of keys) {
    const value = source[key]
    if (isJsonObject(value)) return value
  }
  return null
}

function objectOrStringValue(source: Record<string, unknown>, ...keys: string[]): JsonObject | string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') return value
    if (isJsonObject(value)) return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false
  return Object.values(value).every((item) => (
    item === null
    || typeof item === 'string'
    || typeof item === 'number'
    || typeof item === 'boolean'
    || Array.isArray(item)
    || isRecord(item)
  ))
}
