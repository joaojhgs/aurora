import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultMockAuroraFixtures, webrtcDiagnosticsFixture, type PendingPairingEntry } from '@aurora/client'
import {
  PairingQueueSurface,
  buildPairingAdminActionRequest,
  buildPairingCreateAdminActionRequest,
  buildPairingCredentialModel,
  buildPairingExchangeAdminActionRequest,
  buildPairingQueueModel,
  buildPairingTokenRevokeAdminActionRequest,
  pairingDeepLink
} from '../src/pairing-queue-view'
import { auroraEmbeddedNavItems, auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

describe('PairingQueueView admin pairing surface', () => {
  it('renders pending queue, expiry, audit, create, exchange, revoke, and honest QR/revoke contract states', () => {
    const model = buildPairingQueueModel({
      route: pairingRoute(),
      response: pairingResponse(),
      diagnostics: { ...webrtcDiagnosticsFixture, mesh_enabled: false }
    })
    const createdCredential = buildPairingCredentialModel({ code: 'PAIR-123456', expires_in_seconds: 300 }, 'audit-create-001')
    const markup = renderToStaticMarkup(
      <PairingQueueSurface
        model={model}
        route={pairingRoute()}
        adminReason="approve kitchen tablet"
        permissions="Gateway.use"
        createdCredential={createdCredential}
        exchangeCode="PAIR-123456"
        exchangeResult={{ tokenId: 'token-from-pairing', state: 'user', auditReceipt: 'audit-exchange-001', tokenSecretRedacted: true }}
        operation={{ status: 'success', message: 'AdminAction audit complete', auditReceipt: 'audit-latest-001' }}
      />
    )

    expect(model.total).toBe(3)
    expect(model.meshPairingManaged).toBe(false)
    expect(model.expiredCount).toBe(1)
    expect(markup).toContain('Pending device and peer pairing requests')
    expect(markup).toContain('Kitchen tablet')
    expect(markup).toContain('Expired wall panel')
    expect(markup).toContain('Expiry state')
    expect(markup).toContain('expired')
    expect(markup).toContain('Create pairing code via AdminAction')
    expect(markup).toContain('One-time pairing code')
    expect(markup).toContain('PAIR-123456')
    expect(markup).toContain('aurora://pairing/exchange?code=PAIR-123456')
    expect(markup).toContain('QR image unavailable')
    expect(markup).toContain('Exchange via AdminAction')
    expect(markup).toContain('Revoke exchanged token via AdminAction')
    expect(markup).toContain('Pending pairing revoke unavailable: missing backend contract Auth.PairingRevoke')
    expect(markup).toContain('audit-create-001')
    expect(markup).toContain('audit-exchange-001')
    expect(markup).toContain('AdminAction audit receipt: audit-latest-001')
    expect(markup).not.toContain('secret-token')
  })

  it('builds approve, deny, create, exchange, and revoke requests only after explicit AdminAction unlock', () => {
    const pending = pendingPairing()
    const approve = buildPairingAdminActionRequest(pending, 'approve', {
      reason: 'trust kitchen tablet',
      permissions: 'Gateway.use Auth.use',
      grantAdmin: true,
      reauthConfirmed: true
    })
    expect(approve).toEqual(
      expect.objectContaining({
        methodId: 'Auth.PairingApprove',
        payload: { code: 'mesh-pairing-secret', permissions: ['Gateway.use', 'Auth.use'], is_admin: true },
        reason: 'trust kitchen tablet',
        reauthConfirmed: true,
        path: '/api/Auth/PairingApprove'
      })
    )
    expect(approve.affectedResources).toEqual(expect.arrayContaining(['pairing:mesh-pairing-peer-kitchen', 'peer:peer-kitchen', 'device:Kitchen tablet']))

    const deny = buildPairingAdminActionRequest(pending, 'deny', { reason: 'wrong device', reauthConfirmed: true })
    expect(deny).toEqual(expect.objectContaining({
      methodId: 'Auth.PairingDeny',
      payload: { code: 'mesh-pairing-secret', reason: 'wrong device' },
      reauthConfirmed: true,
      path: '/api/Auth/PairingDeny'
    }))

    const create = buildPairingCreateAdminActionRequest({
      deviceName: 'Field iPad',
      remotePeerId: 'peer-field',
      remoteNodeName: 'Field node',
      reason: 'enroll field device',
      reauthConfirmed: true
    })
    expect(create).toEqual(expect.objectContaining({
      methodId: 'Auth.PairingStart',
      payload: { device_name: 'Field iPad', remote_peer_id: 'peer-field', remote_node_name: 'Field node' },
      reauthConfirmed: true,
      path: '/api/Auth/PairingStart'
    }))

    const exchange = buildPairingExchangeAdminActionRequest({ code: 'PAIR-123456', reason: 'exchange on behalf of device', reauthConfirmed: true })
    expect(exchange).toEqual(expect.objectContaining({
      methodId: 'Auth.PairingExchange',
      payload: { code: 'PAIR-123456' },
      reauthConfirmed: true,
      path: '/api/Auth/PairingExchange'
    }))
    expect(JSON.stringify(exchange.affectedResources)).not.toContain('PAIR-123456')

    const revoke = buildPairingTokenRevokeAdminActionRequest({ tokenId: 'token-from-pairing', reason: 'revoke exchanged token', reauthConfirmed: true })
    expect(revoke).toEqual(expect.objectContaining({
      methodId: 'Auth.RevokeToken',
      payload: { token_id: 'token-from-pairing' },
      reauthConfirmed: true,
      path: '/api/Auth/RevokeToken'
    }))
  })


  it('rejects the prior hardcoded AdminAction submission path without explicit unlock', () => {
    const pending = pendingPairing()
    expect(() => buildPairingAdminActionRequest(pending, 'approve', {
      reason: 'trust kitchen tablet',
      permissions: 'Gateway.use Auth.use',
      grantAdmin: true
    })).toThrow('reauthConfirmed')
    expect(() => buildPairingCreateAdminActionRequest({
      deviceName: 'Field iPad',
      remotePeerId: 'peer-field',
      remoteNodeName: 'Field node',
      reason: 'enroll field device'
    })).toThrow('reauthConfirmed')
  })

  it('disables AdminAction mutations when the pairing route is not permission-routeable', () => {
    const route = { ...pairingRoute(), disabled: true, state: 'denied' as const, explanation: 'permission denied by Auth.ListPendingPairings' }
    const model = buildPairingQueueModel({ route })
    const markup = renderToStaticMarkup(<PairingQueueSurface model={model} route={route} />)

    expect(model.disabledReason).toContain('permission denied')
    expect(markup).toContain('Capability unavailable')
    expect(markup).toContain('disabled=""')
  })

  it('shows bilateral negotiation progress without one-sided or manual instructions', () => {
    const diagnostics = {
      ...webrtcDiagnosticsFixture,
      peers: [{
        ...webrtcDiagnosticsFixture.peers[0]!,
        node_name: 'Aurora 2',
        auth_state: 'anonymous',
        pairing_active: true,
        pending_pairing_task: true
      }]
    }
    const waitingModel = buildPairingQueueModel({
      route: pairingRoute(),
      response: { pairings: [], total: 0, expired_count: 0, secrets_redacted: true },
      diagnostics
    })
    const waitingMarkup = renderToStaticMarkup(<PairingQueueSurface model={waitingModel} route={pairingRoute()} />)

    expect(waitingModel.state).toBe('pending')
    expect(waitingModel.meshPairingManaged).toBe(true)
    expect(waitingModel.outgoingPeers).toEqual([{ peerId: 'stable-peer', nodeName: 'Aurora 2' }])
    expect(waitingMarkup).toContain('Pairing request sent to')
    expect(waitingMarkup).toContain('Aurora 2')
    expect(waitingMarkup).toContain('Both Auroras create an incoming request automatically')
    expect(waitingMarkup).not.toContain('Only the receiving Aurora shows an incoming pending request')
    expect(waitingMarkup).not.toContain('the reverse request will appear here for approval')
    expect(waitingMarkup).toContain('Outgoing pairing is active')
    expect(waitingMarkup).toContain('Mesh pairing creates requests automatically')
    expect(waitingMarkup).toContain('Manual Create pairing code and Exchange controls are disabled while mesh mode is active')
    expect(waitingMarkup).not.toContain('Create pairing code via AdminAction')
    expect(waitingMarkup).not.toContain('Exchange via AdminAction')

    const receivingRequest = { ...pendingPairing(), expires_at: '2099-01-01T00:00:00Z' }
    const receivingModel = buildPairingQueueModel({
      route: pairingRoute(),
      response: { pairings: [receivingRequest], total: 1, expired_count: 0, secrets_redacted: true },
      diagnostics
    })
    expect(receivingModel.outgoingPeers).toEqual([])
  })

  it('keeps manual bearer-code controls hidden while mesh diagnostics are unavailable', () => {
    const model = buildPairingQueueModel({
      route: pairingRoute(),
      response: { pairings: [], total: 0, expired_count: 0, secrets_redacted: true },
      diagnostics: null
    })
    const markup = renderToStaticMarkup(
      <PairingQueueSurface model={model} route={pairingRoute()} />
    )

    expect(model.meshPairingManaged).toBe(true)
    expect(markup).toContain('Mesh pairing creates requests automatically')
    expect(markup).not.toContain('Create pairing code via AdminAction')
    expect(markup).not.toContain('Exchange via AdminAction')
  })

  it('shows the same verification code on both Auroras without exposing opaque handles', () => {
    const diagnostics = {
      ...webrtcDiagnosticsFixture,
      mesh_enabled: true
    }
    const pairingSessionId = 'a'.repeat(64)
    const verificationCode = '48271935'
    const requestOnAurora1 = {
      ...pendingPairing(),
      request_id: 'incoming-on-aurora-1',
      code: 'opaque-request-handle-on-aurora-1',
      device_name: 'Aurora 2',
      remote_peer_id: 'stable-peer-2',
      remote_node_name: 'Aurora 2',
      pairing_session_id: pairingSessionId,
      verification_code: verificationCode,
      expires_at: '2099-01-01T00:00:00Z'
    } as PendingPairingEntry & { pairing_session_id: string; verification_code: string }
    const requestOnAurora2 = {
      ...pendingPairing(),
      request_id: 'incoming-on-aurora-2',
      code: 'opaque-request-handle-on-aurora-2',
      device_name: 'Aurora 1',
      remote_peer_id: 'stable-peer-1',
      remote_node_name: 'Aurora 1',
      pairing_session_id: pairingSessionId,
      verification_code: verificationCode,
      expires_at: '2099-01-01T00:00:00Z'
    } as PendingPairingEntry & { pairing_session_id: string; verification_code: string }

    const surfaces = [requestOnAurora1, requestOnAurora2].map((request) => {
      const model = buildPairingQueueModel({
        route: pairingRoute(),
        response: { pairings: [request], total: 1, expired_count: 0, secrets_redacted: true },
        diagnostics
      })
      return {
        model,
        markup: renderToStaticMarkup(<PairingQueueSurface model={model} route={pairingRoute()} />)
      }
    })

    for (const { model, markup } of surfaces) {
      expect(model.meshPairingManaged).toBe(true)
      expect(model.entries).toHaveLength(1)
      expect(markup).toContain('Verification code')
      expect(markup).toContain(verificationCode)
      expect(markup).toContain('matches on both Auroras')
      expect(markup).toContain('approve independently on each Aurora')
      expect(markup).toContain('AdminAction approve')
      expect(markup).not.toContain('opaque-request-handle')
      expect(markup).not.toContain('Copy code')
      expect(markup).not.toContain('Pairing code to exchange')
      expect(markup).not.toContain('Create pairing code via AdminAction')
      expect(markup).not.toContain('Exchange via AdminAction')
    }
  })

  it('creates deep links without exposing QR as fake backend state', () => {
    const credential = buildPairingCredentialModel({ code: 'space code/with symbols', expires_in_seconds: 60 }, 'audit-created')

    expect(pairingDeepLink('space code/with symbols')).toBe('aurora://pairing/exchange?code=space%20code%2Fwith%20symbols')
    expect(credential.qrPayload).toBe(credential.deepLink)
    expect(credential.qrUnavailableReason).toContain('no @aurora/ui QR renderer or backend QR contract')
    expect(credential.auditReceipt).toBe('audit-created')
  })
})

function pairingRoute(): RouteAvailability {
  const item = [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems].find((candidate) => candidate.id === 'pairing')
  if (!item) throw new Error('pairing route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Pairing route available from mock status.',
    providerLabel: 'mock Auth.ListPendingPairings',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Auth.ListPendingPairings'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: true
  }
}

function pairingResponse() {
  const pending = pendingPairing()
  const expired: PendingPairingEntry = {
    ...pending,
    request_id: 'pairing-expired-wall-panel',
    code: 'expired-secret-token',
    device_name: 'Expired wall panel',
    status: 'pending',
    expires_at: '2020-01-01T00:00:00Z',
    remote_peer_id: 'peer-expired-wall',
    remote_node_name: 'Wall panel'
  }
  const denied: PendingPairingEntry = {
    ...pending,
    request_id: 'pairing-denied-phone',
    code: 'denied-secret-token',
    device_name: 'Denied phone',
    status: 'denied',
    denied_by: 'admin',
    denied_reason: 'unknown device'
  }
  return {
    pairings: [pending, expired, denied],
    total: 3,
    expired_count: 1,
    secrets_redacted: true
  }
}

function pendingPairing(): PendingPairingEntry {
  return defaultMockAuroraFixtures.pendingPairings.pairings[0]!
}
