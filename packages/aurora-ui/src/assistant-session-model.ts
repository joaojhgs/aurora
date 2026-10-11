import type { AssistantStreamUpdate, AuroraErrorCode } from '@aurora/client'
import type { LightweightConfirmationEvent } from '@aurora/client/lightweight-orchestrator'
import { selectAssistantStreamingText, useAssistantStreamStore } from './state/assistant-stream-store'

export const ASSISTANT_RESPONDING_TEXT = 'Aurora is preparing a response.'
export const ASSISTANT_RECONNECTING_TEXT = 'Aurora is reconnecting to the response.'

export function isAssistantPendingText(value: string): boolean {
  return value === ASSISTANT_RESPONDING_TEXT || value === ASSISTANT_RECONNECTING_TEXT
}

export type AssistantUiMessageStatus = 'sent' | 'sending' | 'streaming' | 'failed' | 'cancelled'

const AURORA_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth', 'permission', 'validation', 'timeout', 'unavailable_service',
  'unsupported_feature', 'privacy_blocked', 'native_permission_missing',
  'transport_loss', 'unknown',
])

export function isAuroraErrorCode(value: unknown): value is AuroraErrorCode {
  return typeof value === 'string' && AURORA_ERROR_CODES.has(value)
}

export interface AssistantToolCallCard {
  id: string
  name: string
  sessionId?: string | null | undefined
  status: 'requested' | 'running' | 'completed' | 'failed' | 'requires_action'
  riskClass: string
  target: string
  dataLeavesDevice: boolean
  summary: string
  auditId: string | null
  payloadPreview: Record<string, unknown> | null
  resultPreview?: Record<string, unknown> | string | null | undefined
  error?: string | null | undefined
  errorDetails?: Record<string, unknown> | string | null | undefined
  pendingId?: string | null | undefined
  approvalRequestId?: string | null | undefined
  approvalExpiresAt?: number | null | undefined
  policyDecisionId?: string | null | undefined
  localConfirmationToken?: string | null | undefined
  resolving?: boolean | undefined
}

export interface AssistantUiMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  createdAt: string
  status: AssistantUiMessageStatus
  error?: string | undefined
  errorCode?: AuroraErrorCode | undefined
  toolCalls?: AssistantToolCallCard[] | undefined
  sources?: string[] | undefined
  modelLabel?: string | null | undefined
  providerLabel?: string | null | undefined
  routeLabel?: string | null | undefined
  executionPeerId?: string | null | undefined
}

export type AssistantApprovalGrantScope = 'once' | 'session' | 'until_expiry' | 'always' | 'deny_once' | 'deny_always'

export interface AssistantSessionSnapshot {
  sessionId: string | null
  messages: AssistantUiMessage[]
}

export function isAssistantStreamHardTerminal(update: Pick<AssistantStreamUpdate, 'kind'>): boolean {
  return update.kind === 'failed' || update.kind === 'fallback' || update.kind === 'transport_lost'
}

export function applyAssistantStreamDelta(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  if (!update.textDelta) return message
  const currentText = isAssistantPendingText(message.text) ? '' : message.text
  return {
    ...message,
    text: `${currentText}${update.textDelta}`,
    status: 'streaming',
    modelLabel: update.modelLabel ?? message.modelLabel,
    providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? message.providerLabel
  }
}


export function assistantMessageWithStreamingText(
  message: AssistantUiMessage,
  messageId: string,
  scopeId: string
): AssistantUiMessage {
  const streamingText = selectAssistantStreamingText(messageId, scopeId)(useAssistantStreamStore.getState())
  return streamingText === null ? message : { ...message, text: streamingText }
}

export function applyAssistantToolUpdate(
  message: AssistantUiMessage,
  update: AssistantStreamUpdate,
  placeholder = ASSISTANT_RESPONDING_TEXT
): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  const toolCall = assistantToolCallFromUpdate(update)
  return {
    ...message,
    text: message.text.trim() && !isAssistantPendingText(message.text) && message.text !== placeholder
      ? message.text
      : toolCall.status === 'requires_action'
        ? 'Aurora paused for a tool approval decision.'
        : `Aurora is ${toolCall.status === 'failed' ? 'reporting a tool error' : toolCall.status === 'completed' ? 'finished using a tool' : 'using a tool'}.`,
    toolCalls: upsertAssistantToolCall(message.toolCalls, toolCall)
  }
}

export function applyAssistantAudioChunkUpdate(message: AssistantUiMessage, _update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  if (!hasSubstantiveAssistantText(message)) return message
  return { ...message, status: 'sent' }
}

export function applyAssistantTerminalUpdate(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  const terminalText = update.text.trim() || !hasSubstantiveAssistantText(message)
    ? update.text
    : message.text
  return {
    ...message,
    id: message.id,
    role: 'assistant',
    text: terminalText,
    createdAt: message.createdAt,
    status: 'sent',
    modelLabel: update.modelLabel ?? message.modelLabel,
    providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? message.providerLabel,
    routeLabel: message.routeLabel,
    toolCalls: message.toolCalls
  }
}

