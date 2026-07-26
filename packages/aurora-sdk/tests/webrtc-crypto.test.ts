import { scryptAsync } from '@noble/hashes/scrypt.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AuroraScryptDeriver } from '../src/webrtc/crypto-worker-client.js'
import { deriveScryptInWorker } from '../src/webrtc/crypto-worker-client.js'
import {
  base64UrlDecode,
  base64UrlEncode,
  buildMeshReconnectProofMessage,
  bytesToHex,
  computeReconnectProofHex,
  constantTimeEqual,
  decodeJsonPayload,
  deriveRoomKeys,
  deriveRoomSalt,
  encodeJsonPayload,
  hexToBytes,
  openJson,
  sealJson
} from '../src/webrtc/crypto.js'

type Fixture = {
  room_crypto: {
    inputs: { password: string; app_id: string; room: string }
    salt_sha256_hex: string
    k0_hex: string
    k_sig_hex: string
    k_data_hex: string
    aead: {
      nonce_hex: string
      plaintext: Record<string, unknown>
      plaintext_compact_json: string
      payload_hex: string
      payload_base64url: string
    }
  }
  reconnect: {
    inputs: {
      token_id: string
      challenge: string
      channel_binding: string
      claimant_peer_id: string
      verifier_peer_id: string
      room_name: string
      raw_token_sha256_hex: string
    }
    message_hex: string
    hmac_sha256_hex: string
  }
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
}

const nobleScryptDeriver: AuroraScryptDeriver = async (password, salt, params) =>
  scryptAsync(password, salt, { N: params.N, r: params.r, p: params.p, dkLen: params.dkLen })

describe('Aurora WebRTC crypto', () => {
  it('matches the Python room key and AES-GCM fixture vectors', async () => {
    const vector = fixture().room_crypto
    const salt = await deriveRoomSalt(vector.inputs.app_id, vector.inputs.room)
    expect(bytesToHex(salt)).toBe(vector.salt_sha256_hex)

    const keys = await deriveRoomKeys(vector.inputs.password, vector.inputs.app_id, vector.inputs.room, {
      scryptDeriver: nobleScryptDeriver
    })
    expect(bytesToHex(keys.k0)).toBe(vector.k0_hex)
    expect(bytesToHex(keys.kSig)).toBe(vector.k_sig_hex)
    expect(bytesToHex(keys.kData)).toBe(vector.k_data_hex)

    const orderedPlaintext = { type: 'presence', app_id: 'aurora-fixture', room: 'lab-room', peer_id: 'peer-offer', node_name: 'Fixture Offerer' }
    expect(JSON.stringify(orderedPlaintext)).toBe(vector.aead.plaintext_compact_json)
    const payload = await sealJson(keys.kSig, orderedPlaintext, { nonce: hexToBytes(vector.aead.nonce_hex) })
    expect(bytesToHex(payload)).toBe(vector.aead.payload_hex)
    expect(base64UrlEncode(payload)).toBe(vector.aead.payload_base64url)
    expect(base64UrlDecode(vector.aead.payload_base64url)).toEqual(payload)
    await expect(openJson(keys.kSig, payload)).resolves.toEqual(vector.aead.plaintext)
  }, 20_000)

  it('matches the Python reconnect proof transcript and HMAC vector', async () => {
    const reconnect = fixture().reconnect
    const input = {
      tokenId: reconnect.inputs.token_id,
      challenge: reconnect.inputs.challenge,
      channelBinding: reconnect.inputs.channel_binding,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      roomName: reconnect.inputs.room_name
    }
    expect(bytesToHex(buildMeshReconnectProofMessage(input))).toBe(reconnect.message_hex)
    expect(await computeReconnectProofHex('synthetic-reconnect-token', input)).toBe(reconnect.hmac_sha256_hex)
  })

  it('matches Python ensure_ascii reconnect canonicalization for Unicode identities', async () => {
    const input = {
      tokenId: 'token-é',
      challenge: 'a'.repeat(64),
      channelBinding: 'b'.repeat(64),
      claimantPeerId: 'peer-😀',
      verifierPeerId: 'peer-β',
      roomName: 'café/</room'
    }
    expect(new TextDecoder().decode(buildMeshReconnectProofMessage(input))).toBe(
      'aurora.mesh.reconnect-proof.v1\u0000{"challenge":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","channel_binding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","claimant_peer_id":"peer-\\ud83d\\ude00","room_name":"caf\\u00e9/</room","token_id":"token-\\u00e9","verifier_peer_id":"peer-\\u03b2","version":1}'
    )
    await expect(computeReconnectProofHex('tökén😀', input)).resolves.toBe(
      '23192dbc7bc20cbecad7683032bc064b9cb6c4bca37a6ef2572a2f737c014f22'
    )
  })

  it('supports E2EE on/off JSON payload codec behavior', async () => {
    const vector = fixture().room_crypto
    const keys = await deriveRoomKeys(vector.inputs.password, vector.inputs.app_id, vector.inputs.room, {
      scryptDeriver: nobleScryptDeriver
    })
    const orderedPlaintext = { type: 'presence', app_id: 'aurora-fixture', room: 'lab-room', peer_id: 'peer-offer', node_name: 'Fixture Offerer' }
    const clear = await encodeJsonPayload(orderedPlaintext)
    expect(clear.encrypted).toBe(false)
    await expect(decodeJsonPayload(clear.payload)).resolves.toEqual(vector.aead.plaintext)

    const encrypted = await encodeJsonPayload(orderedPlaintext, {
      key: keys.kSig,
      nonce: hexToBytes(vector.aead.nonce_hex)
    })
    expect(encrypted.encrypted).toBe(true)
    expect(bytesToHex(encrypted.payload)).toBe(vector.aead.payload_hex)
    await expect(decodeJsonPayload(encrypted.payload, { key: keys.kSig })).resolves.toEqual(vector.aead.plaintext)
  }, 20_000)

  it('rejects padded base64url and compares bytes without early length success', () => {
    expect(() => base64UrlDecode('abc=')).toThrow(/base64url/u)
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
  })

  it('is SSR-import safe and refuses default scrypt without a Worker', async () => {
    await expect(import('../src/webrtc/encoding.js')).resolves.toBeTruthy()
    await expect(import('../src/webrtc/crypto.js')).resolves.toBeTruthy()
    await expect(deriveRoomKeys('password', 'app', 'room')).rejects.toThrow(/Worker|deriver/u)
  })

  it('cleans up a successful injected scrypt worker', async () => {
    const terminate = vi.fn()
    let messageListener: ((event: MessageEvent) => void) | undefined
    const worker = {
      postMessage: vi.fn((message: unknown) => {
        const id = (message as { id: number }).id
        queueMicrotask(() => messageListener?.({ data: { id, type: 'scrypt:result', key: new Uint8Array([7, 8, 9]) } } as MessageEvent))
      }),
      terminate,
      addEventListener: vi.fn((type: 'message' | 'error', listener: (event: Event) => void) => {
        if (type === 'message') {
          messageListener = listener as (event: MessageEvent) => void
        }
      }),
      removeEventListener: vi.fn()
    }
    const key = await deriveScryptInWorker(new Uint8Array([1]), new Uint8Array([2]), { workerFactory: () => worker })
    expect(key).toEqual(new Uint8Array([7, 8, 9]))
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('terminates the scrypt worker on abort', async () => {
    const controller = new AbortController()
    const terminate = vi.fn()
    const worker = {
      postMessage: vi.fn(),
      terminate,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const promise = deriveScryptInWorker(new Uint8Array([1]), new Uint8Array([2]), {
      signal: controller.signal,
      workerFactory: () => worker
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
