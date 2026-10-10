import { describe, expect, it } from 'vitest'

import { MemoryLocalDataBackend, runSerializedLocalDataTransaction } from '../src/local-data/index.js'

describe('runSerializedLocalDataTransaction', () => {
  it('serializes separate owners on one session and releases after failure', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    const events: string[] = []
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const first = runSerializedLocalDataTransaction(session, async () => {
      events.push('first-start')
      firstStarted()
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      events.push('first-end')
    })
    await started
    const second = runSerializedLocalDataTransaction(session, async () => {
      events.push('second')
    })
    await Promise.resolve()
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(events).toEqual(['first-start', 'first-end', 'second'])

    await expect(runSerializedLocalDataTransaction(session, async () => {
      events.push('failed')
      throw new Error('owner failed')
    })).rejects.toThrow('owner failed')
    await expect(runSerializedLocalDataTransaction(session, async () => {
      events.push('after-failure')
    })).resolves.toBeUndefined()
    expect(events.slice(-2)).toEqual(['failed', 'after-failure'])
    await session.close()
  })

  it('keeps a successor queued through rollback and supports concurrent Promise.all owners', async () => {
    const session = await new MemoryLocalDataBackend().open('profile-1', 'node-1')
    const events: string[] = []
    let release!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const first = runSerializedLocalDataTransaction(session, async (repositories) => {
      await repositories.conversations.upsertConversation({
        id: 'rollback-sentinel',
        profileId: 'profile-1',
        localNodeId: 'node-1',
        titleEnvelope: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        archivedAtMs: null
      })
      events.push('rollback-start')
      firstStarted()
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('rollback')
    })
    await started
    const second = runSerializedLocalDataTransaction(session, async (repositories) => {
      await expect(repositories.conversations.listConversations()).resolves.toEqual([])
      await repositories.conversations.upsertConversation({
        id: 'successor-conversation',
        profileId: 'profile-1',
        localNodeId: 'node-1',
        titleEnvelope: null,
        createdAtMs: 2,
        updatedAtMs: 2,
        archivedAtMs: null
      })
      events.push('successor')
    })
    expect(events).toEqual(['rollback-start'])
    release()
    await expect(first).rejects.toThrow('rollback')
    await expect(second).resolves.toBeUndefined()
    expect(events).toEqual(['rollback-start', 'successor'])
    await expect(session.conversations.listConversations()).resolves.toEqual([
      expect.objectContaining({ id: 'successor-conversation' })
    ])

    const concurrent = await Promise.all([
      runSerializedLocalDataTransaction(session, async () => { events.push('parallel-a') }),
      runSerializedLocalDataTransaction(session, async () => { events.push('parallel-b') })
    ])
    expect(concurrent).toEqual([undefined, undefined])
    expect(events.slice(-2)).toEqual(['parallel-a', 'parallel-b'])
    await session.close()
  })
})
