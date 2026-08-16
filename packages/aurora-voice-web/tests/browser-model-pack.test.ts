import { describe, expect, it } from 'vitest'

import {
  AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
  AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
  installVerifiedBrowserModelPack,
  openActiveBrowserModelPack,
  verifyBrowserModelPackManifest,
  type AuroraBrowserModelPackManifest
} from '../src/browser-model-pack.js'
import { loadAuroraBrowserVoiceModelBindings } from '../src/browser-runtime.js'
import { findAuroraBrowserVoiceCatalogEntry } from '../src/browser-voice-catalog.js'
import { AuroraSherpaWasmVoiceEngine } from '../src/sherpa-engine.js'
import { MemoryWebModelStoreHost } from '../src/test-doubles/index.js'

const TEST_PRIVATE_KEY_PKCS8_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIBVNj/cSHz9pWMrteoqMMTyDd+p51OEdgbIRQJDEHiBP'
const TEST_PUBLIC_KEY_BASE64 = 'k1NEXA5D4H1jAs3GBxo9Cr42I6BUeYEA/HqYiTOUKhc='
const TEST_RELEASE_KEY_ID = 'aurora-release-web-wasm-test'
const TEST_ASSET_BASE_URL = 'https://models.aurora.test'
const TEST_ASSET_POLICY = { trustedAssetOrigins: [TEST_ASSET_BASE_URL] } as const

class AbortAfterAppendHost extends MemoryWebModelStoreHost {
  private abortController: AbortController | null = null
  lastAppendedStorageKey: string | null = null

  abortAfterNextAppend(controller: AbortController): void {
    this.abortController = controller
  }

  override async appendStaging(storageKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    await super.appendStaging(storageKey, offset, bytes)
    this.lastAppendedStorageKey = storageKey
    const controller = this.abortController
    this.abortController = null
    controller?.abort()
  }
}

class CleanupFailureHost extends AbortAfterAppendHost {
  private failCleanup = false

  failNextCleanupAfterAppend(controller: AbortController): void {
    this.failCleanup = true
    this.abortAfterNextAppend(controller)
  }

  override async clearStaging(storageKey: string): Promise<void> {
    if (this.failCleanup && this.lastAppendedStorageKey === storageKey) {
      this.failCleanup = false
      throw new Error('cleanup_failure')
    }
    await super.clearStaging(storageKey)
  }
}

class PromotionFailureHost extends MemoryWebModelStoreHost {
  private promotionsUntilFailure: number | null = null

  failOnPromotion(number: number): void {
    this.promotionsUntilFailure = number
  }

  override async promoteStagingAtomic(storageKey: string): Promise<void> {
    if (this.promotionsUntilFailure === 1) {
      this.promotionsUntilFailure = null
      throw new Error('promotion_failure')
    }
    if (this.promotionsUntilFailure !== null) this.promotionsUntilFailure -= 1
    await super.promoteStagingAtomic(storageKey)
  }
}

class ActiveWriteFailureHost extends MemoryWebModelStoreHost {
  private failActiveWrite = false

  failNextActiveWrite(): void {
    this.failActiveWrite = true
  }

  override async writeJson(key: string, value: string): Promise<void> {
    if (this.failActiveWrite && key.startsWith('aurora.voice.web-store.v1:active:')) {
      this.failActiveWrite = false
      throw new Error('active_write_failure')
    }
    await super.writeJson(key, value)
  }
}

class AbortAfterPromotionHost extends MemoryWebModelStoreHost {
  constructor(private readonly controller: AbortController) {
    super()
  }

  override async promoteStagingAtomic(storageKey: string): Promise<void> {
    await super.promoteStagingAtomic(storageKey)
    this.controller.abort()
  }
}

class BrowserKeyLimitHost extends MemoryWebModelStoreHost {
  private assertKey(key: string): void {
    if (new TextEncoder().encode(key).byteLength > 256) throw new Error('key_limit')
  }

  override async readJson(key: string): Promise<string | null> {
    this.assertKey(key)
    return super.readJson(key)
  }

  override async writeJson(key: string, value: string): Promise<void> {
    this.assertKey(key)
    await super.writeJson(key, value)
  }

  override async deleteJson(key: string): Promise<void> {
    this.assertKey(key)
    await super.deleteJson(key)
  }

  override async promotedStat(storageKey: string) {
    this.assertKey(storageKey)
    return super.promotedStat(storageKey)
  }

  override async clearStaging(storageKey: string): Promise<void> {
    this.assertKey(storageKey)
    await super.clearStaging(storageKey)
  }

  override async appendStaging(storageKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    this.assertKey(storageKey)
    await super.appendStaging(storageKey, offset, bytes)
  }

  override async promoteStagingAtomic(storageKey: string): Promise<void> {
    this.assertKey(storageKey)
    await super.promoteStagingAtomic(storageKey)
  }
}

