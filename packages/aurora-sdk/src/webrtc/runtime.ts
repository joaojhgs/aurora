import { AuroraClient } from '../client.js'
import { AUTH_METHODS } from '../descriptors.js'
import { AuroraError } from '../errors.js'
import { HttpGatewayTransport, type HttpTransportOptions } from '../http.js'
import { MeshP2PTransport, type MeshPeerBridge, type MeshRouteResolver, type MeshRouteResolution } from '../mesh.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from '../transport.js'
import type { AuroraEventSubscription, AuroraStreamRequest } from '../events.js'
import type { JsonObject } from '../types.js'
import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_PROVIDER_LEASE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  buildProtocolHello
} from './peer-protocol.js'
import { bytesToBase64Url, constantTimeEqual, decodeJsonPayload, deriveRoomKeys, encodeJsonPayload, hexToBytes, randomBytes, sha256Bytes, type AuroraScryptDeriver, type RoomKeys, type ScryptWorkerFactory } from './crypto.js'
import { zeroBytes } from './encoding.js'
import {
  MemoryPeerCredentialStore,
  type MeshPeerCredentialRecord,
  type MeshReconnectChallengeMessage,
  type PeerCredentialStore as InternalPeerCredentialStore
} from './credentials.js'
import {
  MqttWebSocketSignalingClient,
  type MqttSealOpen,
  type MqttSignalingOptions,
  type MqttSignalingRoom
} from './signaling-mqtt.js'
import {
  PairingProtocolError,
  PairingSasHandshake,
  deriveChannelBinding,
  pairingIdentity,
  parsePairingCommitMessage,
  parsePairingRevealMessage,
  parsePairingTerminalMessage,
  type PairingCommitMessage,
  type PairingRevealMessage,
  type PairingSasResult,
  type PairingTerminalMessage
} from './pairing.js'
import {
  WebRtcPeerSession,
  type PeerConnectionLike,
  type PeerSessionAuthContext,
  type PeerSessionAuthFrameResult,
  type PeerSessionAuthPort,
  type PeerSessionOptions,
  type PeerSessionPeerConnectionFactory,
  type PeerSessionSignalingPort,
  type PeerSessionSnapshot,
  type SignalingChannel,
  type SignalingMessage
} from './peer-session.js'
import { WebRtcMeshPeerBridge } from './mesh-peer-bridge.js'
import type { WebRtcPeerHost } from '../peer-host/index.js'
import type { PeerAuthorityResolver, PeerPairingIssuer, PeerRelationshipSelector } from '../peer-host/authority.js'
import type {
  AuroraConnectionMode,
  PeerConnectionController,
  PeerConnectionSnapshot,
  RedactedPeerDiagnostic,
  WebRtcAuroraRuntime,
  WebRtcPeerConnectionProfile
} from './types.js'

export interface WebRtcRuntimeHttpOptions extends Omit<HttpTransportOptions, 'baseUrl'> {
  baseUrl: string
}

export interface PairingConnectPollOptions {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  rpcTimeoutMs: number
}

const DEFAULT_PAIRING_CONNECT_POLL: PairingConnectPollOptions = {
  maxAttempts: 12,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
  rpcTimeoutMs: 5_000
}

export interface BrowserWebRtcRuntimeOptions<TClient = AuroraClient> {
  mode: AuroraConnectionMode
  nodeRole?: 'remote-console' | 'mesh-node'
  http?: WebRtcRuntimeHttpOptions | undefined
  profile?: WebRtcPeerConnectionProfile | undefined
  localStablePeerId?: string | undefined
  localNodeName?: string | undefined
  routeResolver?: MeshRouteResolver | ((request: AuroraTransportRequest) => Promise<MeshRouteResolution> | MeshRouteResolution)
  defaultTimeoutMs?: number | undefined
  fallbackPeerIds?: string[] | undefined
  credentialStore?: InternalPeerCredentialStore | undefined
  initialCredentials?: MeshPeerCredentialRecord[] | undefined
  mapClientTransport?: (transport: AuroraTransport) => AuroraTransport
  createClient?: (transport: AuroraTransport) => TClient
  createPeerConnection?: PeerSessionPeerConnectionFactory | undefined
  signalingFactory?: (options: MqttSignalingOptions) => MqttWebSocketSignalingClient
  randomId?: () => string
  random?: () => number
  scryptDeriver?: AuroraScryptDeriver | undefined
  scryptWorkerFactory?: ScryptWorkerFactory | undefined
  localProtocolCapabilities?: readonly string[] | undefined
  peerHost?: WebRtcPeerHost | undefined
  peerAuthorityResolver?: PeerAuthorityResolver | undefined
  peerPairingIssuer?: PeerPairingIssuer | undefined
  appLayerE2eeAllowed?: boolean | undefined
  allowInsecureLoopback?: boolean | undefined
  pairingConnectPoll?: Partial<PairingConnectPollOptions> | undefined
  visibilityDocument?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | undefined
  windowLocation?: Pick<Location, 'protocol' | 'hostname'> | undefined
}

function clientOptions(transport: AuroraTransport, defaultTimeoutMs?: number): { transport: AuroraTransport; defaultTimeoutMs?: number } {
  const out: { transport: AuroraTransport; defaultTimeoutMs?: number } = { transport }
  if (defaultTimeoutMs !== undefined) out.defaultTimeoutMs = defaultTimeoutMs
  return out
}

function createRuntimeClient<TClient>(
  options: Pick<BrowserWebRtcRuntimeOptions<TClient>, 'createClient' | 'defaultTimeoutMs' | 'mapClientTransport'>,
  transport: AuroraTransport
): TClient {
  const clientTransport = options.mapClientTransport ? options.mapClientTransport(transport) : transport
  if (options.createClient) return options.createClient(clientTransport)
  return new AuroraClient(clientOptions(clientTransport, options.defaultTimeoutMs)) as TClient
}

export interface BrowserWebRtcRuntime<TClient = AuroraClient> extends WebRtcAuroraRuntime<TClient> {
  readonly transport: AuroraTransport
  readonly httpTransport?: HttpGatewayTransport | undefined
  readonly meshTransport?: MeshP2PTransport | undefined
}

export function createBrowserWebRtcAuroraRuntime<TClient = AuroraClient>(
  options: BrowserWebRtcRuntimeOptions<TClient>
): BrowserWebRtcRuntime<TClient> {
  const httpTransport = options.http === undefined ? undefined : new HttpGatewayTransport(options.http)
  if (options.mode === 'http-only') {
    if (!httpTransport) throw new AuroraError({ code: 'validation', message: 'http-only mode requires an HTTP endpoint' })
    const peer = new WebRtcPeerConnectionController(options.mode, undefined, undefined, options.visibilityDocument, options as BrowserWebRtcRuntimeOptions<unknown>)
    const client = createRuntimeClient(options, httpTransport)
    return {
      client,
      peer,
      transport: httpTransport,
      httpTransport,
      async close() {
        await peer.disconnect('runtime closed')
      }
    }
  }
  // A hosted thin shell may be created before an invite is pasted. The
  // controller accepts the validated profile later through connect(profile).
  if (options.profile) assertSecureRuntime(options.profile, options as BrowserWebRtcRuntimeOptions<unknown>)

  const credentialStore = options.credentialStore ?? new MemoryPeerCredentialStore()
  const peer = new WebRtcPeerConnectionController(options.mode, options.profile, credentialStore, options.visibilityDocument, options as BrowserWebRtcRuntimeOptions<unknown>)
  const dynamic = new WebRtcPreferredTransport({ mode: options.mode, peer, http: httpTransport })
  const client = createRuntimeClient(options, dynamic)
  return {
    client,
    peer,
    transport: dynamic,
    httpTransport,
    get meshTransport() { return peer.meshTransport ?? undefined },
    async close() {
      await peer.disconnect('runtime closed')
      await credentialStore.close()
    }
  }
}