export function assistantToolCallFromUpdate(update: AssistantStreamUpdate): AssistantToolCallCard {
  const metadata = update.metadata ?? {}
  const tool = update.tool
  const structuredTool = tool as (typeof tool & { errorDetails?: Record<string, unknown> | string | null }) | null
  const name = tool?.name
    ?? metadataStringValue(metadata, 'tool_name')
    ?? metadataStringValue(metadata, 'toolName')
    ?? metadataStringValue(metadata, 'name')
    ?? 'tool.requested'
  const status = toolStatusFromUpdate(update)
  return {
    id: tool?.id ?? update.eventId ?? `${name}-${Date.now()}`,
    name,
    sessionId: update.sessionId,
    status,
    riskClass: tool?.riskClass ?? metadataStringValue(metadata, 'risk_class') ?? metadataStringValue(metadata, 'riskClass') ?? 'backend-evaluated',
    target: tool?.target ?? metadataStringValue(metadata, 'target') ?? metadataStringValue(metadata, 'provider') ?? 'Aurora tool provider',
    dataLeavesDevice: tool?.dataLeavesDevice ?? metadataBooleanValue(metadata, 'data_leaves_device') ?? metadataBooleanValue(metadata, 'dataLeavesDevice') ?? false,
    summary: tool?.summary ?? (update.text || metadataStringValue(metadata, 'summary') || toolSummaryForStatus(status)),
    auditId: update.audit.correlationId ?? null,
    payloadPreview: tool?.payloadPreview
      ?? metadataObjectValue(metadata, 'payload_preview')
      ?? metadataObjectValue(metadata, 'payloadPreview')
      ?? metadataObjectValue(metadata, 'redacted_args_preview')
      ?? metadataObjectValue(metadata, 'argsPreview'),
    resultPreview: tool?.resultPreview ?? metadataObjectValue(metadata, 'result_preview') ?? metadataObjectValue(metadata, 'resultPreview') ?? metadataStringValue(metadata, 'result_preview') ?? metadataStringValue(metadata, 'resultPreview'),
    error: tool?.error ?? metadataStringValue(metadata, 'error') ?? null,
    errorDetails: structuredTool?.errorDetails
      ?? metadataObjectValue(metadata, 'error_details')
      ?? metadataObjectValue(metadata, 'errorDetails')
      ?? metadataStringValue(metadata, 'error_details')
      ?? metadataStringValue(metadata, 'errorDetails'),
    pendingId: tool?.pendingId ?? metadataStringValue(metadata, 'pending_id') ?? metadataStringValue(metadata, 'pendingId') ?? null,
    approvalRequestId: tool?.approvalRequestId ?? metadataStringValue(metadata, 'approval_request_id') ?? metadataStringValue(metadata, 'approvalRequestId') ?? null,
    approvalExpiresAt: typeof tool?.approvalExpiresAt === 'number'
      ? tool.approvalExpiresAt
      : metadataNumberValue(metadata, 'approval_expires_at') ?? metadataNumberValue(metadata, 'approvalExpiresAt') ?? null,
    policyDecisionId: tool?.policyDecisionId ?? metadataStringValue(metadata, 'policy_decision_id') ?? metadataStringValue(metadata, 'policyDecisionId') ?? null
  }
}


export function lightweightConfirmationToolCard(
  confirmation: LightweightConfirmationEvent
): AssistantToolCallCard {
  const prepared = confirmation.prepared
  const toolCall = confirmation.toolCall
  return {
    id: toolCall.id,
    name: prepared.global_tool_id || toolCall.toolName,
    sessionId: confirmation.conversationId,
    status: 'requires_action',
    riskClass: prepared.trust_tier ?? prepared.capability_class ?? 'review required',
    target: toolCall.route === 'local' ? 'This device' : 'Connected Aurora device',
    dataLeavesDevice: toolCall.route === 'remote',
    summary: 'Review this action before Aurora continues.',
    auditId: prepared.correlation_id ?? null,
    payloadPreview: null,
    resultPreview: null,
    error: null,
    pendingId: null,
    approvalRequestId: null,
    approvalExpiresAt: null,
    policyDecisionId: prepared.policy_decision.decision_id ?? null,
    localConfirmationToken: confirmation.token
  }
}

export function upsertAssistantToolCall(
  current: AssistantToolCallCard[] | undefined,
  next: AssistantToolCallCard
): AssistantToolCallCard[] {
  const existing = current ?? []
  const index = existing.findIndex((tool) => tool.id === next.id)
  if (index === -1) return [...existing, next]
  return existing.map((tool, currentIndex) => currentIndex === index ? mergeAssistantToolCall(tool, next) : tool)
}

