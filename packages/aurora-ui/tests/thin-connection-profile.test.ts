import { describe, expect, it } from 'vitest'
import {
  activeThinConnectionProfile,
  emptyThinProfileDocument,
  isThinConnectionProfileConfigured,
  parseThinProfileDocument,
  sanitizeThinConnectionProfile,
  serializeThinProfileDocument,
  thinConnectionProfileWithManualAddress,
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
      nodeName: 'Aurora host',
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
    expect(direct.nodeName).toBe('Aurora phone')
    expect(direct.webrtcProfile?.nodeName).toBe('Aurora host')
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

  it('converts an invite profile to an HTTP-only manual address profile', () => {
    const manual = thinConnectionProfileWithManualAddress(
      webRtcProfile(),
      '  https://gateway.example.test/api  ',
    )

    expect(manual).toEqual({
      id: 'direct',
      label: 'Direct Aurora',
      mode: 'http-only',
      gatewayUrl: 'https://gateway.example.test/api',
      signalingUrl: '',
      nodeName: 'Aurora phone',
      localStablePeerId: 'aurora-phone-stable',
    })
    expect(manual).not.toHaveProperty('webrtcProfile')
    expect(sanitizeThinConnectionProfile(manual)).toEqual(manual)
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

  it.each([
    'turn:user:password@turn.example.test:3478',
    'turn:turn.example.test:3478?credential=secret',
  ])('rejects credential-bearing ICE metadata: %s', (turnServer) => {
    expect(() =>
      sanitizeThinConnectionProfile(webRtcProfile({
        webrtcProfile: {
          ...webRtcProfile().webrtcProfile!,
          turnServers: [turnServer],
        },
      })),
    ).toThrow(/credentials|query parameters/i)
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

  it('keeps the v1 profile shape limited to runtime home-node connection metadata', () => {
    const encoded = serializeThinProfileDocument({
      version: 1,
      activeProfileId: 'direct',
      profiles: [webRtcProfile()],
    })
    const parsed = JSON.parse(encoded)

    expect(parsed.version).toBe(1)
    expect(parsed.profiles[0]).toMatchObject({
      id: 'direct',
      mode: 'webrtc-only',
      gatewayUrl: '',
      signalingUrl: 'wss://signal.example.test/mqtt?tenant=home',
    })
    expect(parsed.profiles[0]).not.toHaveProperty('nodeMode')
    expect(parsed.profiles[0]).not.toHaveProperty('runtimeTier')
    expect(parsed.profiles[0]).not.toHaveProperty('localCapabilities')
    expect(parsed.profiles[0]).not.toHaveProperty('homeConnection')
  })
})
