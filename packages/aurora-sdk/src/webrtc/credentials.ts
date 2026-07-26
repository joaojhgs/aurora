import { computeReconnectProofHex, type ReconnectProofInput } from './crypto.js'
import { utf8ToBytes, zeroBytes } from './encoding.js'

export interface MeshPeerCredentialRecord {
  tokenId: string
  claimantPeerId: string
  verifierPeerId: string
  claimantSignalingPeerId: string
  verifierSignalingPeerId: string
  roomName: string
  rawBearerToken: string
  createdAtMs?: number
  expiresAtMs?: number
}

export interface StoredPeerCredentialMetadata {
  tokenId: string
  claimantPeerId: string
  verifierPeerId: string
  claimantSignalingPeerId: string
  verifierSignalingPeerId: string
  roomName: string
  createdAtMs?: number
  expiresAtMs?: number
}

export interface MeshReconnectChallengeMessage {
  type: 'mesh_auth_challenge_v1'
  challenge: string
  channel_binding: string
  claimant_peer_id: string
  verifier_peer_id: string
  claimant_signaling_peer_id: string
  verifier_signaling_peer_id: string
  room_name: string
}

export interface MeshReconnectProofMessage extends Omit<MeshReconnectChallengeMessage, 'type'> {
  type: 'mesh_auth_proof_v1'
  token_id: string
  proof: string
}

export interface PeerCredentialStatus {
  peerId: string
  found: boolean
  hasBearerToken: boolean
  credential?: StoredPeerCredentialMetadata | undefined
  backend: string
  persisted: boolean
  secretsRedacted: boolean
  redactedFields: string[]
}

