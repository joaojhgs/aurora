'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { routePath, type AuroraClient } from '@aurora/client'
import { safeErrorCopy } from './product-copy'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { AuroraRuntimeProfileV2, AuroraLocalSpeechPreferencesSave, AuroraLocalSpeechTask } from './runtime-profile'
import { mergeCatalogProfiles } from './voice-settings-managed-voice-model'
import { AURORA_QUERY_STALE_TIMES, useAuroraQueryScopeKey } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys, type createAuroraQueryKeys } from './query-hooks'
import type {
  AuroraBrowserPocketReferenceProfileSummary,
  AuroraBrowserSpeechPackCatalogSelection,
  AuroraLocalSpeechCatalogPort,
} from './browser-speech-pack'

export type SpeechLanguage = string
export type TtsModelStatus = 'degraded' | 'error' | 'loading' | 'ready' | 'unavailable'
export type TtsVoiceKind = 'cloned' | 'standard'
export type TtsLanguagePackCatalogStatus = 'available' | 'unavailable'
export type TtsLanguagePackCatalogErrorCode = 'catalog_unavailable'
export type LocalSpeechCatalogTask = Exclude<AuroraLocalSpeechTask, 'tts'>

export interface TtsResidentLanguagePack {
  pack_id: string
  ready_languages?: SpeechLanguage[] | undefined
}

export interface TtsCapabilities {
  ready?: boolean | undefined
  model_status?: TtsModelStatus | undefined
  ready_languages?: SpeechLanguage[] | undefined
  supported_language_pack_ids?: string[] | undefined
  installed_language_pack_ids?: string[] | undefined
  active_language_pack_id?: string | null | undefined
  default_language_pack_id?: string | null | undefined
  language_packs?: TtsLanguagePack[] | undefined
  resident_language_packs?: TtsResidentLanguagePack[] | undefined
  engine_capabilities?: {
    vad?: boolean | undefined
    kws?: boolean | undefined
    stt?: boolean | undefined
    tts?: boolean | undefined
  } | undefined
  cloning?: boolean | undefined
  local_speech_assets?: Partial<Record<LocalSpeechCatalogTask | 'wakeword' | 'wkw', LocalSpeechCatalogAsset[]>> | undefined
  local_speech_packs?: LocalSpeechCatalogAsset[] | undefined
}

