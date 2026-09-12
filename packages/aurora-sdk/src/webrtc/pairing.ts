import { base64UrlDecode, base64UrlEncode, bytesToHex, compactJson, hexToBytes, hmacSha256, randomBytes, sha256Bytes } from './crypto.js'
import { concatBytes, utf8ToBytes, zeroBytes } from './encoding.js'

export const PAIRING_PROTOCOL_VERSION = 2 as const
export const PAIRING_COMMIT_TYPE = 'pairing_v2_commit' as const
export const PAIRING_REVEAL_TYPE = 'pairing_v2_reveal' as const
export const PAIRING_TERMINAL_TYPE = 'pairing_v2_terminal' as const

const CHANNEL_CONTEXT = 'aurora.mesh.pairing.channel.v2'
const COMMIT_CONTEXT = utf8ToBytes('aurora.mesh.pairing.commit.v2\0')
const TRANSCRIPT_CONTEXT = 'aurora.mesh.pairing.transcript.v2'
const SESSION_CONTEXT = utf8ToBytes('aurora.mesh.pairing.session.v2\0')
const SAS_INFO = utf8ToBytes('aurora.mesh.pairing.sas.v2')
const SAS_RETRY_CONTEXT = utf8ToBytes('aurora.mesh.pairing.sas.retry\0')
const HEX64_RE = /^[0-9a-f]{64}$/u
const HANDSHAKE_ID_RE = /^[0-9a-f]{32}$/u
const MAX_ID_LENGTH = 256
const MAX_NODE_NAME_LENGTH = 256
const MAX_SDP_LENGTH = 2 * 1024 * 1024
const MAX_REASON_LENGTH = 512
const DEFAULT_TIMEOUT_MS = 120_000

export type PairingRole = 'offerer' | 'answerer'
export type PairingTerminalStatus = 'denied' | 'expired' | 'superseded' | 'failed'
export type PairingHandshakeState = 'initialized' | 'commit-sent' | 'commit-accepted' | 'reveal-sent' | 'sas-ready' | 'confirmed' | 'denied' | 'expired' | 'superseded' | 'failed'

export class PairingProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairingProtocolError'
  }
}

export interface PairingIdentity {
  role: PairingRole
  stable_peer_id: string
  node_name: string
  signaling_peer_id: string
  supported_pairing_versions: readonly number[]
}

export interface PairingCommitMessage {
  type: typeof PAIRING_COMMIT_TYPE
  version: typeof PAIRING_PROTOCOL_VERSION
  handshake_id: string
  channel_binding_sha256: string
  identity: PairingIdentity
  nonce_commitment: string
}

export interface PairingRevealMessage {
  type: typeof PAIRING_REVEAL_TYPE
  version: typeof PAIRING_PROTOCOL_VERSION
  handshake_id: string
  channel_binding_sha256: string
  nonce: string
}

export interface PairingTerminalMessage {
  type: typeof PAIRING_TERMINAL_TYPE
  pairing_session_id: string
  status: PairingTerminalStatus
  peer_id: string
  signaling_peer_id: string
  verification_code?: string
  reason?: string
}

export interface PairingSasResult {
  pairingSessionId: string
  verificationCode: string
  transcriptSha256: string
  channelBindingSha256: string
  remoteStablePeerId: string
  remoteNodeName: string
}

export interface PairingHandshakeOptions {
  channelBindingSha256: string
  localIdentity: PairingIdentity
  expectedRemoteIdentity: PairingIdentity
  localNonce?: Uint8Array
  nowMs?: () => number
  timeoutMs?: number
}

export interface DeriveChannelBindingInput {
  appId: string
  room: string
  offererSignalingId: string
  answererSignalingId: string
  offerSdp: string
  answerSdp: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function stringField(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PairingProtocolError(`Invalid pairing ${field}`)
  }
  return value
}

