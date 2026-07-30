import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
} from '@aurora/client'
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
  runtime: AuroraBrowserRuntime
  meshNodeServices: BrowserMeshNodeServices | null
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
  readonly localNodeProviderStatus: AuroraBrowserLocalNodeProviderStatus
}

let browserRuntimeCache: BrowserRuntimeCache | null = null
let browserCredentialStore: BrowserPersistentPeerCredentialStore | null = null
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

export function createAuroraBrowserRuntime(): AuroraBrowserRuntime {
  return createAuroraBrowserRuntimeFromStore(null)
}

export async function createAuroraBrowserRuntimeAsync(): Promise<AuroraBrowserRuntime> {
  const credentialStore = browserCredentialStore ?? new BrowserPersistentPeerCredentialStore()
  browserCredentialStore = credentialStore
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
  return createAuroraBrowserRuntimeFromStore(meshNodeServices)
}

async function resolveBrowserMeshNodeServices(
  baseKey: string,
  createServices: () => Promise<BrowserMeshNodeServices>,
): Promise<BrowserMeshNodeServices | null> {
  const existing = browserMeshNodeCompositionInflight
  if (existing?.baseKey === baseKey) return await existing.promise
  if (existing) {
    void existing.promise
      .then((services) => services?.close())
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
    await services?.close().catch(() => undefined)
    return null
  }
  browserMeshNodeCompositionInflight = null
  return services
}

function createAuroraBrowserRuntimeFromStore(meshNodeServices: BrowserMeshNodeServices | null): AuroraBrowserRuntime {
  const credentialStore = browserCredentialStore ?? new BrowserPersistentPeerCredentialStore()
  browserCredentialStore = credentialStore
  const profileDocument = credentialStore.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  const runtimeProfile = activeRuntimeProfile(profileDocument)
  const thinProfile = thinRuntimeProfileFromRuntimeProfile(runtimeProfile)
  const baseKey = browserClientCacheKey(null)
  const key = browserClientCacheKey(meshNodeServices)
  const cached = browserRuntimeCache
  if (cached?.key === key) return cached.runtime
  if (meshNodeServices === null && cached?.meshNodeServices && cached.baseKey === baseKey) {
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
      effectiveMeshNodeServices?.close().catch(() => undefined),
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
  browserCredentialStore = null
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
  createAuroraBrowserRuntime()
  const runtimeDocument = browserCredentialStore?.loadRuntimeProfileDocument()
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
  createAuroraBrowserRuntime()
  return browserCredentialStore?.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
}

export function auroraBrowserRuntimeProfile(): AuroraRuntimeProfileV2 | undefined {
  return activeRuntimeProfile(auroraBrowserRuntimeProfileDocument())
}

export function auroraBrowserRequiresOnboarding(): boolean {
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
  createAuroraBrowserRuntime()
  const store = browserCredentialStore
  if (!store) throw new Error('Browser thin-client persistence is unavailable')
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
  await closeBrowserRuntimeCache()
  browserCredentialStore = null
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
  createAuroraBrowserRuntime()
  const store = browserCredentialStore
  if (!store) throw new Error('Browser runtime profile persistence is unavailable')
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
  await closeBrowserRuntimeCache()
  browserCredentialStore = null
}

export async function selectAuroraBrowserThinProfile(
  profileId: string,
): Promise<void> {
  createAuroraBrowserRuntime()
  const store = browserCredentialStore
  if (!store) throw new Error('Browser thin-client persistence is unavailable')
  const current = store.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  if (!current.profiles.some((profile) => profile.id === profileId)) {
    throw new Error('Browser runtime profile does not exist')
  }
  store.saveRuntimeProfileDocument({
    ...current,
    activeProfileId: profileId,
  })
  await closeBrowserRuntimeCache()
  browserCredentialStore = null
}

export function isAuroraWebDemoMode(): boolean {
  return isServerDemoMode() || isBrowserDemoMode()
}

export function auroraBrowserRuntimeDiagnostics(): string[] {
  const profile = auroraBrowserThinProfile()
  return explainBrowserThinRuntime({
    mode: profile?.mode,
    gatewayUrl: profile?.gatewayUrl,
    signalingUrl: profile?.signalingUrl,
    profile: profile?.webrtcProfile,
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
      .then((services) => services?.close())
      .catch(() => undefined),
  ])
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
