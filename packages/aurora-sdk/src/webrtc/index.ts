export type {
  AuroraConnectionMode,
  IcePathCategory,
  PeerPairingApproval,
  PeerConnectionController,
  PeerConnectionSnapshot,
  PeerConnectionState,
  RedactedPeerDiagnostic,
  SelectedCandidatePairEvidence,
  StunServerReflexiveCandidateEvidence,
  WebRtcAuroraRuntime,
  WebRtcPeerConnectionProfile
} from './types.js'

export {
  AURORA_RPC_DATA_CHANNEL_LABEL,
  WebRtcPeerSession,
  categorizeIceCandidate
} from './peer-session.js'
export type {
  DataChannelEventLike,
  DataChannelLike,
  IceCandidateEventLike,
  IceCandidateInitLike,
  IceCandidateLike,
  PeerConnectionLike,
  PeerSessionPeerConnectionFactory,
  PeerSessionAuthContext,
  PeerSessionAuthPort,
  PeerSessionDiagnostics,
  PeerSessionFrameCodec,
  PeerSessionListener,
  PeerSessionOptions,
  PeerSessionReconnectOptions,
  PeerSessionRole,
  PeerSessionSignalingPort,
  PeerSessionSnapshot,
  PeerSessionState,
  PeerSessionTimeouts,
  SessionDescriptionLike,
  SignalingEnvelope,
  SignalingMessage
} from './peer-session.js'

export {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_PROVIDER_LEASE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  DEFAULT_FRAGMENT_PAYLOAD_BYTES,
  DEFAULT_INCOMPLETE_TTL_SECONDS,
  DEFAULT_MAX_FRAGMENTS,
  DEFAULT_MAX_LOGICAL_BYTES,
  DEFAULT_MAX_PEER_AGGREGATE_BYTES,
  DEFAULT_PEER_CAPABILITIES,
  FRAGMENT_FRAME_TYPE,
  FragmentProtocolError,
  FragmentReassembler,
  KNOWN_PEER_CAPABILITIES,
  PEER_PROTOCOL_VERSION,
  PROTOCOL_HELLO_TYPE,
  PeerProtocolError,
  PeerProtocolLimits,
  buildProtocolHello,
  fragmentMessage,
  negotiateProtocol,
  parseProtocolHello
} from './peer-protocol.js'
export type {
  FragmentFrame,
  NegotiatedPeerProtocol,
  PeerRole,
  ProtocolHello
} from './peer-protocol.js'

export {
  DEFAULT_DATA_CHANNEL_FLOW_LIMITS,
  DataChannelFlowController,
  sendOrderedWithBackpressure
} from './datachannel-flow.js'
export type { DataChannelFlowLimits } from './datachannel-flow.js'

export {
  MeshEventSubscriptionRegistry,
  CORRELATION_REQUIRED_EVENT_TOPICS
} from './event-subscriptions.js'
export type {
  MeshEventSubscriptionRegistryOptions,
  MeshEventSubscriptionSnapshot,
  RejectedSubscriptionTopic,
  SubscribeResult
} from './event-subscriptions.js'

export {
  DEFAULT_PARSER_LIMITS,
  WebRtcProtocolParseError,
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  parseWebRtcFrame,
  parseWebRtcJsonFrame
} from './protocol.js'
export type {
  AnswerFrame,
  AuroraPairingFrame,
  AuroraProtocolFrame,
  AuroraRpcFrame,
  AuroraSignalingFrame,
  AuroraSubscriptionFrame,
  AuthFrameType,
  CallFrame,
  CandidateFrame,
  CancelFrame,
  CapacityUpdateFrame,
  ChunkFrame,
  ErrorFrame,
  EventFrame,
  OfferFrame,
  PairingCommitFrame,
  PairingFrameType,
  PairingRevealFrame,
  PairingTerminalFrame,
  ParserLimits,
  PresenceFrame,
  ManifestAckFrame,
  ProviderLeaseFrame,
  ResultFrame,
  RpcFrameType,
  SignalingFrameType,
  SubscribeFrame,
  SubscribeRejectedFrame,
  SubscribedFrame,
  SubscriptionFrameType,
  UnsubscribeFrame,
  UnsubscribedFrame
} from './protocol.js'

