import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { AuroraLocalSpeechSelectionProfile } from './runtime-profile'

type SpeechLanguage = string
type TtsModelStatus = 'degraded' | 'error' | 'loading' | 'ready' | 'unavailable'
type TtsVoiceKind = 'cloned' | 'standard'

interface TtsResidentLanguagePack {
  pack_id: string
  ready_languages?: SpeechLanguage[] | undefined
}

interface TtsCapabilities {
  ready?: boolean | undefined
  model_status?: TtsModelStatus | undefined
  ready_languages?: SpeechLanguage[] | undefined
  supported_language_pack_ids?: string[] | undefined
  installed_language_pack_ids?: string[] | undefined
  active_language_pack_id?: string | null | undefined
  default_language_pack_id?: string | null | undefined
  language_packs?: TtsLanguagePack[] | undefined
  resident_language_packs?: TtsResidentLanguagePack[] | undefined
}

interface TtsVoice {
  voice_id: string
  display_name: string
  ready?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface TtsVoiceProfile {
  voice_id: string
  display_name: string
  revision: string
  kind: TtsVoiceKind
  active?: boolean | undefined
  default?: boolean | undefined
  enabled?: boolean | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  retained_source?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface TtsLanguagePack {
  pack_id: string
  language?: SpeechLanguage | undefined
  display_name?: string | null | undefined
  revision?: string | null | undefined
  languages?: SpeechLanguage[] | undefined
  ready_languages?: SpeechLanguage[] | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  active?: boolean | undefined
  default?: boolean | undefined
  downloadable?: boolean | undefined
  download_progress?: number | null | undefined
  compatible_engine?: boolean | undefined
  voices?: TtsLanguagePackVoice[] | undefined
}

interface TtsLanguagePackVoice {
  voice_id: string
  display_name: string
  revision: string
  installed?: boolean | undefined
  ready?: boolean | undefined
  active?: boolean | undefined
  default?: boolean | undefined
}

export interface VoiceRow {
  voiceId: string
  label: string
  detail: string
  ready: boolean
}

export interface ManagedVoice extends VoiceRow {
  revision: string
  compatiblePackIds: string[]
  installable: boolean
  canDelete: boolean
  canExport: boolean
  canRemove: boolean
  canSetDefault: boolean
  badge: string
}

export interface ManagedLanguagePack {
  packId: string
  revision: string | null
  label: string
  detail: string
  ready: boolean
  badge: string
}

export function toVoiceRow(voice: TtsVoice, index: number, capabilities: TtsCapabilities | null): VoiceRow {
  const languages = languageListForPacks(capabilities, voice.compatible_language_pack_ids)
  return {
    voiceId: voice.voice_id,
    label: safeVoiceText(voice.display_name, `Voice option ${index + 1}`),
    detail: languages.length > 0 ? `Works with ${languages.join(', ')}.` : 'Language details are unavailable.',
    ready: voice.ready === true
  }
}

export function toManagedVoice(
  profile: TtsVoiceProfile,
  index: number,
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
): ManagedVoice {
  const languages = languageListForPacks(capabilities, profile.compatible_language_pack_ids)
  const installed = profile.installed === true
  const ready = profile.ready === true
  const isDefault = profile.default === true
  const installable = canInstallProfile(profile, capabilities, catalogPacks)
  return {
    voiceId: profile.voice_id,
    revision: profile.revision,
    compatiblePackIds: profile.compatible_language_pack_ids ?? [],
    label: safeVoiceText(profile.display_name, `Available voice ${index + 1}`),
    detail: managedVoiceDetail(installed, ready, isDefault, installable, languages),
    ready,
    installable,
    canDelete: canDeleteProfile(profile),
    canExport: canExportProfile(profile),
    canRemove: canRemoveProfile(profile),
    canSetDefault: canSetDefaultProfile(profile),
    badge: isDefault ? 'Default' : ready ? 'Ready' : installed || !installable ? 'Needs setup' : 'Available to add'
  }
}

export function toPackRows(
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
): ManagedLanguagePack[] {
  const rows = new Map<string, TtsLanguagePack>()
  for (const pack of capabilities?.language_packs ?? []) rows.set(pack.pack_id, pack)
  for (const pack of catalogPacks) rows.set(pack.pack_id, { ...rows.get(pack.pack_id), ...pack })
  for (const pack of capabilities?.resident_language_packs ?? []) {
    rows.set(pack.pack_id, {
      ...rows.get(pack.pack_id),
      pack_id: pack.pack_id,
      installed: true,
      ready: true,
      ready_languages: pack.ready_languages,
    })
  }
  for (const packId of capabilities?.supported_language_pack_ids ?? []) {
    rows.set(packId, { ...rows.get(packId), pack_id: packId, downloadable: true })
  }
  for (const packId of capabilities?.installed_language_pack_ids ?? []) {
    rows.set(packId, { ...rows.get(packId), pack_id: packId, installed: true })
  }
  return Array.from(rows.values())
    .filter((pack) => safePackId(pack.pack_id) !== null)
    .sort((left, right) => packSortLabel(left).localeCompare(packSortLabel(right)))
    .map((pack, index) => toManagedLanguagePack(pack, index, capabilities))
}

export function mergeCatalogProfiles(
  profiles: readonly TtsVoiceProfile[],
  packs: readonly TtsLanguagePack[],
): TtsVoiceProfile[] {
  const byVoiceId = new Map(profiles.map((profile) => [profile.voice_id, profile]))
  for (const pack of packs) {
    for (const voice of pack.voices ?? []) {
      const existing = byVoiceId.get(voice.voice_id)
      const compatibleLanguagePackIds = [...new Set([
        ...(existing?.compatible_language_pack_ids ?? []),
        pack.pack_id,
      ])]
      byVoiceId.set(voice.voice_id, {
        voice_id: voice.voice_id,
        display_name: voice.display_name,
        revision: voice.revision,
        kind: 'standard',
        active: voice.active === true,
        default: voice.default === true,
        enabled: true,
        installed: voice.installed === true,
        ready: voice.ready === true,
        retained_source: false,
        ...existing,
        compatible_language_pack_ids: compatibleLanguagePackIds,
      })
    }
  }
  return [...byVoiceId.values()].sort((left, right) => left.voice_id.localeCompare(right.voice_id))
}

function toManagedLanguagePack(
  pack: TtsLanguagePack,
  index: number,
  capabilities: TtsCapabilities | null,
): ManagedLanguagePack {
  const packId = safePackId(pack.pack_id) ?? `voice-language-${index + 1}`
  const languages = languageList(pack.ready_languages ?? pack.languages ?? (pack.language ? [pack.language] : []))
  const installed = pack.installed === true || capabilities?.installed_language_pack_ids?.includes(packId) === true
  const ready = pack.ready === true || capabilities?.resident_language_packs?.some((resident) => resident.pack_id === packId) === true
  const isDefault = pack.default === true || capabilities?.default_language_pack_id === packId
  const active = pack.active === true || capabilities?.active_language_pack_id === packId
  const engineCompatible = pack.compatible_engine !== false
  const downloadProgress = typeof pack.download_progress === 'number' && Number.isFinite(pack.download_progress)
    ? Math.max(0, Math.min(100, pack.download_progress))
    : null
  return {
    packId,
    revision: typeof pack.revision === 'string' && pack.revision.trim() ? pack.revision : null,
    label: safeVoiceText(pack.display_name, languages.length > 0 ? languages.join(', ') : `Language option ${index + 1}`),
    detail: languagePackDetail({ installed, ready, isDefault, active, engineCompatible, downloadProgress, languages }),
    ready,
    badge: isDefault ? 'Default' : ready ? 'Ready' : installed ? 'Needs setup' : downloadProgress !== null ? 'Adding' : 'Available'
  }
}

export function confirmedTtsSelection(
  profile: ManagedVoice,
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
): AuroraLocalSpeechSelectionProfile | null {
  const pack = exactPackForVoiceSelection(profile, capabilities, catalogPacks)
  if (!pack?.revision) return null
  return {
    tts: {
      packId: pack.packId,
      packRevision: pack.revision,
      voiceId: profile.voiceId,
      voiceRevision: profile.revision,
    },
  }
}

function exactPackForVoiceSelection(
  profile: ManagedVoice,
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
): ManagedLanguagePack | null {
  const rows = toPackRows(capabilities, catalogPacks)
  const catalogCompatiblePackIds = [...catalogPacks, ...(capabilities?.language_packs ?? [])]
    .filter((pack) => pack.voices?.some((voice) => voice.voice_id === profile.voiceId && voice.revision === profile.revision))
    .map((pack) => pack.pack_id)
  const compatible = new Set(profile.compatiblePackIds.length > 0
    ? profile.compatiblePackIds
    : catalogCompatiblePackIds)
  for (const pack of rows) {
    if (compatible.has(pack.packId) && pack.revision) return pack
  }
  return null
}

function canInstallProfile(
  profile: TtsVoiceProfile,
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
): boolean {
  if (profile.installed === true) return false
  if (profile.enabled === false) return false
  if (profile.kind !== 'standard') return false
  if (!capabilities) return false
  const supportedPacks = new Set([...(capabilities.supported_language_pack_ids ?? []), ...(capabilities.installed_language_pack_ids ?? [])])
  if (supportedPacks.size === 0) return false
  const compatible = profile.compatible_language_pack_ids ?? []
  if (compatible.some((packId) => supportedPacks.has(packId))) return true
  return compatible.some((packId) => catalogPackCanRunProfile(profile, packId, catalogPacks, supportedPacks))
}

function catalogPackCanRunProfile(
  profile: TtsVoiceProfile,
  packId: string,
  catalogPacks: readonly TtsLanguagePack[],
  supportedPacks: ReadonlySet<string>,
): boolean {
  const pack = catalogPacks.find((candidate) => candidate.pack_id === packId)
  if (!pack || pack.downloadable === false || pack.compatible_engine === false) return false
  if (!pack.voices?.some((voice) => voice.voice_id === profile.voice_id && voice.revision === profile.revision)) return false
  return capabilityPackIdsForCatalogPack(pack).some((candidate) => supportedPacks.has(candidate))
}

function capabilityPackIdsForCatalogPack(pack: TtsLanguagePack): string[] {
  const candidates = new Set<string>()
  for (const value of [
    pack.pack_id,
    pack.language,
    ...(pack.languages ?? []),
    ...(pack.ready_languages ?? []),
  ]) {
    const normalized = normalizeLanguageTag(value ?? '')
    if (normalized) {
      candidates.add(normalized)
      candidates.add(`${normalized}-local`)
    }
  }
  return [...candidates]
}

function canSetDefaultProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.installed === true && profile.ready === true && profile.default !== true
}

function canRemoveProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.kind === 'standard' && profile.installed === true && profile.default !== true && profile.active !== true
}

function canDeleteProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.kind === 'cloned' && profile.default !== true && profile.active !== true
}

function canExportProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.kind === 'cloned' && profile.installed === true && profile.ready === true
}

function managedVoiceDetail(installed: boolean, ready: boolean, isDefault: boolean, installable: boolean, languages: string[]): string {
  const languageCopy = languages.length > 0 ? ` ${languages.join(', ')}.` : ''
  if (isDefault) return `Used by default for spoken replies.${languageCopy}`
  if (ready) return `Ready for spoken replies.${languageCopy}`
  if (installed) return `Available but not ready yet.${languageCopy}`
  if (!installable) return `Not available for spoken replies on this Aurora.${languageCopy}`
  return `Can be added for spoken replies.${languageCopy}`
}

function languagePackDetail(input: {
  installed: boolean
  ready: boolean
  isDefault: boolean
  active: boolean
  engineCompatible: boolean
  downloadProgress: number | null
  languages: string[]
}): string {
  const languageCopy = input.languages.length > 0 ? ` ${input.languages.join(', ')}.` : ''
  if (!input.engineCompatible) return `This language cannot run on this device right now.${languageCopy}`
  if (input.downloadProgress !== null && !input.ready) return `Adding language. ${Math.round(input.downloadProgress)} percent complete.${languageCopy}`
  if (input.isDefault) return `Used by default for spoken replies.${languageCopy}`
  if (input.active) return `Currently used for spoken replies.${languageCopy}`
  if (input.ready) return `Ready for spoken replies.${languageCopy}`
  if (input.installed) return `Available but not ready yet.${languageCopy}`
  return `Available with supported voices.${languageCopy}`
}

