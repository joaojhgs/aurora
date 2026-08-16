import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuroraVoiceWebModelDescriptor, AuroraWebModelStoreHost } from '@aurora/voice-web'

const voiceWeb = vi.hoisted(() => ({
  createHost: vi.fn(),
  openExistingHost: vi.fn(),
  openActive: vi.fn(),
  listCatalog: vi.fn(),
  findCatalogEntry: vi.fn(),
  installPack: vi.fn(),
}))

vi.mock('@aurora/voice-web/browser', () => ({
  AuroraBrowserModelStoreHost: {
    create: voiceWeb.createHost,
    openExisting: voiceWeb.openExistingHost,
  },
  openActiveBrowserModelPack: voiceWeb.openActive,
  listAuroraBrowserVoiceCatalogEntries: voiceWeb.listCatalog,
  findAuroraBrowserVoiceCatalogEntry: voiceWeb.findCatalogEntry,
  installVerifiedBrowserModelPack: voiceWeb.installPack,
}))

import {
  createAuroraBrowserVoiceCatalogPort,
  decodeAuroraPocketReferenceWav,
  deleteAuroraBrowserPocketReferenceProfile,
  listAuroraBrowserPocketReferenceProfiles,
  openActiveBrowserSpeechPacks,
  openHostedBrowserSttSpeechPack,
  readAuroraBrowserPocketReferenceProfile,
  saveAuroraBrowserPocketReferenceProfile,
} from '../src/browser-speech-pack'

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

  it('activates internal-mode Pocket packs without a user reference profile', async () => {
    const host = fakeModelStoreHost()
    voiceWeb.openExistingHost.mockResolvedValueOnce(host)
    const pack = modelPack('tts', 'pocket-internal', 'tts-file', '/tts/model.onnx', 'pockettts')
    const model = pack.models[0]
    if (model === undefined) throw new Error('expected model')
    pack.models[0] = {
      ...model,
      files: [
        ...model.files,
        { role: 'referenceAudio', fileId: 'reference-audio', virtualPath: '/internal_reference.wav' },
      ],
      config: { voiceId: 'standard:pockettts:aurora-pockettts-en-2026-04', referenceAudioMode: 'internal', referenceSampleRateHz: 24_000 },
    }
    pack.files.push({
      fileId: 'reference-audio',
      storageKey: 'pocket-internal@reference-audio',
      sha256: 'd'.repeat(64),
      byteLength: 4,
      readAll: async () => new Uint8Array([1, 2, 3, 4]),
      readChunk: async () => new Uint8Array([1]),
    })
    voiceWeb.openActive.mockResolvedValueOnce(pack)

    const result = await openActiveBrowserSpeechPacks({
      trustSelections: [
        { ...releaseTrust(), task: 'tts', packId: 'pocket-internal', packVersion: '1.0.0', voiceId: 'standard:pockettts:aurora-pockettts-en-2026-04' },
      ],
      tasks: ['tts'],
      ttsVoiceId: 'standard:pockettts:aurora-pockettts-en-2026-04',
      loadReferenceProfile: vi.fn(),
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.capabilities.tts).toBe(true)
    expect(result.modelBindings.models[0]?.config).toMatchObject({
      referenceAudioMode: 'internal',
      referenceSampleRateHz: 24_000,
    })
    expect(result.modelBindings.files.some((file) => file.fileId.startsWith('reference-audio:'))).toBe(false)
  })

  it('keeps Pocket voices unavailable until an explicit reference profile is selected', async () => {
    const host = fakeModelStoreHost()
    voiceWeb.openExistingHost.mockResolvedValueOnce(host)
    voiceWeb.openActive.mockResolvedValueOnce(modelPack('tts', 'pocket-pack', 'tts-file', '/tts/model.onnx', 'pockettts'))

    const result = await openActiveBrowserSpeechPacks({
      trustSelections: [
        { ...releaseTrust(), task: 'tts', packId: 'pocket-pack', packVersion: '1.0.0', voiceId: 'pocket.en' },
      ],
      tasks: ['tts'],
      ttsVoiceId: 'pocket.en',
      loadReferenceProfile: vi.fn(),
    })

    expect(result).toMatchObject({
      state: 'absent',
      capabilities: { vad: false, kws: false, stt: false, tts: false },
    })
  })

  it('attaches explicit Pocket reference audio without written sample words', async () => {
    const host = fakeModelStoreHost()
    const audioBytes = wavBytes({ sampleRateHz: 16_000, durationMs: 1_000 })
    voiceWeb.openExistingHost.mockResolvedValueOnce(host)
    voiceWeb.openActive.mockResolvedValueOnce(modelPack('tts', 'pocket-pack', 'tts-file', '/tts/model.onnx', 'pockettts'))

    const result = await openActiveBrowserSpeechPacks({
      trustSelections: [
        { ...releaseTrust(), task: 'tts', packId: 'pocket-pack', packVersion: '1.0.0', voiceId: 'pocket.en', referenceProfileId: 'voice-ref-1' },
      ],
      tasks: ['tts'],
      ttsVoiceId: 'pocket.en',
      loadReferenceProfile: vi.fn(async () => ({
        id: 'voice-ref-1',
        label: 'Voice sample',
        transcript: '',
        sampleRateHz: 16_000,
        durationMs: 1_000,
        byteLength: audioBytes.byteLength,
        sha256: 'c'.repeat(64),
        createdAtMs: 1,
        updatedAtMs: 1,
        audioBytes,
      })),
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.capabilities.tts).toBe(true)
    expect(result.modelBindings.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task: 'tts',
        fileId: 'reference-audio:voice-ref-1',
        virtualPath: '/aurora/reference/voice-ref-1.wav',
        bytes: audioBytes,
      }),
    ]))
    expect(result.modelBindings.models[0]).toMatchObject({
      family: 'pockettts',
      files: expect.arrayContaining([
        expect.objectContaining({ role: 'referenceAudio', fileId: 'reference-audio:voice-ref-1' }),
      ]),
      config: expect.objectContaining({
        referenceSampleRateHz: 16_000,
      }),
    })
    expect(result.modelBindings.models[0]?.config).not.toHaveProperty('referenceText')
    expect(result.revision).toContain('reference-audio:voice-ref-1')
  })

  it('does not forward stored clone words as Sherpa reference text', async () => {
    const audioBytes = wavBytes({ sampleRateHz: 16_000, durationMs: 1_000 })
    voiceWeb.openActive.mockResolvedValueOnce(modelPack('tts', 'pocket-pack', 'tts-file', '/tts/model.onnx', 'pockettts'))

    const result = await openActiveBrowserSpeechPacks({
      trustSelections: [
        { ...releaseTrust(), task: 'tts', packId: 'pocket-pack', packVersion: '1.0.0', voiceId: 'pocket.en', referenceProfileId: 'voice-ref-1' },
      ],
      tasks: ['tts'],
      ttsVoiceId: 'pocket.en',
      loadReferenceProfile: vi.fn(async () => ({
        id: 'voice-ref-1',
        label: 'Voice sample',
        transcript: 'legacy spoken words',
        sampleRateHz: 16_000,
        durationMs: 1_000,
        byteLength: audioBytes.byteLength,
        sha256: 'c'.repeat(64),
        createdAtMs: 1,
        updatedAtMs: 1,
        audioBytes,
      })),
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready')
    expect(result.modelBindings.models[0]?.config).toMatchObject({
      referenceSampleRateHz: 16_000,
    })
    expect(result.modelBindings.models[0]?.config).not.toHaveProperty('referenceText')
  })
})

