// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAP_CONSUMER_ONLY_V1,
  MemoryPeerCredentialStore,
  type BrowserWebRtcRuntimeOptions,
  type PeerConnectionController,
  type PeerPairingApproval,
  type PeerConnectionSnapshot,
  type WebRtcPeerConnectionProfile,
} from '@aurora/client/webrtc'
import {
  AuroraClient,
  AuroraError,
  MockAuroraTransport,
  type AuroraEventSubscription,
  type AuroraStreamRequest,
  type AuroraTransport,
  type JsonObject,
} from '@aurora/client'
import {
  BrowserWebRtcPeerController,
  WebThinConnectionPanel,
  createBrowserWebThinRuntime,
  encodeMeshInviteToken,
  explainBrowserThinRuntime,
  getAuroraSurfaceProfile,
  hostedMixedContentWarning,
  localProtocolCapabilities,
  normalizeAuroraWebRtcRolloutFlags,
  webRtcProfileFromInvite,
  type BrowserWebRtcSnapshot,
  type LocalFeatureSharingPort,
  type ThinConnectionProfile,
  type WebThinRoomSecret,
} from '../src/index'
import { LocalNodeLifecycleController } from '../src/local-node-lifecycle'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

const roots: Root[] = []
const createClient = (transport: AuroraTransport) => new AuroraClient({ transport })
const createDemoClient = () => new AuroraClient({ transport: new MockAuroraTransport() })

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser WebRTC thin-shell runtime', () => {
  it('classifies mesh/WebRTC thin transport through the centralized surface profile', () => {
    const web = getAuroraSurfaceProfile({ runtimeMode: 'web-thin', transportKind: 'mesh' })
    expect(web.kind).toBe('web')
    expect(web.isWebThin).toBe(true)
    expect(web.supportsWebRtcThin).toBe(true)
    expect(web.prefersWebRtcTransport).toBe(true)
    expect(web.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')

    const bootingWeb = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'pending',
    })
    expect(bootingWeb.kind).toBe('web')

    const desktop = getAuroraSurfaceProfile({ runtimeMode: 'desktop-thin', transportKind: 'webrtc-preferred' })
    expect(desktop.kind).toBe('desktop-thin')
    expect(desktop.supportsWebRtcThin).toBe(true)
    expect(desktop.usesLocalSidecar).toBe(false)
    expect(desktop.trustsNativeWebViewOrigin).toBe(true)
    expect(desktop.canManageLocalServiceConfiguration).toBe(false)
    expect(desktop.voiceCapture.focusedPushToTalkOwner).toBe('native-desktop')
    expect(desktop.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(desktop.voiceCapture.wakewordRequiresFocus).toBe(true)

    const local = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nodeMode: 'mesh-node',
      runtimeTier: 'python-full',
    })
    expect(local.voiceCapture.focusedPushToTalkOwner).toBe('native-desktop')
    expect(local.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(local.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(local.canManageLocalServiceConfiguration).toBe(true)

    const androidHttp = getAuroraSurfaceProfile({ runtimeMode: 'mobile-native', transportKind: 'http', nativePlatform: 'android' })
    expect(androidHttp.kind).toBe('android')
    expect(androidHttp.isWebThin).toBe(true)
    expect(androidHttp.supportsAndroidOnly).toBe(true)
    expect(androidHttp.supportsWebRtcThin).toBe(true)
    expect(androidHttp.trustsNativeWebViewOrigin).toBe(true)
    expect(androidHttp.canManageLocalServiceConfiguration).toBe(false)
    expect(androidHttp.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(androidHttp.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(androidHttp.voiceCapture.detail).toContain('Android capture')
    expect(androidHttp.voiceCapture.detail).toContain('foreground')

    const androidWebRtc = getAuroraSurfaceProfile({ runtimeMode: 'mobile-native', transportKind: 'webrtc-preferred', nativePlatform: 'android' })
    expect(androidWebRtc.kind).toBe('android')
    expect(androidWebRtc.prefersWebRtcTransport).toBe(true)

    const androidPackaged = getAuroraSurfaceProfile({ runtimeMode: 'android-thin', transportKind: 'webrtc-preferred' })
    expect(androidPackaged.kind).toBe('android')
    expect(androidPackaged.isMobile).toBe(true)

    const iosPackaged = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'webrtc-preferred',
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    })
    expect(iosPackaged.kind).toBe('ios')
    expect(iosPackaged.isMobile).toBe(true)
    expect(iosPackaged.isWebThin).toBe(true)
    expect(iosPackaged.supportsWebRtcThin).toBe(true)
  })

  it('propagates centralized voice ownership into runtime features', async () => {
    const web = createBrowserWebThinRuntime({
      createClient,
      mode: 'http-only',
      runtimeMode: 'web',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    const android = createBrowserWebThinRuntime({
      createClient,
      mode: 'http-only',
      runtimeMode: 'mobile-native',
      nativePlatform: 'android',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })

    expect(web.surface.voiceCapture.usesBrowserVoiceRuntime).toBe(true)
    expect(web.features).toMatchObject({
      usesBrowserVoiceRuntime: true,
      focusedPushToTalkOwner: 'webview-focused',
      wakewordOwner: 'webview-focused',
      localSpeechPack: {
        state: 'disabled',
        canRunLocalVad: false,
        canRunLocalKws: false,
        canRunLocalStt: false,
        canRunLocalTts: false,
      },
    })
    expect(android.surface.voiceCapture.usesBrowserVoiceRuntime).toBe(false)
    expect(android.features).toMatchObject({
      usesBrowserVoiceRuntime: false,
      focusedPushToTalkOwner: 'webview-focused',
      wakewordOwner: 'webview-focused',
      localSpeechPack: {
        state: 'disabled',
        canRunLocalStt: false,
      },
    })

    await web.close()
    await android.close()
  })

  it('propagates local speech pack state without changing hosted browser capture ownership', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      mode: 'webrtc-only',
      runtimeMode: 'web-thin',
      nodeRole: 'mesh-node',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'downloading',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    expect(runtime.surface.voiceCapture.usesBrowserVoiceRuntime).toBe(true)
    expect(runtime.features).toMatchObject({
      requestedNodeRole: 'mesh-node',
      activeNodeRole: 'mesh-node',
      usesBrowserVoiceRuntime: true,
      focusedPushToTalkOwner: 'webview-focused',
      localSpeechPack: {
        state: 'downloading',
        availabilityState: 'pending',
        canRunLocalVad: false,
        canRunLocalKws: false,
        canRunLocalStt: false,
        canRunLocalTts: false,
      },
    })

    await runtime.close()
  })

  it('does not infer mesh-node role from runtimeMode without an explicit nodeRole', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      runtimeMode: 'mesh-node',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    expect(runtime.features).toMatchObject({
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
    })
    expect(runtime.surface.nodeMode).toBe('remote-console')
    expect(runtime.surface.runtimeTier).toBe('none')

    await runtime.close()
  })

  it('builds a memory-only WebRTC profile from an invite without browser storage', () => {
    const localStorageSet = vi.spyOn(Storage.prototype, 'setItem')
    const sessionStorageSet = vi.spyOn(Storage.prototype, 'setItem')
    const invite = inviteText()

    const profile = webRtcProfileFromInvite(invite, { nodeName: 'Browser shell' })

    expect(profile).toMatchObject({
      appId: 'aurora',
      room: 'studio-room',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Host node',
      signalingBrokers: ['wss://broker.example/mqtt'],
      requireAppLayerE2ee: true,
    })
    expect(profile?.roomSecretRef).toMatch(/^ref:memory:/)
    expect(localStorageSet).not.toHaveBeenCalled()
    expect(sessionStorageSet).not.toHaveBeenCalled()
  })

  it('describes invite presence without making a persistence-backend claim', () => {
    const notes = explainBrowserThinRuntime({
      mode: 'webrtc-only',
      inviteText: inviteText(),
    })

    expect(notes).toContain(
      'invite room=studio-room; brokers=1; secret=provided',
    )
    expect(notes.join('\n')).not.toContain('secret=memory-only')
  })

  it('does not explain mesh-node gates from runtimeMode without an explicit nodeRole', () => {
    const rolloutFlags = {
      mesh_node_runtime_v1: false,
      local_tool_provider_v1: false,
      lightweight_orchestrator_v1: false,
    }
    const runtimeModeOnlyNotes = explainBrowserThinRuntime({
      mode: 'webrtc-only',
      runtimeMode: 'mesh-node',
      rolloutFlags,
    })
    const explicitMeshNodeNotes = explainBrowserThinRuntime({
      mode: 'webrtc-only',
      runtimeMode: 'web-thin',
      nodeRole: 'mesh-node',
      rolloutFlags,
    })

    expect(runtimeModeOnlyNotes.join('\n')).not.toContain('mesh-node runtime disabled')
    expect(runtimeModeOnlyNotes.join('\n')).not.toContain('local tool provider disabled')
    expect(runtimeModeOnlyNotes.join('\n')).not.toContain('lightweight orchestrator disabled')
    expect(explicitMeshNodeNotes).toEqual(expect.arrayContaining([
      'mesh-node implementation disabled by rollout flag',
      'local tool provider disabled by rollout flag',
      'lightweight orchestrator disabled by rollout flag',
    ]))
  })

  it('uses the exact nonsecret profile signaling endpoint over invite metadata', () => {
    const profile = webRtcProfileFromInvite(inviteText(), {
      nodeName: 'Desktop shell',
      signalingUrl: 'wss://profile-signaling.example/mqtt',
    })

    expect(profile?.signalingBrokers).toEqual([
      'wss://profile-signaling.example/mqtt',
    ])
    expect(profile?.expectedStablePeerId).toBe('peer-host')
  })

  it('marks an explicitly allowed loopback signaling invite as development-only', () => {
    const profile = webRtcProfileFromInvite(
      inviteText('ws://127.0.0.1:9001/mqtt'),
      {
        allowInsecureLoopbackSignaling: true,
      },
    )

    expect(profile).toMatchObject({
      signalingBrokers: ['ws://127.0.0.1:9001/mqtt'],
      allowInsecureLoopbackSignaling: true,
      production: false,
    })
  })

  it('selects explicit http-only and webrtc-preferred fallback modes', async () => {
    const httpOnly = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(httpOnly.mode).toBe('http-only')
    expect(httpOnly.client.transport.kind).toBe('http')
    expect(httpOnly.peer.snapshot().status).toBe('idle')

    const preferred = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(preferred.mode).toBe('webrtc-preferred')
    expect(preferred.client.transport.kind).toBe('mesh')
    expect(preferred.peer.snapshot().hasHttpFallback).toBe(true)
    await httpOnly.close()
    await preferred.close()
  })

  it('creates runtime clients through the supplied factory across transport modes', async () => {
    const transports: AuroraTransport[] = []
    const createClientFromRuntimeTransport = vi.fn((transport: AuroraTransport) => {
      transports.push(transport)
      return new AuroraClient({ transport })
    })
    const createDemoClientOnly = vi.fn(createDemoClient)

    const httpOnly = createBrowserWebThinRuntime({
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    const webrtcOnly = createBrowserWebThinRuntime({
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })
    const rolloutHttpFallback = createBrowserWebThinRuntime({
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://aurora.example',
      inviteText: inviteText(),
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    const demo = createBrowserWebThinRuntime({
      bearerToken: () => 'unused-before-onboarding',
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      mode: 'http-only',
      demoMode: true,
    })

    expect(createClientFromRuntimeTransport).toHaveBeenCalledTimes(3)
    expect(transports.map((transport) => transport.kind)).toEqual([
      'http',
      'mesh',
      'http',
    ])
    expect(httpOnly.client.transport).toBe(transports[0])
    expect(webrtcOnly.client.transport).toBe(transports[1])
    expect(rolloutHttpFallback.client.transport).toBe(transports[2])
    expect(rolloutHttpFallback.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
    })
    expect(createDemoClientOnly).toHaveBeenCalledTimes(1)
    expect(demo.client.transport.kind).toBe('mock')

    await httpOnly.close()
    await webrtcOnly.close()
    await rolloutHttpFallback.close()
    await demo.close()
  })

  it('keeps configured browser profiles on their HTTP transport when demo mode is also enabled', async () => {
    const createClientFromRuntimeTransport = vi.fn(createClient)
    const createDemoClientOnly = vi.fn(createDemoClient)

    const demo = createBrowserWebThinRuntime({
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      demoMode: true,
      gatewayUrl: 'https://configured-aurora.example',
      mode: 'http-only',
    })

    expect(createClientFromRuntimeTransport).toHaveBeenCalledTimes(1)
    expect(createDemoClientOnly).not.toHaveBeenCalled()
    expect(demo.client.transport.kind).toBe('http')

    await demo.close()
  })

  it('fails closed instead of replacing an invalid configured HTTP endpoint with demo data', async () => {
    const createClientFromRuntimeTransport = vi.fn(createClient)
    const createDemoClientOnly = vi.fn(createDemoClient)

    const runtime = createBrowserWebThinRuntime({
      createClient: createClientFromRuntimeTransport,
      createDemoClient: createDemoClientOnly,
      demoMode: true,
      gatewayUrl: '   ',
      mode: 'http-only',
    })

    expect(createClientFromRuntimeTransport).toHaveBeenCalledTimes(1)
    expect(createDemoClientOnly).not.toHaveBeenCalled()
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.peer.snapshot().status).toBe('failed')
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(
      'Could not connect to this Aurora device',
    )

    await runtime.close()
  })

  it('forwards durable peer authority services while keeping remote-console consumer-only defaults', async () => {
    vi.resetModules()
    const runtimeOptions: BrowserWebRtcRuntimeOptions<AuroraClient>[] = []
    const createBrowserWebRtcAuroraRuntime = vi.fn((options: BrowserWebRtcRuntimeOptions<AuroraClient>) => {
      runtimeOptions.push(options)
      const transport = new MockAuroraTransport()
      const peer = {
        snapshot: () => ({
          status: 'idle',
          connectionMode: options.mode,
          protocolCapabilities: options.localProtocolCapabilities ?? [],
          secureContext: true,
          visible: true,
          focused: true,
          hasHttpFallback: false,
          secretsPersisted: false,
        }),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
        getSelectedCandidatePairEvidence: vi.fn(async () => ({
          selected: false,
          statsSource: 'mock',
          rawAddressRedacted: true,
        })),
      }

      return {
        client: new AuroraClient({ transport }),
        peer,
        transport,
        close: vi.fn(async () => undefined),
      }
    })
    vi.doMock('@aurora/client/webrtc', async () => ({
      ...await vi.importActual<typeof import('@aurora/client/webrtc')>('@aurora/client/webrtc'),
      createBrowserWebRtcAuroraRuntime,
    }))

    try {
      const { createBrowserWebThinRuntime: createIsolatedBrowserWebThinRuntime } = await import('../src/web-thin-runtime')
      const peerAuthorityResolver = {
        verifyReconnectProof: vi.fn(async () => ({ ok: false, reason: 'missing' })),
      } as unknown as NonNullable<BrowserWebRtcRuntimeOptions<AuroraClient>['peerAuthorityResolver']>
      const peerPairingIssuer = {
        issue: vi.fn(async () => ({ tokenId: 'token-id', bearerToken: 'bearer-token' })),
      } as unknown as NonNullable<BrowserWebRtcRuntimeOptions<AuroraClient>['peerPairingIssuer']>

      const meshNode = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        peerAuthorityResolver,
        peerPairingIssuer,
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })
      const remoteConsole = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'remote-console',
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })
      const runtimeModeOnly = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        runtimeMode: 'mesh-node',
        inviteText: inviteText(),
        peerAuthorityResolver,
        peerPairingIssuer,
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })
      const meshRuntimeDisabled = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        peerAuthorityResolver,
        peerPairingIssuer,
        rolloutFlags: { mesh_node_runtime_v1: false },
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })
      const localProviderDisabled = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        peerAuthorityResolver,
        peerPairingIssuer,
        rolloutFlags: { local_tool_provider_v1: false },
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })
      const localOrchestratorDisabled = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        peerAuthorityResolver,
        peerPairingIssuer,
        rolloutFlags: { lightweight_orchestrator_v1: false },
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })

      expect(runtimeOptions).toHaveLength(6)
      expect(runtimeOptions[0]?.nodeRole).toBe('mesh-node')
      expect(runtimeOptions[0]?.peerAuthorityResolver).toBe(peerAuthorityResolver)
      expect(runtimeOptions[0]?.peerPairingIssuer).toBe(peerPairingIssuer)
      expect(runtimeOptions[1]?.nodeRole).toBe('remote-console')
      expect(runtimeOptions[1]).not.toHaveProperty('peerAuthorityResolver')
      expect(runtimeOptions[1]).not.toHaveProperty('peerPairingIssuer')
      expect(runtimeOptions[1]?.localProtocolCapabilities).toContain(CAP_CONSUMER_ONLY_V1)
      expect(runtimeOptions[2]?.nodeRole).toBe('remote-console')
      expect(runtimeOptions[2]).not.toHaveProperty('peerAuthorityResolver')
      expect(runtimeOptions[2]).not.toHaveProperty('peerPairingIssuer')
      expect(runtimeOptions[2]?.localProtocolCapabilities).toContain(CAP_CONSUMER_ONLY_V1)
      expect(runtimeModeOnly.features).toMatchObject({
        requestedNodeRole: 'remote-console',
        activeNodeRole: 'remote-console',
        meshNodeRuntimeEnabled: false,
        localToolProviderEnabled: false,
        lightweightOrchestratorEnabled: false,
      })
      expect(runtimeModeOnly.surface.nodeMode).toBe('remote-console')
      expect(runtimeModeOnly.surface.runtimeTier).toBe('none')
      expect(runtimeOptions[3]?.nodeRole).toBe('mesh-node')
      expect(runtimeOptions[3]).not.toHaveProperty('peerAuthorityResolver')
      expect(runtimeOptions[3]).not.toHaveProperty('peerPairingIssuer')
      expect(runtimeOptions[3]?.localProtocolCapabilities).not.toContain(CAP_CONSUMER_ONLY_V1)
      expect(meshRuntimeDisabled.features).toEqual({
        requestedNodeRole: 'mesh-node',
        activeNodeRole: 'mesh-node',
        meshNodeRuntimeEnabled: false,
        localToolProviderEnabled: false,
        lightweightOrchestratorEnabled: false,
        usesBrowserVoiceRuntime: true,
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        localSpeechPack: expect.objectContaining({
          state: 'disabled',
          canRunLocalStt: false,
          canRunLocalTts: false,
        }),
      })
      expect(meshRuntimeDisabled.surface.nodeMode).toBe('mesh-node')
      expect(meshRuntimeDisabled.surface.runtimeTier).toBe('none')
      expect(runtimeOptions[4]?.nodeRole).toBe('mesh-node')
      expect(runtimeOptions[4]).not.toHaveProperty('peerAuthorityResolver')
      expect(runtimeOptions[4]).not.toHaveProperty('peerPairingIssuer')
      expect(runtimeOptions[4]?.localProtocolCapabilities).not.toContain(CAP_CONSUMER_ONLY_V1)
      expect(localProviderDisabled.features).toEqual({
        requestedNodeRole: 'mesh-node',
        activeNodeRole: 'mesh-node',
        meshNodeRuntimeEnabled: true,
        localToolProviderEnabled: false,
        lightweightOrchestratorEnabled: true,
        usesBrowserVoiceRuntime: true,
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        localSpeechPack: expect.objectContaining({
          state: 'disabled',
          canRunLocalStt: false,
          canRunLocalTts: false,
        }),
      })
      expect(runtimeOptions[5]?.nodeRole).toBe('mesh-node')
      expect(runtimeOptions[5]?.peerAuthorityResolver).toBe(peerAuthorityResolver)
      expect(runtimeOptions[5]?.peerPairingIssuer).toBe(peerPairingIssuer)
      expect(localOrchestratorDisabled.features).toEqual({
        requestedNodeRole: 'mesh-node',
        activeNodeRole: 'mesh-node',
        meshNodeRuntimeEnabled: true,
        localToolProviderEnabled: true,
        lightweightOrchestratorEnabled: false,
        usesBrowserVoiceRuntime: true,
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        localSpeechPack: expect.objectContaining({
          state: 'disabled',
          canRunLocalStt: false,
          canRunLocalTts: false,
        }),
      })

      await meshNode.close()
      await remoteConsole.close()
      await runtimeModeOnly.close()
      await meshRuntimeDisabled.close()
      await localProviderDisabled.close()
      await localOrchestratorDisabled.close()
    } finally {
      vi.doUnmock('@aurora/client/webrtc')
      vi.resetModules()
    }
  })

  it('creates one authorized WebRTC runtime when home peer and mesh membership share one relationship', async () => {
    vi.resetModules()
    const peerConnect = vi.fn(async () => undefined)
    const peerDisconnect = vi.fn(async () => undefined)
    const runtimeClose = vi.fn(async () => undefined)
    const runtimeOptions: BrowserWebRtcRuntimeOptions<AuroraClient>[] = []
    const createBrowserWebRtcAuroraRuntime = vi.fn((options: BrowserWebRtcRuntimeOptions<AuroraClient>) => {
      runtimeOptions.push(options)
      const transport = new MockAuroraTransport()
      const peer = {
        snapshot: () => ({
          state: 'authorized',
          connectionMode: options.mode,
          expectedStablePeerId: options.profile?.expectedStablePeerId,
          connectedStablePeerId: options.profile?.expectedStablePeerId,
          icePathCategory: 'unknown',
          protocolCapabilities: options.localProtocolCapabilities ?? [],
          reconnectCount: 0,
          pendingCallCount: 0,
          pendingStreamCount: 0,
          pendingSubscriptionCount: 0,
          pendingFragmentCount: 0,
          bufferPressureHighWaterBytes: 0,
          sentFragmentCount: 0,
          receivedFragmentCount: 0,
          updatedAt: new Date(0).toISOString(),
        }),
        connect: peerConnect,
        disconnect: peerDisconnect,
        subscribe: vi.fn((listener: (snapshot: PeerConnectionSnapshot) => void) => {
          listener(peer.snapshot() as PeerConnectionSnapshot)
          return () => undefined
        }),
        getSelectedCandidatePairEvidence: vi.fn(async () => ({
          selected: true,
          category: 'host',
          statsSource: 'mock',
          rawAddressRedacted: true,
        })),
      }

      return {
        client: new AuroraClient({ transport }),
        peer,
        transport,
        close: runtimeClose,
      }
    })
    vi.doMock('@aurora/client/webrtc', async () => ({
      ...await vi.importActual<typeof import('@aurora/client/webrtc')>('@aurora/client/webrtc'),
      createBrowserWebRtcAuroraRuntime,
    }))

    try {
      const { createBrowserWebThinRuntime: createIsolatedBrowserWebThinRuntime } = await import('../src/web-thin-runtime')
      const peerHost = {
        resumeLocalProvider: vi.fn(),
        renewLocalProvider: vi.fn(),
        suspendLocalProvider: vi.fn(),
      }
      const runtime = createIsolatedBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        localStablePeerId: 'browser-peer',
        peerHost: peerHost as never,
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })

      await runtime.peer.connect()

      expect(createBrowserWebRtcAuroraRuntime).toHaveBeenCalledOnce()
      expect(runtimeOptions).toHaveLength(1)
      expect(runtimeOptions[0]).toMatchObject({
        mode: 'webrtc-only',
        nodeRole: 'mesh-node',
        localStablePeerId: 'browser-peer',
      })
      expect(runtimeOptions[0]?.profile?.expectedStablePeerId).toBe('peer-host')
      expect(runtimeOptions[0]?.peerHost).toBe(peerHost)
      expect(peerConnect).toHaveBeenCalledOnce()
      expect(runtime.peer.snapshot()).toMatchObject({
        status: 'authorized',
        expectedStablePeerId: 'peer-host',
        connectedStablePeerId: 'peer-host',
      })

      await runtime.close()
      expect(peerDisconnect).toHaveBeenCalledOnce()
      expect(runtimeClose).toHaveBeenCalledOnce()
    } finally {
      vi.doUnmock('@aurora/client/webrtc')
      vi.resetModules()
    }
  })

  it('keeps WebRTC remote-console runtime consumer-only with no local provider capabilities', async () => {
    expect(normalizeAuroraWebRtcRolloutFlags(undefined)).toMatchObject({
      mesh_node_runtime_v1: true,
      local_tool_provider_v1: true,
      lightweight_orchestrator_v1: true,
    })
    const capabilities = localProtocolCapabilities(
      normalizeAuroraWebRtcRolloutFlags(undefined),
      'remote-console',
    )
    expect(capabilities).toEqual([
      'fragmentation_v1',
      'backpressure_v1',
      'scoped_event_subscriptions_v1',
      CAP_CONSUMER_ONLY_V1,
    ])

    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    expect(runtime.mode).toBe('webrtc-only')
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.peer.snapshot().protocolCapabilities).toEqual([])
    expect(runtime.peer.snapshot().protocolCapabilities).not.toContain(
      CAP_CONSUMER_ONLY_V1,
    )
    await runtime.close()
  })

  it('omits consumer-only from mesh-node protocol capabilities while preserving provider-capable rollout order', () => {
    const capabilities = localProtocolCapabilities(
      normalizeAuroraWebRtcRolloutFlags(undefined),
      'mesh-node',
    )

    expect(capabilities).toEqual([
      'fragmentation_v1',
      'backpressure_v1',
      'scoped_event_subscriptions_v1',
    ])
    expect(capabilities).not.toContain(CAP_CONSUMER_ONLY_V1)
    expect(new Set(capabilities).size).toBe(capabilities.length)
  })

  it('keeps rollout-gated mesh-node capabilities deduplicated and ordered', () => {
    expect(localProtocolCapabilities(
      normalizeAuroraWebRtcRolloutFlags({
        webrtc_fragmentation: false,
        webrtc_scoped_subscriptions: true,
      }),
      'mesh-node',
    )).toEqual(['scoped_event_subscriptions_v1'])

    expect(localProtocolCapabilities(
      normalizeAuroraWebRtcRolloutFlags({
        webrtc_fragmentation: true,
        webrtc_scoped_subscriptions: false,
      }),
      'remote-console',
    )).toEqual([
      'fragmentation_v1',
      'backpressure_v1',
      CAP_CONSUMER_ONLY_V1,
    ])
  })

  it('rolls WebRTC-preferred back to HTTP without consuming or rewriting peer credentials', async () => {
    const credentialStore = Object.assign(new MemoryPeerCredentialStore(), {
      loadConnectionProfile: vi.fn(() => null),
      saveConnectionProfile: vi.fn(),
      setRoomSecret: vi.fn(),
    })
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      credentialStore,
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })

    expect(runtime.mode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
      diagnostic: 'This device cannot use an invite right now.',
    })
    expect(credentialStore.loadConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.saveConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.setRoomSecret).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('withdraws WebRTC-dependent readiness during WebRTC-preferred HTTP rollback without changing the saved role or voice state', async () => {
    const credentialStore = Object.assign(new MemoryPeerCredentialStore(), {
      loadConnectionProfile: vi.fn(() => null),
      saveConnectionProfile: vi.fn(),
      setRoomSecret: vi.fn(),
    })
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      nodeRole: 'mesh-node',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'downloading',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      credentialStore,
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })

    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.features).toMatchObject({
      requestedNodeRole: 'mesh-node',
      activeNodeRole: 'mesh-node',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
      localSpeechPack: {
        state: 'downloading',
        availabilityState: 'pending',
        canRunLocalStt: false,
        canRunLocalTts: false,
      },
    })
    expect(runtime.surface).toMatchObject({
      nodeMode: 'mesh-node',
      runtimeTier: 'none',
      ownsLocalNodeState: true,
      isRemoteConsole: false,
      prefersWebRtcTransport: false,
    })
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
    })
    expect(credentialStore.loadConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.saveConnectionProfile).not.toHaveBeenCalled()
    expect(credentialStore.setRoomSecret).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('fails WebRTC-only closed when the thin-client rollout flag is disabled', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    expect(runtime.client.transport.kind).toBe('mesh')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: false,
      diagnostic: 'This device cannot use an invite right now.',
    })
    await expect(runtime.peer.connect()).rejects.toThrow('This device cannot use an invite right now.')
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow('This device cannot use an invite right now.')
    await runtime.close()
  })

  it.each([
    ['desktop Tauri dev', 'desktop-thin', 'desktop', '127.0.0.1'],
    ['packaged Android Tauri', 'mobile-native', 'android', 'tauri.localhost'],
    ['packaged iOS Tauri', 'mobile-native', 'ios', 'tauri.localhost'],
  ])(
    'trusts the allowlisted local origin for %s without weakening hosted HTTP',
    async (_label, runtimeMode, nativePlatform, hostname) => {
      const runtime = createBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        runtimeMode,
        nativePlatform,
        windowLocation: { protocol: 'http:', hostname },
      })

      expect(runtime.surface.trustsNativeWebViewOrigin).toBe(true)
      expect(runtime.peer.snapshot()).toMatchObject({
        secureContext: true,
        status: expect.not.stringMatching(/needs-secure-context/),
      })
      await runtime.close()
    },
  )

  it('accepts a hosted web thin shell on the browser-trusted localhost origin', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      runtimeMode: 'web-thin',
      windowLocation: { protocol: 'http:', hostname: '127.0.0.1' },
    })

    expect(runtime.surface.trustsNativeWebViewOrigin).toBe(false)
    expect(runtime.peer.snapshot()).toMatchObject({
      secureContext: true,
      status: expect.not.stringMatching(/needs-secure-context/),
    })
    await runtime.close()
  })

  it('does not trust an arbitrary HTTP host even when native runtime metadata is present', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      runtimeMode: 'mobile-native',
      nativePlatform: 'android',
      windowLocation: { protocol: 'http:', hostname: 'public.example' },
    })

    expect(runtime.surface.trustsNativeWebViewOrigin).toBe(true)
    expect(runtime.peer.snapshot()).toMatchObject({
      secureContext: false,
      status: 'needs-secure-context',
    })
    await runtime.close()
  })

  it('fails closed for WebRTC-only on insecure non-loopback contexts', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'http:', hostname: 'public.example' },
    })

    const snapshot = runtime.peer.snapshot()
    expect(snapshot.status).toBe('needs-secure-context')
    expect(snapshot.hasHttpFallback).toBe(false)
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/secure page|Aurora device/i)
  })

  it('surfaces missing RTCPeerConnection during connect without using HTTP in WebRTC-only mode', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      signalingFactory: () => new FakeSignalingClient() as any,
      createPeerConnection: () => { throw new Error('RTCPeerConnection unavailable') },
      randomId: () => 'local-z',
    })
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)

    await runtime.peer.connect()
    await waitUntil(() => ['failed', 'connecting'].includes(runtime.peer.snapshot().status), 200)
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)
    expect(['failed', 'connecting']).toContain(runtime.peer.snapshot().status)
  })

  it('does not fall back to HTTP before an attempted WebRTC connection in preferred mode', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      fetchImpl,
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
    })

    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow('Could not connect to this Aurora device')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(true)
    await runtime.close()
  })

  it('fails closed for WebRTC-preferred secure-context validation instead of falling back to HTTP', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      fetchImpl,
      windowLocation: { protocol: 'http:', hostname: 'public.example' },
    })

    expect(runtime.peer.snapshot().status).toBe('needs-secure-context')
    expect(runtime.peer.snapshot().hasHttpFallback).toBe(false)
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(/secure page|Aurora device/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not allow HTTP fallback for generic unavailable/not-connected errors', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-preferred', { httpFallback: true })

    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'transport_loss', message: 'ICE transport lost' }))).toBe(false)
    await controller.connect(webRtcProfileFromInvite(inviteText())!)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'unavailable_service', message: 'WebRTC mesh transport is not connected and HTTP fallback is disabled.' }))).toBe(false)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'auth', message: 'pairing token rejected' }))).toBe(false)
    expect(controller.isFallbackEligibleAfterWebRtcRoute(new AuroraError({ code: 'transport_loss', message: 'ICE transport lost' }))).toBe(true)
  })

  it('does not render a successful authorization diagnostic as a connection failure', () => {
    const peer = new FakeBrowserPeer({
      status: 'authorized',
      state: 'authorized',
      lastRedactedError: {
        code: 'webrtc_mesh_authorized',
        message: 'WebRTC mesh transport authorized',
        at: '2026-08-02T00:00:00.000Z',
      },
    })
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false })

    expect(controller.snapshot().diagnostic).toBeUndefined()
  })

  it('keeps WebRTC peer sessions connected when the thin-shell document is hidden', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const listeners = new Map<string, Set<() => void>>()
    const visibilityDocument = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set<() => void>()
        set.add(listener)
        listeners.set(event, set)
      },
      removeEventListener: (event: string, listener: () => void) => {
        listeners.get(event)?.delete(listener)
      },
    } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false, visibilityDocument })
    await controller.connect(webRtcProfileFromInvite(inviteText())!)

    Object.defineProperty(visibilityDocument, 'visibilityState', { configurable: true, value: 'hidden' as DocumentVisibilityState })
    for (const listener of listeners.get('visibilitychange') ?? []) listener()

    expect(peer.disconnectedReasons).toEqual([])
    expect(controller.snapshot().status).toBe('authorized')
    expect(controller.snapshot().visible).toBe(false)
    expect(controller.snapshot().diagnostic).toBe(
      'Connection continues while this page is in the background. Some updates may wait until you return.',
    )
  })

  it('drives semantic local provider lifecycle while blur does not withdraw', async () => {
    vi.useFakeTimers()
    try {
      const documentListeners = new Map<string, Set<() => void>>()
      const windowListeners = new Map<string, Set<() => void>>()
      const visibilityDocument = {
        visibilityState: 'visible' as DocumentVisibilityState,
        addEventListener: (event: string, listener: () => void) => {
          const set = documentListeners.get(event) ?? new Set<() => void>()
          set.add(listener)
          documentListeners.set(event, set)
        },
        removeEventListener: (event: string, listener: () => void) => {
          documentListeners.get(event)?.delete(listener)
        },
      } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
      const windowTarget = {
        addEventListener: (event: string, listener: () => void) => {
          const set = windowListeners.get(event) ?? new Set<() => void>()
          set.add(listener)
          windowListeners.set(event, set)
        },
        removeEventListener: (event: string, listener: () => void) => {
          windowListeners.get(event)?.delete(listener)
        },
      } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>
      const calls: string[] = []
      const flushLifecycle = async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      }
      const host = {
        resume: async () => { calls.push('resume') },
        renew: () => { calls.push('renew') },
        suspend: (reason?: string) => { calls.push(`suspend:${reason}`) },
      }
      const controller = new LocalNodeLifecycleController({
        host,
        document: visibilityDocument,
        window: windowTarget,
      })

      controller.start()
      await flushLifecycle()
      expect(calls).toEqual(['resume'])
      for (const listener of windowListeners.get('blur') ?? []) listener()
      expect(calls).toEqual(['resume'])
      vi.advanceTimersByTime(20_000)
      expect(calls).toEqual(['resume', 'renew'])

      for (const listener of windowListeners.get('pagehide') ?? []) listener()
      expect(calls.at(-1)).toBe('suspend:page_hidden')
      vi.advanceTimersByTime(20_000)
      expect(calls.filter((call) => call === 'renew')).toHaveLength(1)

      for (const listener of windowListeners.get('pageshow') ?? []) listener()
      await flushLifecycle()
      expect(calls.at(-1)).toBe('resume')
      for (const listener of documentListeners.get('freeze') ?? []) listener()
      expect(calls.at(-1)).toBe('suspend:page_frozen')
      controller.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('binds browser timer receivers when provider lease renewal starts', () => {
    const intervalHandle = 41 as unknown as ReturnType<typeof globalThis.setInterval>
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(function (this: unknown) {
        expect(this).toBe(globalThis)
        return intervalHandle
      })
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(function (this: unknown, handle) {
        expect(this).toBe(globalThis)
        expect(handle).toBe(intervalHandle)
      })
    const controller = new LocalNodeLifecycleController({
      host: {
        resume: () => undefined,
        renew: () => undefined,
        suspend: () => undefined,
      },
      document: {
        visibilityState: 'visible',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      window: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    })

    controller.start()
    controller.stop()

    expect(setIntervalSpy).toHaveBeenCalledOnce()
    expect(clearIntervalSpy).toHaveBeenCalledOnce()
  })

  it('wires mesh-node browser runtime lifecycle through the SDK provider port', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const peerHost = {
        resumeLocalProvider: async () => { calls.push('resume') },
        renewLocalProvider: async () => { calls.push('renew') },
        suspendLocalProvider: async (reason?: string) => { calls.push(`suspend:${reason}`) },
      }
      const runtime = createBrowserWebThinRuntime({
        createClient,
        createDemoClient,
        mode: 'webrtc-only',
        inviteText: inviteText(),
        nodeRole: 'mesh-node',
        peerHost: peerHost as never,
        windowLocation: { protocol: 'https:', hostname: 'app.example' },
      })

      await Promise.resolve()
      await Promise.resolve()
      expect(calls).toEqual(['resume'])
      vi.advanceTimersByTime(20_000)
      expect(calls).toEqual(['resume', 'renew'])

      window.dispatchEvent(new Event('pagehide'))
      expect(calls.at(-1)).toBe('suspend:page_hidden')
      vi.advanceTimersByTime(20_000)
      expect(calls.filter((call) => call === 'renew')).toHaveLength(1)

      window.dispatchEvent(new Event('pageshow'))
      await Promise.resolve()
      await Promise.resolve()
      expect(calls.at(-1)).toBe('resume')
      await runtime.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards selected candidate-pair evidence without exposing raw addresses', async () => {
    const peer = new FakeBrowserPeer({ status: 'authorized', state: 'authorized' })
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false })

    const evidence = await controller.getSelectedCandidatePairEvidence()

    expect(peer.selectedCandidatePairEvidenceCalls).toBe(1)
    expect(evidence).toEqual({
      selected: true,
      category: 'prflx',
      pairState: 'succeeded',
      nominated: true,
      localCandidateType: 'prflx',
      remoteCandidateType: 'host',
      localProtocol: 'udp',
      remoteProtocol: 'udp',
      stunServerReflexiveCandidate: {
        gathered: true,
        candidateType: 'srflx',
        urlScheme: 'stun',
        urlMatchesConfiguredStunServer: true,
        configuredStunServerCount: 1,
        statsSource: 'RTCPeerConnection.getStats',
        rawAddressRedacted: true,
      },
      statsSource: 'RTCPeerConnection.getStats',
      rawAddressRedacted: true,
    })
    expect(Object.keys(evidence)).not.toEqual(expect.arrayContaining(['localAddress', 'remoteAddress', 'ip', 'address']))
    expect(JSON.stringify(evidence)).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
  })

  it('uses fixed user copy for secret-bearing connection diagnostics', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      signalingFactory: () => { throw new Error('password=secret-room-password token=abc123') },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      randomId: () => 'local-redacted',
    })

    await expect(runtime.peer.connect()).rejects.toThrow()
    const diagnostic = runtime.peer.snapshot().diagnostic ?? ''
    expect(diagnostic).toBe('Could not connect to this Aurora device. Try again from Connection settings.')
    expect(diagnostic).not.toContain('secret-room-password')
    expect(diagnostic).not.toContain('abc123')
    expectProductionCopyClean(diagnostic)
  })

  it('keeps hostile connection errors out of client-facing failures', async () => {
    const runtime = createBrowserWebThinRuntime({
      createClient,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      signalingFactory: () => {
        throw new Error('WebRTC runtime transport provider manifest protocol token=secret')
      },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      randomId: () => 'local-hostile',
    })

    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(
      'Could not connect to this Aurora device. Try again from Connection settings.',
    )
    await expect(runtime.client.capabilities.listCatalog()).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
  })

  it('keeps hostile HTTP errors safe without an injected client factory', async () => {
    const runtime = createBrowserWebThinRuntime({
      createDemoClient,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: hostileGatewayFetch,
    })

    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(
      'Could not connect to this Aurora device. Try again from Connection settings.',
    )
    await expect(runtime.client.capabilities.listCatalog()).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    await runtime.close()
  })

  it('keeps hostile WebRTC setup errors safe without an injected client factory', async () => {
    const runtime = createBrowserWebThinRuntime({
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      signalingFactory: () => {
        throw new Error('WebRTC runtime transport provider manifest protocol token=secret')
      },
      scryptDeriver: async () => new Uint8Array(32).fill(7),
      randomId: () => 'local-hostile-default',
    })

    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(
      'Could not connect to this Aurora device. Try again from Connection settings.',
    )
    await expect(runtime.client.capabilities.listCatalog()).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    await runtime.close()
  })

  it('keeps hostile rollout HTTP fallback errors safe without an injected client factory', async () => {
    const runtime = createBrowserWebThinRuntime({
      createDemoClient,
      mode: 'webrtc-preferred',
      inviteText: inviteText(),
      gatewayUrl: 'https://aurora.example',
      rolloutFlags: { webrtc_thin_client: false },
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      fetchImpl: hostileGatewayFetch,
    })

    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
    })
    await expect(runtime.client.capabilities.listCatalog()).rejects.toThrow(
      'Could not connect to this Aurora device. Try again from Connection settings.',
    )
    await expect(runtime.client.capabilities.listCatalog()).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    await runtime.close()
  })

  it('maps async stream setup failures through fixed copy while preserving metadata', async () => {
    let safeTransport: (AuroraTransport & {
      source?: AuroraTransport
      subscribe?: (request: AuroraStreamRequest) => unknown
    }) | null = null
    const createClientOnce = vi.fn((transport: AuroraTransport) => {
      safeTransport = transport
      return new AuroraClient({ transport })
    })
    const runtime = createBrowserWebThinRuntime({
      createClient: createClientOnce,
      createDemoClient,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    const hostile = hostileAuroraError()
    safeTransport!.source = {
      kind: 'mesh',
      request: async () => ({ data: {} }),
      subscribe: async () => {
        throw hostile
      },
    } as AuroraTransport & { subscribe: () => Promise<never> }

    await expect(safeTransport!.subscribe!(streamRequest())).rejects.toMatchObject({
      code: hostile.code,
      status: hostile.status,
      method: hostile.method,
      busTopic: hostile.busTopic,
      correlationId: hostile.correlationId,
      detail: hostile.detail,
      message: 'Could not connect to this Aurora device. Try again from Connection settings.',
    })
    await expect(safeTransport!.subscribe!(streamRequest())).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    await runtime.close()
  })

  it('maps later stream iterator and subscription failures through fixed copy', async () => {
    let safeTransport: (AuroraTransport & {
      source?: AuroraTransport
      subscribe?: (request: AuroraStreamRequest) => Promise<AuroraEventSubscription>
    }) | null = null
    const createClientOnce = vi.fn((transport: AuroraTransport) => {
      safeTransport = transport
      return new AuroraClient({ transport })
    })
    const runtime = createBrowserWebThinRuntime({
      createClient: createClientOnce,
      createDemoClient,
      mode: 'http-only',
      gatewayUrl: 'https://aurora.example',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    const iteratorError = hostileAuroraError('corr-iterator')
    const closedError = hostileAuroraError('corr-closed')
    safeTransport!.source = {
      kind: 'mesh',
      request: async () => ({ data: {} }),
      subscribe: async () => ({
        closed: Promise.reject(closedError),
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw iteratorError
            },
          }
        },
      }),
    } as AuroraTransport & { subscribe: () => Promise<AuroraEventSubscription> }

    const subscription = await safeTransport!.subscribe!(streamRequest())

    await expect(subscription[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: iteratorError.code,
      status: iteratorError.status,
      method: iteratorError.method,
      busTopic: iteratorError.busTopic,
      correlationId: iteratorError.correlationId,
      detail: iteratorError.detail,
      message: 'Could not connect to this Aurora device. Try again from Connection settings.',
    })
    await expect(subscription.closed).rejects.toMatchObject({
      code: closedError.code,
      correlationId: closedError.correlationId,
      message: 'Could not connect to this Aurora device. Try again from Connection settings.',
    })
    await expect(subscription[Symbol.asyncIterator]().next()).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    await runtime.close()
  })

  it('throws fixed-copy connect failures while preserving structured fields', async () => {
    const hostile = hostileAuroraError()
    const peer = new FakeBrowserPeer({ status: 'idle' }, hostile)
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false })

    await expect(controller.connect(webRtcProfileFromInvite(inviteText())!)).rejects.toMatchObject({
      code: hostile.code,
      status: hostile.status,
      method: hostile.method,
      busTopic: hostile.busTopic,
      correlationId: hostile.correlationId,
      detail: hostile.detail,
      message: 'Could not connect to this Aurora device. Try again from Connection settings.',
    })
    await expect(controller.connect(webRtcProfileFromInvite(inviteText())!)).rejects.not.toThrow(
      /WebRTC|runtime|transport|provider|manifest|protocol|token=secret/i,
    )
    expect(controller.snapshot().diagnostic).toBe(
      'Could not connect to this Aurora device. Try again from Connection settings.',
    )
  })

  it('constructs one caller client for successful runtimes and releases listeners on close', async () => {
    const documentListeners = new Map<string, Set<() => void>>()
    const visibilityDocument = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (event: string, listener: () => void) => {
        const listeners = documentListeners.get(event) ?? new Set<() => void>()
        listeners.add(listener)
        documentListeners.set(event, listeners)
      },
      removeEventListener: (event: string, listener: () => void) => {
        documentListeners.get(event)?.delete(listener)
      },
    } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
    const transports: AuroraTransport[] = []
    const createClientOnce = vi.fn((transport: AuroraTransport) => {
      transports.push(transport)
      return new AuroraClient({ transport })
    })

    const runtime = createBrowserWebThinRuntime({
      createClient: createClientOnce,
      createDemoClient,
      mode: 'webrtc-only',
      inviteText: inviteText(),
      windowLocation: { protocol: 'https:', hostname: 'app.example' },
      visibilityDocument,
    })

    expect(createClientOnce).toHaveBeenCalledTimes(1)
    expect(runtime.client.transport).toBe(transports[0])
    expect(runtime.client.transport.kind).toBe('mesh')
    expect(documentListeners.get('visibilitychange')?.size).toBe(2)

    await runtime.close()

    expect(createClientOnce).toHaveBeenCalledTimes(1)
    expect(documentListeners.get('visibilitychange')?.size ?? 0).toBe(0)
  })

  it('maps hostile structured peer status into safe presentation copy', async () => {
    const hostileDiagnostic = 'WebRTC runtime transport provider manifest protocol fallback token=secret'
    const peer = new FakeBrowserPeer({
      status: 'failed',
      state: 'failed',
      diagnostic: hostileDiagnostic,
      lastRedactedError: {
        code: 'transport_loss',
        message: hostileDiagnostic,
      },
    } as Partial<BrowserWebRtcSnapshot>)
    const controller = new BrowserWebRtcPeerController(peer as any, 'webrtc-only', { httpFallback: false })
    const runtimeDiagnostic = controller.snapshot().diagnostic ?? ''

    expect(runtimeDiagnostic).toBe('Could not connect to this Aurora device. Try again from Connection settings.')
    expectProductionCopyClean(runtimeDiagnostic)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
        />,
      )
    })

    const rendered = container.textContent ?? ''
    expect(rendered).toContain('Could not connect to this Aurora device')
    expect(rendered).not.toContain(hostileDiagnostic)
    expectProductionCopyClean(rendered)
  })

  it('keeps invite actions disabled on insecure public mobile origins', async () => {
    const peer = new FakeBrowserPeer({
      status: 'needs-secure-context',
      secureContext: false,
      diagnostic: 'Open Aurora from a secure page before connecting.',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="native-mobile"
          nativePlatform="android"
          initialInviteText={inviteText()}
        />,
      )
    })

    expect(container.textContent).toContain('Secure connection needed')
    expect(findButton(container, 'Use invite').disabled).toBe(true)
    expect(findButton(container, 'Reconnect').disabled).toBe(true)
    expect(peer.connectedProfiles).toEqual([])
  })

  it('renders invite diagnostics and SAS confirmation controls accessibly', async () => {
    const peer = new FakeBrowserPeer({
      status: 'pairing',
      pairingSessionId: 'pair-session-1',
      pairingVerificationCode: '12345678',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const onInviteAccepted = vi.fn()

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
          initialInviteText={inviteText()}
          onInviteAccepted={onInviteAccepted}
        />
      )
    })

    expect(container.textContent).toContain('Connected Aurora device')
    expect(container.textContent).toContain('Compare this code on both devices')
    expect(container.textContent).toContain('12345678')
    expect(container.textContent).toContain('Temporary session')

    const confirm = findButton(container, 'Approve connection')
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.confirmed).toEqual(['pair-session-1'])

    const accept = findButton(container, 'Use invite')
    await act(async () => {
      accept.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.connectedProfiles).toHaveLength(1)
    expect(peer.connectedProfiles[0]?.room).toBe('studio-room')
    expect(onInviteAccepted).toHaveBeenCalledTimes(1)

    const reconnect = findButton(container, 'Reconnect')
    await act(async () => {
      reconnect.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(peer.connectedProfiles).toHaveLength(2)
  })

  it('asks for locally available service scopes before mobile pairing approval', async () => {
    const peer = new FakeBrowserPeer({
      status: 'pairing',
      pairingSessionId: 'pair-session-mobile',
      pairingVerificationCode: '12345678',
      nodeName: 'Home Aurora',
    })
    const setFeatureEnabled = vi.fn(async () => undefined)
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => ({
        features: [
          {
            serviceId: 'tooling',
            servicePermissionId: 'Tooling.use',
            serviceLabel: 'Tools',
            serviceDescription: 'Use tools this device makes available.',
            id: 'aurora.local.native.get_device_status.v1',
            label: 'Device status',
            description: 'Share battery and connectivity status.',
            enabled: false,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: false,
          },
          {
            serviceId: 'tooling',
            servicePermissionId: 'Tooling.use',
            serviceLabel: 'Tools',
            serviceDescription: 'Use tools this device makes available.',
            id: 'aurora.local.native.share.v1',
            label: 'Share from this phone',
            description: 'Share an item selected on this phone.',
            enabled: true,
            available: true,
            requiresAuroraOpen: true,
            requiresLocalConfirmation: true,
          },
        ],
        approvedDevices: [],
      })),
      setFeatureEnabled,
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="native-mobile"
          nativePlatform="android"
          localFeatureSharing={localFeatureSharing}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Choose what Home Aurora can use from this device')
    expect(container.textContent).toContain('Tools')
    expect(container.textContent).not.toContain('Tooling.use')
    expect(container.textContent).not.toContain('Device status')
    expect(container.textContent).not.toContain('Share from this phone')
    expect(container.textContent).not.toContain('Gateway')
    expect(container.textContent).not.toContain('Orchestrator')
    await act(async () => {
      findButton(container, 'Approve connection').click()
      await Promise.resolve()
    })

    expect(setFeatureEnabled).toHaveBeenCalledWith('aurora.local.native.get_device_status.v1', true)
    expect(peer.confirmed).toEqual(['pair-session-mobile'])
    expect(peer.pairingApprovals).toEqual([{
      sharedFeatureIds: [
        'aurora.local.native.get_device_status.v1',
        'aurora.local.native.share.v1',
      ],
    }])
  })

  it('keeps pending pairing intent through transient disconnect states', async () => {
    const peer = new FakeBrowserPeer({
      status: 'pairing',
      state: 'awaiting-sas-confirmation',
      pairingSessionId: 'pair-session-9',
      pairingVerificationCode: '87654321',
    })
    const controller = new BrowserWebRtcPeerController(
      peer as unknown as PeerConnectionController,
      'webrtc-only',
      { httpFallback: false },
    )
    expect(controller.snapshot().pairingSessionId).toBe('pair-session-9')
    expect(controller.snapshot().pairingVerificationCode).toBe('87654321')

    ;(peer as unknown as { snapshotValue: BrowserWebRtcSnapshot }).snapshotValue.state = 'closed'
    expect(controller.snapshot().pairingSessionId).toBe('pair-session-9')
    ;(peer as unknown as { snapshotValue: BrowserWebRtcSnapshot }).snapshotValue = {
      ...(peer as unknown as { snapshotValue: BrowserWebRtcSnapshot }).snapshotValue,
      state: 'reconnecting',
      status: 'connecting',
      pairingSessionId: undefined,
      pairingVerificationCode: undefined,
    }
    expect(controller.snapshot().pairingSessionId).toBe('pair-session-9')

    await controller.disconnect('disconnect')
    expect(peer.disconnectedReasons.at(-1)).toBe('disconnect')
    expect(controller.snapshot().pairingSessionId).toBe('pair-session-9')

    ;(peer as unknown as { snapshotValue: BrowserWebRtcSnapshot }).snapshotValue = {
      ...(peer as unknown as { snapshotValue: BrowserWebRtcSnapshot }).snapshotValue,
      state: 'authorized',
      status: 'authorized',
      pairingSessionId: undefined,
      pairingVerificationCode: undefined,
    }
    expect(controller.snapshot().pairingSessionId).toBeUndefined()
  })

  it('blocks mobile pairing approval when local sharing options cannot be loaded', async () => {
    const peer = new FakeBrowserPeer({
      status: 'pairing',
      pairingSessionId: 'pair-session-mobile',
      pairingVerificationCode: '12345678',
      nodeName: 'Home Aurora',
    })
    const localFeatureSharing: LocalFeatureSharingPort = {
      load: vi.fn(async () => Promise.reject(new Error('unavailable'))),
      setFeatureEnabled: vi.fn(async () => undefined),
      replacePeerSharing: vi.fn(async () => undefined),
      revokePeerSharing: vi.fn(async () => undefined),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="native-mobile"
          nativePlatform="android"
          localFeatureSharing={localFeatureSharing}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('This device’s sharing options are unavailable right now. Try again.')
    expect(findButton(container, 'Approve connection').disabled).toBe(true)
    expect(peer.confirmed).toEqual([])
  })

  it('edits and saves a nonsecret desktop-thin connection profile', async () => {
    const peer = new FakeBrowserPeer({ status: 'idle' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const profile = {
      id: 'office',
      label: 'Office',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora desktop',
      localStablePeerId: 'desktop-peer-01',
    }
    const onSaveProfile = vi.fn(async () => undefined)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-preferred"
          transportKind="mesh"
          profile={profile}
          profiles={[profile, { ...profile, id: 'home', label: 'Home' }]}
          profileStoreEvidence="Saved on this device"
          onSaveProfile={onSaveProfile}
          onSelectProfile={async () => undefined}
        />
      )
    })

    expect(container.querySelector('[aria-label="Saved connection profile"]')).not.toBeNull()
    const nodeName = container.querySelector<HTMLInputElement>('#webthin-profile-node-name')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nodeName, 'Edited desktop')
      nodeName.dispatchEvent(new Event('input', { bubbles: true }))
      nodeName.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton(container, 'Save and use profile').click()
    })

    expect(onSaveProfile).toHaveBeenCalledWith({
      ...profile,
      nodeName: 'Edited desktop',
    })
    expect(container.querySelector('input[name*="token" i]')).toBeNull()
    expect(container.querySelector('input[name*="secret" i]')).toBeNull()
  })

  it('renders a configured disconnected peer as offline without a transport error', async () => {
    const peer = new FakeBrowserPeer({
      status: 'failed',
      state: 'failed',
      expectedStablePeerId: 'peer-host',
      nodeName: 'Aurora host',
      diagnostic: 'WebRTC mesh transport is not connected; preferred-mode fallback is unavailable.',
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
        />,
      )
    })

    expect(container.textContent).toContain('Aurora host is offline')
    expect(container.textContent).toContain('Aurora will retry the saved device')
    expect(container.textContent).toContain('Address backupNot set')
    expect(container.textContent).not.toContain('Thin-shell transport')
    expect(container.textContent).not.toContain('WebRTC rollout disabled')
    expect(container.textContent).not.toContain(
      'WebRTC mesh transport is not connected',
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not expose a stored peer id when an offline device has no display name', async () => {
    const peer = new FakeBrowserPeer({
      status: 'failed',
      state: 'failed',
      expectedStablePeerId: 'peer-host',
      secretsPersisted: true,
      persistenceBackend: 'platform-keychain',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
        />,
      )
    })

    expect(container.textContent).toContain('Invited Aurora device is offline')
    expect(container.textContent).not.toContain('peer-host')
    expect(container.textContent).not.toContain('Aurora peer')
    expect(container.textContent).not.toContain('Aurora node')
  })

  it('imports an invite into secure storage before leaving configure-only onboarding', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const actions: string[] = []
    const onSaveProfile = vi.fn(async (
      _profile: ThinConnectionProfile,
      _roomSecret?: WebThinRoomSecret,
    ) => {
      actions.push('saved')
    })
    const onInviteAccepted = vi.fn(async () => {
      actions.push('accepted')
    })

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="http-only"
          transportKind="http"
          initialInviteText={inviteText()}
          configureOnly
          onSaveProfile={onSaveProfile}
          onInviteAccepted={onInviteAccepted}
        />
      )
    })

    expect(container.querySelector('[data-thin-invite-onboarding="true"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Thin connection profile"]')).toBeNull()
    expect(container.querySelector('#webthin-profile-mode')).toBeNull()
    expect(container.querySelector('#webthin-profile-gateway')).toBeNull()
    expect(container.querySelector('#webthin-profile-signaling')).toBeNull()
    expect(container.querySelector('#webthin-profile-stable-peer')).toBeNull()
    expect(container.textContent).not.toContain('Thin transport diagnostics')
    expect(container.textContent).not.toContain('Scan QR invite')

    const nodeName = container.querySelector<HTMLInputElement>('#webthin-profile-node-name')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(nodeName, 'Kitchen tablet')
      nodeName.dispatchEvent(new Event('input', { bubbles: true }))
      nodeName.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton(container, 'Save invite and continue').click()
      await Promise.resolve()
    })

    expect(onSaveProfile).toHaveBeenCalledTimes(1)
    expect(onSaveProfile.mock.calls[0]?.[0]).toMatchObject({
      mode: 'webrtc-only',
      signalingUrl: 'wss://broker.example/mqtt',
      nodeName: 'Kitchen tablet',
      webrtcProfile: {
        room: 'studio-room',
        roomSecretRef: 'ref:memory:studio-room',
        nodeName: 'Host node',
      },
    })
    expect(onSaveProfile.mock.calls[0]?.[1]).toEqual({
      roomSecretRef: 'ref:memory:studio-room',
      roomSecret: 'secret-room-password',
    })
    expect(actions).toEqual(['saved', 'accepted'])
    expect(peer.connectedProfiles).toHaveLength(0)
  })

  it('offers QR invite scanning only on mobile configure-only onboarding', async () => {
    const peer = new FakeBrowserPeer({
      status: 'needs-invite',
      diagnostic: 'http-only mode requires an HTTP endpoint',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="http-only"
          transportKind="native-mobile"
          nativePlatform="android"
          configureOnly
          onSaveProfile={async () => undefined}
        />
      )
    })

    expect(container.textContent).toContain('Scan invite')
    expect(container.textContent).toContain('Open invite file')
    expect(container.textContent).toContain('Paste invite')
    expect(container.textContent).not.toContain(
      'http-only mode requires an HTTP endpoint',
    )
  })

  it('fills the invite field from native/browser QR scan and an invite file', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const scannedInvite = inviteText()
    const onScanQr = vi.fn(async () => scannedInvite)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="mesh"
          onScanQr={onScanQr}
        />
      )
    })
    await act(async () => {
      findButton(container, 'Scan invite').click()
      await Promise.resolve()
    })
    expect(onScanQr).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(scannedInvite)

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['ignored by mocked text'], 'invite.aurora', {
      type: 'application/vnd.aurora.context+json',
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: async () => scannedInvite,
    })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(scannedInvite)
  })

  it('re-enables onboarding controls after a native QR scan is cancelled', async () => {
    const peer = new FakeBrowserPeer({ status: 'needs-invite' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const onScanQr = vi.fn(async () => null)

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-only"
          transportKind="native-mobile"
          nativePlatform="android"
          configureOnly
          onScanQr={onScanQr}
          onSaveProfile={async () => undefined}
        />
      )
    })
    await act(async () => {
      findButton(container, 'Scan invite').click()
      await Promise.resolve()
    })

    expect(onScanQr).toHaveBeenCalledTimes(1)
    expect(findButton(container, 'Scan invite').disabled).toBe(false)
    expect(findButton(container, 'Open invite file').disabled).toBe(false)
    expect(
      container.querySelector<HTMLInputElement>('#webthin-profile-node-name')
        ?.disabled,
    ).toBe(false)
    expect(container.textContent).not.toContain('Saving…')
    expect(container.textContent).not.toContain('QR scan failed')
  })

  it('warns that hosted HTTPS cannot override browser mixed-content blocking', () => {
    const profile = {
      id: 'cleartext',
      label: 'LAN',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'http://aurora.lan:8000',
      signalingUrl: 'ws://aurora.lan:9001/mqtt',
      nodeName: 'Hosted browser',
      localStablePeerId: 'hosted-browser-stable',
    }

    expect(hostedMixedContentWarning('web', profile, 'https:')).toContain(
      'Use a secure address',
    )
    expect(hostedMixedContentWarning('desktop-thin', profile, 'https:')).toBeNull()
    expect(hostedMixedContentWarning('web', profile, 'http:')).toBeNull()
  })

  it('re-enables profile controls after profile selection succeeds or fails', async () => {
    const peer = new FakeBrowserPeer({ status: 'idle' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const profile = {
      id: 'office',
      label: 'Office',
      mode: 'webrtc-preferred' as const,
      gatewayUrl: 'https://gateway.example.invalid',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora desktop',
      localStablePeerId: 'desktop-peer-01',
    }
    const home = { ...profile, id: 'home', label: 'Home' }
    const failing = { ...profile, id: 'failing', label: 'Failing' }
    const onSelectProfile = vi.fn(async (profileId: string) => {
      if (profileId === 'failing') throw new Error('token=secret failure')
    })

    await act(async () => {
      root.render(
        <WebThinConnectionPanel
          peer={peer as unknown as BrowserWebRtcPeerController}
          mode="webrtc-preferred"
          transportKind="mesh"
          profile={profile}
          profiles={[profile, home, failing]}
          onSaveProfile={async () => undefined}
          onSelectProfile={onSelectProfile}
        />
      )
    })

    const openAndChoose = async (label: string) => {
      await act(async () => {
        container.querySelector<HTMLElement>('#webthin-profile-select')?.click()
      })
      const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
        .find((candidate) => candidate.textContent?.includes(label))
      expect(item, `select item ${label}`).toBeTruthy()
      await act(async () => {
        item?.click()
      })
    }

    await openAndChoose('Home')
    expect(onSelectProfile).toHaveBeenCalledWith('home')
    expect(findButton(container, 'Save and use profile').hasAttribute('disabled')).toBe(false)

    await openAndChoose('Failing')
    expect(onSelectProfile).toHaveBeenCalledWith('failing')
    expect(findButton(container, 'Save and use profile').hasAttribute('disabled')).toBe(false)
    expect(container.textContent).toContain('Could not connect to this Aurora device')
    expect(container.textContent).not.toContain('token=secret')
  })

})

