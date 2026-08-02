import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  buildProtocolHello,
  parseProtocolHello
} from './peer-protocol.js'
import { DataChannelFlowController, type DataChannelFlowLimits } from './datachannel-flow.js'
import type { AuthenticatedPeerContext } from '../peer-host/index.js'
import type { PeerPairingApproval } from './types.js'

export const AURORA_RPC_DATA_CHANNEL_LABEL = 'aurora-rpc' as const

export type PeerSessionState =
  | 'idle'
  | 'deriving-keys'
  | 'signaling-connecting'
  | 'discovering-peer'
  | 'negotiating'
  | 'channel-open'
  | 'pairing-required'
  | 'reconnect-authenticating'
  | 'awaiting-sas-confirmation'
  | 'authorized'
  | 'reconnecting'
  | 'closed'
  | 'failed'

export type PeerSessionRole = 'offerer' | 'answerer' | 'unknown'
export type IcePathCategory = 'unknown' | 'host' | 'srflx' | 'prflx' | 'relay'
export type SignalingChannel = 'presence' | 'offer' | 'answer' | 'candidate' | 'broadcast'

export interface StunServerReflexiveCandidateEvidence {
  gathered: boolean
  candidateType?: 'srflx' | undefined
  urlScheme?: 'stun' | 'stuns' | undefined
  urlMatchesConfiguredStunServer?: boolean | undefined
  configuredStunServerCount: number
  statsSource: 'RTCPeerConnection.getStats'
  rawAddressRedacted: true
}

export interface SelectedCandidatePairEvidence {
  selected: boolean
  /** Raw selected-pair path category from observed candidate types; prflx is not normalized to srflx. */
  category: IcePathCategory
  pairState?: string | undefined
  nominated?: boolean | undefined
  localCandidateType?: string | undefined
  remoteCandidateType?: string | undefined
  localProtocol?: string | undefined
  remoteProtocol?: string | undefined
  localRelayProtocol?: string | undefined
  remoteRelayProtocol?: string | undefined
  stunServerReflexiveCandidate?: StunServerReflexiveCandidateEvidence | undefined
  statsSource: 'RTCPeerConnection.getStats'
  rawAddressRedacted: true
}

export interface PeerSessionSnapshot {
  state: PeerSessionState
  role: PeerSessionRole
  closed: boolean
  failed: boolean
  authorized: boolean
  localSignalingId: string
  remoteSignalingId?: string | undefined
  remoteStableId?: string | undefined
  expectedRemoteStableId?: string | undefined
  authenticatedPeerContext?: AuthenticatedPeerContext | undefined
  icePath: IcePathCategory
  reconnectAttempts: number
  lastError?: string | undefined
}

export interface PeerSessionDiagnostics extends PeerSessionSnapshot {
  timers: number
  dataChannelOpen: boolean
  connectionState?: string | undefined
}

export interface SignalingEnvelope {
  type: string
  from?: string | undefined
  to?: string | undefined
  stable_peer_id?: string | undefined
  sdp?: string | undefined
  candidate?: string | null | undefined
  candidate_category?: IcePathCategory | undefined
  sdp_mid?: string | null | undefined
  sdp_mline_index?: number | null | undefined
  [key: string]: unknown
}

export interface SignalingMessage {
  channel: SignalingChannel
  from: string
  stablePeerId?: string | undefined
  envelope: SignalingEnvelope
}

export interface PeerSessionSignalingPort {
  connect(): Promise<void> | void
  close(): Promise<void> | void
  publish(channel: SignalingChannel, envelope: SignalingEnvelope, toPeer?: string): Promise<void> | void
  subscribe(listener: (message: SignalingMessage) => void): () => void
}

export interface PeerSessionFrameCodec {
  seal(frame: unknown): string | ArrayBuffer | ArrayBufferView | Promise<string | ArrayBuffer | ArrayBufferView>
  open(data: string | ArrayBuffer | ArrayBufferView): unknown | Promise<unknown>
}

export type PeerSessionAuthFrameResult = boolean | {
  authenticated?: boolean
  authenticatedPeerContext?: AuthenticatedPeerContext
  denied?: boolean
  terminal?: boolean
  retry?: boolean
  handled?: boolean
} | void

export interface PeerSessionAuthPort {
  tryReconnect?(context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> | PeerSessionAuthFrameResult
  startPairing?(context: PeerSessionAuthContext): Promise<void> | void
  confirmPairing?(code: string, context: PeerSessionAuthContext, approval?: PeerPairingApproval): Promise<PeerSessionAuthFrameResult> | PeerSessionAuthFrameResult
  /** Clear state derived from the old SDP/DataChannel while retaining durable credentials. */
  resetTransport?(): void
  handleFrame(frame: unknown, context: PeerSessionAuthContext): Promise<PeerSessionAuthFrameResult> | PeerSessionAuthFrameResult
}

export interface PeerSessionAuthContext {
  localSignalingId: string
  remoteSignalingId: string
  localStableId?: string | undefined
  remoteStableId?: string | undefined
  offerSdp?: string | undefined
  answerSdp?: string | undefined
  sendControlFrame(frame: unknown): Promise<void>
}

export interface PeerSessionTimerPort {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface PeerSessionPeerConnectionFactory {
  (configuration: RTCConfiguration): PeerConnectionLike
}

export interface PeerConnectionLike {
  localDescription: SessionDescriptionLike | null
  remoteDescription: SessionDescriptionLike | null
  connectionState?: RTCPeerConnectionState | string
  iceConnectionState?: RTCIceConnectionState | string
  onicecandidate: ((event: IceCandidateEventLike) => void) | null
  ondatachannel: ((event: DataChannelEventLike) => void) | null
  onconnectionstatechange: (() => void) | null
  oniceconnectionstatechange: (() => void) | null
  createDataChannel(label: string, options?: RTCDataChannelInit): DataChannelLike
  createOffer(): Promise<SessionDescriptionLike>
  createAnswer(): Promise<SessionDescriptionLike>
  setLocalDescription(description: SessionDescriptionLike): Promise<void>
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>
  addIceCandidate(candidate: IceCandidateInitLike | null): Promise<void>
  getStats?(): Promise<RTCStatsReport | Map<string, unknown>>
  close(): void
}

export interface SessionDescriptionLike {
  type: RTCSdpType | 'offer' | 'answer'
  sdp: string
}

export interface IceCandidateInitLike {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export interface IceCandidateLike extends IceCandidateInitLike {
  toJSON?(): IceCandidateInitLike
}

export interface IceCandidateEventLike {
  candidate: IceCandidateLike | null
}

export interface DataChannelEventLike {
  channel: DataChannelLike
}

export interface DataChannelLike {
  label: string
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string | ArrayBuffer | ArrayBufferView }) => void) | null
  onclose: (() => void) | null
  onerror: ((event?: unknown) => void) | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(): void
  addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
  on?(type: string, listener: (...args: unknown[]) => void): void
  removeListener?(type: string, listener: (...args: unknown[]) => void): void
}

