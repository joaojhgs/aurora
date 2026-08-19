import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import type { AuroraThinConnectionMode } from './connection-mode'

const MAX_RUNTIME_PROFILE_COUNT = 64
const MAX_RUNTIME_PROFILE_DOCUMENT_BYTES = 128 * 1024
const CAPABILITY_PACK_ORDER: AuroraCapabilityPack[] = [
  'local-tools',
  'native-actions',
  'local-conversations',
  'lightweight-memory',
  'lightweight-orchestrator',
  'foreground-voice',
  'local-inference',
]

export type AuroraSurfaceKind =
  | 'hosted-web'
  | 'desktop-tauri'
  | 'android'
  | 'ios'
  | 'test'
  | 'unknown'

/** @deprecated Use AuroraSurfaceKind. */
export type AuroraPhysicalSurfaceKind = AuroraSurfaceKind

export type LegacyAuroraSurfaceKind =
  | 'desktop-local'
  | 'desktop-thin'
  | 'web'
  | 'android'
  | 'ios'
  | 'mobile'
  | 'mock'
  | 'unknown'

export type AuroraNodeMode = 'remote-console' | 'mesh-node'
export type AuroraConnectionMode = 'http-only' | 'webrtc-only' | 'webrtc-preferred'
export type AuroraRuntimeTier = 'none' | 'lightweight-ts' | 'python-full'
export type AuroraAuthority = 'unauthenticated' | 'view' | 'use' | 'manage' | 'admin'
export type AuroraCapabilityPack =
  | 'local-tools'
  | 'native-actions'
  | 'local-conversations'
  | 'lightweight-memory'
  | 'lightweight-orchestrator'
  | 'foreground-voice'
  | 'local-inference'

export type AuroraLocalSpeechTask = 'kws' | 'stt' | 'tts' | 'vad'

export type AuroraLocalSpeechPackState =
  | 'disabled'
  | 'downloading'
  | 'incompatible'
  | 'over-budget'
  | 'ready'
  | 'unavailable'

export interface AuroraLocalSpeechAssetSelection {
  packId: string
  packRevision: string
  voiceId?: string | undefined
  voiceRevision?: string | undefined
  referenceProfileId?: string | undefined
}

export interface AuroraLocalWakePhraseSelection {
  phraseId: string
  phrase: string
  language: string
  revision: string
}

export type AuroraLocalSpeechSelectionProfile = Partial<Record<
  AuroraLocalSpeechTask,
  AuroraLocalSpeechAssetSelection
>> & {
  wakePhrase?: AuroraLocalWakePhraseSelection | undefined
}

export const DEFAULT_LOCAL_PRIMARY_LANGUAGE = 'en'
export const AUTO_LOCAL_VOICE_LANGUAGE = 'auto'

const SPEECH_LANGUAGE_TAG_RE = /^(?:[a-z]{2,8}(?:-[a-z0-9]{1,8})*|[ix](?:-[a-z0-9]{1,8})+)$/u

/** Device language prefs mirroring server `system.primary_language` / `system.voice_language`. */
export interface AuroraLocalSpeechLanguagePrefs {
  primaryLanguage?: string | undefined
  voiceLanguage?: string | undefined
}

export type AuroraLocalSpeechPreferencesSave = (
  selection: AuroraLocalSpeechSelectionProfile,
  languages?: AuroraLocalSpeechLanguagePrefs,
) => void | Promise<void>

export interface AuroraLocalSpeechLanguagePolicy {
  primaryLanguage: string
  voiceLanguage: string
  modelLanguage: string
}

export const DEFAULT_DESKTOP_OVERLAY_HOTKEY = 'CommandOrControl+K'
export const DEFAULT_DESKTOP_OVERLAY_AUTO_CLOSE_DELAY_MS = 1200

export interface AuroraDesktopOverlayPreferences {
  enabled: boolean
  voiceEnabled: boolean
  textHotkey: string
  autoCloseDelayMs: number
}

export type AuroraDesktopOverlaySave = (
  overlay: AuroraDesktopOverlayPreferences,
) => void | Promise<void>

export function defaultDesktopOverlayPreferences(): AuroraDesktopOverlayPreferences {
  return {
    enabled: true,
    voiceEnabled: true,
    textHotkey: DEFAULT_DESKTOP_OVERLAY_HOTKEY,
    autoCloseDelayMs: DEFAULT_DESKTOP_OVERLAY_AUTO_CLOSE_DELAY_MS,
  }
}

