import type { LightweightAssistantDependencies } from './local-assistant/lightweight-assistant'
import { runSerializedLocalDataTransaction, type ConversationMessageRecord, type ConversationRecord } from '@aurora/client/local-data'

import type {
  AssistantToolCallCard,
  AssistantViewProps
} from './assistant-view'
import {
  encryptLocalAssistantMessageRuntime,
  encryptLocalAssistantText,
  encryptLocalAssistantToolCard,
  type LocalAssistantHistoryDependencies
} from './assistant-history-crypto'

export type { LocalAssistantHistoryDependencies } from './assistant-history-crypto'

export function resolveLocalAssistantHistoryDependencies(
  localAssistant: LightweightAssistantDependencies | null,
  executionHost: AssistantViewProps['executionHost']
): LocalAssistantHistoryDependencies | null {
  if (executionHost !== 'connected-device') return null
  const localData = localAssistant?.localData
  const envelopeCrypto = localAssistant?.envelopeCrypto
  const scope = localAssistant?.scope
  if (
    !localData
    || typeof localData.conversations?.listConversations !== 'function'
    || typeof localData.conversations?.listMessages !== 'function'
    || !envelopeCrypto
    || typeof envelopeCrypto.decrypt !== 'function'
    || !scope
    || !scope.profileId
    || !scope.localNodeId
  ) return null
  return { localData, envelopeCrypto, scope }
}

export async function persistConnectedAssistantTurnToLocalHistory(
  history: LocalAssistantHistoryDependencies,
  input: {
    conversationId: string
    requestId: string
    prompt: string
    response: string | null
    runtime: {
      routeLabel: string
      executionPeerId: string | null
      modelLabel: string | null
      providerLabel: string | null
    } | null
    toolEvents: Array<{
      recordId: string
      card: AssistantToolCallCard
      createdAtMs: number
    }>
    createdAtMs: number
  }
): Promise<void> {
  if (
    history.localData.profileId !== history.scope.profileId
    || history.localData.localNodeId !== history.scope.localNodeId
  ) {
    throw new Error('Local conversation scope does not match the active profile.')
  }

  const userMessageId = `${input.requestId}-local-user`
  const assistantMessageId = `${input.requestId}-connected-assistant`
  const activityCreatedAtMs = Math.max(
    input.createdAtMs,
    ...input.toolEvents.map((event) => event.createdAtMs),
    input.response === null ? input.createdAtMs : Date.now()
  )
  const [userEnvelope, assistantEnvelope, assistantRuntimeEnvelope, toolRecords] = await Promise.all([
    encryptLocalAssistantText(history, userMessageId, input.prompt),
    input.response === null
      ? Promise.resolve(null)
      : encryptLocalAssistantText(history, assistantMessageId, input.response),
    input.response === null || input.runtime === null
      ? Promise.resolve(null)
      : encryptLocalAssistantMessageRuntime(history, assistantMessageId, input.runtime),
    Promise.all(input.toolEvents.map(async (event): Promise<ConversationMessageRecord> => ({
      id: event.recordId,
      conversationId: input.conversationId,
      sequence: 0,
      role: 'tool',
      contentEnvelope: null,
      toolEnvelope: await encryptLocalAssistantToolCard(history, event.recordId, event.card),
      status: event.card.status === 'failed' ? 'failed' : 'complete',
      createdAtMs: event.createdAtMs
    })))
  ])

  await runSerializedLocalDataTransaction(history.localData, async (repositories) => {
    const existingConversation = await repositories.conversations.getConversation(input.conversationId)
    if (
      existingConversation
      && (
        existingConversation.profileId !== history.scope.profileId
        || existingConversation.localNodeId !== history.scope.localNodeId
      )
    ) {
      throw new Error('Local conversation belongs to a different profile.')
    }

    const conversation: ConversationRecord = existingConversation
      ? {
          ...existingConversation,
          updatedAtMs: Math.max(existingConversation.updatedAtMs, activityCreatedAtMs)
        }
      : {
          id: input.conversationId,
          profileId: history.scope.profileId,
          localNodeId: history.scope.localNodeId,
          titleEnvelope: null,
          createdAtMs: input.createdAtMs,
          updatedAtMs: activityCreatedAtMs,
          archivedAtMs: null
        }
    await repositories.conversations.upsertConversation(conversation)

    let nextSequence = (await repositories.conversations.getLatestMessageSequence(input.conversationId) ?? -1) + 1
    const records: ConversationMessageRecord[] = [
      {
        id: userMessageId,
        conversationId: input.conversationId,
        sequence: nextSequence,
        role: 'user',
        contentEnvelope: userEnvelope,
        toolEnvelope: null,
        status: 'complete',
        createdAtMs: input.createdAtMs
      },
      ...toolRecords,
      ...(assistantEnvelope === null ? [] : [{
        id: assistantMessageId,
        conversationId: input.conversationId,
        sequence: 0,
        role: 'assistant' as const,
        contentEnvelope: assistantEnvelope,
        toolEnvelope: assistantRuntimeEnvelope,
        status: 'complete' as const,
        createdAtMs: activityCreatedAtMs
      }])
    ]
    for (const record of records) {
      if (await repositories.conversations.getMessage(input.conversationId, record.id)) continue
      await repositories.conversations.appendMessage({ ...record, sequence: nextSequence })
      nextSequence += 1
    }
  })
}

export async function persistLatestLocalAssistantRuntime(
  history: LocalAssistantHistoryDependencies,
  input: {
    conversationId: string
    assistantMessageId?: string
    runtime: {
      routeLabel: string
      executionPeerId: string | null
      modelLabel: string | null
      providerLabel: string | null
    }
  }
): Promise<void> {
  if (!input.assistantMessageId) return
  const target = await history.localData.conversations.getMessage(input.conversationId, input.assistantMessageId)
  if (!target || target.conversationId !== input.conversationId || target.role !== 'assistant' || target.status !== 'complete') return
  const toolEnvelope = await encryptLocalAssistantMessageRuntime(
    history,
    target.id,
    input.runtime,
    target.toolEnvelope
  )
  await runSerializedLocalDataTransaction(history.localData, async (repositories) => {
    const current = await repositories.conversations.getMessage(input.conversationId, target.id)
    if (!current) throw new Error('Completed local assistant message is unavailable.')
    await repositories.conversations.appendMessage({ ...current, toolEnvelope })
  })
}
