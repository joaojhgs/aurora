import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  androidNativeCapabilityManifestFixture,
  cloneFixture,
  iosNativeCapabilityManifestFixture,
  nativeCapabilityManifestFixture,
  routePath,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
  type NativeCapabilityManifest,
  type ToolingProjectionToolInfo,
} from '@aurora/client'
import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse,
} from '@aurora/client/lightweight-orchestrator'
import type {
  EnvelopeCryptoPort,
  LocalDataBackend,
  LocalDataSession,
} from '@aurora/client/local-data'
import type { LocalFeatureSharingPort } from '@aurora/client/local-tools'
import {
  BrowserPersistentPeerCredentialStore,
  activeRuntimeProfile,
  activeThinConnectionProfile,
  auroraBrowserVoiceAssetFetchUrl,
  createBrowserWebThinRuntime,
  emptyThinProfileDocument,
  emptyRuntimeProfileDocument,
  explainBrowserThinRuntime,
  createAuroraBrowserVoiceCatalogPort,
  getAuroraSurfaceProfile,
  isRuntimeProfileConfigured,
  isThinConnectionProfileConfigured,
  mergeLocalNodeSpeechPreferences,
  openActiveBrowserSpeechPacks,
  runtimeProfileDocumentToThinDocument,
  runtimeProfileToThinConnectionProfile,
  sanitizeThinConnectionProfile,
  sanitizeRuntimeProfile,
  sanitizeRuntimeProfileDocument,
  type AuroraBrowserSpeechPackCatalogResult,
  type AuroraBrowserSpeechPackCatalogSelection,
  type AuroraBrowserPocketReferenceProfileInput,
  type AuroraBrowserPocketReferenceProfileSummary,
  type AuroraBrowserSpeechPackInstallReceipt,
  type AuroraBrowserSpeechPackInstallRequest,
  type AuroraBrowserSpeechPackTask,
  type AuroraBrowserSpeechPackTrustSelection,
  type AuroraBrowserSpeechPacksRuntimeStatus,
  type AuroraLocalSpeechCatalogPort,
  type AuroraLocalSpeechLanguagePrefs,
  type AuroraLocalSpeechSelectionProfile,
  type AuroraRuntimeProfileDocumentV2,
  type AuroraRuntimeProfileV2,
  type AuroraNodeMode,
  type ThinConnectionProfile,
  type ThinProfileDocument,
  type AuroraWebRtcRolloutFlags,
  type BrowserWebThinRuntime,
} from '@aurora/ui'
import {
  BrowserEnvelopeCryptoPort,
  BrowserIndexedDbLocalDataBackend,
} from '@aurora/ui/local-data/browser'
import {
  BrowserMeshNodeCompositionError,
  browserMeshNodeCompositionStatusFromError,
  createBrowserMeshNodeServices,
  type BrowserMeshNodeServicesOptions,
  type BrowserMeshNodeCompositionStatus,
  type BrowserMeshNodeServices,
} from './browser-mesh-node-services'
import {
  applyDebugUiLaunchToRuntimeProfile,
  debugUiLaunchSanitizeOptions,
  debugUiLaunchSessionIsAdmin,
  resolveAuroraDebugUiLaunch,
  type AuroraDebugUiLaunch,
} from './debug-ui-launch'

type BrowserRuntimeCache = {
  baseKey: string
  key: string
  localAssistant: AuroraBrowserLightweightAssistantConfig | null
  runtime: AuroraBrowserRuntime
  meshNodeServices: BrowserMeshNodeServices | null
}

const ASSISTANT_COMPLETION_ROUTE = '/api/assistant/completion'
const BROWSER_SPEECH_TRUST_STORAGE_KEY = 'aurora.browserSpeechTrust.v1'

export async function fetchAuroraBrowserVoiceAssetBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const target = auroraBrowserVoiceAssetFetchUrl(url)
  const response = await fetch(target, {
    cache: 'no-store',
    redirect: 'follow',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error('voice_download_unavailable')
  return new Uint8Array(await response.arrayBuffer())
}

export interface AuroraBrowserLocalDataContext {
  readonly session: LocalDataSession
  readonly backend: LocalDataBackend
  readonly crypto: EnvelopeCryptoPort
}

export interface AuroraBrowserLocalNodeProviderStatus {
  readonly available: boolean
  readonly state:
    | 'available'
    | 'not-configured'
    | 'needs-attention'
    | 'open-in-another-tab'
  readonly productMessage: string
  readonly registeredFeatureCount: number
  readonly localDataWritable: boolean
}

export interface AuroraBrowserRuntime extends BrowserWebThinRuntime {
  readonly localData?: AuroraBrowserLocalDataContext | undefined
  readonly localFeatureSharing?: LocalFeatureSharingPort | undefined
  readonly localToolProvider?: BrowserMeshNodeServices['provider'] | undefined
  readonly localAssistant?: AuroraBrowserLightweightAssistantConfig | undefined
  readonly localNodeProviderStatus: AuroraBrowserLocalNodeProviderStatus
  readonly browserSpeechPacks: AuroraBrowserSpeechPacksRuntimeStatus
  readonly localSpeechCatalog: AuroraLocalSpeechCatalogPort
}

export interface AuroraBrowserLightweightAssistantConfig {
  readonly provider: LightweightAssistantProvider
  readonly remoteTools?: readonly ToolingProjectionToolInfo[] | undefined
}

let browserRuntimeCache: BrowserRuntimeCache | null = null
let browserCredentialStore: BrowserPersistentPeerCredentialStore | null = null
let browserRuntimeProfileRevision = 0
let browserRuntimeProfileTransition: Promise<void> | null = null
const closedBrowserMeshNodeServices = new WeakSet<BrowserMeshNodeServices>()
let browserMeshNodeCompositionInflight: {
  baseKey: string
  promise: Promise<BrowserMeshNodeServices | null>
} | null = null
let browserMeshNodeCompositionStatus: BrowserMeshNodeCompositionStatus = {
  state: 'disabled',
  reasonCode: 'not_mesh_node',
  message: 'Device sharing services disabled: not_mesh_node',
  productMessage: 'This device is not set up for sharing.',
}
let browserMeshNodeServicesFactoryForTests: BrowserMeshNodeServicesFactory | null = null
let browserVoicePackCatalogForTests: BrowserVoicePackCatalogSource | null = null

type BrowserMeshNodeServicesFactory = (
  options: BrowserMeshNodeServicesOptions,
) => Promise<BrowserMeshNodeServices>

export type BrowserVoicePackCatalogSource = {
  listCatalog(): Promise<AuroraBrowserSpeechPackCatalogResult>
  select(request: AuroraBrowserSpeechPackInstallRequest): Promise<AuroraBrowserSpeechPackInstallReceipt>
  listReferenceProfiles?(): Promise<readonly AuroraBrowserPocketReferenceProfileSummary[]>
  saveReferenceProfile?(input: AuroraBrowserPocketReferenceProfileInput): Promise<AuroraBrowserPocketReferenceProfileSummary>
  deleteReferenceProfile?(profileId: string): Promise<void>
}

export const AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT = 'aurora-browser-voice-packs-changed'

class MissingGatewayTransport implements AuroraTransport {
  readonly kind = 'http'

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    throw new AuroraError({
      code: 'transport_loss',
      message: 'Aurora is not set up on this device. Finish setup or turn on sample data.',
      method: request.method,
      busTopic: request.busTopic,
      detail: {
        demo_mode: false,
        missing_connection_options: ['http_gateway', 'webrtc_invite'],
        secrets_redacted: true,
        repair_action: 'finish_setup_or_enable_sample_data'
      }
    })
  }
}

