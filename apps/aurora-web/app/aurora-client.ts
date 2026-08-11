import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
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
  createBrowserWebThinRuntime,
  emptyThinProfileDocument,
  emptyRuntimeProfileDocument,
  explainBrowserThinRuntime,
  isRuntimeProfileConfigured,
  isThinConnectionProfileConfigured,
  runtimeProfileDocumentToThinDocument,
  runtimeProfileToThinConnectionProfile,
  sanitizeThinConnectionProfile,
  sanitizeRuntimeProfile,
  sanitizeRuntimeProfileDocument,
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

type BrowserRuntimeCache = {
  baseKey: string
  key: string
  localAssistant: AuroraBrowserLightweightAssistantConfig | null
  runtime: AuroraBrowserRuntime
  meshNodeServices: BrowserMeshNodeServices | null
}

const ASSISTANT_COMPLETION_ROUTE = '/api/assistant/completion'

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

type BrowserMeshNodeServicesFactory = (
  options: BrowserMeshNodeServicesOptions,
) => Promise<BrowserMeshNodeServices>

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
        baseUrl: gatewayUrl,
        bearerToken: process.env.AURORA_GATEWAY_TOKEN
      })
    })
  }
  if (isServerDemoMode()) {
    return new AuroraClient({ transport: new MockAuroraTransport() })
  }
  return new AuroraClient({ transport: new MissingGatewayTransport() })
}

export async function loadAuroraBrowserAssistantAvailability(): Promise<boolean> {
  try {
    const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const body = await response.json() as { enabled?: unknown }
    return body.enabled === true
  } catch {
    return false
  }
}

export function createAuroraBrowserAssistantProvider(): LightweightAssistantProvider {
  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      const response = await fetch(ASSISTANT_COMPLETION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

export function createAuroraBrowserRuntime(): AuroraBrowserRuntime {
  return createAuroraBrowserRuntimeFromStore(null)
}

export async function createAuroraBrowserRuntimeAsync({
  localAssistant = null,
}: {
  readonly localAssistant?: AuroraBrowserLightweightAssistantConfig | null | undefined
} = {}): Promise<AuroraBrowserRuntime> {
  if (browserRuntimeProfileTransition) await browserRuntimeProfileTransition
  const credentialStore = ensureBrowserCredentialStore()
  const profileRevision = browserRuntimeProfileRevision
  const profileDocument = credentialStore.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
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
  return createAuroraBrowserRuntimeFromStore(meshNodeServices, localAssistant)
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
): AuroraBrowserRuntime {
  const credentialStore = ensureBrowserCredentialStore()
  const profileDocument = credentialStore.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  const runtimeProfile = activeRuntimeProfile(profileDocument)
  const thinProfile = thinRuntimeProfileFromRuntimeProfile(runtimeProfile)
  const baseKey = browserClientCacheKey(null)
  const key = browserClientCacheKey(meshNodeServices)
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
    nodeRole: effectiveMeshNodeServices?.enabled ? 'mesh-node' : 'remote-console',
    enabledCapabilityPacks: runtimeProfile?.localNode.enabledCapabilityPacks ?? [],
    localSpeechPackState: runtimeProfile?.localNode.localSpeechPackState,
    gatewayUrl,
    bearerToken: () => runtime.client.auth.bearerToken(),
    signalingUrl: thinProfile?.signalingUrl,
    runtimeMode: 'web-thin',
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
    createClient: (transport) => new AuroraClient({ transport }),
    createDemoClient: () => new AuroraClient({ transport: new MockAuroraTransport() }),
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
  if (persistedProfile && rolloutFlags.webrtc_thin_client) {
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

export function auroraBrowserThinProfileDocument(): ThinProfileDocument {
  const runtimeDocument = ensureBrowserCredentialStore().loadRuntimeProfileDocument()
  if (!runtimeDocument) return emptyThinProfileDocument()
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
  return ensureBrowserCredentialStore().loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
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
      throw new Error('Browser thin-client room secret does not match the saved WebRTC profile')
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
    throw new Error('Browser mesh-node onboarding requires an Aurora WebRTC invite')
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
      throw new Error('Browser runtime profile room secret does not match the saved WebRTC profile')
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

function browserClientCacheKey(meshNodeServices: BrowserMeshNodeServices | null = null): string {
  const document = browserCredentialStore?.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  return JSON.stringify({
    document,
    demoMode: isBrowserDemoMode(),
    rolloutFlags: browserWebRtcRolloutFlags(),
    meshNodeServices: meshNodeServices
      ? {
        enabled: meshNodeServices.enabled,
        storageBackendKind: meshNodeServices.storageBackendKind,
        registeredToolIds: meshNodeServices.registeredToolIds,
      }
      : null,
  })
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
  }
}

function isServerDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.AURORA_WEB_DEMO_MODE)
}

function isBrowserDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE)
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
