import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  bytesToUtf8,
  canonicalJson,
  compactJson,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
  zeroBytes
} from './encoding.js'
import {
  AURORA_SCRYPT_PARAMS,
  deriveScryptInWorker,
  type AuroraScryptDeriver,
  type ScryptWorkerFactory
} from './crypto-worker-client.js'

export { base64UrlDecode, base64UrlEncode, bytesToHex, canonicalJson, compactJson, hexToBytes }
export type { AuroraScryptDeriver, ScryptWorkerFactory }
export const bytesToBase64Url = base64UrlEncode
export const base64UrlToBytes = base64UrlDecode

export interface RoomKeys {
  k0: Uint8Array
  kSig: Uint8Array
  kData: Uint8Array
}

export interface DeriveRoomKeysOptions {
  scryptDeriver?: AuroraScryptDeriver
  scryptWorkerFactory?: ScryptWorkerFactory
  signal?: AbortSignal
  dataInfo?: string
}

export type RoomCryptoOptions = DeriveRoomKeysOptions

export interface ReconnectProofInput {
  tokenId: string
  challenge: string
  channelBinding: string
  claimantPeerId: string
  verifierPeerId: string
  roomName: string
}

const RECONNECT_DOMAIN = utf8ToBytes('aurora.mesh.reconnect-proof.v1\0')
const AES_GCM_NONCE_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_KEY_BYTES = 32

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    throw new Error('WebCrypto SubtleCrypto is unavailable')
  }
  return subtle
}

function assertByteLength(name: string, value: Uint8Array, expected: number): void {
  if (value.byteLength !== expected) {
    throw new Error(`${name} must be ${expected} bytes`)
  }
}

function assertPayloadBound(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error('Aurora WebRTC payload exceeds maximum size')
  }
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 65_536) {
    throw new Error('Invalid random byte length')
  }
  const crypto = globalThis.crypto
  if (crypto === undefined) {
    throw new Error('WebCrypto random source is unavailable')
  }
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

export async function sha256Bytes(input: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input
  return new Uint8Array(await getSubtle().digest('SHA-256', bytes))
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

async function importHmacKey(key: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof message === 'string' ? utf8ToBytes(message) : message
  const cryptoKey = await importHmacKey(key)
  return new Uint8Array(await getSubtle().sign('HMAC', cryptoKey, bytes))
}

export async function hkdfSha256(key: Uint8Array, info: string | Uint8Array, length = 32): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > 8_160) {
    throw new Error('Invalid HKDF length')
  }
  const infoBytes = typeof info === 'string' ? utf8ToBytes(info) : info
  const cryptoKey = await getSubtle().importKey('raw', key, 'HKDF', false, ['deriveBits'])
  const bits = await getSubtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: infoBytes },
    cryptoKey,
    length * 8
  )
  return new Uint8Array(bits)
}

export async function deriveRoomSalt(appId: string, room: string): Promise<Uint8Array> {
  return sha256Bytes(`${appId}|${room}`)
}

export async function deriveRoomKeys(
  password: string,
  appId: string,
  room: string,
  options: DeriveRoomKeysOptions = {}
): Promise<RoomKeys> {
  const passwordBytes = utf8ToBytes(password)
  const salt = await deriveRoomSalt(appId, room)
  try {
    const deriver = options.scryptDeriver ?? ((pass, roomSalt, params, signal) => {
      const workerOptions: { signal?: AbortSignal; workerFactory?: ScryptWorkerFactory } = {}
      if (signal !== undefined) {
        workerOptions.signal = signal
      }
      if (options.scryptWorkerFactory !== undefined) {
        workerOptions.workerFactory = options.scryptWorkerFactory
      }
      return deriveScryptInWorker(pass, roomSalt, workerOptions)
    })
    const k0 = await deriver(passwordBytes, salt, AURORA_SCRYPT_PARAMS, options.signal)
    assertByteLength('k0', k0, MAX_KEY_BYTES)
    const [kSig, kData] = await Promise.all([
      hkdfSha256(k0, 'aurora/webrtc/signaling', 32),
      hkdfSha256(k0, options.dataInfo ?? 'aurora/webrtc/data', 32)
    ])
    return { k0: new Uint8Array(k0), kSig, kData }
  } finally {
    zeroBytes(passwordBytes)
    zeroBytes(salt)
  }
}