export function createAuroraWebClient(): AuroraClient {
  const gatewayUrl = process.env.AURORA_GATEWAY_URL
  if (gatewayUrl) {
    return new AuroraClient({
      transport: new HttpGatewayTransport({
        baseUrl: gatewayUrl
      })
    })
  }
  if (isServerDemoMode()) {
    return createDebugUiDemoClient(resolveAuroraDebugUiLaunch())
  }
  return new AuroraClient({ transport: new MissingGatewayTransport() })
}

export async function authorizeAuroraServerAssistantSession(
  headers: Headers,
  signal?: AbortSignal,
): Promise<boolean> {
  const bearerToken = bearerTokenFromHeaders(headers)
  if (!bearerToken) return false
  const gatewayUrl = process.env.AURORA_GATEWAY_URL?.trim()
  if (!gatewayUrl) return false
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/+$/u, '')}${routePath('Auth', 'WhoAmI')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: '{}',
      cache: 'no-store',
      signal,
    })
    if (!response.ok) return false
    const identity = await response.json() as {
      error?: unknown
      principal_id?: unknown
      permissions?: unknown
      effective_perms?: unknown
      is_admin?: unknown
    }
    if (typeof identity.error === 'string' || typeof identity.principal_id !== 'string') return false
    const permissions = Array.isArray(identity.effective_perms)
      ? identity.effective_perms
      : Array.isArray(identity.permissions)
        ? identity.permissions
        : []
    return identity.is_admin === true || permissions.some((permission) => (
      permission === '*' || permission === 'Orchestrator.use'
    ))
  } catch {
    return false
  }
}

function bearerTokenFromHeaders(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  const match = authorization?.match(/^Bearer\s+(.+)$/iu)
  const token = match?.[1]?.trim()
  return token || null
}

export async function loadAuroraBrowserAssistantAvailability(options: {
  readonly bearerToken?: (() => string | null | undefined) | undefined
} = {}): Promise<boolean> {
  try {
    const headers = assistantRouteHeaders({ accept: 'application/json' }, options.bearerToken)
    const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
      method: 'GET',
      headers,
    })
    if (!response.ok) return false
    const body = await response.json() as { enabled?: unknown }
    return body.enabled === true
  } catch {
    return false
  }
}

export function createAuroraBrowserAssistantProvider(options: {
  readonly bearerToken?: (() => string | null | undefined) | undefined
} = {}): LightweightAssistantProvider {
  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      const headers = assistantRouteHeaders({ 'content-type': 'application/json' }, options.bearerToken)
      const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: request.messages,
          tools: request.tools,
          maxToolCalls: request.maxToolCalls,
        }),
        signal: request.signal,
      })
      if (!response.ok) throw new Error('assistant_unavailable')
      return await response.json() as LightweightProviderResponse
    },
  }
}

function assistantRouteHeaders(
  baseHeaders: Record<string, string>,
  bearerToken: (() => string | null | undefined) | undefined,
): Record<string, string> {
  const token = bearerToken?.()?.trim()
  return token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders
}

export function createAuroraBrowserRuntime(): AuroraBrowserRuntime {
  return createAuroraBrowserRuntimeFromStore(null, null, disabledBrowserSpeechPacks())
}

export async function createAuroraBrowserRuntimeAsync({
  localAssistant = null,
}: {
  readonly localAssistant?: AuroraBrowserLightweightAssistantConfig | null | undefined
} = {}): Promise<AuroraBrowserRuntime> {
  if (browserRuntimeProfileTransition) await browserRuntimeProfileTransition
  const credentialStore = ensureBrowserCredentialStore()
  const profileDocument = ensureDebugUiLaunchRuntimeProfile(credentialStore)
  const profileRevision = browserRuntimeProfileRevision
  const runtimeProfile = activeRuntimeProfile(profileDocument)
  const rolloutFlags = browserWebRtcRolloutFlags()
  const localStablePeerId = runtimeProfile?.localNode.stablePeerId || credentialStore.getOrCreateLocalStablePeerId()
  const baseKey = browserClientCacheKey(null)
  const factory = browserMeshNodeServicesFactoryForTests ?? createBrowserMeshNodeServices
  const meshNodeServices = await resolveBrowserMeshNodeServices(baseKey, () => factory({
    runtimeProfile,
    credentialStore,
    rolloutFlags,
    localStablePeerId,
    origin: typeof window === 'undefined' ? undefined : window.location.origin,
    navigator: typeof navigator === 'undefined' ? null : navigator,
    window: typeof window === 'undefined' ? null : window,
    notification: browserNotificationPort(),
    filePicker: browserFilePickerPort(),
    crypto: typeof crypto === 'undefined' ? null : crypto,
    indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    localDataBackendFactory: async (profileId, localNodeId) => {
      const backend = new BrowserIndexedDbLocalDataBackend({
        origin: typeof window === 'undefined' ? undefined : window.location.origin,
        indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
      })
      const session = await backend.open(profileId, localNodeId)
      return { backend, session }
    },
    envelopeCryptoFactory: (options) => new BrowserEnvelopeCryptoPort(options),
  }))
  if (profileRevision !== browserRuntimeProfileRevision) {
    await closeBrowserMeshNodeServices(meshNodeServices).catch(() => undefined)
    if (browserRuntimeProfileTransition) await browserRuntimeProfileTransition
    return await createAuroraBrowserRuntimeAsync({ localAssistant })
  }
  const browserSpeechPacks = await resolveBrowserSpeechPacks(runtimeProfile)
  if (profileRevision !== browserRuntimeProfileRevision) {
    await closeBrowserMeshNodeServices(meshNodeServices).catch(() => undefined)
    if (browserRuntimeProfileTransition) await browserRuntimeProfileTransition
    return await createAuroraBrowserRuntimeAsync({ localAssistant })
  }
  return createAuroraBrowserRuntimeFromStore(meshNodeServices, localAssistant, browserSpeechPacks)
}