export function readinessLabel(capabilities: TtsCapabilities | null): string {
  if (!capabilities) return 'Checking'
  if (capabilities.ready) return 'Ready'
  if (capabilities.model_status === 'loading') return 'Starting'
  return 'Needs setup'
}

export function spokenReplyReadinessCaption(capabilities: TtsCapabilities | null, surfaceProfile: AuroraSurfaceProfile): string {
  if (capabilities?.ready !== true) return 'Choose an available voice to start.'
  if (surfaceProfile.localSpeechPack.canRunLocalTts) return 'This device can speak without a remote connection.'
  if (surfaceProfile.isRemoteConsole) return 'Spoken replies come from the connected Aurora device.'
  return 'This device needs attention before it can speak on its own.'
}

export function languageList(values: readonly string[] | null | undefined): string[] {
  return [...new Set(values ?? [])]
    .map((value) => languageLabel(value))
    .filter((value): value is string => Boolean(value))
}

export function languageListForPacks(capabilities: TtsCapabilities | null, packIds: readonly string[] | null | undefined): string[] {
  if (!capabilities || !packIds || packIds.length === 0) return []
  const packs = new Set(packIds)
  return languageList(
    capabilities.resident_language_packs
      ?.filter((pack) => packs.has(pack.pack_id))
      .flatMap((pack) => pack.ready_languages ?? [])
  )
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

function packSortLabel(pack: TtsLanguagePack): string {
  return safeVoiceText(pack.display_name, '') || languageList(pack.ready_languages ?? pack.languages ?? (pack.language ? [pack.language] : [])).join(', ') || pack.pack_id
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
  return value.replace(/\b[\p{L}]/gu, (match) => match.toLocaleUpperCase())
}
