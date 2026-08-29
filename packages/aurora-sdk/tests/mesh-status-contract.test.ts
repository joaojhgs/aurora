import { describe, expect, it } from 'vitest'

import { cloneFixture, meshStatusFixture } from '../src/fixtures.js'
import type {
  ManifestAck,
  MeshCompatibilityReasonCode,
  MeshRoutingReasonCode,
  MeshStatusResponse
} from '../src/types.js'

const G009_REASON_CODES = [
  'provider_not_allowed',
  'service_not_shared',
  'method_not_shared',
  'permissions_unknown',
  'permission_denied',
  'missing_required_features',
  'missing_required_capability_tags',
  'manifest_projection_stale',
  'incompatible_version',
  'provider_at_capacity',
  'legacy_unverifiable'
] as const satisfies readonly MeshCompatibilityReasonCode[]

const ROUTING_ONLY_REASON_CODES = [
  'provider_unavailable'
] as const satisfies readonly MeshRoutingReasonCode[]

describe('G009 mesh status contracts', () => {
  it('keeps legacy manifest ACK arrays while accepting additive revisions and reasons', () => {
    const legacyAck: ManifestAck = {
      compatible_services: ['TTS'],
      incompatible_services: ['Tooling'],
      unused_services: ['DB']
    }
    const currentAck: ManifestAck = {
      ...legacyAck,
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      protocol_revision: 'v1',
      registry_revision: 'registry-7',
      export_policy_revision: 'export-4',
      auth_grant_revision: 9,
      projection_digest: 'safe-projection-digest',
      services: [
        {
          service_id: 'Tooling',
          service_label: '',
          status: 'incompatible',
          reason_codes: ['permission_denied'],
          reason: ''
        }
      ]
    }

    expect(legacyAck.compatible_services).toEqual(['TTS'])
    expect(currentAck.incompatible_services).toEqual(['Tooling'])
    expect(currentAck.services?.[0]).toMatchObject({
      service_id: 'Tooling',
      service_label: '',
      reason_codes: ['permission_denied']
    })
    expect(currentAck.services?.[0]?.reason).toBe('')
  })

  it('exposes independent export and routing summaries without replacing legacy routes', () => {
    const fixture = cloneFixture(meshStatusFixture)

    expect(fixture.routes.length).toBeGreaterThan(0)
    expect(fixture.export_summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service_id: 'TTS',
          service_label: '',
          shared: true,
          reason_codes: ['method_not_shared'],
          excluded_method_count: 1,
          excluded_feature_count: 0
        }),
        expect.objectContaining({
          service_id: 'Scheduler',
          shared: false,
          reason_codes: ['service_not_shared'],
          excluded_method_count: 0,
          excluded_feature_count: 0
        })
      ])
    )
    expect(fixture.routing_summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service_id: 'TTS',
          service_label: '',
          eligible_provider_ids: ['peer-kitchen']
        })
      ])
    )
  })

  it('covers every required stable denial reason without embedding payload fields', () => {
    const fixture = cloneFixture(meshStatusFixture)
    const fixtureReasons = new Set<string>(
      fixture.routing_summaries?.flatMap((summary) => summary.reason_codes) ?? []
    )

    for (const reason of G009_REASON_CODES) expect(fixtureReasons.has(reason)).toBe(true)
    for (const reason of ROUTING_ONLY_REASON_CODES) expect(fixtureReasons.has(reason)).toBe(true)
    expect(fixtureReasons.has('eligible')).toBe(false)

    const serialized = JSON.stringify(fixture).toLowerCase()
    for (const forbidden of ['room_password', 'auth_token', 'api_key', 'tool_arguments', 'request_payload']) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(fixture.secrets_redacted).toBe(true)
  })

  it('summarizes excluded exports by count without disclosing hidden names', () => {
    const fixture = cloneFixture(meshStatusFixture)
    const tts = fixture.export_summaries?.find((summary) => summary.service_id === 'TTS')
    const scheduler = fixture.export_summaries?.find(
      (summary) => summary.service_id === 'Scheduler'
    )

    expect(tts).toMatchObject({
      reason_codes: ['method_not_shared'],
      excluded_method_count: 1,
      excluded_feature_count: 0
    })
    expect(scheduler).toMatchObject({
      reason_codes: ['service_not_shared'],
      excluded_method_count: 0,
      excluded_feature_count: 0
    })
    expect(tts).not.toHaveProperty('excluded_method_ids')
    expect(tts).not.toHaveProperty('excluded_feature_ids')
  })

  it('keeps wire ACK copy empty while public status uses bounded local copy', () => {
    const fixture = cloneFixture(meshStatusFixture)
    const statusEntry = fixture.peers[0]?.compatibility.local_services?.find(
      (service) => service.service_id === 'DB'
    )

    expect(statusEntry).toMatchObject({
      service_id: 'DB',
      service_label: '',
      status: 'unused',
      reason_codes: [],
      reason: 'not configured for remote routing'
    })
  })

  it('keeps peer labels separate while empty service labels never replace stable IDs', () => {
    const fixture = cloneFixture(meshStatusFixture)
    const peer = fixture.peers.find((candidate) => candidate.peer_id === 'peer-kitchen')
    const summary = fixture.routing_summaries?.find((candidate) => candidate.service_id === 'TTS')

    expect(peer?.node_name).toBe('Kitchen node')
    expect(peer?.peer_id).toBe('peer-kitchen')
    expect(summary?.service_label).toBe('')
    expect(summary?.service_id).toBe('TTS')
    expect(summary?.service_id).not.toBe(summary?.service_label)
    expect(summary?.eligible_provider_ids).toEqual(['peer-kitchen'])
  })

  it('keeps new status fields optional for legacy gateway fixtures', () => {
    const legacyStatus: MeshStatusResponse = {
      local: meshStatusFixture.local,
      peers: [],
      routes: [],
      compatibility_failures: [],
      secrets_redacted: true
    }

    expect(legacyStatus.export_summaries).toBeUndefined()
    expect(legacyStatus.routing_summaries).toBeUndefined()
  })
})