async function resolveBrowserSpeechPacks(
  runtimeProfile: AuroraRuntimeProfileV2 | undefined,
): Promise<AuroraBrowserSpeechPacksRuntimeStatus> {
  const debugLaunch = resolveAuroraDebugUiLaunch()
  const surface = getAuroraSurfaceProfile({
    runtimeMode: debugLaunch?.runtimeMode ?? 'web-thin',
    transportKind: 'http',
    ...(debugLaunch?.nativePlatform ? { nativePlatform: debugLaunch.nativePlatform } : {}),
    ...(debugLaunch?.userAgent ? { userAgent: debugLaunch.userAgent } : {}),
    nodeMode: runtimeProfile?.nodeMode,
    runtimeTier: runtimeProfile?.runtimeTier,
    enabledCapabilityPacks: runtimeProfile?.localNode.enabledCapabilityPacks ?? [],
    localSpeechPackState: runtimeProfile?.localNode.localSpeechPackState,
  })
  const foregroundVoiceSelected = runtimeProfile?.localNode.enabledCapabilityPacks.includes('foreground-voice') === true
  if (!foregroundVoiceSelected || !surface.usesBrowserVoiceRuntime) {
    return disabledBrowserSpeechPacks()
  }
  return await openActiveBrowserSpeechPacks({
    enabled: true,
    trustSelections: browserSpeechTrustSelectionsForProfile(runtimeProfile),
    ttsVoiceId: runtimeProfile?.localNode.localSpeechSelection?.tts?.voiceId ?? null,
  })
}

async function resolveBrowserMeshNodeServices(
  baseKey: string,
  createServices: () => Promise<BrowserMeshNodeServices>,
): Promise<BrowserMeshNodeServices | null> {
  const existing = browserMeshNodeCompositionInflight
  if (existing?.baseKey === baseKey) return await existing.promise
  if (existing) {
    void existing.promise
      .then(closeBrowserMeshNodeServices)
      .catch(() => undefined)
  }
  const promise = (async () => {
    try {
      const services = await createServices()
      browserMeshNodeCompositionStatus = services.compositionStatus
      return services
    } catch (error) {
      if (!(error instanceof BrowserMeshNodeCompositionError)) throw error
      browserMeshNodeCompositionStatus = browserMeshNodeCompositionStatusFromError(error)
      return null
    }
  })()
  browserMeshNodeCompositionInflight = { baseKey, promise }
  const services = await promise
  if (browserMeshNodeCompositionInflight?.baseKey !== baseKey) {
    await closeBrowserMeshNodeServices(services).catch(() => undefined)
    return null
  }
  browserMeshNodeCompositionInflight = null
  return services
}