export function mergeAssistantToolCall(current: AssistantToolCallCard, next: AssistantToolCallCard): AssistantToolCallCard {
  return {
    ...current,
    ...next,
    sessionId: next.sessionId ?? current.sessionId ?? null,
    riskClass: next.riskClass || current.riskClass,
    target: next.target || current.target,
    summary: next.summary || current.summary,
    auditId: next.auditId ?? current.auditId,
    payloadPreview: next.payloadPreview ?? current.payloadPreview,
    resultPreview: next.resultPreview ?? current.resultPreview ?? null,
    error: next.error ?? current.error ?? null,
    errorDetails: next.errorDetails ?? current.errorDetails ?? null,
    pendingId: next.pendingId ?? current.pendingId ?? null,
    approvalRequestId: next.approvalRequestId ?? current.approvalRequestId ?? null,
    approvalExpiresAt: next.approvalExpiresAt ?? current.approvalExpiresAt ?? null,
    policyDecisionId: next.policyDecisionId ?? current.policyDecisionId ?? null,
    resolving: next.resolving ?? current.resolving
  }
}

export function toolSummaryForStatus(status: AssistantToolCallCard['status']): string {
  if (status === 'requires_action') return 'Aurora paused this tool call until an operator approves or denies it.'
  if (status === 'failed') return 'Tool execution failed; Aurora will continue with the available context.'
  if (status === 'completed') return 'Tool execution completed and the result was returned to Aurora.'
  if (status === 'running') return 'Tool execution is running.'
  return 'Tool call requested by Aurora.'
}

export function toolStatusFromUpdate(update: AssistantStreamUpdate): AssistantToolCallCard['status'] {
  const structuredStatus = update.tool?.status?.toLowerCase()
  if (structuredStatus === 'requested' || structuredStatus === 'running' || structuredStatus === 'completed' || structuredStatus === 'failed' || structuredStatus === 'requires_action') return structuredStatus
  const value = metadataStringValue(update.metadata ?? {}, 'status')?.toLowerCase()
  if (value === 'requested' || value === 'requires_action') return value
  if (value === 'running' || value === 'completed' || value === 'failed') return value
  if (update.text.toLowerCase().includes('completed')) return 'completed'
  if (update.text.toLowerCase().includes('failed')) return 'failed'
  return 'requested'
}

export function metadataStringValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value : null
}

export function metadataBooleanValue(metadata: Record<string, unknown>, key: string): boolean | null {
  const value = metadata[key]
  return typeof value === 'boolean' ? value : null
}

export function metadataNumberValue(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function metadataObjectValue(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function isAssistantToolCallCard(value: unknown): value is AssistantToolCallCard {
  if (typeof value !== 'object' || value === null) return false
  const tool = value as Partial<AssistantToolCallCard>
  return (
    typeof tool.id === 'string' &&
    typeof tool.name === 'string' &&
    (tool.sessionId === undefined || tool.sessionId === null || typeof tool.sessionId === 'string') &&
    (tool.status === 'requested' || tool.status === 'running' || tool.status === 'completed' || tool.status === 'failed' || tool.status === 'requires_action') &&
    typeof tool.riskClass === 'string' &&
    typeof tool.target === 'string' &&
    typeof tool.dataLeavesDevice === 'boolean' &&
    typeof tool.summary === 'string' &&
    (tool.auditId === null || typeof tool.auditId === 'string') &&
    (tool.payloadPreview === null || (typeof tool.payloadPreview === 'object' && !Array.isArray(tool.payloadPreview)))
  )
}

export function isAssistantUiMessage(value: unknown): value is AssistantUiMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<AssistantUiMessage>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool') &&
    typeof message.text === 'string' &&
    typeof message.createdAt === 'string' &&
    (message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.every(isAssistantToolCallCard))) &&
    (message.sources === undefined || (Array.isArray(message.sources) && message.sources.every((source) => typeof source === 'string'))) &&
    (message.status === 'sent' ||
      message.status === 'sending' ||
      message.status === 'streaming' ||
      message.status === 'failed' ||
      message.status === 'cancelled')
  )
}

function normalizeAssistantMessageText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function isAssistantPlaceholderText(text: string): boolean {
  return isAssistantPendingText(text.trim())
    || /^(waiting for aurora stream|replaying stream from last backend event|aurora is processing your voice request)/i.test(text.trim())
}

export function hasSubstantiveAssistantText(message: AssistantUiMessage): boolean {
  return message.role === 'assistant' && Boolean(normalizeAssistantMessageText(message.text)) && !isAssistantPlaceholderText(message.text)
}

export function isAssistantPendingWork(message: AssistantUiMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.status === 'sending') return true
  if (message.status !== 'streaming') return false
  return !hasSubstantiveAssistantText(message)
}
