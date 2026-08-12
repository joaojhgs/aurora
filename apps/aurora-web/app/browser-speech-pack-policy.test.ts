import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserSpeechPackPolicyFromEnv,
  parseBrowserSpeechPackPolicy,
} from './browser-speech-pack-policy'

const RELEASE_KEY_ID = 'aurora-release-web-stt'
const RELEASE_PUBLIC_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const RELEASE_MANIFEST_SHA256 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

describe('browserSpeechPackPolicyFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns not configured only when all hosted STT trust anchors are absent', () => {
    expect(parseBrowserSpeechPackPolicy({})).toEqual({
      state: 'not-configured',
      trust: null,
    })
  })

  it('rejects partial hosted STT trust before storage access', () => {
    expect(parseBrowserSpeechPackPolicy({
      releaseKeyId: RELEASE_KEY_ID,
    })).toEqual({
      state: 'invalid',
      reason: 'partial',
      trust: null,
    })
  })

  it('validates key id, Ed25519 public key bytes, and manifest hash', () => {
    expect(parseBrowserSpeechPackPolicy({
      releaseKeyId: 'bad key',
      releasePublicKeyBase64: RELEASE_PUBLIC_KEY_BASE64,
      expectedManifestSha256: RELEASE_MANIFEST_SHA256,
    })).toEqual({ state: 'invalid', reason: 'key-id', trust: null })
    expect(parseBrowserSpeechPackPolicy({
      releaseKeyId: RELEASE_KEY_ID,
      releasePublicKeyBase64: 'AAAA',
      expectedManifestSha256: RELEASE_MANIFEST_SHA256,
    })).toEqual({ state: 'invalid', reason: 'public-key', trust: null })
    expect(parseBrowserSpeechPackPolicy({
      releaseKeyId: RELEASE_KEY_ID,
      releasePublicKeyBase64: RELEASE_PUBLIC_KEY_BASE64,
      expectedManifestSha256: 'not-a-hash',
    })).toEqual({ state: 'invalid', reason: 'expected-digest', trust: null })
  })

  it('normalizes complete public build-time trust anchors from direct NEXT_PUBLIC env references', () => {
    vi.stubEnv('NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_KEY_ID', ` ${RELEASE_KEY_ID} `)
    vi.stubEnv('NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_PUBLIC_KEY_BASE64', ` ${RELEASE_PUBLIC_KEY_BASE64} `)
    vi.stubEnv('NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_MANIFEST_SHA256', RELEASE_MANIFEST_SHA256.toUpperCase())

    expect(browserSpeechPackPolicyFromEnv()).toEqual({
      state: 'configured',
      trust: {
        releaseKeyId: RELEASE_KEY_ID,
        releasePublicKeyBase64: RELEASE_PUBLIC_KEY_BASE64,
        expectedManifestSha256: RELEASE_MANIFEST_SHA256,
      },
    })
  })
})
