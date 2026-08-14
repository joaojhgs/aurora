import type { AuroraBrowserModelPackArchiveEntry, AuroraBrowserModelPackManifest } from './browser-model-pack.js'
import type { AuroraVoiceWebModelDescriptor, AuroraVoiceWebModelFileRole, AuroraVoiceWebModelTask } from './types.js'
import { AURORA_BROWSER_SPEECH_CATALOG, AURORA_BROWSER_TTS_CATALOG } from './browser-voice-catalog.generated.js'

export interface AuroraBrowserRawArchive {
  readonly asset_id: number
  readonly byte_size: number
  readonly filename: string
  readonly format: 'file' | 'tar_bzip2'
  readonly root?: string | null
  readonly sha256: string
  readonly updated_at: string
  readonly url: string
}

export interface AuroraBrowserRawTtsCatalog {
  readonly schema_version: number
  readonly catalog_id: string
  readonly revision: string
  readonly source: unknown
  readonly entries_sha256: string
  readonly languages: readonly string[]
  readonly entries: readonly AuroraBrowserRawTtsEntry[]
}

export interface AuroraBrowserRawTtsEntry {
  readonly voice_id: string
  readonly display_name: string
  readonly language: string
  readonly quality?: string | null
  readonly precision?: string | null
  readonly engine: string
  readonly model_family: string
  readonly archive: AuroraBrowserRawArchive & { readonly root: string }
  readonly bindings: Record<string, string>
  readonly terms: AuroraBrowserCatalogTerms
}

export interface AuroraBrowserRawSpeechCatalog {
  readonly schema_version: number
  readonly catalog_id: string
  readonly revision: string
  readonly sources: unknown
  readonly entries_sha256: string
  readonly languages: readonly string[]
  readonly entries: readonly AuroraBrowserRawSpeechEntry[]
}

export interface AuroraBrowserRawSpeechEntry {
  readonly model_id: string
  readonly display_name: string
  readonly task: 'speech_to_text' | 'voice_activity_detection' | 'keyword_spotting'
  readonly languages: readonly string[]
  readonly language_scope: string
  readonly engine: string
  readonly model_family: string
  readonly mobile_optimized?: boolean
  readonly archive: AuroraBrowserRawArchive
  readonly bindings: Record<string, string>
  readonly terms: AuroraBrowserCatalogTerms
}

export interface AuroraBrowserCatalogTerms {
  readonly download_initiated_by_user: boolean
  readonly redistributed_by_aurora: boolean
  readonly source: string
}

export interface AuroraBrowserVoiceCatalogEntry {
  readonly id: string
  readonly displayName: string
  readonly task: AuroraVoiceWebModelTask
  readonly languages: readonly string[]
  readonly archive: AuroraBrowserRawArchive
  readonly installableByBrowserArchive: boolean
  readonly terms: AuroraBrowserCatalogTerms
  toModelPackManifest(): AuroraBrowserModelPackManifest
}

export function listAuroraBrowserVoiceCatalogEntries(filters: {
  readonly task?: AuroraVoiceWebModelTask
  readonly language?: string
} = {}): readonly AuroraBrowserVoiceCatalogEntry[] {
  return allEntries()
    .filter((entry) => filters.task === undefined || entry.task === filters.task)
    .filter((entry) => filters.language === undefined || entry.languages.includes(filters.language))
}

export function findAuroraBrowserVoiceCatalogEntry(id: string): AuroraBrowserVoiceCatalogEntry | null {
  return allEntries().find((entry) => entry.id === id) ?? null
}

export function auroraBrowserVoiceCatalogSummary(): {
  readonly speechEntries: number
  readonly ttsEntries: number
  readonly speechLanguages: readonly string[]
  readonly ttsLanguages: readonly string[]
} {
  return {
    speechEntries: AURORA_BROWSER_SPEECH_CATALOG.entries.length,
    ttsEntries: AURORA_BROWSER_TTS_CATALOG.entries.length,
    speechLanguages: AURORA_BROWSER_SPEECH_CATALOG.languages,
    ttsLanguages: AURORA_BROWSER_TTS_CATALOG.languages
  }
}

function allEntries(): readonly AuroraBrowserVoiceCatalogEntry[] {
  return [
    ...AURORA_BROWSER_SPEECH_CATALOG.entries.map(speechEntry),
    ...AURORA_BROWSER_TTS_CATALOG.entries.map(ttsEntry)
  ]
}

function speechEntry(entry: AuroraBrowserRawSpeechEntry): AuroraBrowserVoiceCatalogEntry {
  const task = speechTask(entry.task)
  return {
    id: entry.model_id,
    displayName: entry.display_name,
    task,
    languages: entry.languages,
    archive: entry.archive,
    installableByBrowserArchive: archiveInstallable(entry.archive),
    terms: entry.terms,
    toModelPackManifest: () => manifestFor(entry.model_id, entry.display_name, [task], task, entry.archive, entry.bindings, speechFamily(entry), speechKind(task), entry.languages[0])
  }
}