class WebRtcPreferredTransport implements AuroraTransport {
  readonly kind = 'mesh'
  constructor(
    private readonly options: {
      mode: AuroraConnectionMode
      peer: WebRtcPeerConnectionController
      http?: HttpGatewayTransport | undefined
    }
  ) {}

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const mesh = this.options.peer.meshTransport
    if (mesh && this.options.peer.isAuthorized()) {
      try {
        return await mesh.request<TData, TPayload>(request)
      } catch (error) {
        if (!this.canFallbackAfterMeshFailure(request, error)) throw error
        this.options.peer.noteFallback('http_fallback_after_transport_loss', request.method)
        return await this.options.http!.request<TData, TPayload>(request)
      }
    }
    this.options.peer.noteUnavailable(this.options.peer.hasEstablishedAuthorizedRoute() ? 'webrtc_peer_not_connected' : 'webrtc_no_authorized_route', request.method)
    throw new AuroraError({
      code: 'unavailable_service',
      message: 'WebRTC mesh transport is not connected; preferred-mode HTTP fallback is allowed only after an authorized mesh route fails during a safe request.',
      method: request.method,
      busTopic: request.busTopic
    })
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> | Promise<AuroraEventSubscription<TEventPayload>> {
    const mesh = this.options.peer.meshTransport
    if (mesh && this.options.peer.isAuthorized()) return mesh.subscribe<TEventPayload>(request)
    throw new AuroraError({
      code: 'unavailable_service',
      message: 'WebRTC mesh event stream is not connected and HTTP fallback is disabled.',
      method: request.stream,
      busTopic: request.topics[0]
    })
  }

  private canFallbackAfterMeshFailure(request: AuroraTransportRequest, error: unknown): boolean {
    return this.options.mode === 'webrtc-preferred'
      && this.options.http !== undefined
      && this.options.peer.hasEstablishedAuthorizedRoute()
      && isSafeHttpFallbackRequest(request)
      && isFallbackEligible(error)
  }

}

class WebRtcPeerConnectionController implements PeerConnectionController {
  private readonly listeners = new Set<(snapshot: PeerConnectionSnapshot) => void>()
  private readonly diagnostics: RedactedPeerDiagnostic[] = []
  private readonly mode: AuroraConnectionMode
  private readonly fixedProfile: WebRtcPeerConnectionProfile | undefined
  private readonly credentialStore: InternalPeerCredentialStore | undefined
  private readonly visibilityDocument: BrowserWebRtcRuntimeOptions['visibilityDocument']
  private readonly options: BrowserWebRtcRuntimeOptions<unknown>
  private session: WebRtcPeerSession | null = null
  private signaling: MqttWebSocketSignalingClient | null = null
  private bridge: WebRtcMeshPeerBridge | null = null
  meshTransport: MeshP2PTransport | null = null
  private pendingPairing: PairingSasResult | null = null
  private keyMaterial: RoomKeys | null = null
  private activeProfile: WebRtcPeerConnectionProfile | null = null
  private lastSnapshot: PeerConnectionSnapshot
  private removeVisibilityListener: (() => void) | undefined
  private establishedAuthorizedRoute = false
  private activeLocalProtocolHello: Record<string, unknown> | null = null

  constructor(
    mode: AuroraConnectionMode,
    profile?: WebRtcPeerConnectionProfile,
    credentialStore?: InternalPeerCredentialStore,
    visibilityDocument?: BrowserWebRtcRuntimeOptions['visibilityDocument'],
    options: BrowserWebRtcRuntimeOptions<unknown> = { mode }
  ) {
    this.mode = mode
    this.fixedProfile = profile
    this.credentialStore = credentialStore
    this.visibilityDocument = visibilityDocument
    this.options = options
    this.lastSnapshot = this.snapshotFromSession(null, profile)
    this.installVisibilityHook()
  }

  snapshot(): PeerConnectionSnapshot {
    this.lastSnapshot = this.snapshotFromSession(this.session?.getSnapshot() ?? null, this.activeProfile ?? this.fixedProfile)
    return { ...this.lastSnapshot, protocolCapabilities: [...this.lastSnapshot.protocolCapabilities] }
  }