function createAuroraBrowserRuntimeFromStore(
  meshNodeServices: BrowserMeshNodeServices | null,
  localAssistant: AuroraBrowserLightweightAssistantConfig | null = null,
  browserSpeechPacks: AuroraBrowserSpeechPacksRuntimeStatus = disabledBrowserSpeechPacks(),
): AuroraBrowserRuntime {
  const credentialStore = ensureBrowserCredentialStore()
  const profileDocument = ensureDebugUiLaunchRuntimeProfile(credentialStore)
  const runtimeProfile = activeRuntimeProfile(profileDocument)
  const debugLaunch = resolveAuroraDebugUiLaunch()
  const thinProfile = thinRuntimeProfileFromRuntimeProfile(runtimeProfile)
  const baseKey = browserClientCacheKey(null)
  const key = browserClientCacheKey(meshNodeServices, browserSpeechPacks.revision)
  const cached = browserRuntimeCache
  if (cached?.key === key && cached.localAssistant === localAssistant) return cached.runtime
  if (
    meshNodeServices === null
    && cached?.meshNodeServices
    && cached.baseKey === baseKey
    && cached.localAssistant === localAssistant
  ) {
    return cached.runtime
  }
  void browserRuntimeCache?.runtime.close().catch(() => undefined)
  const mode = thinProfile?.mode ?? 'http-only'
  const rolloutFlags = browserWebRtcRolloutFlags()
  const gatewayUrl = thinProfile?.gatewayUrl
  const persistedProfile = thinProfile
    ? thinProfile.webrtcProfile
    : credentialStore.loadConnectionProfile() ?? undefined
  const localStablePeerId = thinProfile?.localStablePeerId || credentialStore.getOrCreateLocalStablePeerId()
  const effectiveMeshNodeServices = runtimeProfile?.nodeMode === 'mesh-node' ? meshNodeServices : null
  const runtime = createBrowserWebThinRuntime({
    mode,
    nodeRole: runtimeProfile?.nodeMode ?? 'remote-console',
    enabledCapabilityPacks: runtimeProfile?.localNode.enabledCapabilityPacks ?? [],
    localSpeechPackState: browserSpeechPacks.state === 'ready' ? 'ready' : runtimeProfile?.localNode.localSpeechPackState,
    localSpeechEngineCapabilities: browserSpeechPacks.state === 'ready' ? browserSpeechPacks.capabilities : null,
    gatewayUrl,
    bearerToken: () => runtime.client.auth.bearerToken(),
    signalingUrl: thinProfile?.signalingUrl,
    runtimeMode: debugLaunch?.runtimeMode ?? 'web-thin',
    ...(debugLaunch?.nativePlatform ? { nativePlatform: debugLaunch.nativePlatform } : {}),
    ...(debugLaunch?.userAgent ? { userAgent: debugLaunch.userAgent } : {}),
    demoMode: isBrowserDemoMode(),
    rolloutFlags,
    allowInsecureLoopback: truthy(process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK),
    allowInsecureLoopbackSignaling: truthy(process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK),
    nodeName: thinProfile?.nodeName ?? 'Aurora Web thin client',
    credentialStore,
    ...(effectiveMeshNodeServices?.peerHost ? { peerHost: effectiveMeshNodeServices.peerHost } : {}),
    ...(effectiveMeshNodeServices?.peerAuthorityResolver ? { peerAuthorityResolver: effectiveMeshNodeServices.peerAuthorityResolver } : {}),
    ...(effectiveMeshNodeServices?.peerPairingIssuer ? { peerPairingIssuer: effectiveMeshNodeServices.peerPairingIssuer } : {}),
    ...(persistedProfile ? { profile: persistedProfile } : {}),
    ...(localStablePeerId ? { localStablePeerId } : {}),
    visibilityDocument: typeof document === 'undefined' ? undefined : document,
    windowLocation: typeof window === 'undefined' ? undefined : window.location,
    createClient: (transport) => (
      debugLaunch && isBrowserDemoMode()
        ? createDebugUiDemoClient(debugLaunch)
        : new AuroraClient({ transport })
    ),
    createDemoClient: () => createDebugUiDemoClient(debugLaunch),
  })
  const runtimeWithLocalServices = Object.assign(runtime, {
    ...(effectiveMeshNodeServices
      ? {
          localData: {
            session: effectiveMeshNodeServices.session,
            backend: effectiveMeshNodeServices.backend,
            crypto: effectiveMeshNodeServices.crypto,
          },
          localFeatureSharing: effectiveMeshNodeServices.localFeatureSharing,
          localToolProvider: effectiveMeshNodeServices.provider,
          ...(runtime.features.lightweightOrchestratorEnabled && localAssistant
            ? { localAssistant }
            : {}),
        }
      : {}),
    localNodeProviderStatus: localNodeProviderStatus(
      effectiveMeshNodeServices,
      browserMeshNodeCompositionStatus,
      runtimeProfile?.nodeMode === 'mesh-node',
    ),
    browserSpeechPacks,
    localSpeechCatalog: createBrowserLocalSpeechCatalogPort(),
  }) as AuroraBrowserRuntime
  const closeRuntime = runtime.close.bind(runtime)
  let closed = false
  runtime.close = async () => {
    if (closed) return
    closed = true
    if (browserRuntimeCache?.runtime === runtime) {
      browserRuntimeCache = null
      browserCredentialStore = null
    }
    await Promise.all([
      closeRuntime(),
      closeBrowserMeshNodeServices(effectiveMeshNodeServices).catch(() => undefined),
    ])
  }
  const ownsPeerConnection =
    runtimeProfile?.nodeMode !== 'mesh-node'
    || effectiveMeshNodeServices !== null
  if (persistedProfile && rolloutFlags.webrtc_thin_client && ownsPeerConnection) {
    queueMicrotask(() => {
      void runtime.peer.connect(persistedProfile).catch(() => undefined)
    })
  }
  browserRuntimeCache = {
    baseKey,
    key,
    localAssistant,
    runtime: runtimeWithLocalServices,
    meshNodeServices: effectiveMeshNodeServices,
  }
  return runtimeWithLocalServices
}

export function createAuroraBrowserClient(): AuroraClient {
  return createAuroraBrowserRuntime().client
}

export function resetAuroraBrowserClientForTests(): void {
  void closeBrowserRuntimeCache().catch(() => undefined)
  void browserCredentialStore?.close().catch(() => undefined)
  browserCredentialStore = null
  browserRuntimeProfileRevision += 1
  browserMeshNodeServicesFactoryForTests = null
  browserVoicePackCatalogForTests = null
}

export function auroraBrowserMeshNodeCompositionStatus(): BrowserMeshNodeCompositionStatus {
  return browserMeshNodeCompositionStatus
}

function localNodeProviderStatus(
  services: BrowserMeshNodeServices | null,
  status: BrowserMeshNodeCompositionStatus,
  requested: boolean,
): AuroraBrowserLocalNodeProviderStatus {
  if (services?.enabled) {
    return {
      available: true,
      state: 'available',
      productMessage: status.productMessage,
      registeredFeatureCount: services.registeredToolIds.length,
      localDataWritable: true,
    }
  }
  if (!requested || status.state === 'disabled') {
    return {
      available: false,
      state: 'not-configured',
      productMessage: status.productMessage,
      registeredFeatureCount: 0,
      localDataWritable: false,
    }
  }
  return {
    available: false,
    state:
      status.reasonCode === 'local_data_owned_elsewhere'
        ? 'open-in-another-tab'
        : 'needs-attention',
    productMessage: status.productMessage,
    registeredFeatureCount: 0,
    localDataWritable: false,
  }
}

export function setAuroraBrowserMeshNodeServicesFactoryForTests(
  factory: BrowserMeshNodeServicesFactory | null,
): void {
  browserMeshNodeServicesFactoryForTests = factory
}

export function setAuroraBrowserVoicePackCatalogSourceForTests(
  source: BrowserVoicePackCatalogSource | null,
): void {
  browserVoicePackCatalogForTests = source
}

export const setAuroraBrowserSpeechPackOpenerForTests = setAuroraBrowserVoicePackCatalogSourceForTests

