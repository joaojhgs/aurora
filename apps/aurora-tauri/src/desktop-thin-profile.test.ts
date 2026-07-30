// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AURORA_RELEASE_FOCUSED_MEDIA_EVENT,
  encodeMeshInviteToken,
  type BrowserWebThinRuntime,
  type BrowserWebRtcSnapshot,
} from '@aurora/ui'
import { NativePeerCredentialStore, type MeshReconnectChallengeMessage, type WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(async (
    _command: string,
    _args?: Record<string, unknown>,
  ): Promise<unknown> => {
    throw new Error('Tauri invoke is not mocked in this test')
  }),
  pluginListeners: [] as Array<{
    plugin: string
    event: string
    callback: (payload: Record<string, unknown>) => void
    unregister: ReturnType<typeof vi.fn>
  }>,
  addPluginListener: vi.fn(async (plugin: string, event: string, callback: (payload: Record<string, unknown>) => void) => {
    const unregister = vi.fn(async () => undefined)
    tauriCoreMock.pluginListeners.push({ plugin, event, callback, unregister })
    return { plugin, event, unregister }
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCoreMock.invoke,
  addPluginListener: tauriCoreMock.addPluginListener,
}))

import {
  bootstrapAuroraTauriRuntime,
  createAuroraTauriRuntime,
  createInitialAuroraTauriRuntime,
  createMemoryRuntimeProfileStore,
  createMemoryThinProfileStore,
  createTauriPackageCapabilities,
  ANDROID_LIFECYCLE_EVENT,
  ANDROID_NATIVE_PLUGIN_NAME,
  createTauriPeerCredentialCommandInvoker,
  installAndroidLifecyclePolicy,
  parseThinProfileDocument,
  serializeThinProfileDocument,
  TAURI_NATIVE_WEBRTC_DEFAULT_TIMEOUT_MS,
  type AuroraTauriRuntime,
  type TauriMeshNodeServicesFactory,
  type AuroraRuntimeProfileDocument,
  type AuroraRuntimeProfileStore,
  type AuroraThinConnectionProfile,
  type AuroraThinProfileDocument,
} from './aurora-client'
import type { TauriMeshNodeServices } from './tauri-mesh-node-services'
import { rebuildAuroraThinRuntime } from './tauri-app'

const profile: AuroraThinConnectionProfile = {
  id: 'office',
  label: 'Office',
  mode: 'webrtc-preferred',
  gatewayUrl: 'https://gateway.example.invalid',
  signalingUrl: 'wss://signaling.example.invalid',
  nodeName: 'Aurora desktop',
  localStablePeerId: 'desktop-peer-01',
  webrtcProfile: {
    mode: 'webrtc-preferred',
    appId: 'aurora',
    room: 'office-room',
    roomSecretRef: 'ref:memory:office-room',
    signalingBrokers: ['wss://signaling.example.invalid'],
    nodeName: 'Aurora desktop',
  },
}

const document: AuroraThinProfileDocument = {
  version: 1,
  activeProfileId: profile.id,
  profiles: [profile],
}

const runtimeDocument: AuroraRuntimeProfileDocument = {
  version: 2,
  activeProfileId: 'runtime-office',
  profiles: [{
    version: 2,
    id: 'runtime-office',
    label: 'Runtime office',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    homeConnection: {
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: 'wss://signaling.example.invalid',
      homePeerId: 'office-home',
      webrtcProfile: {
        ...profile.webrtcProfile!,
        expectedStablePeerId: 'office-home',
      },
    },
    localNode: {
      nodeName: 'Aurora desktop',
      stablePeerId: 'desktop-peer-01',
      enabledCapabilityPacks: ['local-tools'],
      meshMembership: {
        signalingUrl: 'wss://signaling.example.invalid',
        webrtcProfile: {
          mode: 'webrtc-only',
          appId: 'aurora',
          room: 'office-room',
          roomSecretRef: 'ref:memory:office-room',
          signalingBrokers: ['wss://signaling.example.invalid'],
          nodeName: 'Aurora desktop',
        },
      },
    },
  }],
}


type FakeAndroidThinRuntime = BrowserWebThinRuntime & {
  calls: {
    connect: Array<WebRtcPeerConnectionProfile | undefined>
    disconnect: string[]
    originalConnect: BrowserWebThinRuntime['peer']['connect']
  }
}

function fakeAndroidThinRuntime(mode: 'http-only' | 'webrtc-only' | 'webrtc-preferred'): FakeAndroidThinRuntime {
  const snapshot: BrowserWebRtcSnapshot = {
    state: 'idle',
    connectionMode: mode,
    icePathCategory: 'unknown',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: '2026-07-26T00:00:00.000Z',
    status: 'idle',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: mode === 'webrtc-preferred',
    secretsPersisted: false,
  }
  const calls = {
    connect: [] as Array<WebRtcPeerConnectionProfile | undefined>,
    disconnect: [] as string[],
    originalConnect: undefined as unknown as BrowserWebThinRuntime['peer']['connect'],
  }
  const peer: BrowserWebThinRuntime['peer'] = {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    importInvite: () => webRtcProfile('imported-room'),
    connect: vi.fn(async (profile?: WebRtcPeerConnectionProfile) => { calls.connect.push(profile) }),
    confirmPairing: vi.fn(async () => undefined),
    rejectPairing: vi.fn(async () => undefined),
    disconnect: vi.fn(async (reason = 'disconnect') => { calls.disconnect.push(reason) }),
    isFallbackEligibleAfterWebRtcRoute: () => false,
    markFallback: vi.fn(),
  } as unknown as BrowserWebThinRuntime['peer']
  calls.originalConnect = peer.connect
  return {
    client: {} as BrowserWebThinRuntime['client'],
    peer,
    surface: {} as BrowserWebThinRuntime['surface'],
    mode,
    features: {
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
    },
    close: vi.fn(async () => undefined),
    calls,
  }
}

