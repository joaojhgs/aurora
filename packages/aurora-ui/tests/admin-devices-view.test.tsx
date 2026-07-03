import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  defaultMockAuroraFixtures,
  meshPeerListFixture
} from '@aurora/client'
import {
  AdminDevicesView,
  buildAdminDevicesSnapshot,
  buildDeviceDeleteAdminAction,
  buildDeviceMeshPeerAdminAction,
  buildPendingPairingAdminAction
} from '../src/admin-devices-view'

describe('AdminDevicesView production device and pairing controls', () => {
  it('links devices and pending pairings to mesh peers without exposing pairing secrets', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminDevicesView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.meshPeerState).toBe('available-local')
    expect(snapshot.meshPeerActionState).toBe('available-local')
    expect(snapshot.pendingPairings).toContainEqual(
      expect.objectContaining({
        requestId: 'mesh-pairing-peer-kitchen',
        linkedMeshPeerId: 'peer-kitchen',
        linkedMeshPeerState: 'pending',
        approveAction: expect.objectContaining({ methodId: 'Auth.PairingApprove', reauthConfirmed: false }),
        denyAction: expect.objectContaining({ methodId: 'Auth.PairingDeny', reauthConfirmed: false })
      })
    )
    expect(markup).toContain('Mesh peer linkage')
    expect(markup).toContain('Approve/trust via AdminAction')
    expect(markup).toContain('Deny via AdminAction')
    expect(markup).toContain('Kitchen node')
    expect(markup).toContain('pairing secret redacted')
    expect(markup).not.toContain('mesh-pairing-secret')
  })

  it('builds device revoke, pairing approve/deny, and mesh trust action drafts locked until explicit confirmation', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const device = snapshot.devices.find((row) => row.id === 'device-studio-mac')
    expect(device).toBeTruthy()

    const revoke = buildDeviceDeleteAdminAction(device!, 'retire lost laptop')
    expect(revoke).toEqual(
      expect.objectContaining({
        methodId: 'Auth.DeleteDevice',
        payload: { device_id: 'device-studio-mac' },
        reason: 'retire lost laptop',
        reauthConfirmed: false,
        path: '/api/Auth/DeleteDevice'
      })
    )
    expect(revoke.affectedResources).toEqual(expect.arrayContaining(['device:device-studio-mac', 'device_tokens', 'active_sessions']))
    expect(buildDeviceDeleteAdminAction(device!, 'retire lost laptop', true).reauthConfirmed).toBe(true)

    const pairing = defaultMockAuroraFixtures.pendingPairings.pairings[0]
    expect(pairing).toBeTruthy()
    const approve = buildPendingPairingAdminAction(pairing!, 'approve', 'trust kitchen tablet')
    const deny = buildPendingPairingAdminAction(pairing!, 'deny', 'wrong device')
    expect(approve).toEqual(
      expect.objectContaining({
        methodId: 'Auth.PairingApprove',
        payload: { code: 'mesh-pairing-secret', permissions: ['Gateway.use'], is_admin: false },
        reason: 'trust kitchen tablet',
        reauthConfirmed: false,
        path: '/api/Auth/PairingApprove'
      })
    )
    expect(deny).toEqual(
      expect.objectContaining({
        methodId: 'Auth.PairingDeny',
        payload: { code: 'mesh-pairing-secret', reason: 'wrong device' },
        reauthConfirmed: false,
        path: '/api/Auth/PairingDeny'
      })
    )
    expect(approve.affectedResources).toEqual(expect.arrayContaining(['pairing:mesh-pairing-peer-kitchen', 'peer:peer-kitchen', 'device:Kitchen tablet']))
    expect(buildPendingPairingAdminAction(pairing!, 'approve', 'trust kitchen tablet', true).reauthConfirmed).toBe(true)

    const peer = meshPeerListFixture.peers[0]
    expect(peer).toBeTruthy()
    const meshTrust = buildDeviceMeshPeerAdminAction(peer!, 'trust', 'approve peer from devices page')
    expect(meshTrust).toEqual(
      expect.objectContaining({
        methodId: 'Auth.MeshApprovePeer',
        payload: { peer_id: 'peer-kitchen', permissions: [] },
        reason: 'approve peer from devices page',
        reauthConfirmed: false,
        path: '/api/Auth/MeshApprovePeer'
      })
    )
    expect(buildDeviceMeshPeerAdminAction(peer!, 'trust', 'approve peer from devices page', true).reauthConfirmed).toBe(true)
  })


  it('proves prior device AdminAction drafts are not pre-confirmed for submission', async () => {
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const device = snapshot.devices.find((row) => row.id === 'device-studio-mac')
    expect(device?.deleteAction).toEqual(expect.objectContaining({ reauthConfirmed: false }))
    expect(buildDeviceDeleteAdminAction(device!, 'retire lost laptop').reauthConfirmed).toBe(false)
  })

  it('disables device trust action status when mesh mutation capabilities are unavailable', async () => {
    const transport = new MockAuroraTransport()
    transport.lose('Auth.MeshListPeers', 'mesh peer service unavailable')
    const snapshot = await buildAdminDevicesSnapshot(new Aurora({ transport }))
    const markup = renderToStaticMarkup(<AdminDevicesView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.meshPeerState).toBe('unsupported')
    expect(snapshot.warnings.join(' ')).toContain('mesh peer service unavailable')
    expect(markup).toContain('mesh peer service unavailable')
  })
})