function optionalStringField(record: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new PairingProtocolError(`Invalid pairing ${field}`)
  }
  return value
}

function assertNoExtraKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new PairingProtocolError(`Unexpected ${label} field`)
    }
  }
}

function assertHex64(value: string, label: string): void {
  if (!HEX64_RE.test(value)) throw new PairingProtocolError(`Invalid ${label}`)
}

function assertHandshakeId(value: string): void {
  if (!HANDSHAKE_ID_RE.test(value)) throw new PairingProtocolError('Invalid pairing handshake id')
}

function orderedJson(value: unknown): string {
  return compactJson(value, { sortKeys: true })
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256Bytes(value))
}

export function parsePairingIdentity(value: unknown): PairingIdentity {
  if (!isRecord(value)) throw new PairingProtocolError('Pairing identity must be an object')
  assertNoExtraKeys(value, ['role', 'stable_peer_id', 'node_name', 'signaling_peer_id', 'supported_pairing_versions'], 'identity')
  const role = value.role
  if (role !== 'offerer' && role !== 'answerer') throw new PairingProtocolError('Invalid pairing role')
  const stablePeerId = stringField(value, 'stable_peer_id', MAX_ID_LENGTH)
  const signalingPeerId = stringField(value, 'signaling_peer_id', MAX_ID_LENGTH)
  const nodeName = optionalStringField(value, 'node_name', MAX_NODE_NAME_LENGTH) ?? ''
  const versions = value.supported_pairing_versions
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 8) {
    throw new PairingProtocolError('Invalid pairing versions')
  }
  const parsedVersions = versions.map((item) => {
    if (!Number.isSafeInteger(item) || item <= 0 || item > 16) {
      throw new PairingProtocolError('Invalid pairing version')
    }
    return item
  })
  if (!parsedVersions.includes(PAIRING_PROTOCOL_VERSION)) {
    throw new PairingProtocolError('Pairing v2 is not supported by identity')
  }
  return {
    role,
    stable_peer_id: stablePeerId,
    node_name: nodeName,
    signaling_peer_id: signalingPeerId,
    supported_pairing_versions: Object.freeze([...parsedVersions])
  }
}

export function pairingIdentity(input: {
  role: PairingRole
  stablePeerId: string
  nodeName?: string
  signalingPeerId: string
}): PairingIdentity {
  return parsePairingIdentity({
    role: input.role,
    stable_peer_id: input.stablePeerId,
    node_name: input.nodeName ?? '',
    signaling_peer_id: input.signalingPeerId,
    supported_pairing_versions: [PAIRING_PROTOCOL_VERSION]
  })
}

export async function deriveChannelBinding(input: DeriveChannelBindingInput): Promise<string> {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new PairingProtocolError(`Incomplete WebRTC transcript: ${field}`)
    }
  }
  if (input.offerSdp.length > MAX_SDP_LENGTH || input.answerSdp.length > MAX_SDP_LENGTH) {
    throw new PairingProtocolError('WebRTC SDP transcript is too large')
  }
  return sha256Hex(orderedJson({
    context: CHANNEL_CONTEXT,
    app_id: input.appId,
    room: input.room,
    offerer_signaling_id: input.offererSignalingId,
    answerer_signaling_id: input.answererSignalingId,
    offer_sdp_sha256: await sha256Hex(input.offerSdp),
    answer_sdp_sha256: await sha256Hex(input.answerSdp)
  }))
}

export async function nonceCommitment(channelBindingSha256: string, identity: PairingIdentity, nonce: Uint8Array): Promise<string> {
  assertHex64(channelBindingSha256, 'channel binding')
  if (nonce.byteLength !== 32) throw new PairingProtocolError('Pairing nonce must contain 32 bytes')
  return sha256Hex(concatBytes(COMMIT_CONTEXT, hexToBytes(channelBindingSha256), utf8ToBytes(orderedJson(identity)), nonce))
}