class FakeBrowserPeer {
  confirmed: string[] = []
  pairingApprovals: Array<PeerPairingApproval | undefined> = []
  connectedProfiles: WebRtcPeerConnectionProfile[] = []
  disconnectedReasons: string[] = []
  selectedCandidatePairEvidenceCalls = 0
  private snapshotValue: BrowserWebRtcSnapshot
  constructor(partial: Partial<BrowserWebRtcSnapshot> = {}, private readonly connectError: unknown = null) {
    this.snapshotValue = {
      state: 'awaiting-sas-confirmation',
      connectionMode: 'webrtc-only',
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
      updatedAt: new Date().toISOString(),
      status: 'pairing',
      secureContext: true,
      visible: true,
      focused: true,
      hasHttpFallback: false,
      secretsPersisted: false,
      ...partial,
    }
  }
  snapshot() { return this.snapshotValue }
  subscribe(listener: (snapshot: BrowserWebRtcSnapshot) => void) { listener(this.snapshotValue); return () => undefined }
  importInvite(invite: string) { return webRtcProfileFromInvite(invite)! }
  async connect(profile?: WebRtcPeerConnectionProfile) {
    if (this.connectError) throw this.connectError
    if (profile) this.connectedProfiles.push(profile)
    return undefined
  }
  async confirmPairing(sessionId: string, approval?: PeerPairingApproval) {
    this.confirmed.push(sessionId)
    this.pairingApprovals.push(approval)
  }
  async rejectPairing(_sessionId: string) { return undefined }
  async getSelectedCandidatePairEvidence() {
    this.selectedCandidatePairEvidenceCalls += 1
    return {
      selected: true,
      category: 'prflx' as const,
      pairState: 'succeeded',
      nominated: true,
      localCandidateType: 'prflx',
      remoteCandidateType: 'host',
      localProtocol: 'udp',
      remoteProtocol: 'udp',
      stunServerReflexiveCandidate: {
        gathered: true,
        candidateType: 'srflx',
        urlScheme: 'stun',
        urlMatchesConfiguredStunServer: true,
        configuredStunServerCount: 1,
        statsSource: 'RTCPeerConnection.getStats',
        rawAddressRedacted: true,
      },
      statsSource: 'RTCPeerConnection.getStats' as const,
      rawAddressRedacted: true as const,
    }
  }
  async disconnect(reason?: string) { this.disconnectedReasons.push(reason ?? 'disconnect'); return undefined }
}

