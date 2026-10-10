import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MeshSummaryCards } from '../src/mesh-peers-sections'
import { meshInviteReadiness, type MeshPeersSnapshot } from '../src/mesh-peers-view'

function meshSnapshot(): MeshPeersSnapshot {
  return {
    loadState: 'ready',
    generatedAt: '2026-09-16T00:00:00.000Z',
    localPeerId: 'local-peer',
    localNodeName: 'Kitchen Aurora',
    meshEnabled: true,
    meshStarted: true,
    webrtcStarted: true,
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
    runtimePeerCount: 2,
    liveSessionCount: 1,
    deviceCount: 0,
    routeCount: 0,
    compatibilityFailures: [],
    listState: 'available-local',
    listReason: 'Device list loaded.',
    statusState: 'available-local',
    statusReason: 'Connection status loaded.',
    mutationState: 'available-local',
    mutationReason: 'Device actions are available.',
    config: {
      fields: [],
      state: 'available-local',
      reason: 'Settings loaded.',
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

describe('mesh peer view decomposition', () => {
  it('keeps summary card product copy in the extracted section', () => {
    const markup = renderToStaticMarkup(<MeshSummaryCards snapshot={meshSnapshot()} pendingPeers={0} />)

    expect(markup).toContain('This device')
    expect(markup).toContain('Kitchen Aurora')
    expect(markup).toContain('Connected devices')
    expect(markup).toContain('2 saved · 1 online')
    expect(markup).toContain('No requests waiting')
    expect(markup).toContain('Ready for device connections')
  })

  it('keeps invite readiness unavailable when required shared credentials are absent', () => {
    expect(meshInviteReadiness(meshSnapshot())).toEqual({
      ready: false,
      reason: 'Private invite protection must be ready before creating an invite.',
    })
  })
})