  subscribe(listener: (snapshot: PeerConnectionSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async connect(profile: WebRtcPeerConnectionProfile = this.requiredProfile()): Promise<void> {
    await this.disconnect('superseded connection')
    assertSecureRuntime(profile, this.options)
    assertPeerConnectionRuntimeAvailable(this.options)
    const localSignalingId = this.options.randomId?.() ?? randomBrowserId()
    if (this.options.initialCredentials) {
      for (const credential of this.options.initialCredentials) {
        await this.credentialStore?.save(credential.verifierPeerId, credential)
      }
    }
    const keys = await deriveRoomKeysFromProfile(profile, this.options)
    this.keyMaterial = keys
    try {
      const appLayerE2eeEnabled = resolveAppLayerE2eeEnabled(profile, this.options)
      const localProtocolHello = buildLocalProtocolHello(this.options)
      this.activeLocalProtocolHello = localProtocolHello
      const crypto: MqttSealOpen = {
        seal: (value) => encodeJsonPayload(value, { key: keys.kSig }).then((out) => out.payload),
        open: (payload) => decodeJsonPayload(payload, { key: keys.kSig, encrypted: true })
      }
      const signalingOptions: MqttSignalingOptions = {
        brokers: profile.signalingBrokers,
        crypto
      }
      if (profile.production !== undefined) signalingOptions.production = profile.production
      if (profile.allowInsecureLoopbackSignaling !== undefined) signalingOptions.allowInsecureLoopback = profile.allowInsecureLoopbackSignaling
      if (profile.expectedStablePeerId !== undefined) signalingOptions.expectedStablePeerId = profile.expectedStablePeerId
      if (profile.expectedSignalingPeerId !== undefined) signalingOptions.expectedSignalingPeerId = profile.expectedSignalingPeerId
      const signaling = (this.options.signalingFactory ?? ((nextOptions) => new MqttWebSocketSignalingClient(nextOptions)))(signalingOptions)
      const signalingRoom: MqttSignalingRoom = {
        appId: profile.appId,
        room: profile.room,
        signalingPeerId: localSignalingId
      }
      if (this.options.localStablePeerId !== undefined) signalingRoom.stablePeerId = this.options.localStablePeerId
      const nodeName = this.options.localNodeName ?? profile.nodeName
      if (nodeName !== undefined) signalingRoom.nodeName = nodeName
      const signalingPort = new RuntimeSignalingPort(signaling, signalingRoom)
      const auth = new RuntimePeerAuth({
        profile,
        credentialStore: this.credentialStore,
        localStablePeerId: this.options.localStablePeerId ?? localSignalingId,
        localNodeName: this.options.localNodeName ?? 'Aurora thin client',
        onPairing: (pairing) => {
          this.pendingPairing = pairing
          this.emit()
        },
        onDiagnostic: (code, message) => this.recordDiagnostic(code, message),
        randomId: this.options.randomId,
        pairingConnectPoll: this.options.pairingConnectPoll,
        peerAuthorityResolver: this.options.peerAuthorityResolver,
        peerPairingIssuer: this.options.peerPairingIssuer
      })
      const sessionOptions: PeerSessionOptions = {
        localSignalingId,
        iceServers: iceServersFromProfile(profile),
        signaling: signalingPort,
        createPeerConnection: this.options.createPeerConnection ?? defaultPeerConnectionFactory,
        codec: appLayerE2eeEnabled
          ? {
              seal: (frame: unknown) => encodeJsonPayload(frame, { key: keys.kData }).then((out) => out.payload),
              open: (data: string | ArrayBuffer | ArrayBufferView) => decodeJsonPayload(bytesFromDataChannel(data), { key: keys.kData, encrypted: true })
            }
          : {
              seal: async (frame: unknown) => JSON.stringify(frame),
              open: async (data: string | ArrayBuffer | ArrayBufferView) => JSON.parse(textFromDataChannel(data)) as unknown
            },
        auth,
        localProtocolHello
      }
      if (this.options.localStablePeerId !== undefined) sessionOptions.localStableId = this.options.localStablePeerId
      if (profile.expectedSignalingPeerId !== undefined) sessionOptions.expectedRemoteSignalingId = profile.expectedSignalingPeerId
      if (profile.expectedStablePeerId !== undefined) sessionOptions.expectedRemoteStableId = profile.expectedStablePeerId
      if (this.options.random !== undefined) sessionOptions.random = this.options.random
      const session = new WebRtcPeerSession(sessionOptions)
      this.session = session
      this.signaling = signaling
      this.activeProfile = profile
      session.subscribe((snapshot) => this.handleSessionSnapshot(snapshot, profile))
      await session.start()
    } catch (error) {
      this.activeLocalProtocolHello = null
      this.zeroKeyMaterial()
      throw error
    }
  }

  async confirmPairing(sessionId: string): Promise<void> {
    const pending = this.pendingPairing
    if (!pending || pending.pairingSessionId !== sessionId) throw new AuroraError({ code: 'validation', message: 'No matching WebRTC pairing session is pending.' })
    await this.session?.confirmSas(pending.verificationCode)
    this.pendingPairing = null
    this.emit()
  }

  async rejectPairing(sessionId: string): Promise<void> {
    const pending = this.pendingPairing
    if (!pending || pending.pairingSessionId !== sessionId) throw new AuroraError({ code: 'validation', message: 'No matching WebRTC pairing session is pending.' })
    this.pendingPairing = null
    await this.disconnect('pairing rejected')
  }

  async getSelectedCandidatePairEvidence() {
    return await this.session?.getSelectedCandidatePairEvidence() ?? { selected: false, category: 'unknown', statsSource: 'RTCPeerConnection.getStats', rawAddressRedacted: true as const }
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    this.removeVisibilityListener?.()
    this.removeVisibilityListener = undefined
    this.bridge?.close(reason)
    this.bridge = null
    this.meshTransport = null
    const session = this.session
    this.session = null
    const signaling = this.signaling
    this.signaling = null
    this.pendingPairing = null
    this.activeProfile = null
    this.activeLocalProtocolHello = null
    this.zeroKeyMaterial()
    if (session) await session.close()
    else if (signaling) await signaling.close(reason)
    this.handleSessionSnapshot(null, this.fixedProfile)
  }

  isAuthorized(): boolean {
    return this.session?.getSnapshot().authorized === true
  }

  hasEstablishedAuthorizedRoute(): boolean {
    return this.establishedAuthorizedRoute
  }


  private zeroKeyMaterial(): void {
    if (!this.keyMaterial) return
    zeroBytes(this.keyMaterial.k0)
    zeroBytes(this.keyMaterial.kSig)
    zeroBytes(this.keyMaterial.kData)
    this.keyMaterial = null
  }

  private requiredProfile(): WebRtcPeerConnectionProfile {
    if (!this.fixedProfile) throw new AuroraError({ code: 'validation', message: 'A WebRTC peer profile is required to connect.' })
    return this.fixedProfile
  }

  private handleSessionSnapshot(snapshot: PeerSessionSnapshot | null, profile: WebRtcPeerConnectionProfile | undefined): void {
    if (snapshot?.authorized && profile?.expectedStablePeerId && !this.meshTransport && this.session) {
      this.installAuthorizedBridge(this.session, profile)
    }
    this.lastSnapshot = this.snapshotFromSession(snapshot, profile)
    this.emit()
  }


  private installAuthorizedBridge(session: WebRtcPeerSession, profile: WebRtcPeerConnectionProfile): void {
    if (!profile.expectedStablePeerId) return
    const bridgeOptions = {
      session,
      remotePeerId: profile.expectedStablePeerId,
      localPeerRole: this.options.nodeRole === 'mesh-node' ? 'hybrid' as const : 'consumer' as const,
      ...(this.options.peerHost ? { peerHost: this.options.peerHost } : {}),
      ...(this.activeLocalProtocolHello
        ? { localProtocolHello: this.activeLocalProtocolHello }
        : {})
    }
    this.bridge = new WebRtcMeshPeerBridge(bridgeOptions)
    const meshOptions = {
      bridge: this.bridge,
      defaultPeerId: profile.expectedStablePeerId
    } as import('../mesh.js').MeshP2PTransportOptions
    if (this.options.routeResolver !== undefined) meshOptions.routeResolver = this.options.routeResolver
    if (this.options.defaultTimeoutMs !== undefined) meshOptions.defaultTimeoutMs = this.options.defaultTimeoutMs
    if (this.options.fallbackPeerIds !== undefined) meshOptions.fallbackPeerIds = this.options.fallbackPeerIds
    this.meshTransport = new MeshP2PTransport(meshOptions)
    this.establishedAuthorizedRoute = true
    this.recordDiagnostic('webrtc_mesh_authorized', 'WebRTC mesh transport authorized')
  }

  noteFallback(code: string, method: string): void {
    this.recordDiagnostic(code, `HTTP fallback selected for ${method}`)
  }

  noteUnavailable(code: string, method: string): void {
    this.recordDiagnostic(code, `WebRTC preferred route unavailable for ${method}`)
  }

  private snapshotFromSession(snapshot: PeerSessionSnapshot | null, profile: WebRtcPeerConnectionProfile | undefined): PeerConnectionSnapshot {
    const bridgeDiagnostics = this.bridge?.getDiagnostics?.()
    const lastDiagnostic = this.diagnostics[this.diagnostics.length - 1]
    return {
      state: snapshot?.state ?? (this.mode === 'http-only' ? 'idle' : 'closed'),
      connectionMode: this.mode,
      expectedStablePeerId: profile?.expectedStablePeerId,
      connectedStablePeerId: snapshot?.remoteStableId,
      connectedSignalingPeerId: snapshot?.remoteSignalingId,
      negotiationRole: snapshot?.role,
      nodeName: profile?.nodeName,
      selectedSignalingBrokerOrigin: this.signaling?.snapshot().selectedBrokerOrigin,
      icePathCategory: snapshot?.icePath ?? 'unknown',
      protocolCapabilities: bridgeDiagnostics?.remoteProtocolCapabilities ?? [],
      reconnectCount: snapshot?.reconnectAttempts ?? this.signaling?.snapshot().reconnectCount ?? 0,
      pendingCallCount: bridgeDiagnostics?.pendingCallCount ?? 0,
      pendingStreamCount: bridgeDiagnostics?.pendingStreamCount ?? 0,
      pendingSubscriptionCount: bridgeDiagnostics?.pendingSubscriptionCount ?? 0,
      pendingFragmentCount: bridgeDiagnostics?.pendingFragmentCount ?? 0,
      bufferPressureHighWaterBytes: bridgeDiagnostics?.bufferPressureHighWaterBytes ?? 0,
      sentFragmentCount: bridgeDiagnostics?.sentFragmentCount ?? 0,
      receivedFragmentCount: bridgeDiagnostics?.receivedFragmentCount ?? 0,
      lastRedactedError: snapshot?.lastError ? diagnostic('session_error', snapshot.lastError) : lastDiagnostic,
      updatedAt: new Date().toISOString(),
      ...(this.pendingPairing ? { pendingPairing: { sessionId: this.pendingPairing.pairingSessionId, verificationCode: this.pendingPairing.verificationCode, remoteStablePeerId: this.pendingPairing.remoteStablePeerId, remoteNodeName: this.pendingPairing.remoteNodeName } } : {})
    } as PeerConnectionSnapshot
  }

  private recordDiagnostic(code: string, message: string): void {
    this.diagnostics.push(diagnostic(code, message))
    if (this.diagnostics.length > 20) this.diagnostics.splice(0, this.diagnostics.length - 20)
    this.emit()
  }

  private installVisibilityHook(): void {
    if (!this.visibilityDocument) return
    const handler = () => {
      if (this.visibilityDocument?.visibilityState === 'hidden') this.recordDiagnostic('page_hidden', 'WebRTC thin shell is running in a hidden document; browser throttling may delay signaling or media callbacks.')
    }
    this.visibilityDocument.addEventListener('visibilitychange', handler)
    this.removeVisibilityListener = () => this.visibilityDocument?.removeEventListener('visibilitychange', handler)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot())
  }
}

class RuntimeSignalingPort implements PeerSessionSignalingPort {
  constructor(private readonly signaling: MqttWebSocketSignalingClient, private readonly room: MqttSignalingRoom) {}
  async connect(): Promise<void> { await this.signaling.connect(this.room) }
  async close(): Promise<void> { await this.signaling.close() }
  async publish(channel: SignalingChannel, envelope: Record<string, unknown>, toPeer?: string): Promise<void> {
    if (channel === 'presence') return
    if (channel === 'broadcast') await this.signaling.send('broadcast', envelope as import('./signaling-mqtt.js').MqttSignalingEnvelope)
    else await this.signaling.send(channel, envelope as import('./signaling-mqtt.js').MqttSignalingEnvelope, toPeer ?? String(envelope.to ?? ''))
  }
  subscribe(listener: (message: SignalingMessage) => void): () => void {
    return this.signaling.onMessage((message) => listener({
      channel: message.channel,
      from: message.from,
      stablePeerId: message.stablePeerId,
      envelope: message.envelope
    }))
  }
}

class RuntimePeerAuth implements PeerSessionAuthPort {
  private handshake: PairingSasHandshake | null = null
  private handshakePromise: Promise<PairingSasHandshake> | null = null
  private pairing: PairingSasResult | null = null
  private sentCommit = false
  private commitPromise: Promise<void> | null = null
  private sentReveal = false
  private sentAuthFrame = false
  private awaitingGatewayHello = false
  private pairingHandle: string | null = null
  private inboundPairingHandle: string | null = null
  private issuedInboundCredential: {
    mode: 'legacy'
    token: string
    tokenId: string
    pairingSessionId: string
  } | {
    mode: 'durable'
    selector: PeerRelationshipSelector
    tokenHashHex: string
    credentialRevision: number
    pairingSessionId: string
  } | null = null
  private localSasConfirmed = false
  private pairingConnectPromise: Promise<PeerSessionAuthFrameResult> | null = null
  private readonly pairingConnectPoll: PairingConnectPollOptions
  private readonly pendingCalls = new Map<string, { method: string; resolve(value: Record<string, unknown> | null): void; timer: ReturnType<typeof setTimeout> }>()
  private reconnectWaiter: ((result: PeerSessionAuthFrameResult) => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: {
    profile: WebRtcPeerConnectionProfile
    credentialStore?: InternalPeerCredentialStore | undefined
    localStablePeerId: string
    localNodeName: string
    onPairing(pairing: PairingSasResult): void
    onDiagnostic(code: string, message: string): void
    randomId?: (() => string) | undefined
    pairingConnectPoll?: Partial<PairingConnectPollOptions> | undefined
    peerAuthorityResolver?: PeerAuthorityResolver | undefined
    peerPairingIssuer?: PeerPairingIssuer | undefined
  }) {
    this.pairingConnectPoll = { ...DEFAULT_PAIRING_CONNECT_POLL, ...options.pairingConnectPoll }
  }

