import {
  assertManifestShape,
  canonicalizeManifest,
  isManifestRevoked,
  type LocalSpeechManifestSignature,
  type LocalSpeechPackManifest
} from './manifest.js'

const verifiedManifestBrand: unique symbol = Symbol('LocalSpeechVerifiedManifest')

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export interface LocalSpeechTrustedKey {
  readonly keyId: string
  readonly algorithm: LocalSpeechManifestSignature['algorithm']
  readonly verify: (canonicalManifest: string, signature: LocalSpeechManifestSignature) => boolean | Promise<boolean>
}

export interface LocalSpeechTrustPolicy {
  readonly trustedKeys?: readonly LocalSpeechTrustedKey[]
  readonly revokedPackIds?: readonly string[]
  readonly revokedKeyIds?: readonly string[]
  readonly expectedManifestHash?: string
  readonly hashCanonicalManifest?: (canonicalManifest: string) => string | Promise<string>
}

export type LocalSpeechManifestVerificationMode = 'signature' | 'release-hash'

export interface LocalSpeechVerifiedManifest {
  readonly manifest: DeepReadonly<LocalSpeechPackManifest>
  readonly canonicalManifest: string
  readonly verificationMode: LocalSpeechManifestVerificationMode
  readonly keyId?: string
  readonly manifestHash?: string
  readonly [verifiedManifestBrand]: true
}

export function assertLocalSpeechVerifiedManifest(
  value: LocalSpeechVerifiedManifest
): asserts value is LocalSpeechVerifiedManifest {
  if (!value || value[verifiedManifestBrand] !== true || !Object.isFrozen(value) || !Object.isFrozen(value.manifest)) {
    throw new Error('local speech manifest was not verified by the trust boundary')
  }
}

export async function verifyLocalSpeechManifest(
  manifest: LocalSpeechPackManifest,
  policy: LocalSpeechTrustPolicy
): Promise<LocalSpeechVerifiedManifest> {
  assertManifestShape(manifest)
  if (isManifestRevoked(manifest) || policy.revokedPackIds?.includes(manifest.packId)) {
    throw new Error(`local speech manifest ${manifest.packId} is revoked`)
  }
  const canonicalManifest = canonicalizeManifest(manifest)
  const manifestHash = policy.hashCanonicalManifest
    ? await policy.hashCanonicalManifest(canonicalManifest)
    : undefined
  if (policy.expectedManifestHash && manifestHash !== policy.expectedManifestHash) {
    throw new Error('local speech manifest hash does not match release expectation')
  }

  const hashVerified = Boolean(policy.expectedManifestHash && policy.hashCanonicalManifest && manifestHash === policy.expectedManifestHash)
  if (manifest.signature) {
    if (policy.revokedKeyIds?.includes(manifest.signature.keyId)) {
      throw new Error(`local speech manifest key ${manifest.signature.keyId} is revoked`)
    }

    const key = (policy.trustedKeys ?? []).find(
      (candidate) =>
        candidate.keyId === manifest.signature?.keyId && candidate.algorithm === manifest.signature.algorithm
    )
    if (key) {
      const verified = await key.verify(canonicalManifest, manifest.signature)
      if (!verified) throw new Error('local speech manifest signature verification failed')
      return verifiedManifest({
        manifest,
        canonicalManifest,
        verificationMode: 'signature',
        keyId: key.keyId,
        ...(manifestHash ? { manifestHash } : {})
      })
    }
    if (!hashVerified) throw new Error(`local speech manifest key ${manifest.signature.keyId} is not trusted`)
  }

  if (!hashVerified) {
    throw new Error('local speech manifest is unsigned and no release hash policy matched')
  }

  return verifiedManifest({
    manifest,
    canonicalManifest,
    verificationMode: 'release-hash',
    ...(manifestHash ? { manifestHash } : {})
  })
}

function verifiedManifest(value: Omit<LocalSpeechVerifiedManifest, typeof verifiedManifestBrand>): LocalSpeechVerifiedManifest {
  const branded = {
    ...value,
    manifest: deepFreeze(structuredClone(value.manifest)),
    [verifiedManifestBrand]: true as const
  }
  return deepFreeze(branded)
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const property of Reflect.ownKeys(value)) {
      const child = (value as Record<PropertyKey, unknown>)[property]
      if (child && typeof child === 'object') deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}