export interface LocalSpeechCatalogAsset {
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

export interface TtsVoice {
  voice_id: string
  display_name: string
  ready?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

export interface TtsVoiceProfile {
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

export interface TtsLanguagePack {
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

interface TtsListLanguagePacksSuccess {
  packs?: TtsLanguagePack[] | undefined
  catalog_status?: TtsLanguagePackCatalogStatus | undefined
  catalog_error_code?: TtsLanguagePackCatalogErrorCode | null | undefined
}

export interface TtsLanguagePackVoice {
  voice_id: string
  display_name: string
  revision: string
  installed?: boolean | undefined
  ready?: boolean | undefined
  active?: boolean | undefined
  default?: boolean | undefined
}

export interface VoiceSettingsState {
  capabilities: TtsCapabilities | null
  voices: TtsVoice[]
  profiles: TtsVoiceProfile[]
  packs: TtsLanguagePack[]
  loadState: 'loading' | 'ready' | 'error'
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  languageCatalogState: 'locked' | 'loading' | 'ready' | 'limited'
  browserCatalogState: 'locked' | 'loading' | 'ready' | 'limited'
  message: string | null
}

export const initialVoiceSettingsState: VoiceSettingsState = {
  capabilities: null,
  voices: [],
  profiles: [],
  packs: [],
  loadState: 'loading',
  managementState: 'locked',
  languageCatalogState: 'locked',
  browserCatalogState: 'locked',
  message: null
}

export const TTS_MANAGE_METHODS = {
  install: 'TTS.InstallVoiceProfile',
  listLanguagePacks: 'TTS.ListLanguagePacks',
  listProfiles: 'TTS.ListVoiceProfiles',
  remove: 'TTS.RemoveVoiceProfile',
  setDefault: 'TTS.SetDefaultVoice',
  delete: 'TTS.DeleteVoiceProfile'
} as const

export interface UseSpeechCatalogOptions {
  client: AuroraClient
  runtimeProfile: AuroraRuntimeProfileV2 | null
  surfaceProfile: AuroraSurfaceProfile | null
  localSpeechCatalog: AuroraLocalSpeechCatalogPort | null
  onLocalSpeechSelectionConfirmed?: AuroraLocalSpeechPreferencesSave | undefined
  adminActionReady: boolean
  adminReasonValue: string
  adminReviewConfirmed: boolean
}

export interface SpeechCatalogState {
  state: VoiceSettingsState
  surfaceProfile: AuroraSurfaceProfile
  canManageLocalSpeechAssets: boolean
  browserCatalogItems: readonly AuroraBrowserSpeechPackCatalogSelection[]
  referenceProfiles: readonly AuroraBrowserPocketReferenceProfileSummary[]
  setReferenceProfiles: Dispatch<SetStateAction<readonly AuroraBrowserPocketReferenceProfileSummary[]>>
  refreshNow: () => Promise<void>
  loadManagedProfiles: (reason?: string) => Promise<void>
  invalidateVoiceServerData: (reason?: string) => Promise<void>
}

export function useSpeechCatalog({
  client,
  runtimeProfile,
  surfaceProfile: providedSurfaceProfile,
  localSpeechCatalog,
  onLocalSpeechSelectionConfirmed,
  adminActionReady,
  adminReasonValue,
  adminReviewConfirmed,
}: UseSpeechCatalogOptions): SpeechCatalogState {
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const localSpeechScopeKey = JSON.stringify(useAuroraQueryScopeKey())
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const voiceDiscoveryQueryKey = useMemo(() => queryKeys.admin('voice-discovery'), [queryKeys])
  const managedRequestSequence = useRef(0)
  const [managedRequest, setManagedRequest] = useState<VoiceManagedCatalogRequest | null>(null)
  const [browserCatalogState, setBrowserCatalogState] = useState<VoiceSettingsState['browserCatalogState']>('locked')
  const [browserCatalogItems, setBrowserCatalogItems] = useState<readonly AuroraBrowserSpeechPackCatalogSelection[]>([])
  const [referenceProfiles, setReferenceProfiles] = useState<readonly AuroraBrowserPocketReferenceProfileSummary[]>([])
  const voiceDiscoveryQuery = useQuery({
    queryKey: voiceDiscoveryQueryKey,
    queryFn: ({ signal }) => fetchVoiceDiscovery(client, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.capabilities,
    refetchInterval: fallbackInterval,
  })
  const discoveryState = voiceDiscoveryQuery.data ?? voiceDiscoveryPendingState(voiceDiscoveryQuery.error)
  const transportKind = client.transport?.kind ?? 'http'
  const surfaceProfile = useMemo(() => voiceSettingsSurfaceProfile({
    surfaceProfile: providedSurfaceProfile,
    transportKind,
    runtimeProfile,
    engineCapabilities: discoveryState.capabilities?.engine_capabilities,
  }), [providedSurfaceProfile, transportKind, runtimeProfile, discoveryState.capabilities?.engine_capabilities])
  const canManageLocalSpeechAssets = useMemo(() => (
    Boolean(onLocalSpeechSelectionConfirmed)
    && localSpeechSurfaceCanManageAssets(surfaceProfile)
  ), [onLocalSpeechSelectionConfirmed, surfaceProfile])
  const managedCatalogQueryKey = useMemo(
    () => voiceManagedCatalogQueryKey(queryKeys, managedRequest, adminActionReady),
    [adminActionReady, managedRequest, queryKeys],
  )
  const managedCatalogQuery = useQuery({
    queryKey: managedCatalogQueryKey,
    enabled: adminActionReady && managedRequest !== null,
    queryFn: ({ signal }) => managedRequest
      ? fetchManagedVoiceCatalog(client, managedRequest.reason, adminReasonValue, adminReviewConfirmed, signal)
      : voiceManagedCatalogLockedState(),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
  })
  const managedState = adminActionReady && managedRequest !== null
    ? managedCatalogQuery.data ?? voiceManagedCatalogLoadingState()
    : voiceManagedCatalogLockedState()
  const state = useMemo<VoiceSettingsState>(() => ({
    capabilities: discoveryState.capabilities,
    voices: discoveryState.voices,
    profiles: managedState.profiles,
    packs: managedState.packs,
    loadState: discoveryState.loadState,
    managementState: managedState.managementState,
    languageCatalogState: managedState.languageCatalogState,
    browserCatalogState,
    message: managedState.message ?? discoveryState.message,
  }), [browserCatalogState, discoveryState, managedState])

  const loadManagedProfiles = useCallback(async (reason = 'Load available voice settings') => {
    if (!adminActionReady) return
    const request = { sequence: managedRequestSequence.current + 1, reason }
    managedRequestSequence.current = request.sequence
    setManagedRequest(request)
  }, [adminActionReady])

  const refreshNow = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: voiceDiscoveryQueryKey })
    await queryClient.refetchQueries({ queryKey: voiceDiscoveryQueryKey, type: 'active' })
  }, [queryClient, voiceDiscoveryQueryKey])

