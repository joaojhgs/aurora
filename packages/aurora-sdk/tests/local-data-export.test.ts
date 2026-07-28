import { describe, expect, it } from 'vitest'

import { hashLocalDataCollections, localDataCollectionLimits, MemoryLocalDataBackend, parseLocalDataExportV1 } from '../src/local-data/index.js'
import {
  auditFixture,
  conversationFixture,
  localToolStateFixture,
  memoryFixture,
  messageFixture,
  peerGrantFixture
} from './fixtures/local-data-fixtures.js'

describe('local-data export contract', () => {
  it('builds stable same-device export documents with counts and hashes', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 9999 })
    const session = await backend.open('profile-1', 'node-1')
    await session.conversations.upsertConversation(conversationFixture())
    await session.conversations.appendMessage(messageFixture())
    await session.memory.upsertMemoryItem(memoryFixture())
    await session.peerGrants.upsertPeerGrant(peerGrantFixture())

    const first = await session.exportV1()
    const second = await session.exportV1()

    expect(first).toEqual(second)
    expect(first.sourceBackend).toBe('memory')
    expect(first.encryptionEnvelopeVersions).toEqual([1])
    expect(first.recordCounts).toMatchObject({ conversations: 1, messages: 1, memoryItems: 1, peerGrantMetadata: 1 })
    expect(parseLocalDataExportV1(first)).toEqual(first)
    expect(JSON.stringify(first).toLowerCase()).not.toContain('raw_token')
    expect(JSON.stringify(first).toLowerCase()).not.toContain('verifier_secret')
  })

  it('fails closed when export hashes are tampered', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 9999 })
    const session = await backend.open('profile-1', 'node-1')
    await session.memory.upsertMemoryItem(memoryFixture())
    const exported = await session.exportV1()

    expect(() => parseLocalDataExportV1({
      ...exported,
      collectionHashes: { ...exported.collectionHashes, memoryItems: '0'.repeat(64) }
    })).toThrow(/hashes/u)
  })

  it('rejects non-JSON-safe persisted objects before hashing can lose data', async () => {
    const backend = new MemoryLocalDataBackend({ nowMs: () => 9999 })
    const session = await backend.open('profile-1', 'node-1')

    await expect(session.localTools.upsertLocalToolState(localToolStateFixture({
      descriptorJson: { ok: true, nested: [1, 'two', null], missing: undefined } as never
    }))).rejects.toThrow(/record\.local_tool_state/u)
    await expect(session.localAudit.appendAudit(auditFixture({
      redactedDetailJson: { fn: () => 'not-json' } as never
    }))).rejects.toThrow(/record\.local_audit/u)
    await expect(session.localAudit.appendAudit(auditFixture({
      id: 'audit-negative-zero',
      redactedDetailJson: { unsafe: -0 } as never
    }))).rejects.toThrow(/Invalid local data boundary/u)
  })

  it('redacts attacker-controlled keys from validation errors', async () => {
    const attackerKey = 'secret-token-raw-fragment'

    try {
      parseLocalDataExportV1({
        version: 1,
        sourceBackend: 'memory',
        schemaVersion: 3,
        profileId: 'profile-1',
        localNodeId: 'node-1',
        exportedAtMs: 1,
        encryptionEnvelopeVersions: [1],
        recordCounts: {
          conversations: 0,
          messages: 0,
          memoryItems: 0,
          localToolStates: 0,
          peerGrantMetadata: 0,
          localAudit: 0
        },
        collectionHashes: {
          conversations: '0'.repeat(64),
          messages: '0'.repeat(64),
          memoryItems: '0'.repeat(64),
          localToolStates: '0'.repeat(64),
          peerGrantMetadata: '0'.repeat(64),
          localAudit: '0'.repeat(64)
        },
        records: {
          conversations: [],
          messages: [],
          memoryItems: [],
          localToolStates: [],
          peerGrantMetadata: [],
          localAudit: []
        },
        [attackerKey]: 'do-not-leak'
      })
      throw new Error('expected parse to fail')
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(attackerKey)
      expect(error).toMatchObject({
        code: 'invalid_record',
        metadata: {
          boundaryId: 'export.v1',
          validation: 'redacted'
        }
      })
    }
  })

  it('bounds hostile export documents before recursive parsing can exhaust resources', () => {
    const nested = {} as Record<string, unknown>
    let current = nested
    for (let depth = 0; depth < 48; depth += 1) {
      current.child = {}
      current = current.child as Record<string, unknown>
    }
    expect(() => parseLocalDataExportV1(nested)).toThrow(/Invalid local data boundary/u)

    expect(() => parseLocalDataExportV1({
      version: 1,
      sourceBackend: 'memory',
      schemaVersion: 3,
      profileId: 'profile-1',
      localNodeId: 'node-1',
      exportedAtMs: 1,
      encryptionEnvelopeVersions: [1],
      recordCounts: {
        conversations: localDataCollectionLimits.conversations + 1,
        messages: 0,
        memoryItems: 0,
        localToolStates: 0,
        peerGrantMetadata: 0,
        localAudit: 0
      },
      collectionHashes: {
        conversations: '0'.repeat(64),
        messages: '0'.repeat(64),
        memoryItems: '0'.repeat(64),
        localToolStates: '0'.repeat(64),
        peerGrantMetadata: '0'.repeat(64),
        localAudit: '0'.repeat(64)
      },
      records: {
        conversations: [],
        messages: [],
        memoryItems: [],
        localToolStates: [],
        peerGrantMetadata: [],
        localAudit: []
      }
    })).toThrow(/Invalid local data boundary/u)
  })

  it('uses deterministic UTF-8 ordering for canonical collection hashes', () => {
    const recordsA = {
      conversations: [
        conversationFixture({ id: 'é' }),
        conversationFixture({ id: 'z' }),
        conversationFixture({ id: '💡' })
      ],
      messages: [],
      memoryItems: [],
      localToolStates: [],
      peerGrantMetadata: [],
      localAudit: []
    }
    const recordsB = {
      ...recordsA,
      conversations: [...recordsA.conversations].reverse()
    }
    expect(hashLocalDataCollections(recordsA).conversations).toBe(hashLocalDataCollections(recordsB).conversations)
    expect(hashLocalDataCollections(recordsA).conversations).toBe('d1f7bc470603d71fbb7cbb37d547a279ebd075b81d577cd648ef5e12868b4a49')
  })
})
