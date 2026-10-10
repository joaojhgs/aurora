// @vitest-environment jsdom

import { StrictMode, act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import {
  encodeMeshInviteToken,
  getAuroraSurfaceProfile,
  loadingShellSnapshot,
  parseWebRtcInvite,
  useConnectionStore,
  type BrowserWebRtcSnapshot,
  type AuroraShellSnapshot,
} from '@aurora/ui'

const mockedBrowserRuntime = vi.hoisted(() => ({
  requiresOnboarding: true,
  runtime: null as unknown as ReturnType<typeof testBrowserRuntime>,
  profile: undefined as undefined,
  document: {
    version: 1 as const,
    activeProfileId: null,
    profiles: [],
  },
  runtimeDocument: {
    version: 2 as const,
    activeProfileId: null,
    profiles: [],
  } as {
    version: 2
    activeProfileId: string | null
    profiles: Array<Record<string, unknown>>
  },
  save: vi.fn(),
  createRuntime: vi.fn(),
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
}))

const mockedUi = vi.hoisted(() => ({
  fetchAuroraShellSnapshot: vi.fn(),
}))

vi.mock('@aurora/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aurora/ui')>()
  return {
    ...actual,
    fetchAuroraShellSnapshot: mockedUi.fetchAuroraShellSnapshot,
  }
})

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    replace: mockedBrowserRuntime.routerReplace,
    push: mockedBrowserRuntime.routerPush,
  }),
}))

vi.mock('./aurora-client', () => ({
  AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT: 'aurora-browser-voice-packs-changed',
  auroraBrowserRequiresOnboarding: () =>
    mockedBrowserRuntime.requiresOnboarding,
  auroraBrowserRuntimeProfile: () =>
    mockedBrowserRuntime.runtimeDocument.profiles.find(
      (profile) => profile.id === mockedBrowserRuntime.runtimeDocument.activeProfileId,
    ),
  auroraBrowserRuntimeProfileDocument: () => mockedBrowserRuntime.runtimeDocument,
  createAuroraBrowserRuntimeAsync: async () => {
    mockedBrowserRuntime.createRuntime()
    return mockedBrowserRuntime.runtime
  },
  saveAuroraBrowserOnboardingProfile: mockedBrowserRuntime.save,
}))

import {
  PathAwareShell,
  browserRuntimePeerScopeFromSnapshot,
  startBoundedSerialShellRefresh,
} from './path-aware-shell'
import { useBrowserRuntimeProfile } from './browser-shell-runtime'

const roots: Root[] = []

beforeEach(() => {
  mockedUi.fetchAuroraShellSnapshot.mockReset()
  mockedUi.fetchAuroraShellSnapshot.mockResolvedValue(
    readyShellSnapshot('Home Aurora'),
  )
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
  mockedBrowserRuntime.requiresOnboarding = true
  mockedBrowserRuntime.save.mockReset()
  mockedBrowserRuntime.createRuntime.mockReset()
  mockedBrowserRuntime.routerReplace.mockReset()
  mockedBrowserRuntime.routerPush.mockReset()
  mockedUi.fetchAuroraShellSnapshot.mockReset()
  useConnectionStore.getState().reset()
  mockedBrowserRuntime.runtimeDocument = {
    version: 2,
    activeProfileId: null,
    profiles: [],
  }
})

