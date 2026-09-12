// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport, webrtcDiagnosticsFixture, type PendingPairingEntry } from '@aurora/client'
import { PairingQueueView } from '../src/pairing-queue-view'
import type { RouteAvailability } from '../src/shell-data'

const route = {
  item: {
    id: 'pairing',
    label: 'Pairing',
    href: '/admin/pairing',
    capabilityModule: 'Auth',
    capabilityMethod: 'ListPendingPairings',
    methodType: 'manage',
    privacyClass: 'credential',
    fallbackState: 'unsupported',
    adminGated: true,
    expectedTask: 'ADM-011',
  },
  state: 'available-local',
  explanation: 'Auth.ListPendingPairings is routeable.',
  providerLabel: 'local / Auth.ListPendingPairings',
  blockers: [],
  repairActions: [],
  candidateProviders: [],
  evidenceSources: ['capability-catalog'],
  selectorRequired: false,
  approvalRequired: false,
  routeable: true,
  disabled: false,
  requiresAdminAction: true,
} as RouteAvailability

const pendingPairing: PendingPairingEntry = {
  request_id: 'pairing-live-peer',
  code: '654321',
  device_name: 'Remote Aurora',
  client_ip: 'unknown',
  status: 'pending',
  expires_at: '2099-07-10T00:12:04Z',
  created_at: '2099-07-10T00:07:04Z',
  remote_peer_id: 'aurora-remote-peer',
  remote_node_name: 'Aurora 2',
  approved_by: null,
  denied_by: null,
  denied_reason: '',
  granted_permissions: [],
  granted_is_admin: false,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PairingQueueView live refresh', () => {
  it('shows bilateral negotiation instead of an unexplained empty queue', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const transport = MockAuroraTransport.empty()
      .register('Auth.ListPendingPairings', () => ({ pairings: [], total: 0, expired_count: 0, secrets_redacted: true }))
      .register('Gateway.GetWebRTCDiagnostics', () => ({
        ...webrtcDiagnosticsFixture,
        peers: [{
          ...webrtcDiagnosticsFixture.peers[0]!,
          node_name: 'Aurora 2',
          auth_state: 'anonymous',
          pairing_active: true,
          pending_pairing_task: true
        }]
      }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<PairingQueueView client={new Aurora({ transport })} route={route} />)
        await Promise.resolve()
      })

      expect(container.textContent).toContain('Pairing request sent to Aurora 2')
      expect(container.textContent).toContain('Both Auroras create an incoming request automatically')
      expect(container.textContent).toContain('approve independently on each Aurora')
      expect(container.textContent).not.toContain('Only the receiving Aurora shows an incoming pending request')
      expect(container.textContent).not.toContain('the reverse request will appear here for approval')
      expect(container.textContent).toContain('Outgoing pairing is active')
      expect(container.textContent).toContain('Mesh pairing creates requests automatically')
      expect(container.textContent).not.toContain('Create pairing code via AdminAction')
      expect(container.textContent).not.toContain('Pairing code to exchange')
      expect(container.textContent).not.toContain('No pending device or peer pairing requests were reported by Auth')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('discovers a pairing request created after the queue was opened', async () => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    let reads = 0
    const transport = MockAuroraTransport.empty().register('Auth.ListPendingPairings', () => {
      reads += 1
      const pairings = reads === 1 ? [] : [pendingPairing]
      return { pairings, total: pairings.length, expired_count: 0, secrets_redacted: true }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<PairingQueueView client={new Aurora({ transport })} route={route} />)
        await Promise.resolve()
      })
      expect(container.textContent).toContain('No pending device or peer pairing requests')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })

      expect(reads).toBeGreaterThanOrEqual(2)
      expect(container.textContent).toContain('Remote Aurora')
      expect(container.textContent).toContain('Aurora 2')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