export interface PeerSessionOptions {
  localSignalingId: string
  localStableId?: string | undefined
  expectedRemoteSignalingId?: string | undefined
  expectedRemoteStableId?: string | undefined
  iceServers?: RTCIceServer[]
  signaling: PeerSessionSignalingPort
  createPeerConnection: PeerSessionPeerConnectionFactory
  codec: PeerSessionFrameCodec
  auth: PeerSessionAuthPort
  timers?: PeerSessionTimerPort
  random?: () => number
  timeouts?: Partial<PeerSessionTimeouts>
  reconnect?: Partial<PeerSessionReconnectOptions>
  localProtocolHello?: unknown
  dataChannelFlowLimits?: Partial<DataChannelFlowLimits>
}

export interface PeerSessionTimeouts {
  signalingMs: number
  discoveryMs: number
  negotiationMs: number
  authMs: number
  pairingMs: number
}

export interface PeerSessionReconnectOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export type PeerSessionListener = (snapshot: PeerSessionSnapshot) => void
export type PeerSessionFrameListener = (frame: unknown) => void

const DEFAULT_TIMEOUTS: PeerSessionTimeouts = {
  signalingMs: 10_000,
  discoveryMs: 30_000,
  negotiationMs: 20_000,
  authMs: 20_000,
  pairingMs: 300_000
}

const DEFAULT_RECONNECT: PeerSessionReconnectOptions = {
  // A live mesh session keeps recovering until it is explicitly closed.
  // Callers and tests can still provide a finite ceiling when required.
  maxAttempts: Number.POSITIVE_INFINITY,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  jitterRatio: 0.2
}
const MAX_STARTUP_SIGNALING_MESSAGES = 64

function defaultTimers(): PeerSessionTimerPort {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  }
}

function redactError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160)
  if (typeof error === 'string') return error.slice(0, 160)
  return 'peer session error'
}

function cloneAuthenticatedPeerContext(context: AuthenticatedPeerContext): AuthenticatedPeerContext {
  const cloned: AuthenticatedPeerContext = {
    selector: { ...context.selector },
    transport: { ...context.transport },
    credentialRevision: context.credentialRevision,
    authenticatedAtMs: context.authenticatedAtMs
  }
  if (context.connectionEpoch !== undefined) Object.assign(cloned, { connectionEpoch: context.connectionEpoch })
  return cloned
}

export function categorizeIceCandidate(candidate: string | null | undefined): IcePathCategory {
  if (!candidate) return 'unknown'
  if (/\btyp\s+relay\b/u.test(candidate)) return 'relay'
  if (/\btyp\s+srflx\b/u.test(candidate)) return 'srflx'
  if (/\btyp\s+prflx\b/u.test(candidate)) return 'prflx'
  if (/\btyp\s+host\b/u.test(candidate)) return 'host'
  return 'unknown'
}

function candidateToInit(candidate: IceCandidateLike): IceCandidateInitLike {
  if (typeof candidate.toJSON === 'function') return candidate.toJSON()
  const init: IceCandidateInitLike = { candidate: candidate.candidate }
  if (candidate.sdpMid !== undefined) init.sdpMid = candidate.sdpMid
  if (candidate.sdpMLineIndex !== undefined) init.sdpMLineIndex = candidate.sdpMLineIndex
  return init
}

export class WebRtcPeerSession {
  private readonly options: PeerSessionOptions
  private readonly timers: PeerSessionTimerPort
  private readonly timeouts: PeerSessionTimeouts
  private readonly reconnectOptions: PeerSessionReconnectOptions
  private readonly random: () => number
  private readonly listeners = new Set<PeerSessionListener>()
  private readonly frameListeners = new Set<PeerSessionFrameListener>()
  private readonly timerHandles = new Set<unknown>()
  private readonly startupSignalingMessages: SignalingMessage[] = []
  private unsubscribeSignaling: (() => void) | undefined
  private pc: PeerConnectionLike | undefined
  private channel: DataChannelLike | undefined
  private channelFlow: DataChannelFlowController | undefined
  private sendQueue: Promise<void> = Promise.resolve()
  private receiveQueue: Promise<void> = Promise.resolve()
  private state: PeerSessionState = 'idle'
  private role: PeerSessionRole = 'unknown'
  private remoteSignalingId: string | undefined
  private remoteStableId: string | undefined
  private remoteSignalingEpochInvalidated = false
  private readonly pendingSignalingEpochMessages: SignalingMessage[] = []
  private offerSdpTranscript: string | undefined
  private answerSdpTranscript: string | undefined
  private icePath: IcePathCategory = 'unknown'
  private reconnectAttempts = 0
  private closedExplicitly = false
  private terminalNoReconnect = false
  private lastError: string | undefined
  private sentLocalProtocolHello = false
  private pendingRemoteProtocolHello: unknown | undefined
  private authenticatedPeerContext: AuthenticatedPeerContext | undefined
  private transportGeneration = 0

  constructor(options: PeerSessionOptions) {
    this.options = options
    this.timers = options.timers ?? defaultTimers()
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
    this.reconnectOptions = { ...DEFAULT_RECONNECT, ...options.reconnect }
    this.random = options.random ?? Math.random
  }