  async tryReconnect(context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    if (this.options.peerAuthorityResolver !== undefined) {
      let issued = false
      try {
        issued = await this.issueVerifierReconnectChallenge(context)
      } catch {
        this.options.onDiagnostic(
          'webrtc_reconnect_challenge_unavailable',
          'Reconnect verification is unavailable; pairing was not attempted.'
        )
        return { denied: true, terminal: true }
      }
      if (issued) {
        this.resolveReconnectWait(undefined)
        return await new Promise<PeerSessionAuthFrameResult>((resolve) => {
          this.reconnectWaiter = resolve
          this.reconnectTimer = setTimeout(() => this.resolveReconnectWait(undefined), 1500)
        })
      }
    }
    const peerId = this.options.profile.expectedStablePeerId ?? ''
    if (!peerId || !this.options.credentialStore) return undefined
    try {
      if (this.options.credentialStore.status !== undefined) {
        const status = await this.options.credentialStore.status(peerId)
        if (!status.found) return undefined
      } else if ((await this.options.credentialStore.get(peerId)) === undefined) {
        return undefined
      }
    } catch {
      this.options.onDiagnostic(
        'webrtc_reconnect_store_unavailable',
        'Native reconnect storage is unavailable; pairing was not attempted.'
      )
      return { denied: true, terminal: true }
    }
    this.resolveReconnectWait(undefined)
    return await new Promise<PeerSessionAuthFrameResult>((resolve) => {
      this.reconnectWaiter = resolve
      this.reconnectTimer = setTimeout(() => this.resolveReconnectWait(undefined), 1500)
    })
  }

  private resolveReconnectWait(result: PeerSessionAuthFrameResult): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const resolve = this.reconnectWaiter
    this.reconnectWaiter = null
    if (resolve) resolve(result)
  }

  async startPairing(context: PeerSessionAuthContext): Promise<void> {
    await this.ensureHandshake(context)
    await this.sendCommit(context)
  }

