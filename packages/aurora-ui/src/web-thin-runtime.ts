import {
  AuroraClient,
  AuroraError,
  type AuroraEventSubscription,
  type AuroraStreamRequest,
  type AuroraTransport,
  type HttpTransportOptions,
  type JsonObject,
} from '@aurora/client'
import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  MemoryPeerCredentialStore,
  createBrowserWebRtcAuroraRuntime,
  type BrowserWebRtcRuntime,
  type BrowserWebRtcRuntimeOptions,
  type MeshPeerCredentialRecord,
  type WebRtcPeerCredentialStore,
  type PeerConnectionController,
  type PeerConnectionSnapshot,
  type PeerPairingApproval,
  type WebRtcPeerConnectionProfile,
  type WebRtcPeerHost,
} from '@aurora/client/webrtc'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import { LocalNodeLifecycleController } from './local-node-lifecycle'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { AuroraCapabilityPack } from './runtime-profile'
import type { BrowserPeerPersistenceStatus, BrowserWebRtcCredentialStore } from './browser-peer-persistence'
export type { AuroraThinConnectionMode } from './connection-mode'
import type { AuroraThinConnectionMode } from './connection-mode'

export type BrowserWebRtcStatus =
  | 'idle'
  | 'disabled'
  | 'needs-secure-context'
  | 'needs-invite'
  | 'connecting'
  | 'pairing'
  | 'authorized'
  | 'fallback-http'
  | 'closed'
  | 'failed'

export interface AuroraWebRtcRolloutFlags {
  webrtc_thin_client: boolean
  webrtc_scoped_subscriptions: boolean
  webrtc_fragmentation: boolean
  webrtc_app_layer_e2ee: boolean
  mesh_node_runtime_v1: boolean
  local_tool_provider_v1: boolean
  lightweight_orchestrator_v1: boolean
}

export const DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS: Readonly<AuroraWebRtcRolloutFlags> = Object.freeze({
  webrtc_thin_client: true,
  webrtc_scoped_subscriptions: true,
  webrtc_fragmentation: true,
  webrtc_app_layer_e2ee: true,
  mesh_node_runtime_v1: true,
  local_tool_provider_v1: true,
  lightweight_orchestrator_v1: true,
})

export interface BrowserThinRuntimeConfig {
  mode?: AuroraThinConnectionMode | null | undefined
  gatewayUrl?: string | null | undefined
  signalingUrl?: string | null | undefined
  bearerToken?: string | (() => string | null | undefined) | null | undefined
  inviteText?: string | null | undefined
  profile?: WebRtcPeerConnectionProfile | null | undefined
  runtimeMode?: string | null | undefined
  nodeRole?: 'remote-console' | 'mesh-node' | null | undefined
  enabledCapabilityPacks?: readonly AuroraCapabilityPack[] | null | undefined
  localSpeechPackState?: AuroraSurfaceProfile['localSpeechPack']['state'] | null | undefined
  peerHost?: WebRtcPeerHost | undefined
  peerAuthorityResolver?: BrowserWebRtcRuntimeOptions['peerAuthorityResolver'] | undefined
  peerPairingIssuer?: BrowserWebRtcRuntimeOptions['peerPairingIssuer'] | undefined
  nativePlatform?: string | null | undefined
  userAgent?: string | null | undefined
  nodeName?: string | null | undefined
  localStablePeerId?: string | null | undefined
  demoMode?: boolean | undefined
  rolloutFlags?: Partial<AuroraWebRtcRolloutFlags> | undefined
  production?: boolean | undefined
  allowInsecureLoopbackSignaling?: boolean | undefined
  allowInsecureLoopback?: boolean | undefined
  fetchImpl?: typeof fetch | undefined
  eventSourceFactory?: HttpTransportOptions['eventSourceFactory']
  webSocketFactory?: HttpTransportOptions['webSocketFactory']
  peerConnectionFactory?: BrowserWebRtcRuntimeOptions['createPeerConnection']
  createPeerConnection?: BrowserWebRtcRuntimeOptions['createPeerConnection']
  signalingFactory?: BrowserWebRtcRuntimeOptions['signalingFactory']
  randomId?: () => string
  random?: () => number
  scryptDeriver?: BrowserWebRtcRuntimeOptions['scryptDeriver']
  scryptWorkerFactory?: BrowserWebRtcRuntimeOptions['scryptWorkerFactory']
  initialCredentials?: MeshPeerCredentialRecord[] | undefined
  credentialStore?: WebRtcPeerCredentialStore & Partial<BrowserWebRtcCredentialStore>
  visibilityDocument?: BrowserWebRtcRuntimeOptions['visibilityDocument']
  windowLocation?: BrowserWebRtcRuntimeOptions['windowLocation']
  createClient?: (transport: AuroraTransport) => AuroraClient
  createDemoClient?: () => AuroraClient
}

export type BrowserThinNodeRole = NonNullable<BrowserThinRuntimeConfig['nodeRole']>

export interface BrowserWebThinRuntime {
  client: AuroraClient
  peer: BrowserWebRtcPeerController
  surface: AuroraSurfaceProfile
  mode: AuroraThinConnectionMode
  features: BrowserRuntimeFeatureState
  close(): Promise<void>
}

export interface BrowserRuntimeFeatureState {
  requestedNodeRole: BrowserThinNodeRole
  activeNodeRole: BrowserThinNodeRole
  meshNodeRuntimeEnabled: boolean
  localToolProviderEnabled: boolean
  lightweightOrchestratorEnabled: boolean
  /** Voice ownership is derived from the centralized surface profile. */
  usesBrowserVoiceRuntime: boolean
  focusedPushToTalkOwner: AuroraSurfaceProfile['voiceCapture']['focusedPushToTalkOwner']
  wakewordOwner: AuroraSurfaceProfile['voiceCapture']['wakewordOwner']
  localSpeechPack: AuroraSurfaceProfile['localSpeechPack']
}