  getSnapshot(): PeerSessionSnapshot {
    const snapshot: PeerSessionSnapshot = {
      state: this.state,
      role: this.role,
      closed: this.state === 'closed',
      failed: this.state === 'failed',
      authorized: this.state === 'authorized',
      localSignalingId: this.options.localSignalingId,
      icePath: this.icePath,
      reconnectAttempts: this.reconnectAttempts
    }
    if (this.remoteSignalingId !== undefined) snapshot.remoteSignalingId = this.remoteSignalingId
    if (this.remoteStableId !== undefined) snapshot.remoteStableId = this.remoteStableId
    if (this.options.expectedRemoteStableId !== undefined) snapshot.expectedRemoteStableId = this.options.expectedRemoteStableId
    if (this.authenticatedPeerContext !== undefined) snapshot.authenticatedPeerContext = cloneAuthenticatedPeerContext(this.authenticatedPeerContext)
    if (this.lastError !== undefined) snapshot.lastError = this.lastError
    return snapshot
  }

  getDiagnostics(): PeerSessionDiagnostics {
    return {
      ...this.getSnapshot(),
      timers: this.timerHandles.size,
      dataChannelOpen: this.channel?.readyState === 'open',
      connectionState: this.pc?.connectionState ?? this.pc?.iceConnectionState
    }
  }

  async getSelectedCandidatePairEvidence(): Promise<SelectedCandidatePairEvidence> {
    const pc = this.pc
    if (pc === undefined || typeof pc.getStats !== 'function') {
      return emptySelectedCandidatePairEvidence()
    }
    try {
      const report = await pc.getStats()
      return selectedCandidatePairEvidenceFromStats(report, {
        configuredStunServers: this.options.iceServers?.flatMap((server) => iceServerUrls(server).filter(isStunServerUrl)) ?? []
      })
    } catch {
      return emptySelectedCandidatePairEvidence()
    }
  }

