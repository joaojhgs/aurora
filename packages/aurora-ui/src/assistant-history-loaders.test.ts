import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessageRecord, ConversationRecord } from '@aurora/client/local-data'
import { activateLocalAssistantConversation, assistantMessagesFromLocalRecords, mergeLocalAssistantMessageRecords } from './assistant-history-loaders'

describe('assistant history record projection', () => {
  it('groups a tool record with its assistant across a page boundary after raw merge', async () => {
    const history = {
      scope: { profileId: 'profile', localNodeId: 'node' },
      envelopeCrypto: { decrypt: vi.fn(async () => new TextEncoder().encode(JSON.stringify({ toolCall: { id: 'tool-1', toolName: 'local.echo', route: 'local' } }))) },
    } as never
    const tool: ConversationMessageRecord = {
      id: 'tool-1', conversationId: 'conversation-1', sequence: 1, role: 'tool', contentEnvelope: null,
      toolEnvelope: {} as never, status: 'complete', createdAtMs: 100,
    }
    const assistant: ConversationMessageRecord = {
      id: 'assistant-1', conversationId: 'conversation-1', sequence: 2, role: 'assistant', contentEnvelope: null,
      toolEnvelope: null, status: 'complete', createdAtMs: 100,
    }
    const mergedRecords = mergeLocalAssistantMessageRecords([assistant], [tool])
    const messages = await assistantMessagesFromLocalRecords(history, mergedRecords)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'assistant-1', toolCalls: [expect.objectContaining({ id: 'tool-1' })] })
  })

  it('orders equal-timestamp records by persisted sequence before projection', () => {
    const older = { id: 'older', sequence: 1, createdAtMs: 500 }
    const newer = { id: 'newer', sequence: 2, createdAtMs: 500 }
    const merged = mergeLocalAssistantMessageRecords(
      [newer as never],
      [older as never],
    )
    expect(merged.map((record) => record.id)).toEqual(['older', 'newer'])
  })

  it('advances activation beyond an imported future timestamp and the latest summary', async () => {
    const conversation: ConversationRecord = {
      id: 'conversation-future', profileId: 'profile', localNodeId: 'node', titleEnvelope: null,
      createdAtMs: 9_000, updatedAtMs: 9_000, archivedAtMs: null,
    }
    const latest = { ...conversation, id: 'conversation-latest', updatedAtMs: 10_000 }
    const getConversation = vi.fn(async () => conversation)
    const listConversations = vi.fn(async () => [latest])
    const upsertConversation = vi.fn(async () => undefined)
    const history = {
      scope: { profileId: 'profile', localNodeId: 'node' },
      localData: {
        transaction: vi.fn(async (work: (repositories: unknown) => Promise<unknown>) => await work({ conversations: { getConversation, listConversations, upsertConversation } })),
      },
    } as never
    vi.spyOn(Date, 'now').mockReturnValue(1_000)

    await activateLocalAssistantConversation(history, conversation.id)

    expect(listConversations).toHaveBeenCalledWith({ includeArchived: false, limit: 1 })
    expect(upsertConversation).toHaveBeenCalledWith({ ...conversation, updatedAtMs: 10_001 })
  })
})
