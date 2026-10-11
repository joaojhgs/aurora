import { describe, expect, it, vi } from 'vitest'

import { createLocalConversations } from '../src/local-data/conversations.js'
import { LocalDataError, MemoryLocalDataBackend } from '../src/local-data/index.js'
import { conversationFixture, messageFixture } from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local-data product conversation facade', () => {
  it('returns bounded pages with exact continuation cursors and chronological message items', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-a', updatedAtMs: 1000 }) })
    for (const sequence of [0, 1, 2]) {
      await conversations.appendMessage({ scope, record: messageFixture({ id: `message-${sequence}`, conversationId: 'conversation-a', sequence }) })
    }

    const first = await conversations.listMessagesPage({ scope, conversationId: 'conversation-a', limit: 2 })
    expect(first.items.map((message) => message.sequence)).toEqual([1, 2])
    expect(first.nextCursor).toEqual({ direction: 'desc', beforeSequence: 1 })
    if (first.nextCursor === null || first.nextCursor.direction !== 'desc') throw new Error('expected a descending continuation')
    const older = await conversations.listMessagesPage({ scope, conversationId: 'conversation-a', limit: 2, beforeSequence: first.nextCursor.beforeSequence })
    expect(older.items.map((message) => message.sequence)).toEqual([0])
    expect(older.nextCursor).toBeNull()
  })

  it('continues ascending message pages exclusively after the returned sequence', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-a' }) })
    for (const sequence of [0, 1, 2]) await conversations.appendMessage({ scope, record: messageFixture({ id: `asc-${sequence}`, conversationId: 'conversation-a', sequence }) })

    const first = await conversations.listMessagesPage({ scope, conversationId: 'conversation-a', direction: 'asc', limit: 2 })
    expect(first.items.map((message) => message.sequence)).toEqual([0, 1])
    expect(first.nextCursor).toEqual({ direction: 'asc', afterSequence: 1 })
    if (first.nextCursor === null || first.nextCursor.direction !== 'asc') throw new Error('expected ascending continuation')
    const second = await conversations.listMessagesPage({ scope, conversationId: 'conversation-a', direction: 'asc', limit: 2, afterSequence: first.nextCursor.afterSequence })
    expect(second.items.map((message) => message.sequence)).toEqual([2])
    expect(second.nextCursor).toBeNull()
  })

  it('passes the internal 501 conversation and 2001 message probes and returns continuation cursors at public maxima', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    for (let index = 0; index < 501; index += 1) {
      await conversations.upsertConversation({ scope, record: conversationFixture({ id: `conversation-${index}`, createdAtMs: index + 1, updatedAtMs: index + 1 }) })
    }
    const conversationPage = await conversations.listConversationsPage({ scope, limit: 500 })
    expect(conversationPage.items).toHaveLength(500)
    expect(conversationPage.nextCursor).not.toBeNull()
    if (conversationPage.nextCursor === null) throw new Error('expected conversation continuation')
    const remainingConversationPage = await conversations.listConversationsPage({ scope, limit: 500, cursor: conversationPage.nextCursor })
    expect(remainingConversationPage.items.map(({ record }) => record.id)).toEqual(['conversation-0'])
    const firstPageIds = new Set(conversationPage.items.map(({ record }) => record.id))
    expect(remainingConversationPage.items.some(({ record }) => firstPageIds.has(record.id))).toBe(false)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'message-conversation' }) })
    for (let sequence = 0; sequence < 2001; sequence += 1) {
      await conversations.appendMessage({ scope, record: messageFixture({ id: `probe-${sequence}`, conversationId: 'message-conversation', sequence }) })
    }
    const messagePage = await conversations.listMessagesPage({ scope, conversationId: 'message-conversation', limit: 2000 })
    expect(messagePage.items).toHaveLength(2000)
    expect(messagePage.nextCursor).not.toBeNull()
  })

  it('returns scoped conversations and stable message ordering', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({
      scope,
      record: conversationFixture({ id: 'conversation-b', updatedAtMs: 2000 })
    })
    await conversations.upsertConversation({
      scope,
      record: conversationFixture({ id: 'conversation-a', updatedAtMs: 2000 })
    })
    await conversations.upsertConversation({
      scope,
      record: conversationFixture({ id: 'conversation-archived', updatedAtMs: 3000, archivedAtMs: 3100 })
    })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-2', conversationId: 'conversation-a', sequence: 2 }) })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-1', conversationId: 'conversation-a', sequence: 1 }) })

    await expect(conversations.listConversations({ scope })).resolves.toMatchObject([
      { record: { id: 'conversation-a' }, messageCount: 2, historyBoundary: { authority: 'local-sdk', replicationState: 'local-only' } },
      { record: { id: 'conversation-b' }, messageCount: 0 }
    ])
    await expect(conversations.listMessages({ scope, conversationId: 'conversation-a' })).resolves.toEqual([
      messageFixture({ id: 'message-1', conversationId: 'conversation-a', sequence: 1 }),
      messageFixture({ id: 'message-2', conversationId: 'conversation-a', sequence: 2 })
    ])
  })

  it('uses one batched count read instead of loading every conversation body', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-a' }) })
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-b' }) })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-1', conversationId: 'conversation-a', sequence: 0 }) })

    const listMessages = vi.spyOn(session.conversations, 'listMessages')
    const listMessageCounts = vi.spyOn(session.conversations, 'listMessageCounts')

    await expect(conversations.listConversations({ scope })).resolves.toMatchObject([
      { record: { id: 'conversation-a' }, messageCount: 1 },
      { record: { id: 'conversation-b' }, messageCount: 0 }
    ])
    expect(listMessageCounts).toHaveBeenCalledTimes(1)
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('appends through the atomic repository without scanning messages first', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-a' }) })
    const listMessages = vi.spyOn(session.conversations, 'listMessages')

    await conversations.appendMessage({ scope, record: messageFixture({ id: 'append-a', conversationId: 'conversation-a', sequence: 0 }) })
    await expect(conversations.appendMessage({ scope, record: messageFixture({ id: 'append-b', conversationId: 'conversation-a', sequence: 0 }) })).rejects.toMatchObject({
      metadata: { reason: 'duplicate_message_sequence' }
    })
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('archives and deletes only scoped local history with repository cascade semantics', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-1' }) })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-1', conversationId: 'conversation-1', sequence: 0 }) })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-2', conversationId: 'conversation-1', sequence: 1 }) })

    await expect(conversations.archiveConversation({ scope, conversationId: 'conversation-1', archivedAtMs: 5000 })).resolves.toMatchObject({
      id: 'conversation-1',
      archivedAtMs: 5000,
      updatedAtMs: 5000
    })
    await expect(conversations.listConversations({ scope })).resolves.toEqual([])
    await expect(conversations.deleteConversation({ scope, conversationId: 'conversation-1' })).resolves.toEqual({
      deleted: true,
      deletedMessages: 2
    })
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([])
  })

  it('rejects duplicate message IDs across scoped conversations without mutating local history', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-a' }) })
    await conversations.upsertConversation({ scope, record: conversationFixture({ id: 'conversation-b' }) })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-global', conversationId: 'conversation-a', sequence: 0 }) })

    await expect(conversations.appendMessage({
      scope,
      record: messageFixture({ id: 'message-global', conversationId: 'conversation-b', sequence: 0, role: 'assistant' })
    })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'duplicate_message_id' }
    })

    await expect(session.conversations.listMessages('conversation-a')).resolves.toEqual([
      messageFixture({ id: 'message-global', conversationId: 'conversation-a', sequence: 0 })
    ])
    await expect(session.conversations.listMessages('conversation-b')).resolves.toEqual([])
  })

  it('fails closed for hostile scopes, duplicate ordering, bad limits, and Python history merge hints', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const conversations = createLocalConversations(session)
    await conversations.upsertConversation({ scope, record: conversationFixture() })
    await conversations.appendMessage({ scope, record: messageFixture({ id: 'message-1', sequence: 0 }) })

    await expect(conversations.listConversations({ scope, limit: 0 })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(conversations.listConversations({ scope: { profileId: 'profile-2', localNodeId: 'node-1' } })).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(conversations.appendMessage({ scope, record: messageFixture({ id: 'message-2', sequence: 0 }) })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'duplicate_message_sequence' }
    })
    await expect(conversations.upsertConversation({
      scope,
      record: conversationFixture(),
      replicateToPython: true
    } as Parameters<typeof conversations.upsertConversation>[0])).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'implicit_python_history_merge' }
    })
    await expect(conversations.deleteConversation({ scope, conversationId: 'missing' })).rejects.toBeInstanceOf(LocalDataError)
  })
})
