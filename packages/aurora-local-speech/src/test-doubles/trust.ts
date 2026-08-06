import type { LocalSpeechManifestSignature } from '../models/manifest.js'
import type { LocalSpeechTrustedKey } from '../models/trust.js'

export function createDeterministicTrustedKey(keyId = 'test-key'): LocalSpeechTrustedKey {
  return {
    keyId,
    algorithm: 'ed25519',
    verify(canonicalManifest: string, signature: LocalSpeechManifestSignature): boolean {
      return signature.keyId === keyId && signature.value === `signed:${canonicalManifest.length}`
    }
  }
}

export function deterministicManifestHash(canonicalManifest: string): string {
  return `length:${canonicalManifest.length}`
}