describe('browser model pack verification', () => {
  it('requires signed trust and keeps non-production trust behind an explicit option', async () => {
    const manifest = await signedManifest(new Uint8Array([1, 2, 3]))

    await expect(verifyBrowserModelPackManifest({ ...manifest, signature: null })).rejects.toMatchObject({ code: 'unsigned' })
    await expect(verifyBrowserModelPackManifest(manifest)).rejects.toMatchObject({ code: 'untrusted_key' })
    await expect(verifyBrowserModelPackManifest(manifest, { allowNonProductionTestSignature: true })).resolves.toMatchObject({
      pack_id: 'pockettts-web-test',
      verification_mode: 'signature',
      key_id: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
      variant_id: 'web-wasm32-test'
    })
  })

  it('allows unsigned generated catalog manifests only through embedded catalog trust', async () => {
    const manifest = findAuroraBrowserVoiceCatalogEntry('standard:piper:en_us-amy-low')?.toModelPackManifest()
    expect(manifest).toBeDefined()
    const expectedReleaseManifestSha256 = await manifestSha256(manifest!)

    await expect(verifyBrowserModelPackManifest(manifest!)).rejects.toMatchObject({ code: 'unsigned' })
    await expect(verifyBrowserModelPackManifest(manifest!, {
      allowEmbeddedBrowserVoiceCatalogTrust: true,
      expectedReleaseManifestSha256
    }))
      .resolves.toMatchObject({
        pack_id: 'standard:piper:en_us-amy-low',
        manifest_sha256: expectedReleaseManifestSha256,
        verification_mode: 'embedded-catalog',
        key_id: 'aurora-browser-voice-catalog'
      })

    await expect(verifyBrowserModelPackManifest(manifest!, {
      allowEmbeddedBrowserVoiceCatalogTrust: true,
      expectedReleaseManifestSha256: '0'.repeat(64)
    })).rejects.toMatchObject({ code: 'release_hash' })

    await expect(verifyBrowserModelPackManifest({
      ...manifest!,
      display_name: 'tampered'
    }, { allowEmbeddedBrowserVoiceCatalogTrust: true })).rejects.toMatchObject({ code: 'release_hash' })
  })

  it('rejects structurally invalid manifest file URLs during verification', async () => {
    const bytes = new Uint8Array([111, 112, 113])
    const manifest = await signedManifestWithUrl(bytes, ' https://models.aurora.test/model.bin')
    await expect(verifyBrowserModelPackManifest(manifest, { allowNonProductionTestSignature: true }))
      .rejects.toMatchObject({ code: 'asset_url' })

    const nonStringUrlManifest = await signedUnsignedManifest({
      ...manifest,
      files: [{
        ...manifest.files[0]!,
        url: null as unknown as string
      }],
      signature: null
    })
    await expect(verifyBrowserModelPackManifest(nonStringUrlManifest, { allowNonProductionTestSignature: true }))
      .rejects.toMatchObject({ code: 'asset_url' })
  })

  it('installs a verified pack and reopens promoted bytes offline after reload', async () => {
    const bytes = new Uint8Array([4, 5, 6, 7])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => {
        fetchCount += 1
        expect(url).toBe(`${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test.bin`)
        return bytes
      },
      nowMs: () => 42
    })

    expect(fetchCount).toBe(1)
    expect(receipt).toMatchObject({
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verificationMode: 'signature',
      verificationKeyId: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
      identity: {
        packId: 'pockettts-web-test',
        packVersion: '1.0.0',
        variantId: 'web-wasm32-test',
        scope: { task: 'stt', slotId: 'default' }
      }
    })

    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(reopened?.identity).toEqual(receipt.identity)
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual([4, 5, 6, 7])
  })

  it('carries explicit model family kind and config metadata from the verified manifest', async () => {
    const encoderBytes = new Uint8Array([31, 32])
    const decoderBytes = new Uint8Array([33, 34])
    const tokensBytes = new Uint8Array([35, 36])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'moonshine-web-test',
      pack_version: '1.0.0',
      display_name: 'Moonshine Web Test',
      tasks: ['stt'],
      files: [{
        file_id: 'encoder',
        asset_id: 'encoder',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/moonshine-encoder.ort`,
        sha256: await sha256Hex(encoderBytes),
        byte_size: encoderBytes.byteLength,
        installed_size: encoderBytes.byteLength,
        compression: 'none'
      }, {
        file_id: 'decoder-merged',
        asset_id: 'decoder-merged',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/moonshine-decoder-merged.ort`,
        sha256: await sha256Hex(decoderBytes),
        byte_size: decoderBytes.byteLength,
        installed_size: decoderBytes.byteLength,
        compression: 'none'
      }, {
        file_id: 'tokens',
        asset_id: 'tokens',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/moonshine-tokens.txt`,
        sha256: await sha256Hex(tokensBytes),
        byte_size: tokensBytes.byteLength,
        installed_size: tokensBytes.byteLength,
        compression: 'none'
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['encoder', 'decoder-merged', 'tokens'],
        target: 'web',
        os: 'web',
        arch: 'wasm32',
        model_bindings: [{
          task: 'stt',
          family: 'moonshine',
          kind: 'offline-asr',
          files: [
            { role: 'encoder', fileId: 'encoder', virtualPath: '/moonshine-encoder.ort' },
            { role: 'mergedDecoder', fileId: 'decoder-merged', virtualPath: '/moonshine-decoder-merged.ort' },
            { role: 'tokens', fileId: 'tokens', virtualPath: '/moonshine-tokens.txt' }
          ],
          config: { language: 'en', task: 'transcribe' }
        }]
      }],
      revocation: null,
      signature: null
    })
    const host = new MemoryWebModelStoreHost()

    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => {
        if (url.endsWith('encoder.ort')) return encoderBytes
        if (url.endsWith('decoder-merged.ort')) return decoderBytes
        return tokensBytes
      }
    })
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )

    expect(reopened?.models).toEqual([{
      task: 'stt',
      family: 'moonshine',
      kind: 'offline-asr',
      files: [
        { role: 'encoder', fileId: 'encoder', virtualPath: '/moonshine-encoder.ort' },
        { role: 'mergedDecoder', fileId: 'decoder-merged', virtualPath: '/moonshine-decoder-merged.ort' },
        { role: 'tokens', fileId: 'tokens', virtualPath: '/moonshine-tokens.txt' }
      ],
      config: { language: 'en', task: 'transcribe' }
    }])
  })

  it('installs a verified tar.bzip2 archive as extracted immutable model files', async () => {
    const archiveBytes = new Uint8Array([201, 202, 203])
    const modelBytes = new Uint8Array([1, 3, 5, 7])
    const tokensBytes = new Uint8Array([2, 4, 6])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'archive-web-test',
      pack_version: '1.0.0',
      display_name: 'Archive Web Test',
      tasks: ['stt'],
      files: [{
        file_id: 'archive',
        asset_id: 'archive',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/archive.tar.bz2`,
        sha256: await sha256Hex(archiveBytes),
        byte_size: archiveBytes.byteLength,
        installed_size: 64,
        compression: 'tar_bzip2',
        archive_root: 'archive-root',
        archive_entries: [
          { file_id: 'model', task: 'stt', path: 'archive-root/model.onnx', sha256: await sha256Hex(modelBytes), byte_size: modelBytes.byteLength },
          { file_id: 'tokens', task: 'stt', path: 'archive-root/tokens.txt', sha256: await sha256Hex(tokensBytes), byte_size: tokensBytes.byteLength }
        ]
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['archive'],
        target: 'web',
        os: 'web',
        arch: 'wasm32',
        model_bindings: [{
          task: 'stt',
          family: 'sense-voice',
          kind: 'offline-asr',
          files: [
            { role: 'model', fileId: 'model', virtualPath: '/archive-root/model.onnx' },
            { role: 'tokens', fileId: 'tokens', virtualPath: '/archive-root/tokens.txt' }
          ],
          config: { language: 'en' }
        }]
      }],
      revocation: null,
      signature: null
    })
    const host = new MemoryWebModelStoreHost()
    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => archiveBytes,
      extractTarBzip2Archive: async (_bytes, request) => {
        expect(request.expectedRoot).toBe('archive-root')
        expect(request.expectedPaths).toEqual(['archive-root/model.onnx', 'archive-root/tokens.txt'])
        return [
          { path: 'archive-root/model.onnx', byteSize: modelBytes.byteLength, sha256: await sha256Hex(modelBytes), bytes: modelBytes },
          { path: 'archive-root/tokens.txt', byteSize: tokensBytes.byteLength, sha256: await sha256Hex(tokensBytes), bytes: tokensBytes }
        ]
      }
    })

    expect(receipt.files.map((file) => file.fileId)).toEqual(['model', 'tokens'])
    const reopened = await openActiveBrowserModelPack(host, { task: 'stt' }, { allowNonProductionTestSignature: true })
    expect(await Promise.all(reopened?.files.map(async (file) => Array.from(await file.readAll())) ?? [])).toEqual([
      Array.from(modelBytes),
      Array.from(tokensBytes)
    ])
  })

  it('rejects archive extraction mismatches and cleans staging', async () => {
    const archiveBytes = new Uint8Array([211, 212, 213])
    const modelBytes = new Uint8Array([9, 8, 7])
    const manifest = await signedUnsignedManifest({
      ...(await signedManifest(archiveBytes)),
      tasks: ['stt'],
      files: [{
        file_id: 'archive',
        asset_id: 'archive',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/archive.tar.bz2`,
        sha256: await sha256Hex(archiveBytes),
        byte_size: archiveBytes.byteLength,
        installed_size: 64,
        compression: 'tar_bzip2',
        archive_root: 'archive-root',
        archive_entries: [{ file_id: 'model', task: 'stt', path: 'archive-root/model.onnx', sha256: await sha256Hex(new Uint8Array([1])), byte_size: 1 }]
      }],
      variants: [{ variant_id: 'web-wasm32-test', file_ids: ['archive'], target: 'web', os: 'web', arch: 'wasm32' }],
      signature: null
    })
    const host = new MemoryWebModelStoreHost()

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => archiveBytes,
      extractTarBzip2Archive: async () => [
        { path: 'archive-root/model.onnx', byteSize: modelBytes.byteLength, sha256: await sha256Hex(modelBytes), bytes: modelBytes }
      ]
    })).rejects.toMatchObject({ code: 'size' })

    expect(await host.listPromotedKeys()).toEqual([])
    expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])
  })

  it('loads a Piper archive data directory into the browser engine after installation', async () => {
    const archiveBytes = new Uint8Array([220])
    const modelBytes = new Uint8Array([221])
    const tokensBytes = new Uint8Array([222])
    const langBytes = new Uint8Array([223])
    const voiceBytes = new Uint8Array([224])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'piper-web-test',
      pack_version: '1.0.0',
      display_name: 'Piper Web Test',
      tasks: ['tts'],
      files: [{
        file_id: 'tts-archive',
        asset_id: 'tts-archive',
        task: 'tts',
        url: `${TEST_ASSET_BASE_URL}/fixtures/piper.tar.bz2`,
        sha256: await sha256Hex(archiveBytes),
        byte_size: archiveBytes.byteLength,
        installed_size: 16,
        compression: 'tar_bzip2',
        archive_root: 'piper-root',
        archive_entries: [
          { file_id: 'model', task: 'tts', path: 'piper-root/voice.onnx', sha256: await sha256Hex(modelBytes), byte_size: modelBytes.byteLength },
          { file_id: 'tokens', task: 'tts', path: 'piper-root/tokens.txt', sha256: await sha256Hex(tokensBytes), byte_size: tokensBytes.byteLength },
          { file_id: 'data-dir', task: 'tts', path: 'piper-root/espeak-ng-data', kind: 'directory' }
        ]
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['tts-archive'],
        target: 'web',
        os: 'web',
        arch: 'wasm32',
        model_bindings: [{
          task: 'tts',
          family: 'piper',
          kind: 'offline-tts',
          files: [
            { role: 'model', fileId: 'model', virtualPath: '/piper-root/voice.onnx' },
            { role: 'tokens', fileId: 'tokens', virtualPath: '/piper-root/tokens.txt' },
            { role: 'dataDir', fileId: 'data-dir', virtualPath: '/piper-root/espeak-ng-data' }
          ],
          config: { language: 'en-us', voiceId: 'piper-web-test' }
        }]
      }],
      revocation: null,
      signature: null
    })
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      scope: { task: 'tts' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => archiveBytes,
      extractTarBzip2Archive: async (_bytes, request) => {
        expect(request).toMatchObject({
          expectedRoot: 'piper-root',
          expectedPaths: ['piper-root/voice.onnx', 'piper-root/tokens.txt'],
          expectedDirectories: ['piper-root/espeak-ng-data'],
          allowUnexpectedFiles: false
        })
        return [
          { path: 'piper-root/voice.onnx', byteSize: modelBytes.byteLength, sha256: await sha256Hex(modelBytes), bytes: modelBytes },
          { path: 'piper-root/tokens.txt', byteSize: tokensBytes.byteLength, sha256: await sha256Hex(tokensBytes), bytes: tokensBytes },
          { path: 'piper-root/espeak-ng-data/lang/en-us', byteSize: langBytes.byteLength, sha256: await sha256Hex(langBytes), bytes: langBytes },
          { path: 'piper-root/espeak-ng-data/voices/en-us', byteSize: voiceBytes.byteLength, sha256: await sha256Hex(voiceBytes), bytes: voiceBytes }
        ]
      }
    })

    const bindings = await loadAuroraBrowserVoiceModelBindings(host, { allowNonProductionTestSignature: true }, ['tts'])
    const mounted: string[] = []
    const ttsConfigs: unknown[] = []
    const engine = new AuroraSherpaWasmVoiceEngine({
      engineAssets: {
        ttsModuleUrl: 'https://voice.example/sherpa-onnx-wasm-tts.js',
        ttsHelperUrl: 'https://voice.example/sherpa-onnx-tts.js'
      },
      loadModule: async (_url, files) => {
        for (const file of files) mounted.push(file.virtualPath)
        return { FS_createDataFile: (_parent, name) => mounted.push(`fs:/${name}`), FS_createPath: () => undefined }
      },
      loadHelpers: async () => ({
        createOfflineTts: (_module, config) => {
          ttsConfigs.push(config)
          return new FakeTts()
        }
      })
    })

    await expect(engine.initialize(bindings)).resolves.toMatchObject({ tts: true })
    const audio = await engine.synthesizeSpeech({ text: ' hello ', generation: 7 })
    expect(audio).toMatchObject({ generation: 7, sampleRateHz: 16_000, sampleCount: 2, redacted: true })
    expect(mounted).toEqual(expect.arrayContaining([
      '/piper-root/voice.onnx',
      '/piper-root/tokens.txt',
      '/piper-root/espeak-ng-data/lang/en-us',
      '/piper-root/espeak-ng-data/voices/en-us',
      'fs:/piper-root/espeak-ng-data/lang/en-us',
      'fs:/piper-root/espeak-ng-data/voices/en-us'
    ]))
    expect(JSON.stringify(ttsConfigs[0])).toContain('/piper-root/espeak-ng-data')
  })

  it('rejects reopened packs when a directory-expanded file is removed', async () => {
    const archiveBytes = new Uint8Array([225])
    const modelBytes = new Uint8Array([226])
    const manifest = await signedUnsignedManifest({
      ...(await signedManifest(archiveBytes)),
      tasks: ['tts'],
      files: [{
        file_id: 'archive',
        asset_id: 'archive',
        task: 'tts',
        url: `${TEST_ASSET_BASE_URL}/fixtures/piper-corrupt.tar.bz2`,
        sha256: await sha256Hex(archiveBytes),
        byte_size: archiveBytes.byteLength,
        installed_size: 8,
        compression: 'tar_bzip2',
        archive_root: 'piper-root',
        archive_entries: [
          { file_id: 'model', task: 'tts', path: 'piper-root/voice.onnx' },
          { file_id: 'data-dir', task: 'tts', path: 'piper-root/espeak-ng-data', kind: 'directory' }
        ]
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['archive'],
        target: 'web',
        os: 'web',
        arch: 'wasm32',
        model_bindings: [{
          task: 'tts',
          family: 'piper',
          kind: 'offline-tts',
          files: [
            { role: 'model', fileId: 'model', virtualPath: '/piper-root/voice.onnx' },
            { role: 'tokens', fileId: 'model', virtualPath: '/piper-root/voice.onnx' },
            { role: 'dataDir', fileId: 'data-dir', virtualPath: '/piper-root/espeak-ng-data' }
          ]
        }]
      }],
      signature: null
    })
    const host = new MemoryWebModelStoreHost()
    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      scope: { task: 'tts' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => archiveBytes,
      extractTarBzip2Archive: async () => [
        { path: 'piper-root/voice.onnx', byteSize: modelBytes.byteLength, sha256: await sha256Hex(modelBytes), bytes: modelBytes },
        { path: 'piper-root/espeak-ng-data/lang/en-us', byteSize: 1, sha256: await sha256Hex(new Uint8Array([227])), bytes: new Uint8Array([227]) }
      ]
    })
    await host.deletePromoted(receipt.files.at(-1)?.storageKey ?? '')

    await expect(openActiveBrowserModelPack(host, { task: 'tts' }, { allowNonProductionTestSignature: true }))
      .rejects.toMatchObject({ code: 'missing_file' })
  })

  it('rejects archive expansion that exceeds the declared installed budget', async () => {
    const archiveBytes = new Uint8Array([230])
    const manifest = await signedUnsignedManifest({
      ...(await signedManifest(archiveBytes)),
      files: [{
        file_id: 'archive',
        asset_id: 'archive',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/expanded.tar.bz2`,
        sha256: await sha256Hex(archiveBytes),
        byte_size: archiveBytes.byteLength,
        installed_size: 1,
        compression: 'tar_bzip2',
        archive_root: 'archive-root',
        archive_entries: [{ file_id: 'model', task: 'stt', path: 'archive-root/model.onnx' }]
      }],
      variants: [{ variant_id: 'web-wasm32-test', file_ids: ['archive'], target: 'web', os: 'web', arch: 'wasm32' }],
      signature: null
    })
    const host = new MemoryWebModelStoreHost()

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => archiveBytes,
      extractTarBzip2Archive: async () => [
        { path: 'archive-root/model.onnx', byteSize: 2, sha256: await sha256Hex(new Uint8Array([1, 2])), bytes: new Uint8Array([1, 2]) }
      ]
    })).rejects.toMatchObject({ code: 'archive_bounds' })
    expect(await host.listPromotedKeys()).toEqual([])
  })

  it('rejects unsafe asset source URLs before fetching or mutating storage', async () => {
    const bytes = new Uint8Array([101, 102, 103])
    const unsafeUrls = [
      'not a url',
      '//cdn.example.test/model.bin',
      'data:application/octet-stream;base64,AQID',
      'blob:https://models.aurora.test/model',
      'file:///tmp/model.bin',
      'https://cdn.example.test/model.bin',
      'http://models.aurora.test/model.bin'
    ]

    for (const url of unsafeUrls) {
      const host = new MemoryWebModelStoreHost()
      let fetchCount = 0

      await expect(installVerifiedBrowserModelPack({
        host,
        manifest: await signedManifestWithUrl(bytes, url),
        allowNonProductionTestSignature: true,
        ...TEST_ASSET_POLICY,
        trustedAssetBaseUrl: TEST_ASSET_BASE_URL,
        fetchBytes: async () => {
          fetchCount += 1
          return bytes
        }
      })).rejects.toMatchObject({ code: 'asset_url' })

      expect(fetchCount).toBe(0)
      expect(await host.listPromotedKeys()).toEqual([])
      expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])
    }
  })

  it('allows relative assets only when they resolve against an explicit trusted origin', async () => {
    const bytes = new Uint8Array([104, 105, 106])
    const manifest = await signedManifestWithUrl(bytes, 'fixtures/pockettts-web-test.bin')
    const host = new MemoryWebModelStoreHost()
    const fetchedUrls: string[] = []

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })).rejects.toMatchObject({ code: 'asset_url' })

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      trustedAssetBaseUrl: `${TEST_ASSET_BASE_URL}/releases/`,
      fetchBytes: async (url) => {
        fetchedUrls.push(url)
        return bytes
      }
    })

    expect(receipt.files).toHaveLength(1)
    expect(fetchedUrls).toEqual([`${TEST_ASSET_BASE_URL}/releases/fixtures/pockettts-web-test.bin`])
  })

  it('allows same-origin HTTPS assets without an extra origin allowlist', async () => {
    const bytes = new Uint8Array([114, 115, 116])
    const manifest = await signedManifestWithUrl(bytes, `${TEST_ASSET_BASE_URL}/fixtures/same-origin.bin`)
    const host = new MemoryWebModelStoreHost()
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new URL(`${TEST_ASSET_BASE_URL}/app/`)
    })
    try {
      const receipt = await installVerifiedBrowserModelPack({
        host,
        manifest,
        allowNonProductionTestSignature: true,
        fetchBytes: async (url) => {
          expect(url).toBe(`${TEST_ASSET_BASE_URL}/fixtures/same-origin.bin`)
          return bytes
        }
      })
      expect(receipt.files).toHaveLength(1)
    } finally {
      if (previousLocation) {
        Object.defineProperty(globalThis, 'location', previousLocation)
      } else {
        delete (globalThis as { location?: Location }).location
      }
    }
  })

  it('allows loopback HTTP asset URLs only through the explicit non-production option', async () => {
    const bytes = new Uint8Array([107, 108, 109])
    const manifest = await signedManifestWithUrl(bytes, 'http://127.0.0.1:8787/model.bin')
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => {
        fetchCount += 1
        return bytes
      }
    })).rejects.toMatchObject({ code: 'asset_url' })

    expect(fetchCount).toBe(0)

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      allowNonProductionLoopbackHttpAssetUrls: true,
      fetchBytes: async (url) => {
        fetchCount += 1
        expect(url).toBe('http://127.0.0.1:8787/model.bin')
        return bytes
      }
    })

    expect(fetchCount).toBe(1)
    expect(receipt.files).toHaveLength(1)
  })

  it('uses no-store fetches and accepts bounded GitHub release asset redirects for trusted default downloads', async () => {
    const bytes = new Uint8Array([117, 118, 119])
    const manifest = await signedManifestWithUrl(bytes, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/model/default-fetch.bin')
    const host = new MemoryWebModelStoreHost()
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      expect(url).toBe('https://github.com/k2-fsa/sherpa-onnx/releases/download/model/default-fetch.bin')
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'follow' })
      return {
        ok: true,
        url: 'https://release-assets.githubusercontent.com/github-production-release-asset/default-fetch.bin',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      } as Response
    }
    try {
      const receipt = await installVerifiedBrowserModelPack({
        host,
        manifest,
        allowNonProductionTestSignature: true,
        trustedAssetOrigins: ['https://github.com']
      })
      expect(receipt.files).toHaveLength(1)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('rejects unlisted default-fetch redirect origins before storing bytes', async () => {
    const bytes = new Uint8Array([127, 128, 129])
    const manifest = await signedManifestWithUrl(bytes, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/model/bad.bin')
    const host = new MemoryWebModelStoreHost()
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      url: 'https://evil.example/bad.bin',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } as Response)
    try {
      await expect(installVerifiedBrowserModelPack({
        host,
        manifest,
        allowNonProductionTestSignature: true,
        trustedAssetOrigins: ['https://github.com']
      })).rejects.toMatchObject({ code: 'asset_url' })
      expect(await host.listPromotedKeys()).toEqual([])
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('rejects a selected file whose task does not match the requested scope before fetching', async () => {
    const bytes = new Uint8Array([8, 9, 10])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'cross-task-web-test',
      pack_version: '1.0.0',
      display_name: 'Cross-task Web Test',
      tasks: ['stt', 'tts'],
      files: [{
        file_id: 'tts-model',
        asset_id: 'tts-model',
        task: 'tts',
        url: `${TEST_ASSET_BASE_URL}/fixtures/cross-task-web-test.bin`,
        sha256: await sha256Hex(bytes),
        byte_size: bytes.byteLength,
        installed_size: bytes.byteLength,
        compression: 'none'
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['tts-model'],
        target: 'web',
        os: 'web',
        arch: 'wasm32'
      }],
      revocation: null,
      signature: null
    })
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      scope: { task: 'stt' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => {
        fetchCount += 1
        return bytes
      }
    })).rejects.toMatchObject({ code: 'scope' })

    expect(fetchCount).toBe(0)
    expect(await host.listPromotedKeys()).toEqual([])
    expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])
  })

  it('installs a shared mixed-task variant under each matching task scope', async () => {
    const sttBytes = new Uint8Array([11, 12])
    const ttsBytes = new Uint8Array([13, 14])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'mixed-task-web-test',
      pack_version: '1.0.0',
      display_name: 'Mixed-task Web Test',
      tasks: ['stt', 'tts'],
      files: [{
        file_id: 'stt-model',
        asset_id: 'stt-model',
        task: 'stt',
        url: `${TEST_ASSET_BASE_URL}/fixtures/mixed-task-stt.bin`,
        sha256: await sha256Hex(sttBytes),
        byte_size: sttBytes.byteLength,
        installed_size: sttBytes.byteLength,
        compression: 'none'
      }, {
        file_id: 'tts-model',
        asset_id: 'tts-model',
        task: 'tts',
        url: `${TEST_ASSET_BASE_URL}/fixtures/mixed-task-tts.bin`,
        sha256: await sha256Hex(ttsBytes),
        byte_size: ttsBytes.byteLength,
        installed_size: ttsBytes.byteLength,
        compression: 'none'
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['stt-model', 'tts-model'],
        target: 'web',
        os: 'web',
        arch: 'wasm32'
      }],
      revocation: null,
      signature: null
    })

    const host = new MemoryWebModelStoreHost()
    for (const task of ['stt', 'tts']) {
      const receipt = await installVerifiedBrowserModelPack({
        host,
        manifest,
        scope: { task },
        allowNonProductionTestSignature: true,
        ...TEST_ASSET_POLICY,
        fetchBytes: async (url) => url.endsWith('-stt.bin') ? sttBytes : ttsBytes
      })
      const reopened = await openActiveBrowserModelPack(
        host,
        { task },
        { allowNonProductionTestSignature: true }
      )

      expect(receipt.identity.scope.task).toBe(task)
      expect(reopened?.identity).toEqual(receipt.identity)
      expect(reopened?.files).toHaveLength(2)
    }
  })

  it('installs and reopens a task-specific pack under its matching scope', async () => {
    const bytes = new Uint8Array([15, 16, 17])
    const manifest = await signedUnsignedManifest({
      schema_version: 1,
      pack_id: 'tts-web-test',
      pack_version: '1.0.0',
      display_name: 'TTS Web Test',
      tasks: ['tts'],
      files: [{
        file_id: 'tts-model',
        asset_id: 'tts-model',
        task: 'tts',
        url: `${TEST_ASSET_BASE_URL}/fixtures/tts-web-test.bin`,
        sha256: await sha256Hex(bytes),
        byte_size: bytes.byteLength,
        installed_size: bytes.byteLength,
        compression: 'none'
      }],
      variants: [{
        variant_id: 'web-wasm32-test',
        file_ids: ['tts-model'],
        target: 'web',
        os: 'web',
        arch: 'wasm32'
      }],
      revocation: null,
      signature: null
    })
    const host = new MemoryWebModelStoreHost()

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      scope: { task: 'tts' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'tts' },
      { allowNonProductionTestSignature: true }
    )

    expect(receipt.identity.scope).toEqual({ task: 'tts', slotId: 'default' })
    expect(reopened?.identity).toEqual(receipt.identity)
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual(Array.from(bytes))
  })

  it('rejects an unsafe legacy active record whose signed files do not match its stored scope', async () => {
    const bytes = new Uint8Array([18, 19, 20])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      scope: { task: 'stt' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })
    const [sttActiveKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(sttActiveKey ?? '') ?? '{}') as {
      identity: { scope: { task: string } }
    }
    active.identity.scope.task = 'tts'
    const ttsActiveKey = (sttActiveKey ?? '').replace(':active:stt:', ':active:tts:')
    await host.writeJson(ttsActiveKey, JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'tts' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'scope' })
  })

  it('keeps colon-bearing task and slot scopes isolated', async () => {
    const firstBytes = new Uint8Array([21, 22, 23])
    const secondBytes = new Uint8Array([24, 25, 26])
    const firstManifest = await signedTaskManifest('scope-a-web-test', 'a:b', firstBytes)
    const secondManifest = await signedTaskManifest('scope-b-web-test', 'a', secondBytes)
    const host = new MemoryWebModelStoreHost()

    const firstReceipt = await installVerifiedBrowserModelPack({
      host,
      manifest: firstManifest,
      scope: { task: 'a:b', slotId: 'c' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => firstBytes
    })
    const secondReceipt = await installVerifiedBrowserModelPack({
      host,
      manifest: secondManifest,
      scope: { task: 'a', slotId: 'b:c' },
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => secondBytes
    })

    const firstReopened = await openActiveBrowserModelPack(
      host,
      firstReceipt.identity.scope,
      { allowNonProductionTestSignature: true }
    )
    const secondReopened = await openActiveBrowserModelPack(
      host,
      secondReceipt.identity.scope,
      { allowNonProductionTestSignature: true }
    )

    expect(firstReopened?.identity).toEqual(firstReceipt.identity)
    expect(Array.from(await firstReopened?.files[0]?.readAll() ?? [])).toEqual(Array.from(firstBytes))
    expect(secondReopened?.identity).toEqual(secondReceipt.identity)
    expect(Array.from(await secondReopened?.files[0]?.readAll() ?? [])).toEqual(Array.from(secondBytes))
  })

  it('maps a malformed legacy active identity to the package error contract', async () => {
    const bytes = new Uint8Array([27, 28, 29])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })
    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      identity: Record<string, unknown>
    }
    delete active.identity.scope
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'active' })
  })

  it('does not fetch or mutate storage when installation is already cancelled', async () => {
    const bytes = new Uint8Array([14, 15, 16])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    const controller = new AbortController()
    let fetchCount = 0
    controller.abort()

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: controller.signal,
      fetchBytes: async () => {
        fetchCount += 1
        return bytes
      }
    })).rejects.toMatchObject({ code: 'aborted' })

    expect(fetchCount).toBe(0)
    expect(await host.listPromotedKeys()).toEqual([])
    expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])
  })

  it('clears staged bytes and preserves the active offline pack when cancelled before promotion', async () => {
    const previousBytes = new Uint8Array([21, 22, 23])
    const nextBytes = new Uint8Array([31, 32, 33])
    const previousManifest = await signedManifest(previousBytes)
    const nextManifest = await signedManifest(nextBytes)
    const host = new AbortAfterAppendHost()

    const previousReceipt = await installVerifiedBrowserModelPack({
      host,
      manifest: previousManifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => previousBytes
    })

    const controller = new AbortController()
    let forwardedSignal: AbortSignal | undefined
    host.abortAfterNextAppend(controller)
    await expect(installVerifiedBrowserModelPack({
      host,
      manifest: nextManifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: controller.signal,
      fetchBytes: async (_url, signal) => {
        forwardedSignal = signal
        return nextBytes
      }
    })).rejects.toMatchObject({ code: 'aborted' })

    expect(forwardedSignal).toBe(controller.signal)
    expect(host.lastAppendedStorageKey).not.toBeNull()
    expect(await host.stagingLen(host.lastAppendedStorageKey ?? '')).toBe(0)
    expect(await host.listPromotedKeys()).toEqual(previousReceipt.files.map((file) => file.storageKey))
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(reopened?.identity.packVersion).toBe('1.0.0')
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual([21, 22, 23])
  })

  it('maps fetch cancellation only when the supplied signal is actually aborted', async () => {
    const bytes = new Uint8Array([34, 35, 36])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    const controller = new AbortController()
    const fetchAbort = new DOMException('cancelled', 'AbortError')
    let forwardedSignal: AbortSignal | undefined

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: controller.signal,
      fetchBytes: async (_url, signal) => {
        forwardedSignal = signal
        controller.abort()
        throw fetchAbort
      }
    })).rejects.toMatchObject({ code: 'aborted' })

    expect(forwardedSignal).toBe(controller.signal)
    expect(await host.listPromotedKeys()).toEqual([])
    expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])

    const unrelatedAbort = new DOMException('not caused by the install signal', 'AbortError')
    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: new AbortController().signal,
      fetchBytes: async () => { throw unrelatedAbort }
    })).rejects.toBe(unrelatedAbort)
  })

  it('keeps cancellation primary while surfacing staging cleanup failure', async () => {
    const bytes = new Uint8Array([37, 38, 39])
    const manifest = await signedManifest(bytes)
    const controller = new AbortController()
    const host = new CleanupFailureHost()
    host.failNextCleanupAfterAppend(controller)

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: controller.signal,
      fetchBytes: async () => bytes
    })).rejects.toMatchObject({ code: 'aborted', cleanupFailed: true })

    expect(await host.listPromotedKeys()).toEqual([])
    expect(await host.listJsonKeys('aurora.voice.web-store.v1:active:')).toEqual([])
    expect(await host.stagingLen(host.lastAppendedStorageKey ?? '')).toBe(bytes.byteLength)
  })

  it('rolls back a failed multi-file promotion without changing the active same-version pack', async () => {
    const previousFiles = [new Uint8Array([61, 62, 63]), new Uint8Array([71, 72, 73])] as const
    const nextFiles = [new Uint8Array([64, 65, 66]), new Uint8Array([74, 75, 76])] as const
    const previousManifest = await signedTwoFileManifest(...previousFiles)
    const nextManifest = await signedTwoFileManifest(...nextFiles)
    const host = new PromotionFailureHost()
    const previousReceipt = await installVerifiedBrowserModelPack({
      host,
      manifest: previousManifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => url.endsWith('-a.bin') ? previousFiles[0] : previousFiles[1]
    })

    host.failOnPromotion(2)
    await expect(installVerifiedBrowserModelPack({
      host,
      manifest: nextManifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => url.endsWith('-a.bin') ? nextFiles[0] : nextFiles[1]
    })).rejects.toThrow('promotion_failure')

    expect(await host.listPromotedKeys()).toEqual(previousReceipt.files.map((file) => file.storageKey).sort())
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(await Promise.all(reopened?.files.map(async (file) => Array.from(await file.readAll())) ?? [])).toEqual([
      Array.from(previousFiles[0]),
      Array.from(previousFiles[1])
    ])
  })

  it('does not delete pre-existing immutable files when an idempotent reinstall fails to commit', async () => {
    const bytes = new Uint8Array([41, 42, 43])
    const manifest = await signedManifest(bytes)
    const host = new ActiveWriteFailureHost()
    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })

    host.failNextActiveWrite()
    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })).rejects.toThrow('active_write_failure')

    expect(await host.listPromotedKeys()).toEqual(receipt.files.map((file) => file.storageKey))
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual(Array.from(bytes))
  })

  it('keeps immutable generations grouped for pack-level cleanup', async () => {
    const files = [new Uint8Array([47, 48, 49]), new Uint8Array([57, 58, 59])] as const
    const manifest = await signedTwoFileManifest(...files)
    const host = new MemoryWebModelStoreHost()
    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => url.endsWith('-a.bin') ? files[0] : files[1]
    })

    expect(receipt.files.every((file) => file.storageKey.startsWith(`${manifest.pack_id}@`))).toBe(true)
    await host.removePackData(manifest.pack_id)
    expect(await host.listPromotedKeys()).toEqual([])
  })

  it('keeps maximum-length pack ids within browser storage key limits', async () => {
    const bytes = new Uint8Array([50, 51, 52])
    const baseManifest = await signedManifest(bytes)
    const manifest = await signedUnsignedManifest({
      ...baseManifest,
      pack_id: 'p'.repeat(128),
      signature: null
    })
    const host = new BrowserKeyLimitHost()

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })

    expect(receipt.files).toHaveLength(1)
    expect(receipt.files[0]?.storageKey.startsWith(`${manifest.pack_id}@`)).toBe(true)
    await host.removePackData(manifest.pack_id)
    expect(await host.listPromotedKeys()).toEqual([])
  })

  it('finishes the commit once promotion starts even if cancellation arrives at that boundary', async () => {
    const bytes = new Uint8Array([44, 45, 46])
    const manifest = await signedManifest(bytes)
    const controller = new AbortController()
    const host = new AbortAfterPromotionHost(controller)

    await expect(installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      signal: controller.signal,
      fetchBytes: async () => bytes
    })).resolves.toMatchObject({ identity: { packVersion: '1.0.0' } })

    expect(controller.signal.aborted).toBe(true)
    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual(Array.from(bytes))
  })

  it('requires release key, release hash, and signature for production release-hash trust', async () => {
    const manifest = await signedManifest(new Uint8Array([41, 42, 43]), {}, TEST_RELEASE_KEY_ID)
    const expectedReleaseManifestSha256 = await manifestSha256(manifest)
    const trustedReleaseKeys = [{ keyId: TEST_RELEASE_KEY_ID, publicKeyBase64: TEST_PUBLIC_KEY_BASE64 }]

    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).resolves.toMatchObject({
      manifest_sha256: expectedReleaseManifestSha256,
      verification_mode: 'release-hash',
      key_id: TEST_RELEASE_KEY_ID
    })

    await expect(verifyBrowserModelPackManifest(manifest, { trustedReleaseKeys }))
      .rejects.toMatchObject({ code: 'release_hash' })
    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256: '0'.repeat(64)
    })).rejects.toMatchObject({ code: 'release_hash' })
    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys: [],
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'untrusted_key' })
    await expect(verifyBrowserModelPackManifest({ ...manifest, signature: null }, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'unsigned' })

    const signature = manifest.signature
    expect(signature).not.toBeNull()
    expect(signature).toBeDefined()
    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      signature: {
        key_id: signature?.key_id ?? TEST_RELEASE_KEY_ID,
        algorithm: signature?.algorithm ?? AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
        value: encodeBase64(new Uint8Array(64))
      }
    }, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'signature' })
  })

  it('reopens release-hash trusted packs offline only when the pinned hash is supplied again', async () => {
    const bytes = new Uint8Array([51, 52, 53, 54])
    const manifest = await signedManifest(bytes, {}, TEST_RELEASE_KEY_ID)
    const releaseTrust = {
      trustedReleaseKeys: [{ keyId: TEST_RELEASE_KEY_ID, publicKeyBase64: TEST_PUBLIC_KEY_BASE64 }],
      expectedReleaseManifestSha256: await manifestSha256(manifest),
      ...TEST_ASSET_POLICY
    }
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      ...releaseTrust,
      fetchBytes: async () => {
        fetchCount += 1
        return bytes
      }
    })

    expect(receipt).toMatchObject({
      manifestSha256: releaseTrust.expectedReleaseManifestSha256,
      verificationMode: 'release-hash',
      verificationKeyId: TEST_RELEASE_KEY_ID
    })
    expect(fetchCount).toBe(1)

    const reopened = await openActiveBrowserModelPack(host, { task: 'stt' }, releaseTrust)
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual([51, 52, 53, 54])
    expect(fetchCount).toBe(1)
    await expect(openActiveBrowserModelPack(host, { task: 'stt' }, {
      trustedReleaseKeys: releaseTrust.trustedReleaseKeys
    })).rejects.toMatchObject({ code: 'release_hash' })
  })

  it('rejects duplicate active file ids instead of reopening an incomplete two-file pack', async () => {
    const firstBytes = new Uint8Array([61, 62, 63])
    const secondBytes = new Uint8Array([71, 72, 73])
    const manifest = await signedTwoFileManifest(firstBytes, secondBytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => {
        if (url === `${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test-a.bin`) return firstBytes
        if (url === `${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test-b.bin`) return secondBytes
        throw new Error(`unexpected fixture url: ${url}`)
      }
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    expect(activeKey).toBeDefined()
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      files: Array<Record<string, unknown>>
    }
    active.files = [active.files[0] ?? {}, { ...(active.files[0] ?? {}) }]
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects duplicate manifest and receipt file collections at trust boundaries', async () => {
    const firstBytes = new Uint8Array([81, 82, 83])
    const secondBytes = new Uint8Array([91, 92, 93])
    const manifest = await signedTwoFileManifest(firstBytes, secondBytes)

    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      files: [
        manifest.files[0] ?? manifest.files[1]!,
        { ...(manifest.files[1] ?? manifest.files[0]!), file_id: manifest.files[0]?.file_id ?? 'model-a' }
      ]
    }, { allowNonProductionTestSignature: true })).rejects.toMatchObject({ code: 'duplicate_id' })

    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      variants: [{
        ...(manifest.variants[0] ?? {
          variant_id: 'web-wasm32-test',
          target: 'web',
          os: 'web',
          arch: 'wasm32'
        }),
        file_ids: ['model-a', 'model-a']
      }]
    }, { allowNonProductionTestSignature: true })).rejects.toMatchObject({ code: 'duplicate_id' })

    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async (url) => url.endsWith('-a.bin') ? firstBytes : secondBytes
    })
    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      verification_receipt: {
        file_ids: string[]
        files: Array<Record<string, unknown>>
      }
    }

    active.verification_receipt.file_ids = ['model-a', 'model-a']
    await host.writeJson(activeKey ?? '', JSON.stringify(active))
    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })

    active.verification_receipt.file_ids = ['model-a', 'model-b']
    active.verification_receipt.files = [
      active.verification_receipt.files[0] ?? {},
      { ...(active.verification_receipt.files[0] ?? {}) }
    ]
    await host.writeJson(activeKey ?? '', JSON.stringify(active))
    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects forged active metadata instead of trusting browser-mutable receipts', async () => {
    const bytes = new Uint8Array([8, 9, 10])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    expect(activeKey).toBeDefined()
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      manifest_json: string
      verification_receipt: { manifest_sha256: string }
    }
    active.verification_receipt.manifest_sha256 = '0'.repeat(64)
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects signed-manifest tampering on offline reopen', async () => {
    const bytes = new Uint8Array([11, 12, 13])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      ...TEST_ASSET_POLICY,
      fetchBytes: async () => bytes
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as { manifest_json: string }
    const storedManifest = JSON.parse(active.manifest_json) as Record<string, unknown>
    storedManifest.display_name = 'Tampered'
    active.manifest_json = JSON.stringify(storedManifest)
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'signature' })
  })

  it('keeps nested signature fields inside the canonical signed payload', async () => {
    const bytes = new Uint8Array([31, 32, 33])
    const manifest = await signedManifest(bytes, {
      provenance: {
        signature: 'operator-inventory-signature'
      }
    })

    await expect(verifyBrowserModelPackManifest(manifest, { allowNonProductionTestSignature: true })).resolves.toMatchObject({
      verification_mode: 'signature'
    })

    const tampered = {
      ...manifest,
      provenance: {
        signature: 'forged-operator-inventory-signature'
      }
    }
    await expect(verifyBrowserModelPackManifest(tampered, { allowNonProductionTestSignature: true })).rejects.toMatchObject({
      code: 'signature'
    })
  })
})