describe('hosted web thin first-run shell', () => {
  it('hydrates through a deterministic boot shell before reading browser persistence', async () => {
    const transport = new MockAuroraTransport()
    mockedBrowserRuntime.runtime = testBrowserRuntime({ transport })
    const element = (
      <StrictMode>
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
        </PathAwareShell>
      </StrictMode>
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.innerHTML = renderToString(element)

    expect(container.querySelector('[data-browser-shell-boot="true"]')).not.toBeNull()
    expect(mockedBrowserRuntime.createRuntime).not.toHaveBeenCalled()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let root: Root | null = null
    try {
      await act(async () => {
        root = hydrateRoot(container, element)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      if (root) roots.push(root)
      expect(container.textContent).toContain('Connect to Aurora')
      expect(mockedBrowserRuntime.createRuntime).toHaveBeenCalled()
      expect(mockedBrowserRuntime.runtime.close).not.toHaveBeenCalled()
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) => String(value).includes('Hydration failed')),
        ),
      ).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders connection onboarding, consumes a fragment invite, and makes no transport requests', async () => {
    const transport = new MockAuroraTransport()
    const request = vi.spyOn(transport, 'request')
    const invite = encodeMeshInviteToken({
      kind: 'aurora.mesh.invite',
      version: 1,
      generated_at: '2026-07-27T00:00:00Z',
      node: {
        peer_id: 'host-peer',
        node_name: 'Aurora host',
      },
      signaling: {
        provider: 'mqtt',
        app_id: 'aurora',
        room: 'hosted-first-run',
        room_password: 'fragment-secret',
        mqtt_brokers: ['wss://signal.example.test/mqtt'],
      },
      webrtc: {
        app_layer_e2ee: true,
        stun_servers: [],
        turn_servers: [],
      },
    })
    const parsedInvite = parseWebRtcInvite(invite)
    expect(parsedInvite).not.toBeNull()
    mockedBrowserRuntime.runtime = testBrowserRuntime({
      transport,
      peer: fakePeer(parsedInvite!.profile),
    })
    window.history.replaceState(
      {},
      '',
      `/#invite=${encodeURIComponent(invite)}`,
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
        </PathAwareShell>,
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Connect to Aurora')
    expect(container.textContent).toContain('Continue')
    expect(container.textContent).not.toContain('This device name')
    expect(container.textContent).not.toContain('Paste invite')
    expect(container.textContent).not.toContain('Open invite file')
    expect(container.textContent).not.toContain('Scan QR invite')
    expect(container.textContent).not.toContain('HTTP Gateway endpoint')
    expect(container.textContent).not.toContain('WebSocket signaling endpoint')
    expect(container.textContent).not.toContain('Connection mode')
    expect(container.textContent).not.toContain('Stable peer ID')
    expect(container.textContent).not.toContain('configured shell content')

    const roleContinueButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Continue')
    expect(roleContinueButton).toBeDefined()
    await act(async () => {
      roleContinueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('This device name')
    expect(container.textContent).toContain('Paste invite')
    expect(container.textContent).toContain('Open invite file')
    expect(container.textContent).not.toContain('Scan QR invite')
    expect(container.querySelector<HTMLTextAreaElement>('#webthin-invite')?.value)
      .toBe(invite)
    expect(window.location.hash).not.toContain('invite=')
    expect(request).not.toHaveBeenCalled()

    const continueButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save invite and continue'))
    expect(continueButton).toBeDefined()
    await act(async () => {
      continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mockedBrowserRuntime.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'webrtc-only',
        webrtcProfile: expect.objectContaining({
          roomSecretRef: parsedInvite!.profile.roomSecretRef,
        }),
      }),
      'remote-console',
      {
        roomSecretRef: parsedInvite!.profile.roomSecretRef,
        roomSecret: 'fragment-secret',
      },
    )
    expect(mockedBrowserRuntime.routerReplace).toHaveBeenCalledWith('/mesh')
    expect(request).not.toHaveBeenCalled()
  })

  it('saves a manual address profile and leaves hosted-web onboarding', async () => {
    const transport = new MockAuroraTransport()
    const request = vi.spyOn(transport, 'request')
    mockedBrowserRuntime.runtime = testBrowserRuntime({ transport })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
        </PathAwareShell>,
      )
      await Promise.resolve()
    })

    const roleContinueButton = buttonByText(container, 'Continue')
    await act(async () => {
      roleContinueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText(container, 'Connect with an address')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const endpoint = container.querySelector<HTMLInputElement>('#aurora-endpoint')
    expect(endpoint).not.toBeNull()
    await act(async () => {
      setInputValue(endpoint!, 'https://gateway.example.test')
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText(container, 'Use this address')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mockedBrowserRuntime.save).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Aurora address',
        mode: 'http-only',
        gatewayUrl: 'https://gateway.example.test',
        signalingUrl: '',
        nodeName: 'Aurora device',
      }),
      'remote-console',
    )
    expect(mockedBrowserRuntime.routerReplace).toHaveBeenCalledWith('/mesh')
    expect(request).not.toHaveBeenCalled()
  })

  it('loads v2 node-mode context without requiring a v1 connection profile projection', async () => {
    const transport = new MockAuroraTransport()
    mockedBrowserRuntime.runtime = testBrowserRuntime({ transport })
    mockedBrowserRuntime.runtimeDocument = {
      version: 2,
      activeProfileId: 'mesh',
      profiles: [{
        version: 2,
        id: 'mesh',
        label: 'This device',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
        localNode: {
          nodeName: 'Hosted browser',
          stablePeerId: 'browser-peer',
          enabledCapabilityPacks: [],
          meshMembership: {
            signalingUrl: 'wss://signaling.example.invalid',
            webrtcProfile: {
              mode: 'webrtc-only',
              appId: 'aurora',
              room: 'mesh-room',
              roomSecretRef: 'ref:browser:mesh-room',
              signalingBrokers: ['wss://signaling.example.invalid'],
            },
          },
        },
      }],
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
        </PathAwareShell>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (root) roots.push(root)

    expect(container.textContent).toContain('Connect to Aurora')
    expect(mockedBrowserRuntime.createRuntime).toHaveBeenCalled()
    expect(mockedBrowserRuntime.save).not.toHaveBeenCalled()
  })

  it('keeps configured shell navigation inside the persistent browser runtime', async () => {
    const transport = new MockAuroraTransport()
    mockedBrowserRuntime.requiresOnboarding = false
    mockedBrowserRuntime.runtimeDocument = {
      version: 2,
      activeProfileId: 'mesh',
      profiles: [{
        version: 2,
        id: 'mesh',
        label: 'This device',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
        localNode: {
          nodeName: 'Hosted browser',
          stablePeerId: 'browser-peer',
          enabledCapabilityPacks: [],
        },
      }],
    }
    mockedBrowserRuntime.runtime = testBrowserRuntime({
      transport,
      nodeMode: 'mesh-node',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
          <RuntimeProfileProbe />
        </PathAwareShell>,
      )
      await Promise.resolve()
    })

    const toolsLink = [...container.querySelectorAll<HTMLAnchorElement>('a')]
      .find((link) => link.textContent?.includes('Tools & Plugins'))
    expect(toolsLink).toBeDefined()

    await act(async () => {
      toolsLink?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })

    expect(mockedBrowserRuntime.routerPush).toHaveBeenCalledWith('/tools')
    expect(mockedBrowserRuntime.createRuntime).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('runtime-profile:mesh-node')
  })

  it('derives a new query peer scope when a ready peer identity changes', () => {
    expect(
      browserRuntimePeerScopeFromSnapshot({ connectedStablePeerId: 'peer-a' }, 'auth-peer'),
    ).toBe('peer-a')
    expect(
      browserRuntimePeerScopeFromSnapshot({ connectedStablePeerId: 'peer-b' }, 'auth-peer'),
    ).toBe('peer-b')
  })

  it('falls back to expected peer identity before the auth snapshot', () => {
    expect(
      browserRuntimePeerScopeFromSnapshot({ expectedStablePeerId: 'expected-peer' }, 'auth-peer'),
    ).toBe('expected-peer')
    expect(browserRuntimePeerScopeFromSnapshot({}, 'auth-peer')).toBe('auth-peer')
    expect(browserRuntimePeerScopeFromSnapshot({}, null)).toBeNull()
  })

  it('ignores a delayed shell snapshot from an earlier browser peer scope', async () => {
    const transport = new MockAuroraTransport()
    const peer = controllablePeer({
      ...basePeerSnapshot(),
      status: 'authorized',
      expectedStablePeerId: 'peer-a',
    })
    mockedBrowserRuntime.requiresOnboarding = false
    mockedBrowserRuntime.runtimeDocument = {
      version: 2,
      activeProfileId: 'remote',
      profiles: [{
        version: 2,
        id: 'remote',
        label: 'Office Aurora',
        nodeMode: 'remote-console',
        runtimeTier: 'none',
        homeConnection: {
          version: 1,
          id: 'remote',
          label: 'Office Aurora',
          mode: 'http-only',
          gatewayUrl: 'https://gateway.example.test',
          signalingUrl: '',
          nodeName: 'Office Aurora',
        },
      }],
    }
    mockedBrowserRuntime.runtime = testBrowserRuntime({
      transport,
      peer,
    })
    const pending: Array<{
      scopeId: string
      signal?: AbortSignal
      resolve: (snapshot: AuroraShellSnapshot) => void
    }> = []
    mockedUi.fetchAuroraShellSnapshot.mockImplementation(({ scopeKey, signal }) => new Promise((resolve) => {
      pending.push({
        scopeId: scopeKey[1],
        signal,
        resolve: resolve as (snapshot: AuroraShellSnapshot) => void,
      })
    }))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <PathAwareShell
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
          }}
        >
          <p>configured shell content</p>
        </PathAwareShell>,
      )
    })
    await waitFor(() => pending.length > 0)
    const firstScope = pending[pending.length - 1]!.scopeId

    await act(async () => {
      peer.emit({
        ...basePeerSnapshot(),
        status: 'authorized',
        expectedStablePeerId: 'peer-b',
      })
    })
    await waitFor(() => pending.some((request) => request.scopeId !== firstScope))

    const oldRequests = pending.filter((request) => request.scopeId === firstScope)
    const newRequest = [...pending].reverse().find((request) => request.scopeId !== firstScope)
    expect(newRequest).toBeDefined()
    expect(oldRequests[0]?.signal?.aborted).toBe(true)

    await act(async () => {
      newRequest!.resolve(readyShellSnapshot('Peer B'))
    })
    await waitFor(() => container.textContent?.includes('Peer B') === true)
    expect(container.textContent).toContain('Peer B')

    await act(async () => {
      for (const request of oldRequests) request.resolve(readyShellSnapshot('Peer A'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Peer B')
    expect(container.textContent).not.toContain('Peer A')
  })

  it('stops a no-event recovery loop and aborts its active refresh', async () => {
    vi.useFakeTimers()
    const pending: Array<() => void> = []
    const signals: AbortSignal[] = []
    const refresh = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<void>((resolve) => {
        pending.push(resolve)
      })
    })

    const stopRecoveryRefresh = startBoundedSerialShellRefresh(refresh, 100)
    await act(async () => {
      await Promise.resolve()
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.shift()?.()
      await Promise.resolve()
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(refresh).toHaveBeenCalledTimes(2)

    stopRecoveryRefresh()
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => {
      pending.shift()?.()
      await Promise.resolve()
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('drives mounted recovery refreshes from stream loss and coalesces live events', async () => {
    vi.useFakeTimers()
    useConnectionStore.getState().reset()
    mockedBrowserRuntime.requiresOnboarding = false
    const transport = new MockAuroraTransport()
    const healthStream = controlledEventStream()
    const configStream = controlledEventStream()
    transport.stream('health', healthStream.registration)
    transport.stream('config', configStream.registration)
    mockedBrowserRuntime.runtime = testBrowserRuntime({ transport })
    const requests: Array<{
      resolve: (snapshot: AuroraShellSnapshot) => void
      signal?: AbortSignal
      forceRefresh?: boolean
    }> = []
    let activeRequests = 0
    let maxActiveRequests = 0
    mockedUi.fetchAuroraShellSnapshot.mockImplementation(({ signal, forceRefresh }) => new Promise((resolve) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      requests.push({
        resolve: (snapshot) => {
          activeRequests -= 1
          resolve(snapshot)
        },
        signal,
        forceRefresh,
      })
    }))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <PathAwareShell snapshot={{ ...loadingShellSnapshot, loadState: 'ready' }}>
          <p>configured shell content</p>
        </PathAwareShell>,
      )
      await Promise.resolve()
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.forceRefresh).toBeUndefined()
    expect(maxActiveRequests).toBe(1)

    await act(async () => {
      requests[0]!.resolve(readyShellSnapshot('Initial'))
      await Promise.resolve()
    })
    useConnectionStore.getState().setStreamState('health', 'connected')
    useConnectionStore.getState().setStreamState('config', 'connected')
    await act(async () => {
      vi.advanceTimersByTime(16_000)
      await Promise.resolve()
    })
    expect(requests).toHaveLength(1)

    await act(async () => {
      useConnectionStore.getState().setStreamState('health', 'reconnecting')
      await Promise.resolve()
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.forceRefresh).toBe(true)
    expect(maxActiveRequests).toBe(1)
    const recoveryRequest = requests[1]!

    // A live event requests the same snapshot while recovery is unresolved;
    // the bridge must coalesce it and refresh once after settlement.
    await act(async () => {
      configStream.push({
        id: 'config-1',
        topic: 'Gateway.StatusChanged',
        kind: 'config.updated',
        payload: {},
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(requests).toHaveLength(2)
    await act(async () => {
      useConnectionStore.getState().setStreamState('health', 'connected')
      useConnectionStore.getState().setStreamState('config', 'connected')
      await Promise.resolve()
    })
    expect(recoveryRequest.signal?.aborted).toBe(true)
    await act(async () => {
      recoveryRequest.resolve(readyShellSnapshot('Stale'))
      await Promise.resolve()
    })
    // The read captured before the event must not overwrite the event patch;
    // its single queued follow-up is the only request allowed to restore data.
    expect(container.textContent).not.toContain('Stale')
    expect(requests).toHaveLength(3)
    expect(requests[2]?.forceRefresh).toBeUndefined()
    expect(maxActiveRequests).toBe(1)

    const latestRequest = requests[2]!
    latestRequest.resolve(readyShellSnapshot('Fresh'))
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(30_001)
      await Promise.resolve()
    })
    expect(requests).toHaveLength(3)
    expect(container.textContent).toContain('Fresh')
    expect(container.textContent).not.toContain('Stale')
    expect(maxActiveRequests).toBe(1)
    root.unmount()
    vi.useRealTimers()
  })

  it('does not schedule another read when recovery ends without a live event', async () => {
    vi.useFakeTimers()
    useConnectionStore.getState().reset()
    mockedBrowserRuntime.requiresOnboarding = false
    const transport = new MockAuroraTransport()
    const healthStream = controlledEventStream()
    const configStream = controlledEventStream()
    transport.stream('health', healthStream.registration)
    transport.stream('config', configStream.registration)
    mockedBrowserRuntime.runtime = testBrowserRuntime({ transport })
    const requests: Array<{
      resolve: (snapshot: AuroraShellSnapshot) => void
      signal?: AbortSignal
    }> = []
    let activeRequests = 0
    let maxActiveRequests = 0
    mockedUi.fetchAuroraShellSnapshot.mockImplementation(({ signal }) => new Promise((resolve) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      requests.push({
        resolve: (snapshot) => {
          activeRequests -= 1
          resolve(snapshot)
        },
        signal,
      })
    }))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <PathAwareShell snapshot={{ ...loadingShellSnapshot, loadState: 'ready' }}>
          <p>configured shell content</p>
        </PathAwareShell>,
      )
      await Promise.resolve()
    })
    expect(requests).toHaveLength(1)

    await act(async () => {
      requests[0]!.resolve(readyShellSnapshot('Initial'))
      await Promise.resolve()
      useConnectionStore.getState().setStreamState('health', 'connected')
      useConnectionStore.getState().setStreamState('config', 'connected')
      await Promise.resolve()
    })
    await act(async () => {
      useConnectionStore.getState().setStreamState('health', 'reconnecting')
      await Promise.resolve()
    })
    expect(requests).toHaveLength(2)
    const recoveryRequest = requests[1]!

    await act(async () => {
      useConnectionStore.getState().setStreamState('health', 'connected')
      useConnectionStore.getState().setStreamState('config', 'connected')
      await Promise.resolve()
    })
    expect(recoveryRequest.signal?.aborted).toBe(true)
    await act(async () => {
      recoveryRequest.resolve(readyShellSnapshot('Recovered'))
      await Promise.resolve()
      vi.advanceTimersByTime(30_001)
      await Promise.resolve()
    })
    expect(requests).toHaveLength(2)
    expect(maxActiveRequests).toBe(1)
    root.unmount()
    vi.useRealTimers()
  })
})