export * from '../peer-host/index.js'

export {
  PAIRING_COMMIT_TYPE,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_REVEAL_TYPE,
  PAIRING_TERMINAL_TYPE,
  PairingProtocolError,
  PairingSasHandshake,
  deriveChannelBinding,
  derivePairingSas,
  nonceCommitment,
  pairingIdentity,
  parsePairingCommitMessage,
  parsePairingRevealMessage,
  parsePairingTerminalMessage
} from './pairing.js'
export type {
  DeriveChannelBindingInput,
  PairingCommitMessage,
  PairingHandshakeOptions,
  PairingHandshakeState,
  PairingIdentity,
  PairingRevealMessage,
  PairingRole,
  PairingSasResult,
  PairingTerminalMessage,
  PairingTerminalStatus
} from './pairing.js'

export {
  DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS,
  DeterministicPeerCredentialStore,
  MemoryPeerCredentialStore,
  NativePeerCredentialStore
} from './credentials.js'
export type {
  MeshPeerCredentialRecord,
  MeshReconnectChallengeMessage,
  MeshReconnectProofMessage,
  NativePeerCredentialCommandInvoker,
  NativePeerCredentialCommandNames,
  NativePeerCredentialStoreOptions,
  PeerCredentialStatus,
  PeerCredentialStore as WebRtcPeerCredentialStore,
  StoredPeerCredentialMetadata
} from './credentials.js'

export {
  MqttWebSocketSignalingClient,
  directTopic,
  randomSignalingPeerId,
  redactBrokerUrl,
  roomSubscriptions,
  topicBase
} from './signaling-mqtt.js'
export type {
  MqttSignalingClientSnapshot,
  MqttSignalingDiagnostics,
  MqttSignalingEnvelope,
  MqttSignalingMessage,
  MqttSignalingPresence,
  MqttSignalingRoom,
  MqttSignalingOptions,
  SignalingChannel as MqttSignalingChannel
} from './signaling-mqtt.js'

export {
  SIGNALING_PEER_NOT_ALLOWLISTED_REASON,
  SignalingSessionAllowlist
} from './signaling-allowlist.js'
export type {
  SignalingAllowlistCandidate,
  SignalingSessionAllowlistOptions,
  SignalingSessionAllowlistSnapshot
} from './signaling-allowlist.js'


export {
  TimeoutError,
  WebRtcMeshPeerBridge,
  createWebRtcMeshTransport
} from './mesh-peer-bridge.js'
export type {
  WebRtcMeshPeerBridgeOptions,
  WebRtcMeshTransportOptions
} from './mesh-peer-bridge.js'


export {
  MeshPeerBridgeRouter,
  PEER_NOT_REGISTERED_REASON,
  peerNotRegisteredError
} from './mesh-bridge-router.js'
export type { MeshPeerBridgeRouterOptions } from './mesh-bridge-router.js'

export {
  CONNECT_IS_SINGLE_PEER_REASON,
  MeshPeerSessionRegistry,
  PEER_ALREADY_REGISTERED_REASON,
  connectIsSinglePeerError,
  peerAlreadyRegisteredError
} from './peer-registry.js'
export type {
  MeshDiscoveredPeer,
  MeshPeerConnectionPolicy,
  MeshPeerRegistryController,
  MeshPeerRosterEntry,
  MeshPeerRosterSnapshot
} from './peer-registry.js'

export {
  createBrowserWebRtcAuroraRuntime
} from './runtime.js'
export type {
  BrowserWebRtcRuntime,
  BrowserWebRtcRuntimeOptions,
  WebRtcRuntimeHttpOptions
} from './runtime.js'