  async confirmPairing(code: string, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    if (!this.pairing || this.pairing.verificationCode !== code) return { denied: true, terminal: true }
    this.localSasConfirmed = true
    this.handshake?.confirm()
    if (this.pairingHandle) return await this.pollPairingConnect(context, this.pairingHandle)
    return undefined
  }

  async handleFrame(frame: unknown, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    if (!isRecord(frame)) return undefined
    const type = frame.type
    if (type === 'result' || type === 'error') {
      return this.resolveRpcFrame(frame) ? { handled: true } : undefined
    }
    if (type === 'call') {
      return await this.handleInboundAuthCall(frame, context)
    }
    if (type === 'auth') {
      return this.handleInboundAuthFrame(frame, context)
    }
    if (type === 'protocol_hello') {
      if (this.awaitingGatewayHello || this.sentAuthFrame) {
        const result = { authenticated: true }
        this.resolveReconnectWait(result)
        return result
      }
      return undefined
    }
    if (type === 'auth_success' || type === 'authenticated') {
      this.options.onDiagnostic('unsupported_auth_signal', 'Ignoring unsupported WebRTC auth success signal')
      return undefined
    }
    if (type === 'mesh_auth_challenge_v1') {
      const proof = await createReconnectProof(this.options.credentialStore, this.options.profile.expectedStablePeerId ?? '', frame as unknown as MeshReconnectChallengeMessage)
      if (proof) {
        await context.sendControlFrame(proof)
        this.awaitingGatewayHello = true
      } else {
        this.resolveReconnectWait(undefined)
        await this.startPairing(context)
      }
      return undefined
    }
    if (type === 'mesh_auth_proof_v1' && this.options.peerAuthorityResolver !== undefined) {
      return await this.handleInboundReconnectProof(frame, context)
    }
    if (type === 'pairing_v2_commit') {
      const handshake = await this.ensureHandshake(context)
      handshake.acceptCommit(parsePairingCommitMessage(frame))
      await this.sendCommit(context)
      await this.sendReveal(context)
      return undefined
    }
    if (type === 'pairing_v2_reveal') {
      const handshake = await this.ensureHandshake(context)
      this.pairing = await handshake.acceptReveal(parsePairingRevealMessage(frame))
      this.options.onPairing(this.pairing)
      return await this.beginGatewayPairing(context)
    }
    if (type === 'pairing_v2_terminal') {
      const terminal = parsePairingTerminalMessage(frame)
      this.options.onDiagnostic('pairing_terminal', `Pairing ended with ${terminal.status}`)
      return terminal.status === 'denied' ? { denied: true, terminal: true } : undefined
    }
    return undefined
  }

  private async beginGatewayPairing(context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    if (!this.pairing) return undefined
    const result = await this.call(context, AUTH_METHODS.pairingStart, {
      device_name: this.options.localNodeName,
      remote_peer_id: this.options.localStablePeerId,
      remote_node_name: this.options.localNodeName,
      room_name: this.options.profile.room,
      pairing_session_id: this.pairing.pairingSessionId,
      verification_code: this.pairing.verificationCode
    })
    if (!result || result.error) {
      this.options.onDiagnostic('pairing_start_failed', 'Pairing initiation failed')
      return undefined
    }
    if (result.status === 'denied') {
      this.options.onDiagnostic('pairing_denied', 'Pairing was denied by the remote endpoint')
      return { denied: true, terminal: true }
    }
    if (result.pairing_session_id !== this.pairing.pairingSessionId || result.verification_code !== this.pairing.verificationCode) {
      throw new PairingProtocolError('Remote PairingStart response does not match the SAS')
    }
    const handle = typeof result.code === 'string' ? result.code : ''
    if (!handle || handle === this.pairing.verificationCode) throw new PairingProtocolError('Remote reused the display code as a pairing credential')
    this.pairingHandle = handle
    if (this.localSasConfirmed) return await this.pollPairingConnect(context, handle)
    return undefined
  }

  private async pollPairingConnect(context: PeerSessionAuthContext, handle: string): Promise<PeerSessionAuthFrameResult> {
    if (this.pairingConnectPromise) return await this.pairingConnectPromise
    this.pairingConnectPromise = this.pollPairingConnectOnce(context, handle).finally(() => {
      this.pairingConnectPromise = null
    })
    return await this.pairingConnectPromise
  }

  private async pollPairingConnectOnce(context: PeerSessionAuthContext, handle: string): Promise<PeerSessionAuthFrameResult> {
    for (let attempt = 1; attempt <= this.pairingConnectPoll.maxAttempts; attempt += 1) {
      if (!this.pairing) return undefined
      const result = await this.call(context, AUTH_METHODS.pairingConnect, {
        code: handle,
        pairing_session_id: this.pairing.pairingSessionId
      }, this.pairingConnectPoll.rpcTimeoutMs)
      if (result && !result.error) {
        if (result.pairing_session_id !== this.pairing.pairingSessionId || result.verification_code !== this.pairing.verificationCode) {
          throw new PairingProtocolError('Remote pairing status belongs to another SAS')
        }
        const status = String(result.status ?? '')
        if (status === 'approved') {
          await this.sendPairingExchange(context, handle)
          return undefined
        }
        if (status === 'denied' || status === 'expired' || status === 'superseded') {
          this.options.onDiagnostic(`pairing_${status}`, `Pairing was ${status} by the remote endpoint`)
          return { denied: true, terminal: true }
        }
        if (status && status !== 'pending') this.options.onDiagnostic('pairing_not_ready', `Pairing status ${status}`)
      }
      if (attempt < this.pairingConnectPoll.maxAttempts) await sleep(Math.min(this.pairingConnectPoll.maxDelayMs, this.pairingConnectPoll.initialDelayMs * 2 ** (attempt - 1)))
    }
    this.options.onDiagnostic('pairing_timeout', 'Pairing approval timed out')
    return { denied: true, terminal: true }
  }

  private async sendPairingExchange(context: PeerSessionAuthContext, handle: string): Promise<void> {
    if (!this.pairing) return
    const result = await this.call(context, AUTH_METHODS.pairingExchange, {
      code: handle,
      pairing_session_id: this.pairing.pairingSessionId
    })
    const token = typeof result?.token === 'string' ? result.token : ''
    if (!token) {
      this.options.onDiagnostic('pairing_exchange_failed', 'Credential exchange failed')
      return
    }
    const tokenId = typeof result?.token_id === 'string' ? result.token_id : ''
    if (!tokenId) throw new PairingProtocolError('Credential exchange omitted its reconnect token id')
    const claimedPeerId = typeof result?.peer_id === 'string' ? result.peer_id : ''
    if (claimedPeerId && claimedPeerId !== this.pairing.remoteStablePeerId) throw new PairingProtocolError('Credential issuer identity does not match the SAS')
    await this.options.credentialStore?.save(this.pairing.remoteStablePeerId, {
      tokenId,
      claimantPeerId: this.options.localStablePeerId,
      verifierPeerId: this.pairing.remoteStablePeerId,
      claimantSignalingPeerId: context.localSignalingId,
      verifierSignalingPeerId: context.remoteSignalingId,
      roomName: this.options.profile.room,
      rawBearerToken: token
    })
    await context.sendControlFrame({
      type: 'auth',
      peer_name: this.options.localNodeName,
      peer_id: this.options.localStablePeerId,
      signaling_peer_id: context.localSignalingId,
      pairing_session_id: this.pairing.pairingSessionId,
      token
    })
    this.sentAuthFrame = true
    this.awaitingGatewayHello = true
  }

