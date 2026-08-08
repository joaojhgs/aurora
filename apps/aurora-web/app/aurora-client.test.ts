import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraError } from '@aurora/client'
import {
  BrowserMeshNodeCompositionError,
  type BrowserMeshNodeServices,
} from './browser-mesh-node-services'
import {
  auroraBrowserMeshNodeCompositionStatus,
  auroraBrowserRequiresOnboarding,
  auroraBrowserRuntimeProfile,
  auroraBrowserRuntimeProfileDocument,
  auroraBrowserThinProfileDocument,
  createAuroraBrowserClient,
  createAuroraBrowserRuntime,
  createAuroraBrowserRuntimeAsync,
  createAuroraWebClient,
  resetAuroraBrowserClientForTests,
  saveAuroraBrowserOnboardingProfile,
  saveAuroraBrowserRuntimeProfile,
  saveAuroraBrowserThinProfile,
  setAuroraBrowserMeshNodeServicesFactoryForTests,
} from './aurora-client'
import { consumeFragmentInviteFromUrl } from './mesh/mesh-client'

describe('createAuroraWebClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetAuroraBrowserClientForTests()
  })

  it('uses the SDK mock transport only in explicit test or demo mode', () => {
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })

  it('fails closed instead of using fixture data as production truth when Gateway URL is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('http')
    await expect(client.capabilities.getGraph()).rejects.toThrow('Aurora is not set up on this device. Finish setup or turn on sample data.')
  })

  it('keeps missing setup errors product-safe while preserving structured detail', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '')

    const client = createAuroraWebClient()

    try {
      await client.capabilities.getGraph()
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(AuroraError)
      expect((error as Error).message).toBe('Aurora is not set up on this device. Finish setup or turn on sample data.')
      expect((error as Error).message).not.toMatch(/thin client|HTTP Gateway|WebRTC invite/i)
      expect((error as AuroraError).detail).toEqual(expect.objectContaining({
        demo_mode: false,
        missing_connection_options: ['http_gateway', 'webrtc_invite'],
        secrets_redacted: true,
        repair_action: 'finish_setup_or_enable_sample_data',
      }))
    }
  })

  it('requires explicit demo opt-in for fixture-backed web mode outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '1')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })
})