export function auroraBrowserThinProfileDocument(): ThinProfileDocument {
  const runtimeDocument = ensureDebugUiLaunchRuntimeProfile(ensureBrowserCredentialStore())
  try {
    return runtimeProfileDocumentToThinDocument(runtimeDocument)
  } catch {
    return thinDocumentFromRuntimeDocument(runtimeDocument)
  }
}

export function auroraBrowserThinProfile(): ThinConnectionProfile | undefined {
  return activeThinConnectionProfile(auroraBrowserThinProfileDocument())
}

export function auroraBrowserRuntimeProfileDocument(): AuroraRuntimeProfileDocumentV2 {
  return ensureDebugUiLaunchRuntimeProfile(ensureBrowserCredentialStore())
}

export function auroraBrowserRuntimeProfile(): AuroraRuntimeProfileV2 | undefined {
  return activeRuntimeProfile(auroraBrowserRuntimeProfileDocument())
}

export function auroraBrowserRequiresOnboarding(): boolean {
  if (truthy(process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE)) return false
  const runtimeProfile = auroraBrowserRuntimeProfile()
  if (runtimeProfile) return !isRuntimeProfileConfigured(runtimeProfile)
  return !isThinConnectionProfileConfigured(auroraBrowserThinProfile())
}

function ensureDebugUiLaunchRuntimeProfile(
  store: BrowserPersistentPeerCredentialStore,
): AuroraRuntimeProfileDocumentV2 {
  const current = store.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  const launch = resolveAuroraDebugUiLaunch()
  if (!launch) return current

  const profileId = `ui-launch-${launch.preset}`
  const existing = current.profiles.find((profile) => profile.id === profileId)
  const sanitizeOptions = debugUiLaunchSanitizeOptions(launch)
  const profile = sanitizeRuntimeProfile(applyDebugUiLaunchToRuntimeProfile(launch, existing), sanitizeOptions)
  const next = sanitizeRuntimeProfileDocument({
    version: 2,
    activeProfileId: profile.id,
    profiles: [
      ...current.profiles.filter((candidate) => candidate.id !== profile.id),
      profile,
    ],
  }, sanitizeOptions)
  const persistable = persistableDebugLaunchDocument(next, launch)
  if (JSON.stringify(persistable) !== JSON.stringify(current)) {
    store.saveRuntimeProfileDocument(persistable)
    browserRuntimeProfileRevision += 1
  }
  return next
}

function persistableDebugLaunchDocument(
  document: AuroraRuntimeProfileDocumentV2,
  launch: AuroraDebugUiLaunch,
): AuroraRuntimeProfileDocumentV2 {
  if (launch.runtimeTier !== 'python-full') return document
  return sanitizeRuntimeProfileDocument({
    ...document,
    profiles: document.profiles.map((candidate) => (
      candidate.runtimeTier === 'python-full'
        ? { ...candidate, runtimeTier: 'lightweight-ts' }
        : candidate
    )),
  })
}

export async function saveAuroraBrowserThinProfile(
  profile: ThinConnectionProfile,
  roomSecret?: {
    roomSecretRef: string
    roomSecret: string
  },
): Promise<void> {
  const sanitized = sanitizeThinConnectionProfile(profile)
  const store = ensureBrowserCredentialStore()
  if (roomSecret) {
    if (sanitized.webrtcProfile?.roomSecretRef !== roomSecret.roomSecretRef) {
      throw new Error('Saved invite details do not match this connection profile.')
    }
    store.setRoomSecret(roomSecret.roomSecretRef, roomSecret.roomSecret)
  }
  const current = store.loadThinProfileDocument() ?? emptyThinProfileDocument()
  store.saveThinProfileDocument({
    version: 1,
    activeProfileId: sanitized.id,
    profiles: [
      ...current.profiles.filter((candidate) => candidate.id !== sanitized.id),
      sanitized,
    ],
  })
  if (sanitized.webrtcProfile) {
    store.saveConnectionProfile(sanitized.webrtcProfile)
  }
  browserRuntimeProfileRevision += 1
  await finishBrowserRuntimeProfileTransition(store)
}

export async function saveAuroraBrowserOnboardingProfile(
  profile: ThinConnectionProfile,
  nodeMode: AuroraNodeMode | 'connect-to-aurora' | 'make-this-device-available' | 'run-aurora-on-this-computer',
  roomSecret?: {
    roomSecretRef: string
    roomSecret: string
  },
): Promise<void> {
  const sanitized = sanitizeThinConnectionProfile(profile)
  const selectedNodeMode = normalizeOnboardingNodeMode(nodeMode)
  if (selectedNodeMode === 'mesh-node' && !sanitized.webrtcProfile) {
    throw new Error('This device needs a saved Aurora invite before it can be made available.')
  }
  const homeConnection = selectedNodeMode === 'remote-console'
    ? {
      mode: sanitized.mode,
      ...(sanitized.gatewayUrl ? { gatewayUrl: sanitized.gatewayUrl } : {}),
      ...(sanitized.signalingUrl ? { signalingUrl: sanitized.signalingUrl } : {}),
      ...(sanitized.webrtcProfile?.expectedStablePeerId
        ? { homePeerId: sanitized.webrtcProfile.expectedStablePeerId }
        : {}),
      ...(sanitized.webrtcProfile ? { webrtcProfile: sanitized.webrtcProfile } : {}),
    }
    : sanitized.gatewayUrl
      ? {
        mode: 'http-only' as const,
        gatewayUrl: sanitized.gatewayUrl,
      }
      : undefined
  const runtimeProfile: AuroraRuntimeProfileV2 = {
    version: 2,
    id: sanitized.id,
    label: sanitized.label,
    nodeMode: selectedNodeMode,
    runtimeTier: selectedNodeMode === 'mesh-node' ? 'lightweight-ts' : 'none',
    ...(homeConnection ? { homeConnection } : {}),
    localNode: {
      nodeName: sanitized.nodeName,
      stablePeerId: sanitized.localStablePeerId,
      enabledCapabilityPacks: selectedNodeMode === 'mesh-node' ? ['native-actions'] : [],
      ...(selectedNodeMode === 'mesh-node' && sanitized.webrtcProfile
        ? {
          meshMembership: {
            signalingUrl: sanitized.signalingUrl || sanitized.webrtcProfile.signalingBrokers[0] || '',
            webrtcProfile: {
              ...sanitized.webrtcProfile,
              mode: 'webrtc-only',
            },
          },
        }
        : {}),
    },
  }
  await saveAuroraBrowserRuntimeProfile(runtimeProfile, roomSecret)
}

