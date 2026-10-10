import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'
import type { AuroraBrowserPocketReferenceProfileSummary, AuroraBrowserSpeechPackCatalogSelection } from './browser-speech-pack'
import type { AuroraSurfaceProfile } from './platform-surface'
import {
  AUTO_LOCAL_VOICE_LANGUAGE,
  DEFAULT_LOCAL_PRIMARY_LANGUAGE,
  type AuroraLocalSpeechSelectionProfile,
  type AuroraLocalSpeechTask,
  type AuroraRuntimeProfileV2,
} from './runtime-profile'
import type { SearchableChoiceOption } from './voice-settings-searchable-choice'

type LocalSpeechCatalogTask = Exclude<AuroraLocalSpeechTask, 'tts'>

interface LocalSpeechCatalogAsset {
  task?: LocalSpeechCatalogTask | 'wakeword' | 'wkw' | undefined
  pack_id?: string | undefined
  packId?: string | undefined
  revision?: string | null | undefined
  pack_revision?: string | null | undefined
  display_name?: string | null | undefined
  label?: string | null | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  enabled?: boolean | undefined
  compatible_engine?: boolean | undefined
}

interface LocalSpeechCapabilities {
  local_speech_assets?: Partial<Record<LocalSpeechCatalogTask | 'wakeword' | 'wkw', LocalSpeechCatalogAsset[]>> | undefined
  local_speech_packs?: LocalSpeechCatalogAsset[] | undefined
}

export interface WakePhraseOption {
  phraseId: string
  phraseText: string
  locale: string
  label: string
  detail: string
}

export interface LocalSpeechAssetRow {
  task: AuroraLocalSpeechTask
  packId: string
  revision: string
  profilePackId?: string | undefined
  profilePackRevision?: string | undefined
  label: string
  language?: string | undefined
  ready: boolean
  needsReferenceProfile?: boolean | undefined
  referenceProfileId?: string | undefined
  voiceId?: string | undefined
  voiceRevision?: string | undefined
  selection?: AuroraBrowserSpeechPackCatalogSelection | undefined
  copy: {
    action: string
    detail: string
    noun: string
  }
}