  subscribe(listener: PeerSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  subscribeFrames(listener: PeerSessionFrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return
    this.closedExplicitly = false
    this.terminalNoReconnect = false
    this.transition('deriving-keys')
    this.transition('signaling-connecting')
    this.unsubscribeSignaling = this.options.signaling.subscribe((message) => void this.handleSignalingMessage(message))
    this.armTimeout('signaling', this.timeouts.signalingMs, () => this.fail('signaling timeout', true))
    try {
      await this.options.signaling.connect()
      this.clearTimerKind('signaling')
      this.transition('discovering-peer')
      this.armTimeout('discovery', this.timeouts.discoveryMs, () => this.fail('peer discovery timeout', true))
      const startupMessages = this.startupSignalingMessages.splice(0)
      for (const message of startupMessages) {
        if (this.isTerminal()) break
        await this.handleSignalingMessage(message)
      }
    } catch (error) {
      this.fail(error, true)
    }
  }

  async sendFrame(frame: unknown): Promise<void> {
    return this.enqueueFrame(frame, 'Aurora WebRTC peer session is not authorized', () => this.state === 'authorized')
  }

  async confirmSas(code: string, approval?: PeerPairingApproval): Promise<void> {
    if (this.state !== 'awaiting-sas-confirmation') {
      throw new Error('No SAS confirmation is pending')
    }
    const channel = this.channel
    if (channel === undefined) throw new Error('Pairing transport is unavailable')
    const context = this.authContext(channel)
    this.clearTimerKind('auth')
    this.clearTimerKind('pairing-exchange')
    this.armTimeout('pairing-exchange', this.timeouts.pairingMs, () => {
      if (this.channel === channel && !this.isTerminal()) this.fail('pairing exchange timeout', true)
    })
    let result: PeerSessionAuthFrameResult
    try {
      result = await this.options.auth?.confirmPairing?.(code, context, approval)
    } catch (error) {
      if (this.channel === channel && !this.isTerminal()) this.clearTimerKind('pairing-exchange')
      throw error
    }
    if (this.channel !== channel || this.isTerminal()) return
    await this.applyAuthResult(result, 'pairing confirmation')
  }

  async close(): Promise<void> {
    this.closedExplicitly = true
    this.terminalNoReconnect = true
    this.clearAllTimers()
    this.detachSignaling()
    this.authenticatedPeerContext = undefined
    this.pendingSignalingEpochMessages.length = 0
    this.closeChannel()
    this.closePeerConnection()
    this.frameListeners.clear()
    await this.options.signaling.close()
    this.transition('closed')
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    if (this.isTerminal()) return
    if (this.state === 'signaling-connecting') {
      if (this.startupSignalingMessages.length >= MAX_STARTUP_SIGNALING_MESSAGES) {
        this.startupSignalingMessages.shift()
      }
      this.startupSignalingMessages.push(message)
      return
    }
    if (!this.acceptRemoteIdentity(message)) return

    if (message.channel === 'presence') {
      await this.handlePresence(message)
      return
    }
    if (message.channel === 'offer') {
      await this.handleOffer(message)
      return
    }
    if (message.channel === 'answer') {
      await this.handleAnswer(message)
      return
    }
    if (message.channel === 'candidate') {
      await this.handleCandidate(message)
    }
  }

  private acceptRemoteIdentity(message: SignalingMessage): boolean {
    if (message.from === this.options.localSignalingId) return false
    const stable = message.stablePeerId ?? message.envelope.stable_peer_id
    if (this.options.expectedRemoteSignalingId !== undefined && message.from !== this.options.expectedRemoteSignalingId) {
      this.terminalNoReconnect = true
      this.fail('remote signaling identity mismatch', false)
      return false
    }
    if (this.options.expectedRemoteStableId !== undefined && stable !== undefined && stable !== this.options.expectedRemoteStableId) {
      this.terminalNoReconnect = true
      this.fail('remote stable identity mismatch', false)
      return false
    }
    if (this.remoteStableId !== undefined && stable !== undefined && stable !== this.remoteStableId) {
      this.terminalNoReconnect = true
      this.fail('remote stable identity changed', false)
      return false
    }
    if (this.remoteSignalingId !== undefined && message.from !== this.remoteSignalingId) {
      const trustedStableId = this.remoteStableId ?? this.options.expectedRemoteStableId
      if (trustedStableId !== undefined && stable === trustedStableId) {
        if (message.envelope.type !== 'presence_departed') {
          if (this.pendingSignalingEpochMessages.length >= MAX_STARTUP_SIGNALING_MESSAGES) {
            this.pendingSignalingEpochMessages.shift()
          }
          this.pendingSignalingEpochMessages.push(message)
        }
        this.remoteSignalingEpochInvalidated = true
        if (this.state !== 'reconnecting') {
          this.onTransientDisconnect('remote signaling session changed')
        }
        return false
      }
      this.terminalNoReconnect = true
      this.fail('remote signaling identity changed', false)
      return false
    }
    this.remoteSignalingId = message.from
    if (stable !== undefined) this.remoteStableId = stable
    return true
  }

  private async handlePresence(message: SignalingMessage): Promise<void> {
    if (message.envelope.type === 'presence_departed') {
      this.remoteSignalingEpochInvalidated = true
      this.onTransientDisconnect('remote signaling session departed')
      return
    }
    if (this.state !== 'discovering-peer' && this.state !== 'reconnecting') return
    this.clearTimerKind('discovery')
    this.role = this.options.localSignalingId < message.from ? 'offerer' : 'answerer'
    if (this.role === 'offerer') {
      await this.beginOffer()
    }
  }

  private async beginOffer(): Promise<void> {
    if (this.state !== 'discovering-peer' && this.state !== 'reconnecting') return
    this.clearTimerKind('discovery')
    this.ensurePeerConnection()
    const pc = this.pc!
    const generation = this.transportGeneration
    const remoteSignalingId = this.remoteSignalingId
    if (remoteSignalingId === undefined) return
    this.attachDataChannel(pc.createDataChannel(AURORA_RPC_DATA_CHANNEL_LABEL, { ordered: true }))
    this.transition('negotiating')
    this.armTimeout('negotiation', this.timeouts.negotiationMs, () => {
      if (this.isCurrentTransport(pc, generation)) this.fail('negotiation timeout', true)
    })
    const offer = await pc.createOffer()
    if (!this.isCurrentNegotiation(pc, generation)) return
    await pc.setLocalDescription(offer)
    if (!this.isCurrentNegotiation(pc, generation)) return
    const localOfferSdp = pc.localDescription?.sdp ?? offer.sdp
    this.offerSdpTranscript = localOfferSdp
    this.answerSdpTranscript = undefined
    if (!this.isCurrentNegotiation(pc, generation)) return
    await this.options.signaling.publish('offer', { type: 'offer', from: this.options.localSignalingId, to: remoteSignalingId, sdp: localOfferSdp }, remoteSignalingId)
  }

  private async handleOffer(message: SignalingMessage): Promise<void> {
    if (this.options.localSignalingId < message.from) return
    if (this.state !== 'discovering-peer' && this.state !== 'reconnecting' && this.state !== 'negotiating') return
    const sdp = typeof message.envelope.sdp === 'string' ? message.envelope.sdp : undefined
    if (sdp === undefined) {
      this.fail('offer missing sdp', false)
      return
    }
    this.clearTimerKind('discovery')
    this.role = 'answerer'
    this.ensurePeerConnection()
    const pc = this.pc!
    const generation = this.transportGeneration
    this.transition('negotiating')
    this.armTimeout('negotiation', this.timeouts.negotiationMs, () => {
      if (this.isCurrentTransport(pc, generation)) this.fail('negotiation timeout', true)
    })
    await pc.setRemoteDescription({ type: 'offer', sdp })
    if (!this.isCurrentNegotiation(pc, generation)) return
    this.offerSdpTranscript = sdp
    this.answerSdpTranscript = undefined
    const answer = await pc.createAnswer()
    if (!this.isCurrentNegotiation(pc, generation)) return
    await pc.setLocalDescription(answer)
    if (!this.isCurrentNegotiation(pc, generation)) return
    const localAnswerSdp = pc.localDescription?.sdp ?? answer.sdp
    this.answerSdpTranscript = localAnswerSdp
    if (!this.isCurrentNegotiation(pc, generation)) return
    await this.options.signaling.publish('answer', { type: 'answer', from: this.options.localSignalingId, to: message.from, sdp: localAnswerSdp }, message.from)
  }

  private async handleAnswer(message: SignalingMessage): Promise<void> {
    if (this.role !== 'offerer' || this.state !== 'negotiating') return
    const sdp = typeof message.envelope.sdp === 'string' ? message.envelope.sdp : undefined
    if (sdp === undefined) {
      this.fail('answer missing sdp', false)
      return
    }
    const pc = this.pc
    if (pc === undefined) return
    const generation = this.transportGeneration
    await pc.setRemoteDescription({ type: 'answer', sdp })
    if (!this.isCurrentNegotiation(pc, generation)) return
    this.answerSdpTranscript = sdp
  }

  private async handleCandidate(message: SignalingMessage): Promise<void> {
    const pc = this.pc
    if (pc === undefined) return
    const generation = this.transportGeneration
    const candidate = message.envelope.candidate
    if (candidate === null) {
      await pc.addIceCandidate(null)
      return
    }
    if (typeof candidate !== 'string') return
    const icePath = categorizeIceCandidate(candidate)
    const init: IceCandidateInitLike = { candidate }
    if (typeof message.envelope.sdp_mid === 'string') init.sdpMid = message.envelope.sdp_mid
    if (typeof message.envelope.sdp_mline_index === 'number') init.sdpMLineIndex = message.envelope.sdp_mline_index
    await pc.addIceCandidate(init)
    if (!this.isCurrentTransport(pc, generation)) return
    this.icePath = icePath
    this.emit()
  }

  private ensurePeerConnection(): void {
    if (this.pc !== undefined) return
    const pc = this.options.createPeerConnection({ iceServers: this.options.iceServers ?? [] })
    const generation = this.transportGeneration + 1
    this.transportGeneration = generation
    this.pc = pc
    pc.onicecandidate = (event) => void this.onIceCandidate(pc, generation, event)
    pc.ondatachannel = (event) => this.onRemoteDataChannel(pc, generation, event.channel)
    pc.onconnectionstatechange = () => this.onConnectionStateChanged(pc, generation)
    pc.oniceconnectionstatechange = () => this.onConnectionStateChanged(pc, generation)
  }

  private async onIceCandidate(pc: PeerConnectionLike, generation: number, event: IceCandidateEventLike): Promise<void> {
    if (!this.isCurrentTransport(pc, generation) || this.isTerminal() || this.remoteSignalingId === undefined) return
    const remoteSignalingId = this.remoteSignalingId
    if (event.candidate === null) {
      await this.options.signaling.publish('candidate', { type: 'candidate', from: this.options.localSignalingId, to: remoteSignalingId, candidate: null }, remoteSignalingId)
      return
    }
    const init = candidateToInit(event.candidate)
    const icePath = categorizeIceCandidate(init.candidate)
    if (!this.isCurrentTransport(pc, generation)) return
    await this.options.signaling.publish('candidate', {
      type: 'candidate',
      from: this.options.localSignalingId,
      to: remoteSignalingId,
      candidate: init.candidate,
      candidate_category: icePath,
      sdp_mid: init.sdpMid ?? null,
      sdp_mline_index: init.sdpMLineIndex ?? null
    }, remoteSignalingId)
    if (!this.isCurrentTransport(pc, generation)) return
    this.icePath = icePath
    this.emit()
  }

  private onRemoteDataChannel(pc: PeerConnectionLike, generation: number, channel: DataChannelLike): void {
    if (!this.isCurrentTransport(pc, generation)) {
      channel.close()
      return
    }
    if (channel.label !== AURORA_RPC_DATA_CHANNEL_LABEL) {
      channel.close()
      this.terminalNoReconnect = true
      this.fail('unexpected data channel label', false)
      return
    }
    if (this.role === 'offerer') {
      channel.close()
      this.terminalNoReconnect = true
      this.fail('offerer received unexpected data channel', false)
      return
    }
    this.attachDataChannel(channel)
  }

  private attachDataChannel(channel: DataChannelLike): void {
    if (this.channel !== undefined && this.channel !== channel) {
      this.closeChannel()
    } else {
      this.channelFlow?.close()
      this.channelFlow = undefined
    }
    this.channel = channel
    this.channelFlow = new DataChannelFlowController(channel, this.options.dataChannelFlowLimits)
    this.bindDataChannel(channel)
  }

  private bindDataChannel(channel: DataChannelLike): void {
    this.sentLocalProtocolHello = false
    this.pendingRemoteProtocolHello = undefined
    this.receiveQueue = Promise.resolve()
    channel.onopen = () => void this.onChannelOpen(channel)
    channel.onmessage = (event) => {
      const decoded = this.decodeChannelFrame(channel, event.data)
      // Pairing/reconnect handlers can legitimately wait for an RPC response,
      // or receive the peer's reciprocal pairing call, on this same
      // DataChannel. Resolve RPC control frames outside the ordered
      // application-frame queue so that operation cannot deadlock itself,
      // while all non-RPC frames remain strictly arrival-ordered.
      const controlFastPath = decoded
        .then(async (frame) => {
          if (!isRpcControlFrame(frame)) return false
          await this.processChannelFrame(channel, frame)
          return true
        })
        .catch((error) => {
          this.rejectChannelFrame(channel, error)
          return true
        })
      const job = this.receiveQueue.then(async () => {
        if (await controlFastPath) return
        await this.processChannelFrame(channel, await decoded)
      })
      this.receiveQueue = job.catch(() => undefined)
    }
    channel.onclose = () => this.onTransientDisconnect('data channel closed')
    channel.onerror = () => this.onTransientDisconnect('data channel error')
  }

  private async onChannelOpen(channel: DataChannelLike): Promise<void> {
    try {
      if (this.isTerminal() || this.channel !== channel) return
      this.clearTimerKind('negotiation')
      this.transition('channel-open')
      this.armTimeout('auth', this.timeouts.authMs, () => this.fail('auth timeout', true))
      const auth = this.requiredAuth()
      if (auth === undefined) return
      const context = this.authContext(channel)
      if (auth.tryReconnect !== undefined) {
        this.transition('reconnect-authenticating')
        const reconnectResult = await auth.tryReconnect(context)
        if (this.channel !== channel || this.isTerminal()) return
        await this.applyReconnectResult(reconnectResult)
        if (this.state === 'authorized' || this.state === 'failed') return
      }
      this.transition('pairing-required')
      await auth.startPairing?.(context)
      if (this.channel !== channel || this.isTerminal()) return
      if (this.state === 'pairing-required') {
        this.transition('awaiting-sas-confirmation')
        this.armTimeout('auth', this.timeouts.pairingMs, () => this.fail('pairing timeout', true))
      }
    } catch (error) {
      if (this.isTerminal() || this.closedExplicitly || this.channel !== channel) return
      this.terminalNoReconnect = true
      this.fail(error, false)
    }
  }

  private async decodeChannelFrame(
    channel: DataChannelLike,
    data: string | ArrayBuffer | ArrayBufferView
  ): Promise<unknown> {
    if (this.channel !== channel || this.isTerminal()) return undefined
    return await this.options.codec.open(data)
  }

  private async processChannelFrame(channel: DataChannelLike, frame: unknown): Promise<void> {
    if (this.channel !== channel || this.isTerminal()) return
    try {
      if (this.state === 'authorized') {
        if (await this.handleAuthorizedAuthFrame(frame, channel)) return
        this.deliverFrame(frame)
        return
      }
      if (this.isPreAuthState()) {
        await this.handlePreAuthFrame(frame, channel)
      }
    } catch (error) {
      this.rejectChannelFrame(channel, error)
    }
  }

  private rejectChannelFrame(channel: DataChannelLike, error: unknown): void {
    if (this.channel !== channel || this.isTerminal()) return
    this.terminalNoReconnect = true
    this.fail(`encrypted data channel frame rejected: ${redactError(error)}`, false)
  }

  private async handleAuthorizedAuthFrame(frame: unknown, channel: DataChannelLike): Promise<boolean> {
    const auth = this.requiredAuth()
    if (auth === undefined) return false
    const result = await auth.handleFrame(frame, this.authContext(channel))
    if (this.channel !== channel || this.isTerminal()) return true
    if (result === true) return true
    if (typeof result === 'object' && result !== null) {
      if (result.retry === true) {
        this.fail('authorized auth retry required', true)
        return true
      }
      if (result.denied === true || result.terminal === true) {
        this.terminalNoReconnect = true
        this.fail('authorized auth frame denied', false)
        return true
      }
      if (result.authenticated === true) {
        this.updateAuthenticatedContext(result.authenticatedPeerContext)
        return true
      }
      if (result.handled === true) return true
    }
    return false
  }

  private async handlePreAuthFrame(frame: unknown, channel: DataChannelLike): Promise<void> {
    const auth = this.requiredAuth()
    if (auth === undefined) return
    const isHello = isProtocolHelloFrame(frame)
    if (isHello) {
      try {
        parseProtocolHello(frame)
      } catch {
        this.terminalNoReconnect = true
        this.fail('invalid protocol hello', false)
        return
      }
      this.pendingRemoteProtocolHello = frame
    }
    const result = await auth.handleFrame(frame, this.authContext(channel))
    if (this.channel !== channel || this.isTerminal()) return
    const authenticated = result === true || (typeof result === 'object' && result !== null && result.authenticated === true)
    await this.applyAuthResult(
      result,
      'preauth frame',
      authenticated ? this.pendingRemoteProtocolHello : undefined
    )
    if (authenticated) this.pendingRemoteProtocolHello = undefined
  }

  private authContext(channel: DataChannelLike): PeerSessionAuthContext {
    if (this.remoteSignalingId === undefined) throw new Error('remote peer is not known')
    const context: PeerSessionAuthContext = {
      localSignalingId: this.options.localSignalingId,
      remoteSignalingId: this.remoteSignalingId,
      sendControlFrame: (frame: unknown) => this.sendControlFrame(frame, channel)
    }
    const offerSdp = this.offerSdpTranscript ?? (this.role === 'offerer' ? this.pc?.localDescription?.sdp : this.pc?.remoteDescription?.sdp)
    const answerSdp = this.answerSdpTranscript ?? (this.role === 'offerer' ? this.pc?.remoteDescription?.sdp : this.pc?.localDescription?.sdp)
    if (offerSdp !== undefined) context.offerSdp = offerSdp
    if (answerSdp !== undefined) context.answerSdp = answerSdp
    if (this.options.localStableId !== undefined) context.localStableId = this.options.localStableId
    if (this.remoteStableId !== undefined) context.remoteStableId = this.remoteStableId
    return context
  }

  private onConnectionStateChanged(pc: PeerConnectionLike, generation: number): void {
    if (!this.isCurrentTransport(pc, generation)) return
    const state = pc.connectionState ?? pc.iceConnectionState
    if (state === 'failed' || state === 'disconnected') {
      this.onTransientDisconnect(`peer connection ${state}`)
    }
  }

  private onTransientDisconnect(reason: string): void {
    if (this.closedExplicitly || this.terminalNoReconnect || this.isTerminal()) return
    if (this.state === 'reconnecting') return
    this.authenticatedPeerContext = undefined
    if (this.reconnectAttempts >= this.reconnectOptions.maxAttempts) {
      this.fail(reason, false)
      return
    }
    this.clearTimerKind('signaling')
    this.clearTimerKind('discovery')
    this.clearTimerKind('negotiation')
    this.clearTimerKind('auth')
    this.clearTimerKind('pairing-exchange')
    this.reconnectAttempts += 1
    this.transition('reconnecting')
    const jitter = 1 + ((this.random() * 2 - 1) * this.reconnectOptions.jitterRatio)
    const base = Math.min(this.reconnectOptions.maxDelayMs, this.reconnectOptions.baseDelayMs * 2 ** (this.reconnectAttempts - 1))
    this.armTimeout('reconnect', Math.max(0, Math.round(base * jitter)), () => {
      void this.restartAfterTransientDisconnect()
    })
  }

  private async restartAfterTransientDisconnect(): Promise<void> {
    if (this.closedExplicitly || this.terminalNoReconnect || this.state === 'closed') return
    this.closeChannel()
    this.closePeerConnection()
    this.options.auth.resetTransport?.()
    if (this.remoteSignalingEpochInvalidated) {
      this.remoteSignalingId = undefined
      this.role = 'unknown'
      this.remoteSignalingEpochInvalidated = false
    }
    this.offerSdpTranscript = undefined
    this.answerSdpTranscript = undefined
    this.transition('discovering-peer')
    this.armTimeout('discovery', this.timeouts.discoveryMs, () => this.fail('peer discovery timeout', true))
    try {
      await this.options.signaling.publish('presence', {
        type: 'presence',
        from: this.options.localSignalingId,
        stable_peer_id: this.options.localStableId
      })
      const epochMessages = this.pendingSignalingEpochMessages.splice(0)
      for (const message of epochMessages) {
        if (this.isTerminal()) break
        await this.handleSignalingMessage(message)
      }
      if (this.role === 'offerer' && this.remoteSignalingId !== undefined) {
        await this.beginOffer()
      }
    } catch (error) {
      this.fail(error, true)
    }
  }

  private async sendControlFrame(frame: unknown, channel?: DataChannelLike): Promise<void> {
    const expectedChannel = channel ?? this.channel
    if (expectedChannel === undefined) throw new Error('Aurora WebRTC control channel is not open')
    return this.enqueueFrame(
      frame,
      'Aurora WebRTC control channel is not open',
      () => this.channel === expectedChannel && expectedChannel.readyState === 'open'
    )
  }

  private async enqueueFrame(frame: unknown, errorMessage: string, isAllowed: () => boolean): Promise<void> {
    const job = this.sendQueue.then(async () => {
      if (!isAllowed()) throw new Error(errorMessage)
      const sealed = await this.options.codec.seal(frame)
      const channel = this.channel
      const flow = this.channelFlow
      if (channel?.readyState !== 'open' || flow === undefined) {
        throw new Error(errorMessage)
      }
      const sent = await flow.send(sealed)
      if (!sent) throw new Error('Aurora WebRTC data channel send failed')
    })
    this.sendQueue = job.catch(() => undefined)
    return job
  }

  private requiredAuth(): PeerSessionAuthPort | undefined {
    const auth = this.options.auth
    if (auth === undefined || typeof auth.handleFrame !== 'function') {
      this.terminalNoReconnect = true
      this.fail('auth port with handleFrame is required', false)
      return undefined
    }
    return auth
  }

  private async applyReconnectResult(result: PeerSessionAuthFrameResult): Promise<void> {
    if (result === true || (typeof result === 'object' && result !== null && result.authenticated === true)) {
      await this.completeAuthentication(undefined, typeof result === 'object' && result !== null ? result.authenticatedPeerContext : undefined)
      return
    }
    if (typeof result === 'object' && result !== null && (result.denied === true || result.terminal === true)) {
      this.terminalNoReconnect = true
      this.fail('reconnect denied', false)
      return
    }
    if (typeof result === 'object' && result !== null && result.retry === true) this.fail('reconnect retry required', true)
  }

  private async applyAuthResult(result: PeerSessionAuthFrameResult, source: string, replayFrame?: unknown): Promise<void> {
    if (result === true || (typeof result === 'object' && result !== null && result.authenticated === true)) {
      await this.completeAuthentication(replayFrame, typeof result === 'object' && result !== null ? result.authenticatedPeerContext : undefined)
      return
    }
    if (typeof result === 'object' && result !== null && result.retry === true) {
      this.fail(`${source} retry required`, true)
      return
    }
    if (result === false || (typeof result === 'object' && result !== null && (result.denied === true || result.terminal === true))) {
      this.terminalNoReconnect = true
      this.fail(`${source} denied`, false)
    }
  }

  private async completeAuthentication(replayFrame?: unknown, authenticatedPeerContext?: AuthenticatedPeerContext): Promise<void> {
    if (this.state === 'authorized' || this.isTerminal()) return
    this.clearAllTimers()
    let localHello: unknown
    if (!this.sentLocalProtocolHello) {
      try {
        localHello = this.options.localProtocolHello ?? defaultLocalConsumerHello()
        parseProtocolHello(localHello)
      } catch (error) {
        this.terminalNoReconnect = true
        this.fail(error, false)
        return
      }
    }
    this.authenticatedPeerContext = authenticatedPeerContext === undefined ? undefined : cloneAuthenticatedPeerContext(authenticatedPeerContext)
    this.pendingRemoteProtocolHello = undefined
    this.lastError = undefined
    this.transition('authorized')
    if (replayFrame !== undefined) this.deliverFrame(replayFrame)
    if (localHello !== undefined) {
      this.sentLocalProtocolHello = true
      try {
        await this.sendControlFrame(localHello)
      } catch (error) {
        this.terminalNoReconnect = true
        this.fail(error, false)
      }
    }
  }

  private updateAuthenticatedContext(authenticatedPeerContext: AuthenticatedPeerContext | undefined): void {
    if (authenticatedPeerContext === undefined) return
    const next = cloneAuthenticatedPeerContext(authenticatedPeerContext)
    if (JSON.stringify(this.authenticatedPeerContext) === JSON.stringify(next)) return
    this.authenticatedPeerContext = next
    this.emit()
  }

  private deliverFrame(frame: unknown): void {
    for (const listener of [...this.frameListeners]) listener(frame)
  }

  private isPreAuthState(): boolean {
    return this.state === 'channel-open'
      || this.state === 'pairing-required'
      || this.state === 'reconnect-authenticating'
      || this.state === 'awaiting-sas-confirmation'
  }

  private transition(state: PeerSessionState): void {
    if (this.state === state) return
    if (this.state === 'closed' && state !== 'closed') return
    this.state = state
    this.emit()
  }

  private fail(error: unknown, allowReconnect: boolean): void {
    if (this.state === 'closed') return
    this.lastError = redactError(error)
    if (allowReconnect && !this.terminalNoReconnect && !this.closedExplicitly) {
      this.onTransientDisconnect(this.lastError)
      return
    }
    this.clearAllTimers()
    this.authenticatedPeerContext = undefined
    this.closeChannel()
    this.closePeerConnection()
    this.frameListeners.clear()
    this.detachSignaling()
    this.state = 'failed'
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* observer errors must not alter transport state */ }
    }
  }

  private armTimeout(kind: string, ms: number, callback: () => void): void {
    this.clearTimerKind(kind)
    let handle: unknown
    handle = this.timers.setTimeout(() => {
      this.timerHandles.delete(handle)
      timerKinds.delete(handle)
      callback()
    }, ms)
    this.timerHandles.add(handle)
    timerKinds.set(handle, kind)
  }

  private clearTimerKind(kind: string): void {
    for (const handle of [...this.timerHandles]) {
      if (timerKinds.get(handle) === kind) {
        this.timers.clearTimeout(handle)
        this.timerHandles.delete(handle)
        timerKinds.delete(handle)
      }
    }
  }

  private clearAllTimers(): void {
    for (const handle of [...this.timerHandles]) {
      this.timers.clearTimeout(handle)
      timerKinds.delete(handle)
    }
    this.timerHandles.clear()
  }

  private closeChannel(): void {
    if (this.channel !== undefined) {
      this.channelFlow?.close()
      this.channelFlow = undefined
      this.channel.onopen = null
      this.channel.onmessage = null
      this.channel.onclose = null
      this.channel.onerror = null
      this.channel.close()
      this.channel = undefined
    } else {
      this.channelFlow?.close()
      this.channelFlow = undefined
    }
  }

  private closePeerConnection(): void {
    if (this.pc !== undefined) {
      const pc = this.pc
      this.pc = undefined
      this.transportGeneration += 1
      pc.onicecandidate = null
      pc.ondatachannel = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      pc.close()
    }
  }

  private isCurrentTransport(pc: PeerConnectionLike, generation: number): boolean {
    return this.pc === pc && this.transportGeneration === generation && !this.closedExplicitly && !this.isTerminal()
  }

  private isCurrentNegotiation(pc: PeerConnectionLike, generation: number): boolean {
    return this.isCurrentTransport(pc, generation) && this.state === 'negotiating'
  }

  private detachSignaling(): void {
    this.unsubscribeSignaling?.()
    this.unsubscribeSignaling = undefined
  }

  private isTerminal(): boolean {
    return this.state === 'closed' || this.state === 'failed'
  }
}