async function signedManifest(
  bytes: Uint8Array,
  extraFields: Record<string, unknown> = {},
  keyId = AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID
): Promise<AuroraBrowserModelPackManifest> {
  const unsigned: AuroraBrowserModelPackManifest = {
    ...extraFields,
    schema_version: 1,
    pack_id: 'pockettts-web-test',
    pack_version: '1.0.0',
    display_name: 'PocketTTS Web Test',
    tasks: ['stt'],
    files: [{
      file_id: 'model',
      asset_id: 'model',
      task: 'stt',
      url: `${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test.bin`,
      sha256: await sha256Hex(bytes),
      byte_size: bytes.byteLength,
      installed_size: bytes.byteLength,
      compression: 'none'
    }],
    variants: [{
      variant_id: 'web-wasm32-test',
      file_ids: ['model'],
      target: 'web',
      os: 'web',
      arch: 'wasm32'
    }],
    revocation: null,
    signature: null
  }
  const signature = await signCanonicalManifest(unsigned)
  return {
    ...unsigned,
    signature: {
      key_id: keyId,
      algorithm: AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
      value: signature
    }
  }
}

async function signedManifestWithUrl(
  bytes: Uint8Array,
  url: string,
  keyId = AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID
): Promise<AuroraBrowserModelPackManifest> {
  const manifest = await signedManifest(bytes, {}, keyId)
  return signedUnsignedManifest({
    ...manifest,
    files: [{
      ...manifest.files[0]!,
      url
    }],
    signature: null
  }, keyId)
}

