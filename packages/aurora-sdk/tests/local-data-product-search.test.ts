import { describe, expect, it } from 'vitest'

import { searchLocalData } from '../src/local-data/search.js'
import { MemoryLocalDataBackend, type EncryptedDataEnvelopeV1, type EnvelopeCryptoPort, type LocalDataKeyPurpose } from '../src/local-data/index.js'
import { conversationFixture, envelopeFixture, memoryFixture, messageFixture } from './fixtures/local-data-fixtures.js'

const scope = { profileId: 'profile-1', localNodeId: 'node-1' }

describe('local-data product search facade', () => {
  it('searches bounded plaintext metadata without decrypting encrypted records', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-alpha' }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-alpha', conversationId: 'conversation-alpha', role: 'assistant' }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-alpha', namespace: 'notes', sourceId: 'conversation-alpha' }))

    const result = await searchLocalData(session, { scope, query: 'alpha', nowMs: 2000, domains: ['conversations', 'messages', 'memory'] })

    expect(result.summary).toMatchObject({
      bounded: true,
      contentSearchAuthorized: false,
      decryptedRecords: 0,
      decryptedBytes: 0,
      resultCount: 3
    })
    expect(result.results.map((item) => [item.domain, item.id, item.matchField])).toEqual([
      ['conversations', 'conversation-alpha', 'metadata'],
      ['memory', 'memory-alpha', 'metadata'],
      ['messages', 'message-alpha', 'metadata']
    ])
    expect(JSON.stringify(result.results)).not.toContain('secret')
  })

  it('searches authorized in-memory decrypted content with exact AAD and byte bounds', async () => {
    const crypto = new MapEnvelopeCryptoPort(new Map([[envelopeFixture.keyId, 'private searchable note']]))
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-1', namespace: 'notes' }))

    const result = await searchLocalData(session, {
      scope,
      query: 'searchable',
      nowMs: 2000,
      domains: ['memory'],
      decrypt: { crypto, authorized: true }
    })

    expect(result.results).toMatchObject([
      {
        domain: 'memory',
        id: 'memory-1',
        matchField: 'decrypted_content',
        matchedTextPreview: 'private searchable note',
        provenance: { namespace: 'notes' }
      }
    ])
    expect(result.summary).toMatchObject({ decryptedRecords: 1, decryptedBytes: 23 })
    expect(JSON.parse(new TextDecoder().decode(crypto.aad[0]))).toMatchObject({
      table: 'aurora_memory_items',
      recordId: 'memory-1',
      field: 'payload_envelope_json',
      profileId: 'profile-1',
      localNodeId: 'node-1'
    })
  })

  it('searches authorized message tool envelopes with exact AAD and total byte bounds', async () => {
    const toolEnvelope = { ...envelopeFixture, keyId: 'key-local-structured-data-tool' }
    const crypto = new MapEnvelopeCryptoPort(new Map([
      [envelopeFixture.keyId, 'ordinary message text'],
      [toolEnvelope.keyId, 'tool-only searchable payload']
    ]))
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-1' }))
    await session.conversations.appendMessage(messageFixture({ id: 'message-tool', conversationId: 'conversation-1', toolEnvelope }))

    const result = await searchLocalData(session, {
      scope,
      query: 'tool-only',
      nowMs: 2000,
      domains: ['messages'],
      decrypt: { crypto, authorized: true }
    })

    expect(result.results).toMatchObject([
      {
        domain: 'messages',
        id: 'message-tool',
        matchField: 'decrypted_content',
        matchedTextPreview: 'tool-only searchable payload',
        provenance: { redactedFields: ['contentEnvelope', 'toolEnvelope'] }
      }
    ])
    expect(result.summary).toMatchObject({ decryptedRecords: 2, decryptedBytes: 49 })
    expect(crypto.aad.map((aad) => JSON.parse(new TextDecoder().decode(aad)).field)).toEqual([
      'content_envelope_json',
      'tool_envelope_json'
    ])

    await expect(searchLocalData(session, {
      scope,
      query: 'tool-only',
      nowMs: 2000,
      domains: ['messages'],
      maxTotalDecryptedBytes: 48,
      decrypt: { crypto: new MapEnvelopeCryptoPort(new Map([
        [envelopeFixture.keyId, 'ordinary message text'],
        [toolEnvelope.keyId, 'tool-only searchable payload']
      ])), authorized: true }
    })).rejects.toMatchObject({ code: 'invalid_record', metadata: { reason: 'search_decrypted_total_bytes' } })
  })

  it('cancels authorized tool-envelope search before returning decrypted matches', async () => {
    const controller = new AbortController()
    const crypto = new AbortingEnvelopeCryptoPort(new Map([[envelopeFixture.keyId, 'tool-only searchable payload']]), controller)
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.conversations.upsertConversation(conversationFixture({ id: 'conversation-1' }))
    await session.conversations.appendMessage(messageFixture({
      id: 'message-tool',
      conversationId: 'conversation-1',
      contentEnvelope: null,
      toolEnvelope: envelopeFixture
    }))

    await expect(searchLocalData(session, {
      scope,
      query: 'tool-only',
      nowMs: 2000,
      domains: ['messages'],
      decrypt: { crypto, authorized: true },
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed for hostile query bounds, duplicates, expired items, oversized content, and cancellation', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-expired', namespace: 'notes', createdAtMs: 900, updatedAtMs: 1000, expiresAtMs: 1000 }))
    await session.memory.upsertMemoryItem(memoryFixture({ id: 'memory-live', namespace: 'notes', expiresAtMs: 3000 }))

    await expect(searchLocalData(session, { scope, query: '', nowMs: 2000 })).rejects.toMatchObject({ code: 'invalid_record' })
    await expect(searchLocalData(session, { scope, query: 'note', nowMs: 2000, domains: ['memory', 'memory'] })).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'search_domains' }
    })
    await expect(searchLocalData(session, { scope, query: 'expired', nowMs: 2000, domains: ['memory'] })).resolves.toMatchObject({
      results: []
    })
    await expect(searchLocalData(session, {
      scope,
      query: 'x',
      nowMs: 2000,
      domains: ['memory'],
      decrypt: { crypto: new MapEnvelopeCryptoPort(new Map([[envelopeFixture.keyId, 'x'.repeat(65 * 1024)]])), authorized: true }
    })).rejects.toMatchObject({ code: 'invalid_record', metadata: { reason: 'search_decrypted_record_bytes' } })

    const controller = new AbortController()
    controller.abort()
    await expect(searchLocalData(session, { scope, query: 'live', nowMs: 2000, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

class MapEnvelopeCryptoPort implements EnvelopeCryptoPort {
  readonly aad: Uint8Array[] = []

  constructor(private readonly plaintextByKeyId: Map<string, string>) {}

  async encrypt(_keyPurpose: LocalDataKeyPurpose, _plaintext: Uint8Array, _aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    return envelopeFixture
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    this.aad.push(new Uint8Array(aad))
    return new TextEncoder().encode(this.plaintextByKeyId.get(envelope.keyId) ?? '')
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'old', newKeyId: 'new' }
  }
}

class AbortingEnvelopeCryptoPort extends MapEnvelopeCryptoPort {
  constructor(plaintextByKeyId: Map<string, string>, private readonly controller: AbortController) {
    super(plaintextByKeyId)
  }

  override async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    const plaintext = await super.decrypt(envelope, aad)
    this.controller.abort()
    return plaintext
  }
}
