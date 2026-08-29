import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import { describe, expect, it } from 'vitest'
import { buildMeshInvitePayload, buildMeshPeersSnapshot, meshInviteReadiness } from '../src/mesh-peers-view'
import type { RouteAvailability } from '../src/shell-data'

const meshRoute = {
  item: {
    id: 'mesh',
    label: 'Mesh',
    href: '/mesh',
    capabilityModule: 'Gateway',
    capabilityMethod: 'GetMeshStatus',
    methodType: 'use',
    privacyClass: 'credential',
    fallbackState: 'unsupported',
    adminGated: false,
    expectedTask: 'MESH-001',
  },
  state: 'available-local',
  explanation: 'Gateway.GetMeshStatus is available.',
  providerLabel: 'local / Gateway.GetMeshStatus',
  blockers: [],
  repairActions: [],
  candidateProviders: [],
  evidenceSources: ['capability-catalog'],
  selectorRequired: false,
  approvalRequired: false,
  routeable: true,
  disabled: false,
  requiresAdminAction: false,
} as RouteAvailability

describe('mesh invite secret access', () => {
  it('does not request local settings or invite credentials from a remote client surface', async () => {
    let metadataReads = 0
    let inviteReads = 0
    const transport = new MockAuroraTransport()
      .register('Config.GetSchemaMetadata', () => {
        metadataReads += 1
        return { fields: [], secrets_redacted: true }
      })
      .register('Gateway.GetMeshInviteConfig', () => {
        inviteReads += 1
        return {
          app_id: 'should-not-be-read',
          room: 'should-not-be-read',
          room_password: 'should-not-be-read',
        }
      })

    const snapshot = await buildMeshPeersSnapshot(
      new AuroraClient({ transport }),
      meshRoute,
      { canManageLocalServiceConfiguration: false },
    )

    expect(metadataReads).toBe(0)
    expect(inviteReads).toBe(0)
    expect(snapshot.inviteConfig).toBeNull()
    expect(snapshot.config.editable).toBe(false)
  })

  it('uses only the dedicated invite credential method, never raw Config.Get', async () => {
    let rawConfigReads = 0
    const transport = new MockAuroraTransport()
      .register('Config.Get', () => {
        rawConfigReads += 1
        return { config: { services: { gateway: { webrtc: { password: 'raw-secret' } } } } }
      })
      .register('Gateway.GetMeshInviteConfig', () => ({
        app_id: 'aurora-app-admin',
        room: 'aurora-room-admin',
        room_password: 'dedicated-secret',
      }))

    const snapshot = await buildMeshPeersSnapshot(new AuroraClient({ transport }), meshRoute)
    const invite = buildMeshInvitePayload(snapshot)

    expect(rawConfigReads).toBe(0)
    expect(snapshot.inviteConfig).toEqual({
      app_id: 'aurora-app-admin',
      room: 'aurora-room-admin',
      room_password: 'dedicated-secret',
    })
    expect(invite.signaling).toEqual(expect.objectContaining({
      app_id: 'aurora-app-admin',
      room: 'aurora-room-admin',
      room_password: 'dedicated-secret',
    }))
  })

  it('fails invite generation closed when the admin-gated credential read is denied', async () => {
    let rawConfigReads = 0
    const transport = new MockAuroraTransport()
      .register('Config.Get', () => {
        rawConfigReads += 1
        return { config: { services: { gateway: { webrtc: { password: 'must-not-fallback' } } } } }
      })
      .lose('Gateway.GetMeshInviteConfig', 'Gateway.manage is required')

    const snapshot = await buildMeshPeersSnapshot(new AuroraClient({ transport }), meshRoute)

    expect(rawConfigReads).toBe(0)
    expect(snapshot.inviteConfig).toBeNull()
    const readiness = meshInviteReadiness(snapshot)
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe('Aurora is preparing a unique invite identity.')

    let thrown: unknown
    try {
      buildMeshInvitePayload(snapshot)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).toBe('Aurora is preparing a unique invite identity.')
    expect(message).not.toMatch(/\b(signaling|credential|credentials|permission|gateway|config|manage|denied|required|webrtc)\b/i)
    expect(message).not.toContain('Gateway.manage is required')
    expect(message).not.toContain('must-not-fallback')
  })
})