describe('AuroraBrowserPocketReferenceProfile store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => 'voice-ref-1',
        subtle: {
          digest: async () => new Uint8Array(32).fill(0xcc).buffer,
        },
      },
    })
  })

  it('saves normalized PCM WAV audio outside JSON records and can read and delete it', async () => {
    const host = memoryModelStoreHost()
    const audioBytes = wavBytes({ sampleRateHz: 16_000, durationMs: 1_000 })

    const saved = await saveAuroraBrowserPocketReferenceProfile({
      audioBytes,
      filename: 'my voice.wav',
      transcript: '  hello   from me  ',
    }, { createHost: async () => host })
    const listed = await listAuroraBrowserPocketReferenceProfiles({ createHost: async () => host })
    const loaded = await readAuroraBrowserPocketReferenceProfile(saved.id, { createHost: async () => host })

    expect(saved).toMatchObject({
      id: 'voice-ref-1',
      label: 'my voice.wav',
      transcript: 'hello from me',
      sampleRateHz: 16_000,
      durationMs: 1_000,
      byteLength: audioBytes.byteLength,
      sha256: 'c'.repeat(64),
    })
    expect(listed).toEqual([saved])
    expect(loaded?.audioBytes).toEqual(audioBytes)
    expect([...host.json.values()].join(' ')).not.toContain('RIFF')
    expect([...host.json.values()].join(' ')).not.toContain(String.fromCharCode(...audioBytes.slice(0, 12)))

    await deleteAuroraBrowserPocketReferenceProfile(saved.id, { createHost: async () => host })
    expect(await listAuroraBrowserPocketReferenceProfiles({ createHost: async () => host })).toEqual([])
    expect(await readAuroraBrowserPocketReferenceProfile(saved.id, { createHost: async () => host })).toBeNull()
  })

  it('saves a voice sample without written sample words', async () => {
    const host = memoryModelStoreHost()
    const audioBytes = wavBytes({ sampleRateHz: 16_000, durationMs: 1_000 })

    const saved = await saveAuroraBrowserPocketReferenceProfile({
      audioBytes,
      filename: 'my voice.wav',
    }, { createHost: async () => host })

    expect(saved.transcript).toBe('')
    const loaded = await readAuroraBrowserPocketReferenceProfile(saved.id, { createHost: async () => host })
    expect(loaded?.transcript).toBe('')
    expect(loaded?.audioBytes).toEqual(audioBytes)
  })

  it('decodes validated mono PCM WAV samples for native adapters', () => {
    const decoded = decodeAuroraPocketReferenceWav(wavBytes({ sampleRateHz: 24_000, durationMs: 1_000 }))

    expect(decoded.sampleRateHz).toBe(24_000)
    expect(decoded.durationMs).toBe(1_000)
    expect(decoded.normalizedBytes.slice(0, 12)).toEqual(new Uint8Array([82, 73, 70, 70, 164, 187, 0, 0, 87, 65, 86, 69]))
    expect(decoded.samples).toBeInstanceOf(Float32Array)
    expect(decoded.samples).toHaveLength(24_000)
  })

  it('rejects unsupported reference audio before writing browser storage', async () => {
    const host = memoryModelStoreHost()

    await expect(saveAuroraBrowserPocketReferenceProfile({
      audioBytes: wavBytes({ sampleRateHz: 16_000, durationMs: 1_000, channels: 2 }),
      transcript: 'hello',
    }, { createHost: async () => host })).rejects.toThrow('voice_sample_format')

    expect(host.writeJson).not.toHaveBeenCalled()
    expect(host.appendStaging).not.toHaveBeenCalled()
  })
})

