import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS,
  MemoryPeerCredentialStore,
  NativePeerCredentialStore,
  type NativePeerCredentialCommandInvoker
} from '../src/webrtc/credentials.js'

function reconnectFixture() {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8')).reconnect
}

describe('WebRTC peer credential stores', () => {
  it('computes reconnect proof without exposing bearer token metadata', async () => {
    const reconnect = reconnectFixture()
    const store = new MemoryPeerCredentialStore()
    const futureExpiry = Date.now() + 60_000
    const meta = await store.save('stable-answer', {
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      rawBearerToken: 'synthetic-reconnect-token',
      createdAtMs: 1,
      expiresAtMs: futureExpiry
    })
    expect(meta).toEqual({
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      createdAtMs: 1,
      expiresAtMs: futureExpiry
    })
    expect(JSON.stringify(await store.get('stable-answer'))).not.toContain('synthetic-reconnect-token')
    const proof = await store.prove('stable-answer', {
      type: 'mesh_auth_challenge_v1',
      challenge: reconnect.inputs.challenge,
      channel_binding: reconnect.inputs.channel_binding,
      claimant_peer_id: reconnect.inputs.claimant_peer_id,
      verifier_peer_id: reconnect.inputs.verifier_peer_id,
      claimant_signaling_peer_id: reconnect.inputs.claimant_signaling_peer_id,
      verifier_signaling_peer_id: reconnect.inputs.verifier_signaling_peer_id,
      room_name: reconnect.inputs.room_name
    })
    expect(proof).toEqual({
      type: 'mesh_auth_proof_v1',
      token_id: reconnect.inputs.token_id,
      challenge: reconnect.inputs.challenge,
      channel_binding: reconnect.inputs.channel_binding,
      claimant_peer_id: reconnect.inputs.claimant_peer_id,
      verifier_peer_id: reconnect.inputs.verifier_peer_id,
      claimant_signaling_peer_id: reconnect.inputs.claimant_signaling_peer_id,
      verifier_signaling_peer_id: reconnect.inputs.verifier_signaling_peer_id,
      room_name: reconnect.inputs.room_name,
      proof: reconnect.hmac_sha256_hex
    })
    expect(proof).toEqual(reconnect.proof.frame)
    await store.close()
  })

  it('never uses browser storage, fails closed for mismatches, and zeroes token bytes on cleanup', async () => {
    const reconnect = reconnectFixture()
    const store = new MemoryPeerCredentialStore()
    await store.save('stable-answer', {
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      rawBearerToken: 'synthetic-reconnect-token'
    })
    const tokenBytes = store.testingTokenBytes('stable-answer')
    expect(tokenBytes?.some((byte) => byte !== 0)).toBe(true)
    const tamperedChallenges = [
      { label: 'wrong claimant stable identity', patch: { claimant_peer_id: 'wrong-stable-peer' } },
      { label: 'wrong verifier stable identity', patch: { verifier_peer_id: 'wrong-verifier-peer' } },
      { label: 'wrong room', patch: { room_name: 'wrong-room' } }
    ] as const
    for (const { patch } of tamperedChallenges) {
      await expect(store.prove('stable-answer', {
        ...reconnect.challenge.frame,
        ...patch
      })).resolves.toBeUndefined()
    }
    await expect(store.prove('stable-answer', {
      ...reconnect.challenge.frame,
      claimant_signaling_peer_id: 'rotated-claimant-sig',
      verifier_signaling_peer_id: 'rotated-verifier-sig'
    })).resolves.toMatchObject({
      claimant_signaling_peer_id: 'rotated-claimant-sig',
      verifier_signaling_peer_id: 'rotated-verifier-sig'
    })
    await store.remove('stable-answer')
    expect(Array.from(tokenBytes ?? [])).toEqual(Array(tokenBytes?.length ?? 0).fill(0))
    await expect(store.get('stable-answer')).resolves.toBeUndefined()
    await store.close()
    await expect(store.get('stable-answer')).rejects.toThrow(/closed/u)
  })

  it('enforces expiresAtMs with a deterministic clock while preserving non-expiring web credentials', async () => {
    const reconnect = reconnectFixture()
    let now = 1_000
    const store = new MemoryPeerCredentialStore({ now: () => now })
    const base = {
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      rawBearerToken: 'synthetic-reconnect-token'
    }
    await expect(store.save('expired-at-save', { ...base, expiresAtMs: now })).rejects.toThrow(/expired/u)
    await store.save('stable-answer', { ...base, expiresAtMs: 1_500 })
    await expect(store.createReconnectProof('stable-answer', reconnect.challenge.frame)).resolves.toEqual(reconnect.proof.frame)
    now = 1_500
    await expect(store.get('stable-answer')).resolves.toBeUndefined()
    await expect(store.status('stable-answer')).resolves.toMatchObject({ found: false, hasBearerToken: false })
    await expect(store.createReconnectProof('stable-answer', reconnect.challenge.frame)).resolves.toBeUndefined()

    await store.save('non-expiring', base)
    now = 10_000
    await expect(store.createReconnectProof('non-expiring', reconnect.challenge.frame)).resolves.toEqual(reconnect.proof.frame)
  })

})


