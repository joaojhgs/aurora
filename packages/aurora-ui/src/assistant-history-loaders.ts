import {
  createLocalConversations,
  runSerializedLocalDataTransaction,
  type ConversationMessageRecord,
  type ConversationRecord
} from '@aurora/client/local-data'
import type { ConversationCursor, LocalMessageCursor } from '@aurora/client/local-data'

import type {
  AssistantConversationRow,
  AssistantToolCallCard,
  AssistantUiMessage,
  AssistantUiMessageStatus
} from './assistant-view'
import {
  isAssistantToolCallCard,
  metadataObjectValue,
  metadataStringValue,
  safeAssistantRuntimeValue,
  toolSummaryForStatus,
  upsertAssistantToolCall
} from './assistant-message'
import {
  conciseConversationTitle,
  formatSessionActivity,
  localAssistantMessageStatus
} from './assistant-history-model'
import {
  decryptLocalAssistantText,
  localAssistantMessageText,
  type LocalAssistantHistoryDependencies
} from './assistant-history-crypto'

export async function loadLocalAssistantConversationRows(
  history: LocalAssistantHistoryDependencies
): Promise<AssistantConversationRow[]> {
  const conversations = createLocalConversations(history.localData)
  const [summaries, firstUserMessages] = await Promise.all([
    conversations.listConversations({
      scope: history.scope,
      includeArchived: false,
      limit: 100
    }),
    history.localData.conversations.listFirstUserMessages()
  ])
  return await Promise.all(summaries.map(async (summary) => ({
    id: summary.record.id,
    title: await localAssistantConversationTitle(history, summary.record, firstUserMessages[summary.record.id]),
    route: 'This device',
    updated: `${formatSessionActivity(new Date(summary.record.updatedAtMs).toISOString())} · ${summary.messageCount} ${summary.messageCount === 1 ? 'message' : 'messages'}`,
    active: false
  })))
}

export interface LocalAssistantConversationRowsPage {
  readonly rows: AssistantConversationRow[]
  readonly nextCursor: ConversationCursor | null
}

export async function loadLocalAssistantConversationRowsPage(
  history: LocalAssistantHistoryDependencies,
  cursor?: ConversationCursor
): Promise<LocalAssistantConversationRowsPage> {
  const conversations = createLocalConversations(history.localData)
  const page = await conversations.listConversationsPage({ scope: history.scope, includeArchived: false, limit: 25, ...(cursor === undefined ? {} : { cursor }) })
  const firstUserMessages = await history.localData.conversations.listFirstUserMessages(page.items.map(({ record }) => record.id))
  const rows = await Promise.all(page.items.map(async (summary) => ({
    id: summary.record.id,
    title: await localAssistantConversationTitle(history, summary.record, firstUserMessages[summary.record.id]),
    route: 'This device',
    updated: `${formatSessionActivity(new Date(summary.record.updatedAtMs).toISOString())} · ${summary.messageCount} ${summary.messageCount === 1 ? 'message' : 'messages'}`,
    active: false
  })))
  return { rows, nextCursor: page.nextCursor }
}

export async function loadLocalAssistantConversationRow(
  history: LocalAssistantHistoryDependencies,
  conversationId: string,
): Promise<AssistantConversationRow | null> {
  const record = await history.localData.conversations.getConversation(conversationId)
  if (!record || record.archivedAtMs !== null || record.profileId !== history.scope.profileId || record.localNodeId !== history.scope.localNodeId) return null
  const [counts, firstUserMessages] = await Promise.all([
    history.localData.conversations.listMessageCounts([conversationId]),
    history.localData.conversations.listFirstUserMessages([conversationId]),
  ])
  const count = counts[conversationId] ?? 0
  return {
    id: record.id,
    title: await localAssistantConversationTitle(history, record, firstUserMessages[conversationId]),
    route: 'This device',
    updated: `${formatSessionActivity(new Date(record.updatedAtMs).toISOString())} · ${count} ${count === 1 ? 'message' : 'messages'}`,
    active: false,
  }
}

