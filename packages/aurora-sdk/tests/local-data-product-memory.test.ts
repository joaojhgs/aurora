import { describe, expect, it } from 'vitest'

import { createLocalLightweightMemory } from '../src/local-data/lightweight-memory.js'
import { MemoryLocalDataBackend, type LightweightMemoryRecord, type LocalDataSession } from '../src/local-data/index.js'
import { memoryFixture } from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local-data product lightweight memory facade', () => {
  it('returns namespace-scoped active records with provenance and excludes expired records by default', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const memory = createLocalLightweightMemory(session)
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-active-b', updatedAtMs: 2000, expiresAtMs: null }) })
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-active-a', updatedAtMs: 2000, expiresAtMs: 3000 }) })
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-expired', createdAtMs: 1000, updatedAtMs: 1500, expiresAtMs: 1500 }) })
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-other-namespace', namespace: 'tasks', updatedAtMs: 3000 }) })

    await expect(memory.listMemoryItems({ scope, namespace: 'notes', nowMs: 2000 })).resolves.toMatchObject([
      {
        record: { id: 'memory-active-a' },
        provenance: {
          namespace: 'notes',
          sourceType: 'conversation',
          sourceId: 'conversation-1',
          retention: 'expires',
          historyBoundary: { authority: 'local-sdk', replicationState: 'local-only' }
        }
      },
      {
        record: { id: 'memory-active-b' },
        provenance: { retention: 'retained' }
      }
    ])
  })

  it('validates provenance, timestamps, hostile limits, scope, and implicit merge attempts', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const memory = createLocalLightweightMemory(session)

    await expect(memory.upsertMemoryItem({
      scope,
      record: memoryFixture({ sourceType: 'conversation', sourceId: null })
    })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(memory.upsertMemoryItem({
      scope,
      record: memoryFixture({ updatedAtMs: 1, createdAtMs: 2 })
    })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(memory.listMemoryItems({ scope, nowMs: 1000, limit: 0 })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(memory.upsertMemoryItem({
      scope: { profileId: 'profile-2', localNodeId: 'node-1' },
      record: memoryFixture()
    })).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(memory.upsertMemoryItem({
      scope,
      record: memoryFixture(),
      pythonConversationId: 'python-history-1'
    } as Parameters<typeof memory.upsertMemoryItem>[0])).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'implicit_python_history_merge' }
    })
  })

  it('performs positive bounded expired cleanup without returning expired reads', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const memory = createLocalLightweightMemory(session)
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-expired-a', createdAtMs: 900, updatedAtMs: 1000, expiresAtMs: 1000 }) })
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-expired-b', createdAtMs: 900, updatedAtMs: 1000, expiresAtMs: 1000 }) })
    await memory.upsertMemoryItem({ scope, record: memoryFixture({ id: 'memory-active', expiresAtMs: 3000 }) })

    await expect(memory.deleteExpiredMemoryItems({ scope, nowMs: 1000, limit: 1 })).resolves.toEqual({ deleted: 1 })
    await expect(memory.listMemoryItems({ scope, nowMs: 1000, includeExpired: true })).resolves.toHaveLength(2)
    await expect(memory.listMemoryItems({ scope, nowMs: 3000 })).resolves.toEqual([])
    await expect(memory.deleteExpiredMemoryItems({ scope, nowMs: 1000, limit: 0 })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'memory_cleanup_limit' }
    })
  })

  it('scopes expired cleanup without throwing on other profiles or deleting them', async () => {
    const records = [
      memoryFixture({ id: 'memory-profile-1-expired', expiresAtMs: 1000 }),
      memoryFixture({ id: 'memory-profile-2-expired', profileId: 'profile-2', expiresAtMs: 1000 })
    ]
    const deletedScopes: Array<{ profileId: string; localNodeId: string }> = []
    const session = {
      profileId: scope.profileId,
      localNodeId: scope.localNodeId,
      schemaVersion: 3,
      memory: {
        upsertMemoryItem: async () => undefined,
        deleteMemoryItem: async () => ({ deleted: false }),
        deleteExpiredMemoryItems: async (cleanupScope: { profileId: string; localNodeId: string }, nowMs: number, limit: number) => {
          deletedScopes.push(cleanupScope)
          const expiredIds = records
            .filter((record) =>
              record.profileId === cleanupScope.profileId
              && record.localNodeId === cleanupScope.localNodeId
              && record.expiresAtMs !== null
              && record.expiresAtMs <= nowMs
            )
            .slice(0, limit)
            .map((record) => record.id)
          for (const id of expiredIds) {
            records.splice(records.findIndex((record) => record.id === id), 1)
          }
          return { deleted: expiredIds.length }
        },
        listMemoryItems: async () => records.map((record) => structuredClone(record))
      }
    } as unknown as LocalDataSession
    const memory = createLocalLightweightMemory(session)

    await expect(memory.deleteExpiredMemoryItems({ scope, nowMs: 1000, limit: 10 })).resolves.toEqual({ deleted: 1 })

    expect(deletedScopes).toEqual([scope])
    expect(records).toEqual<LightweightMemoryRecord[]>([
      memoryFixture({ id: 'memory-profile-2-expired', profileId: 'profile-2', expiresAtMs: 1000 })
    ])
  })
})