export function toLocalSpeechAssetRows(
  capabilities: LocalSpeechCapabilities | null,
  localSpeechPack: AuroraSurfaceProfile['localSpeechPack'],
): LocalSpeechAssetRow[] {
  if (!capabilities) return []
  const rows: LocalSpeechAssetRow[] = []
  const seen = new Set<string>()
  for (const task of ['vad', 'kws', 'stt'] as const) {
    if (!localSpeechTaskCanRun(task, localSpeechPack)) continue
    const assets = localSpeechCatalogAssets(capabilities, task)
    for (const asset of assets) {
      const row = toLocalSpeechAssetRow(task, asset, rows.length)
      if (!row) continue
      const key = `${row.task}:${row.packId}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }
  return rows
}

export function toBrowserSpeechAssetRows(
  items: readonly AuroraBrowserSpeechPackCatalogSelection[],
  currentSelection: AuroraLocalSpeechSelectionProfile | null,
  referenceProfiles: readonly AuroraBrowserPocketReferenceProfileSummary[],
  ttsOnly: boolean,
): LocalSpeechAssetRow[] {
  const rows: LocalSpeechAssetRow[] = []
  const seen = new Set<string>()
  const knownReferenceProfileIds = new Set(referenceProfiles.map((profile) => profile.id))
  for (const item of items) {
    if (ttsOnly !== (item.task === 'tts')) continue
    const packId = safePackId(item.packId)
    const revision = safePackId(item.packVersion)
    if (!packId || !revision) continue
    const copy = localSpeechTaskCopy(item.task)
    const currentTaskSelection = currentSelection?.[item.task]
    const selectedReferenceProfileId = item.referenceProfileId ?? currentTaskSelection?.referenceProfileId
    const selectedReferenceProfileReady = selectedReferenceProfileId ? knownReferenceProfileIds.has(selectedReferenceProfileId) : false
    const referenceProfileReady = item.requiresReferenceProfile !== true || item.referenceProfileSelected === true || selectedReferenceProfileReady
    const selected = localSpeechSelectionMatches(currentSelection?.[item.task], item, referenceProfiles) && referenceProfileReady
    const detail = item.requiresReferenceProfile === true && !referenceProfileReady
      ? `${copy.detail} Add a voice sample before using this voice.`
      : item.language ? `${copy.detail} ${item.language}.` : copy.detail
    const row: LocalSpeechAssetRow = {
      task: item.task,
      packId,
      revision,
      ...(item.profilePackId ? { profilePackId: item.profilePackId } : {}),
      ...(item.profilePackRevision ? { profilePackRevision: item.profilePackRevision } : {}),
      label: safeVoiceText(item.displayName, `${copy.noun} option ${rows.length + 1}`),
      ...(item.language ? { language: item.language } : {}),
      ready: referenceProfileReady && (item.active === true || item.cached === true || selected),
      needsReferenceProfile: item.requiresReferenceProfile === true && !referenceProfileReady,
      ...(selectedReferenceProfileId && selectedReferenceProfileReady ? { referenceProfileId: selectedReferenceProfileId } : {}),
      ...(item.voiceId ? { voiceId: item.voiceId } : {}),
      ...(item.voiceRevision ? { voiceRevision: item.voiceRevision } : {}),
      selection: selectedReferenceProfileId && item.referenceProfileId !== selectedReferenceProfileId
        ? { ...item, referenceProfileId: selectedReferenceProfileId, referenceProfileSelected: true }
        : item,
      copy: {
        ...copy,
        detail,
      },
    }
    const key = localSpeechActionKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return rows.sort((left, right) => left.label.localeCompare(right.label))
}

function localSpeechTaskCanRun(
  task: LocalSpeechCatalogTask,
  localSpeechPack: AuroraSurfaceProfile['localSpeechPack'],
): boolean {
  if (task === 'vad') return localSpeechPack.canRunLocalVad
  if (task === 'kws') return localSpeechPack.canRunLocalKws
  return localSpeechPack.canRunLocalStt
}

function localSpeechCatalogAssets(
  capabilities: LocalSpeechCapabilities,
  task: LocalSpeechCatalogTask,
): LocalSpeechCatalogAsset[] {
  const grouped = capabilities.local_speech_assets ?? {}
  const groupedAssets = [
    ...(grouped[task] ?? []),
    ...(task === 'kws' ? [...(grouped.wakeword ?? []), ...(grouped.wkw ?? [])] : []),
  ]
  const flatAssets = (capabilities.local_speech_packs ?? []).filter((asset) => normalizeLocalSpeechTask(asset.task) === task)
  return [...groupedAssets, ...flatAssets]
}

function toLocalSpeechAssetRow(
  task: LocalSpeechCatalogTask,
  asset: LocalSpeechCatalogAsset,
  index: number,
): LocalSpeechAssetRow | null {
  if (asset.enabled === false || asset.compatible_engine === false) return null
  const packId = safePackId(asset.pack_id ?? asset.packId)
  const revision = safePackId(asset.revision ?? asset.pack_revision)
  if (!packId || !revision) return null
  const copy = localSpeechTaskCopy(task)
  const label = safeVoiceText(asset.display_name ?? asset.label, `${copy.noun} option ${index + 1}`)
  const language = languageCodeFromText(asset.display_name ?? asset.label ?? packId)
  return {
    task,
    packId,
    revision,
    label,
    ...(language ? { language } : {}),
    ready: asset.ready === true || asset.installed === true,
    copy,
  }
}

function normalizeLocalSpeechTask(task: unknown): LocalSpeechCatalogTask | null {
  if (task === 'vad' || task === 'stt') return task
  if (task === 'kws' || task === 'wakeword' || task === 'wkw') return 'kws'
  return null
}

function localSpeechTaskCopy(task: AuroraLocalSpeechTask): LocalSpeechAssetRow['copy'] {
  if (task === 'vad') {
    return {
      action: 'Use listening start',
      detail: 'Helps Aurora notice when speech begins.',
      noun: 'Listening start',
    }
  }
  if (task === 'kws') {
    return {
      action: 'Use wake phrase',
      detail: 'Lets Aurora listen for its wake phrase on this device.',
      noun: 'Wake phrase',
    }
  }
  if (task === 'tts') {
    return {
      action: 'Use voice',
      detail: 'Lets Aurora speak on this device.',
      noun: 'Voice',
    }
  }
  return {
    action: 'Use transcription',
    detail: 'Turns your speech into text on this device.',
    noun: 'Transcription',
  }
}

function localSpeechSelectionMatches(
  current: AuroraLocalSpeechSelectionProfile[AuroraLocalSpeechTask] | undefined,
  item: AuroraBrowserSpeechPackCatalogSelection,
  referenceProfiles: readonly AuroraBrowserPocketReferenceProfileSummary[],
): boolean {
  if (!current) return false
  if (
    current.packId !== (item.profilePackId ?? item.packId)
    || current.packRevision !== (item.profilePackRevision ?? item.packVersion)
  ) return false
  if (item.task !== 'tts') return true
  const referenceReady = current.referenceProfileId
    ? referenceProfiles.some((profile) => profile.id === current.referenceProfileId)
    : false
  return current.voiceId === item.voiceId && current.voiceRevision === item.voiceRevision
    && (item.requiresReferenceProfile !== true || referenceReady)
}

export function localSpeechSelectionForRow(
  row: LocalSpeechAssetRow,
  referenceProfileId?: string,
): AuroraLocalSpeechSelectionProfile {
  return {
    [row.task]: {
      packId: row.profilePackId ?? row.packId,
      packRevision: row.profilePackRevision ?? row.revision,
      ...(row.voiceId ? { voiceId: row.voiceId } : {}),
      ...(row.voiceRevision ? { voiceRevision: row.voiceRevision } : {}),
      ...(referenceProfileId ? { referenceProfileId } : {}),
    },
  }
}

export function localSpeechActionKey(row: Pick<LocalSpeechAssetRow, 'packId' | 'task' | 'voiceId'>): string {
  return `local:${row.task}:${row.packId}:${row.voiceId ?? ''}`
}

const SPEECH_LANGUAGE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['en', ['english']],
  ['zh', ['chinese', 'mandarin', 'cantonese']],
  ['de', ['german']],
  ['es', ['spanish']],
  ['fr', ['french']],
  ['pt', ['portuguese']],
  ['ja', ['japanese']],
  ['ko', ['korean']],
  ['it', ['italian']],
  ['nl', ['dutch']],
  ['pl', ['polish']],
  ['ru', ['russian']],
  ['ar', ['arabic']],
  ['hi', ['hindi']],
]

export function primaryLanguageFromConfig(config: unknown): string {
  if (!config || typeof config !== 'object') return 'en'
  const record = config as Record<string, unknown>
  const nested = record.system
  const source = nested && typeof nested === 'object' ? nested as Record<string, unknown> : record
  const raw = source.primary_language
  return languageCodeFromText(typeof raw === 'string' ? raw : '') ?? 'en'
}

export function speechLanguageChoices(
  rows: readonly LocalSpeechAssetRow[],
  preferred: string | null,
): SearchableChoiceOption[] {
  const preferredCode = baseLanguageCode(preferred ?? DEFAULT_LOCAL_PRIMARY_LANGUAGE) ?? DEFAULT_LOCAL_PRIMARY_LANGUAGE
  const codes = new Set<string>([preferredCode])
  for (const row of rows) {
    const code = baseLanguageCode(speechLanguageTagFromRow(row) ?? '')
    if (code) codes.add(code)
  }
  return [...codes]
    .sort((left, right) => {
      if (left === preferredCode) return -1
      if (right === preferredCode) return 1
      const leftLabel = languageLabel(left) ?? left
      const rightLabel = languageLabel(right) ?? right
      return leftLabel.localeCompare(rightLabel)
    })
    .map((id) => ({ id, label: languageLabel(id) ?? id }))
}

export function voiceLanguageChoices(
  rows: readonly LocalSpeechAssetRow[],
  preferredVoice: string | null,
  preferredPrimary: string | null,
): SearchableChoiceOption[] {
  const preferred = preferredVoice === AUTO_LOCAL_VOICE_LANGUAGE
    ? preferredPrimary
    : preferredVoice
  const languages = speechLanguageChoices(rows, preferred)
  return [
    { id: AUTO_LOCAL_VOICE_LANGUAGE, label: 'Automatic' },
    ...languages.filter((option) => option.id !== AUTO_LOCAL_VOICE_LANGUAGE),
  ]
}

export function filterSpeechRowsForLanguage(
  rows: readonly LocalSpeechAssetRow[],
  language: string,
  selected: LocalSpeechAssetRow | null,
): LocalSpeechAssetRow[] {
  const selectedKey = selected ? localSpeechActionKey(selected) : null
  const matched = rows.filter((row) => (
    rowMatchesSpeechLanguage(row, language)
    || (selectedKey !== null && localSpeechActionKey(row) === selectedKey)
  ))
  return matched.length > 0 ? matched : [...rows]
}

export function selectedSpeechRow(
  rows: readonly LocalSpeechAssetRow[],
  current: AuroraLocalSpeechSelectionProfile[AuroraLocalSpeechTask] | undefined,
  referenceProfiles: readonly AuroraBrowserPocketReferenceProfileSummary[],
): LocalSpeechAssetRow | null {
  if (!current) return null
  return rows.find((row) => {
    if (row.selection) return localSpeechSelectionMatches(current, row.selection, referenceProfiles)
    return row.packId === current.packId && row.revision === current.packRevision
  }) ?? null
}

export function displayedSpeechRow(
  selected: LocalSpeechAssetRow | null,
  rows: readonly LocalSpeechAssetRow[],
): LocalSpeechAssetRow | null {
  return selected ?? rows.find((row) => row.ready) ?? rows[0] ?? null
}

export function speechRowChoiceOptions(
  rows: readonly LocalSpeechAssetRow[],
  actionPending: boolean,
): SearchableChoiceOption[] {
  return rows.map((row) => ({
    id: localSpeechActionKey(row),
    label: row.label,
    detail: row.copy.detail,
    disabled: actionPending || (!row.ready && !row.selection),
  }))
}

function rowMatchesSpeechLanguage(row: LocalSpeechAssetRow, language: string): boolean {
  const wanted = baseLanguageCode(language)
  if (!wanted) return false
  const rowTag = speechLanguageTagFromRow(row)
  if (!rowTag) return true
  return baseLanguageCode(rowTag) === wanted
}

function speechLanguageTagFromRow(row: LocalSpeechAssetRow): string | null {
  const explicit = typeof row.language === 'string' ? normalizeLanguageTag(row.language.replaceAll('_', '-')) : null
  if (explicit) return explicit
  return languageCodeFromText(row.language)
    ?? languageCodeFromText(row.packId)
    ?? languageCodeFromText(row.label)
}

function baseLanguageCode(value: string): string | null {
  const compact = value.trim()
  if (!compact) return null
  const tagged = normalizeLanguageTag(compact.replaceAll('_', '-'))
  if (tagged) return tagged.split('-')[0]!.toLowerCase()
  return languageCodeFromText(compact)
}

export function languageCodeFromText(value: string | undefined): string | null {
  if (!value) return null
  const compact = value.trim()
  if (!compact) return null
  const tagged = normalizeLanguageTag(compact.replaceAll('_', '-'))
  if (tagged) return tagged.split('-')[0]!.toLowerCase()
  const first = compact.split(/[\s,/]/u)[0]
  const firstTag = first ? normalizeLanguageTag(first.replaceAll('_', '-')) : null
  if (firstTag) return firstTag.split('-')[0]!.toLowerCase()
  const lower = compact.toLowerCase()
  for (const [code, names] of SPEECH_LANGUAGE_ALIASES) {
    if (names.some((name) => lower === name || lower.includes(name))) return code
  }
  const suffix = lower.match(/(?:^|[._:-])([a-z]{2})(?:-[a-z0-9]+)?$/u)
  if (suffix?.[1] && /^[a-z]{2}$/u.test(suffix[1])) return suffix[1]
  return null
}

function safeVoiceText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const compact = value.trim().replace(/\s+/gu, ' ')
  if (!compact || compact.length > 80) return fallback
  if (findForbiddenProductionCopyTerms(compact).length > 0) return fallback
  if (/^(?:standard|clone):/iu.test(compact)) return fallback
  if (/[a-z0-9]+(?:[._:-][a-z0-9]+){2,}/iu.test(compact)) return fallback
  return compact
}

function safePackId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.trim()
  if (!compact || compact.length > 256) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(compact)) return null
  return compact
}

function languageLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeLanguageTag(value)
  if (!normalized) return null
  try {
    const displayNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
      ? new Intl.DisplayNames(['en'], { type: 'language' })
      : null
    const label = displayNames?.of(normalized)
    if (label && label !== normalized) return titleCaseLanguage(label)
  } catch {
    // Ignore browser language-display gaps; the normalized tag is still useful.
  }
  return normalized
}

function normalizeLanguageTag(value: string): string | null {
  const compact = value.trim().replaceAll('_', '-')
  if (!/^(?:[a-zA-Z]{2,3}|und)(?:-[a-zA-Z0-9]{2,8}){0,6}$/u.test(compact)) return null
  const parts = compact.split('-')
  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase()
    if (/^[a-zA-Z]{4}$/u.test(part)) return part[0]!.toUpperCase() + part.slice(1).toLowerCase()
    if (/^[a-zA-Z]{2}$|^\d{3}$/u.test(part)) return part.toUpperCase()
    return part.toLowerCase()
  }).join('-')
}

function titleCaseLanguage(value: string): string {
  return value.replace(/(^|[\s-])([a-z])/gu, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
}

export function confirmedWakePhraseSelection(
  runtimeProfile: AuroraRuntimeProfileV2 | null,
  option: WakePhraseOption,
): AuroraLocalSpeechSelectionProfile | null {
  const current = runtimeProfile?.localNode.localSpeechSelection
  const kws = current?.kws
  if (!kws) return null
  return {
    ...current,
    wakePhrase: {
      phraseId: option.phraseId,
      phrase: option.phraseText,
      language: option.locale,
      revision: wakePhraseRevision(kws, option),
    },
  }
}

export function wakePhraseOptionsFor(runtimeProfile: AuroraRuntimeProfileV2 | null): WakePhraseOption[] {
  const kws = runtimeProfile?.localNode.localSpeechSelection?.kws
  if (!kws) return []
  const locale = localeForWakePack(kws.packId)
  if (locale === 'bilingual') {
    return [
      wakePhraseOption('light-up.en', 'Light up', 'en', 'English'),
      wakePhraseOption('hey-aurora.en', 'Hey Aurora', 'en', 'English'),
      wakePhraseOption('aurora.en', 'Aurora', 'en', 'English'),
      wakePhraseOption('ni-hao-aurora.zh', '你好 Aurora', 'zh', 'Chinese'),
    ]
  }
  if (locale === 'zh') {
    return [
      wakePhraseOption('ni-hao-aurora.zh', '你好 Aurora', 'zh', 'Chinese'),
      wakePhraseOption('aurora.zh', 'Aurora', 'zh', 'Chinese'),
    ]
  }
  if (locale === 'en') {
    return [
      wakePhraseOption('light-up.en', 'Light up', 'en', 'English'),
      wakePhraseOption('hey-aurora.en', 'Hey Aurora', 'en', 'English'),
      wakePhraseOption('aurora.en', 'Aurora', 'en', 'English'),
    ]
  }
  return [
    wakePhraseOption('hey-aurora.und', 'Hey Aurora', 'und', 'selected wake language'),
    wakePhraseOption('aurora.und', 'Aurora', 'und', 'selected wake language'),
  ]
}

function wakePhraseOption(
  phraseId: string,
  phraseText: string,
  locale: string,
  languageLabelValue: string,
): WakePhraseOption {
  return {
    phraseId,
    phraseText,
    locale,
    label: phraseText,
    detail: `Works with the ${languageLabelValue} wake language.`,
  }
}

function localeForWakePack(packId: string): 'en' | 'zh' | 'bilingual' | 'und' {
  const normalized = packId.toLowerCase()
  const supportsChinese = /(?:^|[._:-])(?:zh|cn|chinese|wenet)(?:$|[._:-])/u.test(normalized)
  const supportsEnglish = /(?:^|[._:-])(?:en|english|giga|gigaspeech)(?:$|[._:-])/u.test(normalized)
  if (supportsChinese && supportsEnglish) return 'bilingual'
  if (supportsChinese) return 'zh'
  if (supportsEnglish) return 'en'
  return 'und'
}

function wakePhraseRevision(
  kws: NonNullable<AuroraLocalSpeechSelectionProfile['kws']>,
  option: WakePhraseOption,
): string {
  const normalized = [
    option.phraseText.trim().replace(/\s+/gu, ' ').toLocaleLowerCase(),
    option.locale.toLocaleLowerCase(),
    kws.packId,
    kws.packRevision,
  ].join('\n')
  return `wakephrase-v1-${fnv1aBase36(normalized)}`
}

function fnv1aBase36(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}
