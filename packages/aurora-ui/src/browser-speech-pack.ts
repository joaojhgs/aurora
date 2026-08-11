import {
  AuroraBrowserModelStoreHost,
  openActiveBrowserModelPack,
  type AuroraBrowserActiveModelPack,
  type AuroraBrowserModelPackReleaseTrustKey,
} from '@aurora/voice-web/browser'
import type { AuroraWebModelStoreHost } from '@aurora/voice-web'

export interface AuroraHostedBrowserSpeechPackTrustInput {
  readonly releaseKeyId: string
  readonly releasePublicKeyBase64: string
  readonly expectedManifestSha256: string
}

export type AuroraHostedBrowserSpeechPackStatus =
  | {
      readonly state: 'not-configured'
      readonly pack: null
    }
  | {
      readonly state: 'absent'
      readonly pack: null
    }
  | {
      readonly state: 'verified'
      readonly pack: AuroraBrowserActiveModelPack
    }
  | {
      readonly state: 'rejected'
      readonly reason: string
      readonly pack: null
    }
  | {
      readonly state: 'storage-unavailable'
      readonly reason: string
      readonly pack: null
    }

export interface AuroraHostedBrowserSpeechPackOptions {
  readonly trust?: AuroraHostedBrowserSpeechPackTrustInput | null | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly createHost?: () => Promise<AuroraWebModelStoreHost>
}

export async function openHostedBrowserSttSpeechPack(
  options: AuroraHostedBrowserSpeechPackOptions = {},
): Promise<AuroraHostedBrowserSpeechPackStatus> {
  const trust = normalizeTrustInput(options.trust ?? null)
  if (trust.state === 'not-configured') return Object.freeze({ state: 'not-configured', pack: null })
  if (trust.state === 'invalid') {
    return Object.freeze({
      state: 'rejected',
      reason: trust.reason,
      pack: null,
    })
  }

  let host: AuroraWebModelStoreHost | null
  try {
    host = options.createHost
      ? await options.createHost()
      : await AuroraBrowserModelStoreHost.openExisting(options.globalObject)
  } catch (error) {
    return Object.freeze({
      state: 'storage-unavailable',
      reason: safeReason(error, 'open'),
      pack: null,
    })
  }
  if (host === null) return Object.freeze({ state: 'absent', pack: null })

  try {
    const pack = await openActiveBrowserModelPack(host, { task: 'stt' }, {
      trustedReleaseKeys: [trust.releaseKey],
      expectedReleaseManifestSha256: trust.expectedManifestSha256,
    })
    if (!pack) return Object.freeze({ state: 'absent', pack: null })
    return Object.freeze({ state: 'verified', pack: freezePack(pack) })
  } catch (error) {
    if (isBrowserModelPackError(error)) {
      return Object.freeze({
        state: 'rejected',
        reason: error.code,
        pack: null,
      })
    }
    return Object.freeze({
      state: 'storage-unavailable',
      reason: safeReason(error, 'read'),
      pack: null,
    })
  }
}

type NormalizedTrustInput =
  | {
      readonly state: 'not-configured'
    }
  | {
      readonly state: 'invalid'
      readonly reason: 'key-id' | 'public-key' | 'manifest-sha256'
    }
  | {
      readonly state: 'valid'
      readonly releaseKey: AuroraBrowserModelPackReleaseTrustKey
      readonly expectedManifestSha256: string
    }

function normalizeTrustInput(
  input: AuroraHostedBrowserSpeechPackTrustInput | null,
): NormalizedTrustInput {
  if (!input) return { state: 'not-configured' }
  const keyId = input.releaseKeyId.trim()
  const publicKeyBase64 = input.releasePublicKeyBase64.trim()
  const expectedManifestSha256 = input.expectedManifestSha256.trim().toLowerCase()
  if (!SAFE_ID_RE.test(keyId)) return { state: 'invalid', reason: 'key-id' }
  if (!isSha256(expectedManifestSha256)) return { state: 'invalid', reason: 'manifest-sha256' }
  if (!isBase64ByteLength(publicKeyBase64, 32)) return { state: 'invalid', reason: 'public-key' }
  return {
    state: 'valid',
    releaseKey: {
      keyId,
      publicKeyBase64,
    },
    expectedManifestSha256,
  }
}

function freezePack(pack: AuroraBrowserActiveModelPack): AuroraBrowserActiveModelPack {
  const files = Object.freeze(pack.files.map((file) => Object.freeze(file)))
  return Object.freeze({
    identity: Object.freeze({
      ...pack.identity,
      scope: Object.freeze({ ...pack.identity.scope }),
    }),
    files,
  })
}

function isBrowserModelPackError(error: unknown): error is { readonly code: string } {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { readonly name?: unknown }).name === 'AuroraBrowserModelPackError'
    && typeof (error as { readonly code?: unknown }).code === 'string'
  )
}

function safeReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name) return error.name
  return fallback
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const SHA256_RE = /^[a-f0-9]{64}$/u

function isSha256(value: string): boolean {
  return SHA256_RE.test(value)
}

function isBase64ByteLength(value: string, expectedByteLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return false
  try {
    return atob(value).length === expectedByteLength
  } catch {
    return false
  }
}
