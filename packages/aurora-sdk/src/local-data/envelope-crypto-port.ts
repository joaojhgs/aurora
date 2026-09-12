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
