import { describe, expect, it } from 'vitest'

import {
  WebRtcManifestParseError,
  buildWebRtcManifestAck,
  parseWebRtcMeshManifest
} from '../src/webrtc/manifest.js'

function validFrame(): Record<string, unknown> & { shared_services: unknown[] } {
  return {
    type: 'manifest',
    peer_id: 'stable-peer-1',
    node_name: 'Kitchen Node',
    aurora_version: '0.5.0',
    shared_services: [
      {
        module: 'TTS',
        version: '1.2.0',
        capabilities: ['streaming', 'piper'],
        provider_id: 'mesh:stable-peer-1:TTS',
        service_instance_id: 'remote:stable-peer-1:TTS',
        methods: [
          { name: 'Request', bus_topic: 'TTS.Request', exposure: 'both' },
          { name: 'AudioChunk', bus_topic: 'TTS.AudioChunk', exposure: 'external' }
        ]
      },
      {
        module: 'Gateway',
        methods: ['Gateway.GetRegistry'],
        capabilities: []
      }
    ],
    timestamp: '2026-07-25T00:00:00Z'
  }
}

function projectionFrame(): Record<string, unknown> & { shared_services: unknown[] } {
  const frame = {
    type: 'manifest',
    peer_id: 'stable-peer-1',
    node_name: 'Kitchen Node',
    aurora_version: '0.5.0',
    active_protocol: 'projection-v1',
    active_version: 'v1',
    active_tier: 'projection',
    supported_protocols: ['legacy-unfiltered-v0', 'projection-v1'],
    projection_supported: true,
    projection_active: true,
    granted_permissions: null,
    shared_services: [
      {
        module: 'Empty',
        version: '1.0.0',
        capabilities: [],
        callable_features: [],
        available_feature_ids: [],
        methods: [],
        max_concurrent: 10
      },
      {
        module: 'Tooling',
        version: '1.0.0',
        capabilities: ['tools'],
        callable_features: [],
        available_feature_ids: [],
        methods: [
          {
            name: 'GetExportCatalog',
            summary: '',
            bus_topic: 'Tooling.GetExportCatalog',
            exposure: 'external',
            input_model: null,
            output_model: null,
            required_perms: [],
            callable_feature_ids: [],
            callable_features: [],
            public_infrastructure: false,
            method_type: 'use',
            input_schema: {
              type: 'object',
              properties: {
                offset: { type: 'number', default: 0 },
                ratio: { type: 'number', default: 1.5 }
              }
            },
            output_schema: null
          }
        ],
        max_concurrent: 10
      }
    ],
    recipient_projection_evidence: {
      provider_peer_id: 'stable-peer-1',
      recipient_peer_id: 'thin-consumer-1',
      registry_revision: 'registry-7',
      registry_digest: '1'.repeat(64),
      policy_revision: 'export-4',
      policy_digest: '2'.repeat(64),
      auth_grant_revision: 9,
      auth_grant_state: 'active',
      auth_grant_digest: '3'.repeat(64),
      grants_digest: '4'.repeat(64),
      protocol_tier: 'projection-v1',
      // Generated with Python canonical_digest({provider_peer_id, services}) in
      // app.services.gateway.mesh.negotiation.manifest_projection_digest.
      projection_digest: '154952047c0334b696cef698c6c0fd0dcd92243062c7f33fe31c1c62e83c84e2',
      evidence_digest: '5'.repeat(64),
      grants: []
    },
    timestamp: '2026-07-25T00:00:00Z'
  }
  return frame
}