async function hkdfSha256WithSalt(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm)
  const blocks: Uint8Array[] = []
  let previous = new Uint8Array(0)
  let produced = 0
  let counter = 1
  try {
    while (produced < length) {
      previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([counter])))
      blocks.push(previous)
      produced += previous.byteLength
      counter += 1
    }
    return concatBytes(...blocks).slice(0, length)
  } finally {
    zeroBytes(prk)
    zeroBytes(previous)
    for (const block of blocks) zeroBytes(block)
  }
}

async function uniformEightDigitCode(material: Uint8Array): Promise<string> {
  const modulus = 100_000_000
  const upperBound = Math.floor(2 ** 32 / modulus) * modulus
  let candidateMaterial = new Uint8Array(material)
  try {
    for (let retry = 0; retry < 128; retry += 1) {
      for (let offset = 0; offset < candidateMaterial.byteLength - 3; offset += 4) {
        const value = (candidateMaterial[offset]! * 2 ** 24) + (candidateMaterial[offset + 1]! << 16) + (candidateMaterial[offset + 2]! << 8) + candidateMaterial[offset + 3]!
        if (value < upperBound) return String(value % modulus).padStart(8, '0')
      }
      const retryBytes = new Uint8Array(4)
      new DataView(retryBytes.buffer).setUint32(0, retry + 1, false)
      candidateMaterial = await hmacSha256(material, concatBytes(SAS_RETRY_CONTEXT, retryBytes))
    }
  } finally {
    zeroBytes(candidateMaterial)
  }
  throw new PairingProtocolError('Unable to derive unbiased pairing SAS')
}

export async function derivePairingSas(input: {
  channelBindingSha256: string
  offererIdentity: PairingIdentity
  offererCommitment: string
  offererNonce: Uint8Array
  answererIdentity: PairingIdentity
  answererCommitment: string
  answererNonce: Uint8Array
  localRole: PairingRole
}): Promise<PairingSasResult> {
  assertHex64(input.channelBindingSha256, 'channel binding')
  assertHex64(input.offererCommitment, 'offerer commitment')
  assertHex64(input.answererCommitment, 'answerer commitment')
  if (input.offererNonce.byteLength !== 32 || input.answererNonce.byteLength !== 32) {
    throw new PairingProtocolError('Pairing nonce must contain 32 bytes')
  }
  if (input.offererIdentity.role !== 'offerer' || input.answererIdentity.role !== 'answerer') {
    throw new PairingProtocolError('Pairing identities do not match their roles')
  }
  const transcript = {
    context: TRANSCRIPT_CONTEXT,
    channel_binding_sha256: input.channelBindingSha256,
    offerer: {
      identity: input.offererIdentity,
      commitment: input.offererCommitment,
      nonce: base64UrlEncode(input.offererNonce)
    },
    answerer: {
      identity: input.answererIdentity,
      commitment: input.answererCommitment,
      nonce: base64UrlEncode(input.answererNonce)
    }
  }
  const transcriptDigest = await sha256Bytes(orderedJson(transcript))
  const salt = hexToBytes(input.channelBindingSha256)
  const sasMaterial = await hkdfSha256WithSalt(transcriptDigest, salt, SAS_INFO, 32)
  try {
    const remoteIdentity = input.localRole === 'offerer' ? input.answererIdentity : input.offererIdentity
    return {
      pairingSessionId: await sha256Hex(concatBytes(SESSION_CONTEXT, transcriptDigest)),
      verificationCode: await uniformEightDigitCode(sasMaterial),
      transcriptSha256: bytesToHex(transcriptDigest),
      channelBindingSha256: input.channelBindingSha256,
      remoteStablePeerId: remoteIdentity.stable_peer_id,
      remoteNodeName: remoteIdentity.node_name
    }
  } finally {
    zeroBytes(transcriptDigest)
    zeroBytes(salt)
    zeroBytes(sasMaterial)
  }
}