export interface BrowserWebRtcSnapshot extends PeerConnectionSnapshot {
  status: BrowserWebRtcStatus
  fallbackReason?: string | undefined
  diagnostic?: string | undefined
  pairingSessionId?: string | undefined
  pairingVerificationCode?: string | undefined
  secureContext: boolean
  visible: boolean
  focused: boolean
  hasHttpFallback: boolean
  secretsPersisted: boolean
  persistenceBackend?: BrowserPeerPersistenceStatus['backend'] | 'platform-keychain' | 'memory'
  persistenceFallbackReason?: string | undefined
}

type BrowserSnapshotListener = (snapshot: BrowserWebRtcSnapshot) => void
type SelectedCandidatePairEvidence = Awaited<ReturnType<PeerConnectionController['getSelectedCandidatePairEvidence']>>
type LocalProviderLifecyclePort = {
  resumeLocalProvider(): void | Promise<void>
  renewLocalProvider(): void | Promise<void>
  suspendLocalProvider(reason?: string): void | Promise<void>
}

const DEFAULT_MODE: AuroraThinConnectionMode = 'http-only'
const CONNECTION_UNAVAILABLE_COPY = 'Could not connect to this Aurora device. Try again from Connection settings.'
const INVITE_REQUIRED_COPY = 'Add a valid Aurora invite before connecting.'
const SECURE_CONTEXT_REQUIRED_COPY = 'Open Aurora from a secure page, localhost, or the desktop app before joining.'
const INVITE_UNAVAILABLE_COPY = 'This device cannot use an invite right now.'
const INVITE_INCOMPLETE_COPY = 'This invite is incomplete. Create a new Aurora invite and try again.'
const CLIENT_SETUP_INCOMPLETE_COPY = 'Aurora could not finish setup.'
const REQUEST_TIMEOUT_COPY = 'Aurora request timed out. Try again.'
const SAVED_ADDRESS_CONNECTED_COPY = 'Connected with the saved address.'

/** A saved thin profile keeps WebRTC enabled even while its peer is offline. */
export function isBrowserWebRtcConfigured(
  snapshot: BrowserWebRtcSnapshot | null | undefined,
): snapshot is BrowserWebRtcSnapshot {
  return Boolean(
    snapshot
    && snapshot.connectionMode !== 'http-only'
    && snapshot.status !== 'disabled'
    && snapshot.status !== 'needs-invite'
    && snapshot.expectedStablePeerId,
  )
}

export function isBrowserWebRtcConnected(
  snapshot: BrowserWebRtcSnapshot | null | undefined,
): boolean {
  return Boolean(snapshot && snapshot.status === 'authorized')
}