export async function activateLocalAssistantConversation(
  history: LocalAssistantHistoryDependencies,
  conversationId: string
): Promise<void> {
  await runSerializedLocalDataTransaction(history.localData, async (repositories) => {
    const conversation = await repositories.conversations.getConversation(conversationId)
    if (!conversation || conversation.archivedAtMs !== null) {
      throw new Error('Local conversation is unavailable.')
    }
    if (
      conversation.profileId !== history.scope.profileId
      || conversation.localNodeId !== history.scope.localNodeId
    ) {
      throw new Error('Local conversation belongs to a different profile.')
    }
    const latestSummary = (await repositories.conversations.listConversations({
      includeArchived: false,
      limit: 1
    }))[0]
    const updatedAtMs = Math.max(
      Date.now(),
      conversation.updatedAtMs + 1,
      (latestSummary?.updatedAtMs ?? conversation.updatedAtMs) + 1
    )
    if (!Number.isSafeInteger(updatedAtMs)) throw new Error('Local conversation timestamp is out of range.')
    await repositories.conversations.upsertConversation({
      ...conversation,
      updatedAtMs
    })
  })
}

async function localAssistantConversationTitle(
  history: LocalAssistantHistoryDependencies,
  record: ConversationRecord,
  firstUserMessage?: ConversationMessageRecord
): Promise<string> {
  if (record.titleEnvelope) {
    const title = await decryptLocalAssistantText(history, {
      envelope: record.titleEnvelope,
      table: 'aurora_conversations',
      recordId: record.id,
      field: 'title_envelope_json'
    })
    if (title.trim()) return conciseConversationTitle(title)
  }
  if (firstUserMessage?.contentEnvelope) {
    const prompt = await decryptLocalAssistantText(history, {
      envelope: firstUserMessage.contentEnvelope,
      table: 'aurora_messages',
      recordId: firstUserMessage.id,
      field: 'content_envelope_json'
    })
    if (prompt.trim()) return conciseConversationTitle(prompt)
  }
  return 'New chat'
}

export async function loadLocalAssistantConversationMessages(
  history: LocalAssistantHistoryDependencies,
  conversationId: string
): Promise<AssistantUiMessage[]> {
  const conversations = createLocalConversations(history.localData)
  const records = await conversations.listMessages({ scope: history.scope, conversationId, limit: 2_000 })
  return await assistantMessagesFromLocalRecords(history, records)
}

export interface LocalAssistantConversationMessagesPage {
  readonly records: ConversationMessageRecord[]
  readonly messages: AssistantUiMessage[]
  readonly nextCursor: LocalMessageCursor | null
}

export async function loadLocalAssistantConversationMessagesPage(
  history: LocalAssistantHistoryDependencies,
  conversationId: string,
  cursor?: LocalMessageCursor
): Promise<LocalAssistantConversationMessagesPage> {
  const conversations = createLocalConversations(history.localData)
  const page = await conversations.listMessagesPage({
    scope: history.scope,
    conversationId,
    limit: 50,
    ...(cursor === undefined
      ? { direction: 'desc' as const }
      : cursor.direction === 'asc'
        ? { direction: 'asc' as const, afterSequence: cursor.afterSequence }
        : { direction: 'desc' as const, beforeSequence: cursor.beforeSequence })
  })
  return { records: page.items, messages: await assistantMessagesFromLocalRecords(history, page.items), nextCursor: page.nextCursor }
}

