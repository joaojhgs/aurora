import { describe, expect, it } from 'vitest'

import {
  auroraBrowserVoiceCatalogSummary,
  findAuroraBrowserVoiceCatalogEntry,
  listAuroraBrowserVoiceCatalogEntries
} from '../src/browser-voice-catalog.js'

describe('browser voice catalog', () => {
  it('exports every metadata-only speech and TTS catalog entry', () => {
    const summary = auroraBrowserVoiceCatalogSummary()

    expect(summary.speechEntries).toBe(21)
    expect(summary.ttsEntries).toBe(537)
    expect(summary.speechLanguages).toContain('en')
    expect(summary.ttsLanguages).toContain('en-us')
    expect(listAuroraBrowserVoiceCatalogEntries({ task: 'tts' })).toHaveLength(537)
    expect(listAuroraBrowserVoiceCatalogEntries({ task: 'stt' })).toHaveLength(12)
  })

  it('creates an archive install descriptor for selected upstream metadata', () => {
    const entry = findAuroraBrowserVoiceCatalogEntry('kws:zipformer:gigaspeech')
    const manifest = entry?.toModelPackManifest()

    expect(entry?.terms).toMatchObject({
      download_initiated_by_user: true,
      redistributed_by_aurora: false
    })
    expect(manifest).toMatchObject({
      pack_id: 'kws:zipformer:gigaspeech',
      files: [{
        compression: 'tar_bzip2',
        archive_root: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
        sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a'
      }]
    })
    expect(manifest?.variants[0]?.model_bindings?.[0]?.files.map((file) => file.fileId).sort()).toEqual([
      'decoder',
      'encoder',
      'joiner',
      'tokenizer',
      'tokens'
    ])
  })

  it('marks Piper voices installable with an explicit data directory binding', () => {
    const entry = findAuroraBrowserVoiceCatalogEntry('standard:piper:en_us-amy-low')
    const manifest = entry?.toModelPackManifest()

    expect(entry?.installableByBrowserArchive).toBe(true)
    expect(manifest?.files[0]?.installed_size).toBe(1024 * 1024 * 1024)
    expect(manifest?.files[0]?.archive_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ file_id: 'model' }),
      expect.objectContaining({ file_id: 'tokens' }),
      expect.objectContaining({ file_id: 'data-dir', kind: 'directory' })
    ]))
    expect(manifest?.variants[0]?.model_bindings?.[0]?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'dataDir', fileId: 'data-dir' })
    ]))
  })
})