export function createBrowserWebThinRuntime(config: BrowserThinRuntimeConfig = {}): BrowserWebThinRuntime {
  const mode = normalizeConnectionMode(config.mode)
  const rolloutFlags = normalizeAuroraWebRtcRolloutFlags(config.rolloutFlags)
  const requestedNodeRole = config.nodeRole ?? 'remote-console'
  const http = httpOptionsFromConfig(config)
  const webrtcDisabled = mode !== 'http-only' && !rolloutFlags.webrtc_thin_client
  const rollbackHttp = webrtcDisabled && mode === 'webrtc-preferred' ? http : null
  const activeNodeRole = resolveActiveNodeRole(requestedNodeRole)
  const webrtcRuntimeAvailable = !webrtcDisabled
  const meshNodeRuntimeEnabled =
    webrtcRuntimeAvailable
    && activeNodeRole === 'mesh-node'
    && rolloutFlags.mesh_node_runtime_v1
  const localToolProviderEnabled = meshNodeRuntimeEnabled && rolloutFlags.local_tool_provider_v1
  const surface = getAuroraSurfaceProfile({
    runtimeMode: config.runtimeMode ?? (mode === 'http-only' ? 'web' : 'web-thin'),
    transportKind: mode === 'http-only' || rollbackHttp ? 'http' : 'mesh',
    nativePlatform: config.nativePlatform,
    userAgent: config.userAgent ?? browserUserAgent(),
    nodeMode: activeNodeRole,
    runtimeTier: meshNodeRuntimeEnabled ? 'lightweight-ts' : 'none',
    enabledCapabilityPacks: config.enabledCapabilityPacks,
    localSpeechPackState: config.localSpeechPackState,
  })
  const features: BrowserRuntimeFeatureState = Object.freeze({
    requestedNodeRole,
    activeNodeRole,
    meshNodeRuntimeEnabled,
    localToolProviderEnabled,
    lightweightOrchestratorEnabled:
      meshNodeRuntimeEnabled && rolloutFlags.lightweight_orchestrator_v1,
    usesBrowserVoiceRuntime: surface.voiceCapture.usesBrowserVoiceRuntime,
    focusedPushToTalkOwner: surface.voiceCapture.focusedPushToTalkOwner,
    wakewordOwner: surface.voiceCapture.wakewordOwner,
    localSpeechPack: surface.localSpeechPack,
  })
  const securityContext: BrowserRuntimeSecurityContext = {
    ...config,
    trustsNativeWebViewOrigin: surface.trustsNativeWebViewOrigin,
  }
  if (webrtcDisabled) {
    const disabled = new AuroraError({
      code: 'unsupported_feature',
      message: INVITE_UNAVAILABLE_COPY,
    })
    const rollbackRuntime = rollbackHttp
      ? createBrowserWebRtcAuroraRuntime<AuroraClient>({
          mode: 'http-only',
          http: rollbackHttp,
          mapClientTransport: productSafeTransport,
          ...(config.createClient ? { createClient: config.createClient } : {}),
          ...(config.visibilityDocument ? { visibilityDocument: config.visibilityDocument } : {}),
        })
      : null
    const peer = new BrowserWebRtcPeerController(null, mode, {
      httpFallback: Boolean(rollbackHttp),
      disabledReason: disabled.message,
      credentialStore: config.credentialStore,
      config: securityContext,
      visibilityDocument: config.visibilityDocument,
    })
    return {
      client: rollbackRuntime
        ? rollbackRuntime.client
        : clientFromFactory(config, new FailingTransport(disabled, mode)),
      peer,
      surface,
      mode,
      features,
      async close() {
        await peer.disconnect('runtime closed')
        await rollbackRuntime?.close()
      },
    }
  }
  const credentialStore: NonNullable<BrowserThinRuntimeConfig['credentialStore']> =
    config.credentialStore ?? new MemoryOnlyWebRtcCredentialStore()
  const parsedInvite = config.profile ? null : parseWebRtcInvite(config.inviteText, config)
  const activeProfile = config.profile ?? parsedInvite?.profile ?? credentialStore.loadConnectionProfile?.() ?? null
  if (parsedInvite) {
    if (credentialStore.setRoomSecret) credentialStore.setRoomSecret(parsedInvite.profile.roomSecretRef, parsedInvite.roomSecret)
    else if (!credentialStore.getRoomSecret) throw new AuroraError({ code: 'validation', message: INVITE_INCOMPLETE_COPY })
    credentialStore.saveConnectionProfile?.(parsedInvite.profile)
  }
  const localStablePeerId = config.localStablePeerId ?? credentialStore.getOrCreateLocalStablePeerId?.()

  let sdkRuntime: BrowserWebRtcRuntime<AuroraClient>
  try {
    sdkRuntime = createBrowserWebRtcAuroraRuntime<AuroraClient>({
      mode,
      nodeRole: activeNodeRole,
      ...(http ? { http } : {}),
      ...(activeProfile ? { profile: activeProfile } : {}),
      ...(localToolProviderEnabled && config.peerHost ? { peerHost: config.peerHost } : {}),
      ...(localToolProviderEnabled && config.peerAuthorityResolver ? { peerAuthorityResolver: config.peerAuthorityResolver } : {}),
      ...(localToolProviderEnabled && config.peerPairingIssuer ? { peerPairingIssuer: config.peerPairingIssuer } : {}),
      credentialStore,
      ...(config.initialCredentials ? { initialCredentials: config.initialCredentials } : {}),
      ...(localStablePeerId ? { localStablePeerId } : {}),
      localNodeName: config.nodeName ?? activeProfile?.nodeName ?? 'Aurora Web thin client',
      allowInsecureLoopback: Boolean(
        config.allowInsecureLoopback
        || config.allowInsecureLoopbackSignaling
        || surface.trustsNativeWebViewOrigin
        || isSecureBrowserContext(config.windowLocation)
      ),
      ...(config.peerConnectionFactory ?? config.createPeerConnection ? { createPeerConnection: config.peerConnectionFactory ?? config.createPeerConnection } : {}),
      ...(config.signalingFactory ? { signalingFactory: config.signalingFactory } : {}),
      ...(config.randomId ? { randomId: config.randomId } : {}),
      ...(config.random ? { random: config.random } : {}),
      ...(config.scryptDeriver ? { scryptDeriver: config.scryptDeriver } : {}),
      ...(config.scryptWorkerFactory ? { scryptWorkerFactory: config.scryptWorkerFactory } : {}),
      localProtocolCapabilities: localProtocolCapabilities(rolloutFlags, activeNodeRole),
      appLayerE2eeAllowed: rolloutFlags.webrtc_app_layer_e2ee,
      ...(config.visibilityDocument ? { visibilityDocument: config.visibilityDocument } : {}),
      ...(config.windowLocation ? { windowLocation: config.windowLocation } : {}),
      mapClientTransport: productSafeTransport,
      ...(config.createClient ? { createClient: config.createClient } : {}),
    })
  } catch (error) {
    if (mode === 'http-only' && config.demoMode) {
      const unavailable = new BrowserWebRtcPeerController(null, mode, {
        httpFallback: false,
        creationError: error,
        config: securityContext,
        visibilityDocument: config.visibilityDocument,
      })
      return { client: demoClientFromFactory(config), peer: unavailable, surface, mode, features, close: () => unavailable.disconnect('runtime closed') }
    }
    const unavailable = new BrowserWebRtcPeerController(null, mode, {
      httpFallback: false,
      creationError: error,
      credentialStore,
      config: securityContext,
      visibilityDocument: config.visibilityDocument,
    })
    return {
      client: clientFromFactory(config, new FailingTransport(error, mode)),
      peer: unavailable,
      surface,
      mode,
      features,
      async close() {
        await unavailable.disconnect('runtime closed')
        await credentialStore.close()
      }
    }
  }

  const peer = new BrowserWebRtcPeerController(sdkRuntime.peer, mode, {
    httpFallback: Boolean(http),
    credentialStore,
    config: securityContext,
    visibilityDocument: config.visibilityDocument,
  })
  const localProviderLifecycle = config.peerHost as (WebRtcPeerHost & LocalProviderLifecyclePort) | undefined
  const lifecycle = localToolProviderEnabled && localProviderLifecycle
    ? new LocalNodeLifecycleController({
        host: {
          resume: () => localProviderLifecycle.resumeLocalProvider(),
          renew: () => localProviderLifecycle.renewLocalProvider(),
          suspend: (reason?: string) => localProviderLifecycle.suspendLocalProvider(reason),
        },
        ...(config.visibilityDocument ? { document: config.visibilityDocument } : {}),
      })
    : null
  lifecycle?.start()
  return {
    client: sdkRuntime.client,
    peer,
    surface,
    mode,
    features,
    async close() {
      lifecycle?.stop()
      await peer.disconnect('runtime closed')
      await sdkRuntime.close()
    },
  }
}

export function webRtcProfileFromInvite(
  inviteText: string | null | undefined,
  config: Pick<BrowserThinRuntimeConfig, 'production' | 'allowInsecureLoopbackSignaling' | 'nodeName' | 'signalingUrl'> = {}
): WebRtcPeerConnectionProfile | null {
  return parseWebRtcInvite(inviteText, config)?.profile ?? null
}