function isProtocolHelloFrame(frame: unknown): boolean {
  return typeof frame === 'object'
    && frame !== null
    && !Array.isArray(frame)
    && (frame as { type?: unknown }).type === 'protocol_hello'
}

function isRpcControlFrame(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return false
  }
  const candidate = frame as { type?: unknown; id?: unknown; method?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false
  if (candidate.type === 'result' || candidate.type === 'error') return true
  return candidate.type === 'call' && typeof candidate.method === 'string'
}

function defaultLocalConsumerHello(): unknown {
  return buildProtocolHello({
    role: 'consumer',
    capabilities: [
      CAP_FRAGMENTATION_V1,
      CAP_BACKPRESSURE_V1,
      CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
      CAP_CONSUMER_ONLY_V1
    ]
  })
}

const timerKinds = new Map<unknown, string>()

function emptySelectedCandidatePairEvidence(): SelectedCandidatePairEvidence {
  return {
    selected: false,
    category: 'unknown',
    statsSource: 'RTCPeerConnection.getStats',
    rawAddressRedacted: true
  }
}

function selectedCandidatePairEvidenceFromStats(
  report: RTCStatsReport | Map<string, unknown>,
  hints: { configuredStunServers?: readonly string[] } = {}
): SelectedCandidatePairEvidence {
  const stats = new Map<string, any>()
  ;(report as any).forEach((value: unknown, key: string) => stats.set(String(key), value))
  let pair: any | undefined
  for (const item of stats.values()) {
    if (item?.type === 'transport' && typeof item.selectedCandidatePairId === 'string') {
      pair = stats.get(item.selectedCandidatePairId)
      if (pair) break
    }
  }
  if (!pair) {
    const candidatePairs = Array.from(stats.values()).filter((item) => item?.type === 'candidate-pair')
    pair = candidatePairs.find((item) => item.selected === true)
      ?? candidatePairs
        .filter((item) => item.nominated === true && item.state === 'succeeded')
        .sort((a, b) => candidatePairTrafficScore(b) - candidatePairTrafficScore(a))[0]
      ?? candidatePairs
        .filter((item) => item.state === 'succeeded')
        .sort((a, b) => candidatePairTrafficScore(b) - candidatePairTrafficScore(a))[0]
      ?? candidatePairs.find((item) => item.nominated === true)
  }
  if (!pair) return emptySelectedCandidatePairEvidence()
  const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined
  const remote = typeof pair.remoteCandidateId === 'string' ? stats.get(pair.remoteCandidateId) : undefined
  const localType = safeCandidateType(local)
  const remoteType = safeCandidateType(remote)
  const category = selectedPairCategory(localType, remoteType)
  const stunServerReflexiveCandidate = stunServerReflexiveCandidateEvidenceFromStats(stats, hints.configuredStunServers ?? [])
  const out: SelectedCandidatePairEvidence = {
    selected: true,
    category,
    statsSource: 'RTCPeerConnection.getStats',
    rawAddressRedacted: true
  }
  if (typeof pair.state === 'string') out.pairState = pair.state
  if (typeof pair.nominated === 'boolean') out.nominated = pair.nominated
  if (localType !== undefined) out.localCandidateType = localType
  if (remoteType !== undefined) out.remoteCandidateType = remoteType
  if (typeof local?.protocol === 'string') out.localProtocol = local.protocol
  if (typeof remote?.protocol === 'string') out.remoteProtocol = remote.protocol
  if (typeof local?.relayProtocol === 'string') out.localRelayProtocol = local.relayProtocol
  if (typeof remote?.relayProtocol === 'string') out.remoteRelayProtocol = remote.relayProtocol
  if (stunServerReflexiveCandidate.gathered) out.stunServerReflexiveCandidate = stunServerReflexiveCandidate
  return out
}