function inviteText(
  broker = 'wss://broker.example/mqtt',
): string {
  const invite: JsonObject = {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: '2026-07-26T00:00:00Z',
    node: { peer_id: 'peer-host', node_name: 'Host node' },
    signaling: {
      provider: 'mqtt',
      app_id: 'aurora',
      room: 'studio-room',
      room_password: 'secret-room-password',
      mqtt_brokers: [broker],
    },
    webrtc: { app_layer_e2ee: true, stun_servers: ['stun:stun.example:19302'], turn_servers: [] },
  }
  return encodeMeshInviteToken(invite)
}

function hostileAuroraError(correlationId = 'corr-hostile'): AuroraError {
  return new AuroraError({
    code: 'transport_loss',
    status: 502,
    method: 'Gateway.Events',
    busTopic: 'TTS.AudioChunk',
    correlationId,
    detail: {
      reason: 'WebRTC runtime transport provider manifest protocol token=secret',
    },
    message: 'WebRTC runtime transport provider manifest protocol token=secret',
  })
}

async function hostileGatewayFetch(): Promise<Response> {
  return new Response(
    JSON.stringify({
      message: 'WebRTC runtime transport provider manifest protocol token=secret',
      detail: {
        reason: 'WebRTC runtime transport provider manifest protocol token=secret',
      },
    }),
    { status: 502 },
  )
}

