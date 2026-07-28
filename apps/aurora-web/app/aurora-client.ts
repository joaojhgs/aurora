import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
} from '@aurora/client'
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

type BrowserRuntimeCache = {
  key: string
  runtime: BrowserWebThinRuntime
}

let browserRuntimeCache: BrowserRuntimeCache | null = null
let browserCredentialStore: BrowserPersistentPeerCredentialStore | null = null

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

export function createAuroraBrowserRuntime(): BrowserWebThinRuntime {
  const credentialStore = browserCredentialStore ?? new BrowserPersistentPeerCredentialStore()
  browserCredentialStore = credentialStore
  const profileDocument = credentialStore.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  const runtimeProfile = activeRuntimeProfile(profileDocument)
  const thinProfile = thinRuntimeProfileFromRuntimeProfile(runtimeProfile)
  const key = browserClientCacheKey()
  const cached = browserRuntimeCache
  if (cached?.key === key) return cached.runtime
  void browserRuntimeCache?.runtime.close().catch(() => undefined)
  const mode = thinProfile?.mode ?? 'http-only'
  const rolloutFlags = browserWebRtcRolloutFlags()
  const gatewayUrl = thinProfile?.gatewayUrl
  const persistedProfile = thinProfile
    ? thinProfile.webrtcProfile
    : credentialStore.loadConnectionProfile() ?? undefined
  const localStablePeerId = thinProfile?.localStablePeerId || credentialStore.getOrCreateLocalStablePeerId()
  const runtime = createBrowserWebThinRuntime({
    mode,
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
    ...(persistedProfile ? { profile: persistedProfile } : {}),
    ...(localStablePeerId ? { localStablePeerId } : {}),
    visibilityDocument: typeof document === 'undefined' ? undefined : document,
    windowLocation: typeof window === 'undefined' ? undefined : window.location,
    createClient: (transport) => new AuroraClient({ transport }),
    createDemoClient: () => new AuroraClient({ transport: new MockAuroraTransport() }),
  })
  if (persistedProfile && rolloutFlags.webrtc_thin_client) {
    queueMicrotask(() => {
      void runtime.peer.connect(persistedProfile).catch(() => undefined)
    })
  }
  browserRuntimeCache = { key, runtime }
  return runtime
}

export function createAuroraBrowserClient(): AuroraClient {
  return createAuroraBrowserRuntime().client
}

export function resetAuroraBrowserClientForTests(): void {
  void browserRuntimeCache?.runtime.close().catch(() => undefined)
  browserRuntimeCache = null
  browserCredentialStore = null
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
  const runtime = browserRuntimeCache?.runtime
  browserRuntimeCache = null
  browserCredentialStore = null
  await runtime?.close()
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
      enabledCapabilityPacks: [],
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
  const runtime = browserRuntimeCache?.runtime
  browserRuntimeCache = null
  browserCredentialStore = null
  await runtime?.close()
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
  const runtime = browserRuntimeCache?.runtime
  browserRuntimeCache = null
  browserCredentialStore = null
  await runtime?.close()
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

function browserClientCacheKey(): string {
  const document = browserCredentialStore?.loadRuntimeProfileDocument() ?? emptyRuntimeProfileDocument()
  return JSON.stringify({
    document,
    demoMode: isBrowserDemoMode(),
    rolloutFlags: browserWebRtcRolloutFlags(),
  })
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