export function resolveDesktopOverlayPreferences(
  value: Partial<AuroraDesktopOverlayPreferences> | null | undefined,
): AuroraDesktopOverlayPreferences {
  const defaults = defaultDesktopOverlayPreferences()
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : defaults.enabled,
    voiceEnabled: typeof value?.voiceEnabled === 'boolean' ? value.voiceEnabled : defaults.voiceEnabled,
    textHotkey: normalizeDesktopOverlayHotkey(value?.textHotkey) ?? defaults.textHotkey,
    autoCloseDelayMs: normalizeDesktopOverlayDelayMs(value?.autoCloseDelayMs) ?? defaults.autoCloseDelayMs,
  }
}

export function mergeLocalNodeDesktopOverlay(
  localNode: AuroraLocalNodeProfile,
  overlay: Partial<AuroraDesktopOverlayPreferences>,
): AuroraLocalNodeProfile {
  return {
    ...localNode,
    desktopOverlay: resolveDesktopOverlayPreferences({
      ...localNode.desktopOverlay,
      ...overlay,
    }),
  }
}

export interface AuroraHomeConnectionProfile {
  mode: AuroraConnectionMode
  gatewayUrl?: string | undefined
  signalingUrl?: string | undefined
  homePeerId?: string | undefined
  webrtcProfile?: WebRtcPeerConnectionProfile | undefined
}

export interface AuroraMeshMembershipProfile {
  signalingUrl: string
  webrtcProfile: WebRtcPeerConnectionProfile
}

export interface AuroraLocalNodeProfile {
  nodeName: string
  stablePeerId: string
  enabledCapabilityPacks: AuroraCapabilityPack[]
  /** BCP 47 tag used when one device language is required. Default `en`. */
  primaryLanguage?: string | undefined
  /** `auto` or a BCP 47 tag that pins listening and speaking. Default `auto`. */
  voiceLanguage?: string | undefined
  /** Last known non-ready state; the voice engine remains the execution authority. */
  localSpeechPackState?: AuroraLocalSpeechPackState | undefined
  /** Exact selected local speech assets; operational readiness remains engine-owned. */
  localSpeechSelection?: AuroraLocalSpeechSelectionProfile | undefined
  /** Desktop overlay and shortcut prefs for this device; never server config. */
  desktopOverlay?: AuroraDesktopOverlayPreferences | undefined
  meshMembership?: AuroraMeshMembershipProfile | undefined
}

export interface AuroraRuntimeProfileV2 {
  version: 2
  id: string
  label: string
  nodeMode: AuroraNodeMode
  runtimeTier: AuroraRuntimeTier
  homeConnection?: AuroraHomeConnectionProfile | undefined
  localNode: AuroraLocalNodeProfile
}

export interface AuroraRuntimeProfileDocumentV2 {
  version: 2
  activeProfileId: string | null
  profiles: AuroraRuntimeProfileV2[]
}

export interface RuntimeProfileValidationOptions {
  allowPythonFull?: boolean | undefined
}

interface ThinConnectionProfileV1 {
  id: string
  label: string
  mode: AuroraThinConnectionMode
  gatewayUrl: string
  signalingUrl: string
  nodeName: string
  localStablePeerId: string
  webrtcProfile?: WebRtcPeerConnectionProfile | undefined
}

interface ThinProfileDocumentV1 {
  version: 1
  activeProfileId: string | null
  profiles: ThinConnectionProfileV1[]
}

type ProfileDocumentWire = AuroraRuntimeProfileDocumentV2 | ThinProfileDocumentV1

export function emptyRuntimeProfileDocument(): AuroraRuntimeProfileDocumentV2 {
  return {
    version: 2,
    activeProfileId: null,
    profiles: [],
  }
}

export function activeRuntimeProfile(
  document: AuroraRuntimeProfileDocumentV2 | null | undefined,
): AuroraRuntimeProfileV2 | undefined {
  if (!document?.activeProfileId) return undefined
  return document.profiles.find((profile) => profile.id === document.activeProfileId)
}

export function resolveLocalSpeechLanguagePolicy(
  primaryLanguage: string | null | undefined,
  voiceLanguage: string | null | undefined,
): AuroraLocalSpeechLanguagePolicy {
  const primary = normalizeOptionalSpeechLanguage(primaryLanguage, false)
    ?? DEFAULT_LOCAL_PRIMARY_LANGUAGE
  const voice = normalizeOptionalSpeechLanguage(voiceLanguage, true)
    ?? AUTO_LOCAL_VOICE_LANGUAGE
  return {
    primaryLanguage: primary,
    voiceLanguage: voice,
    modelLanguage: voice === AUTO_LOCAL_VOICE_LANGUAGE ? primary : voice,
  }
}

