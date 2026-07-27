import {
  AuroraError,
  type AuroraClient,
  type AuroraTransport,
  type HttpTransportOptions,
  type JsonObject,
} from '@aurora/client'
import {
  MemoryPeerCredentialStore,
  createBrowserWebRtcAuroraRuntime,
  type BrowserWebRtcRuntime,
  type BrowserWebRtcRuntimeOptions,
  type MeshPeerCredentialRecord,
  type WebRtcPeerCredentialStore,
  type PeerConnectionController,
  type PeerConnectionSnapshot,
  type WebRtcPeerConnectionProfile,
} from '@aurora/client/webrtc'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { BrowserPeerPersistenceStatus, BrowserWebRtcCredentialStore } from './browser-peer-persistence'

export type AuroraThinConnectionMode = 'http-only' | 'webrtc-only' | 'webrtc-preferred'
export type BrowserWebRtcStatus =
  | 'idle'
  | 'needs-secure-context'
  | 'needs-invite'
  | 'connecting'
  | 'pairing'
  | 'authorized'
  | 'fallback-http'
  | 'closed'
  | 'failed'

export interface BrowserThinRuntimeConfig {
  mode?: AuroraThinConnectionMode | null | undefined
  gatewayUrl?: string | null | undefined
  signalingUrl?: string | null | undefined
  bearerToken?: string | (() => string | null | undefined) | null | undefined
  inviteText?: string | null | undefined
  profile?: WebRtcPeerConnectionProfile | null | undefined
  runtimeMode?: string | null | undefined
  nativePlatform?: string | null | undefined
  userAgent?: string | null | undefined
  nodeName?: string | null | undefined
  localStablePeerId?: string | null | undefined
  demoMode?: boolean | undefined
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

export interface BrowserWebThinRuntime {
  client: AuroraClient
  peer: BrowserWebRtcPeerController
  surface: AuroraSurfaceProfile
  mode: AuroraThinConnectionMode
  close(): Promise<void>
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

const DEFAULT_MODE: AuroraThinConnectionMode = 'http-only'

export function createBrowserWebThinRuntime(config: BrowserThinRuntimeConfig = {}): BrowserWebThinRuntime {
  const mode = normalizeConnectionMode(config.mode)
  const surface = getAuroraSurfaceProfile({
    runtimeMode: config.runtimeMode ?? (mode === 'http-only' ? 'web' : 'web-thin'),
    transportKind: mode === 'http-only' ? 'http' : 'mesh',
    nativePlatform: config.nativePlatform,
    userAgent: config.userAgent ?? browserUserAgent(),
  })
  const http = httpOptionsFromConfig(config)
  const credentialStore: NonNullable<BrowserThinRuntimeConfig['credentialStore']> =
    config.credentialStore ?? new MemoryOnlyWebRtcCredentialStore()
  const parsedInvite = config.profile ? null : parseWebRtcInvite(config.inviteText, config)
  const activeProfile = config.profile ?? parsedInvite?.profile ?? credentialStore.loadConnectionProfile?.() ?? null
  if (parsedInvite) {
    if (credentialStore.setRoomSecret) credentialStore.setRoomSecret(parsedInvite.profile.roomSecretRef, parsedInvite.roomSecret)
    else if (!credentialStore.getRoomSecret) throw new AuroraError({ code: 'validation', message: 'WebRTC invite requires a room-secret capable credential store.' })
    credentialStore.saveConnectionProfile?.(parsedInvite.profile)
  }
  const localStablePeerId = config.localStablePeerId ?? credentialStore.getOrCreateLocalStablePeerId?.()

  let sdkRuntime: BrowserWebRtcRuntime<AuroraClient>
  try {
    sdkRuntime = createBrowserWebRtcAuroraRuntime<AuroraClient>({
      mode,
      ...(http ? { http } : {}),
      ...(activeProfile ? { profile: activeProfile } : {}),
      credentialStore,
      ...(config.initialCredentials ? { initialCredentials: config.initialCredentials } : {}),
      ...(localStablePeerId ? { localStablePeerId } : {}),
      localNodeName: config.nodeName ?? activeProfile?.nodeName ?? 'Aurora Web thin client',
      allowInsecureLoopback: config.allowInsecureLoopback ?? config.allowInsecureLoopbackSignaling,
      ...(config.peerConnectionFactory ?? config.createPeerConnection ? { createPeerConnection: config.peerConnectionFactory ?? config.createPeerConnection } : {}),
      ...(config.signalingFactory ? { signalingFactory: config.signalingFactory } : {}),
      ...(config.randomId ? { randomId: config.randomId } : {}),
      ...(config.random ? { random: config.random } : {}),
      ...(config.scryptDeriver ? { scryptDeriver: config.scryptDeriver } : {}),
      ...(config.scryptWorkerFactory ? { scryptWorkerFactory: config.scryptWorkerFactory } : {}),
      ...(config.visibilityDocument ? { visibilityDocument: config.visibilityDocument } : {}),
      ...(config.windowLocation ? { windowLocation: config.windowLocation } : {}),
      ...(config.createClient ? { createClient: config.createClient } : {}),
    })
  } catch (error) {
    if (mode === 'http-only' && config.demoMode) {
      const unavailable = new BrowserWebRtcPeerController(null, mode, { httpFallback: false, creationError: error, visibilityDocument: config.visibilityDocument })
      return { client: demoClientFromFactory(config), peer: unavailable, surface, mode, close: () => unavailable.disconnect('runtime closed') }
    }
    const unavailable = new BrowserWebRtcPeerController(null, mode, { httpFallback: false, creationError: error, credentialStore, config, visibilityDocument: config.visibilityDocument })
    return {
      client: clientFromFactory(config, new FailingTransport(error, mode)),
      peer: unavailable,
      surface,
      mode,
      async close() {
        await unavailable.disconnect('runtime closed')
        await credentialStore.close()
      }
    }
  }

  const peer = new BrowserWebRtcPeerController(sdkRuntime.peer, mode, { httpFallback: Boolean(http), credentialStore, config, visibilityDocument: config.visibilityDocument })
  return {
    client: sdkRuntime.client,
    peer,
    surface,
    mode,
    async close() {
      await sdkRuntime.close()
      await credentialStore.close()
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
  const invite = config.inviteText ? decodeMeshInvite(config.inviteText) : null
  const summary = invite ? meshInviteSummary(invite) : null
  const notes = [`mode=${mode}`]
  if (config.gatewayUrl) notes.push('http endpoint configured')
  if (config.signalingUrl) notes.push('signaling endpoint configured')
  if (summary) notes.push(`invite room=${summary.room}; brokers=${summary.brokerCount}; secret=${summary.includesPassword ? 'memory-only' : 'missing'}`)
  if (mode !== 'http-only' && typeof window !== 'undefined' && !isSecureBrowserContext(config.windowLocation)) notes.push('blocked: secure context required')
  if (mode === 'webrtc-only' && !summary && !config.profile) notes.push('blocked: invite/profile required')
  return notes
}

export class BrowserWebRtcPeerController implements PeerConnectionController {
  private readonly listeners = new Set<BrowserSnapshotListener>()
  private readonly peer: PeerConnectionController | null
  private readonly mode: AuroraThinConnectionMode
  private readonly httpFallback: boolean
  private readonly creationError: unknown
  private readonly credentialStore: BrowserThinRuntimeConfig['credentialStore']
  private readonly config: Pick<BrowserThinRuntimeConfig, 'production' | 'allowInsecureLoopbackSignaling' | 'nodeName' | 'signalingUrl'>
  private sdkSnapshot: PeerConnectionSnapshot | null = null
  private fallbackReason: string | undefined
  private visibilityDiagnostic: string | undefined
  private connectionDiagnostic: string | undefined
  private attemptedConnect = false
  private authorizedRouteSeen = false
  private disconnected = false
  private unsubscribe: (() => void) | undefined
  private removeVisibilityListeners: (() => void) | undefined

  constructor(peer: PeerConnectionController | null, mode: AuroraThinConnectionMode, options: { httpFallback: boolean; creationError?: unknown; credentialStore?: BrowserThinRuntimeConfig['credentialStore']; config?: Pick<BrowserThinRuntimeConfig, 'production' | 'allowInsecureLoopbackSignaling' | 'nodeName' | 'signalingUrl'>; visibilityDocument?: BrowserThinRuntimeConfig['visibilityDocument'] }) {
    this.peer = peer
    this.mode = mode
    this.httpFallback = options.httpFallback
    this.creationError = options.creationError
    this.credentialStore = options.credentialStore
    this.config = options.config ?? {}
    if (peer) this.unsubscribe = peer.subscribe((snapshot) => {
      this.sdkSnapshot = snapshot
      if (snapshot.state === 'authorized') this.authorizedRouteSeen = true
      this.emit()
    })
    this.installVisibilityPolicy(options.visibilityDocument)
  }

  snapshot(): BrowserWebRtcSnapshot {
    const sdk = this.sdkSnapshot ?? this.peer?.snapshot() ?? null
    const diagnostic = this.visibilityDiagnostic ?? this.connectionDiagnostic ?? diagnosticFromSnapshot(sdk) ?? diagnosticFromError(this.creationError)
    const pendingPairing = pendingPairingFromSnapshot(sdk)
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
      status: statusFromSnapshot(sdk, this.mode, this.creationError, this.fallbackReason, this.disconnected, this.attemptedConnect),
      secureContext: isSecureBrowserContext(),
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
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
    const parsed = parseWebRtcInvite(inviteText, this.config)
    if (!parsed) throw new AuroraError({ code: 'validation', message: 'Paste a valid Aurora mesh invite before connecting WebRTC thin mode.' })
    if (this.credentialStore?.setRoomSecret) this.credentialStore.setRoomSecret(parsed.profile.roomSecretRef, parsed.roomSecret)
    this.credentialStore?.saveConnectionProfile?.(parsed.profile)
    return parsed.profile
  }

  async connect(profile?: WebRtcPeerConnectionProfile): Promise<void> {
    if (!this.peer) throw new AuroraError({ code: 'unavailable_service', message: diagnosticFromError(this.creationError) ?? 'WebRTC runtime is unavailable.' })
    this.fallbackReason = undefined
    this.connectionDiagnostic = undefined
    this.attemptedConnect = true
    this.disconnected = false
    if (profile !== undefined) this.credentialStore?.saveConnectionProfile?.(profile)
    try {
      await this.peer.connect(profile as WebRtcPeerConnectionProfile)
    } catch (error) {
      this.connectionDiagnostic = diagnosticFromError(error) ?? 'WebRTC connection failed.'
      this.emit()
      throw error
    }
  }

  isFallbackEligibleAfterWebRtcRoute(error: unknown): boolean {
    if (!this.attemptedConnect || !this.authorizedRouteSeen) return false
    if (error instanceof AuroraError && (error.code === 'transport_loss' || error.code === 'timeout')) return true
    const diagnostic = this.sdkSnapshot?.lastRedactedError
    return Boolean(diagnostic && /transport[_-]?(loss|unavailable)|webrtc[_-]?transport[_-]?unavailable/i.test(`${diagnostic.code} ${diagnostic.message}`))
  }

  async confirmPairing(sessionId: string): Promise<void> {
    if (!this.peer) throw new AuroraError({ code: 'unavailable_service', message: 'No WebRTC peer is available.' })
    await this.peer.confirmPairing(sessionId)
  }

  async rejectPairing(sessionId: string): Promise<void> {
    if (!this.peer) return
    await this.peer.rejectPairing(sessionId)
  }

  async getSelectedCandidatePairEvidence(): Promise<SelectedCandidatePairEvidence> {
    if (!this.peer) return emptySelectedCandidatePairEvidence()
    return await this.peer.getSelectedCandidatePairEvidence()
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    this.disconnected = true
    if (reason.includes('hidden') || reason.includes('blurred')) this.visibilityDiagnostic = 'WebRTC disconnected because the thin shell lost visibility or focus.'
    if (reason === 'runtime closed') {
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.removeVisibilityListeners?.()
      this.removeVisibilityListeners = undefined
    }
    await this.peer?.disconnect(reason)
    if (reason === 'runtime closed') await this.credentialStore?.close()
    this.emit()
  }

  markFallback(reason: string): void {
    this.fallbackReason = reason
    this.emit()
  }

  private installVisibilityPolicy(visibilityDocument: BrowserThinRuntimeConfig['visibilityDocument']): void {
    if (this.mode === 'http-only' || !this.peer) return
    const doc = visibilityDocument ?? (typeof document === 'undefined' ? undefined : document)
    const release = () => {
      const hidden = doc?.visibilityState === 'hidden'
      const blurred = typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()
      if (!hidden && !blurred) return
      void this.disconnect(hidden ? 'hidden document' : 'window blurred')
    }
    doc?.addEventListener('visibilitychange', release)
    if (typeof window !== 'undefined') window.addEventListener('blur', release)
    this.removeVisibilityListeners = () => {
      doc?.removeEventListener('visibilitychange', release)
      if (typeof window !== 'undefined') window.removeEventListener('blur', release)
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
    if (this.error instanceof AuroraError) return new AuroraError({ ...this.error, message: diagnosticFromError(this.error) ?? 'WebRTC runtime is unavailable.' })
    return new AuroraError({ code: 'unavailable_service', message: `${this.mode} runtime is unavailable: ${diagnosticFromError(this.error) ?? 'unknown error'}` })
  }
}

function demoClientFromFactory(config: BrowserThinRuntimeConfig): AuroraClient {
  if (config.createDemoClient) return config.createDemoClient()
  throw new AuroraError({ code: 'validation', message: 'Browser thin runtime demo mode requires an app-provided demo client factory.' })
}

function clientFromFactory(config: BrowserThinRuntimeConfig, transport: AuroraTransport): AuroraClient {
  if (config.createClient) return config.createClient(transport)
  throw new AuroraError({ code: 'validation', message: 'Browser thin runtime requires an app-provided client factory for this transport path.' })
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

interface ParsedWebRtcInvite {
  profile: WebRtcPeerConnectionProfile
  roomSecret: string
}

function parseWebRtcInvite(
  inviteText: string | null | undefined,
  config: Pick<BrowserThinRuntimeConfig, 'production' | 'allowInsecureLoopbackSignaling' | 'nodeName' | 'signalingUrl'> = {}
): ParsedWebRtcInvite | null {
  const invite = inviteText ? decodeMeshInvite(inviteText) : null
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
    nodeName: config.nodeName ?? 'Aurora Web thin client',
    stunServers: stringArray(webrtc.stun_servers),
    turnServers: stringArray(webrtc.turn_servers),
    requireAppLayerE2ee: booleanValue(webrtc.app_layer_e2ee, true),
  }
  const expectedStablePeerId = stringValue(node.peer_id)
  if (expectedStablePeerId) profile.expectedStablePeerId = expectedStablePeerId
  if (config.production !== undefined) profile.production = config.production
  if (config.allowInsecureLoopbackSignaling !== undefined) profile.allowInsecureLoopbackSignaling = config.allowInsecureLoopbackSignaling
  return { profile, roomSecret: roomPassword }
}

function memoryRoomSecretRef(room: string): string {
  return `ref:memory:${room}`
}

function isSecureBrowserContext(locationOverride?: BrowserThinRuntimeConfig['windowLocation']): boolean {
  if (typeof window === 'undefined' && !locationOverride) return true
  if (typeof window !== 'undefined' && window.isSecureContext) return true
  const location = locationOverride ?? (typeof window === 'undefined' ? undefined : window.location)
  if (!location) return true
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
}

function statusFromSnapshot(
  snapshot: PeerConnectionSnapshot | null,
  mode: AuroraThinConnectionMode,
  creationError: unknown,
  fallbackReason: string | undefined,
  disconnected: boolean,
  attemptedConnect: boolean,
): BrowserWebRtcStatus {
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
  const pending = (snapshot as unknown as { pendingPairing?: { sessionId?: string; verificationCode?: string } } | null)?.pendingPairing
  return pending ?? null
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
  return redactThinDiagnostic(snapshot?.lastRedactedError?.message)
}

function diagnosticFromError(error: unknown): string | undefined {
  if (!error) return undefined
  return redactThinDiagnostic(error instanceof Error ? error.message : String(error))
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