  const invalidateVoiceServerData = useCallback(async (reason = 'Refresh available voice settings'): Promise<void> => {
    await refreshNow()
    await queryClient.invalidateQueries({ queryKey: voiceManagedCatalogFamilyKey(queryKeys), refetchType: 'none' })
    if (adminActionReady && managedRequest !== null) {
      await loadManagedProfiles(reason)
    }
  }, [adminActionReady, loadManagedProfiles, managedRequest, queryClient, queryKeys, refreshNow])

  useEffect(() => {
    if (!localSpeechCatalog?.available || !canManageLocalSpeechAssets) {
      setBrowserCatalogItems([])
      setReferenceProfiles([])
      setBrowserCatalogState('locked')
      return
    }
    let active = true
    setBrowserCatalogState('loading')
    void Promise.all([
      localSpeechCatalog.listCatalog(),
      localSpeechCatalog.listReferenceProfiles?.() ?? Promise.resolve(Object.freeze([])),
    ]).then(([result, profiles]) => {
      if (!active) return
      if (result.state !== 'ready') {
        setBrowserCatalogItems([])
        setReferenceProfiles([])
        setBrowserCatalogState('limited')
        return
      }
      setBrowserCatalogItems(result.items)
      setReferenceProfiles(profiles)
      setBrowserCatalogState('ready')
    }, () => {
      if (!active) return
      setBrowserCatalogItems([])
      setReferenceProfiles([])
      setBrowserCatalogState('limited')
    })
    return () => {
      active = false
    }
  }, [localSpeechCatalog, canManageLocalSpeechAssets, localSpeechScopeKey])

  return {
    state,
    surfaceProfile,
    canManageLocalSpeechAssets,
    browserCatalogItems,
    referenceProfiles,
    setReferenceProfiles,
    refreshNow,
    loadManagedProfiles,
    invalidateVoiceServerData,
  }
}


interface VoiceManagedCatalogRequest {
  sequence: number
  reason: string
}

type AuroraQueryKeys = ReturnType<typeof createAuroraQueryKeys>

async function fetchVoiceDiscovery(client: AuroraClient, signal?: AbortSignal): Promise<Pick<VoiceSettingsState, 'capabilities' | 'voices' | 'loadState' | 'message'>> {
  throwVoiceQueryAbortIfRequested(signal)
  const [capabilitiesResult, voicesResult] = await Promise.all([
    client.speech.tts.getCapabilities({}, signal ? { signal } : {}),
    client.speech.tts.listVoices({}, signal ? { signal } : {})
  ])
  throwVoiceQueryAbortIfRequested(signal)
  const capabilities = capabilitiesResult.ok ? capabilitiesResult.data.capabilities as TtsCapabilities : null
  const voices = voicesResult.ok ? (voicesResult.data.voices as TtsVoice[] | undefined) ?? [] : []
  const readError = !capabilitiesResult.ok || !voicesResult.ok
  const readProblem = capabilitiesResult.ok
    ? voicesResult.ok ? null : voicesResult.error
    : capabilitiesResult.error
  return {
    capabilities,
    voices,
    loadState: readError ? 'error' : 'ready',
    message: readError ? productVoiceSettingsErrorCopy(readProblem) : null
  }
}

function voiceDiscoveryPendingState(error: unknown): Pick<VoiceSettingsState, 'capabilities' | 'voices' | 'loadState' | 'message'> {
  if (error) {
    return {
      capabilities: null,
      voices: [],
      loadState: 'error',
      message: productVoiceSettingsErrorCopy(error)
    }
  }
  return {
    capabilities: null,
    voices: [],
    loadState: 'loading',
    message: null
  }
}

function voiceManagedCatalogQueryKey(
  queryKeys: AuroraQueryKeys,
  request: VoiceManagedCatalogRequest | null,
  adminActionReady: boolean,
) {
  return queryKeys.admin('voice-managed-catalog', {
    access: adminActionReady ? 'ready' : 'locked',
    request: request ? request.sequence : 0,
  })
}

function voiceManagedCatalogFamilyKey(queryKeys: AuroraQueryKeys) {
  return [...queryKeys.root(), 'admin', 'voice-managed-catalog'] as const
}

async function fetchManagedVoiceCatalog(
  client: AuroraClient,
  reason: string,
  adminReasonValue: string,
  adminReviewConfirmed: boolean,
  signal?: AbortSignal,
): Promise<Pick<VoiceSettingsState, 'profiles' | 'packs' | 'managementState' | 'languageCatalogState' | 'message'>> {
  try {
    throwVoiceQueryAbortIfRequested(signal)
    const result = await client.admin.execute<{ profiles?: TtsVoiceProfile[] }>({
      methodId: TTS_MANAGE_METHODS.listProfiles,
      payload: { include_unavailable: true },
      reason: adminReasonFor(reason, adminReasonValue),
      reauthConfirmed: adminReviewConfirmed,
      affectedResources: ['voice-profiles'],
      path: routePath('TTS', 'ListVoiceProfiles'),
      ...(signal ? { signal } : {})
    })
    let packs: TtsLanguagePack[] = []
    let languageCatalogState: VoiceSettingsState['languageCatalogState'] = 'ready'
    let message: string | null = null
    try {
      throwVoiceQueryAbortIfRequested(signal)
      const packsResult = await client.admin.execute<TtsListLanguagePacksSuccess>({
        methodId: TTS_MANAGE_METHODS.listLanguagePacks,
        payload: { include_unavailable: true },
        reason: adminReasonFor(reason, adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: ['voice-language-downloads'],
        path: routePath('TTS', 'ListLanguagePacks'),
        ...(signal ? { signal } : {})
      })
      packs = packsResult.data.packs ?? []
      if (packsResult.data.catalog_status === 'unavailable') {
        languageCatalogState = 'limited'
        message = languageCatalogUnavailableCopy()
      }
    } catch (error) {
      if (isVoiceQueryAbort(error, signal)) throw error
      languageCatalogState = 'limited'
      message = languageCatalogUnavailableCopy()
    }
    throwVoiceQueryAbortIfRequested(signal)
    return {
      profiles: mergeCatalogProfiles(result.data.profiles ?? [], packs),
      packs,
      managementState: 'ready',
      languageCatalogState,
      message
    }
  } catch (error) {
    if (isVoiceQueryAbort(error, signal)) throw error
    return {
      profiles: [],
      packs: [],
      managementState: 'limited',
      languageCatalogState: 'limited',
      message: voiceSettingsManagementCopy(error)
    }
  }
}

function voiceManagedCatalogLoadingState(): Pick<VoiceSettingsState, 'profiles' | 'packs' | 'managementState' | 'languageCatalogState' | 'message'> {
  return {
    profiles: [],
    packs: [],
    managementState: 'loading',
    languageCatalogState: 'loading',
    message: null
  }
}

function voiceManagedCatalogLockedState(): Pick<VoiceSettingsState, 'profiles' | 'packs' | 'managementState' | 'languageCatalogState' | 'message'> {
  return {
    profiles: [],
    packs: [],
    managementState: 'locked',
    languageCatalogState: 'locked',
    message: null
  }
}

function throwVoiceQueryAbortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw voiceQueryAbortError()
}

function isVoiceQueryAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError')
}