export async function assistantMessagesFromLocalRecords(
  history: LocalAssistantHistoryDependencies,
  records: ConversationMessageRecord[]
): Promise<AssistantUiMessage[]> {
  const messages: AssistantUiMessage[] = []
  let pendingToolCards: AssistantToolCallCard[] = []
  let pendingToolCreatedAt: string | null = null
  let pendingToolStatus: AssistantUiMessageStatus = 'sent'
  for (const record of records) {
    if (record.role === 'tool') {
      const tool = await localAssistantToolCallCard(history, record)
      pendingToolCards = upsertAssistantToolCall(pendingToolCards, tool)
      pendingToolCreatedAt = new Date(record.createdAtMs).toISOString()
      pendingToolStatus = localAssistantMessageStatus(record.status)
      continue
    }
    const runtime = record.role === 'assistant'
      ? await localAssistantMessageRuntime(history, record)
      : null
    const message: AssistantUiMessage = {
      id: record.id,
      role: record.role,
      text: await localAssistantMessageText(history, record),
      createdAt: new Date(record.createdAtMs).toISOString(),
      status: localAssistantMessageStatus(record.status),
      routeLabel: runtime?.routeLabel ?? 'This device',
      executionPeerId: runtime?.executionPeerId ?? null,
      modelLabel: runtime?.modelLabel ?? null,
      providerLabel: runtime?.providerLabel ?? null
    }
    if (record.role === 'assistant' && pendingToolCards.length > 0) {
      message.toolCalls = pendingToolCards
      pendingToolCards = []
      pendingToolCreatedAt = null
      pendingToolStatus = 'sent'
    }
    messages.push(message)
  }
  if (pendingToolCards.length > 0) {
    messages.push({
      id: `local-tool-${pendingToolCards.map((tool) => tool.id).join('-')}`,
      role: 'assistant',
      text: '',
      createdAt: pendingToolCreatedAt ?? new Date().toISOString(),
      status: pendingToolStatus,
      toolCalls: pendingToolCards,
      routeLabel: 'This device',
      executionPeerId: null
    })
  }
  return messages
}

export function mergeLocalAssistantMessageRecords(
  current: ConversationMessageRecord[],
  incoming: ConversationMessageRecord[],
): ConversationMessageRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

async function localAssistantMessageRuntime(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord
): Promise<Pick<AssistantUiMessage, 'routeLabel' | 'executionPeerId' | 'modelLabel' | 'providerLabel'> | null> {
  if (record.role !== 'assistant' || !record.toolEnvelope) return null
  let payload: Record<string, unknown>
  try {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope: record.toolEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'tool_envelope_json'
    })
    const parsed: unknown = JSON.parse(plaintext)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const runtime = metadataObjectValue(payload, 'assistantRuntime')
  if (!runtime) return null
  return {
    routeLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'routeLabel'), null),
    executionPeerId: metadataStringValue(runtime, 'executionPeerId'),
    modelLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'modelLabel'), null),
    providerLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'providerLabel'), null)
  }
}

async function localAssistantToolCallCard(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord
): Promise<AssistantToolCallCard> {
  let payload: Record<string, unknown> = {}
  if (record.toolEnvelope) {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope: record.toolEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'tool_envelope_json'
    })
    try {
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      payload = {}
    }
  }
  const persistedCard = metadataObjectValue(payload, 'assistantToolCall')
  if (persistedCard && isAssistantToolCallCard(persistedCard)) {
    return {
      ...persistedCard,
      sessionId: record.conversationId,
      localConfirmationToken: null,
      resolving: false
    }
  }
  const toolCall = metadataObjectValue(payload, 'toolCall') ?? {}
  const route = metadataStringValue(toolCall, 'route')
  const data = payload.data
  const resultPreview = typeof data === 'string'
    ? data
    : typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : data === null || data === undefined
        ? null
        : 'Saved with this chat'
  const status = localAssistantToolCardStatus(record.status)
  const errorCode = metadataStringValue(payload, 'errorCode')
  return {
    id: metadataStringValue(toolCall, 'id') ?? record.id,
    name: metadataStringValue(payload, 'globalToolId')
      ?? metadataStringValue(toolCall, 'toolName')
      ?? 'assistant-action',
    sessionId: record.conversationId,
    status,
    riskClass: 'reviewed',
    target: route === 'remote' ? 'Connected Aurora device' : 'This device',
    dataLeavesDevice: route === 'remote',
    summary: toolSummaryForStatus(status),
    auditId: metadataStringValue(payload, 'correlationId'),
    payloadPreview: metadataObjectValue(toolCall, 'arguments'),
    resultPreview,
    error: status === 'failed' ? errorCode ?? 'action_incomplete' : null,
    errorDetails: null,
    pendingId: null,
    approvalRequestId: null,
    approvalExpiresAt: null,
    policyDecisionId: null
  }
}

function localAssistantToolCardStatus(
  status: ConversationMessageRecord['status']
): AssistantToolCallCard['status'] {
  if (status === 'pending') return 'requires_action'
  if (status === 'complete') return 'completed'
  return 'failed'
}