export function explainBrowserThinRuntime(config: BrowserThinRuntimeConfig = {}): string[] {
  const mode = normalizeConnectionMode(config.mode)
  const rolloutFlags = normalizeAuroraWebRtcRolloutFlags(config.rolloutFlags)
  const requestedNodeRole = config.nodeRole ?? 'remote-console'
  const webrtcDisabled = mode !== 'http-only' && !rolloutFlags.webrtc_thin_client
  const rollbackHttp = webrtcDisabled && mode === 'webrtc-preferred' ? httpOptionsFromConfig(config) : null
  const activeNodeRole = resolveActiveNodeRole(requestedNodeRole)
  const webrtcRuntimeAvailable = !webrtcDisabled
  const meshNodeRuntimeEnabled =
    webrtcRuntimeAvailable
    && activeNodeRole === 'mesh-node'
    && rolloutFlags.mesh_node_runtime_v1
  const surface = getAuroraSurfaceProfile({
    runtimeMode: config.runtimeMode ?? (mode === 'http-only' ? 'web' : 'web-thin'),
    transportKind: mode === 'http-only' || rollbackHttp ? 'http' : 'mesh',
    nativePlatform: config.nativePlatform,
    userAgent: config.userAgent ?? browserUserAgent(),
    nodeMode: activeNodeRole,
    runtimeTier: meshNodeRuntimeEnabled ? 'lightweight-ts' : 'none',
    enabledCapabilityPacks: config.enabledCapabilityPacks,
    localSpeechPackState: config.localSpeechPackState,
  })
  const invite = config.inviteText ? decodeMeshInvite(config.inviteText) : null
  const summary = invite ? meshInviteSummary(invite) : null
  const notes = [`mode=${mode}`]
  if (config.gatewayUrl) notes.push('http endpoint configured')
  if (config.signalingUrl) notes.push('signaling endpoint configured')
  if (webrtcDisabled) notes.push('WebRTC disabled by webrtc_thin_client rollout flag; HTTP/local modes remain available')
  if (mode !== 'http-only' && !rolloutFlags.webrtc_scoped_subscriptions) notes.push('scoped WebRTC subscriptions disabled by rollout flag')
  if (mode !== 'http-only' && !rolloutFlags.webrtc_fragmentation) notes.push('WebRTC fragmentation/backpressure disabled by rollout flag')
  if (mode !== 'http-only' && !rolloutFlags.webrtc_app_layer_e2ee) notes.push('application-layer WebRTC E2EE disabled by rollout flag; profiles requiring it fail closed')
  if (requestedNodeRole === 'mesh-node' && !rolloutFlags.mesh_node_runtime_v1) notes.push('mesh-node implementation disabled by rollout flag')
  if (requestedNodeRole === 'mesh-node' && !rolloutFlags.local_tool_provider_v1) notes.push('local tool provider disabled by rollout flag')
  if (requestedNodeRole === 'mesh-node' && !rolloutFlags.lightweight_orchestrator_v1) notes.push('lightweight orchestrator disabled by rollout flag')
  if (summary) notes.push(`invite room=${summary.room}; brokers=${summary.brokerCount}; secret=${summary.includesPassword ? 'provided' : 'missing'}`)
  if (
    mode !== 'http-only'
    && typeof window !== 'undefined'
    && !isSecureBrowserContext(
      config.windowLocation,
      surface.trustsNativeWebViewOrigin,
    )
  ) {
    notes.push('blocked: secure context required')
  }
  if (mode === 'webrtc-only' && !summary && !config.profile) notes.push('blocked: invite/profile required')
  return notes
}

function resolveActiveNodeRole(
  requestedNodeRole: BrowserThinNodeRole,
): BrowserThinNodeRole {
  return requestedNodeRole
}

export class BrowserWebRtcPeerController implements PeerConnectionController {
  private readonly listeners = new Set<BrowserSnapshotListener>()
  private readonly peer: PeerConnectionController | null
  private readonly mode: AuroraThinConnectionMode
  private readonly httpFallback: boolean
  private readonly creationError: unknown
  private readonly disabledReason: string | undefined
  private readonly credentialStore: BrowserThinRuntimeConfig['credentialStore']
  private readonly config: BrowserRuntimeSecurityContext
  private sdkSnapshot: PeerConnectionSnapshot | null = null
  private fallbackReason: string | undefined
  private visibilityDiagnostic: string | undefined
  private connectionDiagnostic: string | undefined
  private attemptedConnect = false
  private authorizedRouteSeen = false
  private disconnected = false
  private readonly pairingCacheTtlMs = 65_000
  private pendingPairingCache: { sessionId?: string; verificationCode?: string; cachedAt: number } | null = null
  private unsubscribe: (() => void) | undefined
  private removeVisibilityListeners: (() => void) | undefined
  private readonly visibilityDocument: BrowserThinRuntimeConfig['visibilityDocument']

  constructor(peer: PeerConnectionController | null, mode: AuroraThinConnectionMode, options: { httpFallback: boolean; creationError?: unknown; disabledReason?: string; credentialStore?: BrowserThinRuntimeConfig['credentialStore']; config?: BrowserRuntimeSecurityContext; visibilityDocument?: BrowserThinRuntimeConfig['visibilityDocument'] }) {
    this.peer = peer
    this.mode = mode
    this.httpFallback = options.httpFallback
    this.creationError = options.creationError
    this.disabledReason = options.disabledReason
    this.credentialStore = options.credentialStore
    this.config = options.config ?? {}
    this.visibilityDocument = options.visibilityDocument
    if (peer) this.unsubscribe = peer.subscribe((snapshot) => {
      this.sdkSnapshot = snapshot
      if (snapshot.state === 'authorized') this.authorizedRouteSeen = true
      this.emit()
    })
    this.installVisibilityPolicy(options.visibilityDocument)
  }