describe('NativePeerCredentialStore', () => {
  it('normalizes JSON null values from native Keychain/Keystore adapters as absent', async () => {
    const reconnect = reconnectFixture()
    const commands: string[] = []
    const store = new NativePeerCredentialStore({
      invoke: async (command, payload) => {
        commands.push(command)
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) {
          return {
            peerId: payload?.peerId,
            found: false,
            hasBearerToken: false,
            credential: null,
            backend: 'ios-keychain',
            persisted: true,
            secretsRedacted: true,
            redactedFields: ['rawBearerToken']
          }
        }
        throw new Error(`unexpected command ${command}`)
      }
    })

    await expect(store.status('stable-answer')).resolves.toMatchObject({
      found: false,
      hasBearerToken: false,
      credential: undefined,
      backend: 'ios-keychain'
    })
    await expect(
      store.createReconnectProof('stable-answer', reconnect.challenge.frame)
    ).resolves.toBeUndefined()
    expect(commands).toEqual([
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status
    ])
  })

  it('delegates reconnect proof creation to an opaque native provider without raw-token load in JS', async () => {
    const reconnect = reconnectFixture()
    const calls: Array<{ command: string; payload: Record<string, unknown> | undefined }> = []
    const invoke: NativePeerCredentialCommandInvoker = async (command, payload) => {
      calls.push({ command, payload })
      expect(command).not.toContain('get')
      if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) {
        return {
          peerId: 'stable-answer',
          found: true,
          hasBearerToken: true,
          credential: {
            tokenId: reconnect.inputs.token_id,
            claimantPeerId: reconnect.inputs.claimant_peer_id,
            verifierPeerId: reconnect.inputs.verifier_peer_id,
            claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
            verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
            roomName: reconnect.inputs.room_name
          },
          backend: 'platform-keychain',
          persisted: true,
          secretsRedacted: true,
          redactedFields: ['rawBearerToken']
        }
      }
      if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.prove) {
        expect(JSON.stringify(payload)).not.toContain('synthetic-reconnect-token')
        return {
          peerId: 'stable-answer',
          found: true,
          matched: true,
          proof: reconnect.proof.frame,
          backend: 'platform-keychain',
          secretsRedacted: true,
          redactedFields: ['rawBearerToken']
        }
      }
      throw new Error(`unexpected command ${command}`)
    }
    const store = new NativePeerCredentialStore({ invoke })
    const status = await store.status('stable-answer')
    expect(status).toMatchObject({ found: true, hasBearerToken: true, persisted: true, secretsRedacted: true })
    expect(JSON.stringify(status)).not.toContain('synthetic-reconnect-token')
    const proof = await store.createReconnectProof('stable-answer', reconnect.challenge.frame)
    expect(proof).toEqual(reconnect.proof.frame)
    expect(calls.map((call) => call.command)).toEqual([
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.prove
    ])
  })


  it('treats expired native status as absent, deletes it, and does not request a proof', async () => {
    const reconnect = reconnectFixture()
    const commands: string[] = []
    const store = new NativePeerCredentialStore({
      now: () => 2_000,
      invoke: async (command, payload) => {
        commands.push(command)
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) {
          return {
            peerId: payload?.peerId,
            found: true,
            hasBearerToken: true,
            credential: {
              tokenId: reconnect.inputs.token_id,
              claimantPeerId: reconnect.inputs.claimant_peer_id,
              verifierPeerId: reconnect.inputs.verifier_peer_id,
              claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
              verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
              roomName: reconnect.inputs.room_name,
              expiresAtMs: 2_000
            },
            backend: 'platform-keychain',
            persisted: true,
            secretsRedacted: true,
            redactedFields: ['rawBearerToken']
          }
        }
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete) return { peerId: payload?.peerId, found: false, hasBearerToken: false }
        throw new Error(`unexpected command ${command}`)
      }
    })
    await expect(store.status('stable-answer')).resolves.toMatchObject({ found: false, hasBearerToken: false })
    await expect(store.createReconnectProof('stable-answer', reconnect.challenge.frame)).resolves.toBeUndefined()
    expect(commands).toEqual([
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete
    ])
  })

  it('rejects already-expired native saves and discards expired native proof responses', async () => {
    const reconnect = reconnectFixture()
    const commands: string[] = []
    const store = new NativePeerCredentialStore({
      now: () => 2_000,
      invoke: async (command, payload) => {
        commands.push(command)
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) {
          return {
            peerId: payload?.peerId,
            found: true,
            hasBearerToken: true,
            credential: {
              tokenId: reconnect.inputs.token_id,
              claimantPeerId: reconnect.inputs.claimant_peer_id,
              verifierPeerId: reconnect.inputs.verifier_peer_id,
              claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
              verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
              roomName: reconnect.inputs.room_name,
              expiresAtMs: 2_001
            },
            secretsRedacted: true,
            redactedFields: ['rawBearerToken']
          }
        }
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.prove) {
          return {
            peerId: payload?.peerId,
            found: true,
            matched: true,
            proof: reconnect.proof.frame,
            credential: {
              tokenId: reconnect.inputs.token_id,
              claimantPeerId: reconnect.inputs.claimant_peer_id,
              verifierPeerId: reconnect.inputs.verifier_peer_id,
              claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
              verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
              roomName: reconnect.inputs.room_name,
              expiresAtMs: 2_000
            },
            secretsRedacted: true,
            redactedFields: ['rawBearerToken']
          }
        }
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete) return { peerId: payload?.peerId, found: false, hasBearerToken: false }
        throw new Error(`unexpected command ${command}`)
      }
    })
    await expect(store.save('stable-answer', {
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      rawBearerToken: 'synthetic-reconnect-token',
      expiresAtMs: 2_000
    })).rejects.toThrow(/expired/u)
    expect(commands).toEqual([])
    await expect(store.createReconnectProof('stable-answer', reconnect.challenge.frame)).resolves.toBeUndefined()
    expect(commands).toEqual([
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.prove,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete
    ])
  })


  it('propagates native command failures and fails closed when native reports no matching credential', async () => {
    const reconnect = reconnectFixture()
    const failures = new NativePeerCredentialStore({
      invoke: async (command) => {
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) throw new Error('native unavailable')
        return null
      }
    })
    await expect(failures.status('stable-answer')).rejects.toThrow(/native unavailable/u)

    const store = new NativePeerCredentialStore({
      invoke: async (command) => {
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.status) {
          return { peerId: 'stable-answer', found: true, hasBearerToken: true, secretsRedacted: true, redactedFields: ['rawBearerToken'] }
        }
        if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.prove) {
          return {
            peerId: 'stable-answer',
            found: true,
            matched: false,
            backend: 'platform-keychain',
            secretsRedacted: true,
            redactedFields: ['rawBearerToken']
          }
        }
        throw new Error(`unexpected command ${command}`)
      }
    })
    await expect(store.createReconnectProof('stable-answer', reconnect.challenge.frame)).resolves.toBeUndefined()
  })

  it('stores only by handing the transient bearer to native, then uses status/delete without reloading raw token', async () => {
    const reconnect = reconnectFixture()
    const commands: string[] = []
    const invoke: NativePeerCredentialCommandInvoker = async (command, payload) => {
      commands.push(command)
      if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.set) {
        expect(payload?.rawBearerToken).toBe('synthetic-reconnect-token')
        return {
          peerId: payload?.peerId,
          found: true,
          hasBearerToken: true,
          credential: {
            tokenId: payload?.tokenId,
            claimantPeerId: payload?.claimantPeerId,
            verifierPeerId: payload?.verifierPeerId,
            claimantSignalingPeerId: payload?.claimantSignalingPeerId,
            verifierSignalingPeerId: payload?.verifierSignalingPeerId,
            roomName: payload?.roomName
          },
          backend: 'platform-keychain',
          persisted: true,
          secretsRedacted: true,
          redactedFields: ['rawBearerToken']
        }
      }
      if (command === DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete) return { peerId: payload?.peerId, found: false, hasBearerToken: false }
      throw new Error(`unexpected command ${command}`)
    }
    const store = new NativePeerCredentialStore({ invoke })
    const meta = await store.save('stable-answer', {
      tokenId: reconnect.inputs.token_id,
      claimantPeerId: reconnect.inputs.claimant_peer_id,
      verifierPeerId: reconnect.inputs.verifier_peer_id,
      claimantSignalingPeerId: reconnect.inputs.claimant_signaling_peer_id,
      verifierSignalingPeerId: reconnect.inputs.verifier_signaling_peer_id,
      roomName: reconnect.inputs.room_name,
      rawBearerToken: 'synthetic-reconnect-token'
    })
    expect(meta).toMatchObject({ tokenId: reconnect.inputs.token_id, roomName: reconnect.inputs.room_name })
    await store.remove('stable-answer')
    await store.clear()
    await store.close()
    await expect(store.status('stable-answer')).rejects.toThrow(/closed/u)
    expect(commands).toEqual([
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.set,
      DEFAULT_NATIVE_PEER_CREDENTIAL_COMMANDS.delete
    ])
  })
})
