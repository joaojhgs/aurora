import type { DBGetSessionResponse, DBSessionRecord } from '@aurora/client'

import {
  isAssistantUiMessage,
  metadataBooleanValue,
  metadataNumberValue,
  metadataObjectValue,
  metadataStringValue,
  toolSummaryForStatus,
  type AssistantSessionSnapshot,
  type AssistantToolCallCard,
  type AssistantUiMessage,
} from './assistant-session-model'

export {
  ASSISTANT_RECONNECTING_TEXT,
  ASSISTANT_RESPONDING_TEXT,
  applyAssistantAudioChunkUpdate,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  assistantMessageWithStreamingText,
  assistantToolCallFromUpdate,
  hasSubstantiveAssistantText,
  isAssistantPendingText,
  isAssistantPendingWork,
  isAssistantPlaceholderText,
  isAssistantStreamHardTerminal,
  isAssistantToolCallCard,
  isAssistantUiMessage,
  lightweightConfirmationToolCard,
  mergeAssistantToolCall,
  metadataBooleanValue,
  metadataNumberValue,
  metadataObjectValue,
  metadataStringValue,
  toolStatusFromUpdate,
  toolSummaryForStatus,
  upsertAssistantToolCall,
} from './assistant-session-model'
export type {
  AssistantApprovalGrantScope,
  AssistantSessionSnapshot,
  AssistantToolCallCard,
  AssistantUiMessage,
  AssistantUiMessageStatus,
} from './assistant-session-model'

export function emptyAssistantSession(): AssistantSessionSnapshot {
  return { sessionId: null, messages: [] }
}

export function assistantSessionFromPersisted(
  response: DBGetSessionResponse
): AssistantSessionSnapshot {
  return {
    sessionId: response.session.id,
    messages: response.messages.map(assistantUiMessageFromPersisted)
  }
}

export function assistantUiMessageFromPersisted(
  message: Record<string, unknown>,
  index: number
): AssistantUiMessage {
  const role = message.role === 'assistant' || message.role === 'system' || message.role === 'tool'
    ? message.role
    : 'user'
  const createdAt = typeof message.timestamp === 'string'
    ? message.timestamp
    : typeof message.created_at === 'string'
      ? message.created_at
      : new Date(0).toISOString()
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {}
  const executionPeerId = metadataStringValue(metadata, 'execution_peer_id')
    ?? (
      metadata.dispatch_selector
      && typeof metadata.dispatch_selector === 'object'
      && !Array.isArray(metadata.dispatch_selector)
        ? metadataStringValue(metadata.dispatch_selector as Record<string, unknown>, 'peer_id')
        : null
    )
  const execution = metadataStringValue(metadata, 'execution')
  const executionPeerName = metadataStringValue(metadata, 'execution_peer_name')
  const uiMessage: AssistantUiMessage = {
    id: typeof message.id === 'string' ? message.id : `persisted-message-${index}`,
    role,
    text: typeof message.content === 'string'
      ? message.content
      : typeof message.text === 'string'
        ? message.text
        : '',
    createdAt,
    status: 'sent',
    modelLabel: metadataStringValue(metadata, 'model'),
    providerLabel: metadataStringValue(metadata, 'provider_label') ?? metadataStringValue(metadata, 'provider'),
    routeLabel: execution === 'local' ? 'Local' : executionPeerName,
    executionPeerId
  }
  if (role === 'tool') {
    uiMessage.toolCalls = [assistantToolCallFromPersisted(message, metadata, uiMessage)]
  }
  return uiMessage
}