function candidatePairTrafficScore(pair: any): number {
  const sent = typeof pair?.bytesSent === 'number' ? pair.bytesSent : 0
  const received = typeof pair?.bytesReceived === 'number' ? pair.bytesReceived : 0
  return sent + received
}

function safeCandidateType(candidate: any): string | undefined {
  const value = candidate?.candidateType
  if (value === 'host' || value === 'srflx' || value === 'relay' || value === 'prflx') return value
  return undefined
}

function selectedPairCategory(
  localType: string | undefined,
  remoteType: string | undefined
): IcePathCategory {
  if (localType === 'relay' || remoteType === 'relay') return 'relay'
  if (localType === 'srflx' || remoteType === 'srflx') return 'srflx'
  if (localType === 'prflx' || remoteType === 'prflx') return 'prflx'
  if (localType === 'host' || remoteType === 'host') return 'host'
  return 'unknown'
}

function stunServerReflexiveCandidateEvidenceFromStats(
  stats: Map<string, any>,
  configuredStunServers: readonly string[]
): StunServerReflexiveCandidateEvidence {
  const configured = new Set(configuredStunServers)
  const configuredStunServerCount = configuredStunServers.length
  for (const candidate of stats.values()) {
    if (candidate?.type !== 'local-candidate' || candidate.candidateType !== 'srflx') continue
    const url = typeof candidate.url === 'string' ? candidate.url : undefined
    const urlScheme = url?.startsWith('stuns:') ? 'stuns' : url?.startsWith('stun:') ? 'stun' : undefined
    return {
      gathered: true,
      candidateType: 'srflx',
      ...(urlScheme !== undefined ? { urlScheme } : {}),
      ...(url !== undefined ? { urlMatchesConfiguredStunServer: configured.has(url) } : {}),
      configuredStunServerCount,
      statsSource: 'RTCPeerConnection.getStats',
      rawAddressRedacted: true
    }
  }
  return {
    gathered: false,
    configuredStunServerCount,
    statsSource: 'RTCPeerConnection.getStats',
    rawAddressRedacted: true
  }
}

function isStunServerUrl(url: string): boolean {
  return url.startsWith('stun:') || url.startsWith('stuns:')
}

function iceServerUrls(server: RTCIceServer): string[] {
  if (typeof server.urls === 'string') return [server.urls]
  if (Array.isArray(server.urls)) return server.urls.filter((url): url is string => typeof url === 'string')
  return []
}