describe('createAuroraBrowserClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetAuroraBrowserClientForTests()
  })

  it('keeps one browser client identity and authorizes Gateway calls with an in-memory login token only', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/Login')) {
        return jsonResponse({
          token: 'login-token',
          user_id: 'user-1',
          username: 'Ada',
          permissions: ['Gateway.use']
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const login = await client.authApi.login({ username: 'ada', password: 'secret' })
    const sameClient = createAuroraBrowserClient()
    await sameClient.registry.getRegistry()

    expect(login.ok).toBe(true)
    expect(sameClient).toBe(client)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'user', isAuthenticated: true }))
    client.auth.clear()
    await sameClient.registry.getRegistry()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.headers.Authorization).toBeUndefined()
    expect(calls[1]?.headers.Authorization).toBe('Bearer login-token')
    expect(calls[2]?.headers.Authorization).toBeUndefined()
    expectStorageHasNoSecrets(storage, ['login-token', 'secret'])
  })

  it('uses a validated manual token for later Gateway calls without browser storage', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/ValidateToken')) {
        return jsonResponse({
          valid: true,
          principal_id: 'user-2',
          principal_name: 'Grace',
          permissions: ['Gateway.use'],
          source: 'http_bearer'
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const validation = await client.authApi.validateToken({ token: 'manual-token' })
    await client.registry.getRegistry()

    expect(validation.ok).toBe(true)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'user', principalId: 'user-2' }))
    expect(calls[1]?.headers.Authorization).toBe('Bearer manual-token')
    expectStorageHasNoSecrets(storage, ['manual-token'])
  })

  it('does not bootstrap WebRTC invites from public env or persistent URL state', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_CONNECTION_MODE', 'webrtc-only')
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'https://aurora.example')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_INVITE', 'room_password=do-not-read')
    installBrowserStorage()
    const runtime = createAuroraBrowserRuntime()

    expect(auroraBrowserRequiresOnboarding()).toBe(true)
    expect(runtime.peer.snapshot().diagnostic ?? '').not.toContain('do-not-read')
  })

  it('uses the WebRTC rollout kill switch to keep hosted preferred mode on HTTP', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT', '0')
    installBrowserStorage()
    await saveAuroraBrowserThinProfile({
      id: 'preferred',
      label: 'Preferred',
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://aurora.example',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora Web',
      localStablePeerId: 'aurora-web-test-peer',
      webrtcProfile: {
        mode: 'webrtc-preferred',
        appId: 'aurora',
        room: 'office',
        roomSecretRef: 'ref:browser:office',
        signalingBrokers: ['wss://signaling.example.invalid'],
        nodeName: 'Aurora Web',
      },
    })

    const runtime = createAuroraBrowserRuntime()

    expect(runtime.mode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
    })
  })

  it('maps the three lightweight rollout kill switches into a fail-closed runtime', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_MESH_NODE_RUNTIME_V1', '0')
    vi.stubEnv('NEXT_PUBLIC_AURORA_LOCAL_TOOL_PROVIDER_V1', '0')
    vi.stubEnv('NEXT_PUBLIC_AURORA_LIGHTWEIGHT_ORCHESTRATOR_V1', '0')
    installBrowserStorage()
    await saveAuroraBrowserOnboardingProfile({
      id: 'mesh-rollout',
      label: 'Mesh rollout',
      mode: 'webrtc-only',
      gatewayUrl: '',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Hosted browser',
      localStablePeerId: 'aurora-web-rollout-peer',
      webrtcProfile: {
        mode: 'webrtc-only',
        appId: 'aurora',
        room: 'mesh-rollout',
        roomSecretRef: 'ref:browser:mesh-rollout',
        signalingBrokers: ['wss://signaling.example.invalid'],
      },
    }, 'make-this-device-available', {
      roomSecretRef: 'ref:browser:mesh-rollout',
      roomSecret: 'mesh-rollout-secret',
    })

    const runtime = createAuroraBrowserRuntime()

    expect(runtime.features).toEqual({
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
      usesBrowserVoiceRuntime: true,
      focusedPushToTalkOwner: 'webview-focused',
      wakewordOwner: 'webview-focused',
    })
    expect(runtime.peer.snapshot().protocolCapabilities).not.toContain('hybrid')
    await runtime.close()
  })

  it('loads and saves v2 runtime profiles as the hosted browser composition source', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT', '0')
    const storage = installBrowserStorage()
    await saveAuroraBrowserRuntimeProfile({
      version: 2,
      id: 'runtime-home',
      label: 'Runtime home',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      homeConnection: {
        mode: 'webrtc-preferred',
        gatewayUrl: 'https://aurora.example',
        signalingUrl: 'wss://signaling.example.invalid',
        homePeerId: 'home-peer',
        webrtcProfile: {
          mode: 'webrtc-preferred',
          appId: 'aurora',
          room: 'office',
          roomSecretRef: 'ref:browser:office',
          signalingBrokers: ['wss://signaling.example.invalid'],
          expectedStablePeerId: 'home-peer',
          nodeName: 'Home Aurora',
        },
      },
      localNode: {
        nodeName: 'Hosted browser',
        stablePeerId: 'aurora-web-runtime-peer',
        enabledCapabilityPacks: ['local-tools'],
        meshMembership: {
          signalingUrl: 'wss://signaling.example.invalid',
          webrtcProfile: {
            mode: 'webrtc-only',
            appId: 'aurora',
            room: 'office',
            roomSecretRef: 'ref:browser:office',
            signalingBrokers: ['wss://signaling.example.invalid'],
          },
        },
      },
    })

    const runtime = createAuroraBrowserRuntime()

    expect(runtime.mode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('http')
    expect(auroraBrowserRuntimeProfile()).toMatchObject({
      id: 'runtime-home',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })
    expect(auroraBrowserRuntimeProfileDocument()).toMatchObject({
      version: 2,
      activeProfileId: 'runtime-home',
    })
    expectStorageHasNoSecrets(storage, ['room-secret', 'rawBearerToken'])
    expect(JSON.stringify(storage.dump())).toContain('aurora.runtimeProfiles.v2')
    expect(JSON.stringify(storage.dump())).not.toContain('aurora.webThin.connectionProfiles.v1')
  })

  it('persists mesh-node onboarding selection as v2 and restores it after restart', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT', '0')
    const storage = installBrowserStorage()
    await saveAuroraBrowserOnboardingProfile({
      id: 'mesh-onboarding',
      label: 'Mesh onboarding',
      mode: 'webrtc-only',
      gatewayUrl: '',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Hosted browser',
      localStablePeerId: 'aurora-web-mesh-peer',
      webrtcProfile: {
        mode: 'webrtc-only',
        appId: 'aurora',
        room: 'mesh-office',
        roomSecretRef: 'ref:browser:mesh-office',
        signalingBrokers: ['wss://signaling.example.invalid'],
      },
    }, 'make-this-device-available', {
      roomSecretRef: 'ref:browser:mesh-office',
      roomSecret: 'mesh-room-secret',
    })

    resetAuroraBrowserClientForTests()
    const runtime = createAuroraBrowserRuntime()

    expect(runtime.mode).toBe('webrtc-only')
    expect(auroraBrowserRequiresOnboarding()).toBe(false)
    const restoredProfile = auroraBrowserRuntimeProfile()
    expect(restoredProfile?.homeConnection).toBeUndefined()
    expect(restoredProfile).toMatchObject({
      id: 'mesh-onboarding',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      localNode: {
        stablePeerId: 'aurora-web-mesh-peer',
        enabledCapabilityPacks: ['native-actions'],
        meshMembership: {
          signalingUrl: 'wss://signaling.example.invalid',
        },
      },
    })
    const serialized = JSON.stringify(storage.dump())
    expect(serialized).toContain('aurora.runtimeProfiles.v2')
    expect(serialized).not.toContain('mesh-room-secret')
    expect(serialized).not.toContain('aurora.webThin.connectionProfiles.v1')
  })

  it('activates mesh-node runtime from saved onboarding when composition gates are ready', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    await saveMeshOnboardingProfile('mesh-ready')
    const closeServices = vi.fn(async () => undefined)
    const services = fakeMeshNodeServices(closeServices)
    const factory = vi.fn(async () => services)
    setAuroraBrowserMeshNodeServicesFactoryForTests(factory)

    const runtime = await createAuroraBrowserRuntimeAsync()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(auroraBrowserRuntimeProfile()?.localNode.enabledCapabilityPacks).toEqual(['native-actions'])
    expect(runtime.features).toMatchObject({
      requestedNodeRole: 'mesh-node',
      activeNodeRole: 'mesh-node',
      meshNodeRuntimeEnabled: true,
      localToolProviderEnabled: true,
      lightweightOrchestratorEnabled: true,
    })
    expect(runtime.localData).toEqual({
      session: services.session,
      backend: services.backend,
      crypto: services.crypto,
    })
    expect(runtime.localFeatureSharing).toBe(services.localFeatureSharing)
    expect(runtime.localToolProvider).toBe(services.provider)
    expect(runtime.localAssistant).toBeUndefined()
    expect(runtime.localNodeProviderStatus).toEqual({
      available: true,
      state: 'available',
      productMessage: 'This device is available for sharing.',
      registeredFeatureCount: 1,
      localDataWritable: true,
    })
    expect(auroraBrowserMeshNodeCompositionStatus()).toMatchObject({ state: 'ready' })
    await runtime.close()
    expect(closeServices).toHaveBeenCalledTimes(1)
  })

  it('attaches an explicitly injected on-device provider only while the rollout is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    await saveMeshOnboardingProfile('mesh-assistant-ready')
    const services = fakeMeshNodeServices(vi.fn(async () => undefined))
    setAuroraBrowserMeshNodeServicesFactoryForTests(vi.fn(async () => services))
    const provider = {
      complete: vi.fn(async () => ({ type: 'message' as const, content: 'Ready here.' })),
    }

    const runtime = await createAuroraBrowserRuntimeAsync({
      localAssistant: { provider, remoteTools: [] },
    })

    expect(runtime.features.lightweightOrchestratorEnabled).toBe(true)
    expect(runtime.localAssistant).toEqual({ provider, remoteTools: [] })
    await runtime.close()
  })

  it('coalesces async mesh composition and closes cached services exactly once', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    await saveMeshOnboardingProfile('mesh-concurrent')
    const closeServices = vi.fn(async () => undefined)
    const services = fakeMeshNodeServices(closeServices)
    let resolveServices!: (value: BrowserMeshNodeServices) => void
    const factory = vi.fn(() => new Promise<BrowserMeshNodeServices>((resolve) => {
      resolveServices = resolve
    }))
    setAuroraBrowserMeshNodeServicesFactoryForTests(factory)

    const first = createAuroraBrowserRuntimeAsync()
    const second = createAuroraBrowserRuntimeAsync()
    expect(factory).toHaveBeenCalledTimes(1)
    resolveServices(services)
    const [firstRuntime, secondRuntime] = await Promise.all([first, second])

    expect(firstRuntime).toBe(secondRuntime)
    await firstRuntime.close()
    await secondRuntime.close()
    expect(closeServices).toHaveBeenCalledTimes(1)

    const nextServices = fakeMeshNodeServices(vi.fn(async () => undefined))
    factory.mockResolvedValueOnce(nextServices)
    const nextRuntime = await createAuroraBrowserRuntimeAsync()
    expect(nextRuntime).not.toBe(firstRuntime)
    expect(factory).toHaveBeenCalledTimes(2)
    await nextRuntime.close()
  })

  it('retries mesh composition when profile saving races an in-flight runtime build', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveMeshOnboardingProfile('mesh-race-a')
    const closeFirstServices = vi.fn(async () => undefined)
    const firstServices = fakeMeshNodeServices(closeFirstServices)
    const secondServices = fakeMeshNodeServices(vi.fn(async () => undefined))
    let resolveFirstServices!: (value: BrowserMeshNodeServices) => void
    const factory = vi
      .fn<() => Promise<BrowserMeshNodeServices>>()
      .mockImplementationOnce(
        () =>
          new Promise<BrowserMeshNodeServices>((resolve) => {
            resolveFirstServices = resolve
          }),
      )
      .mockResolvedValueOnce(secondServices)
    setAuroraBrowserMeshNodeServicesFactoryForTests(factory)

    const runtimePromise = createAuroraBrowserRuntimeAsync()
    const savePromise = saveMeshOnboardingProfile('mesh-race-b')
    resolveFirstServices(firstServices)
    await savePromise
    const runtime = await runtimePromise

    expect(factory).toHaveBeenCalledTimes(2)
    expect(closeFirstServices).toHaveBeenCalledOnce()
    expect(auroraBrowserRuntimeProfile()?.id).toBe('mesh-race-b')
    expect(runtime.localData?.session).toBe(secondServices.session)
    expect(JSON.stringify(storage.dump())).not.toContain('mesh-race-b-secret')
    await runtime.close()
  })

  it('keeps a second tab out of provider mode when another tab owns local data', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    await saveMeshOnboardingProfile('mesh-owned-elsewhere')
    setAuroraBrowserMeshNodeServicesFactoryForTests(
      vi.fn(async () => {
        throw new BrowserMeshNodeCompositionError(
          'local_data_owned_elsewhere',
          'Device sharing is already owned by another tab',
          'This device is already available from another open tab.',
        )
      }),
    )

    const runtime = await createAuroraBrowserRuntimeAsync()

    expect(runtime.features).toMatchObject({
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      localToolProviderEnabled: false,
    })
    expect(runtime.localData).toBeUndefined()
    expect(runtime.localFeatureSharing).toBeUndefined()
    expect(runtime.localNodeProviderStatus).toEqual({
      available: false,
      state: 'open-in-another-tab',
      productMessage: 'This device is already available from another open tab.',
      registeredFeatureCount: 0,
      localDataWritable: false,
    })
    await runtime.close()
  })

  it('returns an empty v1 compatibility document for a valid mesh-only v2 profile', () => {
    const storage = installBrowserStorage()
    storage.setItem('aurora.runtimeProfiles.v2', JSON.stringify({
      version: 2,
      activeProfileId: 'mesh-only',
      profiles: [{
        version: 2,
        id: 'mesh-only',
        label: 'Mesh only',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
        localNode: {
          nodeName: 'Hosted browser',
          stablePeerId: 'aurora-web-mesh-peer',
          enabledCapabilityPacks: [],
          meshMembership: {
            signalingUrl: 'wss://signaling.example.invalid',
            webrtcProfile: {
              mode: 'webrtc-only',
              appId: 'aurora',
              room: 'mesh-only',
              roomSecretRef: 'ref:browser:mesh-only',
              signalingBrokers: ['wss://signaling.example.invalid'],
            },
          },
        },
      }],
    }))

    expect(() => createAuroraBrowserRuntime()).not.toThrow()
    expect(auroraBrowserThinProfileDocument()).toEqual({
      version: 1,
      activeProfileId: null,
      profiles: [],
    })
    expect(auroraBrowserRuntimeProfile()).toMatchObject({
      id: 'mesh-only',
      nodeMode: 'mesh-node',
    })
  })

  it('rejects a room secret that does not belong to the saved WebRTC profile', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    const profile = {
      id: 'webrtc',
      label: 'WebRTC',
      mode: 'webrtc-only' as const,
      gatewayUrl: '',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora Web',
      localStablePeerId: 'aurora-web-test-peer',
      webrtcProfile: {
        mode: 'webrtc-only' as const,
        appId: 'aurora',
        room: 'office',
        roomSecretRef: 'ref:browser:office',
        signalingBrokers: ['wss://signaling.example.invalid'],
        nodeName: 'Aurora Web',
      },
    }

    await expect(saveAuroraBrowserThinProfile(profile, {
      roomSecretRef: 'ref:browser:other-room',
      roomSecret: 'must-not-be-stored',
    })).rejects.toThrow(/does not match/)

    expect(auroraBrowserRequiresOnboarding()).toBe(true)
  })

  it('ignores query invites and only consumes scrubbed fragment invites without reload', () => {
    const testDir = dirname(fileURLToPath(import.meta.url))
    const clientSource = readFileSync(join(testDir, 'aurora-client.ts'), 'utf8')
    const meshSource = readFileSync(join(testDir, 'mesh/mesh-client.tsx'), 'utf8')
    const replacements: string[] = []

    expect(consumeFragmentInviteFromUrl('https://app.example/mesh?invite=query-secret', (url) => replacements.push(url))).toBeNull()
    expect(replacements).toEqual([])
    expect(consumeFragmentInviteFromUrl('https://app.example/mesh?view=peers#invite=fragment-secret&tab=rtc', (url) => replacements.push(url))).toBe('fragment-secret')
    expect(replacements).toEqual(['/mesh?view=peers#tab=rtc'])

    expect(clientSource).not.toContain('NEXT_PUBLIC_AURORA_WEBRTC_INVITE')
    expect(meshSource).not.toContain("searchParams.get('invite')")
    expect(meshSource).toContain('window.history.replaceState')
    expect(meshSource).not.toContain("url.searchParams.set('invite'")
    const inviteConsumerSource = meshSource.slice(meshSource.indexOf('export function consumeFragmentInviteFromUrl'))
    expect(inviteConsumerSource).not.toContain('window.location.reload')
  })

  it('uses a pairing exchange token for later Gateway calls without persisting the secret', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/PairingExchange')) {
        return jsonResponse({
          token: 'pairing-token',
          user_id: 'peer-principal-1',
          device_id: 'device-1',
          peer_id: 'peer-1',
          node_name: 'Phone',
          permissions: ['Gateway.use']
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const exchange = await client.authApi.pairingExchange({ code: 'PAIR-1234' })
    await client.registry.getRegistry()

    expect(exchange.ok).toBe(true)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'mesh_peer', peerId: 'peer-1' }))
    expect(calls[1]?.headers.Authorization).toBe('Bearer pairing-token')
    expectStorageHasNoSecrets(storage, ['pairing-token', 'PAIR-1234'])
  })
})