export function localSpeechSelectionHasAssetPatch(
  selection: AuroraLocalSpeechSelectionProfile | null | undefined,
): boolean {
  if (!selection) return false
  return Boolean(selection.vad || selection.kws || selection.stt || selection.tts || selection.wakePhrase)
}

export function mergeLocalNodeSpeechPreferences(
  localNode: AuroraLocalNodeProfile,
  selection?: AuroraLocalSpeechSelectionProfile,
  languages?: AuroraLocalSpeechLanguagePrefs,
): AuroraLocalNodeProfile {
  const localSpeechSelection = localSpeechSelectionHasAssetPatch(selection)
    ? {
        ...(localNode.localSpeechSelection ?? {}),
        ...selection,
      }
    : localNode.localSpeechSelection
  return {
    ...localNode,
    ...(localSpeechSelection ? { localSpeechSelection } : {}),
    ...(languages?.primaryLanguage !== undefined ? { primaryLanguage: languages.primaryLanguage } : {}),
    ...(languages?.voiceLanguage !== undefined ? { voiceLanguage: languages.voiceLanguage } : {}),
  }
}

export function isRuntimeProfileConfigured(
  profile: AuroraRuntimeProfileV2 | null | undefined,
): boolean {
  if (!profile) return false
  if (profile.nodeMode === 'remote-console') {
    return isHomeConnectionConfigured(profile.homeConnection)
  }
  if (!profile.localNode.meshMembership) return false
  return profile.homeConnection === undefined || isHomeConnectionConfigured(profile.homeConnection)
}

export function migrateThinProfileToRuntimeProfile(profile: ThinConnectionProfileV1): AuroraRuntimeProfileV2 {
  const sanitized = sanitizeThinConnectionProfileV1(profile)
  const homeConnection: AuroraHomeConnectionProfile = {
    mode: sanitized.mode,
    ...(sanitized.gatewayUrl ? { gatewayUrl: sanitized.gatewayUrl } : {}),
    ...(sanitized.signalingUrl ? { signalingUrl: sanitized.signalingUrl } : {}),
    ...(sanitized.webrtcProfile ? { webrtcProfile: sanitized.webrtcProfile } : {}),
  }
  const homePeerId = sanitized.webrtcProfile?.expectedStablePeerId
  if (homePeerId) homeConnection.homePeerId = homePeerId
  return sanitizeRuntimeProfile({
    version: 2,
    id: sanitized.id,
    label: sanitized.label,
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    homeConnection,
    localNode: {
      nodeName: sanitized.nodeName,
      stablePeerId: sanitized.localStablePeerId,
      enabledCapabilityPacks: [],
    },
  })
}

export function migrateThinProfileDocumentToRuntime(
  document: ThinProfileDocumentV1,
): AuroraRuntimeProfileDocumentV2 {
  return sanitizeRuntimeProfileDocument({
    version: 2,
    activeProfileId: document.activeProfileId,
    profiles: document.profiles.map(migrateThinProfileToRuntimeProfile),
  })
}

export function runtimeProfileToThinConnectionProfile(
  profile: AuroraRuntimeProfileV2,
): ThinConnectionProfileV1 {
  const sanitized = sanitizeRuntimeProfile(profile)
  const home = sanitized.homeConnection
  return sanitizeThinConnectionProfileV1({
    id: sanitized.id,
    label: sanitized.label,
    mode: home?.mode ?? 'http-only',
    gatewayUrl: home?.gatewayUrl ?? '',
    signalingUrl: home?.signalingUrl ?? '',
    nodeName: sanitized.localNode.nodeName,
    localStablePeerId: sanitized.localNode.stablePeerId,
    ...(home?.webrtcProfile ? { webrtcProfile: home.webrtcProfile } : {}),
  })
}

export function runtimeProfileDocumentToThinDocument(
  document: AuroraRuntimeProfileDocumentV2,
): ThinProfileDocumentV1 {
  const sanitized = sanitizeRuntimeProfileDocument(document)
  return {
    version: 1,
    activeProfileId: sanitized.activeProfileId,
    profiles: sanitized.profiles.map(runtimeProfileToThinConnectionProfile),
  }
}