export function assistantToolCallFromPersisted(
  message: Record<string, unknown>,
  metadata: Record<string, unknown>,
  uiMessage: AssistantUiMessage
): AssistantToolCallCard {
  const tool = metadataObjectValue(metadata, 'tool')
    ?? metadataObjectValue(metadata, 'tool_call')
    ?? metadataObjectValue(metadata, 'toolCall')
    ?? metadata
  const status = persistedToolStatus(
    metadataStringValue(tool, 'status')
      ?? metadataStringValue(metadata, 'status')
      ?? metadataStringValue(message, 'status')
  )
  const name = metadataStringValue(tool, 'name')
    ?? metadataStringValue(tool, 'tool_name')
    ?? metadataStringValue(tool, 'toolName')
    ?? metadataStringValue(tool, 'global_tool_id')
    ?? metadataStringValue(metadata, 'global_tool_id')
    ?? metadataStringValue(message, 'tool_name')
    ?? 'assistant-action'
  const route = metadataStringValue(metadata, 'execution') ?? metadataStringValue(tool, 'route')
  const dataLeavesDevice = metadataBooleanValue(tool, 'data_leaves_device')
    ?? metadataBooleanValue(tool, 'dataLeavesDevice')
    ?? route === 'remote'
  return {
    id: metadataStringValue(tool, 'id')
      ?? metadataStringValue(tool, 'tool_call_id')
      ?? metadataStringValue(tool, 'toolCallId')
      ?? metadataStringValue(message, 'tool_call_id')
      ?? uiMessage.id,
    name,
    sessionId: metadataStringValue(metadata, 'session_id') ?? metadataStringValue(message, 'session_id'),
    status,
    riskClass: metadataStringValue(tool, 'risk_class')
      ?? metadataStringValue(tool, 'riskClass')
      ?? metadataStringValue(metadata, 'risk_class')
      ?? 'reviewed',
    target: metadataStringValue(tool, 'target')
      ?? metadataStringValue(metadata, 'execution_peer_name')
      ?? (dataLeavesDevice ? 'Connected Aurora device' : 'This device'),
    dataLeavesDevice,
    summary: metadataStringValue(tool, 'summary')
      ?? (uiMessage.text.trim() ? uiMessage.text : toolSummaryForStatus(status)),
    auditId: metadataStringValue(metadata, 'correlation_id')
      ?? metadataStringValue(metadata, 'correlationId')
      ?? metadataStringValue(message, 'correlation_id'),
    payloadPreview: metadataObjectValue(tool, 'payload_preview')
      ?? metadataObjectValue(tool, 'payloadPreview')
      ?? metadataObjectValue(tool, 'arguments')
      ?? metadataObjectValue(metadata, 'payload_preview'),
    resultPreview: metadataObjectValue(tool, 'result_preview')
      ?? metadataObjectValue(tool, 'resultPreview')
      ?? metadataStringValue(tool, 'result_preview')
      ?? metadataStringValue(tool, 'resultPreview')
      ?? (status === 'completed' && uiMessage.text.trim() ? 'Result details saved with the conversation.' : null),
    error: status === 'failed'
      ? metadataStringValue(tool, 'error') ?? metadataStringValue(metadata, 'error') ?? 'action_incomplete'
      : null,
    errorDetails: metadataObjectValue(tool, 'error_details')
      ?? metadataObjectValue(tool, 'errorDetails')
      ?? metadataStringValue(tool, 'error_details')
      ?? metadataStringValue(tool, 'errorDetails'),
    pendingId: metadataStringValue(tool, 'pending_id')
      ?? metadataStringValue(tool, 'pendingId')
      ?? metadataStringValue(metadata, 'pending_id'),
    approvalRequestId: metadataStringValue(tool, 'approval_request_id')
      ?? metadataStringValue(tool, 'approvalRequestId')
      ?? metadataStringValue(metadata, 'approval_request_id'),
    approvalExpiresAt: metadataNumberValue(tool, 'approval_expires_at')
      ?? metadataNumberValue(tool, 'approvalExpiresAt')
      ?? metadataNumberValue(metadata, 'approval_expires_at'),
    policyDecisionId: metadataStringValue(tool, 'policy_decision_id')
      ?? metadataStringValue(tool, 'policyDecisionId')
      ?? metadataStringValue(metadata, 'policy_decision_id')
  }
}

export function persistedToolStatus(value: string | null): AssistantToolCallCard['status'] {
  const normalized = value?.toLowerCase().replace(/[\s-]+/gu, '_') ?? ''
  if (normalized.includes('requires_action') || normalized.includes('approval') || normalized === 'pending') return 'requires_action'
  if (normalized.includes('running') || normalized.includes('requested')) return 'running'
  if (normalized.includes('fail') || normalized.includes('error') || normalized === 'cancelled') return 'failed'
  return 'completed'
}

export function upsertSessionByModification(
  sessions: DBSessionRecord[],
  updated: DBSessionRecord
): DBSessionRecord[] {
  return sortSessionsByModification([
    updated,
    ...sessions.filter((session) => session.id !== updated.id)
  ])
}

export function sortSessionsByModification(sessions: DBSessionRecord[]): DBSessionRecord[] {
  return [...sessions].sort((left, right) => {
    const activityDelta = sessionModificationTimestamp(right) - sessionModificationTimestamp(left)
    return activityDelta !== 0 ? activityDelta : left.id.localeCompare(right.id)
  })
}

export function sessionModificationTimestamp(session: DBSessionRecord): number {
  const updatedAt = Date.parse(session.updated_at)
  if (Number.isFinite(updatedAt)) return updatedAt
  const createdAt = Date.parse(session.created_at)
  return Number.isFinite(createdAt) ? createdAt : 0
}

export function defaultAssistantSessionForTransport(transportKind: string): AssistantSessionSnapshot {
  if (transportKind !== 'mock') return emptyAssistantSession()
  const createdAt = '2026-06-19T00:00:00Z'
  return {
    sessionId: 'Draft launch announcement',
    messages: [
      {
        id: 'demo-user-launch',
        role: 'user',
        text: 'Draft a short launch announcement for the Aurora 0.9 release.',
        createdAt,
        status: 'sent'
      },
      {
        id: 'demo-assistant-launch',
        role: 'assistant',
        text: `Here's a concise draft:

Aurora 0.9 is here. Your private assistant now runs across desktop, server, mesh and mobile with a unified operator cockpit for services, RBAC, and diagnostics. Every route is observable, every admin action is auditable, and local-first is the default.`,
        createdAt,
        status: 'sent',
        sources: ['release-notes.md', 'changelog/0.9.0']
      },
      {
        id: 'demo-user-health',
        role: 'user',
        text: 'Now check our latest deployment health and summarize any warnings.',
        createdAt,
        status: 'sent'
      },
      {
        id: 'demo-assistant-health',
        role: 'assistant',
        text: 'I can call diagnostics to read current service health. This is a read-only action on the local node.',
        createdAt,
        status: 'sent',
        toolCalls: [
          {
            id: 'demo-tool-diagnostics',
            name: 'diagnostics.serviceHealth',
            status: 'requested',
            riskClass: 'Read-only',
            target: 'Gateway',
            dataLeavesDevice: false,
            summary: 'Read current service health and warning states from the local Gateway.',
            auditId: null,
            payloadPreview: { scope: 'all-services', includeLogs: false }
          }
        ]
      }
    ]
  }
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