export async function saveAuroraBrowserRuntimeProfile(
  profile: AuroraRuntimeProfileV2,
  roomSecret?: {
    roomSecretRef: string
    roomSecret: string
  },
): Promise<void> {
  const sanitized = sanitizeRuntimeProfile(profile)
  const store = ensureBrowserCredentialStore()
  if (roomSecret) {
    const allowedRefs = new Set([
      sanitized.homeConnection?.webrtcProfile?.roomSecretRef,
      sanitized.localNode.meshMembership?.webrtcProfile.roomSecretRef,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0))
    if (!allowedRefs.has(roomSecret.roomSecretRef)) {
      throw new Error('Saved invite details do not match this connection profile.')
    }
    store.setRoomSecret(roomSecret.roomSecretRef, roomSecret.roomSecret)
  }
  const current = store.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  store.saveRuntimeProfileDocument(sanitizeRuntimeProfileDocument({
    version: 2,
    activeProfileId: sanitized.id,
    profiles: [
      ...current.profiles.filter((candidate) => candidate.id !== sanitized.id),
      sanitized,
    ],
  }))
  if (sanitized.homeConnection?.webrtcProfile) {
    store.saveConnectionProfile(sanitized.homeConnection.webrtcProfile)
  }
  if (sanitized.localNode.meshMembership?.webrtcProfile) {
    store.saveConnectionProfile(sanitized.localNode.meshMembership.webrtcProfile)
  }
  browserRuntimeProfileRevision += 1
  await finishBrowserRuntimeProfileTransition(store)
}

export async function saveAuroraBrowserLocalSpeechSelection(
  selection: AuroraLocalSpeechSelectionProfile,
  languages?: AuroraLocalSpeechLanguagePrefs,
): Promise<void> {
  const current = auroraBrowserRuntimeProfile()
  if (!current) throw new Error('Browser runtime profile is unavailable')
  const enabledCapabilityPacks = current.localNode.enabledCapabilityPacks.includes('foreground-voice')
    ? current.localNode.enabledCapabilityPacks
    : [...current.localNode.enabledCapabilityPacks, 'foreground-voice' as const]
  await saveAuroraBrowserRuntimeProfile({
    ...current,
    localNode: {
      ...mergeLocalNodeSpeechPreferences(current.localNode, selection, languages),
      enabledCapabilityPacks,
    },
  })
  dispatchBrowserVoicePacksChanged()
}

export async function selectAuroraBrowserThinProfile(
  profileId: string,
): Promise<void> {
  const store = ensureBrowserCredentialStore()
  const current = store.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  if (!current.profiles.some((profile) => profile.id === profileId)) {
    throw new Error('Browser runtime profile does not exist')
  }
  store.saveRuntimeProfileDocument({
    ...current,
    activeProfileId: profileId,
  })
  browserRuntimeProfileRevision += 1
  await finishBrowserRuntimeProfileTransition(store)
}

export function isAuroraWebDemoMode(): boolean {
  return isServerDemoMode() || isBrowserDemoMode()
}

export function auroraBrowserRuntimeDiagnostics(): string[] {
  const profile = auroraBrowserThinProfile()
  const runtimeProfile = auroraBrowserRuntimeProfile()
  return explainBrowserThinRuntime({
    mode: profile?.mode,
    gatewayUrl: profile?.gatewayUrl,
    signalingUrl: profile?.signalingUrl,
    profile: profile?.webrtcProfile,
    nodeRole: runtimeProfile?.nodeMode,
    enabledCapabilityPacks: runtimeProfile?.localNode.enabledCapabilityPacks,
    localSpeechPackState: runtimeProfile?.localNode.localSpeechPackState,
    rolloutFlags: browserWebRtcRolloutFlags(),
  })
}

function browserClientCacheKey(meshNodeServices: BrowserMeshNodeServices | null = null, browserSpeechPacksRevision = 'none'): string {
  const document = browserCredentialStore?.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  const debugLaunch = resolveAuroraDebugUiLaunch()
  return JSON.stringify({
    document,
    demoMode: isBrowserDemoMode(),
    debugLaunch: debugLaunch
      ? {
        preset: debugLaunch.preset,
        runtimeMode: debugLaunch.runtimeMode,
        nativePlatform: debugLaunch.nativePlatform,
        userAgent: debugLaunch.userAgent,
      }
      : null,
    rolloutFlags: browserWebRtcRolloutFlags(),
    browserSpeechPacksRevision,
    meshNodeServices: meshNodeServices
      ? {
        enabled: meshNodeServices.enabled,
        storageBackendKind: meshNodeServices.storageBackendKind,
        registeredToolIds: meshNodeServices.registeredToolIds,
      }
      : null,
  })
}

function disabledBrowserSpeechPacks(): AuroraBrowserSpeechPacksRuntimeStatus {
  return Object.freeze({
    state: 'disabled',
    packs: Object.freeze([]),
    capabilities: Object.freeze({ vad: false, kws: false, stt: false, tts: false }),
    revision: 'disabled',
  })
}

function browserSpeechTrustSelectionsForProfile(
  runtimeProfile: AuroraRuntimeProfileV2 | undefined,
): AuroraBrowserSpeechPackTrustSelection[] {
  const selected = runtimeProfile?.localNode.localSpeechSelection
  if (!selected) return []
  const stored = loadBrowserSpeechTrustSelections()
  const selections: AuroraBrowserSpeechPackTrustSelection[] = []
  for (const task of ['vad', 'kws', 'stt', 'tts'] as const) {
    const taskSelection = selected[task]
    if (!taskSelection) continue
    const trust = stored.find((candidate) =>
      candidate.task === task
      && candidate.packId === taskSelection.packId
      && candidate.packVersion === taskSelection.packRevision
      && (task !== 'tts' || candidate.voiceId === taskSelection.voiceId)
      && (task !== 'tts' || candidate.referenceProfileId === taskSelection.referenceProfileId)
    )
    if (trust) selections.push(trust)
  }
  return selections
}

