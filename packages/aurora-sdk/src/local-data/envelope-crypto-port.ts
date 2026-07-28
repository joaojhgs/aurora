import type { EncryptedDataEnvelopeV1 } from './encrypted-envelope.js'

export type LocalDataKeyPurpose = 'local-structured-data'

export interface EnvelopeCryptoPort {
  encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1>
  decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array>
  rotateKey(keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }>
}

export class MemoryEnvelopeCryptoPort implements EnvelopeCryptoPort {
  readonly encrypted: Array<{ keyPurpose: LocalDataKeyPurpose; aad: Uint8Array; plaintextBytes: number }> = []

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    this.encrypted.push({ keyPurpose, aad: new Uint8Array(aad), plaintextBytes: plaintext.byteLength })
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'memory-session-key',
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: `memory${plaintext.byteLength.toString(16).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAA`,
      createdAtMs: 0
    }
  }

  async decrypt(_envelope: EncryptedDataEnvelopeV1, _aad: Uint8Array): Promise<Uint8Array> {
    throw new Error('MemoryEnvelopeCryptoPort does not retain plaintext')
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'memory-session-key', newKeyId: 'memory-session-key-next' }
  }
}