  snapshot(): BrowserWebRtcSnapshot {
    const sdk = this.peer?.snapshot() ?? this.sdkSnapshot ?? null
    const diagnostic = this.connectionDiagnostic ?? this.visibilityDiagnostic ?? this.disabledReason ?? diagnosticFromSnapshot(sdk) ?? diagnosticFromError(this.creationError)
    const snapshotPairing = pendingPairingFromSnapshot(sdk)
    if (snapshotPairing) {
      this.pendingPairingCache = {
        cachedAt: Date.now(),
      }
      if (snapshotPairing.sessionId) this.pendingPairingCache.sessionId = snapshotPairing.sessionId
      if (snapshotPairing.verificationCode) this.pendingPairingCache.verificationCode = snapshotPairing.verificationCode
    } else if (sdk?.state) {
      const staleCache = this.pendingPairingCache && Date.now() - this.pendingPairingCache.cachedAt > this.pairingCacheTtlMs
      if (staleCache || sdk.state === 'authorized') {
        this.pendingPairingCache = null
      }
    }
    const pendingPairing = snapshotPairing ?? this.pendingPairingCache
    const persistence = this.credentialStore?.persistenceStatus?.()
    const out: BrowserWebRtcSnapshot = {
      state: sdk?.state ?? (this.disconnected ? 'closed' : this.creationError ? 'failed' : 'idle'),
      connectionMode: this.mode,
      icePathCategory: sdk?.icePathCategory ?? 'unknown',
      protocolCapabilities: sdk?.protocolCapabilities ?? [],
      reconnectCount: sdk?.reconnectCount ?? 0,
      pendingCallCount: sdk?.pendingCallCount ?? 0,
      pendingStreamCount: sdk?.pendingStreamCount ?? 0,
      pendingSubscriptionCount: sdk?.pendingSubscriptionCount ?? 0,
      pendingFragmentCount: sdk?.pendingFragmentCount ?? 0,
      bufferPressureHighWaterBytes: sdk?.bufferPressureHighWaterBytes ?? 0,
      sentFragmentCount: sdk?.sentFragmentCount ?? 0,
      receivedFragmentCount: sdk?.receivedFragmentCount ?? 0,
      updatedAt: sdk?.updatedAt ?? new Date().toISOString(),
      status: statusFromSnapshot(sdk, this.mode, this.creationError, this.disabledReason, this.fallbackReason, this.disconnected, this.attemptedConnect),
      secureContext: isSecureBrowserContext(
        this.config.windowLocation,
        this.config.trustsNativeWebViewOrigin,
      ),
      visible: this.visibilityDocument
        ? this.visibilityDocument.visibilityState !== 'hidden'
        : typeof document === 'undefined' || document.visibilityState !== 'hidden',
      focused: typeof document === 'undefined' || document.hasFocus(),
      hasHttpFallback: this.httpFallback,
      secretsPersisted: persistence?.secretsPersisted ?? false,
      persistenceBackend: persistence?.backend ?? 'memory',
    }
    if (sdk?.expectedStablePeerId !== undefined) out.expectedStablePeerId = sdk.expectedStablePeerId
    if (sdk?.connectedStablePeerId !== undefined) out.connectedStablePeerId = sdk.connectedStablePeerId
    if (sdk?.connectedSignalingPeerId !== undefined) out.connectedSignalingPeerId = sdk.connectedSignalingPeerId
    if (sdk?.nodeName !== undefined) out.nodeName = sdk.nodeName
    if (sdk?.selectedSignalingBrokerOrigin !== undefined) out.selectedSignalingBrokerOrigin = sdk.selectedSignalingBrokerOrigin
    if (sdk?.lastRedactedError !== undefined) out.lastRedactedError = sdk.lastRedactedError
    if (this.fallbackReason !== undefined) out.fallbackReason = this.fallbackReason
    if (diagnostic !== undefined) out.diagnostic = diagnostic
    if (pendingPairing?.sessionId !== undefined) out.pairingSessionId = pendingPairing.sessionId
    if (pendingPairing?.verificationCode !== undefined) out.pairingVerificationCode = pendingPairing.verificationCode
    if (persistence?.fallbackReason !== undefined) out.persistenceFallbackReason = persistence.fallbackReason
    return out
  }

