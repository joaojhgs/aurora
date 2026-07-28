import { describe, expect, it } from 'vitest'

import {
  buildEnvelopeAad,
  MemoryEnvelopeCryptoPort,
  parseEncryptedDataEnvelopeV1
} from '../src/local-data/index.js'
import { envelopeFixture } from './fixtures/local-data-fixtures.js'

describe('local-data encrypted envelope contract', () => {
  it('validates AES-GCM envelope boundaries and rejects plaintext-shaped records', () => {
    expect(parseEncryptedDataEnvelopeV1(envelopeFixture)).toEqual(envelopeFixture)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, algorithm: 'plaintext' })).toThrow(/algorithm/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, ciphertext: 'secret text' })).toThrow(/unsupported field ciphertext/u)
    expect(JSON.stringify(envelopeFixture).toLowerCase()).not.toContain('bearer')
    expect(JSON.stringify(envelopeFixture).toLowerCase()).not.toContain('verifier')
  })

  it('binds AAD to table, record, field, profile, and local node identity', () => {
    const aad = new TextDecoder().decode(buildEnvelopeAad({
      table: 'aurora_memory_items',
      recordId: 'memory-1',
      field: 'payload_envelope_json',
      profileId: 'profile-1',
      localNodeId: 'node-1'
    }))
    expect(JSON.parse(aad)).toEqual({
      envelopeVersion: 1,
      field: 'payload_envelope_json',
      localNodeId: 'node-1',
      profileId: 'profile-1',
      recordId: 'memory-1',
      table: 'aurora_memory_items'
    })
  })

  it('keeps the memory crypto port on envelope boundaries only', async () => {
    const crypto = new MemoryEnvelopeCryptoPort()
    const envelope = await crypto.encrypt('local-structured-data', new TextEncoder().encode('secret note'), new Uint8Array([1, 2, 3]))
    expect(envelope.algorithm).toBe('AES-GCM-256')
    expect(envelope.ciphertextAndTagB64Url).not.toContain('secret note')
    await expect(crypto.decrypt(envelope, new Uint8Array())).rejects.toThrow(/does not retain plaintext/u)
  })
})