function fakeEnabledMeshNodeServices() {
  const close = vi.fn(async () => undefined)
  const localFeatureSharing = {
    load: vi.fn(async () => ({ features: [], approvedDevices: [] })),
    setFeatureEnabled: vi.fn(async () => undefined),
    replacePeerSharing: vi.fn(async () => undefined),
    revokePeerSharing: vi.fn(async () => undefined),
  }
  const services = {
    enabled: true,
    peerHost: {},
    authorityResolver: {},
    pairingIssuer: {},
    localFeatureSharing,
    registeredToolIds: ['native.get_device_status'],
    close,
  } as unknown as TauriMeshNodeServices
  return { services, close, localFeatureSharing }
}

function webRtcProfile(room: string): WebRtcPeerConnectionProfile {
  return {
    mode: 'webrtc-only',
    appId: 'aurora',
    room,
    roomSecretRef: `ref:memory:${room}`,
    signalingBrokers: ['wss://broker.example/mqtt'],
    nodeName: 'Aurora Android',
    expectedStablePeerId: 'host-peer',
    requireAppLayerE2ee: true,
  }
}

describe('desktop-thin live connection profiles', () => {
  it('allows native Linux DataChannel RPC to carry fragmented registry responses', () => {
    expect(TAURI_NATIVE_WEBRTC_DEFAULT_TIMEOUT_MS).toBe(90_000)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.invoke.mockImplementation(async (
      _command: string,
      _args?: Record<string, unknown>,
    ): Promise<unknown> => {
      throw new Error('Tauri invoke is not mocked in this test')
    })
    tauriCoreMock.addPluginListener.mockClear()
    tauriCoreMock.pluginListeners.splice(0)
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__
  })

  it('loads the packaged profile asynchronously before creating the live runtime', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    let release!: (value: AuroraThinProfileDocument) => void
    const load = vi.fn(() => new Promise<AuroraThinProfileDocument>((resolve) => {
      release = resolve
    }))
    const store = {
      evidence: 'test nonsecret store',
      load,
      save: vi.fn(async () => undefined),
    }

    const pending = bootstrapAuroraTauriRuntime(store)
    expect(load).toHaveBeenCalledOnce()
    release(document)
    const runtime = await pending

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.thinProfile).toEqual(profile)
    expect(runtime.runtimeProfile).toMatchObject({
      id: profile.id,
      nodeMode: 'remote-console',
      runtimeTier: 'none',
    })
    expect(runtime.thinProfileController?.evidence).toContain('test nonsecret store')
    await runtime.dispose()
  })

  it('awaits durable mesh-node services before advertising the desktop client as a mesh node', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const store: AuroraRuntimeProfileStore = {
      kind: 'runtime-profile',
      evidence: 'test runtime profile store',
      load: vi.fn(async () => runtimeDocument),
      save: vi.fn(async () => undefined),
    }
    const { services, close, localFeatureSharing } = fakeEnabledMeshNodeServices()
    let release!: (value: TauriMeshNodeServices) => void
    const factory = vi.fn<TauriMeshNodeServicesFactory>(
      () =>
        new Promise<TauriMeshNodeServices>((resolve) => {
          release = resolve
        }),
    )

    const pending = bootstrapAuroraTauriRuntime(
      store,
      { pythonFullRuntime: false },
      factory,
    )
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(factory.mock.calls[0]?.[0].profile).toEqual(runtimeDocument.profiles[0])

    release(services)
    const runtime = await pending

    expect(runtime.thinFeatures).toMatchObject({
      activeNodeRole: 'mesh-node',
      meshNodeRuntimeEnabled: true,
      localToolProviderEnabled: true,
    })
    expect(runtime.localNodeProviderStatus).toEqual({
      available: true,
      reasonCode: null,
      registeredToolIds: ['native.get_device_status'],
    })
    expect(runtime.localFeatureSharing).toBe(localFeatureSharing)
    await runtime.dispose()
    await runtime.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('composes the configured native assistant provider without exposing its credential to JavaScript', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const store: AuroraRuntimeProfileStore = {
      kind: 'runtime-profile',
      evidence: 'test runtime profile store',
      load: vi.fn(async () => runtimeDocument),
      save: vi.fn(async () => undefined),
    }
    const { services } = fakeEnabledMeshNodeServices()
    tauriCoreMock.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'aurora_assistant_provider_status') {
        return {
          configured: true,
          enabled: true,
          provider: 'openai-compatible',
          endpoint: 'https://llm.example/v1/chat/completions',
          model: 'model-a',
          backend: 'platform-keychain',
          persisted: true,
          secretsRedacted: true,
          redactedFields: ['apiKey'],
        }
      }
      if (command === 'aurora_assistant_provider_complete') {
        expect(JSON.stringify(args)).not.toContain('provider-secret')
        return { type: 'message', content: 'Ready.' }
      }
      throw new Error(`Unexpected native command: ${command}`)
    })

    const runtime = await bootstrapAuroraTauriRuntime(
      store,
      { pythonFullRuntime: false },
      vi.fn(async () => services),
    )
    const response = await runtime.localAssistant?.provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 1,
      signal: new AbortController().signal,
    })

    expect(runtime.localAssistant?.remoteTools).toEqual([])
    expect(response).toEqual({ type: 'message', content: 'Ready.' })
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith('aurora_assistant_provider_status')
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'aurora_assistant_provider_complete',
      expect.objectContaining({
        request: expect.objectContaining({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }),
    )
    await runtime.dispose()
  })

  it('keeps an explicitly injected assistant provider ahead of native provider discovery', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const store: AuroraRuntimeProfileStore = {
      kind: 'runtime-profile',
      evidence: 'test runtime profile store',
      load: vi.fn(async () => runtimeDocument),
      save: vi.fn(async () => undefined),
    }
    const { services } = fakeEnabledMeshNodeServices()
    const provider = {
      complete: vi.fn(async () => ({ type: 'message' as const, content: 'Injected.' })),
    }

    const runtime = await bootstrapAuroraTauriRuntime(
      store,
      { pythonFullRuntime: false },
      vi.fn(async () => services),
      { provider },
    )

    expect(runtime.localAssistant?.provider).toBe(provider)
    expect(tauriCoreMock.invoke).not.toHaveBeenCalledWith('aurora_assistant_provider_status')
    await runtime.dispose()
  })

  it('fails bootstrap when mesh-node composition throws unexpectedly', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const store: AuroraRuntimeProfileStore = {
      kind: 'runtime-profile',
      evidence: 'test runtime profile store',
      load: vi.fn(async () => runtimeDocument),
      save: vi.fn(async () => undefined),
    }
    const factory = vi.fn<TauriMeshNodeServicesFactory>(async () => {
      throw new Error('mesh composition failed')
    })

    await expect(
      bootstrapAuroraTauriRuntime(
        store,
        { pythonFullRuntime: false },
        factory,
      ),
    ).rejects.toThrow('mesh composition failed')
  })

  it('composes desktop thin runtime from an actual v2 runtime profile document', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })

    const runtime = createAuroraTauriRuntime({
      runtimeProfileDocument: runtimeDocument,
      consumeThinInvite: false,
    })

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.runtimeProfile).toEqual(runtimeDocument.profiles[0])
    expect(runtime.nodeMode).toBe('mesh-node')
    expect(runtime.runtimeTier).toBe('lightweight-ts')
    expect(runtime.thinConnectionMode).toBe('webrtc-preferred')
    expect(runtime.thinProfile).toMatchObject({
      id: 'runtime-office',
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://gateway.example.invalid',
      localStablePeerId: 'desktop-peer-01',
    })
    expect(runtime.thinProfileConfigured).toBe(true)
    expect(runtime.thinFeatures).toMatchObject({
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
    })
    expect(runtime.localNodeProviderStatus).toBeUndefined()
    await runtime.dispose()
  })

  it('preserves legacy v1 profiles across sequential controller saves and selects', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    let saved: AuroraThinProfileDocument = document
    const store = {
      evidence: 'test v1 profile store',
      load: vi.fn(async () => saved),
      save: vi.fn(async (next: AuroraThinProfileDocument) => { saved = next }),
    }
    const runtime = createAuroraTauriRuntime({
      thinProfileStore: store,
      thinProfileDocument: document,
      consumeThinInvite: false,
    })

    await runtime.thinProfileController!.saveProfile({
      ...profile,
      id: 'backup',
      label: 'Backup',
    })
    await runtime.thinProfileController!.saveProfile({
      ...profile,
      id: 'travel',
      label: 'Travel',
    })
    await runtime.thinProfileController!.selectProfile('backup')

    expect(saved.activeProfileId).toBe('backup')
    expect(saved.profiles.map((candidate) => candidate.id).sort()).toEqual([
      'backup',
      'office',
      'travel',
    ])
    expect(runtime.thinProfileController!.document).toEqual(saved)
    await runtime.dispose()
  })

  it('requires explicit package capability proof before accepting python-full runtime profiles', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    const pythonFullDocument: AuroraRuntimeProfileDocument = {
      ...runtimeDocument,
      profiles: [{
        ...runtimeDocument.profiles[0]!,
        runtimeTier: 'python-full',
      }],
    }

    expect(() => createAuroraTauriRuntime({
      runtimeProfileDocument: pythonFullDocument,
      consumeThinInvite: false,
    })).toThrow(/bundled Python/)
    expect(() => createAuroraTauriRuntime({
      runtimeProfileDocument: pythonFullDocument,
      packageCapabilities: { pythonFullRuntime: true },
      consumeThinInvite: false,
    })).toThrow(/bundled Python/)
    expect(() => createAuroraTauriRuntime({
      runtimeProfileDocument: pythonFullDocument,
      packageCapabilities: createTauriPackageCapabilities({
        source: 'test',
        runtimeMode: 'desktop-local',
        includesPython: false,
      }),
      consumeThinInvite: false,
    })).toThrow(/bundled Python/)
    expect(() => createAuroraTauriRuntime({
      runtimeProfileDocument: pythonFullDocument,
      packageCapabilities: createTauriPackageCapabilities({
        source: 'test',
        runtimeMode: 'desktop-thin',
        includesPython: true,
      }),
      consumeThinInvite: false,
    })).toThrow(/bundled Python/)

    const runtime = createAuroraTauriRuntime({
      runtimeProfileDocument: pythonFullDocument,
      packageCapabilities: createTauriPackageCapabilities({
        source: 'test',
        runtimeMode: 'desktop-local',
        includesPython: true,
      }),
      consumeThinInvite: false,
    })

    expect(runtime.runtimeTier).toBe('python-full')
    expect(runtime.nodeMode).toBe('mesh-node')
    await runtime.dispose()
  })

  it('uses a remote-console runtime profile instead of starting desktop-local sidecar in a universal desktop artifact', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const remoteDocument: AuroraRuntimeProfileDocument = {
      version: 2,
      activeProfileId: 'remote',
      profiles: [{
        version: 2,
        id: 'remote',
        label: 'Remote',
        nodeMode: 'remote-console',
        runtimeTier: 'none',
        homeConnection: {
          mode: 'http-only',
          gatewayUrl: 'https://gateway.example.invalid',
        },
        localNode: {
          nodeName: 'Aurora desktop',
          stablePeerId: 'desktop-peer-remote',
          enabledCapabilityPacks: [],
        },
      }],
    }

    const runtime = createAuroraTauriRuntime({
      runtimeProfileDocument: remoteDocument,
      consumeThinInvite: false,
    })

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.nodeMode).toBe('remote-console')
    expect(runtime.runtimeTier).toBe('none')
    expect(await runtime.sidecarStatus()).toBeNull()
    await runtime.dispose()
  })

  it('keeps lightweight mesh-only profiles off the desktop-local sidecar path', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const meshOnlyDocument: AuroraRuntimeProfileDocument = {
      ...runtimeDocument,
      profiles: [{
        ...runtimeDocument.profiles[0]!,
        id: 'mesh-only',
        homeConnection: undefined,
      }],
      activeProfileId: 'mesh-only',
    }

    const runtime = createAuroraTauriRuntime({
      runtimeProfileDocument: meshOnlyDocument,
      consumeThinInvite: false,
    })

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.nodeMode).toBe('mesh-node')
    expect(runtime.runtimeTier).toBe('lightweight-ts')
    expect(runtime.thinConnectionMode).toBe('webrtc-only')
    expect(runtime.thinProfile).toMatchObject({
      id: 'mesh-only',
      mode: 'webrtc-only',
      gatewayUrl: '',
      signalingUrl: 'wss://signaling.example.invalid',
      webrtcProfile: expect.objectContaining({
        room: 'office-room',
      }),
    })
    expect(await runtime.sidecarStatus()).toBeNull()
    await runtime.dispose()
  })

  it('uses desktop-local sidecar only for proven python-full runtime profiles', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const fullDocument: AuroraRuntimeProfileDocument = {
      ...runtimeDocument,
      profiles: [{
        ...runtimeDocument.profiles[0]!,
        runtimeTier: 'python-full',
      }],
    }

    const runtime = createAuroraTauriRuntime({
      runtimeProfileDocument: fullDocument,
      packageCapabilities: createTauriPackageCapabilities({
        source: 'test',
        runtimeMode: 'desktop-local',
        includesPython: true,
      }),
      consumeThinInvite: false,
    })

    expect(runtime.mode).toBe('desktop-local')
    expect(runtime.runtimeTier).toBe('python-full')
    expect(runtime.nodeMode).toBe('mesh-node')
    await runtime.dispose()
  })

  it('rejects spoofed env-only package capability for python-full profiles', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    vi.stubEnv('VITE_AURORA_PACKAGE_INCLUDES_PYTHON', '1')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const fullDocument: AuroraRuntimeProfileDocument = {
      ...runtimeDocument,
      profiles: [{
        ...runtimeDocument.profiles[0]!,
        runtimeTier: 'python-full',
      }],
    }

    expect(() => createAuroraTauriRuntime({
      runtimeProfileDocument: fullDocument,
      consumeThinInvite: false,
    })).toThrow(/bundled Python/)
  })

  it('does not classify a v1 store as runtime storage from human evidence text', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const save = vi.fn(async () => undefined)
    const store = {
      evidence: 'test runtime profile wording from a v1 store',
      load: vi.fn(async () => document),
      save,
    }

    const runtime = await bootstrapAuroraTauriRuntime(store)
    const next = await runtime.thinProfileController!.saveProfile({
      ...profile,
      id: 'second-office',
      label: 'Second office',
    })

    expect(next.version).toBe(1)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      activeProfileId: 'second-office',
    }))
    await runtime.dispose()
  })

  it('preserves mesh-only v2 profiles across sequential controller saves and runtime recreation', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-local')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const meshOnly = {
      ...runtimeDocument.profiles[0]!,
      id: 'mesh-only',
      homeConnection: undefined,
    }
    const remote = {
      version: 2 as const,
      id: 'remote',
      label: 'Remote',
      nodeMode: 'remote-console' as const,
      runtimeTier: 'none' as const,
      homeConnection: {
        mode: 'http-only' as const,
        gatewayUrl: 'https://gateway.example.invalid',
      },
      localNode: {
        nodeName: 'Aurora desktop',
        stablePeerId: 'desktop-peer-remote',
        enabledCapabilityPacks: [],
      },
    }
    const initial: AuroraRuntimeProfileDocument = {
      version: 2,
      activeProfileId: 'remote',
      profiles: [meshOnly, remote],
    }
    let saved = initial
    const store: AuroraRuntimeProfileStore = {
      kind: 'runtime-profile',
      evidence: 'test runtime store',
      load: vi.fn(async () => saved),
      save: vi.fn(async (next) => { saved = next }),
    }

    const runtime = createAuroraTauriRuntime({
      runtimeProfileStore: store,
      runtimeProfileDocument: initial,
      consumeThinInvite: false,
    })
    await runtime.thinProfileController!.saveProfile({
      ...profile,
      id: 'second-remote',
      label: 'Second remote',
    })
    await runtime.thinProfileController!.selectProfile('mesh-only')
    const recreated = runtime.thinProfileController!.createRuntime(runtime.thinProfileController!.document)

    expect(saved.profiles.map((candidate) => candidate.id).sort()).toEqual([
      'mesh-only',
      'remote',
      'second-remote',
    ])
    expect(recreated.runtimeProfile).toMatchObject({
      id: 'mesh-only',
      nodeMode: 'mesh-node',
    })
    expect(recreated.thinProfile).toMatchObject({
      id: 'mesh-only',
      mode: 'webrtc-only',
    })
    await runtime.dispose()
    await recreated.dispose()
  })

  it('restores a v2 runtime role from the nonsecret store on restart', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const store = createMemoryRuntimeProfileStore(runtimeDocument)

    const first = await bootstrapAuroraTauriRuntime(store)
    await first.thinProfileController!.selectProfile(runtimeDocument.activeProfileId!)
    await first.dispose()
    const restarted = await bootstrapAuroraTauriRuntime(store)

    expect(restarted.runtimeProfile).toMatchObject({
      id: 'runtime-office',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })
    expect(restarted.mode).toBe('desktop-thin')
    await restarted.dispose()
  })

  it('preserves a packaged desktop-thin fragment invite until async profile bootstrap owns it', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    vi.stubEnv('VITE_AURORA_CONNECTION_MODE', 'webrtc-only')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const inviteText = encodeMeshInviteToken({
      kind: 'aurora.mesh.invite',
      generated_at: '2026-07-26T00:00:00.000Z',
      node: { peer_id: 'peer-host', node_name: 'Aurora host' },
      signaling: {
        provider: 'mqtt',
        room: 'tauri-room',
        room_password: 'tauri-secret',
        app_id: 'aurora',
        mqtt_brokers: ['wss://broker.example/mqtt'],
      },
      webrtc: { app_layer_e2ee: true, stun_servers: ['stun:stun.example:3478'] },
    })
    window.history.replaceState({}, '', `/mesh#invite=${encodeURIComponent(inviteText)}&panel=mesh`)
    let release!: (value: AuroraThinProfileDocument) => void
    const load = vi.fn(() => new Promise<AuroraThinProfileDocument>((resolve) => {
      release = resolve
    }))
    const store = {
      evidence: 'test nonsecret store',
      load,
      save: vi.fn(async () => undefined),
    }

    const initial = createInitialAuroraTauriRuntime()
    let initialClosed = false
    const originalDispose = initial.dispose
    initial.dispose = async () => {
      initialClosed = true
      await originalDispose()
    }

    expect(initial.mode).toBe('desktop-thin')
    expect(initial.thinDiagnostics().join(' ')).not.toContain('tauri-room')
    expect(window.location.hash).toContain('invite=')

    const pending = bootstrapAuroraTauriRuntime(store)
    expect(load).toHaveBeenCalledOnce()
    expect(window.location.hash).not.toContain('invite=')
    expect(window.location.hash).toContain('panel=mesh')
    release(document)
    const finalRuntime = await pending
    await initial.dispose()

    expect(finalRuntime).not.toBe(initial)
    expect(initialClosed).toBe(true)
    expect(finalRuntime.mode).toBe('desktop-thin')
    expect(finalRuntime.thinDiagnostics().join(' ')).toContain('invite room=tauri-room')

    const secondRuntime = createAuroraTauriRuntime({
      thinProfileStore: store,
      thinProfileDocument: document,
    })
    expect(secondRuntime.thinDiagnostics().join(' ')).not.toContain('tauri-room')
    await finalRuntime.dispose()
    await secondRuntime.dispose()
  })


  it('serializes only the nonsecret allowlisted profile fields', () => {
    const tainted = {
      ...profile,
      bearerToken: 'must-not-persist',
      invite: 'must-not-persist',
      roomSecret: 'must-not-persist',
    } as AuroraThinConnectionProfile

    const serialized = serializeThinProfileDocument({
      ...document,
      profiles: [tainted],
    })

    expect(serialized).not.toContain('must-not-persist')
    expect(serialized).not.toMatch(/bearerToken|invite|\"roomSecret\"\s*:/)
    expect(parseThinProfileDocument(serialized)).toEqual(document)
  })

  it('preserves runtime endpoint query strings without treating them as credential storage', () => {
    const serialized = serializeThinProfileDocument({
      ...document,
      profiles: [
        {
          ...profile,
          gatewayUrl:
            'https://gateway.example.invalid/tenant?region=local',
        },
      ],
    })

    expect(serialized).toContain('region=local')
    expect(serialized).not.toContain('access_token')
  })

  it('rejects persisted endpoint URL fragments', () => {
    expect(() =>
      serializeThinProfileDocument({
        ...document,
        profiles: [
          {
            ...profile,
            signalingUrl: 'wss://signaling.example.invalid#invite-secret',
          },
        ],
      }),
    ).toThrow(/URL fragments/)
  })

  it('requires WebSocket schemes for persisted WebRTC signaling endpoints', () => {
    expect(() =>
      serializeThinProfileDocument({
        ...document,
        profiles: [
          {
            ...profile,
            signalingUrl: 'https://signaling.example.invalid',
          },
        ],
      }),
    ).toThrow(/ws:\/wss:/i)
  })

  it('rejects credential material in endpoint authority before persistence', () => {
    for (const gatewayUrl of [
      'https://user:password@gateway.example.invalid',
    ]) {
      expect(() =>
        serializeThinProfileDocument({
          ...document,
          profiles: [{ ...profile, gatewayUrl }],
        }),
      ).toThrow(/embedded credentials/)
    }
  })


  it('saves and switches by closing the old runtime before reconstruction', async () => {
    const order: string[] = []
    const nextRuntime = { mode: 'desktop-thin' } as AuroraTauriRuntime
    const controller = {
      evidence: 'test',
      document,
      saveProfile: vi.fn(async () => document),
      selectProfile: vi.fn(async () => document),
      createRuntime: vi.fn(() => {
        order.push('create')
        return nextRuntime
      }),
    }
    const runtime = {
      thinProfileController: controller,
      dispose: vi.fn(async () => {
        order.push('dispose')
      }),
    } as unknown as AuroraTauriRuntime

    const rebuilt = await rebuildAuroraThinRuntime(runtime, (active) =>
      active.selectProfile(profile.id),
    )

    expect(rebuilt).toBe(nextRuntime)
    expect(controller.selectProfile).toHaveBeenCalledWith(profile.id)
    expect(order).toEqual(['dispose', 'create'])
  })

  it('resolves HTTP authorization from the current SDK session on every request', async () => {
    const headers: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    const httpProfile = { ...profile, mode: 'http-only' as const }
    const runtime = createAuroraTauriRuntime({
      thinProfileStore: createMemoryThinProfileStore({
        ...document,
        profiles: [httpProfile],
      }),
      thinProfileDocument: { ...document, profiles: [httpProfile] },
    })

    runtime.client.auth.setBearerToken('session-one')
    await runtime.client.request('Gateway.Health', undefined, {
      path: '/api/health',
      httpMethod: 'GET',
    })
    runtime.client.auth.setBearerToken('session-two')
    await runtime.client.request('Gateway.Health', undefined, {
      path: '/api/health',
      httpMethod: 'GET',
    })

    expect(headers).toEqual(['Bearer session-one', 'Bearer session-two'])
    await runtime.dispose()
  })

  it('keeps browser preview profiles memory-only and avoids the native credential backend', async () => {
    const store = createMemoryThinProfileStore(document)
    const loaded = await store.load()
    const runtime = createAuroraTauriRuntime({
      thinProfileStore: store,
      thinProfileDocument: loaded,
    })

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.thinProfileController?.evidence).toContain('memory-only')
    expect(runtime.thinPeer?.snapshot().secretsPersisted).toBe(false)
    await runtime.dispose()
  })

  it('loads Android thin profiles asynchronously and creates a shared WebView HTTP runtime without sidecar', async () => {
    vi.stubEnv('VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK', '1')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const httpProfile = {
      ...profile,
      mode: 'http-only' as const,
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: '',
      nodeName: 'Aurora Android',
      localStablePeerId: 'android-peer-01',
    }
    const androidDocument = { ...document, profiles: [httpProfile] }
    let release!: (value: AuroraThinProfileDocument) => void
    const store = {
      evidence: 'android nonsecret profile store',
      load: vi.fn(() => new Promise<AuroraThinProfileDocument>((resolve) => {
        release = resolve
      })),
      save: vi.fn(async () => undefined),
    }

    const initial = createInitialAuroraTauriRuntime()
    expect(initial.mode).toBe('mobile-native')
    expect(initial.thinDiagnostics().join(' ')).not.toContain('tauri-room')

    const pending = bootstrapAuroraTauriRuntime(store)
    expect(store.load).toHaveBeenCalledOnce()
    release(androidDocument)
    const runtime = await pending

    expect(runtime.mode).toBe('mobile-native')
    expect(runtime.thinConnectionMode).toBe('http-only')
    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.thinPeer).toBeDefined()
    expect(runtime.thinPeer?.snapshot().secretsPersisted).toBe(false)
    expect(runtime.thinDiagnostics().join(' ')).toContain('mode=http-only')
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.startSidecar()).resolves.toBeNull()
    await expect(runtime.stopSidecar()).resolves.toBeNull()
    await runtime.dispose()
    await initial.dispose()
  })

  it('uses runtime-configured desktop-thin endpoints without enabling sidecar ownership', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'desktop-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) Aurora Desktop',
      configurable: true,
    })
    const runtimeProfile: AuroraThinConnectionProfile = {
      ...profile,
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://gateway.operator.example/api?site=studio',
      signalingUrl: 'wss://signal.operator.example/mqtt?site=studio',
      webrtcProfile: {
        ...profile.webrtcProfile!,
        mode: 'webrtc-preferred',
        signalingBrokers: ['wss://signal.operator.example/mqtt?site=studio'],
      },
    }

    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: {
        version: 1,
        activeProfileId: runtimeProfile.id,
        profiles: [runtimeProfile],
      },
    })

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.thinConnectionMode).toBe('webrtc-preferred')
    expect(runtime.thinProfile).toMatchObject({
      gatewayUrl: 'https://gateway.operator.example/api?site=studio',
      signalingUrl: 'wss://signal.operator.example/mqtt?site=studio',
    })
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.thinPeer?.snapshot().hasHttpFallback).toBe(true)
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.startSidecar()).resolves.toBeNull()
    await expect(runtime.stopSidecar()).resolves.toBeNull()
    await runtime.dispose()
  })

  it('classifies a packaged iOS-thin build without relying on the WebView user agent', async () => {
    vi.stubEnv('VITE_AURORA_RUNTIME_MODE', 'ios-thin')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 15) conflicting-test-agent',
      configurable: true,
    })

    const iosProfile: AuroraThinConnectionProfile = {
      ...profile,
      label: 'iOS thin',
      nodeName: 'Aurora iOS thin',
      localStablePeerId: 'aurora-ios-thin',
    }
    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: {
        version: 1,
        activeProfileId: iosProfile.id,
        profiles: [iosProfile],
      },
    })

    expect(runtime.mode).toBe('mobile-native')
    expect(runtime.thinConnectionMode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.thinProfile).toMatchObject({
      label: 'iOS thin',
      nodeName: 'Aurora iOS thin',
      localStablePeerId: 'aurora-ios-thin',
    })
    expect(runtime.modePreferenceStore?.evidence).toContain('ios thin mode preference')
    expect(runtime.thinDiagnostics().join(' ')).toContain('mode=webrtc-preferred')
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.startSidecar()).resolves.toBeNull()
    await expect(runtime.stopSidecar()).resolves.toBeNull()
    await expect(runtime.androidForegroundStatus()).resolves.toBeNull()
    await runtime.dispose()
  })

  it('creates Android WebRTC-only and WebRTC-preferred runtimes with fragment invite scrubbed once', async () => {
    vi.stubEnv('VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK', '1')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const inviteText = encodeMeshInviteToken({
      kind: 'aurora.mesh.invite',
      generated_at: '2026-07-26T00:00:00.000Z',
      node: { peer_id: 'peer-host', node_name: 'Aurora host' },
      signaling: {
        provider: 'mqtt',
        room: 'android-room',
        room_password: 'android-secret',
        app_id: 'aurora',
        mqtt_brokers: ['wss://broker.example/mqtt'],
      },
      webrtc: { app_layer_e2ee: true, stun_servers: ['stun:stun.example:3478'] },
    })
    window.history.replaceState({}, '', `/mesh#invite=${encodeURIComponent(inviteText)}&panel=mesh`)
    const webrtcOnly = { ...profile, mode: 'webrtc-only' as const, gatewayUrl: '', signalingUrl: 'wss://signaling.example.invalid', nodeName: 'Aurora Android', localStablePeerId: 'android-peer-01' }
    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: { ...document, profiles: [webrtcOnly] },
    })

    expect(runtime.mode).toBe('mobile-native')
    expect(runtime.thinConnectionMode).toBe('webrtc-only')
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.thinPeer?.snapshot()).toMatchObject({ hasHttpFallback: false, secretsPersisted: false })
    expect(runtime.thinDiagnostics().join(' ')).toContain('invite room=android-room')
    expect(window.location.hash).not.toContain('invite=')
    expect(window.location.hash).toContain('panel=mesh')

    window.history.replaceState({}, '', `/mesh#invite=${encodeURIComponent(inviteText)}`)
    const secondRuntime = createAuroraTauriRuntime({
      thinProfileDocument: { ...document, profiles: [{ ...webrtcOnly, mode: 'webrtc-preferred' as const, gatewayUrl: 'https://gateway.example.invalid' }] },
    })
    expect(secondRuntime.thinConnectionMode).toBe('webrtc-preferred')
    expect(secondRuntime.thinPeer?.snapshot().hasHttpFallback).toBe(true)
    expect(secondRuntime.thinDiagnostics().join(' ')).toContain('invite room=android-room')
    expect(window.location.hash).not.toContain('invite=')
    await runtime.dispose()
    await secondRuntime.dispose()
  })

  it('resolves Android thin HTTP authorization from the current SDK session', async () => {
    const headers: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const httpProfile = { ...profile, mode: 'http-only' as const, gatewayUrl: 'https://gateway.example.invalid', signalingUrl: '', nodeName: 'Aurora Android', localStablePeerId: 'android-peer-01' }
    const runtime = createAuroraTauriRuntime({
      thinProfileDocument: { ...document, profiles: [httpProfile] },
    })

    runtime.client.auth.setBearerToken('android-session-one')
    await runtime.client.request('Gateway.Health', undefined, { path: '/api/health', httpMethod: 'GET' })
    runtime.client.auth.setBearerToken('android-session-two')
    await runtime.client.request('Gateway.Health', undefined, { path: '/api/health', httpMethod: 'GET' })

    expect(headers).toEqual(['Bearer android-session-one', 'Bearer android-session-two'])
    await runtime.dispose()
  })


  it('registers Android lifecycle through the native plugin listener and releases focused media without disconnecting the peer', async () => {
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const runtime = fakeAndroidThinRuntime('webrtc-only')
    const releaseFocusedMedia = vi.fn()
    window.addEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedMedia)

    const release = installAndroidLifecyclePolicy(runtime)
    await Promise.resolve()

    expect(tauriCoreMock.addPluginListener).toHaveBeenCalledWith(
      ANDROID_NATIVE_PLUGIN_NAME,
      ANDROID_LIFECYCLE_EVENT,
      expect.any(Function),
    )
    expect(tauriCoreMock.addPluginListener).not.toHaveBeenCalledWith(
      'event',
      ANDROID_LIFECYCLE_EVENT,
      expect.any(Function),
    )

    tauriCoreMock.pluginListeners[0]!.callback({ phase: 'pause', foreground: false, focused: false, mustReleaseMicrophone: true, backgroundWakeword: false })
    tauriCoreMock.pluginListeners[0]!.callback({ phase: 'stop', foreground: false, focused: false, mustReleaseMicrophone: true, backgroundWakeword: false })
    expect(releaseFocusedMedia).toHaveBeenCalledTimes(2)
    expect(runtime.calls.disconnect).toEqual([])

    await release()
    window.removeEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedMedia)
    expect(tauriCoreMock.pluginListeners[0]!.unregister).toHaveBeenCalledOnce()
  })

  it('keeps the Android WebRTC peer connected across background and resume lifecycle payloads', async () => {
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const runtime = fakeAndroidThinRuntime('webrtc-only')
    const firstProfile = webRtcProfile('android-room')

    const release = installAndroidLifecyclePolicy(runtime)
    await Promise.resolve()
    await runtime.peer.connect(firstProfile)
    tauriCoreMock.pluginListeners[0]!.callback({ foreground: false, focused: false, mustReleaseMicrophone: true, backgroundWakeword: false })
    tauriCoreMock.pluginListeners[0]!.callback({ foreground: true, focused: true, mustReleaseMicrophone: false, backgroundWakeword: false })
    await Promise.resolve()

    expect(runtime.calls.disconnect).toEqual([])
    expect(runtime.calls.connect).toEqual([firstProfile])
    await release()
  })

  it('does not auto-connect Android WebRTC on resume without a prior explicit route', async () => {
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const runtime = fakeAndroidThinRuntime('webrtc-only')

    const release = installAndroidLifecyclePolicy(runtime)
    await Promise.resolve()
    tauriCoreMock.pluginListeners[0]!.callback({ foreground: true, focused: true, mustReleaseMicrophone: false, backgroundWakeword: false })
    await Promise.resolve()

    expect(runtime.calls.connect).toEqual([])
    await release()
  })

  it('removes Android lifecycle listeners before later payloads can release focused media', async () => {
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15) Aurora', configurable: true })
    const runtime = fakeAndroidThinRuntime('webrtc-only')
    const releaseFocusedMedia = vi.fn()
    window.addEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedMedia)

    const release = installAndroidLifecyclePolicy(runtime)
    await Promise.resolve()
    await release()
    expect(tauriCoreMock.pluginListeners[0]!.unregister).toHaveBeenCalledOnce()
    tauriCoreMock.pluginListeners[0]!.callback({ foreground: false, focused: false, mustReleaseMicrophone: true, backgroundWakeword: false })
    expect(releaseFocusedMedia).not.toHaveBeenCalled()
    window.removeEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedMedia)
  })


  it('wraps native thin peer credential commands in the Rust request argument shape', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoker = createTauriPeerCredentialCommandInvoker((async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      const request = args?.request as Record<string, unknown>
      if (command === 'aurora_thin_peer_credential_set') {
        return {
          peerId: request.peerId,
          found: true,
          hasBearerToken: true,
          persisted: true,
          secretsRedacted: true,
          redactedFields: ['rawBearerToken'],
          credential: {
            tokenId: request.tokenId,
            claimantPeerId: request.claimantPeerId,
            verifierPeerId: request.verifierPeerId,
            claimantSignalingPeerId: request.claimantSignalingPeerId,
            verifierSignalingPeerId: request.verifierSignalingPeerId,
            roomName: request.roomName,
          },
        }
      }
      if (command === 'aurora_thin_peer_credential_status') {
        return { peerId: request.peerId, found: true, hasBearerToken: true, persisted: true, secretsRedacted: true, redactedFields: ['rawBearerToken'] }
      }
      if (command === 'aurora_thin_peer_reconnect_prove') {
        const challenge = request.challenge as MeshReconnectChallengeMessage
        return {
          peerId: request.peerId,
          found: true,
          matched: true,
          secretsRedacted: true,
          redactedFields: ['rawBearerToken'],
          proof: {
            type: 'mesh_auth_proof_v1',
            token_id: 'token-fixture',
            proof: 'a'.repeat(64),
            challenge: challenge.challenge,
            channel_binding: challenge.channel_binding,
            claimant_peer_id: challenge.claimant_peer_id,
            verifier_peer_id: challenge.verifier_peer_id,
            claimant_signaling_peer_id: challenge.claimant_signaling_peer_id,
            verifier_signaling_peer_id: challenge.verifier_signaling_peer_id,
            room_name: challenge.room_name,
          },
        }
      }
      return { peerId: request.peerId, found: false, persisted: true, secretsRedacted: true, redactedFields: ['rawBearerToken'] }
    }) as any)
    const store = new NativePeerCredentialStore({ invoke: invoker })
    const credential = {
      tokenId: 'token-fixture',
      claimantPeerId: 'android-peer',
      verifierPeerId: 'host-peer',
      claimantSignalingPeerId: 'android-signal',
      verifierSignalingPeerId: 'host-signal',
      roomName: 'android-room',
      rawBearerToken: 'raw-token-secret',
    }
    const challenge: MeshReconnectChallengeMessage = {
      type: 'mesh_auth_challenge_v1',
      challenge: 'b'.repeat(64),
      channel_binding: 'c'.repeat(64),
      claimant_peer_id: 'android-peer',
      verifier_peer_id: 'host-peer',
      claimant_signaling_peer_id: 'android-signal',
      verifier_signaling_peer_id: 'host-signal',
      room_name: 'android-room',
    }

    await store.save('android-peer', credential)
    await store.status('android-peer')
    const proof = await store.prove('android-peer', challenge)
    await store.remove('android-peer')

    expect(calls.map((call) => call.command)).toEqual([
      'aurora_thin_peer_credential_set',
      'aurora_thin_peer_credential_status',
      'aurora_thin_peer_credential_status',
      'aurora_thin_peer_reconnect_prove',
      'aurora_thin_peer_credential_delete',
    ])
    expect(calls.every((call) => call.args && 'request' in call.args)).toBe(true)
    expect(calls[0]?.args?.request).toMatchObject({ peerId: 'android-peer', rawBearerToken: 'raw-token-secret' })
    expect(proof).toMatchObject({
      type: 'mesh_auth_proof_v1',
      token_id: 'token-fixture',
      channel_binding: 'c'.repeat(64),
      claimant_peer_id: 'android-peer',
      room_name: 'android-room',
    })
  })

})