export function parsePairingCommitMessage(value: unknown): PairingCommitMessage {
  if (!isRecord(value)) throw new PairingProtocolError('Pairing commit must be an object')
  assertNoExtraKeys(value, ['type', 'version', 'handshake_id', 'channel_binding_sha256', 'identity', 'nonce_commitment'], 'commit')
  if (value.type !== PAIRING_COMMIT_TYPE || value.version !== PAIRING_PROTOCOL_VERSION) {
    throw new PairingProtocolError('Unexpected pairing commit message')
  }
  const handshakeId = stringField(value, 'handshake_id', 32)
  const channelBindingSha256 = stringField(value, 'channel_binding_sha256', 64)
  const nonce = stringField(value, 'nonce_commitment', 64)
  assertHandshakeId(handshakeId)
  assertHex64(channelBindingSha256, 'channel binding')
  assertHex64(nonce, 'remote pairing commitment')
  return {
    type: PAIRING_COMMIT_TYPE,
    version: PAIRING_PROTOCOL_VERSION,
    handshake_id: handshakeId,
    channel_binding_sha256: channelBindingSha256,
    identity: parsePairingIdentity(value.identity),
    nonce_commitment: nonce
  }
}

export function parsePairingRevealMessage(value: unknown): PairingRevealMessage {
  if (!isRecord(value)) throw new PairingProtocolError('Pairing reveal must be an object')
  assertNoExtraKeys(value, ['type', 'version', 'handshake_id', 'channel_binding_sha256', 'nonce'], 'reveal')
  if (value.type !== PAIRING_REVEAL_TYPE || value.version !== PAIRING_PROTOCOL_VERSION) {
    throw new PairingProtocolError('Unexpected pairing reveal message')
  }
  const handshakeId = stringField(value, 'handshake_id', 32)
  const channelBindingSha256 = stringField(value, 'channel_binding_sha256', 64)
  const nonce = stringField(value, 'nonce', 64)
  assertHandshakeId(handshakeId)
  assertHex64(channelBindingSha256, 'channel binding')
  if (base64UrlDecode(nonce).byteLength !== 32) throw new PairingProtocolError('Remote pairing nonce must contain 32 bytes')
  return { type: PAIRING_REVEAL_TYPE, version: PAIRING_PROTOCOL_VERSION, handshake_id: handshakeId, channel_binding_sha256: channelBindingSha256, nonce }
}

export function parsePairingTerminalMessage(value: unknown): PairingTerminalMessage {
  if (!isRecord(value)) throw new PairingProtocolError('Pairing terminal must be an object')
  assertNoExtraKeys(value, ['type', 'pairing_session_id', 'status', 'peer_id', 'signaling_peer_id', 'verification_code', 'reason'], 'terminal')
  if (value.type !== PAIRING_TERMINAL_TYPE) throw new PairingProtocolError('Unexpected pairing terminal message')
  const status = value.status
  if (status !== 'denied' && status !== 'expired' && status !== 'superseded' && status !== 'failed') {
    throw new PairingProtocolError('Invalid pairing terminal status')
  }
  const message: PairingTerminalMessage = {
    type: PAIRING_TERMINAL_TYPE,
    pairing_session_id: stringField(value, 'pairing_session_id', 64),
    status,
    peer_id: stringField(value, 'peer_id', MAX_ID_LENGTH),
    signaling_peer_id: stringField(value, 'signaling_peer_id', MAX_ID_LENGTH)
  }
  assertHex64(message.pairing_session_id, 'pairing session id')
  const verificationCode = optionalStringField(value, 'verification_code', 8)
  if (verificationCode !== undefined) {
    if (!/^\d{8}$/u.test(verificationCode)) throw new PairingProtocolError('Invalid pairing verification code')
    message.verification_code = verificationCode
  }
  const reason = optionalStringField(value, 'reason', MAX_REASON_LENGTH)
  if (reason !== undefined) message.reason = reason
  return message
}

