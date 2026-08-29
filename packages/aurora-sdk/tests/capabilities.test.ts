import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  MockAuroraTransport,
  buildCapabilityGraph,
  type CallableFeatureContract,
  type CapabilityActionInfo,
  type CapabilityCatalogResponse,
  type CapabilityFreshnessInfo,
  type CapabilityPolicyDecisionInfo,
  type CapabilityProviderInfo,
  type GetRegistryResponse,
  type GetServicesResponse
} from '../src/index.js'

const speechStreamingFeature: CallableFeatureContract = {
  feature_id: 'speech_streaming',
  module: 'TTS',
  label: 'Speech Streaming',
  summary: 'Start, stream, and end ordered text-to-speech audio streams.',
  method_ids: ['TTS.StreamStart', 'TTS.StreamChunk', 'TTS.StreamEnd']
}

const freshness: CapabilityFreshnessInfo = {
  source: 'registry',
  manifest_time: null,
  last_probe_age_s: null,
  ttl_s: null,
  stale: false,
  registry_digest: 'test'
}

const policy: CapabilityPolicyDecisionInfo = {
  required_permissions: ['TTS.use'],
  required_callable_feature_ids: ['speech_streaming'],
  trust_tier: 'local',
  safety_class: 'public',
  explicit_selector_required: false,
  consent_required: false,
  privacy_indicator_required: false,
  bandwidth_check_required: false,
  approval_required: false,
  selector_required: false,
  mesh_visible: true,
  local_only: false,
  allowed_provider_peer_ids: null,
  operation_class: 'invoke',
  resource_scope: null,
  denial_reasons: []
}

function provider(): CapabilityProviderInfo {
  return {
    provider_id: 'local:TTS:main',
    peer_id: null,
    provider_kind: 'local',
    node_name: 'local',
    status: 'healthy',
    service_instance_id: 'tts-main',
    module: 'TTS',
    version: '1.0.0',
    latency_ms: null,
    max_concurrent: 10,
    active_calls: 0,
    available_capacity: 10,
    eligible: true,
    reason_code: '',
    reason: 'available',
    policy,
    freshness
  }
}

function action(method: string): CapabilityActionInfo {
  return {
    action_id: `local:TTS:${method}`,
    module: 'TTS',
    method,
    topic: `TTS.${method}`,
    callable_feature_ids: ['speech_streaming'],
    callable_features: [speechStreamingFeature],
    tool_id: null,
    resource_id: null,
    provider_id: 'local:TTS:main',
    peer_id: null,
    provider_kind: 'local',
    service_instance_id: 'tts-main',
    selector: null,
    bindability: 'available',
    sdk_operation_kind: 'method',
    route_hints: [],
    route_blockers: [],
    summary: method,
    input_schema: null,
    output_schema: null,
    policy,
    freshness
  }
}

describe('capability graph callable grouping', () => {
  it('keeps callable actions as method nodes while indexing module-scoped groups', () => {
    const catalog: CapabilityCatalogResponse = {
      generated_at: '2026-01-01T00:00:00Z',
      local_peer_id: 'local',
      local_node_name: 'local',
      providers: [provider()],
      actions: [action('StreamStart'), action('StreamChunk'), action('StreamEnd')],
      resources: [],
      provider_index: {},
      action_index: {},
      secrets_redacted: true
    }

    const graph = buildCapabilityGraph({ catalog, registry: null, transportKind: 'http' })
    expect(graph.serverVersion).toBeNull()
    const methodFeatureIds = [
      'method:TTS.StreamStart',
      'method:TTS.StreamChunk',
      'method:TTS.StreamEnd'
    ]
    const sortedMethodFeatureIds = [...methodFeatureIds].sort()

    expect(graph.byFeatureId['callable:TTS:speech_streaming']).toBeUndefined()
    expect(graph.byFeatureId['callable:speech_streaming']).toBeUndefined()
    expect(graph.nodes.map((node) => node.featureId).sort()).toEqual(sortedMethodFeatureIds)

    for (const featureId of methodFeatureIds) {
      const node = graph.byFeatureId[featureId]!
      const topic = featureId.replace('method:', '')
      const method = topic.split('.')[1]
      const explanation = graph.explain(featureId)

      expect(node).toBeDefined()
      expect(node.featureId).toBe(featureId)
      expect(node.method).toBe(method)
      expect(node.busTopic).toBe(topic)
      expect(node.providers).toHaveLength(1)
      expect(node.selectedProvider).toEqual(node.providers[0])
      expect(node.alternateProviders).toEqual([])
      expect(node.rawActions).toHaveLength(1)
      expect(node.rawActions[0]?.topic).toBe(topic)
      expect(explanation.selectedProvider).toEqual(node.selectedProvider)
      expect(explanation.providerCandidates).toEqual(node.providers)
      expect(explanation.alternateProviders).toEqual([])
    }

    expect(graph.callableFeatureIndex['callable:TTS:speech_streaming']).toEqual(sortedMethodFeatureIds)
    expect(graph.candidateProviderIndex['callable:TTS:speech_streaming']).toEqual([
      'method:TTS.StreamChunk:local:TTS:StreamChunk@local:TTS:main',
      'method:TTS.StreamEnd:local:TTS:StreamEnd@local:TTS:main',
      'method:TTS.StreamStart:local:TTS:StreamStart@local:TTS:main'
    ])
    expect(new Set(graph.candidateProviderIndex['callable:TTS:speech_streaming'])).toHaveLength(3)
  })

  it('surfaces a non-empty catalog aurora_version as the graph serverVersion', () => {
    const catalog: CapabilityCatalogResponse = {
      generated_at: '2026-01-01T00:00:00Z',
      local_peer_id: 'local',
      local_node_name: 'local',
      aurora_version: ' 1.0.0 ',
      providers: [provider()],
      actions: [action('StreamStart')],
      resources: [],
      provider_index: {},
      action_index: {},
      secrets_redacted: true
    }

    const graph = buildCapabilityGraph({ catalog, registry: null, transportKind: 'http' })
    expect(graph.serverVersion).toBe('1.0.0')
  })

  it('roundtrips callable feature objects on services and registry announcements', async () => {
    const services: GetServicesResponse = {
      services: [
        {
          module: 'TTS',
          version: '1.0.0',
          summary: 'Text to speech',
          capabilities: [],
          callable_features: [speechStreamingFeature],
          method_count: 3,
          last_seen: '2026-01-01T00:00:00Z',
          status: 'healthy',
          instance_id: 'tts-main'
        }
      ],
      mode: 'threads'
    }
    const registry: GetRegistryResponse = {
      modules: [
        {
          module: 'TTS',
          version: '1.0.0',
          summary: 'Text to speech',
          capabilities: [],
          callable_features: [speechStreamingFeature],
          methods: [
            {
              name: 'StreamStart',
              summary: 'Start stream',
              bus_topic: 'TTS.StreamStart',
              exposure: 'both',
              input_model: null,
              output_model: null,
              required_perms: ['TTS.use'],
              callable_feature_ids: ['speech_streaming'],
              callable_features: [speechStreamingFeature],
              public_infrastructure: false,
              method_type: 'use',
              input_schema: null,
              output_schema: null
            }
          ]
        }
      ],
      digest: 'test',
      service_count: 1,
      method_count: 1
    }
    const client = new AuroraClient({
      transport: MockAuroraTransport.empty()
        .register('Gateway.GetServices', services)
        .register('Gateway.GetRegistry', registry)
    })

    await expect(client.registry.listServices()).resolves.toEqual(services)
    await expect(client.registry.getRegistry()).resolves.toEqual(registry)
  })
})
