import {
  buildEnvelopeAad,
  type ConversationMessageRecord,
  type EnvelopeCryptoPort,
  type LocalDataScope,
  type LocalDataSession
} from '@aurora/client/local-data'

import type { AssistantToolCallCard } from './assistant-view'

export interface LocalAssistantHistoryDependencies {
  localData: LocalDataSession
  envelopeCrypto: EnvelopeCryptoPort
  scope: LocalDataScope
}

export async function encryptLocalAssistantText(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  text: string
): Promise<ConversationMessageRecord['contentEnvelope']> {
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(text),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'content_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId
    })
  )
}

export async function encryptLocalAssistantToolCard(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  card: AssistantToolCallCard
): Promise<ConversationMessageRecord['toolEnvelope']> {
  const persistedCard: AssistantToolCallCard = {
    ...card,
    localConfirmationToken: null,
    resolving: false
  }
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(JSON.stringify({
      assistantToolCall: persistedCard,
      secretsRedacted: true
    })),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId
    })
  )
}

export async function encryptLocalAssistantMessageRuntime(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  runtime: {
    routeLabel: string
    executionPeerId: string | null
    modelLabel: string | null
    providerLabel: string | null
  },
  existingEnvelope: ConversationMessageRecord['toolEnvelope'] = null
): Promise<ConversationMessageRecord['toolEnvelope']> {
  const existingPayload = await localAssistantToolEnvelopePayload(
    history,
    messageId,
    existingEnvelope
  )
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(JSON.stringify({
      ...existingPayload,
      assistantRuntime: runtime,
      secretsRedacted: true
    })),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId
    })
  )
}

export async function localAssistantToolEnvelopePayload(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  envelope: ConversationMessageRecord['toolEnvelope']
): Promise<Record<string, unknown>> {
  if (!envelope) return {}
  try {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope,
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json'
    })
    const parsed: unknown = JSON.parse(plaintext)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function localAssistantMessageText(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord
): Promise<string> {
  if (record.contentEnvelope) {
    const content = await decryptLocalAssistantText(history, {
      envelope: record.contentEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'content_envelope_json'
    })
    if (content.trim() || record.role !== 'tool') return content
  }
  if (record.role === 'tool') {
    if (record.status === 'pending') return 'This action was waiting for approval.'
    if (record.status === 'failed') return 'This action did not finish.'
    if (record.status === 'cancelled') return 'This action was cancelled.'
    return 'Action completed.'
  }
  if (record.status === 'failed') return 'This response did not finish.'
  if (record.status === 'cancelled' || record.status === 'pending') return 'This response was stopped.'
  return 'Saved message'
}

export async function decryptLocalAssistantText(
  history: LocalAssistantHistoryDependencies,
  input: {
    envelope: NonNullable<ConversationMessageRecord['contentEnvelope']>
    table: 'aurora_conversations' | 'aurora_messages'
    recordId: string
    field: 'title_envelope_json' | 'content_envelope_json' | 'tool_envelope_json'
  }
): Promise<string> {
  const plaintext = await history.envelopeCrypto.decrypt(
    input.envelope,
    buildEnvelopeAad({
      table: input.table,
      recordId: input.recordId,
      field: input.field,
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId
    })
  )
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
}
