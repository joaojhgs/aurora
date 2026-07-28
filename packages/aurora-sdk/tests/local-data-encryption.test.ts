import { describe, expect, it } from 'vitest'

import {
  buildEnvelopeAad,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  parseEncryptedDataEnvelopeV1
} from '../src/local-data/index.js'
import { envelopeFixture } from './fixtures/local-data-fixtures.js'

describe('local-data encrypted envelope contract', () => {
  it('validates AES-GCM envelope boundaries and rejects plaintext-shaped records', () => {
    expect(parseEncryptedDataEnvelopeV1(envelopeFixture)).toEqual(envelopeFixture)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, algorithm: 'plaintext' })).toThrow(/envelope\.v1/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, ciphertext: 'secret text' })).toThrow(/envelope\.v1/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, nonceB64Url: 'AAAA' })).toThrow(/envelope\.v1/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, nonceB64Url: 'AAAAAAAAAAAAAAAA=' })).toThrow(/envelope\.v1/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, ciphertextAndTagB64Url: 'AAAA' })).toThrow(/envelope\.v1/u)
    expect(() => parseEncryptedDataEnvelopeV1({ ...envelopeFixture, ciphertextAndTagB64Url: 'A'.repeat(2 * 1024 * 1024 + 1) })).toThrow(/envelope\.v1/u)
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
    const crypto = new RecordingEnvelopeCryptoPort()
    const envelope = await crypto.encrypt('local-structured-data', new TextEncoder().encode('secret note'), new Uint8Array([1, 2, 3]))
    expect(envelope.algorithm).toBe('AES-GCM-256')
    expect(envelope.ciphertextAndTagB64Url).not.toContain('secret note')
    await expect(crypto.decrypt(envelope, new Uint8Array())).rejects.toThrow(/does not retain plaintext/u)
  })
})

class RecordingEnvelopeCryptoPort implements EnvelopeCryptoPort {
  readonly encrypted: Array<{ keyPurpose: LocalDataKeyPurpose; aad: Uint8Array; plaintextBytes: number }> = []

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    this.encrypted.push({ keyPurpose, aad: new Uint8Array(aad), plaintextBytes: plaintext.byteLength })
    return envelopeFixture
  }

  async decrypt(_envelope: EncryptedDataEnvelopeV1, _aad: Uint8Array): Promise<Uint8Array> {
    throw new Error('RecordingEnvelopeCryptoPort does not retain plaintext')
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'recording-test-key', newKeyId: 'recording-test-key-next' }
  }
}