export interface PeerCredentialStore {
  get(peerId: string): Promise<StoredPeerCredentialMetadata | undefined>
  save(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata>
  prove(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined>
  createReconnectProof?(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined>
  status?(peerId: string): Promise<PeerCredentialStatus>
  remove(peerId: string): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
}

export type NativePeerCredentialCommandInvoker = (command: string, payload?: Record<string, unknown>) => Promise<unknown>

export interface NativePeerCredentialStoreOptions {
  invoke: NativePeerCredentialCommandInvoker
  commands?: Partial<NativePeerCredentialCommandNames> | undefined
  backend?: string | undefined
  now?: (() => number) | undefined
}

export interface MemoryPeerCredentialStoreOptions {
  now?: (() => number) | undefined
}

export interface NativePeerCredentialCommandNames {
  set: string
  status: string
  prove: string
  delete: string
}

interface NativeCredentialStatusResponse {
  peerId?: string
  found?: boolean
  hasBearerToken?: boolean
  credential?: StoredPeerCredentialMetadata | null | undefined
  backend?: string
  persisted?: boolean
  secretsRedacted?: boolean
  redactedFields?: string[]
}

interface NativeReconnectProofResponse {
  peerId?: string
  found?: boolean
  matched?: boolean
  proof?: MeshReconnectProofMessage | null | undefined
  credential?: StoredPeerCredentialMetadata | null | undefined
  backend?: string
  secretsRedacted?: boolean
  redactedFields?: string[]
}

interface InternalCredential {
  meta: StoredPeerCredentialMetadata
  tokenBytes: Uint8Array
}

const HEX64_RE = /^[0-9a-f]{64}$/u
const MAX_ID_LENGTH = 256
const MAX_TOKEN_LENGTH = 4096

export const DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS: NativePeerCredentialCommandNames = {
  set: 'aurora_thin_peer_credential_set',
  status: 'aurora_thin_peer_credential_status',
  prove: 'aurora_thin_peer_reconnect_prove',
  delete: 'aurora_thin_peer_credential_delete'
}

function assertNonEmpty(name: string, value: string, maxLength = MAX_ID_LENGTH): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}`)
  }
}

function assertChallenge(challenge: MeshReconnectChallengeMessage): void {
  if (challenge.type !== 'mesh_auth_challenge_v1') throw new Error('Invalid reconnect challenge type')
  assertNonEmpty('challenge', challenge.challenge, 64)
  if (!HEX64_RE.test(challenge.challenge)) throw new Error('Invalid reconnect challenge')
  if (!HEX64_RE.test(challenge.channel_binding)) throw new Error('Invalid reconnect channel binding')
  assertNonEmpty('claimant_peer_id', challenge.claimant_peer_id)
  assertNonEmpty('verifier_peer_id', challenge.verifier_peer_id)
  assertNonEmpty('claimant_signaling_peer_id', challenge.claimant_signaling_peer_id)
  assertNonEmpty('verifier_signaling_peer_id', challenge.verifier_signaling_peer_id)
  assertNonEmpty('room_name', challenge.room_name, 512)
}

function metadata(record: MeshPeerCredentialRecord, now = Date.now()): StoredPeerCredentialMetadata {
  assertNonEmpty('tokenId', record.tokenId, 128)
  assertNonEmpty('claimantPeerId', record.claimantPeerId)
  assertNonEmpty('verifierPeerId', record.verifierPeerId)
  assertNonEmpty('claimantSignalingPeerId', record.claimantSignalingPeerId)
  assertNonEmpty('verifierSignalingPeerId', record.verifierSignalingPeerId)
  assertNonEmpty('roomName', record.roomName, 512)
  assertNonEmpty('rawBearerToken', record.rawBearerToken, MAX_TOKEN_LENGTH)
  assertNotExpired(record.expiresAtMs, now)
  const out: StoredPeerCredentialMetadata = {
    tokenId: record.tokenId,
    claimantPeerId: record.claimantPeerId,
    verifierPeerId: record.verifierPeerId,
    claimantSignalingPeerId: record.claimantSignalingPeerId,
    verifierSignalingPeerId: record.verifierSignalingPeerId,
    roomName: record.roomName
  }
  if (record.createdAtMs !== undefined) out.createdAtMs = record.createdAtMs
  if (record.expiresAtMs !== undefined) out.expiresAtMs = record.expiresAtMs
  return out
}

function cloneMeta(meta: StoredPeerCredentialMetadata): StoredPeerCredentialMetadata {
  const out: StoredPeerCredentialMetadata = {
    tokenId: meta.tokenId,
    claimantPeerId: meta.claimantPeerId,
    verifierPeerId: meta.verifierPeerId,
    claimantSignalingPeerId: meta.claimantSignalingPeerId,
    verifierSignalingPeerId: meta.verifierSignalingPeerId,
    roomName: meta.roomName
  }
  if (meta.createdAtMs !== undefined) out.createdAtMs = meta.createdAtMs
  if (meta.expiresAtMs !== undefined) out.expiresAtMs = meta.expiresAtMs
  return out
}

function tokenString(tokenBytes: Uint8Array): string {
  return new TextDecoder().decode(tokenBytes)
}

function challengeMatches(meta: StoredPeerCredentialMetadata, challenge: MeshReconnectChallengeMessage): boolean {
  // Signaling peer IDs are intentionally omitted here: they are ephemeral per
  // transport session and are already bound by the verifier's active challenge
  // plus the channel binding. Persisted credentials are keyed to stable mesh
  // identities and room membership so reconnects can survive a fresh signaling
  // session without falling back to SAS pairing.
  return challenge.claimant_peer_id === meta.claimantPeerId &&
    challenge.verifier_peer_id === meta.verifierPeerId &&
    challenge.room_name === meta.roomName
}

export class MemoryPeerCredentialStore implements PeerCredentialStore {
  private readonly records = new Map<string, InternalCredential>()
  private readonly now: () => number
  private closed = false

  constructor(options: MemoryPeerCredentialStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async get(peerId: string): Promise<StoredPeerCredentialMetadata | undefined> {
    this.assertOpen()
    const record = this.records.get(peerId)
    if (record === undefined) return undefined
    if (isExpired(record.meta.expiresAtMs, this.now())) {
      await this.remove(peerId)
      return undefined
    }
    return cloneMeta(record.meta)
  }

  async status(peerId: string): Promise<PeerCredentialStatus> {
    this.assertOpen()
    const credential = await this.get(peerId)
    return {
      peerId,
      found: credential !== undefined,
      hasBearerToken: credential !== undefined,
      credential,
      backend: 'memory',
      persisted: false,
      secretsRedacted: true,
      redactedFields: ['rawBearerToken']
    }
  }

  async save(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata> {
    this.assertOpen()
    assertNonEmpty('peerId', peerId)
    const meta = metadata(credential, this.now())
    const previous = this.records.get(peerId)
    if (previous !== undefined) zeroBytes(previous.tokenBytes)
    const tokenBytes = utf8ToBytes(credential.rawBearerToken)
    this.records.set(peerId, { meta, tokenBytes })
    return cloneMeta(meta)
  }

  async prove(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    return await this.createReconnectProof(peerId, challenge)
  }

  async createReconnectProof(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    this.assertOpen()
    assertChallenge(challenge)
    const record = this.records.get(peerId)
    if (record === undefined) return undefined
    const meta = record.meta
    if (isExpired(meta.expiresAtMs, this.now())) {
      await this.remove(peerId)
      return undefined
    }
    if (!challengeMatches(meta, challenge)) return undefined
    const input: ReconnectProofInput = {
      tokenId: meta.tokenId,
      challenge: challenge.challenge,
      channelBinding: challenge.channel_binding,
      claimantPeerId: meta.claimantPeerId,
      verifierPeerId: meta.verifierPeerId,
      roomName: meta.roomName
    }
    return {
      type: 'mesh_auth_proof_v1',
      token_id: meta.tokenId,
      challenge: challenge.challenge,
      proof: await computeReconnectProofHex(tokenString(record.tokenBytes), input),
      channel_binding: challenge.channel_binding,
      claimant_peer_id: meta.claimantPeerId,
      verifier_peer_id: meta.verifierPeerId,
      claimant_signaling_peer_id: challenge.claimant_signaling_peer_id,
      verifier_signaling_peer_id: challenge.verifier_signaling_peer_id,
      room_name: meta.roomName
    }
  }

  async remove(peerId: string): Promise<void> {
    this.assertOpen()
    const record = this.records.get(peerId)
    if (record !== undefined) zeroBytes(record.tokenBytes)
    this.records.delete(peerId)
  }

  async clear(): Promise<void> {
    for (const record of this.records.values()) zeroBytes(record.tokenBytes)
    this.records.clear()
  }

  async close(): Promise<void> {
    await this.clear()
    this.closed = true
  }

  testingTokenBytes(peerId: string): Uint8Array | undefined {
    return this.records.get(peerId)?.tokenBytes
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Peer credential store is closed')
  }
}

export class NativePeerCredentialStore implements PeerCredentialStore {
  private readonly invoke: NativePeerCredentialCommandInvoker
  private readonly commands: NativePeerCredentialCommandNames
  private readonly backend: string
  private readonly now: () => number
  private closed = false

  constructor(options: NativePeerCredentialStoreOptions) {
    this.invoke = options.invoke
    this.commands = { ...DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS, ...options.commands }
    this.backend = options.backend ?? 'platform-keychain'
    this.now = options.now ?? Date.now
  }

  async get(peerId: string): Promise<StoredPeerCredentialMetadata | undefined> {
    const status = await this.status(peerId)
    return status.credential === undefined ? undefined : cloneMeta(status.credential)
  }

  async status(peerId: string): Promise<PeerCredentialStatus> {
    this.assertOpen()
    assertNonEmpty('peerId', peerId)
    const response = await this.invoke(this.commands.status, { peerId }) as NativeCredentialStatusResponse
    const status = normalizeNativeStatus(peerId, response, this.backend)
    if (status.credential !== undefined && isExpired(status.credential.expiresAtMs, this.now())) {
      await this.remove(peerId)
      return absentStatus(peerId, this.backend)
    }
    return status
  }

  async save(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata> {
    this.assertOpen()
    assertNonEmpty('peerId', peerId)
    const meta = metadata(credential, this.now())
    const response = await this.invoke(this.commands.set, {
      peerId,
      tokenId: credential.tokenId,
      claimantPeerId: credential.claimantPeerId,
      verifierPeerId: credential.verifierPeerId,
      claimantSignalingPeerId: credential.claimantSignalingPeerId,
      verifierSignalingPeerId: credential.verifierSignalingPeerId,
      roomName: credential.roomName,
      rawBearerToken: credential.rawBearerToken,
      createdAtMs: credential.createdAtMs,
      expiresAtMs: credential.expiresAtMs
    }) as NativeCredentialStatusResponse
    const status = normalizeNativeStatus(peerId, response, this.backend)
    if (status.credential !== undefined) return cloneMeta(status.credential)
    return meta
  }

  async prove(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    return await this.createReconnectProof(peerId, challenge)
  }

  async createReconnectProof(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    this.assertOpen()
    assertNonEmpty('peerId', peerId)
    assertChallenge(challenge)
    const status = await this.status(peerId)
    if (!status.found) return undefined
    const response = await this.invoke(this.commands.prove, { peerId, challenge }) as NativeReconnectProofResponse
    if (response.credential != null && isExpired(response.credential.expiresAtMs, this.now())) {
      await this.remove(peerId)
      return undefined
    }
    if (response.found === false || response.matched === false || response.proof == null) return undefined
    return cloneProof(response.proof)
  }

  async remove(peerId: string): Promise<void> {
    this.assertOpen()
    assertNonEmpty('peerId', peerId)
    await this.invoke(this.commands.delete, { peerId })
  }

  async clear(): Promise<void> {
    this.assertOpen()
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Peer credential store is closed')
  }
}

export class DeterministicPeerCredentialStore extends MemoryPeerCredentialStore {
  async seed(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata> {
    return this.save(peerId, credential)
  }
}


function isExpired(expiresAtMs: number | undefined, now: number): boolean {
  return expiresAtMs !== undefined && expiresAtMs <= now
}

function assertNotExpired(expiresAtMs: number | undefined, now: number): void {
  if (isExpired(expiresAtMs, now)) throw new Error('Peer credential is expired')
}

function absentStatus(peerId: string, backend: string): PeerCredentialStatus {
  return {
    peerId,
    found: false,
    hasBearerToken: false,
    backend,
    persisted: true,
    secretsRedacted: true,
    redactedFields: ['rawBearerToken']
  }
}

function normalizeNativeStatus(peerId: string, response: NativeCredentialStatusResponse | undefined, fallbackBackend: string): PeerCredentialStatus {
  const credential = response?.credential == null ? undefined : cloneMeta(response.credential)
  return {
    peerId: response?.peerId ?? peerId,
    found: response?.found ?? credential !== undefined,
    hasBearerToken: response?.hasBearerToken ?? credential !== undefined,
    credential,
    backend: response?.backend ?? fallbackBackend,
    persisted: response?.persisted ?? true,
    secretsRedacted: response?.secretsRedacted ?? true,
    redactedFields: [...(response?.redactedFields ?? ['rawBearerToken'])]
  }
}

function cloneProof(proof: MeshReconnectProofMessage): MeshReconnectProofMessage {
  return {
    type: 'mesh_auth_proof_v1',
    token_id: proof.token_id,
    challenge: proof.challenge,
    proof: proof.proof,
    channel_binding: proof.channel_binding,
    claimant_peer_id: proof.claimant_peer_id,
    verifier_peer_id: proof.verifier_peer_id,
    claimant_signaling_peer_id: proof.claimant_signaling_peer_id,
    verifier_signaling_peer_id: proof.verifier_signaling_peer_id,
    room_name: proof.room_name
  }
}
