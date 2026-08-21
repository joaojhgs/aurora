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
  type MqttSignalingPresence,
  type MqttSignalingRoom
} from './signaling-mqtt.js'
import { SignalingSessionAllowlist } from './signaling-allowlist.js'
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
import { MeshPeerBridgeRouter } from './mesh-bridge-router.js'
import {
  MeshPeerSessionRegistry,
  type MeshPeerConnectionBudget,
  type MeshDiscoveredPeer,
  type MeshPeerConnectionPolicy,
  type MeshPeerLifecycleState,
  type MeshPeerPriorityUpdate,
  type MeshPeerRegistryController,
  type MeshPeerRosterSnapshot,
  type MeshPeerSessionEntry
} from './peer-registry.js'
import type { MeshPeerStandbyFrame, MeshPeerStandbyReason } from './protocol.js'
import type { AuthenticatedPeerContext, WebRtcPeerHost } from '../peer-host/index.js'
import type { PeerAuthorityResolverPort, PeerPairingIssuerPort, PeerRelationshipSelector } from '../peer-host/authority-types.js'
import type {
  AuroraConnectionMode,
  PeerPairingApproval,
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
  maxAttempts: 0,
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
  /**
   * How many devices this surface may hold at once. Connect surfaces stay on
   * one Aurora at a time by policy; a mesh surface holds several through the
   * same registry.
   */
  peerConnectionPolicy?: MeshPeerConnectionPolicy | undefined
  peerConnectionBudget?: MeshPeerConnectionBudget | undefined
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
  peerAuthorityResolver?: PeerAuthorityResolverPort | undefined
  peerPairingIssuer?: PeerPairingIssuerPort | undefined
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

/** A peer this device has seen announce itself in the room. */
interface ObservedRoomPeer {
  readonly signalingPeerId: string
  readonly stablePeerId?: string | undefined
  readonly nodeName?: string | undefined
  readonly lastSeenAt: string
}

/** States where the session has a live channel with the peer it negotiated with. */
const ESTABLISHED_SESSION_STATES = new Set<PeerSessionSnapshot['state']>([
  'channel-open',
  'pairing-required',
  'reconnect-authenticating',
  'awaiting-sas-confirmation',
  'authorized'
])

/** States where the session is back to looking for its peer and may rebind. */
const UNBOUND_SESSION_STATES = new Set<PeerSessionSnapshot['state']>([
  'signaling-connecting',
  'discovering-peer',
  'reconnecting',
  'closed',
  'failed'
])

class WebRtcPeerConnectionController implements PeerConnectionController, MeshPeerRegistryController {
  private readonly listeners = new Set<(snapshot: PeerConnectionSnapshot) => void>()
  private readonly rosterListeners = new Set<(roster: MeshPeerRosterSnapshot) => void>()
  private readonly diagnostics: RedactedPeerDiagnostic[] = []
  /** Standby rows retained until a resumed transport is authorized. */
  private readonly resumeFallbacks = new Map<MeshPeerSessionEntry, MeshPeerSessionEntry>()
  private readonly mode: AuroraConnectionMode
  private readonly fixedProfile: WebRtcPeerConnectionProfile | undefined
  private readonly credentialStore: InternalPeerCredentialStore | undefined
  private readonly visibilityDocument: BrowserWebRtcRuntimeOptions['visibilityDocument']
  private readonly options: BrowserWebRtcRuntimeOptions<unknown>
  // One entry per stable peer id: session, signaling port, bridge, pairing
  // state. The single-peer snapshot below is a derived view over this map.
  private readonly registry: MeshPeerSessionRegistry
  // Dispatches every mesh RPC on the peer id the caller named, so one transport
  // reaches the whole registry instead of a single `defaultPeerId`.
  private readonly bridgeRouter = new MeshPeerBridgeRouter({
    resolve: (peerId) => this.registry.findByPeerId(peerId)?.bridge ?? undefined,
    reachablePeerIds: () => this.registry.list().flatMap(
      (entry) => (entry.bridge !== null && entry.peerId !== undefined ? [entry.peerId] : [])
    ),
    onRouteStart: (peerId) => this.registry.beginPeerRoute(peerId),
    onRouteEnd: (peerId) => {
      this.registry.endPeerRoute(peerId)
      void this.applyConnectionBudget()
    }
  })
  // Everyone observed announcing themselves in the room, keyed by signaling
  // identity. Discovery only: an observed peer is a candidate to connect to,
  // never an authorized one.
  private readonly observedPeers = new Map<string, ObservedRoomPeer>()
  meshTransport: MeshP2PTransport | null = null
  private primaryEntry: MeshPeerSessionEntry | null = null
  private removeVisibilityListener: (() => void) | undefined
  private establishedAuthorizedRoute = false
  private lifecycleState: MeshPeerLifecycleState = 'foreground'

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
    // The single-device Connect restriction is one policy check the registry
    // applies, not a shape the registry is stuck in.
    this.registry = new MeshPeerSessionRegistry(
      {
        ...(options.peerConnectionPolicy !== undefined ? { policy: options.peerConnectionPolicy } : {}),
        ...(options.peerConnectionBudget !== undefined ? { budget: options.peerConnectionBudget } : {})
      }
    )
    this.installVisibilityHook()
  }

  snapshot(): PeerConnectionSnapshot {
    const snapshot = this.snapshotForEntry(this.currentEntry())
    return { ...snapshot, protocolCapabilities: [...snapshot.protocolCapabilities] }
  }

  subscribe(listener: (snapshot: PeerConnectionSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  roster(): MeshPeerRosterSnapshot {
    // `primary` is the entry the single-peer snapshot and the default mesh
    // route derive from, so the roster and that derived view never disagree.
    const primary = this.currentEntry()
    const peers = this.registry.list().map((entry) => {
      const context = entry.session?.getSnapshot().authenticatedPeerContext
      return {
        peerId: entry.peerId ?? entry.key,
        primary: entry === primary,
        ...(entry.profile.nodeName !== undefined ? { nodeName: entry.profile.nodeName } : {}),
        ...(context !== undefined ? { authenticatedPeerContext: context } : {}),
        ...(entry.standby !== null ? { standby: entry.standby } : {}),
        snapshot: this.snapshotForEntry(entry)
      }
    })
    return {
      peers,
      discovered: this.discoveredPeers(),
      ...(primary?.peerId !== undefined ? { primaryPeerId: primary.peerId } : {}),
      updatedAt: new Date().toISOString()
    }
  }

  /** Everyone seen in the room, whether or not this device connected to them. */
  private discoveredPeers(): readonly MeshDiscoveredPeer[] {
    return [...this.observedPeers.values()].map((observed) => ({
      peerId: observed.stablePeerId ?? observed.signalingPeerId,
      ...(observed.stablePeerId !== undefined ? { stablePeerId: observed.stablePeerId } : {}),
      signalingPeerId: observed.signalingPeerId,
      ...(observed.nodeName !== undefined ? { nodeName: observed.nodeName } : {}),
      connected: this.registry.list().some((entry) => entry.session !== null
        && entry.peerId === observed.stablePeerId
        && entry.allowlist.signalingPeerId === observed.signalingPeerId),
      lastSeenAt: observed.lastSeenAt
    }))
  }

  private observeRoomPresence(presence: MqttSignalingPresence): void {
    const key = presence.stablePeerId ?? presence.signalingPeerId
    // A device that already holds an established session is described by that
    // session. Whoever announces its identity next does not get to rename it,
    // reset its last-seen time, or announce its departure on its behalf.
    if (this.presenceIsImpersonatingEstablishedPeer(presence)) return
    if (presence.departed) {
      if (this.observedPeers.get(key)?.signalingPeerId !== presence.signalingPeerId) return
      this.observedPeers.delete(key)
      this.emit()
      return
    }
    const observed: ObservedRoomPeer = {
      signalingPeerId: presence.signalingPeerId,
      ...(presence.stablePeerId !== undefined ? { stablePeerId: presence.stablePeerId } : {}),
      ...(presence.nodeName !== undefined ? { nodeName: presence.nodeName } : {}),
      lastSeenAt: new Date().toISOString()
    }
    const previous = this.observedPeers.get(key)
    this.observedPeers.set(key, observed)
    if (previous?.signalingPeerId === observed.signalingPeerId
      && previous.stablePeerId === observed.stablePeerId
      && previous.nodeName === observed.nodeName) return
    this.emit()
  }

  private presenceIsImpersonatingEstablishedPeer(presence: MqttSignalingPresence): boolean {
    if (presence.stablePeerId === undefined) return false
    const entry = this.registry.findByPeerId(presence.stablePeerId)
    if (entry === undefined || !entry.allowlist.established) return false
    return entry.allowlist.signalingPeerId !== presence.signalingPeerId
  }

  subscribeRoster(listener: (roster: MeshPeerRosterSnapshot) => void): () => void {
    this.rosterListeners.add(listener)
    listener(this.roster())
    return () => this.rosterListeners.delete(listener)
  }

  async getManifest(peerId: string): Promise<import('../mesh.js').MeshPeerManifest | null> {
    return await this.bridgeRouter.getManifest(peerId)
  }

  connectionPolicy(): MeshPeerConnectionPolicy {
    return this.registry.connectionPolicy
  }

  setPeerPriority(peerId: string, priority: MeshPeerPriorityUpdate): void {
    this.registry.setPeerPriority(peerId, priority)
    void this.applyConnectionBudget()
  }

  notePeerUsed(peerId: string): void {
    this.registry.notePeerUsed(peerId)
  }

  async connect(profile: WebRtcPeerConnectionProfile = this.requiredProfile()): Promise<void> {
    await this.disconnect('superseded connection')
    await this.connectPeer(profile)
  }

  async connectPeer(profile: WebRtcPeerConnectionProfile): Promise<void> {
    assertSecureRuntime(profile, this.options)
    assertPeerConnectionRuntimeAvailable(this.options)
    const rememberedStandby = profile.expectedStablePeerId === undefined
      ? undefined
      : this.registry.takeStandby(profile.expectedStablePeerId)
    const localSignalingId = this.options.randomId?.() ?? randomBrowserId()
    const now = Date.now()
    const entry: MeshPeerSessionEntry = {
      key: profile.expectedStablePeerId ?? `pending:${localSignalingId}`,
      peerId: profile.expectedStablePeerId,
      profile,
      session: null,
      signaling: null,
      // The per-session allowlist that replaces the flat signaling filter: this
      // session accepts signaling only from the peer it belongs to.
      allowlist: new SignalingSessionAllowlist({
        expectedStablePeerId: profile.expectedStablePeerId,
        expectedSignalingPeerId: profile.expectedSignalingPeerId
      }),
      bridge: null,
      keyMaterial: null,
      localProtocolHello: null,
      pendingPairing: null,
      budget: {
        userPinned: rememberedStandby?.budget.userPinned ?? false,
        dependedUpon: rememberedStandby?.budget.dependedUpon ?? false,
        activeRouteCount: 0,
        lastUsedAtMs: now,
        connectedAtMs: rememberedStandby?.budget.connectedAtMs ?? now
      },
      standby: null
    }
    // One stable id, one session: a known identity presenting on a second
    // transport is refused here rather than quietly superseding the first.
    this.registry.add(entry)
    if (rememberedStandby) this.resumeFallbacks.set(entry, rememberedStandby)
    if (this.options.initialCredentials) {
      for (const credential of this.options.initialCredentials) {
        await this.credentialStore?.save(credential.verifierPeerId, credential)
      }
    }
    try {
      const keys = await deriveRoomKeysFromProfile(profile, this.options)
      entry.keyMaterial = keys
      const appLayerE2eeEnabled = resolveAppLayerE2eeEnabled(profile, this.options)
      const localProtocolHello = buildLocalProtocolHello(this.options)
      entry.localProtocolHello = localProtocolHello
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
      signalingOptions.allowlist = entry.allowlist
      const signaling = (this.options.signalingFactory ?? ((nextOptions) => new MqttWebSocketSignalingClient(nextOptions)))(signalingOptions)
      signaling.onPresence?.((presence) => this.observeRoomPresence(presence))
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
          entry.pendingPairing = pairing
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
      entry.session = session
      entry.signaling = signaling
      session.subscribe((snapshot) => this.handleSessionSnapshot(entry, snapshot))
      await session.start()
    } catch (error) {
      this.resumeFallbacks.delete(entry)
      this.registry.remove(entry)
      if (this.primaryEntry === entry) this.primaryEntry = null
      const close = this.detachEntry(entry, 'connection failed')
      if (rememberedStandby && !this.registry.has(rememberedStandby)) {
        this.registry.add(rememberedStandby)
      }
      this.refreshMeshTransport()
      try {
        await close()
      } catch (cleanupError) {
        this.recordDiagnostic('webrtc_peer_connect_cleanup_failed', diagnosticMessage(cleanupError))
      }
      this.emit()
      throw error
    }
  }

  async confirmPairing(sessionId: string, approval?: PeerPairingApproval): Promise<void> {
    const entry = this.registry.list().find((candidate) => candidate.pendingPairing?.pairingSessionId === sessionId)
    const pending = entry?.pendingPairing
    if (!entry || !pending) throw new AuroraError({ code: 'validation', message: 'No matching WebRTC pairing session is pending.' })
    const session = entry.session
    if (!session) throw new AuroraError({ code: 'unavailable_service', message: 'The WebRTC pairing session is unavailable.' })
    await session.confirmSas(pending.verificationCode, approval)
    if (entry.session === session && entry.pendingPairing?.pairingSessionId === sessionId) {
      entry.pendingPairing = null
      this.emit()
    }
  }

  async rejectPairing(sessionId: string): Promise<void> {
    const entry = this.registry.list().find((candidate) => candidate.pendingPairing?.pairingSessionId === sessionId)
    if (!entry) throw new AuroraError({ code: 'validation', message: 'No matching WebRTC pairing session is pending.' })
    entry.pendingPairing = null
    await this.closeEntry(entry, 'pairing rejected')
  }

  async getSelectedCandidatePairEvidence() {
    return await this.session?.getSelectedCandidatePairEvidence() ?? { selected: false, category: 'unknown', statsSource: 'RTCPeerConnection.getStats', rawAddressRedacted: true as const }
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    this.releaseVisibilityHook()
    this.observedPeers.clear()
    const entries = this.registry.clear()
    this.resumeFallbacks.clear()
    this.primaryEntry = null
    this.meshTransport = null
    const closing = entries.map((entry) => this.detachEntry(entry, reason))
    for (const close of closing) await close()
    this.emit()
  }

  async disconnectPeer(peerId: string, reason = 'disconnect'): Promise<void> {
    const entry = this.registry.findByPeerId(peerId) ?? this.registry.list().find((candidate) => candidate.key === peerId)
    if (!entry) return
    await this.closeEntry(entry, reason)
  }

  async applyConnectionBudget(reasonCode?: MeshPeerStandbyReason): Promise<void> {
    const resolvedReason = reasonCode
      ?? (this.lifecycleState === 'background' ? this.registry.backgroundStandbyReason() : 'connection_budget')
    const overBudget = this.registry.overBudgetEntries(this.lifecycleState)
    for (const entry of overBudget) {
      await this.standbyAndCloseEntry(entry, resolvedReason)
    }
  }

  isAuthorized(): boolean {
    return this.registry.list().some((entry) => entry.session?.getSnapshot().authorized === true)
  }

  hasEstablishedAuthorizedRoute(): boolean {
    return this.establishedAuthorizedRoute
  }

  private async closeEntry(entry: MeshPeerSessionEntry, reason: string): Promise<void> {
    this.resumeFallbacks.delete(entry)
    if (!this.registry.remove(entry)) return
    if (this.primaryEntry === entry) this.primaryEntry = null
    const close = this.detachEntry(entry, reason)
    this.refreshMeshTransport()
    if (this.registry.size === 0) {
      // Nothing is watching the room any more, so nothing is being discovered.
      this.observedPeers.clear()
      this.releaseVisibilityHook()
    }
    await close()
    this.emit()
  }

  private async standbyAndCloseEntry(entry: MeshPeerSessionEntry, reasonCode: MeshPeerStandbyReason): Promise<void> {
    if (!this.registry.has(entry)) return
    try {
      await entry.bridge?.sendPeerStandby(reasonCode, { resumeExpected: true })
    } catch (error) {
      this.recordDiagnostic('webrtc_peer_standby_failed', diagnosticMessage(error))
    }
    const standby = {
      reasonCode,
      resumeExpected: true,
      sinceMs: Date.now()
    }
    if (!this.registry.markStandby(entry, standby)) return
    if (this.primaryEntry === entry) this.primaryEntry = null
    const close = this.detachEntry(entry, reasonCode)
    this.refreshMeshTransport()
    await close()
    this.emit()
  }

  /**
   * Drop an entry's transport state synchronously and hand back the async close
   * so no snapshot emitted while the session shuts down can resurrect it.
   */
  private detachEntry(entry: MeshPeerSessionEntry, reason: string): () => Promise<void> {
    entry.bridge?.close(reason)
    entry.bridge = null
    const session = entry.session
    entry.session = null
    const signaling = entry.signaling
    entry.signaling = null
    entry.pendingPairing = null
    entry.localProtocolHello = null
    zeroEntryKeyMaterial(entry)
    return async () => {
      if (session) await session.close()
      else if (signaling) await signaling.close(reason)
    }
  }

  private currentEntry(): MeshPeerSessionEntry | null {
    if (this.primaryEntry && this.registry.has(this.primaryEntry) && this.primaryEntry.standby === null) {
      return this.primaryEntry
    }
    const active = this.registry.activeEntries()
    return active[active.length - 1] ?? this.registry.list().at(-1) ?? null
  }

  /**
   * Single-peer projection of the registry: the entry the derived single-peer
   * snapshot reads from. Read-only on purpose — an entry is created by
   * connecting a peer, never as a side effect of an assignment, so the roster
   * can never hold a peer nothing ever connected to. Multi-peer callers use
   * the roster instead.
   */
  private get session(): WebRtcPeerSession | null {
    return this.currentEntry()?.session ?? null
  }

  private get pendingPairing(): PairingSasResult | null {
    return this.currentEntry()?.pendingPairing ?? null
  }

  private requiredProfile(): WebRtcPeerConnectionProfile {
    if (!this.fixedProfile) throw new AuroraError({ code: 'validation', message: 'A WebRTC peer profile is required to connect.' })
    return this.fixedProfile
  }

  private handleSessionSnapshot(entry: MeshPeerSessionEntry, snapshot: PeerSessionSnapshot | null): void {
    if (this.registry.has(entry)) {
      this.syncAllowlistBinding(entry, snapshot)
      const resumeFallback = this.resumeFallbacks.get(entry)
      if (resumeFallback && snapshot?.state === 'failed') {
        void this.restoreStandbyAfterFailedResume(entry, resumeFallback)
        return
      }
      if (snapshot && ['failed', 'closed', 'idle', 'needs-invite', 'disabled'].includes(snapshot.state)) {
        entry.pendingPairing = null
      }
      if (snapshot && snapshot.state === 'reconnecting' && entry.pendingPairing) {
        this.recordDiagnostic('webrtc_reconnect_active', 'Direct device pairing continues while this connection retries.')
      }
      if (snapshot?.remoteStableId !== undefined && entry.peerId !== snapshot.remoteStableId && !this.bindEntryPeerId(entry, snapshot.remoteStableId)) {
        return
      }
      if (snapshot?.authorized && entry.peerId !== undefined && !entry.bridge && entry.session) {
        this.resumeFallbacks.delete(entry)
        entry.standby = null
        this.installAuthorizedBridge(entry)
      }
    }
    this.emit()
  }

  private async restoreStandbyAfterFailedResume(
    entry: MeshPeerSessionEntry,
    standby: MeshPeerSessionEntry,
  ): Promise<void> {
    if (this.resumeFallbacks.get(entry) !== standby) return
    this.resumeFallbacks.delete(entry)
    if (!this.registry.remove(entry)) return
    if (this.primaryEntry === entry) this.primaryEntry = null
    const close = this.detachEntry(entry, 'resume failed')
    this.registry.add(standby)
    this.refreshMeshTransport()
    try {
      await close()
    } catch (error) {
      this.recordDiagnostic('webrtc_peer_resume_cleanup_failed', diagnosticMessage(error))
    }
    this.emit()
  }

  /** Returns false when the stable id is already held by another live session. */
  private bindEntryPeerId(entry: MeshPeerSessionEntry, peerId: string): boolean {
    try {
      this.registry.bindPeerId(entry, peerId)
      return true
    } catch {
      this.recordDiagnostic('webrtc_peer_already_connected', 'That device already has a connection here; the second one was refused.')
      void this.closeEntry(entry, 'stable peer id already connected')
      return false
    }
  }

  private installAuthorizedBridge(entry: MeshPeerSessionEntry): void {
    const session = entry.session
    const remotePeerId = entry.peerId
    if (!session || remotePeerId === undefined) return
    const bridgeOptions = {
      session,
      remotePeerId,
      localPeerRole: this.options.nodeRole === 'mesh-node' ? 'hybrid' as const : 'consumer' as const,
      // Required: buildWebRtcManifestAck binds recipient_projection_evidence to
      // this peer and fails closed without it. The bridge otherwise falls back
      // to peerHost.localPeerId, which a consumer-role runtime does not have,
      // so every projection manifest would be rejected as "recipient unbound".
      ...(this.options.localStablePeerId ? { localPeerId: this.options.localStablePeerId } : {}),
      ...(this.options.peerHost ? { peerHost: this.options.peerHost } : {}),
      onPeerStandby: (frame: MeshPeerStandbyFrame) => {
        void this.acceptPeerStandby(entry, frame)
      },
      onManifestChanged: () => this.emit(),
      ...(entry.localProtocolHello
        ? { localProtocolHello: entry.localProtocolHello }
        : {})
    }
    entry.bridge = new WebRtcMeshPeerBridge(bridgeOptions)
    this.establishedAuthorizedRoute = true
    this.refreshMeshTransport()
    this.recordDiagnostic('webrtc_mesh_authorized', 'WebRTC mesh transport authorized')
    void this.applyConnectionBudget()
  }

  private async acceptPeerStandby(entry: MeshPeerSessionEntry, frame: MeshPeerStandbyFrame): Promise<void> {
    if (!this.registry.has(entry) || entry.peerId === undefined || frame.peer_id !== entry.peerId) {
      this.recordDiagnostic('webrtc_peer_standby_invalid', 'A device sent a standby notice for a different connection.')
      return
    }
    const standby = {
      reasonCode: frame.reason_code,
      resumeExpected: frame.resume_expected !== false,
      sinceMs: Date.now()
    }
    if (!this.registry.markStandby(entry, standby)) return
    if (this.primaryEntry === entry) this.primaryEntry = null
    const close = this.detachEntry(entry, frame.reason_code)
    this.refreshMeshTransport()
    await close()
    this.emit()
  }

  /** Keep one transport pointed at the primary peer while the roster changes. */
  private refreshMeshTransport(): void {
    const primary = this.registry.list().find((entry) => entry.bridge !== null && entry.peerId !== undefined) ?? null
    this.primaryEntry = primary
    if (!primary?.bridge || primary.peerId === undefined) {
      this.meshTransport = null
      return
    }
    const reachablePeerCount = this.registry.list().filter((entry) => entry.bridge !== null).length
    const meshOptions = { bridge: this.bridgeRouter } as import('../mesh.js').MeshP2PTransportOptions
    // The legacy implicit route is safe only when exactly one peer is reachable
    // (or Connect policy enforces that invariant). Multi-peer mesh calls must
    // carry a selector or resolve through the manifest-aware route resolver.
    if (this.registry.connectionPolicy === 'connect' || reachablePeerCount === 1) {
      meshOptions.defaultPeerId = primary.peerId
    }
    if (this.options.routeResolver !== undefined) meshOptions.routeResolver = this.options.routeResolver
    if (this.options.defaultTimeoutMs !== undefined) meshOptions.defaultTimeoutMs = this.options.defaultTimeoutMs
    if (this.options.fallbackPeerIds !== undefined) meshOptions.fallbackPeerIds = this.options.fallbackPeerIds
    this.meshTransport = new MeshP2PTransport(meshOptions)
  }

  noteFallback(code: string, method: string): void {
    this.recordDiagnostic(code, `HTTP fallback selected for ${method}`)
  }

  noteUnavailable(code: string, method: string): void {
    this.recordDiagnostic(code, `WebRTC preferred route unavailable for ${method}`)
  }

  private snapshotForEntry(entry: MeshPeerSessionEntry | null): PeerConnectionSnapshot {
    const snapshot = entry?.session?.getSnapshot() ?? null
    const profile = entry?.profile ?? this.fixedProfile
    const bridgeDiagnostics = entry?.bridge?.getDiagnostics?.()
    const signalingSnapshot = entry?.signaling?.snapshot()
    const pendingPairing = entry?.pendingPairing ?? null
    const lastDiagnostic = this.diagnostics[this.diagnostics.length - 1]
    const visibleDiagnostic = snapshot?.authorized && lastDiagnostic?.code === 'webrtc_peer_not_connected'
      ? [...this.diagnostics].reverse().find((item) => item.code === 'webrtc_mesh_authorized') ?? lastDiagnostic
      : lastDiagnostic
    return {
      state: snapshot?.state ?? (this.mode === 'http-only' ? 'idle' : 'closed'),
      connectionMode: this.mode,
      expectedStablePeerId: profile?.expectedStablePeerId,
      connectedStablePeerId: snapshot?.remoteStableId,
      connectedSignalingPeerId: snapshot?.remoteSignalingId,
      negotiationRole: snapshot?.role,
      nodeName: profile?.nodeName,
      selectedSignalingBrokerOrigin: signalingSnapshot?.selectedBrokerOrigin,
      icePathCategory: snapshot?.icePath ?? 'unknown',
      protocolCapabilities: bridgeDiagnostics?.remoteProtocolCapabilities ?? [],
      reconnectCount: snapshot?.reconnectAttempts ?? signalingSnapshot?.reconnectCount ?? 0,
      pendingCallCount: bridgeDiagnostics?.pendingCallCount ?? 0,
      pendingStreamCount: bridgeDiagnostics?.pendingStreamCount ?? 0,
      pendingSubscriptionCount: bridgeDiagnostics?.pendingSubscriptionCount ?? 0,
      pendingFragmentCount: bridgeDiagnostics?.pendingFragmentCount ?? 0,
      bufferPressureHighWaterBytes: bridgeDiagnostics?.bufferPressureHighWaterBytes ?? 0,
      sentFragmentCount: bridgeDiagnostics?.sentFragmentCount ?? 0,
      receivedFragmentCount: bridgeDiagnostics?.receivedFragmentCount ?? 0,
      lastRedactedError: snapshot?.lastError ? diagnostic('session_error', snapshot.lastError) : visibleDiagnostic,
      updatedAt: new Date().toISOString(),
      ...(pendingPairing ? { pendingPairing: { sessionId: pendingPairing.pairingSessionId, verificationCode: pendingPairing.verificationCode, remoteStablePeerId: pendingPairing.remoteStablePeerId, remoteNodeName: pendingPairing.remoteNodeName } } : {})
    } as PeerConnectionSnapshot
  }

  private recordDiagnostic(code: string, message: string): void {
    this.diagnostics.push(diagnostic(code, message))
    if (this.diagnostics.length > 20) this.diagnostics.splice(0, this.diagnostics.length - 20)
    this.emit()
  }

  private installVisibilityHook(): void {
    if (!this.visibilityDocument) return
    this.lifecycleState = this.visibilityDocument.visibilityState === 'hidden' ? 'background' : 'foreground'
    const handler = () => {
      const hidden = this.visibilityDocument?.visibilityState === 'hidden'
      this.lifecycleState = hidden ? 'background' : 'foreground'
      if (hidden) this.recordDiagnostic('page_hidden', 'WebRTC thin shell is running in a hidden document; browser throttling may delay signaling or media callbacks.')
      if (hidden) void this.applyConnectionBudget()
      else void this.resumeStandbyPeers()
    }
    this.visibilityDocument.addEventListener('visibilitychange', handler)
    this.removeVisibilityListener = () => this.visibilityDocument?.removeEventListener('visibilitychange', handler)
  }

  private async resumeStandbyPeers(): Promise<void> {
    const profiles = this.registry.standbyEntries()
      .filter((entry) => entry.standby?.resumeExpected !== false)
      .map((entry) => entry.profile)
    for (const profile of profiles) {
      try {
        await this.connectPeer(profile)
      } catch (error) {
        this.recordDiagnostic('webrtc_peer_resume_failed', diagnosticMessage(error))
      }
    }
  }

  private releaseVisibilityHook(): void {
    this.removeVisibilityListener?.()
    this.removeVisibilityListener = undefined
  }

  /**
   * Keep the per-session allowlist in step with the session it guards. Once the
   * channel is open the session is pinned to the peer it negotiated with, so a
   * forged announcement claiming that peer's identity cannot move the binding.
   * A session that has fallen back to discovery releases the pin, which is how
   * a peer that genuinely restarted gets to rebind.
   */
  private syncAllowlistBinding(entry: MeshPeerSessionEntry, snapshot: PeerSessionSnapshot | null): void {
    if (snapshot === null) return
    if (ESTABLISHED_SESSION_STATES.has(snapshot.state)) {
      entry.allowlist.establish(snapshot.remoteSignalingId)
      return
    }
    if (UNBOUND_SESSION_STATES.has(snapshot.state)) entry.allowlist.release()
  }

  private emit(): void {
    if (this.listeners.size > 0) {
      const snapshot = this.snapshot()
      for (const listener of [...this.listeners]) listener(snapshot)
    }
    if (this.rosterListeners.size > 0) {
      const roster = this.roster()
      for (const listener of [...this.rosterListeners]) listener(roster)
    }
  }
}

function zeroEntryKeyMaterial(entry: MeshPeerSessionEntry): void {
  if (!entry.keyMaterial) return
  zeroBytes(entry.keyMaterial.k0)
  zeroBytes(entry.keyMaterial.kSig)
  zeroBytes(entry.keyMaterial.kData)
  entry.keyMaterial = null
}

class RuntimeSignalingPort implements PeerSessionSignalingPort {
  constructor(private readonly signaling: MqttWebSocketSignalingClient, private readonly room: MqttSignalingRoom) {}
  async connect(): Promise<void> { await this.signaling.connect(this.room) }
  async close(): Promise<void> { await this.signaling.close() }
  async publish(channel: SignalingChannel, envelope: Record<string, unknown>, toPeer?: string): Promise<void> {
    if (channel === 'presence') {
      await this.signaling.announcePresence()
      return
    }
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

interface LegacyInboundCredential {
  readonly mode: 'legacy'
  readonly token: string
  readonly tokenId: string
  readonly pairingSessionId: string
}

interface DurableInboundCredential {
  readonly mode: 'durable'
  readonly selector: PeerRelationshipSelector
  readonly token: string
  readonly tokenHashHex: string
  readonly credentialRevision: number
  readonly pairingSessionId: string
  readonly permissions: readonly string[]
}

interface InboundPairingExchangeOutcome {
  readonly result: Record<string, unknown>
  readonly rollback?: (() => Promise<void>) | undefined
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
  private issuedInboundCredential: LegacyInboundCredential | DurableInboundCredential | null = null
  private localSasConfirmed = false
  private approvedSharedFeatureIds: readonly string[] = []
  private remoteAuthenticatedByReconnectProof = false
  private remoteAuthenticated = false
  private remoteAuthenticatedContext: AuthenticatedPeerContext | undefined
  private gatewayHelloReceived = false
  private pairingCompleted = false
  private transportGeneration = 0
  private pairingConnectPromise: Promise<PeerSessionAuthFrameResult> | null = null
  private readonly pairingConnectPoll: PairingConnectPollOptions
  private readonly pendingCalls = new Map<string, { method: string; resolve(value: Record<string, unknown> | null): void; timer: ReturnType<typeof setTimeout> }>()
  private reconnectWaiter: ((result: PeerSessionAuthFrameResult) => void) | null = null

  constructor(private readonly options: {
    profile: WebRtcPeerConnectionProfile
    credentialStore?: InternalPeerCredentialStore | undefined
    localStablePeerId: string
    localNodeName: string
    onPairing(pairing: PairingSasResult): void
    onDiagnostic(code: string, message: string): void
    randomId?: (() => string) | undefined
    pairingConnectPoll?: Partial<PairingConnectPollOptions> | undefined
    peerAuthorityResolver?: PeerAuthorityResolverPort | undefined
    peerPairingIssuer?: PeerPairingIssuerPort | undefined
  }) {
    this.pairingConnectPoll = { ...DEFAULT_PAIRING_CONNECT_POLL, ...options.pairingConnectPoll }
  }

  async tryReconnect(context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    const generation = this.transportGeneration
    if (this.options.peerAuthorityResolver !== undefined) {
      let issued = false
      try {
        issued = await this.issueVerifierReconnectChallenge(context)
      } catch {
        if (!this.isCurrentTransport(generation)) return undefined
        this.options.onDiagnostic(
          'webrtc_reconnect_challenge_unavailable',
          'Reconnect verification is unavailable; pairing was not attempted.'
        )
        return { denied: true, terminal: true }
      }
      if (!this.isCurrentTransport(generation)) return undefined
      if (issued) {
        return await this.waitForReconnectResult()
      }
    }
    const peerId = this.options.profile.expectedStablePeerId ?? ''
    if (!peerId || !this.options.credentialStore) return undefined
    try {
      if (this.options.credentialStore.status !== undefined) {
        const status = await this.options.credentialStore.status(peerId)
        if (!this.isCurrentTransport(generation)) return undefined
        if (!status.found) return undefined
      } else {
        const credential = await this.options.credentialStore.get(peerId)
        if (!this.isCurrentTransport(generation)) return undefined
        if (credential === undefined) return undefined
      }
    } catch {
      if (!this.isCurrentTransport(generation)) return undefined
      this.options.onDiagnostic(
        'webrtc_reconnect_store_unavailable',
        'Native reconnect storage is unavailable; pairing was not attempted.'
      )
      return { denied: true, terminal: true }
    }
    if (!this.isCurrentTransport(generation)) return undefined
    return await this.waitForReconnectResult()
  }

  private waitForReconnectResult(): Promise<PeerSessionAuthFrameResult> {
    this.resolveReconnectWait(undefined)
    return new Promise<PeerSessionAuthFrameResult>((resolve) => {
      this.reconnectWaiter = resolve
    })
  }

  private resolveReconnectWait(result: PeerSessionAuthFrameResult): void {
    const resolve = this.reconnectWaiter
    this.reconnectWaiter = null
    if (resolve) resolve(result)
  }

  resetTransport(): void {
    this.transportGeneration += 1
    this.resolveReconnectWait(undefined)
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
    this.pendingCalls.clear()
    // Authentication is bound to the current SDP/DataChannel. Preserve the
    // user's in-flight pairing decision, but require both trust directions to
    // complete again before application traffic is authorized on a new one.
    this.sentAuthFrame = false
    this.awaitingGatewayHello = false
    this.remoteAuthenticatedByReconnectProof = false
    this.remoteAuthenticated = false
    this.remoteAuthenticatedContext = undefined
    this.gatewayHelloReceived = false
    const preservePairingState = !this.pairingCompleted && (
      this.pairing !== null
      || this.pairingHandle !== null
      || this.localSasConfirmed
      || this.issuedInboundCredential !== null
      || this.inboundPairingHandle !== null
      || this.pairingConnectPromise !== null
    )
    if (!preservePairingState) {
      this.handshake = null
      this.handshakePromise = null
      this.pairing = null
      this.sentCommit = false
      this.commitPromise = null
      this.sentReveal = false
      this.sentAuthFrame = false
      this.awaitingGatewayHello = false
      this.pairingHandle = null
      this.inboundPairingHandle = null
      this.issuedInboundCredential = null
      this.localSasConfirmed = false
      this.approvedSharedFeatureIds = []
      this.remoteAuthenticatedByReconnectProof = false
      this.pairingCompleted = false
      this.pairingConnectPromise = null
      return
    }
    if (!this.handshake && this.pairing) {
      this.handshake = null
    }
    this.handshakePromise = null
    this.commitPromise = null
    this.pairingConnectPromise = null
  }

  async startPairing(context: PeerSessionAuthContext): Promise<void> {
    const generation = this.transportGeneration
    const handshake = await this.ensureHandshake(context, generation)
    if (!handshake || !this.isCurrentTransport(generation)) return
    await this.sendCommit(context, generation)
  }

  async confirmPairing(code: string, context: PeerSessionAuthContext, approval?: PeerPairingApproval): Promise<PeerSessionAuthFrameResult> {
    if (!this.pairing || this.pairing.verificationCode !== code) return { denied: true, terminal: true }
    this.localSasConfirmed = true
    this.approvedSharedFeatureIds = normalizeSharedFeatureIds(approval?.sharedFeatureIds)
    this.handshake?.confirm()
    if (this.pairingHandle) return await this.pollPairingConnect(context, this.pairingHandle)
    return undefined
  }

  async handleFrame(frame: unknown, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> {
    if (!isRecord(frame)) return undefined
    const generation = this.transportGeneration
    const type = frame.type
    if (type === 'result' || type === 'error') {
      return this.resolveRpcFrame(frame) ? { handled: true } : undefined
    }
    if (type === 'call') {
      return await this.handleInboundAuthCall(frame, context, generation)
    }
    if (type === 'auth') {
      return await this.handleInboundAuthFrame(frame, context, generation)
    }
    if (type === 'protocol_hello') {
      if (this.awaitingGatewayHello || this.sentAuthFrame) {
        this.gatewayHelloReceived = true
        return this.mutualAuthenticationResult()
      }
      return undefined
    }
    if (type === 'auth_success' || type === 'authenticated') {
      this.options.onDiagnostic('unsupported_auth_signal', 'Ignoring unsupported WebRTC auth success signal')
      return undefined
    }
    if (type === 'mesh_auth_challenge_v1') {
      const proof = await createReconnectProof(this.options.credentialStore, this.options.profile.expectedStablePeerId ?? '', frame as unknown as MeshReconnectChallengeMessage)
      if (!this.isCurrentTransport(generation)) return { handled: true }
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
      return await this.handleInboundReconnectProof(frame, context, generation)
    }
    if (type === 'pairing_v2_commit') {
      this.resolveReconnectWait(undefined)
      const handshake = await this.ensureHandshake(context, generation)
      if (!handshake || !this.isCurrentTransport(generation)) return { handled: true }
      handshake.acceptCommit(parsePairingCommitMessage(frame))
      await this.sendCommit(context, generation)
      await this.sendReveal(context, generation)
      return undefined
    }
    if (type === 'pairing_v2_reveal') {
      this.resolveReconnectWait(undefined)
      const handshake = await this.ensureHandshake(context, generation)
      if (!handshake || !this.isCurrentTransport(generation)) return { handled: true }
      const pairing = await handshake.acceptReveal(parsePairingRevealMessage(frame))
      if (!this.isCurrentTransport(generation)) return { handled: true }
      this.pairing = pairing
      if (!this.remoteAuthenticatedByReconnectProof) this.options.onPairing(this.pairing)
      return await this.beginGatewayPairing(context, generation)
    }
    if (type === 'pairing_v2_terminal') {
      this.resolveReconnectWait(undefined)
      const terminal = parsePairingTerminalMessage(frame)
      this.options.onDiagnostic('pairing_terminal', `Pairing ended with ${terminal.status}`)
      return terminal.status === 'denied' ? { denied: true, terminal: true } : undefined
    }
    return undefined
  }

  private async beginGatewayPairing(context: PeerSessionAuthContext, generation: number): Promise<PeerSessionAuthFrameResult> {
    if (!this.pairing) return undefined
    const pairing = this.pairing
    const result = await this.call(context, AUTH_METHODS.pairingStart, {
      device_name: this.options.localNodeName,
      remote_peer_id: this.options.localStablePeerId,
      remote_node_name: this.options.localNodeName,
      room_name: this.options.profile.room,
      pairing_session_id: pairing.pairingSessionId,
      verification_code: pairing.verificationCode
    })
    if (!this.isCurrentPairing(generation, pairing)) return { handled: true }
    if (!result || result.error) {
      this.options.onDiagnostic('pairing_start_failed', 'Pairing initiation failed')
      return undefined
    }
    if (result.status === 'denied') {
      this.options.onDiagnostic('pairing_denied', 'Pairing was denied by the remote endpoint')
      return { denied: true, terminal: true }
    }
    if (result.pairing_session_id !== pairing.pairingSessionId || result.verification_code !== pairing.verificationCode) {
      throw new PairingProtocolError('Remote PairingStart response does not match the SAS')
    }
    if (result.status === 'already_trusted') return undefined
    const handle = typeof result.code === 'string' ? result.code : ''
    if (!handle || handle === pairing.verificationCode) throw new PairingProtocolError('Remote reused the display code as a pairing credential')
    this.pairingHandle = handle
    if (this.localSasConfirmed) return await this.pollPairingConnect(context, handle, generation)
    return undefined
  }

  private async pollPairingConnect(context: PeerSessionAuthContext, handle: string, generation = this.transportGeneration): Promise<PeerSessionAuthFrameResult> {
    if (!this.isCurrentTransport(generation)) return { handled: true }
    if (this.pairingConnectPromise) return await this.pairingConnectPromise
    const pending = this.pollPairingConnectOnce(context, handle, generation)
    this.pairingConnectPromise = pending
    try {
      return await pending
    } finally {
      if (this.pairingConnectPromise === pending) this.pairingConnectPromise = null
    }
  }

  private async pollPairingConnectOnce(context: PeerSessionAuthContext, handle: string, generation: number): Promise<PeerSessionAuthFrameResult> {
    const pairing = this.pairing
    if (!pairing) return undefined
    const maxAttempts = Math.max(0, Math.floor(this.pairingConnectPoll.maxAttempts))
    for (let attempt = 1; maxAttempts === 0 || attempt <= maxAttempts; attempt += 1) {
      if (!this.isCurrentPairing(generation, pairing)) return { handled: true }
      const result = await this.call(context, AUTH_METHODS.pairingConnect, {
        code: handle,
        pairing_session_id: pairing.pairingSessionId
      }, this.pairingConnectPoll.rpcTimeoutMs)
      if (!this.isCurrentPairing(generation, pairing)) return { handled: true }
      if (result && !result.error) {
        if (result.pairing_session_id !== pairing.pairingSessionId || result.verification_code !== pairing.verificationCode) {
          throw new PairingProtocolError('Remote pairing status belongs to another SAS')
        }
        const status = String(result.status ?? '')
        if (status === 'approved') {
          await this.sendPairingExchange(context, handle, generation, pairing)
          return undefined
        }
        if (status === 'already_trusted') return undefined
        if (status === 'denied' || status === 'expired' || status === 'superseded') {
          this.options.onDiagnostic(`pairing_${status}`, `Pairing was ${status} by the remote endpoint`)
          return { denied: true, terminal: true }
        }
        if (status && status !== 'pending') this.options.onDiagnostic('pairing_not_ready', `Pairing status ${status}`)
      }
      if (maxAttempts === 0 || attempt < maxAttempts) {
        await sleep(Math.min(this.pairingConnectPoll.maxDelayMs, this.pairingConnectPoll.initialDelayMs * 2 ** (attempt - 1)))
      }
    }
    this.options.onDiagnostic('pairing_timeout', 'Pairing approval timed out')
    return { retry: true }
  }

  private async sendPairingExchange(context: PeerSessionAuthContext, handle: string, generation: number, pairing: PairingSasResult): Promise<void> {
    if (!this.isCurrentPairing(generation, pairing)) return
    const result = await this.call(context, AUTH_METHODS.pairingExchange, {
      code: handle,
      pairing_session_id: pairing.pairingSessionId
    })
    if (!this.isCurrentPairing(generation, pairing)) return
    const token = typeof result?.token === 'string' ? result.token : ''
    if (!token) {
      this.options.onDiagnostic('pairing_exchange_failed', 'Credential exchange failed')
      return
    }
    const tokenId = typeof result?.token_id === 'string' ? result.token_id : ''
    if (!tokenId) throw new PairingProtocolError('Credential exchange omitted its reconnect token id')
    const claimedPeerId = typeof result?.peer_id === 'string' ? result.peer_id : ''
    if (claimedPeerId && claimedPeerId !== pairing.remoteStablePeerId) throw new PairingProtocolError('Credential issuer identity does not match the SAS')
    await this.options.credentialStore?.save(pairing.remoteStablePeerId, {
      tokenId,
      claimantPeerId: this.options.localStablePeerId,
      verifierPeerId: pairing.remoteStablePeerId,
      claimantSignalingPeerId: context.localSignalingId,
      verifierSignalingPeerId: context.remoteSignalingId,
      roomName: this.options.profile.room,
      rawBearerToken: token
    })
    if (!this.isCurrentPairing(generation, pairing)) return
    await context.sendControlFrame({
      type: 'auth',
      peer_name: this.options.localNodeName,
      peer_id: this.options.localStablePeerId,
      signaling_peer_id: context.localSignalingId,
      pairing_session_id: pairing.pairingSessionId,
      token
    })
    if (!this.isCurrentPairing(generation, pairing)) return
    this.sentAuthFrame = true
    this.awaitingGatewayHello = true
  }

  private async handleInboundAuthCall(frame: Record<string, unknown>, context: PeerSessionAuthContext, generation: number): Promise<PeerSessionAuthFrameResult> {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const method = typeof frame.method === 'string' ? frame.method : ''
    const params = isRecord(frame.params) ? frame.params : {}
    if (method !== AUTH_METHODS.pairingStart && method !== AUTH_METHODS.pairingConnect && method !== AUTH_METHODS.pairingExchange) return undefined
    let rollbackIssue: (() => Promise<void>) | undefined
    try {
      let result: Record<string, unknown>
      if (method === AUTH_METHODS.pairingStart) {
        result = this.handleInboundPairingStart(params)
      } else if (method === AUTH_METHODS.pairingConnect) {
        result = this.handleInboundPairingConnect(params)
      } else {
        const exchange = await this.handleInboundPairingExchange(params, context, generation)
        result = exchange.result
        rollbackIssue = exchange.rollback
      }
      if (!this.isCurrentTransport(generation)) {
        await rollbackIssue?.()
        return { handled: true }
      }
      await context.sendControlFrame({ type: 'result', id, result })
      rollbackIssue = undefined
    } catch (error) {
      if (rollbackIssue !== undefined) {
        try {
          await rollbackIssue()
        } catch {
          this.options.onDiagnostic('pairing_rollback_failed', 'The connection approval could not be finalized safely.')
        }
      }
      if (!this.isCurrentTransport(generation)) return { handled: true }
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
      status: this.remoteAuthenticatedByReconnectProof ? 'already_trusted' : this.localSasConfirmed ? 'approved' : 'pending'
    }
  }

  private handleInboundPairingConnect(params: Record<string, unknown>): Record<string, unknown> {
    const pairing = this.requireInboundPairingContext(params, false)
    this.assertInboundHandle(params)
    return {
      request_id: this.inboundPairingHandle,
      device_name: pairing.remoteNodeName || pairing.remoteStablePeerId,
      status: this.remoteAuthenticatedByReconnectProof ? 'already_trusted' : this.localSasConfirmed ? 'approved' : 'pending',
      pairing_session_id: pairing.pairingSessionId,
      verification_code: pairing.verificationCode
    }
  }

  private async handleInboundPairingExchange(params: Record<string, unknown>, context: PeerSessionAuthContext, generation: number): Promise<InboundPairingExchangeOutcome> {
    const pairing = this.requireInboundPairingContext(params, false)
    this.assertInboundHandle(params)
    if (this.remoteAuthenticatedByReconnectProof) throw new PairingProtocolError('Peer already has a trusted credential')
    if (!this.localSasConfirmed) throw new PairingProtocolError('Pairing has not been approved locally')
    if (this.options.peerPairingIssuer !== undefined) {
      if (this.issuedInboundCredential !== null) {
        if (this.issuedInboundCredential.mode !== 'durable' || this.issuedInboundCredential.pairingSessionId !== pairing.pairingSessionId) {
          throw new PairingProtocolError('Pairing credential was already issued')
        }
        return { result: this.durablePairingExchangeResult(this.issuedInboundCredential, context) }
      }
      const selector: PeerRelationshipSelector = {
        tokenId: boundedTokenId(),
        claimantPeerId: pairing.remoteStablePeerId,
        verifierPeerId: this.options.localStablePeerId,
        roomName: this.options.profile.room
      }
      const issued = await this.options.peerPairingIssuer.issue(selector, {
        featureIds: this.approvedSharedFeatureIds
      })
      if (!this.isCurrentPairing(generation, pairing)) {
        try {
          await this.options.peerPairingIssuer.rollback(selector)
        } catch {
          this.options.onDiagnostic('pairing_rollback_failed', 'The connection approval could not be finalized safely.')
        }
        throw new PairingProtocolError('Pairing transport changed during credential issue')
      }
      const credential: DurableInboundCredential = {
        mode: 'durable',
        selector: {
          tokenId: issued.verifier.tokenId,
          claimantPeerId: issued.verifier.claimantPeerId,
          verifierPeerId: issued.verifier.verifierPeerId,
          roomName: issued.verifier.roomName
        },
        token: issued.bearerToken,
        tokenHashHex: issued.verifier.tokenHashHex,
        credentialRevision: issued.verifier.credentialRevision,
        pairingSessionId: pairing.pairingSessionId,
        permissions: normalizeGrantedPermissions(issued.grantedPermissions)
      }
      this.issuedInboundCredential = credential
      let rollbackPending = true
      return {
        result: this.durablePairingExchangeResult(credential, context),
        rollback: async () => {
          if (!rollbackPending) return
          rollbackPending = false
          if (this.issuedInboundCredential === credential) this.issuedInboundCredential = null
          await this.options.peerPairingIssuer!.rollback(selector)
        }
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
      result: {
        token: this.issuedInboundCredential.token,
        token_id: this.issuedInboundCredential.tokenId,
        device_id: context.localStableId ?? this.options.localStablePeerId,
        user_id: this.options.localStablePeerId,
        permissions: [],
        peer_id: this.options.localStablePeerId,
        node_name: this.options.localNodeName
      }
    }
  }

  private durablePairingExchangeResult(credential: DurableInboundCredential, context: PeerSessionAuthContext): Record<string, unknown> {
    return {
      token: credential.token,
      token_id: credential.selector.tokenId,
      device_id: context.localStableId ?? this.options.localStablePeerId,
      user_id: this.options.localStablePeerId,
      permissions: [...credential.permissions],
      peer_id: this.options.localStablePeerId,
      node_name: this.options.localNodeName
    }
  }

  private async handleInboundAuthFrame(frame: Record<string, unknown>, context: PeerSessionAuthContext, generation: number): Promise<PeerSessionAuthFrameResult> {
    const pairing = this.pairing
    const credential = this.issuedInboundCredential
    if (!pairing || !credential) return undefined
    const token = typeof frame.token === 'string' ? frame.token : ''
    if (credential.mode === 'durable') {
      const transport = await this.currentInboundTransport(context)
      if (!this.isCurrentPairing(generation, pairing) || this.issuedInboundCredential !== credential) return { handled: true }
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
        this.remoteAuthenticated = true
        this.remoteAuthenticatedContext = {
          selector: { ...credential.selector },
          transport,
          credentialRevision: credential.credentialRevision,
          authenticatedAtMs: Date.now()
        }
        return this.mutualAuthenticationResult()
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
    this.remoteAuthenticated = true
    this.remoteAuthenticatedContext = undefined
    return this.mutualAuthenticationResult()
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

  private async handleInboundReconnectProof(frame: Record<string, unknown>, context: PeerSessionAuthContext, generation: number): Promise<PeerSessionAuthFrameResult> {
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
    if (!this.isCurrentTransport(generation)) return { handled: true }
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
    if (!this.isCurrentTransport(generation)) return { handled: true }
    if (!result.ok || result.context === undefined) {
      if (result.reasonCode === 'credential_not_found') {
        this.options.onDiagnostic(
          'webrtc_reconnect_credential_stale',
          'Saved reconnect approval is no longer available; fresh pairing is required.'
        )
        this.resolveReconnectWait(undefined)
        await this.startPairing(context)
        return { handled: true }
      }
      return { handled: true, denied: true, terminal: true }
    }
    this.remoteAuthenticatedByReconnectProof = true
    this.remoteAuthenticated = true
    this.remoteAuthenticatedContext = result.context
    this.localSasConfirmed = true
    return this.mutualAuthenticationResult()
  }

  private mutualAuthenticationResult(): PeerSessionAuthFrameResult {
    const remoteAuthenticationRequired = this.options.peerAuthorityResolver !== undefined
      || this.options.peerPairingIssuer !== undefined
    const outboundAuthenticationRequired = this.pairing !== null
      || this.awaitingGatewayHello
      || this.sentAuthFrame
    if ((outboundAuthenticationRequired && !this.gatewayHelloReceived)
      || (remoteAuthenticationRequired && !this.remoteAuthenticated)) {
      return { handled: true }
    }
    const result: PeerSessionAuthFrameResult = {
      handled: true,
      authenticated: true,
      ...(this.remoteAuthenticatedContext !== undefined
        ? { authenticatedPeerContext: this.remoteAuthenticatedContext }
        : {})
    }
    this.pairingCompleted = true
    this.resolveReconnectWait(result)
    return result
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

  private isCurrentTransport(generation: number): boolean {
    return generation === this.transportGeneration
  }

  private isCurrentPairing(generation: number, pairing: PairingSasResult): boolean {
    const current = this.pairing
    return this.isCurrentTransport(generation)
      && current?.pairingSessionId === pairing.pairingSessionId
      && current.verificationCode === pairing.verificationCode
      && current.remoteStablePeerId === pairing.remoteStablePeerId
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

  private async ensureHandshake(context: PeerSessionAuthContext, generation: number): Promise<PairingSasHandshake | null> {
    if (!this.isCurrentTransport(generation)) return null
    if (this.handshake) return this.handshake
    if (this.handshakePromise) {
      const handshake = await this.handshakePromise
      return this.isCurrentTransport(generation) ? handshake : null
    }
    const pending = this.createHandshake(context)
    this.handshakePromise = pending
    try {
      const handshake = await pending
      if (!this.isCurrentTransport(generation)) return null
      if (this.handshakePromise === pending) {
        this.handshake = handshake
        this.handshakePromise = null
      }
      return handshake
    } catch (error) {
      if (this.handshakePromise === pending) this.handshakePromise = null
      throw error
    }
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

  private async sendCommit(context: PeerSessionAuthContext, generation: number): Promise<void> {
    if (!this.isCurrentTransport(generation) || this.sentCommit || !this.handshake) return
    if (this.commitPromise) return await this.commitPromise
    const pending = this.sendCommitOnce(context, generation)
    this.commitPromise = pending
    try {
      await pending
    } catch (error) {
      if (this.isCurrentTransport(generation) && this.commitPromise === pending) this.sentCommit = false
      throw error
    } finally {
      if (this.isCurrentTransport(generation) && this.commitPromise === pending) this.commitPromise = null
    }
  }

  private async sendCommitOnce(context: PeerSessionAuthContext, generation: number): Promise<void> {
    if (!this.isCurrentTransport(generation) || !this.handshake) return
    this.sentCommit = true
    const commit: PairingCommitMessage = await this.handshake.commitMessage()
    if (!this.isCurrentTransport(generation)) return
    await context.sendControlFrame(commit)
  }

  private async sendReveal(context: PeerSessionAuthContext, generation: number): Promise<void> {
    if (!this.isCurrentTransport(generation) || this.sentReveal || !this.handshake) return
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

function normalizeSharedFeatureIds(featureIds: readonly string[] | undefined): readonly string[] {
  if (featureIds === undefined) return []
  if (!Array.isArray(featureIds) || featureIds.length > 128) {
    throw new PairingProtocolError('Invalid local feature selection')
  }
  const normalized = featureIds.map((featureId) => {
    if (typeof featureId !== 'string') throw new PairingProtocolError('Invalid local feature selection')
    const value = featureId.trim()
    if (!value || value.length > 256) throw new PairingProtocolError('Invalid local feature selection')
    return value
  })
  return [...new Set(normalized)].sort()
}

function normalizeGrantedPermissions(permissions: readonly string[] | undefined): readonly string[] {
  if (permissions === undefined) return []
  if (!Array.isArray(permissions) || permissions.length > 128) {
    throw new PairingProtocolError('Invalid local feature permissions')
  }
  const normalized = permissions.map((permission) => {
    if (typeof permission !== 'string') throw new PairingProtocolError('Invalid local feature permissions')
    const value = permission.trim()
    if (!value || value.length > 256) throw new PairingProtocolError('Invalid local feature permissions')
    return value
  })
  return [...new Set(normalized)].sort()
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

function diagnosticMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'WebRTC mesh standby announcement failed.'
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
