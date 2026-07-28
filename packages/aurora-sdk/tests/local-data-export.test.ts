import { describe, expect, it } from 'vitest'

import { MemoryLocalDataBackend, parseLocalDataExportV1 } from '../src/local-data/index.js'
import {
  conversationFixture,
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
})
