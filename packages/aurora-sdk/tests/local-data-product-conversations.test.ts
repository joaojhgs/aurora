import { describe, expect, it } from 'vitest'

import { createLocalConversations } from '../src/local-data/conversations.js'
import { LocalDataError, MemoryLocalDataBackend } from '../src/local-data/index.js'
import { conversationFixture, messageFixture } from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local-data product conversation facade', () => {
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
