import { describe, expect, it } from 'vitest'
import {
  emptyRuntimeProfileDocument,
  isRuntimeProfileConfigured,
  migrateThinProfileDocumentToRuntime,
  parseRuntimeProfileDocument,
  runtimeProfileDocumentToThinDocument,
  sanitizeRuntimeProfile,
  serializeRuntimeProfileDocument,
  type AuroraRuntimeProfileV2,
} from '../src/thin-connection-profile'
import type { ThinProfileDocument } from '../src/thin-connection-profile'
import {
  getAuroraSurfaceProfile,
  surfaceSupportsRuntimeTier,
} from '../src/platform-surface'

const webrtcProfile = {
  mode: 'webrtc-preferred' as const,
  appId: 'aurora',
  room: 'family-room',
  roomSecretRef: 'ref:memory:family-room',
  signalingBrokers: ['wss://signal.example.test/mqtt'],
  expectedStablePeerId: 'home-peer',
  nodeName: 'Home Aurora',
  production: true,
}

const v1Document: ThinProfileDocument = {
  version: 1,
  activeProfileId: 'home',
  profiles: [{
    id: 'home',
    label: 'Home',
    mode: 'webrtc-preferred',
    gatewayUrl: 'https://gateway.example.test/api',
    signalingUrl: 'wss://signal.example.test/mqtt',
    nodeName: 'Hosted browser',
    localStablePeerId: 'browser-peer',
    webrtcProfile,
  }],
}

describe('runtime profile document', () => {
  it('migrates v1 thin profiles to v2 remote-console profiles without losing connection identity', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)

    expect(migrated).toEqual({
      version: 2,
      activeProfileId: 'home',
      profiles: [{
        version: 2,
        id: 'home',
        label: 'Home',
        nodeMode: 'remote-console',
        runtimeTier: 'none',
        homeConnection: {
          mode: 'webrtc-preferred',
          gatewayUrl: 'https://gateway.example.test/api',
          signalingUrl: 'wss://signal.example.test/mqtt',
          homePeerId: 'home-peer',
          webrtcProfile,
        },
        localNode: {
          nodeName: 'Hosted browser',
          stablePeerId: 'browser-peer',
          enabledCapabilityPacks: [],
        },
      }],
    })
    expect(parseRuntimeProfileDocument(JSON.stringify(v1Document))).toEqual(migrated)
    expect(runtimeProfileDocumentToThinDocument(migrated)).toEqual(v1Document)
    expect(isRuntimeProfileConfigured(migrated.profiles[0])).toBe(true)
  })

  it('keeps surface, node role, connection, and runtime tier independent', () => {
    const hostedWebSurface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'webrtc-only',
    })
    const meshNode: AuroraRuntimeProfileV2 = {
      version: 2,
      id: 'mesh',
      label: 'This device',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      homeConnection: {
        mode: 'http-only',
        gatewayUrl: 'https://gateway.example.test/api',
      },
      localNode: {
        nodeName: 'Hosted browser',
        stablePeerId: 'browser-peer',
        enabledCapabilityPacks: ['local-tools', 'native-actions'],
        meshMembership: {
          signalingUrl: 'wss://signal.example.test/mqtt',
          webrtcProfile: {
            ...webrtcProfile,
            mode: 'webrtc-only',
          },
        },
      },
    }

    expect(hostedWebSurface.physicalKind).toBe('hosted-web')
    expect(hostedWebSurface.kind).toBe('web')
    expect(hostedWebSurface.prefersWebRtcTransport).toBe(true)
    expect(sanitizeRuntimeProfile(meshNode)).toEqual(meshNode)
    expect(isRuntimeProfileConfigured(meshNode)).toBe(true)
  })

  it('fails closed for corrupt data and rejects secrets in nonsecret profile documents', () => {
    expect(parseRuntimeProfileDocument('{')).toBeNull()
    expect(parseRuntimeProfileDocument(JSON.stringify({
      version: 1,
      activeProfileId: 'legacy-secret',
      profiles: [{
        ...v1Document.profiles[0],
        id: 'legacy-secret',
        roomSecret: 'do-not-store',
      }],
    }))).toBeNull()
    expect(parseRuntimeProfileDocument(JSON.stringify({
      version: 2,
      activeProfileId: 'secret',
      profiles: [{
        version: 2,
        id: 'secret',
        label: 'Secret',
        nodeMode: 'remote-console',
        runtimeTier: 'none',
        homeConnection: {
          mode: 'http-only',
          gatewayUrl: 'https://gateway.example.test/api',
          bearerToken: 'do-not-store',
        },
        localNode: {
          nodeName: 'Browser',
          stablePeerId: 'browser-peer',
          enabledCapabilityPacks: [],
        },
      }],
    }))).toBeNull()
    expect(() => serializeRuntimeProfileDocument({
      version: 2,
      activeProfileId: 'secret',
      profiles: [{
        ...migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!,
        id: 'secret',
        homeConnection: {
          mode: 'http-only',
          gatewayUrl: 'https://gateway.example.test/api?access_token=secret',
        },
      }],
    })).toThrow(/credentials/u)
  })

  it('validates home and mesh membership boundaries', () => {
    expect(() => sanitizeRuntimeProfile({
      version: 2,
      id: 'remote',
      label: 'Remote',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      localNode: {
        nodeName: 'Browser',
        stablePeerId: 'browser-peer',
        enabledCapabilityPacks: [],
      },
    })).toThrow(/home connection/u)

    expect(() => sanitizeRuntimeProfile({
      version: 2,
      id: 'mesh',
      label: 'Mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      localNode: {
        nodeName: 'Browser',
        stablePeerId: 'browser-peer',
        enabledCapabilityPacks: [],
      },
    })).toThrow(/mesh membership/u)

    expect(emptyRuntimeProfileDocument()).toEqual({
      version: 2,
      activeProfileId: null,
      profiles: [],
    })
  })

  it('gates the python-full tier on a package capability', () => {
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
    })
    const profile: AuroraRuntimeProfileV2 = {
      version: 2,
      id: 'local',
      label: 'Local',
      nodeMode: 'mesh-node',
      runtimeTier: 'python-full',
      localNode: {
        nodeName: 'Desktop',
        stablePeerId: 'desktop-peer',
        enabledCapabilityPacks: [],
        meshMembership: {
          signalingUrl: 'wss://signal.example.test/mqtt',
          webrtcProfile: {
            ...webrtcProfile,
            mode: 'webrtc-only',
          },
        },
      },
    }

    expect(surface.physicalKind).toBe('desktop-tauri')
    expect(surfaceSupportsRuntimeTier(surface, 'python-full')).toBe(false)
    expect(surfaceSupportsRuntimeTier(surface, 'python-full', { packageIncludesPython: true })).toBe(true)
    expect(() => sanitizeRuntimeProfile(profile)).toThrow(/bundled Python/u)
    expect(sanitizeRuntimeProfile(profile, { allowPythonFull: true })).toEqual(profile)
  })
})