  subscribe(listener: BrowserSnapshotListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  importInvite(inviteText: string): WebRtcPeerConnectionProfile {
    if (this.disabledReason) throw new AuroraError({ code: 'unsupported_feature', message: this.disabledReason })
    const parsed = parseWebRtcInvite(inviteText, this.config)
    if (!parsed) throw new AuroraError({ code: 'validation', message: INVITE_REQUIRED_COPY })
    if (this.credentialStore?.setRoomSecret) this.credentialStore.setRoomSecret(parsed.profile.roomSecretRef, parsed.roomSecret)
    this.credentialStore?.saveConnectionProfile?.(parsed.profile)
    return parsed.profile
  }

  async connect(profile?: WebRtcPeerConnectionProfile): Promise<void> {
    if (this.disabledReason) throw new AuroraError({ code: 'unsupported_feature', message: this.disabledReason })
    if (!this.peer) throw new AuroraError({ code: 'unavailable_service', message: productDiagnosticFromError(this.creationError) ?? CONNECTION_UNAVAILABLE_COPY })
    this.fallbackReason = undefined
    this.connectionDiagnostic = undefined
    this.attemptedConnect = true
    this.disconnected = false
    if (profile !== undefined) this.credentialStore?.saveConnectionProfile?.(profile)
    try {
      await this.peer.connect(profile as WebRtcPeerConnectionProfile)
    } catch (error) {
      this.connectionDiagnostic = productDiagnosticFromError(error) ?? CONNECTION_UNAVAILABLE_COPY
      this.emit()
      throw productSafeAuroraError(error)
    }
  }

  isFallbackEligibleAfterWebRtcRoute(error: unknown): boolean {
    if (!this.attemptedConnect || !this.authorizedRouteSeen) return false
    if (error instanceof AuroraError && (error.code === 'transport_loss' || error.code === 'timeout')) return true
    const diagnostic = this.sdkSnapshot?.lastRedactedError
    return Boolean(diagnostic && /transport[_-]?(loss|unavailable)|webrtc[_-]?transport[_-]?unavailable/i.test(`${diagnostic.code} ${diagnostic.message}`))
  }

  async confirmPairing(sessionId: string, approval?: PeerPairingApproval): Promise<void> {
    if (!this.peer) throw new AuroraError({ code: 'unavailable_service', message: CONNECTION_UNAVAILABLE_COPY })
    await this.peer.confirmPairing(sessionId, approval)
    if (this.pendingPairingCache?.sessionId === sessionId) this.pendingPairingCache = null
  }

  async rejectPairing(sessionId: string): Promise<void> {
    if (!this.peer) return
    await this.peer.rejectPairing(sessionId)
    if (this.pendingPairingCache?.sessionId === sessionId) this.pendingPairingCache = null
  }

  async getSelectedCandidatePairEvidence(): Promise<SelectedCandidatePairEvidence> {
    if (!this.peer) return emptySelectedCandidatePairEvidence()
    return await this.peer.getSelectedCandidatePairEvidence()
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    this.disconnected = true
    if (reason === 'runtime closed') {
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.removeVisibilityListeners?.()
      this.removeVisibilityListeners = undefined
      this.pendingPairingCache = null
    }
    await this.peer?.disconnect(reason)
    if (reason === 'runtime closed') await this.credentialStore?.close()
    this.emit()
  }

  markFallback(reason: string): void {
    this.fallbackReason = reason ? SAVED_ADDRESS_CONNECTED_COPY : undefined
    this.emit()
  }

  private installVisibilityPolicy(visibilityDocument: BrowserThinRuntimeConfig['visibilityDocument']): void {
    if (this.mode === 'http-only' || !this.peer) return
    const doc = visibilityDocument ?? (typeof document === 'undefined' ? undefined : document)
    const updateVisibility = () => {
      const hidden = doc?.visibilityState === 'hidden'
      const blurred = typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()
      this.visibilityDiagnostic = hidden
        ? 'Connection continues while this page is in the background. Some updates may wait until you return.'
        : blurred
          ? 'Connection continues while this page is not active. Some updates may wait until you return.'
          : undefined
      this.emit()
    }
    doc?.addEventListener('visibilitychange', updateVisibility)
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', updateVisibility)
      window.addEventListener('focus', updateVisibility)
    }
    this.removeVisibilityListeners = () => {
      doc?.removeEventListener('visibilitychange', updateVisibility)
      if (typeof window !== 'undefined') {
        window.removeEventListener('blur', updateVisibility)
        window.removeEventListener('focus', updateVisibility)
      }
    }
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
  }
}

class MemoryOnlyWebRtcCredentialStore extends MemoryPeerCredentialStore {
  private readonly roomSecrets = new Map<string, Uint8Array>()

  setRoomSecret(ref: string, value: string): void {
    this.roomSecrets.set(ref, new TextEncoder().encode(value))
  }

  async getRoomSecret(ref: string): Promise<Uint8Array | null> {
    const value = this.roomSecrets.get(ref)
    return value ? new Uint8Array(value) : null
  }

  override async close(): Promise<void> {
    for (const value of this.roomSecrets.values()) value.fill(0)
    this.roomSecrets.clear()
    await super.close()
  }
}

class FailingTransport {
  readonly kind = 'mesh'
  constructor(private readonly error: unknown, private readonly mode: AuroraThinConnectionMode) {}
  async request(): Promise<never> {
    throw this.toError()
  }
  subscribe(): never {
    throw this.toError()
  }
  private toError(): AuroraError {
    if (this.error instanceof AuroraError) {
      return new AuroraError({ ...this.error, message: productDiagnosticFromError(this.error) ?? CONNECTION_UNAVAILABLE_COPY })
    }
    return new AuroraError({ code: 'unavailable_service', message: productDiagnosticFromError(this.error) ?? CONNECTION_UNAVAILABLE_COPY })
  }
}

class ProductSafeTransport implements AuroraTransport {
  readonly kind: AuroraTransport['kind']

  constructor(private readonly source: AuroraTransport) {
    this.kind = source.kind
  }

  async request<TData = unknown, TPayload = unknown>(
    request: Parameters<AuroraTransport['request']>[0],
  ) {
    try {
      return await this.source.request<TData, TPayload>(request as never)
    } catch (error) {
      throw productSafeAuroraError(error)
    }
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>,
  ): AuroraEventSubscription<TEventPayload> | Promise<AuroraEventSubscription<TEventPayload>> {
    const source = this.source as AuroraTransport & {
      subscribe?: <TNextEventPayload = TEventPayload, TNextPayload = TPayload>(
        request: AuroraStreamRequest<TNextPayload>,
      ) => AuroraEventSubscription<TNextEventPayload> | Promise<AuroraEventSubscription<TNextEventPayload>>
    }
    if (!source.subscribe) {
      throw new AuroraError({ code: 'unsupported_feature', message: CONNECTION_UNAVAILABLE_COPY })
    }
    try {
      const subscription = source.subscribe<TEventPayload, TPayload>(request)
      return isPromiseLike(subscription)
        ? subscription.then(wrapProductSafeSubscription, (error) => {
            throw productSafeAuroraError(error)
          })
        : wrapProductSafeSubscription(subscription)
    } catch (error) {
      throw productSafeAuroraError(error)
    }
  }
}

function wrapProductSafeSubscription<TPayload>(
  subscription: AuroraEventSubscription<TPayload>,
): AuroraEventSubscription<TPayload> {
  return {
    get closed() {
      return subscription.closed.catch((error) => {
        throw productSafeAuroraError(error)
      })
    },
    close(reason?: unknown) {
      subscription.close(reason)
    },
    [Symbol.asyncIterator]() {
      const iterator = subscription[Symbol.asyncIterator]()
      return {
        async next(): Promise<IteratorResult<Awaited<ReturnType<typeof iterator.next>> extends IteratorResult<infer TValue> ? TValue : never>> {
          try {
            return await iterator.next()
          } catch (error) {
            throw productSafeAuroraError(error)
          }
        },
        async return(): Promise<IteratorResult<Awaited<ReturnType<typeof iterator.next>> extends IteratorResult<infer TValue> ? TValue : never>> {
          try {
            return iterator.return
              ? await iterator.return()
              : { done: true, value: undefined as never }
          } catch (error) {
            throw productSafeAuroraError(error)
          }
        },
        async throw(error?: unknown): Promise<IteratorResult<Awaited<ReturnType<typeof iterator.next>> extends IteratorResult<infer TValue> ? TValue : never>> {
          try {
            if (iterator.throw) return await iterator.throw(error)
            throw error
          } catch (nextError) {
            throw productSafeAuroraError(nextError)
          }
        },
      }
    },
  }
}