export function sanitizeRuntimeProfileDocument(
  document: AuroraRuntimeProfileDocumentV2,
  options: RuntimeProfileValidationOptions = {},
): AuroraRuntimeProfileDocumentV2 {
  if (!isRecord(document) || document.version !== 2 || !Array.isArray(document.profiles)) {
    throw new Error('Runtime profile document is invalid')
  }
  if (document.profiles.length > MAX_RUNTIME_PROFILE_COUNT) {
    throw new Error('Runtime profile document has too many profiles')
  }
  const profiles = document.profiles.map((profile) => sanitizeRuntimeProfile(profile, options))
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error('Runtime profile IDs must be unique')
    ids.add(profile.id)
  }
  const activeProfileId = document.activeProfileId
  if (activeProfileId !== null && (typeof activeProfileId !== 'string' || !profiles.some((profile) => profile.id === activeProfileId))) {
    throw new Error('Runtime profile active profile must exist')
  }
  const sanitized = { version: 2 as const, activeProfileId, profiles }
  if (utf8ByteLength(JSON.stringify(sanitized)) > MAX_RUNTIME_PROFILE_DOCUMENT_BYTES) {
    throw new Error('Runtime profile document is too large')
  }
  return sanitized
}

export function sanitizeRuntimeProfile(
  profile: AuroraRuntimeProfileV2,
  options: RuntimeProfileValidationOptions = {},
): AuroraRuntimeProfileV2 {
  if (!isRecord(profile) || profile.version !== 2) throw new Error('Runtime profile is invalid')
  rejectSecretFields(profile, [])
  const id = requiredText(profile.id, 'profile id', 96)
  const label = requiredText(profile.label, 'profile label', 120)
  const nodeMode = profile.nodeMode
  if (nodeMode !== 'remote-console' && nodeMode !== 'mesh-node') {
    throw new Error('Runtime profile node mode is invalid')
  }
  const runtimeTier = profile.runtimeTier
  if (runtimeTier !== 'none' && runtimeTier !== 'lightweight-ts' && runtimeTier !== 'python-full') {
    throw new Error('Runtime profile tier is invalid')
  }
  if (nodeMode === 'remote-console' && runtimeTier !== 'none') {
    throw new Error('Remote console profiles cannot run a local runtime tier')
  }
  if (nodeMode === 'mesh-node' && runtimeTier === 'none') {
    throw new Error('Mesh node profiles require a local runtime tier')
  }
  if (runtimeTier === 'python-full' && options.allowPythonFull !== true) {
    throw new Error('Python full runtime requires a package with bundled Python support')
  }
  const homeConnection = profile.homeConnection === undefined
    ? undefined
    : sanitizeHomeConnection(profile.homeConnection)
  if (nodeMode === 'remote-console' && !homeConnection) {
    throw new Error('Remote console profiles require a home connection')
  }
  const localNode = sanitizeLocalNode(profile.localNode, nodeMode)
  return {
    version: 2,
    id,
    label,
    nodeMode,
    runtimeTier,
    ...(homeConnection ? { homeConnection } : {}),
    localNode,
  }
}

export function serializeRuntimeProfileDocument(
  document: AuroraRuntimeProfileDocumentV2,
  options: RuntimeProfileValidationOptions = {},
): string {
  return JSON.stringify(sanitizeRuntimeProfileDocument(document, options))
}

export function parseRuntimeProfileDocument(
  value: string | null | undefined,
  options: RuntimeProfileValidationOptions = {},
): AuroraRuntimeProfileDocumentV2 | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as ProfileDocumentWire
    if (!isRecord(parsed)) return null
    if (parsed.version === 1) return migrateThinProfileDocumentToRuntime(parsed)
    if (parsed.version === 2) return sanitizeRuntimeProfileDocument(parsed, options)
    return null
  } catch {
    return null
  }
}

export function parseRuntimeProfileDocumentWire(
  value: string | null | undefined,
  options: RuntimeProfileValidationOptions = {},
): { document: AuroraRuntimeProfileDocumentV2; migratedFromVersion: 1 | 2 } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as ProfileDocumentWire
    if (!isRecord(parsed)) return null
    if (parsed.version === 1) {
      return { document: migrateThinProfileDocumentToRuntime(parsed), migratedFromVersion: 1 }
    }
    if (parsed.version === 2) {
      return { document: sanitizeRuntimeProfileDocument(parsed, options), migratedFromVersion: 2 }
    }
    return null
  } catch {
    return null
  }
}