  private async handleInboundAuthCall(frame: Record<string, unknown>, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const method = typeof frame.method === 'string' ? frame.method : ''
    const params = isRecord(frame.params) ? frame.params : {}
    if (method !== AUTH_METHODS.pairingStart && method !== AUTH_METHODS.pairingConnect && method !== AUTH_METHODS.pairingExchange) return undefined
    try {
      let result: Record<string, unknown>
      if (method === AUTH_METHODS.pairingStart) {
        result = this.handleInboundPairingStart(params)
      } else if (method === AUTH_METHODS.pairingConnect) {
        result = this.handleInboundPairingConnect(params)
      } else {
        result = await this.handleInboundPairingExchange(params, context)
      }
      await context.sendControlFrame({ type: 'result', id, result })
    } catch (error) {
      await context.sendControlFrame({ type: 'error', id, correlation_id: id, error: { code: 409, message: error instanceof Error ? error.message : 'Pairing request rejected' } })
    }
    return { handled: true }
  }

  private handleInboundPairingStart(params: Record<string, unknown>): Record<string, unknown> {
    const pairing = this.requireInboundPairingContext(params, true)
    this.assertInboundPairingIdentity(params, pairing)
    if (this.inboundPairingHandle === null) {
      this.inboundPairingHandle = `thin-${bytesToBase64Url(randomBytes(18))}`
    }
    return {
      code: this.inboundPairingHandle,
      expires_in_seconds: 300,
      pairing_session_id: pairing.pairingSessionId,
      verification_code: pairing.verificationCode,
      status: this.localSasConfirmed ? 'approved' : 'pending'
    }
  }

  private handleInboundPairingConnect(params: Record<string, unknown>): Record<string, unknown> {
    const pairing = this.requireInboundPairingContext(params, false)
    this.assertInboundHandle(params)
    return {
      request_id: this.inboundPairingHandle,
      device_name: pairing.remoteNodeName || pairing.remoteStablePeerId,
      status: this.localSasConfirmed ? 'approved' : 'pending',
      pairing_session_id: pairing.pairingSessionId,
      verification_code: pairing.verificationCode
    }
  }

  private async handleInboundPairingExchange(params: Record<string, unknown>, context: PeerSessionAuthContext): Promise<Record<string, unknown>> {
    const pairing = this.requireInboundPairingContext(params, false)
    this.assertInboundHandle(params)
    if (!this.localSasConfirmed) throw new PairingProtocolError('Pairing has not been approved locally')
    if (this.options.peerPairingIssuer !== undefined) {
      if (this.issuedInboundCredential !== null) throw new PairingProtocolError('Pairing credential was already issued')
      const selector: PeerRelationshipSelector = {
        tokenId: boundedTokenId(),
        claimantPeerId: pairing.remoteStablePeerId,
        verifierPeerId: this.options.localStablePeerId,
        roomName: this.options.profile.room
      }
      const issued = await this.options.peerPairingIssuer.issue(selector)
      this.issuedInboundCredential = {
        mode: 'durable',
        selector: {
          tokenId: issued.verifier.tokenId,
          claimantPeerId: issued.verifier.claimantPeerId,
          verifierPeerId: issued.verifier.verifierPeerId,
          roomName: issued.verifier.roomName
        },
        tokenHashHex: issued.verifier.tokenHashHex,
        credentialRevision: issued.verifier.credentialRevision,
        pairingSessionId: pairing.pairingSessionId
      }
      return {
        token: issued.bearerToken,
        token_id: issued.tokenId,
        device_id: context.localStableId ?? this.options.localStablePeerId,
        user_id: this.options.localStablePeerId,
        permissions: [],
        peer_id: this.options.localStablePeerId,
        node_name: this.options.localNodeName
      }
    }
    if (this.issuedInboundCredential === null) {
      this.issuedInboundCredential = {
        mode: 'legacy',
        token: `thin-token-${bytesToBase64Url(randomBytes(32))}`,
        tokenId: `thin-token-row-${bytesToBase64Url(randomBytes(18))}`,
        pairingSessionId: pairing.pairingSessionId
      }
    }
    if (this.issuedInboundCredential.mode !== 'legacy') throw new PairingProtocolError('Pairing credential was already issued')
    return {
      token: this.issuedInboundCredential.token,
      token_id: this.issuedInboundCredential.tokenId,
      device_id: context.localStableId ?? this.options.localStablePeerId,
      user_id: this.options.localStablePeerId,
      permissions: [],
      peer_id: this.options.localStablePeerId,
      node_name: this.options.localNodeName
    }
  }

  private async handleInboundAuthFrame(frame: Record<string, unknown>, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    const pairing = this.pairing
    const credential = this.issuedInboundCredential
    if (!pairing || !credential) return undefined
    const token = typeof frame.token === 'string' ? frame.token : ''
    if (credential.mode === 'durable') {
      const transport = await this.currentInboundTransport(context)
      const actualHash = await sha256Bytes(token)
      const expectedHash = hexToBytes(credential.tokenHashHex)
      try {
        const matches = frame.pairing_session_id === credential.pairingSessionId &&
          frame.peer_id === pairing.remoteStablePeerId &&
          frame.signaling_peer_id === context.remoteSignalingId &&
          transport.claimantSignalingPeerId === context.remoteSignalingId &&
          transport.verifierSignalingPeerId === context.localSignalingId &&
          constantTimeEqual(actualHash, expectedHash)
        if (!matches) return { handled: true, denied: true, terminal: true }
        return {
          handled: true,
          authenticated: true,
          authenticatedPeerContext: {
            selector: { ...credential.selector },
            transport,
            credentialRevision: credential.credentialRevision,
            authenticatedAtMs: Date.now()
          }
        }
      } finally {
        zeroBytes(actualHash)
        zeroBytes(expectedHash)
      }
    }
    const expectedToken = new TextEncoder().encode(credential.token)
    const actualToken = new TextEncoder().encode(token)
    const matches = frame.pairing_session_id === credential.pairingSessionId &&
      frame.peer_id === pairing.remoteStablePeerId &&
      frame.signaling_peer_id === context.remoteSignalingId &&
      constantTimeEqual(actualToken, expectedToken)
    actualToken.fill(0)
    expectedToken.fill(0)
    if (!matches) return { handled: true, denied: true, terminal: true }
    return { handled: true, authenticated: true }
  }

  private async issueVerifierReconnectChallenge(context: PeerSessionAuthContext): Promise<boolean> {
    const claimantPeerId = this.options.profile.expectedStablePeerId ?? context.remoteStableId
    if (!claimantPeerId || !context.offerSdp || !context.answerSdp) return false
    const transport = await this.currentInboundTransport(context)
    const challenge = await this.options.peerAuthorityResolver!.issueReconnectChallenge({
      identity: {
        claimantPeerId,
        verifierPeerId: this.options.localStablePeerId,
        roomName: this.options.profile.room
      },
      transport,
      nowMs: Date.now()
    })
    await context.sendControlFrame({
      type: 'mesh_auth_challenge_v1',
      challenge: challenge.challenge,
      channel_binding: transport.channelBinding,
      claimant_peer_id: claimantPeerId,
      verifier_peer_id: this.options.localStablePeerId,
      claimant_signaling_peer_id: transport.claimantSignalingPeerId,
      verifier_signaling_peer_id: transport.verifierSignalingPeerId,
      room_name: this.options.profile.room
    })
    return true
  }

