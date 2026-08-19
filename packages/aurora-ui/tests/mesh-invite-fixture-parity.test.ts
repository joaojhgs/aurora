import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@aurora/client'

import {
  decodeMeshInvite,
  encodeMeshInviteToken,
  encodeMeshInviteUrl,
  meshInviteOrigin,
  meshInviteSummary,
} from '../src/mesh-invite'

interface InviteVector {
  payload: JsonObject
  token: string
  url: string
}

interface Fixture {
  invite: InviteVector
  invite_v2: InviteVector
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
}

describe('mesh invite protocol fixture parity', () => {
  it('matches the committed WebRTC thin-shell amv1 invite vector', () => {
    const invite = fixture().invite

    expect(encodeMeshInviteToken(invite.payload)).toBe(invite.token)
    expect(encodeMeshInviteUrl(invite.payload)).toBe(invite.url)
    expect(decodeMeshInvite(invite.token)).toEqual(invite.payload)
    expect(decodeMeshInvite(invite.url)).toEqual(invite.payload)
  })

  it('matches the committed amv2 mesh-wide invite vector', () => {
    const invite = fixture().invite_v2

    expect(invite.token.startsWith('amv2.')).toBe(true)
    expect(encodeMeshInviteToken(invite.payload)).toBe(invite.token)
    expect(encodeMeshInviteUrl(invite.payload)).toBe(invite.url)
    expect(decodeMeshInvite(invite.token)).toEqual(invite.payload)
    expect(decodeMeshInvite(invite.url)).toEqual(invite.payload)
  })

  it('reads amv2 origin explicitly and amv1 node.peer_id as a hint', () => {
    const v2 = fixture().invite_v2
    const v1 = fixture().invite

    expect(meshInviteOrigin(v2.payload)).toEqual({ peerId: 'stable-offer', source: 'origin' })
    // The same device id, but an amv1 invite only ever *suggests* it — under the old
    // rules it was the single reachable device, which is no longer what an invite means.
    expect(meshInviteOrigin(v1.payload)).toEqual({ peerId: 'stable-offer', source: 'legacy-hint' })
    expect(meshInviteSummary(v2.payload).version).toBe(2)
    expect(meshInviteSummary(v1.payload).version).toBe(1)
  })

  it('keeps decoding amv1 tokens after the emitter moved to amv2', () => {
    const v1 = fixture().invite
    // amv1 links are already in the wild; decoding them is permanent, not a migration window.
    expect(decodeMeshInvite(v1.token)).toEqual(v1.payload)
    expect(decodeMeshInvite(`forwarded through chat: ${v1.token} enjoy`)).toEqual(v1.payload)
  })
})
