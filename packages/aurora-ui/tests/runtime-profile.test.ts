import { describe, expect, it } from 'vitest'
import {
  emptyRuntimeProfileDocument,
  isRuntimeProfileConfigured,
  mergeLocalNodeDesktopOverlay,
  mergeLocalNodeSpeechPreferences,
  migrateThinProfileDocumentToRuntime,
  parseRuntimeProfileDocument,
  resolveLocalSpeechLanguagePolicy,
  runtimeProfileDocumentToThinDocument,
  sanitizeRuntimeProfile,
  sanitizeRuntimeProfileDocument,
  serializeRuntimeProfileDocument,
  type AuroraRuntimeProfileV2,
  type AuroraSurfaceKind,
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

  it('preserves inactive saved profiles while rejecting unbounded or duplicate corpora', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    const inactive = {
      ...migrated,
      activeProfileId: null,
      profiles: [
        migrated.profiles[0]!,
        {
          ...migrated.profiles[0]!,
          id: 'backup-home',
          label: 'Backup home',
        },
      ],
    }

    expect(sanitizeRuntimeProfileDocument(inactive)).toEqual(inactive)
    expect(runtimeProfileDocumentToThinDocument(inactive)).toEqual({
      version: 1,
      activeProfileId: null,
      profiles: [
        v1Document.profiles[0],
        {
          ...v1Document.profiles[0]!,
          id: 'backup-home',
          label: 'Backup home',
        },
      ],
    })
    expect(parseRuntimeProfileDocument(JSON.stringify(inactive))).toEqual(inactive)
    expect(() => sanitizeRuntimeProfileDocument({
      ...inactive,
      profiles: [inactive.profiles[0]!, { ...inactive.profiles[0]! }],
    })).toThrow(/unique/u)
    expect(() => sanitizeRuntimeProfileDocument({
      version: 2,
      activeProfileId: null,
      profiles: Array.from({ length: 65 }, (_, index) => ({
        ...migrated.profiles[0]!,
        id: `profile-${index}`,
      })),
    })).toThrow(/too many/u)
  })

  it('enforces runtime profile size limits by UTF-8 bytes', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    expect(() => sanitizeRuntimeProfile({
      ...migrated.profiles[0]!,
      label: 'é'.repeat(61),
    })).toThrow(/profile label/u)

    const oversizedProfiles = Array.from({ length: 64 }, (_, index) => ({
      ...migrated.profiles[0]!,
      id: `profile-${index}`,
      label: `Profile ${index}`,
      homeConnection: {
        ...migrated.profiles[0]!.homeConnection!,
        webrtcProfile: {
          ...webrtcProfile,
          room: `${index}-${'é'.repeat(250)}`,
          roomSecretRef: `ref:${index}:${'é'.repeat(500)}`,
        },
      },
    }))
    expect(() => sanitizeRuntimeProfileDocument({
      version: 2,
      activeProfileId: null,
      profiles: oversizedProfiles,
    })).toThrow(/too large/u)
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
        enabledCapabilityPacks: ['native-actions', 'local-tools'],
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
    const surfaceKind: AuroraSurfaceKind = hostedWebSurface.physicalKind
    expect(surfaceKind).toBe('hosted-web')
    expect(hostedWebSurface.kind).toBe('web')
    expect(hostedWebSurface.legacyKind).toBe('web')
    expect(hostedWebSurface.prefersWebRtcTransport).toBe(true)
    expect(sanitizeRuntimeProfile(meshNode)).toEqual({
      ...meshNode,
      localNode: {
        ...meshNode.localNode,
        enabledCapabilityPacks: ['local-tools', 'native-actions'],
      },
    })
    expect(isRuntimeProfileConfigured(meshNode)).toBe(true)
  })

  it.each([
    'disabled',
    'unavailable',
    'downloading',
    'incompatible',
    'over-budget',
    'ready',
  ] as const)('sanitizes the persisted %s local speech state', (localSpeechPackState) => {
    const profile: AuroraRuntimeProfileV2 = {
      version: 2,
      id: `voice-${localSpeechPackState}`,
      label: 'Voice state',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      localNode: {
        nodeName: 'Hosted browser',
        stablePeerId: 'browser-peer',
        enabledCapabilityPacks: ['foreground-voice'],
        localSpeechPackState,
        meshMembership: {
          signalingUrl: 'wss://signal.example.test/mqtt',
          webrtcProfile: {
            ...webrtcProfile,
            mode: 'webrtc-only',
          },
        },
      },
    }

    expect(sanitizeRuntimeProfile(profile).localNode.localSpeechPackState).toBe(localSpeechPackState)
  })

  it('rejects unknown persisted local speech states', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!
    expect(() => sanitizeRuntimeProfile({
      ...migrated,
      localNode: {
        ...migrated.localNode,
        localSpeechPackState: 'unknown',
      },
    } as unknown as AuroraRuntimeProfileV2)).toThrow(/local speech state/u)
  })

  it('round-trips exact local speech selections separately from readiness state', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    const profile: AuroraRuntimeProfileV2 = {
      ...migrated.profiles[0]!,
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      localNode: {
        ...migrated.profiles[0]!.localNode,
        enabledCapabilityPacks: ['foreground-voice'],
        localSpeechPackState: 'downloading',
        localSpeechSelection: {
          vad: { packId: 'vad-small.en', packRevision: 'vad-rev-1' },
          kws: {
            packId: 'wake.en',
            packRevision: 'wake-rev-2',
          },
          stt: { packId: 'stt.en', packRevision: 'stt-rev-3' },
          tts: {
            packId: 'piper.en',
            packRevision: 'pack-rev-4',
            voiceId: 'standard:piper.en:ava',
            voiceRevision: 'voice-rev-5',
          },
          wakePhrase: {
            phraseId: 'hey-aurora.en',
            phrase: 'Hey Aurora',
            language: 'en',
            revision: 'wakephrase-v1-abc123',
          },
        },
        meshMembership: {
          signalingUrl: 'wss://signal.example.test/mqtt',
          webrtcProfile: {
            ...webrtcProfile,
            mode: 'webrtc-only',
          },
        },
      },
    }
    const document = {
      ...migrated,
      profiles: [profile],
    }

    const serialized = serializeRuntimeProfileDocument(document)
    const parsed = parseRuntimeProfileDocument(serialized)

    expect(parsed?.profiles[0]?.localNode.localSpeechPackState).toBe('downloading')
    expect(parsed?.profiles[0]?.localNode.localSpeechSelection).toEqual(profile.localNode.localSpeechSelection)
    expect(isRuntimeProfileConfigured(parsed?.profiles[0])).toBe(true)
  })

  it('round-trips this-device primary and voice language independently from speech packs', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    const profile: AuroraRuntimeProfileV2 = {
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        primaryLanguage: 'pt-BR',
        voiceLanguage: 'AUTO',
      },
    }

    const parsed = parseRuntimeProfileDocument(serializeRuntimeProfileDocument({
      ...migrated,
      profiles: [profile],
    }))
    expect(parsed?.profiles[0]?.localNode.primaryLanguage).toBe('pt-br')
    expect(parsed?.profiles[0]?.localNode.voiceLanguage).toBe('auto')
    expect(parsed?.profiles[0]?.localNode.localSpeechSelection).toBeUndefined()
    expect(resolveLocalSpeechLanguagePolicy('pt-br', 'auto')).toEqual({
      primaryLanguage: 'pt-br',
      voiceLanguage: 'auto',
      modelLanguage: 'pt-br',
    })
    expect(resolveLocalSpeechLanguagePolicy('en', 'de')).toEqual({
      primaryLanguage: 'en',
      voiceLanguage: 'de',
      modelLanguage: 'de',
    })
    expect(mergeLocalNodeSpeechPreferences(profile.localNode, {}, {
      primaryLanguage: 'de',
      voiceLanguage: 'fr',
    })).toEqual({
      ...profile.localNode,
      primaryLanguage: 'de',
      voiceLanguage: 'fr',
    })
    expect(() => sanitizeRuntimeProfile({
      ...profile,
      localNode: {
        ...profile.localNode,
        primaryLanguage: 'auto',
      },
    })).toThrow(/primary language/u)
    expect(() => sanitizeRuntimeProfile({
      ...profile,
      localNode: {
        ...profile.localNode,
        voiceLanguage: 'not a language',
      },
    })).toThrow(/voice language/u)
  })

  it('round-trips this-device overlay and shortcut prefs without server config', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    const profile: AuroraRuntimeProfileV2 = {
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        desktopOverlay: {
          enabled: false,
          voiceEnabled: true,
          textHotkey: 'Ctrl+J',
          autoCloseDelayMs: 2500,
        },
      },
    }

    const parsed = parseRuntimeProfileDocument(serializeRuntimeProfileDocument({
      ...migrated,
      profiles: [profile],
    }))
    expect(parsed?.profiles[0]?.localNode.desktopOverlay).toEqual({
      enabled: false,
      voiceEnabled: true,
      textHotkey: 'CommandOrControl+J',
      autoCloseDelayMs: 2500,
    })
    expect(mergeLocalNodeDesktopOverlay(profile.localNode, {
      enabled: true,
      textHotkey: 'Alt+K',
    })).toEqual({
      ...profile.localNode,
      desktopOverlay: {
        enabled: true,
        voiceEnabled: true,
        textHotkey: 'Alt+K',
        autoCloseDelayMs: 2500,
      },
    })
    expect(parseRuntimeProfileDocument(serializeRuntimeProfileDocument({
      ...migrated,
      profiles: [{
        ...migrated.profiles[0]!,
        localNode: migrated.profiles[0]!.localNode,
      }],
    }))?.profiles[0]?.localNode.desktopOverlay).toBeUndefined()
    expect(() => sanitizeRuntimeProfile({
      ...profile,
      localNode: {
        ...profile.localNode,
        desktopOverlay: {
          enabled: true,
          voiceEnabled: true,
          textHotkey: 'K',
          autoCloseDelayMs: 1200,
        },
      },
    })).toThrow(/overlay shortcut/u)
    expect(() => sanitizeRuntimeProfile({
      ...profile,
      localNode: {
        ...profile.localNode,
        desktopOverlay: {
          enabled: true,
          voiceEnabled: true,
          textHotkey: 'CommandOrControl+K',
          autoCloseDelayMs: 90_000,
        },
      },
    })).toThrow(/overlay hide delay/u)
  })

  it('rejects malformed local speech selections without rejecting old profile documents', () => {
    const migrated = migrateThinProfileDocumentToRuntime(v1Document)
    expect(parseRuntimeProfileDocument(JSON.stringify(v1Document))?.profiles[0]?.localNode.localSpeechSelection).toBeUndefined()
    expect(parseRuntimeProfileDocument(JSON.stringify(migrated))?.profiles[0]?.localNode.localSpeechSelection).toBeUndefined()

    expect(parseRuntimeProfileDocument(JSON.stringify({
      ...migrated,
      profiles: [{
        ...migrated.profiles[0]!,
        localNode: {
          ...migrated.profiles[0]!.localNode,
          localSpeechSelection: {
            tts: {
              packId: 'piper.en',
              packRevision: 'pack-rev-1',
              voiceId: 'standard:piper.en:ava',
            },
          },
        },
      }],
    }))).toBeNull()

    expect(() => sanitizeRuntimeProfile({
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        localSpeechSelection: {
          tts: {
            packId: 'piper.en?token=secret',
            packRevision: 'pack-rev-1',
            voiceId: 'standard:piper.en:ava',
            voiceRevision: 'voice-rev-1',
          },
        },
      },
    } as unknown as AuroraRuntimeProfileV2)).toThrow(/local speech pack id/u)

    expect(() => sanitizeRuntimeProfile({
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        localSpeechSelection: {
          batch: {
            packId: 'piper.en',
            packRevision: 'pack-rev-1',
          },
        },
      },
    } as unknown as AuroraRuntimeProfileV2)).toThrow(/selection task/u)

    expect(() => sanitizeRuntimeProfile({
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        localSpeechSelection: {
          stt: {
            packId: 'stt.en',
            packRevision: 'stt-rev-1',
            phraseId: 'hey-aurora.en',
          },
        },
      },
    } as unknown as AuroraRuntimeProfileV2)).toThrow(/asset selection field/u)

    expect(() => sanitizeRuntimeProfile({
      ...migrated.profiles[0]!,
      localNode: {
        ...migrated.profiles[0]!.localNode,
        localSpeechSelection: {
          wakePhrase: {
            phraseId: 'hey-aurora.en',
            phrase: 'Hey Aurora',
            language: 'en',
          },
        },
      },
    } as unknown as AuroraRuntimeProfileV2)).toThrow(/wake phrase revision/u)
  })

  it('keeps exact local speech selections neutral to physical surface capability', () => {
    const surface = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'unavailable',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })

    expect(surface.physicalKind).toBe('hosted-web')
    expect(surface.localSpeechPack).toMatchObject({
      state: 'unavailable',
      availabilityState: 'unsupported',
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    })
  })

  it('uses product-safe physical surface labels', () => {
    expect(getAuroraSurfaceProfile({ runtimeMode: 'desktop-thin' }).label).toBe('Desktop app')
    expect(getAuroraSurfaceProfile({ runtimeMode: 'web-thin' }).label).toBe('Web app')
    expect(getAuroraSurfaceProfile({ runtimeMode: 'android' }).label).toBe('Android app')
    expect(getAuroraSurfaceProfile({ runtimeMode: 'ios' }).label).toBe('iOS app')
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
    expect(() => serializeRuntimeProfileDocument({
      ...migrateThinProfileDocumentToRuntime(v1Document),
      profiles: [{
        ...migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!,
        homeConnection: {
          ...migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!.homeConnection!,
          webrtcProfile: {
            ...webrtcProfile,
            turnServers: ['turn:user:password@turn.example.test:3478'],
          },
        },
      }],
    })).toThrow(/embedded credentials/u)
    expect(() => serializeRuntimeProfileDocument({
      ...migrateThinProfileDocumentToRuntime(v1Document),
      profiles: [{
        ...migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!,
        homeConnection: {
          ...migrateThinProfileDocumentToRuntime(v1Document).profiles[0]!.homeConnection!,
          webrtcProfile: {
            ...webrtcProfile,
            turnServers: ['turn:turn.example.test:3478?credential=secret'],
          },
        },
      }],
    })).toThrow(/query parameters/u)
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