function testBrowserRuntime({
  transport,
  peer = fakePeer(),
  nodeMode = 'remote-console',
}: {
  transport: MockAuroraTransport
  peer?: ReturnType<typeof fakePeer> | ReturnType<typeof controllablePeer>
  nodeMode?: 'remote-console' | 'mesh-node'
}) {
  const surface = getAuroraSurfaceProfile({
    runtimeMode: 'web-thin',
    transportKind: 'http',
    nodeMode,
    runtimeTier: nodeMode === 'mesh-node' ? 'lightweight-ts' : 'none',
  })
  return {
    client: new AuroraClient({ transport }),
    peer,
    mode: 'http-only' as const,
    surface,
    features: {
      requestedNodeRole: nodeMode,
      activeNodeRole: nodeMode,
      meshNodeRuntimeEnabled: nodeMode === 'mesh-node',
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
      usesBrowserVoiceRuntime: surface.usesBrowserVoiceRuntime,
      focusedPushToTalkOwner: surface.voiceCapture.focusedPushToTalkOwner,
      wakewordOwner: surface.voiceCapture.wakewordOwner,
      localSpeechPack: surface.localSpeechPack,
    },
    localNodeProviderStatus: {
      available: false,
      state: 'not-configured' as const,
      productMessage: 'This device is not set up for sharing.',
      registeredFeatureCount: 0,
      localDataWritable: false,
    },
    close: vi.fn(async () => undefined),
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function RuntimeProfileProbe() {
  const profile = useBrowserRuntimeProfile()
  return <p>runtime-profile:{profile?.nodeMode ?? 'none'}</p>
}

function readyShellSnapshot(nodeName: string): AuroraShellSnapshot {
  return {
    ...loadingShellSnapshot,
    loadState: 'ready',
    connectionState: 'connected',
    capabilityFreshness: 'fresh',
    nodeName,
    transportKind: 'mock',
    evidenceSource: 'test snapshot',
    error: null,
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for condition')
}

function controlledEventStream() {
  const queued: Array<Record<string, unknown>> = []
  let resolveNext: ((event: Record<string, unknown> | null) => void) | null = null
  let closed = false
  return {
    registration: async function* () {
      while (!closed) {
        const next = queued.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          resolveNext = resolve
        })
        if (!next) return
        yield next
      }
    },
    push(event: Record<string, unknown>) {
      if (resolveNext) {
        const resolve = resolveNext
        resolveNext = null
        resolve(event)
      } else {
        queued.push(event)
      }
    },
    close() {
      closed = true
      resolveNext?.(null)
      resolveNext = null
    },
  }
}

function basePeerSnapshot(): BrowserWebRtcSnapshot {
  return {
    state: 'idle',
    connectionMode: 'http-only',
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
    updatedAt: '2026-07-27T00:00:00Z',
    status: 'idle',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: false,
  }
}

function controllablePeer(initialSnapshot: BrowserWebRtcSnapshot) {
  let snapshot = initialSnapshot
  const listeners = new Set<(value: BrowserWebRtcSnapshot) => void>()
  return {
    snapshot: () => snapshot,
    subscribe: (listener: (value: BrowserWebRtcSnapshot) => void) => {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
    emit: (nextSnapshot: BrowserWebRtcSnapshot) => {
      snapshot = nextSnapshot
      for (const listener of listeners) listener(snapshot)
    },
    importInvite: vi.fn(),
    connect: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
    disconnect: vi.fn(),
  }
}

function fakePeer(importedProfile?: NonNullable<ReturnType<typeof parseWebRtcInvite>>['profile']) {
  const snapshot = basePeerSnapshot()
  return {
    snapshot: () => snapshot,
    subscribe: (listener: (value: BrowserWebRtcSnapshot) => void) => {
      listener(snapshot)
      return () => undefined
    },
    importInvite: vi.fn(() => importedProfile),
    connect: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
    disconnect: vi.fn(),
  }
}
