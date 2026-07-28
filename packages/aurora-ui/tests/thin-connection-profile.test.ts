import { describe, expect, it } from 'vitest'
import {
  activeThinConnectionProfile,
  emptyThinProfileDocument,
  isThinConnectionProfileConfigured,
  parseThinProfileDocument,
  sanitizeThinConnectionProfile,
  serializeThinProfileDocument,
  type ThinConnectionProfile,
} from '../src/thin-connection-profile'

function httpProfile(
  overrides: Partial<ThinConnectionProfile> = {},
): ThinConnectionProfile {
  return {
    id: 'home',
    label: 'Home Aurora',
    mode: 'http-only',
    gatewayUrl: 'http://gateway.lan:8000/api?tenant=home',
    signalingUrl: '',
    nodeName: 'Kitchen tablet',
    localStablePeerId: 'aurora-kitchen-tablet',
    ...overrides,
  }
}

function webRtcProfile(
  overrides: Partial<ThinConnectionProfile> = {},
): ThinConnectionProfile {
  return {
    id: 'direct',
    label: 'Direct Aurora',
    mode: 'webrtc-only',
    gatewayUrl: '',
    signalingUrl: 'wss://signal.example.test/mqtt?tenant=home',
    nodeName: 'Aurora phone',
    localStablePeerId: 'aurora-phone-stable',
    webrtcProfile: {
      mode: 'webrtc-only',
      appId: 'aurora',
      room: 'family-room',
      roomSecretRef: 'ref:memory:family-room',
      signalingBrokers: ['wss://invite.example.test/mqtt'],
      nodeName: 'Aurora phone',
      expectedStablePeerId: 'host-peer',
      stunServers: ['stun:stun.example.test:3478'],
      turnServers: ['turns:turn.example.test:5349'],
      requireAppLayerE2ee: true,
    },
    ...overrides,
  }
}

describe('thin connection profiles', () => {
  it('round-trips an empty first-run document without inventing a build-time endpoint', () => {
    const document = emptyThinProfileDocument()
    const encoded = serializeThinProfileDocument(document)

    expect(JSON.parse(encoded)).toEqual({
      version: 1,
      activeProfileId: null,
      profiles: [],
    })
    expect(parseThinProfileDocument(encoded)).toEqual(document)
    expect(activeThinConnectionProfile(document)).toBeUndefined()
  })

  it('accepts runtime HTTP/HTTPS and WS/WSS endpoints with deployment paths and nonsecret queries', () => {
    const http = sanitizeThinConnectionProfile(httpProfile())
    const direct = sanitizeThinConnectionProfile(webRtcProfile())

    expect(http.gatewayUrl).toBe('http://gateway.lan:8000/api?tenant=home')
    expect(direct.signalingUrl).toBe('wss://signal.example.test/mqtt?tenant=home')
    expect(direct.webrtcProfile?.signalingBrokers).toEqual([
      'wss://signal.example.test/mqtt?tenant=home',
    ])
    expect(isThinConnectionProfileConfigured(http)).toBe(true)
    expect(isThinConnectionProfileConfigured(direct)).toBe(true)
  })

  it('requires the transports selected by the runtime connection mode', () => {
    expect(() =>
      sanitizeThinConnectionProfile(httpProfile({ gatewayUrl: '' })),
    ).toThrow(/requires an HTTP or HTTPS Gateway endpoint/i)
    expect(() =>
      sanitizeThinConnectionProfile(webRtcProfile({ webrtcProfile: undefined })),
    ).toThrow(/requires an Aurora WebRTC invite/i)
    expect(() =>
      sanitizeThinConnectionProfile(webRtcProfile({
        mode: 'webrtc-preferred',
        gatewayUrl: '',
      })),
    ).toThrow(/requires an HTTP or HTTPS Gateway endpoint/i)
  })

  it.each([
    'http://user:password@gateway.example.test',
    'https://gateway.example.test/path#token',
    'https://gateway.example.test/api?access_token=secret',
    'https://gateway.example.test/api?apiKey=secret',
  ])('rejects credential-bearing Gateway metadata: %s', (gatewayUrl) => {
    expect(() =>
      sanitizeThinConnectionProfile(httpProfile({ gatewayUrl })),
    ).toThrow(/credentials|fragments/i)
  })

  it.each([
    'wss://user:password@signal.example.test/mqtt',
    'ws://signal.example.test/mqtt#room',
    'wss://signal.example.test/mqtt?room_secret=secret',
    'https://signal.example.test/mqtt',
  ])('rejects unsafe signaling metadata: %s', (signalingUrl) => {
    expect(() =>
      sanitizeThinConnectionProfile(webRtcProfile({ signalingUrl })),
    ).toThrow(/credentials|fragments|must use/i)
  })

  it('serializes only the nonsecret profile schema and rejects an invalid active profile', () => {
    const unsafe = {
      ...webRtcProfile(),
      rawBearerToken: 'must-not-persist',
      roomSecret: 'must-not-persist',
      webrtcProfile: {
        ...webRtcProfile().webrtcProfile!,
        roomSecret: 'must-not-persist',
        rawBearerToken: 'must-not-persist',
      },
    } as ThinConnectionProfile
    const encoded = serializeThinProfileDocument({
      version: 1,
      activeProfileId: unsafe.id,
      profiles: [unsafe],
    })

    expect(encoded).not.toContain('must-not-persist')
    expect(parseThinProfileDocument(encoded)?.profiles).toHaveLength(1)
    expect(parseThinProfileDocument(JSON.stringify({
      version: 1,
      activeProfileId: 'missing',
      profiles: [httpProfile()],
    }))).toBeNull()
  })
})
