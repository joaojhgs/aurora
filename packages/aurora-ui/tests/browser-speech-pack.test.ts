import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuroraWebModelStoreHost } from '@aurora/voice-web'

const voiceWeb = vi.hoisted(() => ({
  createHost: vi.fn(),
  openExistingHost: vi.fn(),
  openActive: vi.fn(),
}))

vi.mock('@aurora/voice-web/browser', () => ({
  AuroraBrowserModelStoreHost: {
    create: voiceWeb.createHost,
    openExisting: voiceWeb.openExistingHost,
  },
  openActiveBrowserModelPack: voiceWeb.openActive,
}))

import { openActiveBrowserSpeechPacks, openHostedBrowserSttSpeechPack } from '../src/browser-speech-pack'

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
    expect(voiceWeb.openExistingHost).not.toHaveBeenCalled()
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
    expect(voiceWeb.openExistingHost).not.toHaveBeenCalled()
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

  it('returns absent for complete trust with no existing browser store without verifying a pack', async () => {
    voiceWeb.openExistingHost.mockResolvedValueOnce(null)

    const result = await openHostedBrowserSttSpeechPack({
      trust: releaseTrust(),
    })

    expect(result).toEqual({ state: 'absent', pack: null })
    expect(voiceWeb.createHost).not.toHaveBeenCalled()
    expect(voiceWeb.openExistingHost).toHaveBeenCalledTimes(1)
    expect(voiceWeb.openActive).not.toHaveBeenCalled()
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
      models: [{
        task: 'stt',
        family: 'whisper',
        kind: 'offline-asr',
        files: [{
          role: 'tokens',
          fileId: 'tokens',
          virtualPath: '/models/stt/tokens.txt',
        }],
        config: { language: 'en' },
      }],
    }
    voiceWeb.openExistingHost.mockResolvedValueOnce(fakeModelStoreHost())
    voiceWeb.openActive.mockResolvedValueOnce(pack)

    const result = await openHostedBrowserSttSpeechPack({
      trust: releaseTrust(),
    })

    expect(result.state).toBe('verified')
    if (result.state !== 'verified') throw new Error('expected verified')
    expect(voiceWeb.createHost).not.toHaveBeenCalled()
    expect(voiceWeb.openExistingHost).toHaveBeenCalledTimes(1)
    expect(result.pack).toMatchObject({
      identity: {
        packId: 'aurora-stt',
        scope: { task: 'stt', slotId: 'default' },
      },
    })
    expect(Object.isFrozen(result.pack)).toBe(true)
    expect(Object.isFrozen(result.pack.files)).toBe(true)
    expect(Object.isFrozen(result.pack.files[0])).toBe(true)
    expect(result.pack.models).toEqual(pack.models)
    expect(Object.isFrozen(result.pack.models)).toBe(true)
    expect(Object.isFrozen(result.pack.models[0])).toBe(true)
    expect(Object.isFrozen(result.pack.models[0]?.files)).toBe(true)
    expect(Object.isFrozen(result.pack.models[0]?.files[0])).toBe(true)
    expect(Object.isFrozen(result.pack.models[0]?.config)).toBe(true)
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

describe('openActiveBrowserSpeechPacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not open browser storage until at least one exact task selection is configured', async () => {
    const result = await openActiveBrowserSpeechPacks()

    expect(result).toMatchObject({
      state: 'not-configured',
      capabilities: { vad: false, kws: false, stt: false, tts: false },
    })
    expect(voiceWeb.openExistingHost).not.toHaveBeenCalled()
    expect(voiceWeb.openActive).not.toHaveBeenCalled()
  })

  it('opens selected tasks with their own trust and combines cached model bindings', async () => {
    const host = fakeModelStoreHost()
    voiceWeb.openExistingHost.mockResolvedValueOnce(host)
    voiceWeb.openActive
      .mockResolvedValueOnce(modelPack('vad', 'vad-pack', 'vad-file', '/vad/model.onnx'))
      .mockResolvedValueOnce(modelPack('stt', 'stt-pack', 'stt-file', '/stt/model.onnx'))
      .mockResolvedValueOnce(modelPack('tts', 'tts-pack', 'tts-file', '/tts/model.onnx'))

    const result = await openActiveBrowserSpeechPacks({
      trustSelections: [
        { ...releaseTrust(), task: 'vad', packId: 'vad-pack', packVersion: '1.0.0' },
        { ...releaseTrust(), task: 'stt', packId: 'stt-pack', packVersion: '1.0.0' },
        { ...releaseTrust(), task: 'tts', packId: 'tts-pack', packVersion: '1.0.0', voiceId: 'voice-en' },
      ],
      tasks: ['vad', 'stt', 'tts'],
      ttsVoiceId: 'voice-en',
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.capabilities).toEqual({ vad: true, kws: false, stt: true, tts: true })
    expect(result.ttsVoiceId).toBe('voice-en')
    expect(result.modelBindings.models.map((model) => model.task)).toEqual(['vad', 'stt', 'tts'])
    expect(result.modelBindings.files.map((file) => file.fileId)).toEqual(['vad-file', 'stt-file', 'tts-file'])
    expect(voiceWeb.openActive).toHaveBeenNthCalledWith(1, host, { task: 'vad' }, expect.objectContaining({
      expectedReleaseManifestSha256: RELEASE_MANIFEST_SHA256,
    }))
    expect(voiceWeb.openActive).toHaveBeenNthCalledWith(2, host, { task: 'stt' }, expect.objectContaining({
      expectedReleaseManifestSha256: RELEASE_MANIFEST_SHA256,
    }))
    expect(voiceWeb.openActive).toHaveBeenNthCalledWith(3, host, { task: 'tts' }, expect.objectContaining({
      expectedReleaseManifestSha256: RELEASE_MANIFEST_SHA256,
    }))
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

function modelPack(task: 'vad' | 'kws' | 'stt' | 'tts', packId: string, fileId: string, virtualPath: string) {
  return {
    identity: {
      packId,
      packVersion: '1.0.0',
      variantId: 'web-wasm',
      scope: { task },
    },
    files: [{
      fileId,
      storageKey: `${packId}@${fileId}`,
      sha256: 'b'.repeat(64),
      byteLength: 4,
      readAll: async () => new Uint8Array([1, 2, 3, 4]),
      readChunk: async () => new Uint8Array([1]),
    }],
    models: [{
      task,
      family: task === 'tts' ? 'vits' : 'sherpa',
      kind: task === 'tts' ? 'offline-tts' : task === 'stt' ? 'offline-asr' : task,
      files: [{
        role: task === 'tts' ? 'model' : 'encoder',
        fileId,
        virtualPath,
      }],
      config: task === 'tts' ? { voiceId: 'voice-en' } : { language: 'en' },
    }],
  }
}
