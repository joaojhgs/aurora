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
  createBrowserWebThinRuntime,
  explainBrowserThinRuntime,
  type AuroraWebRtcRolloutFlags,
  type AuroraThinConnectionMode,
  type BrowserWebThinRuntime,
} from '@aurora/ui'

type BrowserRuntimeCache = {
  key: string
  runtime: BrowserWebThinRuntime
}

let browserRuntimeCache: BrowserRuntimeCache | null = null

class MissingGatewayTransport implements AuroraTransport {
  readonly kind = 'http'

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    throw new AuroraError({
      code: 'transport_loss',
      message: 'Aurora Gateway URL is not configured. Set AURORA_GATEWAY_URL/NEXT_PUBLIC_AURORA_GATEWAY_URL, paste a WebRTC invite with NEXT_PUBLIC_AURORA_CONNECTION_MODE=webrtc-only|webrtc-preferred, or explicitly enable AURORA_WEB_DEMO_MODE=1 for labeled offline demo data.',
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
  const key = browserClientCacheKey()
  const cached = browserRuntimeCache
  if (cached?.key === key) return cached.runtime
  void browserRuntimeCache?.runtime.close().catch(() => undefined)
  const mode = browserConnectionMode()
  const rolloutFlags = browserWebRtcRolloutFlags()
  const gatewayUrl = process.env.NEXT_PUBLIC_AURORA_GATEWAY_URL
  const credentialStore = mode === 'http-only' || !rolloutFlags.webrtc_thin_client
    ? undefined
    : new BrowserPersistentPeerCredentialStore()
  const persistedProfile = credentialStore?.loadConnectionProfile() ?? undefined
  const localStablePeerId = credentialStore?.getOrCreateLocalStablePeerId()
  const runtime = createBrowserWebThinRuntime({
    mode,
    gatewayUrl,
    bearerToken: () => runtime.client.auth.bearerToken(),
    runtimeMode: browserRuntimeMode(),
    demoMode: isBrowserDemoMode(),
    rolloutFlags,
    allowInsecureLoopback: truthy(process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK),
    allowInsecureLoopbackSignaling: truthy(process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK),
    nodeName: process.env.NEXT_PUBLIC_AURORA_NODE_NAME ?? 'Aurora Web thin client',
    ...(credentialStore ? { credentialStore } : {}),
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
}

export function isAuroraWebDemoMode(): boolean {
  return isServerDemoMode() || isBrowserDemoMode()
}

export function auroraBrowserRuntimeDiagnostics(): string[] {
  return explainBrowserThinRuntime({
    mode: browserConnectionMode(),
    gatewayUrl: process.env.NEXT_PUBLIC_AURORA_GATEWAY_URL,
    rolloutFlags: browserWebRtcRolloutFlags(),
  })
}

function browserClientCacheKey(): string {
  return JSON.stringify({
    gatewayUrl: process.env.NEXT_PUBLIC_AURORA_GATEWAY_URL ?? '',
    mode: browserConnectionMode(),
    demoMode: isBrowserDemoMode(),
    nodeName: process.env.NEXT_PUBLIC_AURORA_NODE_NAME ?? '',
    rolloutFlags: browserWebRtcRolloutFlags(),
  })
}

function browserConnectionMode(): AuroraThinConnectionMode {
  const value = process.env.NEXT_PUBLIC_AURORA_CONNECTION_MODE
  if (value === 'http-only' || value === 'webrtc-only' || value === 'webrtc-preferred') return value
  return 'http-only'
}

function browserRuntimeMode(): string {
  const mode = browserConnectionMode()
  if (mode === 'http-only') return 'web'
  return 'web-thin'
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