async function signedTaskManifest(
  packId: string,
  task: string,
  bytes: Uint8Array
): Promise<AuroraBrowserModelPackManifest> {
  return signedUnsignedManifest({
    schema_version: 1,
    pack_id: packId,
    pack_version: '1.0.0',
    display_name: 'Scoped Web Test',
    tasks: [task],
    files: [{
      file_id: 'model',
      asset_id: 'model',
      task,
      url: `${TEST_ASSET_BASE_URL}/fixtures/${packId}.bin`,
      sha256: await sha256Hex(bytes),
      byte_size: bytes.byteLength,
      installed_size: bytes.byteLength,
      compression: 'none'
    }],
    variants: [{
      variant_id: 'web-wasm32-test',
      file_ids: ['model'],
      target: 'web',
      os: 'web',
      arch: 'wasm32'
    }],
    revocation: null,
    signature: null
  })
}

async function signedTwoFileManifest(
  firstBytes: Uint8Array,
  secondBytes: Uint8Array
): Promise<AuroraBrowserModelPackManifest> {
  return signedUnsignedManifest({
    schema_version: 1,
    pack_id: 'pockettts-web-test',
    pack_version: '1.0.0',
    display_name: 'PocketTTS Web Test',
    tasks: ['stt'],
    files: [{
      file_id: 'model-a',
      asset_id: 'model-a',
      task: 'stt',
      url: `${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test-a.bin`,
      sha256: await sha256Hex(firstBytes),
      byte_size: firstBytes.byteLength,
      installed_size: firstBytes.byteLength,
      compression: 'none'
    }, {
      file_id: 'model-b',
      asset_id: 'model-b',
      task: 'stt',
      url: `${TEST_ASSET_BASE_URL}/fixtures/pockettts-web-test-b.bin`,
      sha256: await sha256Hex(secondBytes),
      byte_size: secondBytes.byteLength,
      installed_size: secondBytes.byteLength,
      compression: 'none'
    }],
    variants: [{
      variant_id: 'web-wasm32-test',
      file_ids: ['model-a', 'model-b'],
      target: 'web',
      os: 'web',
      arch: 'wasm32'
    }],
    revocation: null,
    signature: null
  })
}

async function signedUnsignedManifest(
  unsigned: AuroraBrowserModelPackManifest,
  keyId = AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID
): Promise<AuroraBrowserModelPackManifest> {
  const signature = await signCanonicalManifest(unsigned)
  return {
    ...unsigned,
    signature: {
      key_id: keyId,
      algorithm: AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
      value: signature
    }
  }
}

async function signCanonicalManifest(manifest: AuroraBrowserModelPackManifest): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decodeBase64(TEST_PRIVATE_KEY_PKCS8_BASE64),
    'Ed25519',
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('Ed25519', privateKey, encodeUtf8(canonicalJson(stripSignature(manifest))))
  return encodeBase64(new Uint8Array(signature))
}

function stripSignature(manifest: AuroraBrowserModelPackManifest): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = manifest
  return unsigned
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function manifestSha256(manifest: AuroraBrowserModelPackManifest): Promise<string> {
  return sha256Hex(encodeUtf8(canonicalJson(stripSignature(manifest))))
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

class FakeTts {
  generateWithConfig(): unknown {
    return { sampleRate: 16_000, samples: new Float32Array([0.1, -0.1]) }
  }

  free(): void {}
}
