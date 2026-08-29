import {
  parseEncryptedDataEnvelopeV1,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose
} from '../../../../packages/aurora-sdk/src/local-data/index.js'
import { invokeAuroraLocalDataCommand } from './tauri-local-data-invoke.js'

export interface TauriEnvelopeCryptoPortOptions {
  readonly profileId: string
  readonly localNodeId: string
  readonly invokeCommand?: (command: string, args: Record<string, unknown>) => Promise<unknown>
}

export class TauriEnvelopeCryptoPort implements EnvelopeCryptoPort {
  private readonly profileId: string
  private readonly localNodeId: string
  private readonly invokeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>

  constructor(options: TauriEnvelopeCryptoPortOptions) {
    this.profileId = options.profileId
    this.localNodeId = options.localNodeId
    this.invokeCommand = options.invokeCommand ?? invokeAuroraLocalDataCommand
  }

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    assertLocalDataPurpose(keyPurpose)
    const value = await this.invokeCommand('aurora_local_data_envelope_encrypt', {
      request: {
        keyPurpose,
        profileId: this.profileId,
        localNodeId: this.localNodeId,
        plaintextB64Url: base64UrlEncode(plaintext),
        aadB64Url: base64UrlEncode(aad)
      }
    })
    return parseEncryptedDataEnvelopeV1(value)
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    const parsed = parseEncryptedDataEnvelopeV1(envelope)
    const value = await this.invokeCommand('aurora_local_data_envelope_decrypt', {
      request: {
        profileId: this.profileId,
        localNodeId: this.localNodeId,
        envelope: parsed,
        aadB64Url: base64UrlEncode(aad)
      }
    })
    return parseDecryptResponse(value)
  }

  async rotateKey(keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    assertLocalDataPurpose(keyPurpose)
    const value = await this.invokeCommand('aurora_local_data_envelope_rotate', {
      request: {
        keyPurpose,
        profileId: this.profileId,
        localNodeId: this.localNodeId
      }
    })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local data key rotation response')
    const record = value as { previousKeyId?: unknown; newKeyId?: unknown }
    if (typeof record.previousKeyId !== 'string' || typeof record.newKeyId !== 'string') {
      throw new Error('Invalid local data key rotation response')
    }
    return { previousKeyId: record.previousKeyId, newKeyId: record.newKeyId }
  }
}

function parseDecryptResponse(value: unknown): Uint8Array {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local data decrypt response')
  const plaintextB64Url = (value as { plaintextB64Url?: unknown }).plaintextB64Url
  if (typeof plaintextB64Url !== 'string') throw new Error('Invalid local data decrypt response')
  return base64UrlDecode(plaintextB64Url)
}

function assertLocalDataPurpose(value: LocalDataKeyPurpose): void {
  if (value !== 'local-structured-data') throw new Error('Unsupported local data key purpose')
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string): Uint8Array {
  if (value.includes('=')) throw new Error('Invalid base64url value')
  const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (base64UrlEncode(bytes) !== value) throw new Error('Invalid base64url value')
  return bytes
}