function ttsEntry(entry: AuroraBrowserRawTtsEntry): AuroraBrowserVoiceCatalogEntry {
  return {
    id: entry.voice_id,
    displayName: entry.display_name,
    task: 'tts',
    languages: [entry.language],
    archive: entry.archive,
    installableByBrowserArchive: false,
    terms: entry.terms,
    toModelPackManifest: () => manifestFor(entry.voice_id, entry.display_name, ['tts'], 'tts', entry.archive, entry.bindings, 'piper', 'offline-tts', entry.language, entry.voice_id)
  }
}

function manifestFor(
  id: string,
  displayName: string,
  tasks: readonly AuroraVoiceWebModelTask[],
  task: AuroraVoiceWebModelTask,
  archive: AuroraBrowserRawArchive,
  bindings: Record<string, string>,
  family: AuroraVoiceWebModelDescriptor['family'],
  kind: AuroraVoiceWebModelDescriptor['kind'],
  language?: string,
  voiceId?: string
): AuroraBrowserModelPackManifest {
  const archiveFileId = `${task}-archive`
  const bindingEntries = bindingArchiveEntries(task, archive, bindings)
  return {
    schema_version: 1,
    pack_id: id,
    pack_version: archive.sha256.slice(0, 16),
    display_name: displayName,
    tasks,
    files: [{
      file_id: archiveFileId,
      asset_id: String(archive.asset_id),
      task,
      url: archive.url,
      sha256: archive.sha256,
      byte_size: archive.byte_size,
      installed_size: archive.byte_size,
      compression: archive.format === 'tar_bzip2' ? 'tar_bzip2' : 'none',
      ...(archive.root === undefined || archive.root === null ? {} : { archive_root: archive.root }),
      ...(archive.format === 'tar_bzip2' ? { archive_entries: bindingEntries } : {})
    }],
    variants: [{
      variant_id: 'web-wasm32',
      file_ids: [archiveFileId],
      target: 'web',
      os: 'web',
      arch: 'wasm32',
      model_bindings: [{
        task,
        family,
        kind,
        files: modelFileRefs(bindingEntries, bindings),
        config: {
          ...(language === undefined ? {} : { language }),
          ...(voiceId === undefined ? {} : { voiceId })
        }
      }]
    }],
    revocation: null,
    signature: null
  }
}

function bindingArchiveEntries(
  task: AuroraVoiceWebModelTask,
  archive: AuroraBrowserRawArchive,
  bindings: Record<string, string>
): readonly AuroraBrowserModelPackArchiveEntry[] {
  if (archive.format === 'file') {
    return [{ file_id: 'model', task, path: archive.filename, sha256: archive.sha256, byte_size: archive.byte_size }]
  }
  return Object.entries(bindings)
    .filter(([role]) => role !== 'model_card' && role !== 'config' && role !== 'data_dir')
    .map(([role, path]) => ({ file_id: roleFileId(role), task, path }))
}

function modelFileRefs(
  entries: readonly AuroraBrowserModelPackArchiveEntry[],
  bindings: Record<string, string>
): AuroraVoiceWebModelDescriptor['files'] {
  return Object.entries(bindings)
    .map(([role, path]) => ({ role: roleName(role), fileId: roleFileId(role), virtualPath: `/${path}` }))
    .filter((ref): ref is AuroraVoiceWebModelDescriptor['files'][number] => ref.role !== null && entries.some((entry) => entry.file_id === ref.fileId))
}

function archiveInstallable(archive: AuroraBrowserRawArchive): boolean {
  return archive.format === 'file' || archive.format === 'tar_bzip2'
}

function speechTask(task: AuroraBrowserRawSpeechEntry['task']): AuroraVoiceWebModelTask {
  if (task === 'speech_to_text') return 'stt'
  if (task === 'keyword_spotting') return 'kws'
  return 'vad'
}

function speechFamily(entry: AuroraBrowserRawSpeechEntry): AuroraVoiceWebModelDescriptor['family'] {
  if (entry.task === 'voice_activity_detection') return 'silero-vad'
  if (entry.task === 'keyword_spotting') return 'sherpa-kws-transducer'
  if (entry.model_family === 'sense_voice') return 'sense-voice'
  return 'whisper'
}

function speechKind(task: AuroraVoiceWebModelTask): AuroraVoiceWebModelDescriptor['kind'] {
  if (task === 'vad') return 'vad'
  if (task === 'kws') return 'keyword-spotter'
  return 'offline-asr'
}

function roleName(role: string): AuroraVoiceWebModelFileRole | null {
  if (role === 'merged_decoder') return 'mergedDecoder'
  if (role === 'tokenizer') return 'bpeVocab'
  if (role === 'data_dir') return 'dataDir'
  if (role === 'bpe_vocab') return 'bpeVocab'
  if (['model', 'encoder', 'decoder', 'tokens', 'joiner', 'keywords', 'lexicon'].includes(role)) {
    return role as AuroraVoiceWebModelFileRole
  }
  return null
}

function roleFileId(role: string): string {
  return role.replaceAll('_', '-')
}