function isPromiseLike<TValue>(value: TValue | PromiseLike<TValue>): value is PromiseLike<TValue> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

function demoClientFromFactory(config: BrowserThinRuntimeConfig): AuroraClient {
  if (config.createDemoClient) return config.createDemoClient()
  throw new AuroraError({ code: 'validation', message: CLIENT_SETUP_INCOMPLETE_COPY })
}

function clientFromFactory(config: BrowserThinRuntimeConfig, transport: AuroraTransport): AuroraClient {
  if (config.createClient) return config.createClient(transport)
  throw new AuroraError({ code: 'validation', message: CLIENT_SETUP_INCOMPLETE_COPY })
}

function productSafeTransport(transport: AuroraTransport): AuroraTransport {
  return new ProductSafeTransport(transport)
}

function httpOptionsFromConfig(config: BrowserThinRuntimeConfig): HttpTransportOptions | null {
  const url = (config.gatewayUrl ?? '').trim()
  if (!url) return null
  const options: HttpTransportOptions = { baseUrl: url }
  if (config.bearerToken !== undefined && config.bearerToken !== null) options.bearerToken = config.bearerToken
  if (config.fetchImpl !== undefined) options.fetchImpl = config.fetchImpl
  if (config.eventSourceFactory !== undefined) options.eventSourceFactory = config.eventSourceFactory
  if (config.webSocketFactory !== undefined) options.webSocketFactory = config.webSocketFactory
  return options
}

function normalizeConnectionMode(value: string | null | undefined): AuroraThinConnectionMode {
  if (value === 'webrtc-only' || value === 'webrtc-preferred' || value === 'http-only') return value
  return DEFAULT_MODE
}

export function normalizeAuroraWebRtcRolloutFlags(
  value: Partial<AuroraWebRtcRolloutFlags> | null | undefined
): AuroraWebRtcRolloutFlags {
  return {
    webrtc_thin_client:
      value?.webrtc_thin_client
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.webrtc_thin_client,
    webrtc_scoped_subscriptions:
      value?.webrtc_scoped_subscriptions
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.webrtc_scoped_subscriptions,
    webrtc_fragmentation:
      value?.webrtc_fragmentation
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.webrtc_fragmentation,
    webrtc_app_layer_e2ee:
      value?.webrtc_app_layer_e2ee
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.webrtc_app_layer_e2ee,
    mesh_node_runtime_v1:
      value?.mesh_node_runtime_v1
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.mesh_node_runtime_v1,
    local_tool_provider_v1:
      value?.local_tool_provider_v1
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.local_tool_provider_v1,
    lightweight_orchestrator_v1:
      value?.lightweight_orchestrator_v1
      ?? DEFAULT_AURORA_WEBRTC_ROLLOUT_FLAGS.lightweight_orchestrator_v1,
  }
}

export function localProtocolCapabilities(
  flags: AuroraWebRtcRolloutFlags,
  nodeRole: BrowserThinNodeRole = 'remote-console',
): string[] {
  const capabilities: string[] = [
    ...(flags.webrtc_fragmentation ? [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1] : []),
    ...(flags.webrtc_scoped_subscriptions ? [CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] : []),
  ]
  if (nodeRole === 'remote-console') capabilities.push(CAP_CONSUMER_ONLY_V1)
  return [...new Set(capabilities)]
}

export interface ParsedWebRtcInvite {
  profile: WebRtcPeerConnectionProfile
  roomSecret: string
}

export function parseWebRtcInvite(
  inviteText: string | null | undefined,
  config: Pick<BrowserThinRuntimeConfig, 'production' | 'allowInsecureLoopbackSignaling' | 'nodeName' | 'signalingUrl'> = {}
): ParsedWebRtcInvite | null {
  const trimmedInvite = typeof inviteText === 'string' ? inviteText.trim() : ''
  const invite = trimmedInvite ? decodeMeshInvite(trimmedInvite) : null
  if (!invite) return null
  const signaling = record(invite.signaling)
  const node = record(invite.node)
  const webrtc = record(invite.webrtc)
  const room = stringValue(signaling.room)
  const roomPassword = stringValue(signaling.room_password)
  const appId = stringValue(signaling.app_id) || 'aurora'
  const configuredSignaling = stringValue(config.signalingUrl)
  const brokers = configuredSignaling ? [configuredSignaling] : stringArray(signaling.mqtt_brokers)
  if (!room || !roomPassword || brokers.length === 0) return null
  const profile: WebRtcPeerConnectionProfile = {
    mode: 'webrtc-preferred',
    appId,
    room,
    roomSecretRef: memoryRoomSecretRef(room),
    signalingBrokers: brokers,
    stunServers: stringArray(webrtc.stun_servers),
    turnServers: stringArray(webrtc.turn_servers),
    requireAppLayerE2ee: booleanValue(webrtc.app_layer_e2ee, true),
  }
  const expectedStablePeerId = stringValue(node.peer_id)
  if (expectedStablePeerId) profile.expectedStablePeerId = expectedStablePeerId
  const expectedNodeName = stringValue(node.node_name)
  if (expectedNodeName) profile.nodeName = expectedNodeName
  if (config.production !== undefined) profile.production = config.production
  if (config.allowInsecureLoopbackSignaling !== undefined) {
    profile.allowInsecureLoopbackSignaling = config.allowInsecureLoopbackSignaling
    // The signaling SDK defaults an unspecified profile to production policy.
    // An explicit loopback-development override therefore also has to mark the
    // imported profile non-production; the broker validator still restricts
    // cleartext WebSockets to loopback hosts.
    if (config.production === undefined && config.allowInsecureLoopbackSignaling) {
      profile.production = false
    }
  }
  return { profile, roomSecret: roomPassword }
}

