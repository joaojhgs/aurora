import { describe, expect, it } from 'vitest'

import { LocalDataError, MemoryLocalDataBackend } from '../src/local-data/index.js'
import {
  auditFixture,
  conversationFixture,
  envelopeFixture,
  localToolStateFixture,
  memoryFixture,
  messageFixture,
  peerGrantFixture
} from './fixtures/local-data-fixtures.js'

describe('local-data memory repository contract', () => {
  it('stores every repository type through typed ports without exposing SQL', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 2000 })
    const session = await backend.open('profile-1', 'node-1')

    expect(Object.keys(session).join(' ').toLowerCase()).not.toContain('sql')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.localTools.upsertLocalToolState(localToolStateFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())
    await session.localAudit.appendAudit(auditFixture())

    await expect(session.conversations.listConversations()).resolves.toHaveLength(1)
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual([messageFixture()])
    await expect(session.memory.listMemoryItems('notes')).resolves.toEqual([memoryFixture()])
    await expect(session.localTools.listLocalToolStates()).resolves.toEqual([localToolStateFixture()])
    await expect(session.peerGrants.listPeerGrants()).resolves.toEqual([peerGrantFixture()])
    await expect(session.localAudit.listAudit()).resolves.toEqual([auditFixture()])
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

    await Promise.resolve()
    await expect(session.memory.listMemoryItems()).resolves.toHaveLength(1)
    gates[0]?.()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    await expect(third).rejects.toThrow(/rollback third/u)
    await expect(session.memory.listMemoryItems()).resolves.toEqual([
      memoryFixture({ id: 'memory-first' }),
      memoryFixture({ id: 'memory-second' })
    ])
  })

  it('validates open identity and rejects future-schema imports before replacing state', async () => {
    const backend = new MemoryLocalDataBackend({ schemaVersion: 3 })
    await expect(backend.open('', 'node-1')).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(backend.open('profile-1', '')).rejects.toMatchObject({ code: 'invalid_record' })
    const session = await backend.open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-original' }))
    const exported = await session.exportV1()

    await expect(session.importV1({ ...exported, schemaVersion: 4 })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'future_schema' }
    })
    await expect(session.memory.listMemoryItems()).resolves.toEqual([memoryFixture({ id: 'memory-original' })])
  })
})
