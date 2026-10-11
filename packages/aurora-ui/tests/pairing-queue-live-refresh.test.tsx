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
      })
      await vi.waitFor(() => expect(container.textContent).toContain('Pairing request sent to Aurora 2'))

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
      expect(container.textContent).not.toContain('reported by Auth')
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
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(container.textContent).toContain('No pending device or peer pairing requests'))
      expect(container.textContent).toContain('No pending device or peer pairing requests')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
      })

      expect(reads).toBeGreaterThanOrEqual(2)
      expect(container.textContent).toContain('Remote Aurora')
      expect(container.textContent).toContain('Aurora 2')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('refreshes the active queue after pairing exchange and exchanged credential revoke', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    let reads = 0
    const transport = MockAuroraTransport.empty()
      .register('Gateway.AdminActionDraft', (request) => ({
        action_id: `draft-${reads}`,
        nonce: 'nonce',
        digest: 'digest',
        method_id: String((request.payload as { method_id?: unknown })?.method_id ?? 'Auth.PairingExchange'),
        affected_resources: [],
        required_reason: true,
        required_reauth: true,
        required_phrase: null,
        expires_at: '2099-07-10T00:12:04Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }))
      .register('Gateway.AdminActionConfirm', () => ({
        action_id: 'draft',
        confirmation_token: 'confirmed',
        digest: 'digest',
        confirmed: true,
        expires_at: '2099-07-10T00:12:04Z',
        audit_receipt: 'pairing-refresh',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }))
      .register('Auth.ListPendingPairings', () => {
        reads += 1
        return { pairings: [], total: 0, expired_count: 0, secrets_redacted: true }
      })
      .register('Gateway.GetWebRTCDiagnostics', () => ({
        ...webrtcDiagnosticsFixture,
        mesh_enabled: false,
        peers: []
      }))
      .register('Auth.PairingExchange', () => ({
        token_id: 'token-exchanged',
        token: 'redacted-token',
        peer_id: null,
        device_id: 'device-exchanged',
        expires_at: '2099-07-10T00:12:04Z'
      }))
      .register('Auth.RevokeToken', () => ({ success: true }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<PairingQueueView client={new Aurora({ transport })} route={route} />)
      })
      await vi.waitFor(() => expect(container.textContent).toContain('Exchange and revoke'))
      await vi.waitFor(() => expect(reads).toBe(1))

      await act(async () => {
        container.querySelector<HTMLElement>('[aria-label="In-session administrator unlock confirmed"]')?.click()
      })
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>('#pairing-exchange-code')
        expect(input).toBeTruthy()
        setInputValue(input!, 'PAIR-123')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        buttonByText(container, 'Exchange pairing code').click()
      })

      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))
      await vi.waitFor(() => expect(container.textContent).toContain('token-exchanged'))

      await act(async () => {
        buttonByText(container, 'Revoke exchanged credential').click()
      })

      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3))
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}