  private async currentInboundTransport(context: PeerSessionAuthContext) {
    return {
      channelBinding: await reconnectChannelBinding(this.options.profile, context),
      claimantSignalingPeerId: context.remoteSignalingId,
      verifierSignalingPeerId: context.localSignalingId
    }
  }

  private async handleInboundReconnectProof(frame: Record<string, unknown>, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    const expectedClaimantPeerId = this.options.profile.expectedStablePeerId ?? context.remoteStableId
    const verifierPeerId = this.options.localStablePeerId
    if (!expectedClaimantPeerId || !context.offerSdp || !context.answerSdp) return { handled: true, denied: true, terminal: true }
    const tokenId = stringField(frame, 'token_id')
    const challenge = hex64Field(frame, 'challenge')
    const proofHex = hex64Field(frame, 'proof')
    const channelBinding = hex64Field(frame, 'channel_binding')
    const claimantPeerId = stringField(frame, 'claimant_peer_id')
    const proofVerifierPeerId = stringField(frame, 'verifier_peer_id')
    const claimantSignalingPeerId = stringField(frame, 'claimant_signaling_peer_id')
    const verifierSignalingPeerId = stringField(frame, 'verifier_signaling_peer_id')
    const roomName = stringField(frame, 'room_name')
    if (
      tokenId === null ||
      challenge === null ||
      proofHex === null ||
      channelBinding === null ||
      claimantPeerId !== expectedClaimantPeerId ||
      proofVerifierPeerId !== verifierPeerId ||
      claimantSignalingPeerId !== context.remoteSignalingId ||
      verifierSignalingPeerId !== context.localSignalingId ||
      roomName !== this.options.profile.room
    ) {
      return { handled: true, denied: true, terminal: true }
    }
    const expectedChannelBinding = await reconnectChannelBinding(this.options.profile, context)
    if (channelBinding !== expectedChannelBinding) return { handled: true, denied: true, terminal: true }
    const result = await this.options.peerAuthorityResolver!.verifyReconnectProof({
      proofHex,
      challenge,
      selector: {
        tokenId,
        claimantPeerId,
        verifierPeerId,
        roomName
      },
      transport: {
        channelBinding,
        claimantSignalingPeerId,
        verifierSignalingPeerId
      },
      nowMs: Date.now()
    })
    if (!result.ok || result.context === undefined) return { handled: true, denied: true, terminal: true }
    const authenticated = { handled: true, authenticated: true, authenticatedPeerContext: result.context }
    this.resolveReconnectWait(authenticated)
    return authenticated
  }

  private requireInboundPairingContext(params: Record<string, unknown>, requireVerificationCode: boolean): PairingSasResult {
    const pairing = this.pairing
    if (!pairing) throw new PairingProtocolError('Pairing verification handshake is not ready')
    if (
      params.pairing_session_id !== pairing.pairingSessionId ||
      (requireVerificationCode && params.verification_code !== pairing.verificationCode) ||
      (!requireVerificationCode && params.verification_code !== undefined && params.verification_code !== pairing.verificationCode)
    ) {
      throw new PairingProtocolError('Pairing transcript mismatch')
    }
    return pairing
  }

  private assertInboundPairingIdentity(params: Record<string, unknown>, pairing: PairingSasResult): void {
    if (params.room_name !== undefined && params.room_name !== this.options.profile.room) throw new PairingProtocolError('Pairing room mismatch')
    if (params.remote_peer_id !== undefined && params.remote_peer_id !== pairing.remoteStablePeerId) throw new PairingProtocolError('Pairing peer identity mismatch')
    if (pairing.remoteNodeName && params.remote_node_name !== undefined && params.remote_node_name !== pairing.remoteNodeName) throw new PairingProtocolError('Pairing node identity mismatch')
  }

  private assertInboundHandle(params: Record<string, unknown>): void {
    if (!this.inboundPairingHandle || params.code !== this.inboundPairingHandle) {
      throw new PairingProtocolError('Invalid or expired pairing handle')
    }
  }

