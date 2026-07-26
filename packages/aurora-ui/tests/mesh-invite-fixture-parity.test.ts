import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@aurora/client'

import { decodeMeshInvite, encodeMeshInviteToken, encodeMeshInviteUrl } from '../src/mesh-invite'

interface Fixture {
  invite: {
    payload: JsonObject
    token: string
    url: string
  }
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
})