export class PairingSasHandshake {
  readonly channelBindingSha256: string
  readonly localIdentity: PairingIdentity
  readonly expectedRemoteIdentity: PairingIdentity
  readonly localNonce: Uint8Array
  readonly createdAtMs: number
  readonly timeoutMs: number
  readonly nowMs: () => number
  private remoteCommitment?: string
  private remoteNonce?: Uint8Array
  private revealSent = false
  private result?: PairingSasResult
  private stateValue: PairingHandshakeState = 'initialized'

  constructor(options: PairingHandshakeOptions) {
    assertHex64(options.channelBindingSha256, 'channel binding')
    this.channelBindingSha256 = options.channelBindingSha256
    this.localIdentity = parsePairingIdentity(options.localIdentity)
    this.expectedRemoteIdentity = parsePairingIdentity(options.expectedRemoteIdentity)
    this.localNonce = new Uint8Array(options.localNonce ?? randomBytes(32))
    if (this.localNonce.byteLength !== 32) throw new PairingProtocolError('Pairing nonce must contain 32 bytes')
    if (this.localIdentity.stable_peer_id === this.expectedRemoteIdentity.stable_peer_id) {
      throw new PairingProtocolError('Local and remote mesh identities are identical; copied instance configuration')
    }
    if (this.localIdentity.role === this.expectedRemoteIdentity.role) {
      throw new PairingProtocolError('Pairing endpoints claim the same signaling role')
    }
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.createdAtMs = this.nowMs()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get state(): PairingHandshakeState {
    return this.stateValue
  }

  get localRole(): PairingRole {
    return this.localIdentity.role
  }

  get remoteRole(): PairingRole {
    return this.expectedRemoteIdentity.role
  }

  get handshakeId(): string {
    return this.channelBindingSha256.slice(0, 32)
  }

  async localCommitment(): Promise<string> {
    this.assertFresh()
    return nonceCommitment(this.channelBindingSha256, this.localIdentity, this.localNonce)
  }

  async commitMessage(): Promise<PairingCommitMessage> {
    this.assertFresh()
    this.stateValue = 'commit-sent'
    return {
      type: PAIRING_COMMIT_TYPE,
      version: PAIRING_PROTOCOL_VERSION,
      handshake_id: this.handshakeId,
      channel_binding_sha256: this.channelBindingSha256,
      identity: this.localIdentity,
      nonce_commitment: await this.localCommitment()
    }
  }

  acceptCommit(value: unknown): void {
    this.assertFresh()
    const message = parsePairingCommitMessage(value)
    this.validateCommon(message)
    if (JSON.stringify(message.identity) !== JSON.stringify(this.expectedRemoteIdentity)) {
      throw new PairingProtocolError('Remote pairing identity does not match signaling metadata')
    }
    if (this.remoteCommitment !== undefined && this.remoteCommitment !== message.nonce_commitment) {
      this.stateValue = 'failed'
      throw new PairingProtocolError('Conflicting duplicate pairing commitment')
    }
    this.remoteCommitment = message.nonce_commitment
    this.stateValue = 'commit-accepted'
  }

  revealMessage(): PairingRevealMessage {
    this.assertFresh()
    if (this.remoteCommitment === undefined) {
      throw new PairingProtocolError('Cannot reveal before both commitments are known')
    }
    this.revealSent = true
    this.stateValue = 'reveal-sent'
    return {
      type: PAIRING_REVEAL_TYPE,
      version: PAIRING_PROTOCOL_VERSION,
      handshake_id: this.handshakeId,
      channel_binding_sha256: this.channelBindingSha256,
      nonce: base64UrlEncode(this.localNonce)
    }
  }

  async acceptReveal(value: unknown): Promise<PairingSasResult> {
    this.assertFresh()
    const message = parsePairingRevealMessage(value)
    this.validateCommon(message)
    if (this.remoteCommitment === undefined) {
      throw new PairingProtocolError('Remote revealed before committing')
    }
    const nonce = base64UrlDecode(message.nonce)
    const expected = await nonceCommitment(this.channelBindingSha256, this.expectedRemoteIdentity, nonce)
    if (expected !== this.remoteCommitment) {
      this.stateValue = 'failed'
      throw new PairingProtocolError('Remote pairing reveal does not match its commitment')
    }
    if (this.remoteNonce !== undefined && bytesToHex(this.remoteNonce) !== bytesToHex(nonce)) {
      this.stateValue = 'failed'
      throw new PairingProtocolError('Conflicting duplicate pairing reveal')
    }
    this.remoteNonce = nonce
    if (this.result === undefined) {
      const localCommitment = await this.localCommitment()
      const args = this.localRole === 'offerer'
        ? {
            offererIdentity: this.localIdentity,
            offererCommitment: localCommitment,
            offererNonce: this.localNonce,
            answererIdentity: this.expectedRemoteIdentity,
            answererCommitment: this.remoteCommitment,
            answererNonce: nonce
          }
        : {
            offererIdentity: this.expectedRemoteIdentity,
            offererCommitment: this.remoteCommitment,
            offererNonce: nonce,
            answererIdentity: this.localIdentity,
            answererCommitment: localCommitment,
            answererNonce: this.localNonce
          }
      this.result = await derivePairingSas({
        channelBindingSha256: this.channelBindingSha256,
        ...args,
        localRole: this.localRole
      })
    }
    this.stateValue = 'sas-ready'
    return this.result
  }

  confirm(): void {
    if (this.result === undefined) throw new PairingProtocolError('Cannot confirm pairing before SAS is ready')
    this.stateValue = 'confirmed'
  }

  reject(reason?: string): PairingTerminalMessage {
    return this.terminal('denied', reason)
  }

  expire(reason?: string): PairingTerminalMessage {
    return this.terminal('expired', reason)
  }

  supersede(reason?: string): PairingTerminalMessage {
    return this.terminal('superseded', reason)
  }

  fail(reason?: string): PairingTerminalMessage {
    return this.terminal('failed', reason)
  }

  private terminal(status: PairingTerminalStatus, reason?: string): PairingTerminalMessage {
    if (this.result === undefined) throw new PairingProtocolError('Cannot emit pairing terminal before SAS is ready')
    this.stateValue = status
    const message: PairingTerminalMessage = {
      type: PAIRING_TERMINAL_TYPE,
      pairing_session_id: this.result.pairingSessionId,
      status,
      peer_id: this.localIdentity.stable_peer_id,
      signaling_peer_id: this.localIdentity.signaling_peer_id,
      verification_code: this.result.verificationCode
    }
    if (reason !== undefined) message.reason = reason.slice(0, MAX_REASON_LENGTH)
    return message
  }

  close(): void {
    zeroBytes(this.localNonce)
    if (this.remoteNonce !== undefined) zeroBytes(this.remoteNonce)
  }

  private validateCommon(message: PairingCommitMessage | PairingRevealMessage): void {
    if (message.handshake_id !== this.handshakeId) throw new PairingProtocolError('Pairing message belongs to a stale connection')
    if (message.channel_binding_sha256 !== this.channelBindingSha256) throw new PairingProtocolError('Pairing channel binding mismatch')
  }

  private assertFresh(): void {
    if (this.stateValue === 'expired') throw new PairingProtocolError('Pairing handshake expired')
    if (this.nowMs() - this.createdAtMs > this.timeoutMs) {
      this.stateValue = 'expired'
      throw new PairingProtocolError('Pairing handshake expired')
    }
    if (this.stateValue === 'confirmed' || this.stateValue === 'denied' || this.stateValue === 'superseded' || this.stateValue === 'failed') {
      throw new PairingProtocolError('Pairing handshake is terminal')
    }
  }
}
