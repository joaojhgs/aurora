import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuroraWebModelStoreHost } from '@aurora/voice-web'

const voiceWeb = vi.hoisted(() => ({
  createHost: vi.fn(),
  openActive: vi.fn(),
}))

vi.mock('@aurora/voice-web/browser', () => ({
  AuroraBrowserModelStoreHost: {
    create: voiceWeb.createHost,
  },
  openActiveBrowserModelPack: voiceWeb.openActive,
}))

import { openHostedBrowserSttSpeechPack } from '../src/browser-speech-pack'

const RELEASE_KEY_ID = 'aurora-release-web-stt'
const RELEASE_PUBLIC_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const RELEASE_MANIFEST_SHA256 = 'a'.repeat(64)

describe('openHostedBrowserSttSpeechPack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not open browser storage when production trust is not configured', async () => {
    const result = await openHostedBrowserSttSpeechPack()

    expect(result).toEqual({ state: 'not-configured', pack: null })
    expect(voiceWeb.createHost).not.toHaveBeenCalled()
    expect(voiceWeb.openActive).not.toHaveBeenCalled()
  })

  it('rejects malformed trust before opening browser storage', async () => {
    const result = await openHostedBrowserSttSpeechPack({
      trust: {
        releaseKeyId: RELEASE_KEY_ID,
        releasePublicKeyBase64: 'not-base64',
        expectedManifestSha256: RELEASE_MANIFEST_SHA256,
      },
    })

    expect(result).toEqual({ state: 'rejected', reason: 'public-key', pack: null })
    expect(voiceWeb.createHost).not.toHaveBeenCalled()
    expect(voiceWeb.openActive).not.toHaveBeenCalled()
  })

  it('opens only the hosted STT scope with exact release trust options', async () => {
    const host = fakeModelStoreHost()
    const createHost = vi.fn(async () => host)
    voiceWeb.openActive.mockResolvedValueOnce(null)

    const result = await openHostedBrowserSttSpeechPack({
      trust: releaseTrust(),
      createHost,
    })

    expect(result).toEqual({ state: 'absent', pack: null })
    expect(createHost).toHaveBeenCalledTimes(1)
    expect(voiceWeb.openActive).toHaveBeenCalledWith(host, { task: 'stt' }, {
      trustedReleaseKeys: [{
        keyId: RELEASE_KEY_ID,
        publicKeyBase64: RELEASE_PUBLIC_KEY_BASE64,
      }],
      expectedReleaseManifestSha256: RELEASE_MANIFEST_SHA256,
    })
    expect(voiceWeb.openActive.mock.calls[0]?.[2]).not.toHaveProperty('allowNonProductionTestSignature')
  })

  it('returns an immutable handle only for a verified preinstalled pack', async () => {
    const pack = {
      identity: {
        packId: 'aurora-stt',
        packVersion: '1.0.0',
        variantId: 'web-wasm',
        scope: { task: 'stt', slotId: 'default' },
      },
      files: [{
        fileId: 'model',
        storageKey: 'pack@model',
        sha256: 'b'.repeat(64),
        byteLength: 4,
        readAll: async () => new Uint8Array([1, 2, 3, 4]),
        readChunk: async () => new Uint8Array([1]),
      }],
    }
    voiceWeb.openActive.mockResolvedValueOnce(pack)

    const result = await openHostedBrowserSttSpeechPack({
      trust: releaseTrust(),
      createHost: vi.fn(async () => fakeModelStoreHost()),
    })

    expect(result.state).toBe('verified')
    if (result.state !== 'verified') throw new Error('expected verified')
    expect(result.pack).toMatchObject({
      identity: {
        packId: 'aurora-stt',
        scope: { task: 'stt', slotId: 'default' },
      },
    })
    expect(Object.isFrozen(result.pack)).toBe(true)
    expect(Object.isFrozen(result.pack.files)).toBe(true)
    expect(Object.isFrozen(result.pack.files[0])).toBe(true)
  })

  it('keeps corrupted or tampered packs rejected instead of treating them as absent', async () => {
    const error = Object.assign(new Error('aurora_voice_web_model_pack:corrupt'), {
      name: 'AuroraBrowserModelPackError',
      code: 'corrupt',
    })
    voiceWeb.openActive.mockRejectedValueOnce(error)

    const result = await openHostedBrowserSttSpeechPack({
      trust: releaseTrust(),
      createHost: vi.fn(async () => fakeModelStoreHost()),
    })

    expect(result).toEqual({ state: 'rejected', reason: 'corrupt', pack: null })
  })
})

function releaseTrust() {
  return {
    releaseKeyId: RELEASE_KEY_ID,
    releasePublicKeyBase64: RELEASE_PUBLIC_KEY_BASE64,
    expectedManifestSha256: RELEASE_MANIFEST_SHA256,
  }
}

function fakeModelStoreHost(): AuroraWebModelStoreHost {
  return {
    persistenceReport: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    deleteJson: vi.fn(),
    listJsonKeys: vi.fn(),
    stagingLen: vi.fn(),
    readStagingChunk: vi.fn(),
    appendStaging: vi.fn(),
    clearStaging: vi.fn(),
    promotedStat: vi.fn(),
    readPromotedChunk: vi.fn(),
    promoteStagingAtomic: vi.fn(),
    deletePromoted: vi.fn(),
    listPromotedKeys: vi.fn(),
    removePackData: vi.fn(),
  }
}
