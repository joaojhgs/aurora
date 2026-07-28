// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
import { AppShell } from '../src/shell'
import { errorShellSnapshot, type AuroraShellSnapshot, type RouteAvailability } from '../src/shell-data'
import { MeshPeersView, type MeshPeersSnapshot } from '../src/mesh-peers-view'
import { OnboardingView } from '../src/onboarding-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import { ServiceRoutingView, type ServiceRoutingSnapshot } from '../src/service-routing-view'
import { HomeNodeConnectionPanel } from '../src/web-thin-connection-panel'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from '../src/web-thin-runtime'

describe('production UI copy', () => {
  it('keeps runtime-role surfaces free of internal wording', () => {
    const snapshot = safeShellSnapshot()
    const surfaces = [
      ['shell', <AppShell key="shell" snapshot={snapshot} runtimeMode="web-thin"><main>Ready</main></AppShell>],
      [
        'onboarding',
        <OnboardingView
          key="onboarding"
          client={client()}
          snapshot={snapshot}
          setupRequired
          thinConnectionPanel={<div>Use your Aurora invite to connect this device.</div>}
        />,
      ],
      [
        'home-node-connection',
        <HomeNodeConnectionPanel
          key="home-node-connection"
          peer={peerController()}
          mode="webrtc-preferred"
          transportKind="http"
          configureOnly
        />,
      ],
      ['mesh', <MeshPeersView key="mesh" snapshot={meshSnapshot()} route={route()} canManageLocalServiceConfiguration={false} />],
      ['service-sharing', <ServiceRoutingView key="service-sharing" snapshot={serviceRoutingSnapshot()} />],
    ] as const

    for (const [name, element] of surfaces) {
      const text = visibleText(renderToStaticMarkup(element))
      const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
      expect(matches, `${name} rendered forbidden copy in: ${text}`).toEqual([])
    }
  })
})

function visibleText(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function client(): AuroraClient {
  return {
    transport: { kind: 'http' },
    auth: {
      refreshClock: () => ({
        state: 'anonymous',
        isAuthenticated: false,
        isTerminal: false,
        isMeshPeer: false,
        principalId: null,
        principalName: null,
        permissions: [],
      }),
      subscribe: () => () => undefined,
      setPairingChallenge: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      validateToken: vi.fn(),
      pairingStart: vi.fn(),
      pairingExchange: vi.fn(),
    },
  } as unknown as AuroraClient
}

function safeShellSnapshot(): AuroraShellSnapshot {
  return {
    ...errorShellSnapshot('http', new Error('offline')),
    routes: [],
    routeCount: 0,
    blockedCount: 0,
    availableCount: 0,
    error: null,
  }
}

function route(): RouteAvailability {
  return {
    item: {
      id: 'mesh',
      label: 'Mesh',
      href: '/mesh',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetMeshStatus',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'degraded',
      adminGated: false,
      expectedTask: 'MESH-001',
    },
    state: 'available-local',
    explanation: 'ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function peerController(): BrowserWebRtcPeerController {
  const snapshot: BrowserWebRtcSnapshot = {
    state: 'closed',
    connectionMode: 'webrtc-preferred',
    expectedStablePeerId: 'home-node',
    nodeName: 'Home Aurora',
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
    updatedAt: '2026-07-28T00:00:00Z',
    status: 'closed',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: true,
    secretsPersisted: true,
    persistenceBackend: 'platform-keychain',
  }
  return {
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    importInvite: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    confirmPairing: vi.fn(),
    rejectPairing: vi.fn(),
  } as unknown as BrowserWebRtcPeerController
}

function meshSnapshot(): MeshPeersSnapshot {
  return {
    loadState: 'ready',
    generatedAt: '2026-07-28T00:00:00Z',
    localPeerId: 'local-peer',
    localNodeName: 'Home Aurora',
    meshEnabled: false,
    meshStarted: false,
    webrtcStarted: false,
    inviteConfig: null,
    secretsRedacted: true,
    peers: [],
    pendingRequests: [],
    liveSessions: [],
    devices: [],
    pendingCount: 0,
    approvedCount: 0,
    deniedCount: 0,
    removedCount: 0,
    runtimePeerCount: 0,
    liveSessionCount: 0,
    deviceCount: 0,
    routeCount: 0,
    compatibilityFailures: [],
    listState: 'available-local',
    listReason: 'No peers found.',
    statusState: 'available-local',
    statusReason: 'Mesh is off.',
    mutationState: 'available-local',
    mutationReason: 'Changes are available.',
    config: {
      fields: [],
      state: 'available-local',
      reason: 'Settings are available.',
      secretsRedacted: true,
      editable: true,
      warnings: [],
    },
    warnings: [],
    error: null,
    evidenceSource: 'Aurora',
    transportKind: 'http',
    fixtureOnly: false,
  }
}

function serviceRoutingSnapshot(): ServiceRoutingSnapshot {
  return {
    loadState: 'ready',
    rows: [],
    knownPeers: [],
    editable: true,
    registryMode: 'thread',
    warnings: [],
    error: null,
    evidenceSource: 'Aurora',
  }
}