function memoryRoomSecretRef(room: string): string {
  return `ref:memory:${room}`
}

type BrowserRuntimeSecurityContext = Pick<
  BrowserThinRuntimeConfig,
  | 'production'
  | 'allowInsecureLoopbackSignaling'
  | 'nodeName'
  | 'signalingUrl'
  | 'windowLocation'
> & {
  trustsNativeWebViewOrigin?: boolean
}

function isSecureBrowserContext(
  locationOverride?: BrowserThinRuntimeConfig['windowLocation'],
  trustsNativeWebViewOrigin = false,
): boolean {
  if (typeof window === 'undefined' && !locationOverride) return true
  if (typeof window !== 'undefined' && window.isSecureContext) return true
  const location = locationOverride ?? (typeof window === 'undefined' ? undefined : window.location)
  if (!location) return true
  if (location.protocol === 'https:') return true
  if (isBrowserLoopbackHost(location.hostname)) return true
  return trustsNativeWebViewOrigin && isTrustedNativeWebViewHost(location.hostname)
}

function isTrustedNativeWebViewHost(hostname: string): boolean {
  return (
    hostname === 'tauri.localhost'
    || isBrowserLoopbackHost(hostname)
  )
}

function isBrowserLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
  )
}

function statusFromSnapshot(
  snapshot: PeerConnectionSnapshot | null,
  mode: AuroraThinConnectionMode,
  creationError: unknown,
  disabledReason: string | undefined,
  fallbackReason: string | undefined,
  disconnected: boolean,
  attemptedConnect: boolean,
): BrowserWebRtcStatus {
  if (disabledReason) return 'disabled'
  if (fallbackReason) return 'fallback-http'
  if (creationError) return /secure/i.test(diagnosticFromError(creationError) ?? '') ? 'needs-secure-context' : 'failed'
  if (mode === 'http-only') return 'idle'
  if (disconnected) return 'closed'
  if (!attemptedConnect && !snapshot?.expectedStablePeerId) return 'needs-invite'
  if (!snapshot) return 'needs-invite'
  if (snapshot.state === 'authorized') return 'authorized'
  if (snapshot.state === 'awaiting-sas-confirmation' || snapshot.state === 'pairing-required') return 'pairing'
  if (snapshot.state === 'failed') return 'failed'
  if (snapshot.state === 'closed') return 'closed'
  if (snapshot.state === 'idle') return 'idle'
  return 'connecting'
}

function pendingPairingFromSnapshot(snapshot: PeerConnectionSnapshot | null): { sessionId?: string; verificationCode?: string } | null {
  if (snapshot?.state === 'authorized') return null
  const pending = (snapshot as unknown as { pendingPairing?: { sessionId?: string; verificationCode?: string } } | null)?.pendingPairing
  if (pending) return pending
  const legacy = snapshot as unknown as { pairingSessionId?: string; pairingVerificationCode?: string } | null
  if (legacy?.pairingSessionId || legacy?.pairingVerificationCode) {
    const next: { sessionId?: string; verificationCode?: string } = {}
    if (legacy.pairingSessionId) next.sessionId = legacy.pairingSessionId
    if (legacy.pairingVerificationCode) next.verificationCode = legacy.pairingVerificationCode
    return next
  }
  return null
}

function emptySelectedCandidatePairEvidence(): SelectedCandidatePairEvidence {
  return {
    selected: false,
    category: 'unknown',
    statsSource: 'RTCPeerConnection.getStats',
    rawAddressRedacted: true,
  }
}

function diagnosticFromSnapshot(snapshot: PeerConnectionSnapshot | null): string | undefined {
  if (snapshot?.state === 'authorized') return undefined
  const diagnostic = `${snapshot?.lastRedactedError?.code ?? ''} ${snapshot?.lastRedactedError?.message ?? ''}`.trim()
  if (isExpectedOfflineDiagnostic(diagnostic)) return undefined
  return productDiagnosticFromValue(diagnostic)
}

function diagnosticFromError(error: unknown): string | undefined {
  if (!error) return undefined
  return redactThinDiagnostic(error instanceof Error ? error.message : String(error))
}

function productDiagnosticFromError(error: unknown): string | undefined {
  return productDiagnosticFromValue(diagnosticFromError(error))
}

function productDiagnosticFromValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.includes(INVITE_UNAVAILABLE_COPY)) return INVITE_UNAVAILABLE_COPY
  if (/timed?\s*out|timeout/iu.test(value)) return REQUEST_TIMEOUT_COPY
  if (/secure|https|localhost/iu.test(value)) return SECURE_CONTEXT_REQUIRED_COPY
  if (/invite|profile|room|pair/iu.test(value)) return INVITE_REQUIRED_COPY
  return CONNECTION_UNAVAILABLE_COPY
}

function productSafeAuroraError(error: unknown): AuroraError {
  if (error instanceof AuroraError) {
    return new AuroraError({
      code: error.code,
      message: productDiagnosticFromError(error) ?? CONNECTION_UNAVAILABLE_COPY,
      status: error.status,
      method: error.method,
      busTopic: error.busTopic,
      correlationId: error.correlationId,
      detail: error.detail,
      cause: error.cause,
    })
  }
  return new AuroraError({
    code: 'unavailable_service',
    message: productDiagnosticFromError(error) ?? CONNECTION_UNAVAILABLE_COPY,
    cause: error,
  })
}

function isExpectedOfflineDiagnostic(value: string): boolean {
  return /mesh transport is not connected|transport datachannel not connected|preferred-mode fallback is unavailable/iu.test(value)
}

function redactThinDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value
    .replace(/"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;<>"']+/gi, '$1$2[redacted]')
    .replace(/\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)\b(\s*[:=]\s*)(["']?)[^\s,;<>"']+/gi, '$1$2$3[redacted]')
    .replace(/([?&](?:(?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .slice(0, 240)
}

function browserUserAgent(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.userAgent
}
function record(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}