function sanitizeHomeConnection(value: AuroraHomeConnectionProfile): AuroraHomeConnectionProfile {
  if (!isRecord(value)) throw new Error('Runtime profile home connection is invalid')
  const mode = value.mode
  if (mode !== 'http-only' && mode !== 'webrtc-only' && mode !== 'webrtc-preferred') {
    throw new Error('Runtime profile connection mode is invalid')
  }
  const gatewayUrl = optionalRuntimeEndpoint(value.gatewayUrl, 'Aurora address', new Set(['http:', 'https:']))
  const signalingUrl = optionalRuntimeEndpoint(value.signalingUrl, 'signaling address', new Set(['ws:', 'wss:']))
  const webrtcProfile = value.webrtcProfile
    ? sanitizeWebRtcProfile(value.webrtcProfile, signalingUrl, mode)
    : undefined
  if (mode !== 'webrtc-only' && !gatewayUrl) {
    throw new Error(`${mode} requires an HTTP or HTTPS Aurora address`)
  }
  if (mode !== 'http-only' && !webrtcProfile) {
    throw new Error(`${mode} requires an Aurora WebRTC invite`)
  }
  const homePeerId = optionalText(value.homePeerId, 'home peer id', 256)
  return {
    mode,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...((signalingUrl || webrtcProfile?.signalingBrokers[0])
      ? { signalingUrl: signalingUrl || webrtcProfile?.signalingBrokers[0] }
      : {}),
    ...(homePeerId ? { homePeerId } : {}),
    ...(webrtcProfile ? { webrtcProfile } : {}),
  }
}

function sanitizeLocalNode(value: AuroraLocalNodeProfile, nodeMode: AuroraNodeMode): AuroraLocalNodeProfile {
  if (!isRecord(value)) throw new Error('Runtime profile local node is invalid')
  const nodeName = requiredText(value.nodeName, 'node name', 160)
  const stablePeerId = requiredText(value.stablePeerId, 'stable peer id', 160)
  const enabledCapabilityPacks = sanitizeCapabilityPacks(value.enabledCapabilityPacks)
  const primaryLanguage = sanitizeStoredSpeechLanguage(value.primaryLanguage, 'primary language', false)
  const voiceLanguage = sanitizeStoredSpeechLanguage(value.voiceLanguage, 'voice language', true)
  const localSpeechPackState = sanitizeLocalSpeechPackState(value.localSpeechPackState)
  const localSpeechSelection = sanitizeLocalSpeechSelection(value.localSpeechSelection)
  const desktopOverlay = sanitizeStoredDesktopOverlay(value.desktopOverlay)
  const meshMembership = value.meshMembership === undefined
    ? undefined
    : sanitizeMeshMembership(value.meshMembership)
  if (nodeMode === 'remote-console' && enabledCapabilityPacks.length !== 0) {
    throw new Error('Remote console profiles cannot enable local capability packs')
  }
  if (nodeMode === 'mesh-node' && !meshMembership) {
    throw new Error('Mesh node profiles require WebRTC mesh membership')
  }
  return {
    nodeName,
    stablePeerId,
    enabledCapabilityPacks,
    ...(primaryLanguage ? { primaryLanguage } : {}),
    ...(voiceLanguage ? { voiceLanguage } : {}),
    ...(localSpeechPackState ? { localSpeechPackState } : {}),
    ...(localSpeechSelection ? { localSpeechSelection } : {}),
    ...(desktopOverlay ? { desktopOverlay } : {}),
    ...(meshMembership ? { meshMembership } : {}),
  }
}

function sanitizeMeshMembership(value: AuroraMeshMembershipProfile): AuroraMeshMembershipProfile {
  if (!isRecord(value)) throw new Error('Runtime profile mesh membership is invalid')
  const signalingUrl = optionalRuntimeEndpoint(value.signalingUrl, 'mesh membership address', new Set(['ws:', 'wss:']))
  if (!signalingUrl) throw new Error('Mesh membership requires a signaling address')
  return {
    signalingUrl,
    webrtcProfile: sanitizeWebRtcProfile(value.webrtcProfile, signalingUrl, 'webrtc-only'),
  }
}

function sanitizeCapabilityPacks(value: unknown): AuroraCapabilityPack[] {
  if (!Array.isArray(value)) throw new Error('Runtime profile capability packs are invalid')
  const seen = new Set<AuroraCapabilityPack>()
  for (const item of value) {
    if (!isCapabilityPack(item)) throw new Error('Runtime profile capability pack is invalid')
    seen.add(item)
  }
  return CAPABILITY_PACK_ORDER.filter((pack) => seen.has(pack))
}

function isCapabilityPack(value: unknown): value is AuroraCapabilityPack {
  return value === 'local-tools'
    || value === 'native-actions'
    || value === 'local-conversations'
    || value === 'lightweight-memory'
    || value === 'lightweight-orchestrator'
    || value === 'foreground-voice'
    || value === 'local-inference'
}

function sanitizeLocalSpeechPackState(value: unknown): AuroraLocalSpeechPackState | undefined {
  if (value === undefined) return undefined
  if (
    value === 'disabled'
    || value === 'downloading'
    || value === 'incompatible'
    || value === 'over-budget'
    || value === 'ready'
    || value === 'unavailable'
  ) return value
  throw new Error('Runtime profile local speech state is invalid')
}

