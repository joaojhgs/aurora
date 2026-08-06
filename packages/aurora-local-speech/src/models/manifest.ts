export type LocalSpeechFeature = 'tts' | 'stt' | 'vad' | 'wakeword' | 'voice-state'
export type LocalSpeechRuntimeTarget = 'web' | 'desktop' | 'android' | 'ios'
export type LocalSpeechCompression = 'none' | 'gzip' | 'brotli' | 'zip'
export type LocalSpeechQualityTier = 'compact' | 'standard' | 'preview' | 'accurate'
export type LocalSpeechMemoryClass = 'low' | 'balanced' | 'high'
export type LocalSpeechRevocationReason = 'corrupt' | 'legal' | 'superseded' | 'security'

export interface LocalSpeechManifestSignature {
  readonly keyId: string
  readonly algorithm: 'ed25519' | 'ecdsa-p256-sha256'
  readonly value: string
}

export interface LocalSpeechRevocation {
  readonly revoked: boolean
  readonly reason: LocalSpeechRevocationReason
  readonly since: string
  readonly replacementPackId?: string
}

export interface LocalSpeechAssetManifest {
  readonly assetId: string
  readonly feature: LocalSpeechFeature
  readonly runtimeTarget: LocalSpeechRuntimeTarget
  readonly language: string
  readonly locale?: string
  readonly byteSize: number
  readonly url: string
  readonly sha256: string
  readonly compression: LocalSpeechCompression
  readonly unpackedSize?: number
  readonly dependencies?: readonly string[]
  readonly license: string
  readonly attribution: string
  readonly upstreamSource: string
  readonly upstreamRevision: string
  readonly redistribution: 'allowed' | 'restricted' | 'internal-only'
  readonly hardware?: {
    readonly webgpu?: boolean
    readonly simd?: boolean
    readonly threads?: boolean
    readonly memoryClass?: LocalSpeechMemoryClass
  }
  readonly raven?: {
    readonly canonicalConfigId: string
    readonly sourceCheckpointRevision: string
    readonly conversionRevision: string
    readonly architectureAbi: string
    readonly layerCount: number
    readonly precision: 'fp32' | 'fp16' | 'int8' | 'int4'
    readonly qualityTier: LocalSpeechQualityTier
    readonly tokenizerAssetId: string
    readonly textConditionerAssetId: string
    readonly bosAssetId: string
    readonly modelAssetId: string
    readonly defaultLsdSteps: number
    readonly defaultTemperature: number
    readonly defaultEos: string
    readonly voiceStateCompatibilityGroupId: string
  }
  readonly wakeword?: {
    readonly customizationMode: 'open-vocabulary' | 'imported-trained-classifier'
    readonly frontendAbi: string
    readonly classifierFamily: string
    readonly supportedLanguages: readonly string[]
    readonly sampleRate: number
    readonly windowSize: number
    readonly hopSize: number
    readonly phraseMetadata?: string
    readonly threshold: number
    readonly debounceMs: number
    readonly trainingToolRevision?: string
    readonly sanitizedEvaluationSummary?: string
  }
  readonly revocation?: LocalSpeechRevocation
}

export interface LocalSpeechPackManifest {
  readonly schemaVersion: 1
  readonly packId: string
  readonly packVersion: string
  readonly minAuroraVersion: string
  readonly minRuntimeVersion: string
  readonly minEngineVersion: string
  readonly starter: boolean
  readonly optional: boolean
  readonly createdAt: string
  readonly assets: readonly LocalSpeechAssetManifest[]
  readonly signature?: LocalSpeechManifestSignature
  readonly revocation?: LocalSpeechRevocation
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined }

export function canonicalizeManifest(manifest: LocalSpeechPackManifest): string {
  return canonicalizeJson(stripManifestSignature(manifest) as unknown as CanonicalJsonValue)
}

