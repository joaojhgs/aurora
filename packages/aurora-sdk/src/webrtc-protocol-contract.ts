/** Descriptor-only WebRTC thin-shell protocol baseline.
 *
 * Keep this module dependency-free and browser/SSR safe. Runtime WebRTC support
 * imports it through the explicit `@aurora/client/webrtc-protocol-contract`
 * subpath; the SDK root intentionally does not import it.
 */

export const WEBRTC_THIN_PROTOCOL_VERSION = 1 as const
export const WEBRTC_THIN_CAPABILITY_VERSION = 1 as const
export const PAIRING_PROTOCOL_VERSION = 2 as const
export const INVITE_FORMAT_VERSION = 'amv1' as const
export const DATA_CHANNEL_LABEL = 'aurora-rpc' as const

export const SCRYPT_PARAMETERS = Object.freeze({
  n: 65_536,
  r: 8,
  p: 1,
  length: 32,
  salt: "sha256(app_id + '|' + room)"
})

export const HKDF_INFO = Object.freeze({
  signaling: 'aurora/webrtc/signaling',
  data: 'aurora/webrtc/data'
})

export const AEAD_PARAMETERS = Object.freeze({
  algorithm: 'AES-256-GCM',
  nonceBytes: 12,
  payload: 'nonce || ciphertext || tag',
  plaintextJson: "json.dumps(obj, separators=(',', ':'))"
})

export const SIGNALING_TOPICS = Object.freeze({
  root: 'aurora',
  base: '{root}/{app_id}/{room}/{channel}',
  direct: '{root}/{app_id}/{room}/{channel}/{peer_id}',
  subscriptions: Object.freeze([
    Object.freeze({ topic: '{root}/{app_id}/{room}/presence/+', qos: 1 }),
    Object.freeze({ topic: '{root}/{app_id}/{room}/offer/{peer_id}', qos: 0 }),
    Object.freeze({ topic: '{root}/{app_id}/{room}/answer/{peer_id}', qos: 0 }),
    Object.freeze({ topic: '{root}/{app_id}/{room}/candidate/{peer_id}', qos: 0 }),
    Object.freeze({ topic: '{root}/{app_id}/{room}/broadcast', qos: 0 })
  ])
})

export const RPC_FRAME_TYPES = Object.freeze(['call', 'result', 'error', 'chunk', 'eof', 'cancel', 'event'] as const)

export const WEBRTC_THIN_PROTOCOL_CAPABILITIES = Object.freeze({
  protocolVersion: WEBRTC_THIN_PROTOCOL_VERSION,
  capabilityVersion: WEBRTC_THIN_CAPABILITY_VERSION,
  pairingProtocolVersion: PAIRING_PROTOCOL_VERSION,
  inviteFormat: INVITE_FORMAT_VERSION,
  dataChannelLabel: DATA_CHANNEL_LABEL,
  signaling: Object.freeze({
    mqttV5: true,
    mqttWebsocketTransport: true,
    encryptedPresence: true,
    sessionSignalingPeerId: true
  }),
  crypto: Object.freeze({
    scryptRoomKeys: true,
    hkdfSha256: true,
    aesGcmNonceCiphertextTag: true,
    reconnectHmacSha256: true
  }),
  rpc: Object.freeze({
    jsonDataChannel: true,
    callResultError: true,
    streamChunkEof: true,
    cancel: true,
    forwardedEvent: true,
    fragmentation: true,
    backpressure: true,
    scopedEventSubscriptions: true,
    consumerOnlyPeer: true
  }),
  pairing: Object.freeze({
    commitRevealSasV2: true,
    channelBindingSdpSha256: true,
    terminalFrame: true
  })
})