function sanitizeLocalSpeechSelection(value: unknown): AuroraLocalSpeechSelectionProfile | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Runtime profile local speech selection is invalid')
  const out: AuroraLocalSpeechSelectionProfile = {}
  for (const [task, selection] of Object.entries(value)) {
    if (task === 'wakePhrase') {
      out.wakePhrase = sanitizeLocalWakePhraseSelection(selection)
      continue
    }
    if (!isLocalSpeechTask(task)) throw new Error('Runtime profile local speech selection task is invalid')
    out[task] = sanitizeLocalSpeechAssetSelection(selection, task)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeLocalWakePhraseSelection(value: unknown): AuroraLocalWakePhraseSelection {
  if (!isRecord(value)) throw new Error('Runtime profile local wake phrase selection is invalid')
  const allowed = new Set(['phraseId', 'phrase', 'language', 'revision'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('Runtime profile local wake phrase selection field is invalid')
  }
  return {
    phraseId: requiredCatalogText(value.phraseId, 'local wake phrase id', 128),
    phrase: requiredPhraseText(value.phrase, 'local wake phrase text', 64),
    language: requiredLocaleText(value.language, 'local wake phrase language'),
    revision: requiredCatalogText(value.revision, 'local wake phrase revision', 128),
  }
}

function sanitizeLocalSpeechAssetSelection(
  value: unknown,
  task: AuroraLocalSpeechTask,
): AuroraLocalSpeechAssetSelection {
  if (!isRecord(value)) throw new Error('Runtime profile local speech asset selection is invalid')
  const allowed = new Set(['packId', 'packRevision', 'voiceId', 'voiceRevision', 'referenceProfileId'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('Runtime profile local speech asset selection field is invalid')
  }
  const packId = requiredCatalogText(value.packId, 'local speech pack id', 256)
  const packRevision = requiredCatalogText(value.packRevision, 'local speech pack revision', 256)
  const voiceId = optionalCatalogText(value.voiceId, 'local speech voice id', 256)
  const voiceRevision = optionalCatalogText(value.voiceRevision, 'local speech voice revision', 256)
  const referenceProfileId = optionalCatalogText(value.referenceProfileId, 'local speech reference profile id', 256)
  if ((voiceId === undefined) !== (voiceRevision === undefined)) {
    throw new Error('Runtime profile local speech voice selection is incomplete')
  }
  if (task === 'tts' && (!voiceId || !voiceRevision)) {
    throw new Error('Runtime profile local speech TTS selection requires a voice')
  }
  return {
    packId,
    packRevision,
    ...(voiceId ? { voiceId } : {}),
    ...(voiceRevision ? { voiceRevision } : {}),
    ...(referenceProfileId ? { referenceProfileId } : {}),
  }
}

function isLocalSpeechTask(value: string): value is AuroraLocalSpeechTask {
  return value === 'kws' || value === 'stt' || value === 'tts' || value === 'vad'
}

function isHomeConnectionConfigured(value: AuroraHomeConnectionProfile | undefined): boolean {
  if (!value) return false
  if (value.mode !== 'webrtc-only' && !value.gatewayUrl) return false
  if (value.mode !== 'http-only' && !value.webrtcProfile) return false
  return true
}

function sanitizeThinConnectionProfileV1(profile: ThinConnectionProfileV1): ThinConnectionProfileV1 {
  if (!isRecord(profile)) throw new Error('Thin-client connection profile is invalid')
  rejectSecretFields(profile, [])
  const home = sanitizeHomeConnection({
    mode: profile.mode,
    gatewayUrl: profile.gatewayUrl,
    signalingUrl: profile.signalingUrl,
    ...(profile.webrtcProfile ? { webrtcProfile: profile.webrtcProfile } : {}),
  })
  return {
    id: requiredText(profile.id, 'profile id', 96),
    label: requiredText(profile.label, 'profile label', 120),
    mode: home.mode,
    gatewayUrl: home.gatewayUrl ?? '',
    signalingUrl: home.signalingUrl ?? '',
    nodeName: requiredText(profile.nodeName, 'node name', 160),
    localStablePeerId: requiredText(profile.localStablePeerId, 'stable peer id', 160),
    ...(home.webrtcProfile ? { webrtcProfile: home.webrtcProfile } : {}),
  }
}

function sanitizeWebRtcProfile(
  value: WebRtcPeerConnectionProfile,
  signalingOverride: string,
  mode: AuroraConnectionMode,
): WebRtcPeerConnectionProfile {
  if (!isRecord(value)) throw new Error('Runtime profile WebRTC invite is invalid')
  const appId = requiredText(value.appId, 'WebRTC app id', 256)
  const room = requiredText(value.room, 'WebRTC room', 512)
  const roomSecretRef = requiredText(value.roomSecretRef, 'WebRTC room-secret reference', 1024)
  const configuredBrokers = signalingOverride
    ? [signalingOverride]
    : Array.isArray(value.signalingBrokers)
      ? [...value.signalingBrokers]
      : []
  if (configuredBrokers.length === 0 || configuredBrokers.length > 16) {
    throw new Error('Runtime profile WebRTC signaling broker list is invalid')
  }
  const signalingBrokers = configuredBrokers.map((broker) =>
    optionalRuntimeEndpoint(broker, 'signaling broker', new Set(['ws:', 'wss:'])),
  )
  const out: WebRtcPeerConnectionProfile = {
    mode: mode === 'webrtc-only' ? 'webrtc-only' : 'webrtc-preferred',
    appId,
    room,
    roomSecretRef,
    signalingBrokers,
  }
  copyOptionalText(value.expectedStablePeerId, out, 'expectedStablePeerId', 256)
  copyOptionalText(value.expectedSignalingPeerId, out, 'expectedSignalingPeerId', 256)
  copyOptionalText(value.nodeName, out, 'nodeName', 160)
  copyOptionalBoolean(value.production, out, 'production')
  copyOptionalBoolean(value.allowInsecureLoopbackSignaling, out, 'allowInsecureLoopbackSignaling')
  copyOptionalBoolean(value.requireAppLayerE2ee, out, 'requireAppLayerE2ee')
  const stunServers = sanitizeIceServers(value.stunServers, new Set(['stun:', 'stuns:']))
  const turnServers = sanitizeIceServers(value.turnServers, new Set(['turn:', 'turns:']))
  if (stunServers) out.stunServers = stunServers
  if (turnServers) out.turnServers = turnServers
  return out
}

function optionalRuntimeEndpoint(
  value: unknown,
  label: string,
  protocols: Set<string>,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (!protocols.has(url.protocol) || url.username || url.password) {
    throw new Error(
      `${label} must use ${[...protocols].join('/')} without embedded credentials`,
    )
  }
  if (url.hash) throw new Error(`${label} must not contain URL fragments`)
  for (const key of url.searchParams.keys()) {
    if (isSecretFieldName(key)) {
      throw new Error(`${label} must not store credentials in URL query parameters`)
    }
  }
  return url.toString().replace(/\/$/, '')
}

function sanitizeIceServers(
  values: readonly string[] | undefined,
  protocols: Set<string>,
): string[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values) || values.length > 16) throw new Error('Runtime profile ICE server list is invalid')
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('Runtime profile ICE server URL is invalid')
    const trimmed = value.trim()
    const protocol = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
    if (!protocols.has(protocol) || trimmed.length > 2048 || trimmed !== value) {
      throw new Error('Runtime profile ICE server URL is invalid')
    }
    validateIceServerUrl(trimmed, protocol)
    return trimmed
  })
}

