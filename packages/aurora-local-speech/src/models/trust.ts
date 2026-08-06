import {
  assertManifestShape,
  canonicalizeManifest,
  isManifestRevoked,
  type LocalSpeechManifestSignature,
  type LocalSpeechPackManifest
} from './manifest.js'

export interface LocalSpeechTrustedKey {
  readonly keyId: string
  readonly algorithm: LocalSpeechManifestSignature['algorithm']
  readonly verify: (canonicalManifest: string, signature: LocalSpeechManifestSignature) => boolean | Promise<boolean>
}

export interface LocalSpeechTrustPolicy {
  readonly trustedKeys: readonly LocalSpeechTrustedKey[]
  readonly revokedPackIds?: readonly string[]
  readonly revokedKeyIds?: readonly string[]
  readonly expectedManifestHash?: string
  readonly hashCanonicalManifest?: (canonicalManifest: string) => string | Promise<string>
}

export interface LocalSpeechVerifiedManifest {
  readonly manifest: LocalSpeechPackManifest
  readonly canonicalManifest: string
  readonly keyId: string
  readonly manifestHash?: string
}

export async function verifyLocalSpeechManifest(
  manifest: LocalSpeechPackManifest,
  policy: LocalSpeechTrustPolicy
): Promise<LocalSpeechVerifiedManifest> {
  assertManifestShape(manifest)
  if (isManifestRevoked(manifest) || policy.revokedPackIds?.includes(manifest.packId)) {
    throw new Error(`local speech manifest ${manifest.packId} is revoked`)
  }
  if (!manifest.signature) throw new Error('local speech manifest is unsigned')
  if (policy.revokedKeyIds?.includes(manifest.signature.keyId)) {
    throw new Error(`local speech manifest key ${manifest.signature.keyId} is revoked`)
  }

  const key = policy.trustedKeys.find(
    (candidate) =>
      candidate.keyId === manifest.signature?.keyId && candidate.algorithm === manifest.signature.algorithm
  )
  if (!key) throw new Error(`local speech manifest key ${manifest.signature.keyId} is not trusted`)

  const canonicalManifest = canonicalizeManifest(manifest)
  const manifestHash = policy.hashCanonicalManifest
    ? await policy.hashCanonicalManifest(canonicalManifest)
    : undefined
  if (policy.expectedManifestHash && manifestHash !== policy.expectedManifestHash) {
    throw new Error('local speech manifest hash does not match release expectation')
  }

  const verified = await key.verify(canonicalManifest, manifest.signature)
  if (!verified) throw new Error('local speech manifest signature verification failed')

  return {
    manifest,
    canonicalManifest,
    keyId: key.keyId,
    ...(manifestHash ? { manifestHash } : {})
  }
}