  private async call(context: PeerSessionAuthContext, method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_PAIRING_CONNECT_POLL.rpcTimeoutMs): Promise<Record<string, unknown> | null> {
    const id = this.options.randomId?.() ?? `auth-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    const response = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pendingCalls.set(id, { method, resolve, timer })
    })
    await context.sendControlFrame({ type: 'call', id, method, params })
    return response
  }

  private resolveRpcFrame(frame: Record<string, unknown>): boolean {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const pending = this.pendingCalls.get(id)
    if (!pending) return false
    this.pendingCalls.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(frame.type === 'result' && isRecord(frame.result) ? frame.result : null)
    return true
  }

  private async ensureHandshake(context: PeerSessionAuthContext): Promise<PairingSasHandshake> {
    if (this.handshake) return this.handshake
    if (this.handshakePromise) return await this.handshakePromise
    this.handshakePromise = this.createHandshake(context).then((handshake) => {
      this.handshake = handshake
      return handshake
    }).catch((error) => {
      this.handshakePromise = null
      throw error
    })
    return await this.handshakePromise
  }

  private async createHandshake(context: PeerSessionAuthContext): Promise<PairingSasHandshake> {
    const expectedRemoteStableId = this.options.profile.expectedStablePeerId ?? context.remoteStableId
    if (!expectedRemoteStableId) throw new PairingProtocolError('Expected remote stable peer id is required for WebRTC pairing')
    if (!context.offerSdp || !context.answerSdp) throw new PairingProtocolError('WebRTC SDP transcript is required for SAS pairing')
    const localRole = context.localSignalingId < context.remoteSignalingId ? 'offerer' : 'answerer'
    const remoteRole = localRole === 'offerer' ? 'answerer' : 'offerer'
    return new PairingSasHandshake({
      channelBindingSha256: await deriveChannelBinding({
        appId: this.options.profile.appId,
        room: this.options.profile.room,
        offererSignalingId: localRole === 'offerer' ? context.localSignalingId : context.remoteSignalingId,
        answererSignalingId: localRole === 'answerer' ? context.localSignalingId : context.remoteSignalingId,
        offerSdp: context.offerSdp,
        answerSdp: context.answerSdp
      }),
      localIdentity: pairingIdentity({
        role: localRole,
        stablePeerId: this.options.localStablePeerId,
        signalingPeerId: context.localSignalingId,
        nodeName: this.options.localNodeName
      }),
      expectedRemoteIdentity: pairingIdentity({
        role: remoteRole,
        stablePeerId: expectedRemoteStableId,
        signalingPeerId: context.remoteSignalingId,
        nodeName: this.options.profile.nodeName ?? ''
      })
    })
  }

  private async sendCommit(context: PeerSessionAuthContext): Promise<void> {
    if (this.sentCommit || !this.handshake) return
    if (this.commitPromise) return await this.commitPromise
    this.commitPromise = this.sendCommitOnce(context).catch((error) => {
      this.sentCommit = false
      this.commitPromise = null
      throw error
    })
    return await this.commitPromise
  }

  private async sendCommitOnce(context: PeerSessionAuthContext): Promise<void> {
    if (!this.handshake) return
    this.sentCommit = true
    const commit: PairingCommitMessage = await this.handshake.commitMessage()
    await context.sendControlFrame(commit)
  }

  private async sendReveal(context: PeerSessionAuthContext): Promise<void> {
    if (this.sentReveal || !this.handshake) return
    const reveal: PairingRevealMessage = this.handshake.revealMessage()
    this.sentReveal = true
    await context.sendControlFrame(reveal)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function deriveRoomKeysFromProfile(profile: WebRtcPeerConnectionProfile, options: BrowserWebRtcRuntimeOptions<unknown>) {
  const secret = await resolveRoomSecret(profile, options)
  try {
    const deriveOptions: Parameters<typeof deriveRoomKeys>[3] = {}
    if (options.scryptDeriver !== undefined) deriveOptions.scryptDeriver = options.scryptDeriver
    if (options.scryptWorkerFactory !== undefined) deriveOptions.scryptWorkerFactory = options.scryptWorkerFactory
    return await deriveRoomKeys(secret, profile.appId, profile.room, deriveOptions)
  } finally {
    // Strings cannot be zeroed, but custom stores can keep their source memory-only.
  }
}

async function resolveRoomSecret(profile: WebRtcPeerConnectionProfile, options: BrowserWebRtcRuntimeOptions<unknown>): Promise<string> {
  const store = options.credentialStore as (InternalPeerCredentialStore & { getRoomSecret?: (ref: string) => Promise<Uint8Array | string | null> }) | undefined
  const value = await store?.getRoomSecret?.(profile.roomSecretRef)
  if (typeof value === 'string' && value.length > 0) return value
  if (value instanceof Uint8Array && value.byteLength > 0) return new TextDecoder().decode(value)
  if (profile.roomSecretRef.length > 0 && !profile.roomSecretRef.startsWith('ref:')) return profile.roomSecretRef
  throw new AuroraError({ code: 'auth', message: 'WebRTC room secret is unavailable; thin runtime keeps credentials memory-only.' })
}

function iceServersFromProfile(profile: WebRtcPeerConnectionProfile): Array<{ urls: string | string[] }> {
  return [...(profile.stunServers ?? []), ...(profile.turnServers ?? [])].map((url) => ({ urls: url }))
}

function buildLocalProtocolHello(
  options: BrowserWebRtcRuntimeOptions<unknown>
): Record<string, unknown> {
  const configured = options.localProtocolCapabilities ?? [
    CAP_FRAGMENTATION_V1,
    CAP_BACKPRESSURE_V1,
    CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  ]
  if (options.nodeRole === 'mesh-node') {
    return buildProtocolHello({
      role: 'hybrid',
      capabilities: [...new Set([...configured, CAP_PROVIDER_LEASE_V1])]
    })
  }
  return buildProtocolHello({
    role: 'consumer',
    capabilities: [...new Set([...configured, CAP_CONSUMER_ONLY_V1])]
  })
}

function resolveAppLayerE2eeEnabled(
  profile: WebRtcPeerConnectionProfile,
  options: BrowserWebRtcRuntimeOptions<unknown>
): boolean {
  const profileEnablesE2ee = profile.requireAppLayerE2ee !== false
  if (profileEnablesE2ee && options.appLayerE2eeAllowed === false) {
    throw new AuroraError({
      code: 'unsupported_feature',
      message: 'This WebRTC profile requires application-layer E2EE, but the local rollout gate disables it.'
    })
  }
  return profileEnablesE2ee
}

function assertSecureRuntime(profile: WebRtcPeerConnectionProfile, options: BrowserWebRtcRuntimeOptions<unknown>): void {
  const location = options.windowLocation ?? (typeof window === 'undefined' ? undefined : window.location)
  if (!location) return
  if (location.protocol === 'https:') return
  if ((options.allowInsecureLoopback || profile.allowInsecureLoopbackSignaling) && isLoopbackHost(location.hostname)) return
  throw new AuroraError({ code: 'native_permission_missing', message: 'WebRTC thin shell requires a secure browser/WebView context.' })
}

function assertPeerConnectionRuntimeAvailable(
  options: BrowserWebRtcRuntimeOptions<unknown>
): void {
  if (options.createPeerConnection || globalThis.RTCPeerConnection) return
  throw new AuroraError({
    code: 'unsupported_feature',
    message: 'RTCPeerConnection is unavailable in this WebView/browser.'
  })
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === 'tauri.localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function defaultPeerConnectionFactory(configuration: RTCConfiguration): PeerConnectionLike {
  const ctor = globalThis.RTCPeerConnection
  if (!ctor) throw new AuroraError({ code: 'unsupported_feature', message: 'RTCPeerConnection is unavailable in this WebView/browser.' })
  return new ctor(configuration) as unknown as PeerConnectionLike
}

function randomBrowserId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues(bytes)
  if (bytes.some((byte) => byte !== 0)) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `thin-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function boundedTokenId(): string {
  return `thin-token-row-${bytesToBase64Url(randomBytes(18))}`
}

function bytesFromDataChannel(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function textFromDataChannel(data: string | ArrayBuffer | ArrayBufferView): string {
  return typeof data === 'string'
    ? data
    : new TextDecoder().decode(bytesFromDataChannel(data))
}

async function createReconnectProof(credentialStore: InternalPeerCredentialStore | undefined, peerId: string, challenge: MeshReconnectChallengeMessage) {
  if (!credentialStore) return undefined
  if (credentialStore.createReconnectProof) return await credentialStore.createReconnectProof(peerId, challenge)
  return await credentialStore.prove(peerId, challenge)
}

async function reconnectChannelBinding(profile: WebRtcPeerConnectionProfile, context: PeerSessionAuthContext): Promise<string> {
  if (!context.offerSdp || !context.answerSdp) throw new PairingProtocolError('WebRTC SDP transcript is required for reconnect proof')
  const localRole = context.localSignalingId < context.remoteSignalingId ? 'offerer' : 'answerer'
  return await deriveChannelBinding({
    appId: profile.appId,
    room: profile.room,
    offererSignalingId: localRole === 'offerer' ? context.localSignalingId : context.remoteSignalingId,
    answererSignalingId: localRole === 'answerer' ? context.localSignalingId : context.remoteSignalingId,
    offerSdp: context.offerSdp,
    answerSdp: context.answerSdp
  })
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function hex64Field(record: Record<string, unknown>, key: string): string | null {
  const value = stringField(record, key)
  return value !== null && /^[0-9a-f]{64}$/u.test(value) ? value : null
}

function diagnostic(code: string, message: string): RedactedPeerDiagnostic {
  return { code, message: redactDiagnostic(message), at: new Date().toISOString() }
}

function redactDiagnostic(message: string): string {
  const lowered = message.toLowerCase()
  if (/(token|password|secret|key|credential)/u.test(lowered)) return 'redacted diagnostic event'
  return message.slice(0, 240)
}


function isSafeHttpFallbackRequest(request: AuroraTransportRequest): boolean {
  const method = request.httpMethod ?? 'POST'
  if (method === 'GET') return true
  return false
}

function isFallbackEligible(error: unknown): boolean {
  return error instanceof AuroraError && (error.code === 'transport_loss' || error.code === 'timeout' || error.code === 'unavailable_service')
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