function loadBrowserSpeechTrustSelections(): AuroraBrowserSpeechPackTrustSelection[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(BROWSER_SPEECH_TRUST_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isBrowserSpeechTrustSelection)
  } catch {
    return []
  }
}

function saveBrowserSpeechTrustSelection(selection: AuroraBrowserSpeechPackTrustSelection): void {
  if (typeof window === 'undefined') return
  const current = loadBrowserSpeechTrustSelections()
  const next = [
    ...current.filter((candidate) => !sameBrowserSpeechTrustSelection(candidate, selection)),
    selection,
  ]
  window.localStorage.setItem(BROWSER_SPEECH_TRUST_STORAGE_KEY, JSON.stringify(next))
}

function sameBrowserSpeechTrustSelection(
  left: AuroraBrowserSpeechPackTrustSelection,
  right: AuroraBrowserSpeechPackTrustSelection,
): boolean {
  return left.task === right.task
    && left.packId === right.packId
    && left.packVersion === right.packVersion
    && left.voiceId === right.voiceId
    && left.referenceProfileId === right.referenceProfileId
}

function isBrowserSpeechTrustSelection(value: unknown): value is AuroraBrowserSpeechPackTrustSelection {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<AuroraBrowserSpeechPackTrustSelection>
  return isBrowserSpeechTask(record.task)
    && typeof record.packId === 'string'
    && typeof record.packVersion === 'string'
    && (record.verificationMode === undefined || record.verificationMode === 'release-hash' || record.verificationMode === 'embedded-catalog' || record.verificationMode === 'signature')
    && (record.releaseKeyId === undefined || typeof record.releaseKeyId === 'string')
    && (record.releasePublicKeyBase64 === undefined || typeof record.releasePublicKeyBase64 === 'string')
    && typeof record.expectedManifestSha256 === 'string'
    && (record.slotId === undefined || typeof record.slotId === 'string')
    && (record.voiceId === undefined || typeof record.voiceId === 'string')
    && (record.referenceProfileId === undefined || typeof record.referenceProfileId === 'string')
}

function isBrowserSpeechTask(value: unknown): value is AuroraBrowserSpeechPackTask {
  return value === 'vad' || value === 'kws' || value === 'stt' || value === 'tts'
}

function createBrowserLocalSpeechCatalogPort(): AuroraLocalSpeechCatalogPort {
  const source = browserVoicePackCatalogSource()
  if (source) {
    return Object.freeze({
      available: true,
      listCatalog: () => source.listCatalog(),
      async select(request: AuroraBrowserSpeechPackInstallRequest) {
        const receipt = await source.select(request)
        await persistBrowserVoiceCatalogSelection(receipt, request)
        return receipt
      },
      ...(source.listReferenceProfiles ? { listReferenceProfiles: () => source.listReferenceProfiles!() } : {}),
      ...(source.saveReferenceProfile ? { saveReferenceProfile: (input: AuroraBrowserPocketReferenceProfileInput) => source.saveReferenceProfile!(input) } : {}),
      ...(source.deleteReferenceProfile ? { deleteReferenceProfile: (profileId: string) => source.deleteReferenceProfile!(profileId) } : {}),
    })
  }
  return createAuroraBrowserVoiceCatalogPort({
    available: typeof window !== 'undefined',
    fetchBytes: fetchAuroraBrowserVoiceAssetBytes,
    async afterSelect(receipt, request) {
      await persistBrowserVoiceCatalogSelection(receipt, request)
    },
    async afterReferenceProfileDeleted(profileId) {
      await clearDeletedBrowserVoiceReferenceProfile(profileId)
    },
  })
}

function browserVoicePackCatalogSource(): BrowserVoicePackCatalogSource | null {
  if (browserVoicePackCatalogForTests) return browserVoicePackCatalogForTests
  return null
}

async function persistBrowserVoiceCatalogSelection(
  receipt: AuroraBrowserSpeechPackInstallReceipt,
  request: AuroraBrowserSpeechPackInstallRequest,
): Promise<void> {
  saveBrowserSpeechTrustSelection(receipt.trust)
  await saveAuroraBrowserLocalSpeechSelection({
    [receipt.task]: {
      packId: receipt.packId,
      packRevision: receipt.packVersion,
      ...(receipt.trust.voiceId ? { voiceId: receipt.trust.voiceId } : {}),
      ...(request.selection.voiceRevision ? { voiceRevision: request.selection.voiceRevision } : {}),
      ...(request.selection.referenceProfileId ? { referenceProfileId: request.selection.referenceProfileId } : {}),
    },
  })
}

async function clearDeletedBrowserVoiceReferenceProfile(profileId: string): Promise<void> {
  const current = auroraBrowserRuntimeProfile()
  const selected = current?.localNode.localSpeechSelection?.tts
  if (!selected || selected.referenceProfileId !== profileId) return
  await saveAuroraBrowserLocalSpeechSelection({
    tts: {
      packId: selected.packId,
      packRevision: selected.packRevision,
      ...(selected.voiceId ? { voiceId: selected.voiceId } : {}),
      ...(selected.voiceRevision ? { voiceRevision: selected.voiceRevision } : {}),
    },
  })
}

function dispatchBrowserVoicePacksChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT))
}

async function closeBrowserRuntimeCache(): Promise<void> {
  const cached = browserRuntimeCache
  const inflight = browserMeshNodeCompositionInflight
  browserRuntimeCache = null
  browserMeshNodeCompositionInflight = null
  await Promise.all([
    cached?.runtime.close().catch(() => undefined),
    inflight?.promise
      .then(closeBrowserMeshNodeServices)
      .catch(() => undefined),
  ])
}

async function closeBrowserMeshNodeServices(
  services: BrowserMeshNodeServices | null | undefined,
): Promise<void> {
  if (!services || closedBrowserMeshNodeServices.has(services)) return
  closedBrowserMeshNodeServices.add(services)
  await services.close()
}

function ensureBrowserCredentialStore(): BrowserPersistentPeerCredentialStore {
  const store = browserCredentialStore ?? new BrowserPersistentPeerCredentialStore()
  browserCredentialStore = store
  return store
}