export function stripManifestSignature(manifest: LocalSpeechPackManifest): Omit<LocalSpeechPackManifest, 'signature'> {
  const { signature: _signature, ...unsigned } = manifest
  return unsigned
}

export function canonicalizeJson(value: CanonicalJsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }

  const objectValue = value as { readonly [key: string]: CanonicalJsonValue | undefined }
  const keys = Object.keys(value)
    .filter((key) => objectValue[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key] ?? null)}`).join(',')}}`
}

export function assertManifestShape(manifest: LocalSpeechPackManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error('unsupported local speech manifest schema')
  if (!manifest.packId.trim()) throw new Error('manifest packId is required')
  if (!manifest.packVersion.trim()) throw new Error('manifest packVersion is required')
  if (manifest.assets.length === 0) throw new Error('manifest must contain at least one asset')

  const assetIds = new Set<string>()
  for (const asset of manifest.assets) {
    if (assetIds.has(asset.assetId)) throw new Error(`duplicate asset id: ${asset.assetId}`)
    assetIds.add(asset.assetId)
    if (asset.byteSize <= 0 || !Number.isInteger(asset.byteSize)) {
      throw new Error(`asset ${asset.assetId} has invalid byte size`)
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`asset ${asset.assetId} has invalid sha256`)
    if (asset.revocation?.revoked) continue
    if (!asset.url.startsWith('https://') && !asset.url.startsWith('/')) {
      throw new Error(`asset ${asset.assetId} must use https or same-origin URL`)
    }
  }

  for (const asset of manifest.assets) {
    for (const dependency of asset.dependencies ?? []) {
      if (!assetIds.has(dependency)) throw new Error(`asset ${asset.assetId} depends on unknown asset ${dependency}`)
    }
  }

  const assetsById = new Map(manifest.assets.map((asset) => [asset.assetId, asset] as const))
  const revokedAssetIds = new Set(
    manifest.assets.filter((asset) => asset.revocation?.revoked === true).map((asset) => asset.assetId)
  )
  for (const asset of manifest.assets) {
    if (asset.revocation?.revoked === true) continue
    if (asset.raven) {
      const ravenReferences = [
        ['tokenizerAssetId', asset.raven.tokenizerAssetId],
        ['textConditionerAssetId', asset.raven.textConditionerAssetId],
        ['bosAssetId', asset.raven.bosAssetId],
        ['modelAssetId', asset.raven.modelAssetId]
      ] as const
      for (const [field, referencedAssetId] of ravenReferences) {
        const referencedAsset = assetsById.get(referencedAssetId)
        if (!referencedAsset) {
          throw new Error(`Raven ${field} references unknown asset ${referencedAssetId}`)
        }
        if (referencedAsset.revocation?.revoked === true) {
          throw new Error(`Raven ${field} references revoked asset ${referencedAssetId}`)
        }
      }
      if (asset.raven.modelAssetId !== asset.assetId) {
        throw new Error(`Raven modelAssetId must match containing asset ${asset.assetId}`)
      }
      const dependencies = new Set(asset.dependencies ?? [])
      for (const referencedAssetId of [
        asset.raven.tokenizerAssetId,
        asset.raven.textConditionerAssetId,
        asset.raven.bosAssetId
      ]) {
        if (!dependencies.has(referencedAssetId)) {
          throw new Error(`Raven asset ${asset.assetId} must declare dependency ${referencedAssetId}`)
        }
      }
    }
    const revokedDependency = (asset.dependencies ?? []).find((dependency) => revokedAssetIds.has(dependency))
    if (revokedDependency) {
      throw new Error(`active asset ${asset.assetId} depends on revoked asset ${revokedDependency}`)
    }
  }
}

export function listActiveAssets(manifest: LocalSpeechPackManifest): readonly LocalSpeechAssetManifest[] {
  return manifest.assets.filter((asset) => asset.revocation?.revoked !== true)
}

export function isManifestRevoked(manifest: LocalSpeechPackManifest): boolean {
  return manifest.revocation?.revoked === true
}