function streamRequest(): AuroraStreamRequest {
  return {
    stream: 'generic',
    topics: ['TTS.AudioChunk'],
    kinds: ['tts.audio_chunk'],
    reconnect: { maxAttempts: 0 },
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`button ${text} not found`)
  return button
}

function expectProductionCopyClean(value: string): void {
  expect(findForbiddenProductionCopyTerms(value)).toEqual([])
  expect(value).not.toMatch(
    /\b(?:runtime|thin|WebRTC|transport|consumer|provider|manifest|protocol|HTTP|WSS?|signaling|datachannel|fallback)\b/i,
  )
}


class FakeSignalingClient {
  signalingPeerId = 'local-z'
  private handlers = new Set<(message: any) => void>()
  snapshot() { return { selectedBrokerOrigin: 'wss://broker.example' } }
  diagnostics() { return { attempts: [], reconnectCount: 0 } }
  onMessage(handler: (message: any) => void) { this.handlers.add(handler); return () => this.handlers.delete(handler) }
  async connect(_room: any) {
    queueMicrotask(() => {
      for (const handler of this.handlers) handler({
        channel: 'presence',
        from: 'remote-a',
        stablePeerId: 'peer-host',
        envelope: { type: 'presence', peer_id: 'remote-a', stable_peer_id: 'peer-host' },
        topic: 'presence',
        raw: new Uint8Array(),
      })
    })
  }
  async close() { return undefined }
  async send() { return undefined }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  }
}