async function finishBrowserRuntimeProfileTransition(
  store: BrowserPersistentPeerCredentialStore,
): Promise<void> {
  const transition = (async () => {
    await closeBrowserRuntimeCache()
    await store.close()
    if (browserCredentialStore === store) browserCredentialStore = null
  })()
  browserRuntimeProfileTransition = transition
  try {
    await transition
  } finally {
    if (browserRuntimeProfileTransition === transition) {
      browserRuntimeProfileTransition = null
    }
  }
}

function thinProfileFromRuntimeProfile(
  profile: AuroraRuntimeProfileV2 | undefined,
): ThinConnectionProfile | undefined {
  if (!profile?.homeConnection) return undefined
  try {
    return runtimeProfileToThinConnectionProfile(profile)
  } catch {
    return undefined
  }
}

function thinRuntimeProfileFromRuntimeProfile(
  profile: AuroraRuntimeProfileV2 | undefined,
): ThinConnectionProfile | undefined {
  if (!profile) return undefined
  if (profile.nodeMode === 'mesh-node' && profile.localNode.meshMembership) {
    const membership = profile.localNode.meshMembership
    const gatewayUrl = profile.homeConnection?.gatewayUrl ?? ''
    return sanitizeThinConnectionProfile({
      id: profile.id,
      label: profile.label,
      mode: gatewayUrl ? 'webrtc-preferred' : 'webrtc-only',
      gatewayUrl,
      signalingUrl: membership.signalingUrl,
      nodeName: profile.localNode.nodeName,
      localStablePeerId: profile.localNode.stablePeerId,
      webrtcProfile: membership.webrtcProfile,
    })
  }
  return thinProfileFromRuntimeProfile(profile)
}

function thinDocumentFromRuntimeDocument(document: AuroraRuntimeProfileDocumentV2): ThinProfileDocument {
  const profiles = document.profiles.flatMap((profile) => {
    const projected = thinProfileFromRuntimeProfile(profile)
    return projected ? [projected] : []
  })
  const activeProfileId = profiles.some((profile) => profile.id === document.activeProfileId)
    ? document.activeProfileId
    : null
  return { version: 1, activeProfileId, profiles }
}

function normalizeOnboardingNodeMode(
  value: AuroraNodeMode | 'connect-to-aurora' | 'make-this-device-available' | 'run-aurora-on-this-computer',
): AuroraNodeMode {
  if (value === 'mesh-node' || value === 'make-this-device-available') return 'mesh-node'
  if (value === 'run-aurora-on-this-computer') {
    throw new Error('Hosted web cannot select the full local runtime')
  }
  return 'remote-console'
}

function browserWebRtcRolloutFlags(): AuroraWebRtcRolloutFlags {
  return {
    webrtc_thin_client: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT),
    webrtc_scoped_subscriptions: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS),
    webrtc_fragmentation: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_WEBRTC_FRAGMENTATION),
    webrtc_app_layer_e2ee: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_WEBRTC_APP_LAYER_E2EE),
    mesh_node_runtime_v1: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_MESH_NODE_RUNTIME_V1),
    local_tool_provider_v1: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_LOCAL_TOOL_PROVIDER_V1),
    lightweight_orchestrator_v1: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_LIGHTWEIGHT_ORCHESTRATOR_V1),
    native_webrtc_transport_v1: enabledUnlessExplicitlyFalse(process.env.NEXT_PUBLIC_AURORA_NATIVE_WEBRTC_TRANSPORT_V1),
  }
}

function isServerDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.AURORA_WEB_DEMO_MODE)
}

function isBrowserDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE)
}

function createDebugUiDemoClient(launch: AuroraDebugUiLaunch | null): AuroraClient {
  const transport = new MockAuroraTransport()
  const sessionIsAdmin = launch ? debugUiLaunchSessionIsAdmin(launch) : false
  const whoAmI = {
    principal_id: sessionIsAdmin ? 'demo-admin' : 'demo-member',
    principal_name: sessionIsAdmin ? 'Admin' : 'Member',
    permissions: sessionIsAdmin ? ['*'] : ['Gateway.use'],
    effective_perms: sessionIsAdmin ? ['*'] : ['Gateway.use'],
    is_admin: sessionIsAdmin,
  }
  transport.register('Auth.WhoAmI', () => whoAmI)
  const nativeManifest = nativeManifestForDebugLaunch(launch)
  if (nativeManifest === 'unavailable') {
    transport.register('Native.GetCapabilityManifest', () => {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Device features are not available here yet.',
      })
    })
  } else if (nativeManifest) {
    transport.register('Native.GetCapabilityManifest', () => cloneFixture(nativeManifest))
  }
  const client = new AuroraClient({ transport })
  client.auth.updateFromWhoAmI(whoAmI)
  return client
}

function nativeManifestForDebugLaunch(
  launch: AuroraDebugUiLaunch | null,
): NativeCapabilityManifest | 'unavailable' | null {
  if (!launch) return null
  const runtimeMode = launch.runtimeMode
  const nativePlatform = launch.nativePlatform ?? ''
  if (runtimeMode.startsWith('android') || nativePlatform === 'android') {
    return androidNativeCapabilityManifestFixture
  }
  if (runtimeMode.startsWith('ios') || nativePlatform === 'ios') {
    return iosNativeCapabilityManifestFixture
  }
  if (runtimeMode.startsWith('desktop')) {
    return nativeCapabilityManifestFixture
  }
  return 'unavailable'
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
}

function enabledUnlessExplicitlyFalse(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '')
}

function browserNotificationPort(): import('@aurora/ui').BrowserNotificationPort | null {
  if (typeof Notification === 'undefined') return null
  return {
    permission: Notification.permission,
    show(title, options) {
      return new Notification(title, options)
    },
  }
}

function browserFilePickerPort(): import('@aurora/ui').BrowserFilePickerPort | null {
  if (typeof window === 'undefined') return null
  const candidate = window as unknown as import('@aurora/ui').BrowserFilePickerPort
  return typeof candidate.showOpenFilePicker === 'function' ? candidate : null
}
