// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import {
  encodeMeshInviteToken,
  loadingShellSnapshot,
  parseWebRtcInvite,
  type BrowserWebRtcSnapshot,
} from '@aurora/ui'

const mockedBrowserRuntime = vi.hoisted(() => ({
  requiresOnboarding: true,
  runtime: null as unknown as {
    client: AuroraClient
    peer: unknown
    mode: 'http-only'
  },
  profile: undefined as undefined,
  document: {
    version: 1 as const,
    activeProfileId: null,
    profiles: [],
  },
  save: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

vi.mock('./aurora-client', () => ({
  auroraBrowserRequiresOnboarding: () =>
    mockedBrowserRuntime.requiresOnboarding,
  auroraBrowserThinProfile: () => mockedBrowserRuntime.profile,
  auroraBrowserThinProfileDocument: () => mockedBrowserRuntime.document,
  createAuroraBrowserRuntime: () => mockedBrowserRuntime.runtime,
  saveAuroraBrowserThinProfile: mockedBrowserRuntime.save,
}))

import { PathAwareShell } from './path-aware-shell'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
  mockedBrowserRuntime.save.mockReset()
})

describe('hosted web thin first-run shell', () => {
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
    mockedBrowserRuntime.runtime = {
      client: new AuroraClient({ transport }),
      peer: fakePeer(parsedInvite!.profile),
      mode: 'http-only',
    }
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
    expect(container.textContent).toContain('Node name')
    expect(container.textContent).toContain('Paste mesh invite')
    expect(container.textContent).toContain('Open invite file')
    expect(container.textContent).not.toContain('Scan QR invite')
    expect(container.textContent).not.toContain('HTTP Gateway endpoint')
    expect(container.textContent).not.toContain('WebSocket signaling endpoint')
    expect(container.textContent).not.toContain('Connection mode')
    expect(container.textContent).not.toContain('Stable peer ID')
    expect(container.textContent).not.toContain('configured shell content')
    expect(
      container.querySelector('[data-onboarding-scroll-viewport="true"]'),
    ).not.toBeNull()
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
      {
        roomSecretRef: parsedInvite!.profile.roomSecretRef,
        roomSecret: 'fragment-secret',
      },
    )
    expect(request).not.toHaveBeenCalled()
  })
})

function fakePeer(importedProfile?: NonNullable<ReturnType<typeof parseWebRtcInvite>>['profile']) {
  const snapshot: BrowserWebRtcSnapshot = {
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