describe('WebRTC mesh manifest parser', () => {
  it('normalizes a valid Python-shaped manifest and preserves raw frame', () => {
    const frame = validFrame()
    const parsed = parseWebRtcMeshManifest(frame, 'stable-peer-1')
    expect(parsed).toEqual({
      peerId: 'stable-peer-1',
      nodeName: 'Kitchen Node',
      version: '0.5.0',
      authenticated: true,
      trusted: false,
      services: [
        {
          module: 'TTS',
          version: '1.2.0',
          methods: ['TTS.Request', 'TTS.AudioChunk'],
          capabilities: ['streaming', 'piper'],
          providerId: 'mesh:stable-peer-1:TTS',
          serviceInstanceId: 'remote:stable-peer-1:TTS'
        },
        {
          module: 'Gateway',
          methods: ['Gateway.GetRegistry'],
          capabilities: []
        }
      ],
      raw: frame
    })
  })

  it('rejects signaling/transient ID substitution', () => {
    expect(() => parseWebRtcMeshManifest({ ...validFrame(), peer_id: 'sig-peer-1' }, 'stable-peer-1')).toThrow(/peer_id/u)
  })

  it('rejects accessor and prototype-bearing objects', () => {
    const accessor = validFrame() as Record<string, unknown>
    Object.defineProperty(accessor, 'node_name', { get: () => 'leak', enumerable: true })
    expect(() => parseWebRtcMeshManifest(accessor, 'stable-peer-1')).toThrow(WebRtcManifestParseError)

    class ManifestLike {
      type = 'manifest'
      peer_id = 'stable-peer-1'
      node_name = 'n'
      shared_services = []
    }
    expect(() =>
      parseWebRtcMeshManifest(new ManifestLike() as unknown as Record<string, unknown>, 'stable-peer-1')
    ).toThrow(WebRtcManifestParseError)

    const polluted = JSON.parse(
      '{"type":"manifest","peer_id":"stable-peer-1","node_name":"n","shared_services":[],"__proto__":{"polluted":true}}'
    ) as Record<string, unknown>
    expect(() => parseWebRtcMeshManifest(polluted, 'stable-peer-1')).toThrow(/unsafe/u)
  })

  it('rejects malformed services and methods', () => {
    expect(() =>
      parseWebRtcMeshManifest({ ...validFrame(), shared_services: [{ module: '', methods: [] }] }, 'stable-peer-1')
    ).toThrow(/module/u)
    expect(() =>
      parseWebRtcMeshManifest(
        { ...validFrame(), shared_services: [{ module: 'TTS', methods: [{ name: 'Request' }] }] },
        'stable-peer-1'
      )
    ).toThrow(/bus_topic/u)
    expect(() =>
      parseWebRtcMeshManifest(
        { ...validFrame(), shared_services: [{ module: 'TTS', methods: ['not-a-topic'] }] },
        'stable-peer-1'
      )
    ).toThrow(/topic/u)
  })

  it('rejects duplicate service modules', () => {
    const frame = validFrame()
    frame.shared_services = [frame.shared_services[0]!, { ...frame.shared_services[0]!, version: '2.0.0' }]
    expect(() => parseWebRtcMeshManifest(frame, 'stable-peer-1')).toThrow(/duplicate/u)
  })

  it('rejects bounded-size violations', () => {
    expect(() =>
      parseWebRtcMeshManifest({ ...validFrame(), node_name: 'x'.repeat(600) }, 'stable-peer-1')
    ).toThrow(/node_name/u)
    expect(() =>
      parseWebRtcMeshManifest(
        {
          ...validFrame(),
          shared_services: Array.from({ length: 129 }, (_, index) => ({ module: `M${index}`, methods: [] }))
        },
        'stable-peer-1'
      )
    ).toThrow(/shared_services/u)
    expect(() =>
      parseWebRtcMeshManifest(
        {
          ...validFrame(),
          shared_services: [{ module: 'TTS', methods: Array.from({ length: 513 }, () => 'TTS.Request') }]
        },
        'stable-peer-1'
      )
    ).toThrow(/methods/u)
  })

  it('rejects explicit consumer-only provider claims', () => {
    expect(() => parseWebRtcMeshManifest({ ...validFrame(), role: 'consumer' }, 'stable-peer-1')).toThrow(/consumer-only/u)
    expect(() => parseWebRtcMeshManifest({ ...validFrame(), capabilities: ['consumer_only_v1'] }, 'stable-peer-1')).toThrow(/consumer-only/u)
  })

  it('builds a Python-compatible projection manifest ACK from authoritative raw evidence', () => {
    const parsed = parseWebRtcMeshManifest(projectionFrame(), 'stable-peer-1')
    const ack = buildWebRtcManifestAck(parsed)

    expect(ack).toEqual({
      type: 'manifest_ack',
      compatible_services: ['Tooling'],
      incompatible_services: ['Empty'],
      unused_services: [],
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      protocol_revision: 'v1',
      registry_revision: 'registry-7',
      export_policy_revision: 'export-4',
      auth_grant_revision: 9,
      projection_digest: '154952047c0334b696cef698c6c0fd0dcd92243062c7f33fe31c1c62e83c84e2',
      services: [
        {
          service_id: 'Empty',
          service_label: '',
          status: 'incompatible',
          reason_codes: ['method_not_advertised'],
          reason: ''
        },
        {
          service_id: 'Tooling',
          service_label: '',
          status: 'compatible',
          reason_codes: [],
          reason: ''
        }
      ]
    })
  })

  it('fails closed for legacy manifests without inventing projection evidence', () => {
    const parsed = parseWebRtcMeshManifest(validFrame(), 'stable-peer-1')
    expect(buildWebRtcManifestAck(parsed)).toMatchObject({
      type: 'manifest_ack',
      compatible_services: [],
      incompatible_services: ['Gateway', 'TTS'],
      unused_services: [],
      protocol_revision: null,
      export_policy_revision: null,
      projection_digest: null,
      services: [
        { service_id: 'Gateway', status: 'incompatible', reason_codes: ['legacy_unverifiable'] },
        { service_id: 'TTS', status: 'incompatible', reason_codes: ['legacy_unverifiable'] }
      ]
    })
  })

  it('rejects projection ACKs with missing or contradictory authority evidence', () => {
    const missingEvidence = parseWebRtcMeshManifest(
      { ...projectionFrame(), recipient_projection_evidence: undefined },
      'stable-peer-1'
    )
    expect(() => buildWebRtcManifestAck(missingEvidence)).toThrow(/recipient_projection_evidence/u)

    const contradictory = projectionFrame()
    contradictory.recipient_projection_evidence = {
      ...(contradictory.recipient_projection_evidence as Record<string, unknown>),
      projection_digest: '0'.repeat(64)
    }
    const parsed = parseWebRtcMeshManifest(contradictory, 'stable-peer-1')
    expect(() => buildWebRtcManifestAck(parsed)).toThrow(/projection_digest/u)
  })

  it('rejects unsafe manifest ACK inputs before reading authority fields', () => {
    const parsed = parseWebRtcMeshManifest(projectionFrame(), 'stable-peer-1') as unknown as Record<string, unknown>
    Object.defineProperty(parsed, 'peerId', { get: () => 'stable-peer-1', enumerable: true })
    expect(() => buildWebRtcManifestAck(parsed as never)).toThrow(WebRtcManifestParseError)
  })
})
