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
  activeThinConnectionProfile,
  createBrowserWebThinRuntime,
  emptyThinProfileDocument,
  explainBrowserThinRuntime,
  isThinConnectionProfileConfigured,
  sanitizeThinConnectionProfile,
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
      message: 'This Aurora thin client has not been configured. Complete first-run onboarding with an HTTP Gateway or Aurora WebRTC invite, or explicitly enable demo mode for labeled offline data.',
      method: request.method,
      busTopic: request.busTopic,
      detail: {
        demo_mode: false,
        secrets_redacted: true,
        repair_action: 'Configure a real Gateway URL, connect through a WebRTC invite, or opt into demo mode explicitly.'
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
  const profileDocument = credentialStore.loadThinProfileDocument() ?? emptyThinProfileDocument()
  const thinProfile = activeThinConnectionProfile(profileDocument)
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
  return browserCredentialStore?.loadThinProfileDocument() ?? emptyThinProfileDocument()
}

export function auroraBrowserThinProfile(): ThinConnectionProfile | undefined {
  return activeThinConnectionProfile(auroraBrowserThinProfileDocument())
}

export function auroraBrowserRequiresOnboarding(): boolean {
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

export async function selectAuroraBrowserThinProfile(
  profileId: string,
): Promise<void> {
  createAuroraBrowserRuntime()
  const store = browserCredentialStore
  if (!store) throw new Error('Browser thin-client persistence is unavailable')
  const current = store.loadThinProfileDocument() ?? emptyThinProfileDocument()
  if (!current.profiles.some((profile) => profile.id === profileId)) {
    throw new Error('Browser thin-client profile does not exist')
  }
  store.saveThinProfileDocument({
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
  const document = browserCredentialStore?.loadThinProfileDocument() ?? emptyThinProfileDocument()
  return JSON.stringify({
    document,
    demoMode: isBrowserDemoMode(),
    rolloutFlags: browserWebRtcRolloutFlags(),
  })
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