function validateIceServerUrl(value: string, protocol: string): void {
  const rest = value.slice(protocol.length)
  const queryIndex = rest.indexOf('?')
  const authority = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : ''
  if (authority.includes('@')) {
    throw new Error('Runtime profile ICE server URL must not contain embedded credentials')
  }
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (isSecretFieldName(key)) {
      throw new Error('Runtime profile ICE server URL must not store credentials in query parameters')
    }
  }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || utf8ByteLength(trimmed) > maxLength) throw new Error(`Runtime profile ${label} is required`)
  return trimmed
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, label, maxLength)
}

function requiredCatalogText(value: unknown, label: string, maxLength: number): string {
  const text = requiredText(value, label, maxLength)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:+/@-]*$/u.test(text)) {
    throw new Error(`Runtime profile ${label} is invalid`)
  }
  return text
}

function optionalCatalogText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requiredCatalogText(value, label, maxLength)
}

function requiredLocaleText(value: unknown, label: string): string {
  const text = requiredText(value, label, 32)
  if (!/^(?:[a-zA-Z]{2,3}|und)(?:-[a-zA-Z0-9]{2,8}){0,6}$/u.test(text)) {
    throw new Error(`Runtime profile ${label} is invalid`)
  }
  return text
}

function sanitizeStoredSpeechLanguage(
  value: unknown,
  label: string,
  allowAuto: boolean,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = normalizeOptionalSpeechLanguage(value, allowAuto)
  if (!normalized) throw new Error(`Runtime profile ${label} is invalid`)
  return normalized
}

