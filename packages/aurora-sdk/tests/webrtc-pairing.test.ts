import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { bytesToHex, hexToBytes } from '../src/webrtc/crypto.js'
import {
  PairingProtocolError,
  PairingSasHandshake,
  deriveChannelBinding,
  derivePairingSas,
  nonceCommitment,
  pairingIdentity,
  parsePairingCommitMessage,
  parsePairingRevealMessage,
  parsePairingTerminalMessage
} from '../src/webrtc/pairing.js'

type PairingFixture = {
  inputs: {
    app_id: string
    room: string
    offerer_signaling_id: string
    answerer_signaling_id: string
    offer_sdp: string
    answer_sdp: string
    offerer_nonce_hex: string
    answerer_nonce_hex: string
  }
  channel_binding_sha256: string
  offerer_identity: any
  answerer_identity: any
  offerer_commit_message: any
  answerer_commit_message: any
  offerer_reveal_message: any
  answerer_reveal_message: any
  sas: {
    pairing_session_id: string
    transcript_sha256: string
    verification_code: string
    answerer_view_matches: boolean
  }
  terminal_message: any
}

function pairingFixture(): PairingFixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8')).pairing
}

describe('WebRTC pairing SAS v2', () => {
  it('matches Python channel binding, commitments, reveal messages and two-sided SAS fixture', async () => {
    const fixture = pairingFixture()
    const binding = await deriveChannelBinding({
      appId: fixture.inputs.app_id,
      room: fixture.inputs.room,
      offererSignalingId: fixture.inputs.offerer_signaling_id,
      answererSignalingId: fixture.inputs.answerer_signaling_id,
      offerSdp: fixture.inputs.offer_sdp,
      answerSdp: fixture.inputs.answer_sdp
    })
    expect(binding).toBe(fixture.channel_binding_sha256)

    const offererNonce = hexToBytes(fixture.inputs.offerer_nonce_hex)
    const answererNonce = hexToBytes(fixture.inputs.answerer_nonce_hex)
    expect(await nonceCommitment(binding, fixture.offerer_identity, offererNonce)).toBe(fixture.offerer_commit_message.nonce_commitment)
    expect(await nonceCommitment(binding, fixture.answerer_identity, answererNonce)).toBe(fixture.answerer_commit_message.nonce_commitment)

    const offerer = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: fixture.offerer_identity,
      expectedRemoteIdentity: fixture.answerer_identity,
      localNonce: offererNonce
    })
    const answerer = new PairingSasHandshake({
      channelBindingSha256: binding,
      localIdentity: fixture.answerer_identity,
      expectedRemoteIdentity: fixture.offerer_identity,
      localNonce: answererNonce
    })

    await expect(offerer.commitMessage()).resolves.toEqual(fixture.offerer_commit_message)
    await expect(answerer.commitMessage()).resolves.toEqual(fixture.answerer_commit_message)
    offerer.acceptCommit(fixture.answerer_commit_message)
    answerer.acceptCommit(fixture.offerer_commit_message)
    expect(offerer.revealMessage()).toEqual(fixture.offerer_reveal_message)
    expect(answerer.revealMessage()).toEqual(fixture.answerer_reveal_message)

    const offererSas = await offerer.acceptReveal(fixture.answerer_reveal_message)
    const answererSas = await answerer.acceptReveal(fixture.offerer_reveal_message)
    expect(offererSas).toMatchObject({
      pairingSessionId: fixture.sas.pairing_session_id,
      transcriptSha256: fixture.sas.transcript_sha256,
      verificationCode: fixture.sas.verification_code,
      channelBindingSha256: binding,
      remoteStablePeerId: 'stable-answer',
      remoteNodeName: 'Fixture Answerer'
    })
    expect(answererSas.verificationCode).toBe(offererSas.verificationCode)
    expect(answererSas.pairingSessionId).toBe(offererSas.pairingSessionId)
    expect(fixture.sas.answerer_view_matches).toBe(true)
    offerer.confirm()
    expect(offerer.state).toBe('confirmed')
    expect(() => parsePairingTerminalMessage({ type: 'pairing_v2_terminal', status: 'accepted', pairing_session_id: fixture.sas.pairing_session_id, peer_id: 'stable-offer', signaling_peer_id: 'sig-offer' })).toThrow(PairingProtocolError)

    const denied = answerer.reject()
    expect(denied).toEqual({ ...fixture.terminal_message, peer_id: 'stable-answer', signaling_peer_id: 'sig-answer' })
    offerer.close()
    answerer.close()
    expect(bytesToHex(offerer.localNonce)).toBe('00'.repeat(32))
  })

  it('derives SAS directly from parsed fixture messages', async () => {
    const fixture = pairingFixture()
    const commit = parsePairingCommitMessage(fixture.offerer_commit_message)
    const reveal = parsePairingRevealMessage(fixture.offerer_reveal_message)
    expect(commit.identity).toEqual(fixture.offerer_identity)
    expect(reveal.nonce).toBe(fixture.offerer_reveal_message.nonce)
    const sas = await derivePairingSas({
      channelBindingSha256: fixture.channel_binding_sha256,
      offererIdentity: fixture.offerer_identity,
      offererCommitment: fixture.offerer_commit_message.nonce_commitment,
      offererNonce: hexToBytes(fixture.inputs.offerer_nonce_hex),
      answererIdentity: fixture.answerer_identity,
      answererCommitment: fixture.answerer_commit_message.nonce_commitment,
      answererNonce: hexToBytes(fixture.inputs.answerer_nonce_hex),
      localRole: 'answerer'
    })
    expect(sas.pairingSessionId).toBe(fixture.sas.pairing_session_id)
    expect(sas.remoteStablePeerId).toBe('stable-offer')
  })

  it('rejects mutation, stale channel binding, duplicate conflicts, identity mismatch, and expired sessions', async () => {
    const fixture = pairingFixture()
    const hand = new PairingSasHandshake({
      channelBindingSha256: fixture.channel_binding_sha256,
      localIdentity: fixture.offerer_identity,
      expectedRemoteIdentity: fixture.answerer_identity,
      localNonce: hexToBytes(fixture.inputs.offerer_nonce_hex)
    })
    await hand.commitMessage()
    expect(() => hand.acceptCommit({ ...fixture.answerer_commit_message, channel_binding_sha256: 'a'.repeat(64) })).toThrow(PairingProtocolError)
    expect(() => hand.acceptCommit({ ...fixture.answerer_commit_message, identity: { ...fixture.answerer_identity, stable_peer_id: 'evil' } })).toThrow(PairingProtocolError)
    hand.acceptCommit(fixture.answerer_commit_message)
    expect(() => hand.acceptCommit({ ...fixture.answerer_commit_message, nonce_commitment: 'b'.repeat(64) })).toThrow(PairingProtocolError)

    const stale = new PairingSasHandshake({
      channelBindingSha256: fixture.channel_binding_sha256,
      localIdentity: fixture.offerer_identity,
      expectedRemoteIdentity: fixture.answerer_identity,
      localNonce: hexToBytes(fixture.inputs.offerer_nonce_hex),
      timeoutMs: 5,
      nowMs: (() => {
        let now = 0
        return () => {
          now += 10
          return now
        }
      })()
    })
    await expect(stale.commitMessage()).rejects.toThrow(/expired/u)
  })

  it('rejects prototype-bearing and overbroad parser inputs', () => {
    const fixture = pairingFixture()
    class Evil { type = 'pairing_v2_commit' }
    expect(() => parsePairingCommitMessage(new Evil())).toThrow(PairingProtocolError)
    expect(() => parsePairingCommitMessage({ ...fixture.offerer_commit_message, extra: true })).toThrow(PairingProtocolError)
    expect(() => parsePairingRevealMessage({ ...fixture.offerer_reveal_message, nonce: `${fixture.offerer_reveal_message.nonce}=` })).toThrow()
    expect(() => parsePairingTerminalMessage({ ...fixture.terminal_message, verification_code: 'abc' })).toThrow(PairingProtocolError)
    expect(parsePairingTerminalMessage({ ...fixture.terminal_message, status: 'superseded', reason: 'newer connection' }).status).toBe('superseded')
    expect(parsePairingTerminalMessage({ ...fixture.terminal_message, status: 'failed', reason: 'bad transcript' }).status).toBe('failed')
    expect(() => pairingIdentity({ role: 'offerer', stablePeerId: '', signalingPeerId: 'sig' })).toThrow(PairingProtocolError)
  })
})