describe('createAuroraBrowserVoiceCatalogPort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists generated catalog entries and installs with embedded catalog trust', async () => {
    const host = fakeModelStoreHost()
    const entry = catalogEntry('standard:piper:en-us-test')
    voiceWeb.openExistingHost.mockResolvedValueOnce(null)
    voiceWeb.createHost.mockResolvedValueOnce(host)
    voiceWeb.listCatalog.mockReturnValueOnce([entry])
    voiceWeb.findCatalogEntry.mockReturnValueOnce(entry)
    voiceWeb.installPack.mockResolvedValueOnce({
      identity: {
        packId: 'standard:piper:en-us-test',
        packVersion: '1.0.0',
        variantId: 'web-wasm32',
        scope: { task: 'tts', slotId: 'default' },
      },
      files: [],
      manifestSha256: RELEASE_MANIFEST_SHA256,
      verificationMode: 'embedded-catalog',
      verificationKeyId: 'aurora-browser-voice-catalog',
    })
    const progress: string[] = []
    const afterSelect = vi.fn()
    const port = createAuroraBrowserVoiceCatalogPort({ afterSelect })

    const catalog = await port.listCatalog()
    const selection = catalog.items[0]
    if (!selection) throw new Error('expected catalog item')
    const receipt = await port.select({ selection, onProgress: (event) => progress.push(event.state) })

    expect(catalog).toMatchObject({
      state: 'ready',
      items: [expect.objectContaining({
        task: 'tts',
        packId: 'standard:piper:en-us-test',
        voiceId: 'standard:piper:en-us-test',
        active: false,
      })],
    })
    expect(voiceWeb.installPack).toHaveBeenCalledWith(expect.objectContaining({
      host,
      manifest: entry.toModelPackManifest(),
      scope: { task: 'tts' },
      allowEmbeddedBrowserVoiceCatalogTrust: true,
      trustedAssetOrigins: ['https://github.com'],
    }))
    expect(receipt.trust).toMatchObject({
      task: 'tts',
      packId: 'standard:piper:en-us-test',
      verificationMode: 'embedded-catalog',
      expectedManifestSha256: RELEASE_MANIFEST_SHA256,
    })
    expect(progress).toEqual(['queued', 'downloading', 'saving', 'ready'])
    expect(afterSelect).toHaveBeenCalledWith(receipt, expect.objectContaining({ selection }))
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

function modelPack(
  task: AuroraVoiceWebModelDescriptor['task'],
  packId: string,
  fileId: string,
  virtualPath: string,
  family?: 'piper' | 'pockettts',
) {
  const familyByTask = {
    vad: 'silero-vad',
    kws: 'sherpa-kws-transducer',
    stt: 'whisper',
    tts: family ?? 'piper',
  } satisfies Record<
    AuroraVoiceWebModelDescriptor['task'],
    AuroraVoiceWebModelDescriptor['family']
  >
  const kindByTask = {
    vad: 'vad',
    kws: 'keyword-spotter',
    stt: 'offline-asr',
    tts: 'offline-tts',
  } satisfies Record<
    AuroraVoiceWebModelDescriptor['task'],
    AuroraVoiceWebModelDescriptor['kind']
  >
  const model: AuroraVoiceWebModelDescriptor = {
    task,
    family: familyByTask[task],
    kind: kindByTask[task],
    files: [{
      role: task === 'tts' ? 'model' : 'encoder',
      fileId,
      virtualPath,
    }],
    config: task === 'tts' ? { voiceId: 'voice-en' } : { language: 'en' },
  }
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
    models: [model],
  }
}

function memoryModelStoreHost(): AuroraWebModelStoreHost & {
  readonly json: Map<string, string>
  readonly promoted: Map<string, Uint8Array>
} {
  const json = new Map<string, string>()
  const staging = new Map<string, Uint8Array>()
  const promoted = new Map<string, Uint8Array>()
  return {
    json,
    promoted,
    persistenceReport: vi.fn(),
    readJson: vi.fn(async (key: string) => json.get(key) ?? null),
    writeJson: vi.fn(async (key: string, value: string) => {
      json.set(key, value)
    }),
    deleteJson: vi.fn(async (key: string) => {
      json.delete(key)
    }),
    listJsonKeys: vi.fn(async (prefix: string) => [...json.keys()].filter((key) => key.startsWith(prefix))),
    stagingLen: vi.fn(async (key: string) => staging.get(key)?.byteLength ?? 0),
    readStagingChunk: vi.fn(async (key: string, offset: number, maxBytes: number) => {
      const bytes = staging.get(key) ?? new Uint8Array()
      return { bytes: bytes.slice(offset, offset + maxBytes), offset, complete: offset + maxBytes >= bytes.byteLength }
    }),
    appendStaging: vi.fn(async (key: string, offset: number, bytes: Uint8Array) => {
      const current = staging.get(key) ?? new Uint8Array()
      const next = new Uint8Array(Math.max(current.byteLength, offset + bytes.byteLength))
      next.set(current)
      next.set(bytes, offset)
      staging.set(key, next)
    }),
    clearStaging: vi.fn(async (key: string) => {
      staging.delete(key)
    }),
    promotedStat: vi.fn(async (key: string) => {
      const bytes = promoted.get(key)
      return bytes ? { byteLength: bytes.byteLength, sha256: null } : null
    }),
    readPromotedChunk: vi.fn(async (key: string, offset: number, maxBytes: number) => {
      const bytes = promoted.get(key) ?? new Uint8Array()
      return { bytes: bytes.slice(offset, offset + maxBytes), offset, complete: offset + maxBytes >= bytes.byteLength }
    }),
    promoteStagingAtomic: vi.fn(async (key: string) => {
      const bytes = staging.get(key)
      if (bytes) promoted.set(key, bytes)
      staging.delete(key)
    }),
    deletePromoted: vi.fn(async (key: string) => {
      promoted.delete(key)
    }),
    listPromotedKeys: vi.fn(async () => [...promoted.keys()]),
    removePackData: vi.fn(),
  }
}

function wavBytes(options: { sampleRateHz: number, durationMs: number, channels?: number }): Uint8Array {
  const channels = options.channels ?? 1
  const sampleCount = Math.floor((options.sampleRateHz * options.durationMs) / 1000)
  const dataBytes = sampleCount * channels * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, options.sampleRateHz, true)
  view.setUint32(28, options.sampleRateHz * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
}

function catalogEntry(id: string) {
  const manifest = {
    schema_version: 1 as const,
    pack_id: id,
    pack_version: '1.0.0',
    display_name: 'Test voice',
    tasks: ['tts'],
    files: [{
      file_id: 'tts-archive',
      asset_id: '1',
      task: 'tts',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/test.tar.bz2',
      sha256: 'b'.repeat(64),
      byte_size: 4,
      installed_size: 4,
      compression: 'none' as const,
    }],
    variants: [{
      variant_id: 'web-wasm32',
      file_ids: ['tts-archive'],
      target: 'web',
      os: 'web',
      arch: 'wasm32',
      model_bindings: [{
        task: 'tts' as const,
        family: 'piper' as const,
        kind: 'offline-tts' as const,
        files: [{ role: 'model' as const, fileId: 'tts-archive', virtualPath: '/test.onnx' }],
        config: { voiceId: id },
      }],
    }],
    revocation: null,
    signature: null,
  }
  return {
    id,
    displayName: 'Test voice',
    task: 'tts' as const,
    languages: ['en-us'],
    archive: {
      asset_id: 1,
      byte_size: 4,
      filename: 'test.tar.bz2',
      format: 'file' as const,
      sha256: 'b'.repeat(64),
      updated_at: '2026-01-01T00:00:00Z',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/test.tar.bz2',
    },
    installableByBrowserArchive: true,
    terms: {
      download_initiated_by_user: true,
      redistributed_by_aurora: false,
      source: 'upstream_model_card',
    },
    toModelPackManifest: () => manifest,
  }
}