function voiceQueryAbortError(): DOMException {
  return new DOMException('Voice settings request was cancelled', 'AbortError')
}

function voiceSettingsSurfaceProfile(input: {
  surfaceProfile: AuroraSurfaceProfile | null
  transportKind: string
  runtimeProfile: AuroraRuntimeProfileV2 | null
  engineCapabilities: TtsCapabilities['engine_capabilities'] | undefined
}): AuroraSurfaceProfile {
  if (input.surfaceProfile) return input.surfaceProfile
  const localNode = input.runtimeProfile?.nodeMode === 'mesh-node'
    ? input.runtimeProfile.localNode
    : null
  return getAuroraSurfaceProfile({
    runtimeMode: undefined,
    transportKind: input.transportKind,
    nativePlatform: undefined,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    nodeMode: input.runtimeProfile?.nodeMode,
    runtimeTier: input.runtimeProfile?.runtimeTier,
    enabledCapabilityPacks: localNode?.enabledCapabilityPacks ?? [],
    localSpeechPackState: input.runtimeProfile?.localNode.localSpeechPackState,
    localSpeechEngineCapabilities: input.engineCapabilities,
  })
}

function localSpeechSurfaceCanManageAssets(
  surfaceProfile: AuroraSurfaceProfile,
): boolean {
  return surfaceProfile.usesNativeShell || surfaceProfile.usesBrowserVoiceRuntime || surfaceProfile.supportsMobileNative || surfaceProfile.legacyKind === 'mock'
}

export function adminReasonFor(action: string, userReason: string): string {
  return `${action}: ${userReason}`
}

export function productVoiceSettingsErrorCopy(error: unknown, backup = 'Voice settings could not be loaded. Try again.'): string {
  const copy = safeErrorCopy(error)
  if (!copy.title) return backup
  if (!copy.action || copy.title.toLowerCase().includes(copy.action.toLowerCase())) return copy.title
  return `${copy.title}. ${copy.action}.`
}

function voiceSettingsManagementCopy(error: unknown): string {
  const copy = safeErrorCopy(error)
  if (copy.title.includes('Permission')) return 'Available voices need access before they can be shown.'
  if (copy.title.includes('cannot use')) return 'Available voices are not shown on this Aurora version.'
  return 'Available voices could not be loaded. Review access and try again.'
}

function languageCatalogUnavailableCopy(): string {
  return 'Language options could not be loaded. Review access and try again.'
}