async function importAesGcmKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  assertByteLength('AES-GCM key', key, MAX_KEY_BYTES)
  return getSubtle().importKey('raw', key, 'AES-GCM', false, usages)
}

export async function aeadSeal(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(AES_GCM_NONCE_BYTES)): Promise<Uint8Array> {
  assertByteLength('AES-GCM nonce', nonce, AES_GCM_NONCE_BYTES)
  assertPayloadBound(plaintext)
  const cryptoKey = await importAesGcmKey(key, ['encrypt'])
  const ciphertext = new Uint8Array(await getSubtle().encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cryptoKey, plaintext))
  return concatBytes(nonce, ciphertext)
}

export async function aeadOpen(key: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  if (payload.byteLength < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error('AES-GCM payload is too short')
  }
  assertPayloadBound(payload)
  const nonce = payload.slice(0, AES_GCM_NONCE_BYTES)
  const ciphertext = payload.slice(AES_GCM_NONCE_BYTES)
  const cryptoKey = await importAesGcmKey(key, ['decrypt'])
  return new Uint8Array(await getSubtle().decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cryptoKey, ciphertext))
}

export async function sealJson(key: Uint8Array, value: unknown, options: { nonce?: Uint8Array } = {}): Promise<Uint8Array> {
  return aeadSeal(key, utf8ToBytes(compactJson(value)), options.nonce)
}

export async function openJson<T = unknown>(key: Uint8Array, payload: Uint8Array): Promise<T> {
  return JSON.parse(bytesToUtf8(await aeadOpen(key, payload))) as T
}

export async function encodeJsonPayload(
  value: unknown,
  options: { key?: Uint8Array; nonce?: Uint8Array } = {}
): Promise<{ encrypted: boolean; payload: Uint8Array }> {
  const plaintext = utf8ToBytes(compactJson(value))
  if (options.key === undefined) {
    return { encrypted: false, payload: plaintext }
  }
  return { encrypted: true, payload: await aeadSeal(options.key, plaintext, options.nonce) }
}

export async function decodeJsonPayload<T = unknown>(
  payload: Uint8Array,
  options: { key?: Uint8Array; encrypted?: boolean } = {}
): Promise<T> {
  const key = options.key
  if (options.encrypted === true) {
    if (key === undefined) {
      throw new Error('Encrypted Aurora WebRTC payload requires a key')
    }
    return JSON.parse(bytesToUtf8(await aeadOpen(key, payload))) as T
  }
  if (key !== undefined) {
    return JSON.parse(bytesToUtf8(await aeadOpen(key, payload))) as T
  }
  return JSON.parse(bytesToUtf8(payload)) as T
}

export function buildMeshReconnectProofMessage(input: ReconnectProofInput): Uint8Array {
  const transcript = {
    challenge: input.challenge,
    channel_binding: input.channelBinding,
    claimant_peer_id: input.claimantPeerId,
    room_name: input.roomName,
    token_id: input.tokenId,
    verifier_peer_id: input.verifierPeerId,
    version: 1
  }
  return concatBytes(RECONNECT_DOMAIN, utf8ToBytes(canonicalJson(transcript)))
}

export async function computeReconnectProofHex(rawBearerToken: string, input: ReconnectProofInput): Promise<string> {
  const key = await sha256Bytes(rawBearerToken)
  try {
    return bytesToHex(await hmacSha256(key, buildMeshReconnectProofMessage(input)))
  } finally {
    zeroBytes(key)
  }
}

export function encodeEncryptedBase64Url(payload: Uint8Array): string {
  return base64UrlEncode(payload)
}

export function decodeEncryptedBase64Url(payload: string): Uint8Array {
  return base64UrlDecode(payload)
}
