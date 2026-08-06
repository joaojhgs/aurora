import { describe, expect, it } from 'vitest'

import {
  canonicalizeManifest,
  verifyLocalSpeechManifest,
  type LocalSpeechPackManifest
} from '../src/index.js'
import {
  createDeterministicTrustedKey,
  deterministicManifestHash
} from '../src/test-doubles/index.js'

const assetHash = 'a'.repeat(64)

function manifest(overrides: Partial<LocalSpeechPackManifest> = {}): LocalSpeechPackManifest {
  const unsigned: LocalSpeechPackManifest = {
    schemaVersion: 1,
    packId: 'raven-en-starter',
    packVersion: '2026.08.06',
    minAuroraVersion: '0.1.0',
    minRuntimeVersion: '0.1.0',
    minEngineVersion: '0.1.0',
    starter: true,
    optional: false,
    createdAt: '2026-08-06T00:00:00Z',
    assets: [
      {
        assetId: 'raven-en-model',
        feature: 'tts',
        runtimeTarget: 'web',
        language: 'en',
        locale: 'en-US',
        byteSize: 1024,
        url: '/speech/raven-en-model.bin',
        sha256: assetHash,
        compression: 'none',
        license: 'test-license',
        attribution: 'Aurora test fixture',
        upstreamSource: 'aurora-test',
        upstreamRevision: 'fixture-1',
        redistribution: 'internal-only',
        raven: {
          canonicalConfigId: 'pockettts-raven-en-6l',
          sourceCheckpointRevision: 'source-1',
          conversionRevision: 'conversion-1',
          architectureAbi: 'raven-v1',
          layerCount: 6,
          precision: 'fp16',
          qualityTier: 'compact',
          tokenizerAssetId: 'tokenizer',
          textConditionerAssetId: 'conditioner',
          bosAssetId: 'bos',
          modelAssetId: 'raven-en-model',
          defaultLsdSteps: 8,
          defaultTemperature: 0.8,
          defaultEos: '</s>',
          voiceStateCompatibilityGroupId: 'raven-en-v1'
        }
      }
    ]
  }
  const withOverrides = { ...unsigned, ...overrides }
  return {
    ...withOverrides,
    signature: {
      keyId: 'test-key',
      algorithm: 'ed25519',
      value: `signed:${canonicalizeManifest(withOverrides).length}`
    }
  }
}

describe('local speech manifests', () => {
  it('canonicalizes manifests without signature material', () => {
    const first = manifest()
    const second = {
      ...first,
      signature: { keyId: 'test-key', algorithm: 'ed25519' as const, value: 'different' }
    }

    expect(canonicalizeManifest(first)).toBe(canonicalizeManifest(second))
  })

  it('verifies trusted signed manifests against the release hash', async () => {
    const trustedManifest = manifest()
    const verified = await verifyLocalSpeechManifest(trustedManifest, {
      trustedKeys: [createDeterministicTrustedKey()],
      hashCanonicalManifest: deterministicManifestHash,
      expectedManifestHash: deterministicManifestHash(canonicalizeManifest(trustedManifest))
    })

    expect(verified.manifest.packId).toBe('raven-en-starter')
    expect(verified.keyId).toBe('test-key')
    expect(verified.verificationMode).toBe('signature')
    expect(Object.isFrozen(verified.manifest.assets[0])).toBe(true)
  })

  it('allows unsigned manifests only when a release hash policy matches', async () => {
    const { signature: _signature, ...unsigned } = manifest()
    const verified = await verifyLocalSpeechManifest(unsigned, {
      hashCanonicalManifest: deterministicManifestHash,
      expectedManifestHash: deterministicManifestHash(canonicalizeManifest(unsigned))
    })

    expect(verified.verificationMode).toBe('release-hash')
    expect(verified.keyId).toBeUndefined()
  })

  it('rejects unsigned manifests when no release hash policy is configured', async () => {
    const { signature: _signature, ...unsigned } = manifest()

    await expect(
      verifyLocalSpeechManifest(unsigned, {})
    ).rejects.toThrow(/unsigned/)
  })

  it('rejects revoked packs before activation', async () => {
    await expect(
      verifyLocalSpeechManifest(manifest({ revocation: { revoked: true, reason: 'legal', since: '2026-08-06' } }), {
        trustedKeys: [createDeterministicTrustedKey()]
      })
    ).rejects.toThrow(/revoked/)
  })

  it('rejects unsigned packs before activation', async () => {
    const { signature: _signature, ...unsigned } = manifest()

    await expect(
      verifyLocalSpeechManifest(unsigned, {
        trustedKeys: [createDeterministicTrustedKey()]
      })
    ).rejects.toThrow(/unsigned/)
  })

  it('rejects incomplete asset dependency graphs', async () => {
    const broken = manifest({
      assets: [
        {
          ...manifest().assets[0]!,
          dependencies: ['missing-tokenizer']
        }
      ]
    })

    await expect(
      verifyLocalSpeechManifest(broken, { trustedKeys: [createDeterministicTrustedKey()] })
    ).rejects.toThrow(/unknown asset/)
  })
})