async function saveHttpThinProfile(gatewayUrl: string): Promise<void> {
  await saveAuroraBrowserThinProfile({
    id: 'http',
    label: 'HTTP',
    mode: 'http-only',
    gatewayUrl,
    signalingUrl: '',
    nodeName: 'Aurora Web',
    localStablePeerId: 'aurora-web-test-peer',
  })
}

async function saveMeshOnboardingProfile(id: string): Promise<void> {
  await saveAuroraBrowserOnboardingProfile({
    id,
    label: 'Mesh onboarding',
    mode: 'webrtc-only',
    gatewayUrl: '',
    signalingUrl: 'wss://signaling.example.invalid',
    nodeName: 'Hosted browser',
    localStablePeerId: `aurora-web-${id}`,
    webrtcProfile: {
      mode: 'webrtc-only',
      appId: 'aurora',
      room: id,
      roomSecretRef: `ref:browser:${id}`,
      signalingBrokers: ['wss://signaling.example.invalid'],
    },
  }, 'make-this-device-available', {
    roomSecretRef: `ref:browser:${id}`,
    roomSecret: `${id}-secret`,
  })
}

function fakeMeshNodeServices(close: () => Promise<void>): BrowserMeshNodeServices {
  return {
    enabled: true,
    peerHost: undefined,
    peerAuthorityResolver: undefined,
    peerPairingIssuer: undefined,
    peerGrantManager: {} as BrowserMeshNodeServices['peerGrantManager'],
    peerRevocationController: {} as BrowserMeshNodeServices['peerRevocationController'],
    session: {} as BrowserMeshNodeServices['session'],
    backend: { kind: 'indexeddb', persistent: true, sqlite: false } as BrowserMeshNodeServices['backend'],
    crypto: {} as BrowserMeshNodeServices['crypto'],
    provider: { enabled: true } as BrowserMeshNodeServices['provider'],
    localFeatureSharing: {} as BrowserMeshNodeServices['localFeatureSharing'],
    localToolRegistry: {} as BrowserMeshNodeServices['localToolRegistry'],
    compositionStatus: {
      state: 'ready',
      message: 'Device sharing services are ready',
      productMessage: 'This device is available for sharing.',
    },
    registeredToolIds: ['aurora.local.native.get_device_status.v1'],
    storageBackendKind: 'indexeddb',
    grantStorePersistent: true,
    close,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

function installBrowserStorage(): Storage & { dump(): Record<string, string> } {
  const values = new Map<string, string>()
  const storage: Storage & { dump(): Record<string, string> } = {
    length: 0,
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    setItem: vi.fn((key: string, value: string) => { values.set(key, String(value)) }),
    dump: () => Object.fromEntries(values),
  }
  Object.defineProperty(storage, 'length', {
    get: () => values.size,
  })
  vi.stubGlobal('window', {
    localStorage: storage,
    location: new URL('https://app.example/'),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', storage)
  return storage
}

function expectStorageHasNoSecrets(
  storage: Storage & { dump(): Record<string, string> },
  forbidden: string[],
): void {
  const encoded = JSON.stringify(storage.dump())
  for (const value of forbidden) {
    expect(encoded).not.toContain(value)
  }
}
