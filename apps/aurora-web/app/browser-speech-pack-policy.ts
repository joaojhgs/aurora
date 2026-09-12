import type { AuroraHostedBrowserSpeechPackTrustInput } from '@aurora/ui'

export type BrowserSpeechPackPolicy =
  | {
      readonly state: 'not-configured'
      readonly trust: null
    }
  | {
      readonly state: 'invalid'
      readonly reason: 'partial' | 'key-id' | 'public-key' | 'expected-digest'
      readonly trust: null
    }
  | {
      readonly state: 'configured'
      readonly trust: AuroraHostedBrowserSpeechPackTrustInput
    }

export function browserSpeechPackPolicyFromEnv(): BrowserSpeechPackPolicy {
  return parseBrowserSpeechPackPolicy({
    releaseKeyId: process.env.NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_KEY_ID,
    releasePublicKeyBase64: process.env.NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_PUBLIC_KEY_BASE64,
    expectedManifestSha256: process.env.NEXT_PUBLIC_AURORA_BROWSER_STT_PACK_MANIFEST_SHA256,
  })
}

export function parseBrowserSpeechPackPolicy(input: {
  readonly releaseKeyId?: string | null | undefined
  readonly releasePublicKeyBase64?: string | null | undefined
  readonly expectedManifestSha256?: string | null | undefined
}): BrowserSpeechPackPolicy {
  const releaseKeyId = normalizeEnvValue(input.releaseKeyId)
  const releasePublicKeyBase64 = normalizeEnvValue(input.releasePublicKeyBase64)
  const expectedManifestSha256 = normalizeEnvValue(input.expectedManifestSha256)?.toLowerCase() ?? null
  const values = [releaseKeyId, releasePublicKeyBase64, expectedManifestSha256]
  const presentCount = values.filter((value) => value !== null).length
  if (presentCount === 0) return Object.freeze({ state: 'not-configured', trust: null })
  if (presentCount !== values.length) {
    return Object.freeze({ state: 'invalid', reason: 'partial', trust: null })
  }
  if (!releaseKeyId || !SAFE_ID_RE.test(releaseKeyId)) {
    return Object.freeze({ state: 'invalid', reason: 'key-id', trust: null })
  }
  if (!releasePublicKeyBase64 || !isBase64ByteLength(releasePublicKeyBase64, 32)) {
    return Object.freeze({ state: 'invalid', reason: 'public-key', trust: null })
  }
  if (!expectedManifestSha256 || !SHA256_RE.test(expectedManifestSha256)) {
    return Object.freeze({ state: 'invalid', reason: 'expected-digest', trust: null })
  }
  return Object.freeze({
    state: 'configured',
    trust: Object.freeze({
      releaseKeyId,
      releasePublicKeyBase64,
      expectedManifestSha256,
    }),
  })
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const SHA256_RE = /^[a-f0-9]{64}$/u

function normalizeEnvValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function isBase64ByteLength(value: string, expectedByteLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return false
  try {
    return atob(value).length === expectedByteLength
  } catch {
    return false
  }
}
