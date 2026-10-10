import type { DBSessionRecord } from '@aurora/client'

import type {
  AssistantConversationRow,
  AssistantSessionSnapshot,
  AssistantUiMessage,
  AssistantUiMessageStatus
} from './assistant-view'
import type { ConversationMessageRecord } from '@aurora/client/local-data'

function sessionTypeLabel(type: string): string {
  const normalized = type.trim()
  return normalized ? `${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}` : 'Session'
}

export function formatSessionActivity(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'recently'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (elapsedSeconds < 60) return 'now'
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export function assistantConversationRows(
  session: AssistantSessionSnapshot,
  sessions: DBSessionRecord[],
  transportKind: string
): AssistantConversationRow[] {
  if (transportKind === 'mock') {
    return [
      { id: 'draft-launch', title: 'Plan a weekend trip', route: 'This device', updated: '2m ago', active: true },
      { id: 'quarterly', title: 'Summarize a reading list', route: 'Connected device', updated: '1h ago', active: false },
      { id: 'mesh-notes', title: 'Prepare a grocery list', route: 'Connected device', updated: '5h ago', active: false },
      { id: 'journal', title: 'Personal journal reflection', route: 'This device', updated: 'yesterday', active: false }
    ]
  }
  return sessions.map((record) => ({
    id: record.id,
    title: record.title?.trim() || 'New chat',
    route: sessionTypeLabel(record.type),
    updated: `${formatSessionActivity(record.updated_at)} · ${record.message_count} ${record.message_count === 1 ? 'message' : 'messages'}`,
    active: record.id === session.sessionId
  }))
}

export function updateLocalConversationRowTitle(
  rows: AssistantConversationRow[],
  conversationId: string | null,
  messages: readonly AssistantUiMessage[]
): AssistantConversationRow[] {
  if (!conversationId) return rows
  const title = localAssistantConversationTitleFromMessages(messages)
  return rows.map((row) => row.id === conversationId && row.title === 'New chat'
    ? { ...row, title }
    : row)
}

function localAssistantConversationTitleFromMessages(
  messages: readonly AssistantUiMessage[]
): string {
  const firstPrompt = messages.find((message) => message.role === 'user' && message.text.trim())
  return firstPrompt ? conciseConversationTitle(firstPrompt.text) : 'New chat'
}

export function enrichLatestLocalAssistantMessage(
  messages: AssistantUiMessage[],
  runtime: {
    text: string
    modelLabel: string
    providerLabel: string
    routeLabel: string
  }
): AssistantUiMessage[] {
  const latestAssistantIndex = messages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1
  )
  return messages.map((message, index) => index === latestAssistantIndex
    ? {
        ...message,
        text: runtime.text || message.text,
        modelLabel: runtime.modelLabel,
        providerLabel: runtime.providerLabel,
        routeLabel: runtime.routeLabel,
        executionPeerId: null
      }
    : message)
}

export function preserveActiveAssistantTurnIds(
  persistedMessages: AssistantUiMessage[],
  currentMessages: AssistantUiMessage[],
  pendingId: string
): AssistantUiMessage[] {
  const pendingIndex = currentMessages.findIndex((message) => message.id === pendingId)
  if (pendingIndex < 0) return persistedMessages
  const activeUser = currentMessages
    .slice(0, pendingIndex)
    .reverse()
    .find((message) => message.role === 'user')
  const latestAssistantIndex = persistedMessages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1
  )
  if (latestAssistantIndex < 0) return persistedMessages
  const latestUserIndex = persistedMessages.reduce(
    (latest, message, index) => index < latestAssistantIndex && message.role === 'user' ? index : latest,
    -1
  )
  return persistedMessages.map((message, index) => {
    if (index === latestAssistantIndex) return { ...message, id: pendingId }
    if (activeUser && index === latestUserIndex) return { ...message, id: activeUser.id }
    return message
  })
}

export function preserveActiveAssistantTurn(
  persistedMessages: AssistantUiMessage[],
  currentMessages: AssistantUiMessage[],
): AssistantUiMessage[] {
  const activeAssistantIndex = currentMessages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1,
  )
  const persistedAssistantIndex = persistedMessages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1,
  )
  if (activeAssistantIndex < 0) return persistedMessages
  if (persistedAssistantIndex < 0) return currentMessages
  const activeAssistant = currentMessages[activeAssistantIndex]!
  const activeUser = currentMessages.slice(0, activeAssistantIndex).reverse().find((message) => message.role === 'user')
  const persistedUser = persistedMessages.slice(0, persistedAssistantIndex).reverse().find((message) => message.role === 'user')
  if (
    !activeUser
    || !persistedUser
    || activeUser.text !== persistedUser.text
    || activeUser.createdAt !== persistedUser.createdAt
  ) return currentMessages

  const preservedMessages = preserveActiveAssistantTurnIds(persistedMessages, currentMessages, activeAssistant.id)
  return preservedMessages.map((message) => {
    if (message.role !== 'assistant' || message.id !== activeAssistant.id) return message
    const liveToolCalls = new Map(
      (activeAssistant.toolCalls ?? [])
        .filter((tool) => tool.status === 'requires_action' && tool.localConfirmationToken)
        .map((tool) => [tool.id, tool]),
    )
    if (liveToolCalls.size === 0) return message
    return {
      ...message,
      toolCalls: (message.toolCalls ?? []).map((tool) => {
        const liveTool = liveToolCalls.get(tool.id)
        return liveTool && tool.status === 'requires_action'
          ? {
              ...tool,
              localConfirmationToken: liveTool.localConfirmationToken,
              resolving: liveTool.resolving,
            }
          : tool
      }),
    }
  })
}

export function conciseConversationTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) return 'New chat'
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 61).trimEnd()}…`
}

export function localAssistantMessageStatus(
  status: ConversationMessageRecord['status']
): AssistantUiMessageStatus {
  if (status === 'complete') return 'sent'
  if (status === 'pending') return 'sending'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}
