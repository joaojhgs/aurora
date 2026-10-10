import { describe, expect, it } from 'vitest'

import { buildLocalDataExportV1, LocalDataError, MemoryLocalDataBackend, type LocalDataRepositories } from '../src/local-data/index.js'
import { compareUtf8 } from '../src/local-data/export-v1.js'
import {
  auditFixture,
  conversationFixture,
  envelopeFixture,
  localToolStateFixture,
  memoryFixture,
  messageFixture,
  peerGrantFixture
} from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local-data memory repository contract', () => {
  it('supports bounded keyset conversation and message queries while preserving legacy reads', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture({ id: 'z', updatedAtMs: 2000 }))
    await session.conversations.upsertConversation(conversationFixture({ id: 'b', updatedAtMs: 2000 }))
    await session.conversations.upsertConversation(conversationFixture({ id: 'a', updatedAtMs: 2000 }))
    await session.conversations.appendMessage(messageFixture({ id: 'm-0', conversationId: 'z', sequence: 0 }))
    await session.conversations.appendMessage(messageFixture({ id: 'm-1', conversationId: 'z', sequence: 1 }))
    await session.conversations.appendMessage(messageFixture({ id: 'm-2', conversationId: 'z', sequence: 2 }))

    const first = await session.conversations.listConversations({ limit: 2 })
    expect(first.map((record) => record.id)).toEqual(['a', 'b'])
    const second = await session.conversations.listConversations({ limit: 2, cursor: { updatedAtMs: 2000, id: 'b' } })
    expect(second.map((record) => record.id)).toEqual(['z'])
    await expect(session.conversations.listConversations()).resolves.toHaveLength(3)
    await expect(session.conversations.listMessages('z', { limit: 2, direction: 'desc' })).resolves.toEqual([
      messageFixture({ id: 'm-2', conversationId: 'z', sequence: 2 }),
      messageFixture({ id: 'm-1', conversationId: 'z', sequence: 1 })
    ])
    await expect(session.conversations.listMessages('z', { beforeSequence: 2 })).resolves.toEqual([
      messageFixture({ id: 'm-0', conversationId: 'z', sequence: 0 }),
      messageFixture({ id: 'm-1', conversationId: 'z', sequence: 1 })
    ])
    await expect(session.conversations.getLatestMessageSequence('z')).resolves.toBe(2)
  })

  it('orders Unicode IDs by UTF-8 bytes and advances the exclusive cursor without broadening ID validation', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    expect(compareUtf8('\uE000', '😀')).toBeLessThan(0)
    expect(compareUtf8('😀', '\uE000')).toBeGreaterThan(0)
    await session.conversations.upsertConversation(conversationFixture({ id: 'unicode-a', updatedAtMs: 2000 }))
    await session.conversations.upsertConversation(conversationFixture({ id: 'unicode-b', updatedAtMs: 2000 }))
    const first = await session.conversations.listConversations({ limit: 1 })
    expect(first).toHaveLength(1)
    const second = await session.conversations.listConversations({ limit: 1, cursor: { updatedAtMs: 2000, id: first[0]!.id } })
    expect(second).toHaveLength(1)
    expect(second[0]!.id).not.toBe(first[0]!.id)
    await expect(session.conversations.listConversations({ limit: Number.NaN })).rejects.toMatchObject({ metadata: { reason: 'conversation_limit' } })
    await expect(session.conversations.listConversations({ cursor: { updatedAtMs: Number.POSITIVE_INFINITY, id: 'unicode-a' } })).rejects.toMatchObject({ metadata: { reason: 'conversation_cursor_updated_at' } })
  })

  it('accepts repository probe maxima while rejecting oversized exact ID sets', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    await expect(session.conversations.listConversations({ limit: 501 })).resolves.toEqual([])
    await expect(session.conversations.listMessages('z', { limit: 2001 })).resolves.toEqual([])
    await expect(session.conversations.listMessageCounts(Array.from({ length: 501 }, (_, index) => `conversation-${index}`))).rejects.toMatchObject({ metadata: { reason: 'conversation_id_set_limit' } })
  })

  it('updates an existing same-conversation message atomically inside a transaction', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-1' }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-update', conversationId: 'conversation-1', sequence: 0, status: 'pending' }))
    await session.transaction(async (repositories) => {
      await repositories.conversations.appendMessage(messageFixture({ id: 'message-update', conversationId: 'conversation-1', sequence: 0, status: 'complete' }))
    })
    await expect(session.conversations.getMessage('conversation-1', 'message-update')).resolves.toMatchObject({ id: 'message-update', status: 'complete' })
  })

  it('bounds exact ID projections and returns empty results for an empty set', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await expect(session.conversations.listMessageCounts([])).resolves.toEqual({})
    await expect(session.conversations.listFirstUserMessages([])).resolves.toEqual({})
    await expect(session.conversations.listMessageCounts(['conversation-1'])).resolves.toEqual({ 'conversation-1': 1 })
    await expect(session.conversations.listFirstUserMessages(['conversation-1'])).resolves.toMatchObject({ 'conversation-1': { id: 'message-1' } })
    await expect(session.conversations.listMessages('conversation-1', { beforeSequence: 1, afterSequence: 0 })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'ambiguous_message_cursor' }
    })
  })

  it('reads an exact scoped message as an immutable clone, including inside a transaction', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-1' }))
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-2' }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-exact', conversationId: 'conversation-1' }))

    const outside = await session.conversations.getMessage('conversation-1', 'message-exact')
    expect(outside).toEqual(messageFixture({ id: 'message-exact', conversationId: 'conversation-1' }))
    if (outside === null) throw new Error('expected exact message')
    outside.id = 'mutated-clone-id'
    await expect(session.conversations.getMessage('conversation-1', 'message-exact')).resolves.toMatchObject({ id: 'message-exact' })
    await expect(session.conversations.getMessage('conversation-2', 'message-exact')).resolves.toBeNull()

    await session.transaction(async (repositories) => {
      const inside = await repositories.conversations.getMessage('conversation-1', 'message-exact')
      expect(inside).toEqual(messageFixture({ id: 'message-exact', conversationId: 'conversation-1' }))
      if (inside === null) throw new Error('expected transaction message')
      inside.id = 'transaction-clone-id'
    })
    await expect(session.conversations.getMessage('conversation-1', 'message-exact')).resolves.toMatchObject({ id: 'message-exact' })
  })

  it('stores every repository type through typed ports without exposing SQL', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 2000 })
    const session = await backend.open('profile-1', 'node-1')

    expect(Object.keys(session).join(' ').toLowerCase()).not.toContain('sql')
    await session.conversations.upsertConversation(conversationFixture({ id: 'z' }))
    await session.conversations.appendMessage(messageFixture({ conversationId: 'z' }))
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.localTools.upsertLocalToolState(localToolStateFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())
    await session.localAudit.appendAudit(auditFixture())

    await expect(session.conversations.listConversations()).resolves.toHaveLength(1)
    await expect(session.conversations.listMessages('z')).resolves.toEqual([messageFixture({ conversationId: 'z' })])
    await expect(session.memory.listMemoryItems('notes')).resolves.toEqual([memoryFixture()])
    await expect(session.localTools.listLocalToolStates()).resolves.toEqual([localToolStateFixture()])
    await expect(session.peerGrants.listPeerGrants()).resolves.toEqual([peerGrantFixture()])
    await expect(session.localAudit.listAudit()).resolves.toEqual([auditFixture()])
  })

  it('deletes conversations with messages and memory items with deterministic bounds', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture({ id: 'message-1', sequence: 0 }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-2', sequence: 1 }))

    await expect(session.conversations.deleteConversation('missing-conversation')).resolves.toEqual({
      deleted: false,
      deletedMessages: 0
    })
    await expect(session.conversations.deleteConversation('conversation-1')).resolves.toEqual({
      deleted: true,
      deletedMessages: 2
    })
    await expect(session.conversations.listConversations()).resolves.toEqual([])
    await expect(session.conversations.listMessages('z')).resolves.toEqual([])

    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-keep', expiresAtMs: null }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-new', expiresAtMs: 3000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired-b', expiresAtMs: 1000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired-a', expiresAtMs: 1000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired-old', expiresAtMs: 900 }))

    await expect(session.memory.deleteMemoryItem('missing-memory')).resolves.toEqual({ deleted: false })
    await expect(session.memory.deleteMemoryItem('memory-keep')).resolves.toEqual({ deleted: true })
    await expect(session.memory.deleteExpiredMemoryItems(scope, 1000, 2)).resolves.toEqual({ deleted: 2 })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([
      memoryFixture({ id: 'memory-expired-b', expiresAtMs: 1000 }),
      memoryFixture({ id: 'memory-new', expiresAtMs: 3000 })
    ])
    await expect(session.memory.deleteExpiredMemoryItems(scope, 1000, 2)).resolves.toEqual({ deleted: 1 })
    await expect(session.memory.deleteExpiredMemoryItems(scope, 3000, 5)).resolves.toEqual({ deleted: 1 })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])
    await expect(session.memory.deleteExpiredMemoryItems(scope, 1000, 0)).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'delete_limit' }
    })
  })

  it('rejects invalid expired-memory cutoffs before deleting records', async () => {
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1000.5]) {
      const backend = new MemoryLocalDataBackend()
      const session = await backend.open('profile-1', 'node-1')
      await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired', expiresAtMs: 1000 }))

      await expect(session.memory.deleteExpiredMemoryItems(scope, nowMs, 1)).rejects.toMatchObject({
        code: 'invalid_record',
        metadata: { reason: 'delete_now_ms' }
      })
      await expect(session.memory.listMemoryItems()).resolves.toEqual([
        memoryFixture({ id: 'memory-expired', expiresAtMs: 1000 })
      ])
    }
  })

  it('rolls back transaction writes and enforces local node identity', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())

    await expect(session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-rollback' }))
      throw new Error('fail current unit')
    })).rejects.toThrow(/fail current unit/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])

    await expect(session.memory.upsertMemoryItem(memoryFixture({ localNodeId: 'node-2' }))).rejects.toMatchObject({
      code: 'identity_mismatch'
    })
  })

  it('is explicitly session-only and clears records when closed', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture({ payloadEnvelope: envelopeFixture }))
    await expect(backend.status()).resolves.toMatchObject({
      kind: 'memory',
      persistent: false,
      sqlite: false,
      degradedReason: 'memory_session_only'
    })

    await expect(backend.open('profile-2', 'node-2')).rejects.toBeInstanceOf(LocalDataError)
    await session.close()
    await expect(session.memory.listMemoryItems()).rejects.toMatchObject({ code: 'session_closed' })

    const reopened = await backend.open('profile-1', 'node-1')
    await expect(reopened.memory.listMemoryItems()).resolves.toEqual([])
  })

  it('serializes concurrent transactions and isolates failed rollbacks', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    const gates: Array<() => void> = []

    const first = session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-first' }))
      await new Promise<void>((resolve) => gates.push(resolve))
    })
    const second = session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-second' }))
    })
    const third = session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-third' }))
      throw new Error('rollback third')
    })

    await waitUntil(() => gates.length > 0)
    gates[0]?.()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    await expect(third).rejects.toThrow(/rollback third/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([
      memoryFixture({ id: 'memory-first' }),
      memoryFixture({ id: 'memory-second' })
    ])
  })

  it('queues ordinary reads during a long transaction without exposing uncommitted state', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    let releaseTransaction: (() => void) | undefined
    const transaction = session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-transaction' }))
      await new Promise<void>((resolve) => {
        releaseTransaction = resolve
      })
    })

    await waitUntil(() => releaseTransaction !== undefined)
    let outsideReadSettled = false
    const outsideRead = session.memory.listMemoryItems().then((records) => {
      outsideReadSettled = true
      return records
    })
    await Promise.resolve()
    expect(outsideReadSettled).toBe(false)

    releaseTransaction?.()
    await expect(transaction).resolves.toBeUndefined()
    await expect(outsideRead).resolves.toEqual([memoryFixture({ id: 'memory-transaction' })])
  })

  it('queues outside writes until a long failed transaction rolls back', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    let releaseTransaction: (() => void) | undefined
    const transaction = session.transaction(async (repositories) => {
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-transaction' }))
      await new Promise<void>((resolve) => {
        releaseTransaction = resolve
      })
      throw new Error('rollback long transaction')
    })

    await waitUntil(() => releaseTransaction !== undefined)
    let outsideWriteSettled = false
    const outsideWrite = session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-outside' })).then(() => {
      outsideWriteSettled = true
    })
    await Promise.resolve()
    expect(outsideWriteSettled).toBe(false)

    releaseTransaction?.()
    await expect(transaction).rejects.toThrow(/rollback long transaction/u)
    await expect(outsideWrite).resolves.toBeUndefined()
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-outside' })])
  })

  it('invalidates leaked transaction repositories after commit and rollback', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    let committedLeak: LocalDataRepositories | undefined
    await session.transaction(async (repositories) => {
      committedLeak = repositories
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-committed' }))
    })

    await expect(committedLeak?.memory.upsertMemoryItem(memoryFixture({ id: 'memory-leaked-commit' }))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: {
        boundaryId: 'transaction.scope',
        validation: 'redacted'
      }
    })

    let rolledBackLeak: LocalDataRepositories | undefined
    await expect(session.transaction(async (repositories) => {
      rolledBackLeak = repositories
      await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-rollback-leak' }))
      throw new Error('rollback with leaked repository')
    })).rejects.toThrow(/rollback with leaked repository/u)

    await expect(rolledBackLeak?.memory.listMemoryItems()).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: {
        boundaryId: 'transaction.scope',
        validation: 'redacted'
      }
    })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-committed' })])
  })

  it('rejects nested transactions without waiting on the outer queue', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')

    await expect(session.transaction(async () => {
      const nested = session.transaction(async (repositories) => {
        await repositories.memory.upsertMemoryItem(memoryFixture({ id: 'memory-nested' }))
      })
      const nestedOutcome = await Promise.race([
        nested.then(() => 'resolved' as const, (error: unknown) => error),
        delay(25).then(() => 'timeout' as const)
      ])
      expect(nestedOutcome).not.toBe('timeout')
      expect(nestedOutcome).toMatchObject({
        code: 'invalid_record',
        metadata: {
          boundaryId: 'transaction.scope',
          validation: 'redacted'
        }
      })
    })).resolves.toBeUndefined()
    await expect(session.memory.listMemoryItems()).resolves.toEqual([])
  })

  it('validates open identity and rejects future-schema imports before replacing state', async () => {
    const backend = new MemoryLocalDataBackend({ schemaVersion: 3 })
    await expect(backend.open('', 'node-1')).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(backend.open('profile-1', '')).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(backend.open('profile 1', 'node-1')).rejects.toMatchObject({ code: 'invalid_record' })
    const session = await backend.open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-original' }))
    const exported = await session.exportV1()

    await expect(session.importV1({ ...exported, schemaVersion: 4 })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'future_schema' }
    })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-original' })])
  })

  it('validates imported identities and repository invariants before replacing state', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 9999 })
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-original' }))
    const exported = await session.exportV1()
    const documentWithRecords = (records: typeof exported.records) => buildLocalDataExportV1({
      sourceBackend: 'memory',
      schemaVersion: exported.schemaVersion,
      profileId: exported.profileId,
      localNodeId: exported.localNodeId,
      exportedAtMs: exported.exportedAtMs,
      records
    })

    await expect(session.importV1(documentWithRecords({
      ...exported.records,
      memoryItems: [memoryFixture({ id: 'memory-bad', profileId: 'profile-2' })]
    }))).rejects.toMatchObject({ code: 'identity_mismatch' })

    await expect(session.importV1(documentWithRecords({
      ...exported.records,
      conversations: [conversationFixture({ id: 'dup' }), conversationFixture({ id: 'dup', updatedAtMs: 1200 })]
    }))).rejects.toMatchObject({ code: 'invalid_record' })

    await expect(session.importV1(documentWithRecords({
      ...exported.records,
      messages: [messageFixture({ conversationId: 'missing-conversation' })]
    }))).rejects.toMatchObject({ code: 'invalid_record' })

    await expect(session.importV1(documentWithRecords({
      ...exported.records,
      messages: [
        messageFixture({ id: 'message-1', sequence: 0 }),
        messageFixture({ id: 'message-2', sequence: 0 })
      ]
    }))).rejects.toMatchObject({ code: 'invalid_record' })

    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-original' })])
  })
})

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