function normalizeOptionalSpeechLanguage(value: unknown, allowAuto: boolean): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replaceAll('_', '-')
  if (!normalized) return undefined
  if (normalized === AUTO_LOCAL_VOICE_LANGUAGE) {
    return allowAuto ? AUTO_LOCAL_VOICE_LANGUAGE : undefined
  }
  if (normalized.length < 2 || normalized.length > 255) return undefined
  if (!SPEECH_LANGUAGE_TAG_RE.test(normalized)) return undefined
  return normalized
}

function sanitizeStoredDesktopOverlay(value: unknown): AuroraDesktopOverlayPreferences | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Runtime profile overlay settings are invalid')
  const allowed = new Set(['enabled', 'voiceEnabled', 'textHotkey', 'autoCloseDelayMs'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('Runtime profile overlay settings field is invalid')
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('Runtime profile overlay settings are invalid')
  }
  if (value.voiceEnabled !== undefined && typeof value.voiceEnabled !== 'boolean') {
    throw new Error('Runtime profile overlay settings are invalid')
  }
  const textHotkey = value.textHotkey === undefined
    ? undefined
    : normalizeDesktopOverlayHotkey(value.textHotkey)
  if (value.textHotkey !== undefined && !textHotkey) {
    throw new Error('Runtime profile overlay shortcut is invalid')
  }
  const autoCloseDelayMs = value.autoCloseDelayMs === undefined
    ? undefined
    : normalizeDesktopOverlayDelayMs(value.autoCloseDelayMs)
  if (value.autoCloseDelayMs !== undefined && autoCloseDelayMs === undefined) {
    throw new Error('Runtime profile overlay hide delay is invalid')
  }
  return resolveDesktopOverlayPreferences({
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.voiceEnabled === 'boolean' ? { voiceEnabled: value.voiceEnabled } : {}),
    ...(textHotkey ? { textHotkey } : {}),
    ...(autoCloseDelayMs !== undefined ? { autoCloseDelayMs } : {}),
  })
}

export function normalizeDesktopOverlayHotkey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().replace(/\s+/gu, '')
  if (!compact || compact.length > 64) return undefined
  const parts = compact.split('+').filter((part) => part.length > 0)
  if (parts.length < 2) return undefined
  const key = parts.at(-1)
  const modifiers = parts.slice(0, -1).map((part) => {
    const token = part.toLowerCase()
    if (token === 'commandorcontrol' || token === 'cmdorctrl' || token === 'ctrl' || token === 'control') {
      return 'CommandOrControl'
    }
    if (token === 'command' || token === 'cmd' || token === 'meta' || token === 'super') {
      return 'Command'
    }
    if (token === 'alt' || token === 'option') return 'Alt'
    if (token === 'shift') return 'Shift'
    return null
  })
  if (!key || !/^[A-Za-z0-9]$/u.test(key) || modifiers.some((part) => part === null)) return undefined
  const uniqueModifiers = [...new Set(modifiers.filter((part): part is string => part !== null))]
  return `${uniqueModifiers.join('+')}+${key.toUpperCase()}`
}

function normalizeDesktopOverlayDelayMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60_000) return undefined
  return Math.round(value)
}

function requiredPhraseText(value: unknown, label: string, maxLength: number): string {
  const text = requiredText(value, label, maxLength)
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N}' -]*$/u.test(text)
    || /(?:https?:|wss?:|token|secret|password|key=)/iu.test(text)
  ) {
    throw new Error(`Runtime profile ${label} is invalid`)
  }
  return text
}

function copyOptionalText(
  value: string | undefined,
  target: WebRtcPeerConnectionProfile,
  key: 'expectedStablePeerId' | 'expectedSignalingPeerId' | 'nodeName',
  maxLength: number,
): void {
  if (value === undefined) return
  target[key] = requiredText(value, key, maxLength)
}

function copyOptionalBoolean(
  value: boolean | undefined,
  target: WebRtcPeerConnectionProfile,
  key: 'production' | 'allowInsecureLoopbackSignaling' | 'requireAppLayerE2ee',
): void {
  if (value !== undefined) {
    if (typeof value !== 'boolean') throw new Error(`Runtime profile ${key} is invalid`)
    target[key] = value
  }
}

function rejectSecretFields(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, [...path, String(index)]))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key) && !isAllowedSecretReferenceField(key)) {
      throw new Error(`Runtime profile must not contain secret field ${[...path, key].join('.')}`)
    }
    rejectSecretFields(child, [...path, key])
  }
}

function isSecretFieldName(value: string): boolean {
  return /(?:token|secret|password|credential|authorization|bearer)/iu.test(value)
}

function isAllowedSecretReferenceField(value: string): boolean {
  return value === 'roomSecretRef'
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
