/** Public browser/WebView WebRTC thin-client types.
 *
 * This file is dependency-free and SSR-safe: it contains no imports and touches
 * no browser, WebRTC, MQTT, Worker, or storage globals.
 */

export type AuroraConnectionMode = 'http-only' | 'webrtc-only' | 'webrtc-preferred'

export type PeerConnectionState =
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

export type IcePathCategory = 'unknown' | 'host' | 'srflx' | 'prflx' | 'relay'

export interface RedactedPeerDiagnostic {
  code: string
  action?: string
  message: string
  at: string
}

export interface WebRtcPeerConnectionProfile {
  mode: Extract<AuroraConnectionMode, 'webrtc-only' | 'webrtc-preferred'>
  appId: string
  room: string
  roomSecretRef: string
  signalingBrokers: readonly string[]
  expectedStablePeerId?: string
  expectedSignalingPeerId?: string
  nodeName?: string
  production?: boolean
  allowInsecureLoopbackSignaling?: boolean
  stunServers?: readonly string[]
  turnServers?: readonly string[]
  requireAppLayerE2ee?: boolean
}

export interface ReconnectChallenge {
  type: 'mesh_auth_challenge_v1'
  challenge: string
  channel_binding: string
  claimant_peer_id: string
  verifier_peer_id: string
  claimant_signaling_peer_id: string
  verifier_signaling_peer_id: string
  room_name: string
}

export interface ReconnectProof {
  type: 'mesh_auth_proof_v1'
  token_id: string
  challenge: string
  proof: string
  channel_binding: string
  claimant_peer_id: string
  verifier_peer_id: string
  claimant_signaling_peer_id: string
  verifier_signaling_peer_id: string
  room_name: string
}

export interface PeerCredentialMetadata {
  tokenId: string
  claimantPeerId: string
  verifierPeerId: string
  claimantSignalingPeerId: string
  verifierSignalingPeerId: string
  roomName: string
  createdAtMs?: number
  expiresAtMs?: number
}

export interface PeerCredentialStatus {
  peerId: string
  found: boolean
  hasBearerToken: boolean
  credential?: PeerCredentialMetadata
  backend: string
  persisted: boolean
  secretsRedacted: boolean
  redactedFields: readonly string[]
}

export interface PeerCredentialStore {
  get(peerId: string): Promise<PeerCredentialMetadata | undefined>
  createReconnectProof(peerId: string, challenge: ReconnectChallenge): Promise<ReconnectProof | undefined>
  status?(peerId: string): Promise<PeerCredentialStatus>
  remove(peerId: string): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
}

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

export interface PeerConnectionSnapshot {
  state: PeerConnectionState
  connectionMode: AuroraConnectionMode
  expectedStablePeerId?: string
  connectedStablePeerId?: string
  connectedSignalingPeerId?: string
  nodeName?: string
  selectedSignalingBrokerOrigin?: string
  icePathCategory: IcePathCategory
  protocolCapabilities: readonly string[]
  reconnectCount: number
  pendingCallCount: number
  pendingStreamCount: number
  pendingSubscriptionCount: number
  pendingFragmentCount: number
  bufferPressureHighWaterBytes: number
  lastRedactedError?: RedactedPeerDiagnostic
  pendingPairing?: {
    sessionId: string
    verificationCode: string
    remoteStablePeerId: string
    remoteNodeName: string
  }
  updatedAt: string
}

export interface PeerConnectionController {
  snapshot(): PeerConnectionSnapshot
  subscribe(listener: (snapshot: PeerConnectionSnapshot) => void): () => void
  connect(profile: WebRtcPeerConnectionProfile): Promise<void>
  confirmPairing(sessionId: string): Promise<void>
  rejectPairing(sessionId: string): Promise<void>
  disconnect(reason?: string): Promise<void>
  getSelectedCandidatePairEvidence(): Promise<SelectedCandidatePairEvidence>
}

export interface WebRtcAuroraRuntime<TClient = unknown> {
  client: TClient
  peer: PeerConnectionController
  close(): Promise<void>
}
