import type {
  BackendInventory,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityFreshnessInfo,
  CapabilityPolicyDecisionInfo,
  CapabilityProviderInfo,
  DeploymentTopologyResponse,
  GatewayBuiltinRouteDescriptor,
  GetRegistryResponse,
  GetServicesResponse,
  ModelRuntimeCatalogResponse,
  NativeCapabilityManifest,
  RouteExplainResponse,
  WebRTCDiagnosticsResponse
} from './types.js'
import { describeBackendInventory, describeRegistry } from './descriptors.js'

export const emptyRegistryFixture: GetRegistryResponse = {
  modules: [],
  digest: '',
  service_count: 0,
  method_count: 0
}

export const gatewayRegistryFixture: GetRegistryResponse = {
  modules: [
    {
      module: 'Orchestrator',
      version: '0.1.0',
      summary: 'Assistant orchestration and model runtime',
      capabilities: ['assistant', 'models'],
      methods: [
        {
          name: 'GetModelCatalog',
          summary: 'Return UI-safe model runtime provider catalog',
          bus_topic: 'Orchestrator.GetModelCatalog',
          exposure: 'external',
          input_model: 'ModelRuntimeCatalogRequest',
          output_model: 'ModelRuntimeCatalogResponse',
          required_perms: ['Orchestrator.use'],
          method_type: 'use',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'GetModelRuntime',
          summary: 'Return selected model runtime provider detail',
          bus_topic: 'Orchestrator.GetModelRuntime',
          exposure: 'external',
          input_model: 'ModelRuntimeRequest',
          output_model: 'ModelRuntimeResponse',
          required_perms: ['Orchestrator.use'],
          method_type: 'use',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'ImportModel',
          summary: 'Import a model through AdminAction-gated backend workflow',
          bus_topic: 'Orchestrator.ImportModel',
          exposure: 'external',
          input_model: 'ModelRuntimeOperationRequest',
          output_model: 'ModelRuntimeOperationResponse',
          required_perms: ['Orchestrator.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'DownloadModel',
          summary: 'Download a model through AdminAction-gated backend workflow',
          bus_topic: 'Orchestrator.DownloadModel',
          exposure: 'external',
          input_model: 'ModelRuntimeOperationRequest',
          output_model: 'ModelRuntimeOperationResponse',
          required_perms: ['Orchestrator.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'BenchmarkModel',
          summary: 'Benchmark a model runtime provider',
          bus_topic: 'Orchestrator.BenchmarkModel',
          exposure: 'external',
          input_model: 'ModelRuntimeOperationRequest',
          output_model: 'ModelRuntimeOperationResponse',
          required_perms: ['Orchestrator.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        }
      ]
    },
    {
      module: 'Gateway',
      version: '0.1.0',
      summary: 'Gateway service',
      capabilities: ['registry'],
      methods: [
        {
          name: 'GetRegistry',
          summary: 'Return the aggregated service registry',
          bus_topic: 'Gateway.GetRegistry',
          exposure: 'external',
          input_model: null,
          output_model: 'GetRegistryResponse',
          required_perms: ['Gateway.use'],
          method_type: 'use',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'GetDeploymentTopology',
          summary: 'Get sanitized deployment topology and message bus health',
          bus_topic: 'Gateway.GetDeploymentTopology',
          exposure: 'external',
          input_model: 'EmptyInput',
          output_model: 'DeploymentTopologyResponse',
          required_perms: ['Gateway.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'GetWebRTCDiagnostics',
          summary: 'Get read-only WebRTC, ICE, and DataChannel diagnostics',
          bus_topic: 'Gateway.GetWebRTCDiagnostics',
          exposure: 'external',
          input_model: 'EmptyInput',
          output_model: 'WebRTCDiagnosticsResponse',
          required_perms: ['Gateway.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'InternalOnly',
          summary: 'Internal-only method',
          bus_topic: 'Gateway.InternalOnly',
          exposure: 'internal',
          input_model: null,
          output_model: null,
          required_perms: ['Gateway.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        }
      ]
    }
  ],
  digest: 'fixture',
  service_count: 2,
  method_count: 9
}

const localFreshness: CapabilityFreshnessInfo = {
  source: 'ui-mock-reference+backend-inventory',
  manifest_time: '2026-06-19T00:00:00Z',
  last_probe_age_s: 2,
  ttl_s: 30,
  stale: false,
  registry_digest: 'fixture'
}

const staleFreshness: CapabilityFreshnessInfo = {
  ...localFreshness,
  last_probe_age_s: 240,
  stale: true
}

const standardPolicy: CapabilityPolicyDecisionInfo = {
  required_permissions: ['Gateway.use'],
  trust_tier: 'local',
  safety_class: 'standard',
  explicit_selector_required: false,
  consent_required: false,
  privacy_indicator_required: false,
  bandwidth_check_required: false,
  approval_required: false,
  selector_required: false,
  mesh_visible: false,
  local_only: false,
  allowed_peers: null,
  operation_class: null,
  resource_scope: null,
  denial_reasons: []
}

const privacyBlockedPolicy: CapabilityPolicyDecisionInfo = {
  ...standardPolicy,
  required_permissions: ['TTS.use'],
  trust_tier: 'mesh',
  safety_class: 'sensitive',
  explicit_selector_required: true,
  consent_required: true,
  privacy_indicator_required: true,
  selector_required: true,
  mesh_visible: true,
  operation_class: 'audio',
  resource_scope: 'raw-audio',
  denial_reasons: []
}

const localGatewayProvider: CapabilityProviderInfo = {
  provider_id: 'local:Gateway',
  peer_id: 'local-peer',
  provider_kind: 'local',
  node_name: 'aurora-prod-01',
  status: 'healthy',
  service_instance_id: 'gw-7f3a',
  module: 'Gateway',
  version: '0.1.0',
  latency_ms: 1,
  max_concurrent: 16,
  active_calls: 0,
  available_capacity: 16,
  eligible: true,
  reason_code: 'eligible',
  reason: 'Local Gateway fixture provider is available.',
  policy: standardPolicy,
  freshness: localFreshness
}

const remoteTtsProvider: CapabilityProviderInfo = {
  provider_id: 'mesh:studio-gpu:TTS',
  peer_id: 'peer-studio-gpu',
  provider_kind: 'mesh',
  node_name: 'studio-gpu',
  status: 'available',
  service_instance_id: 'tts-remote-01',
  module: 'TTS',
  version: '0.1.0',
  latency_ms: 34,
  max_concurrent: 2,
  active_calls: 0,
  available_capacity: 2,
  eligible: false,
  reason_code: 'explicit_selector_required',
  reason: 'Remote raw-audio capable provider requires explicit selector and consent.',
  policy: privacyBlockedPolicy,
  freshness: localFreshness
}

const staleDbProvider: CapabilityProviderInfo = {
  provider_id: 'mesh:cabin-node:DB',
  peer_id: 'peer-cabin-node',
  provider_kind: 'mesh',
  node_name: 'cabin-node',
  status: 'stale',
  service_instance_id: 'db-stale-01',
  module: 'DB',
  version: '0.1.0',
  latency_ms: 180,
  max_concurrent: 1,
  active_calls: 1,
  available_capacity: 0,
  eligible: false,
  reason_code: 'stale_provider',
  reason: 'Provider heartbeat is older than the fixture TTL.',
  policy: {
    ...standardPolicy,
    required_permissions: ['DB.use'],
    trust_tier: 'mesh',
    mesh_visible: true
  },
  freshness: staleFreshness
}

function actionFixture(
  provider: CapabilityProviderInfo,
  overrides: Partial<CapabilityActionInfo>
): CapabilityActionInfo {
  return {
    action_id: `${provider.provider_id}:${overrides.method ?? 'Unknown'}`,
    module: provider.module,
    method: overrides.method ?? 'Unknown',
    topic: overrides.topic ?? `${provider.module}.${overrides.method ?? 'Unknown'}`,
    tool_id: null,
    resource_id: null,
    provider_id: provider.provider_id,
    peer_id: provider.peer_id,
    provider_kind: provider.provider_kind,
    service_instance_id: provider.service_instance_id,
    selector: { peer_id: provider.peer_id, module: provider.module },
    bindability: provider.eligible ? 'available' : 'unavailable',
    sdk_operation_kind: 'bus_method',
    route_hints: [],
    route_blockers: provider.eligible ? [] : [provider.reason_code],
    summary: provider.reason,
    input_schema: null,
    output_schema: null,
    policy: provider.policy,
    freshness: provider.freshness,
    ...overrides
  }
}

export const capabilityCatalogFixture: CapabilityCatalogResponse = {
  generated_at: '2026-06-19T00:00:00Z',
  local_peer_id: 'local-peer',
  local_node_name: 'aurora-prod-01',
  providers: [localGatewayProvider, remoteTtsProvider, staleDbProvider],
  actions: [
    actionFixture(localGatewayProvider, {
      action_id: 'gateway-registry-local',
      method: 'GetRegistry',
      topic: 'Gateway.GetRegistry',
      summary: 'Return the aggregated service registry fixture.',
      bindability: 'available'
    }),
    actionFixture(remoteTtsProvider, {
      action_id: 'tts-remote-privacy-blocked',
      method: 'Synthesize',
      topic: 'TTS.Synthesize',
      summary: 'Remote speech synthesis fixture requires explicit selector and consent.',
      bindability: 'unavailable'
    }),
    actionFixture(staleDbProvider, {
      action_id: 'db-stale-rag-search',
      method: 'RAGSearch',
      topic: 'DB.RAGSearch',
      summary: 'Stale remote DB/RAG provider fixture.',
      bindability: 'unavailable'
    })
  ],
  resources: [],
  provider_index: {
    Gateway: ['local:Gateway'],
    TTS: ['mesh:studio-gpu:TTS'],
    DB: ['mesh:cabin-node:DB']
  },
  action_index: {
    Gateway: ['gateway-registry-local'],
    TTS: ['tts-remote-privacy-blocked'],
    DB: ['db-stale-rag-search']
  },
  secrets_redacted: true
}

const basePolicy: CapabilityPolicyDecisionInfo = {
  required_permissions: [],
  trust_tier: 'local',
  safety_class: 'standard',
  explicit_selector_required: false,
  consent_required: false,
  privacy_indicator_required: false,
  bandwidth_check_required: false,
  approval_required: false,
  selector_required: false,
  mesh_visible: false,
  local_only: false,
  allowed_peers: null,
  operation_class: null,
  resource_scope: null,
  denial_reasons: []
}

const baseFreshness: CapabilityFreshnessInfo = {
  source: 'catalog',
  manifest_time: '2026-06-19T00:00:00Z',
  last_probe_age_s: 1,
  ttl_s: 30,
  stale: false,
  registry_digest: 'fixture'
}

const modelRuntimePolicy: CapabilityPolicyDecisionInfo = {
  ...basePolicy,
  required_permissions: ['Orchestrator.use'],
  resource_scope: 'personal'
}

const modelManagePolicy: CapabilityPolicyDecisionInfo = {
  ...basePolicy,
  required_permissions: ['Orchestrator.manage'],
  operation_class: 'admin',
  safety_class: 'admin',
  approval_required: true
}

function provider(overrides: Partial<CapabilityProviderInfo>): CapabilityProviderInfo {
  return {
    provider_id: 'local:Gateway',
    peer_id: 'local-peer',
    provider_kind: 'local',
    node_name: 'local',
    status: 'healthy',
    service_instance_id: 'gateway-local',
    module: 'Gateway',
    version: '0.1.0',
    latency_ms: 1,
    max_concurrent: 4,
    active_calls: 0,
    available_capacity: 4,
    eligible: true,
    reason_code: 'eligible',
    reason: 'Eligible',
    policy: basePolicy,
    freshness: baseFreshness,
    ...overrides
  }
}

function action(overrides: Partial<CapabilityActionInfo>): CapabilityActionInfo {
  const module = overrides.module ?? 'Gateway'
  const method = overrides.method ?? 'GetRegistry'
  return {
    action_id: `${module}.${method}`,
    module,
    method,
    topic: `${module}.${method}`,
    tool_id: null,
    resource_id: null,
    provider_id: `local:${module}`,
    peer_id: 'local-peer',
    provider_kind: 'local',
    service_instance_id: `${module.toLowerCase()}-local`,
    selector: { peer_id: 'local-peer', module },
    bindability: 'available',
    sdk_operation_kind: 'bus_method',
    route_hints: [],
    route_blockers: [],
    summary: `${module} ${method}`,
    input_schema: null,
    output_schema: null,
    policy: basePolicy,
    freshness: baseFreshness,
    ...overrides
  }
}

export const capabilityGraphCatalogFixture: CapabilityCatalogResponse = {
  generated_at: '2026-06-19T00:00:00Z',
  local_peer_id: 'local-peer',
  local_node_name: 'local',
  providers: [
    provider({
      provider_id: 'local:TTS',
      module: 'TTS',
      service_instance_id: 'tts-local'
    }),
    provider({
      provider_id: 'remote:kitchen:TTS',
      peer_id: 'kitchen-peer',
      provider_kind: 'remote',
      node_name: 'Kitchen node',
      module: 'TTS',
      service_instance_id: 'tts-kitchen',
      latency_ms: 18,
      policy: { ...basePolicy, trust_tier: 'paired', mesh_visible: true }
    }),
    provider({
      provider_id: 'remote:den:TTS',
      peer_id: 'den-peer',
      provider_kind: 'remote',
      node_name: 'Den node',
      module: 'TTS',
      service_instance_id: 'tts-den',
      eligible: false,
      reason_code: 'policy_denied',
      reason: 'Remote playback disabled by policy',
      policy: {
        ...basePolicy,
        trust_tier: 'paired',
        mesh_visible: true,
        denial_reasons: ['policy_denied']
      }
    }),
    provider({
      provider_id: 'remote:garage:Tooling',
      peer_id: 'garage-peer',
      provider_kind: 'remote',
      node_name: 'Garage node',
      module: 'Tooling',
      service_instance_id: 'tooling-garage',
      status: 'stale',
      eligible: false,
      reason_code: 'stale',
      reason: 'Manifest is stale',
      policy: { ...basePolicy, trust_tier: 'paired', mesh_visible: true },
      freshness: { ...baseFreshness, last_probe_age_s: 900, stale: true }
    }),
    provider({
      provider_id: 'local:Orchestrator:llama-cpp',
      module: 'Orchestrator',
      service_instance_id: 'orchestrator-local',
      reason: 'Local desktop llama.cpp runtime is available.'
    }),
    provider({
      provider_id: 'mesh:studio-gpu:Orchestrator',
      peer_id: 'peer-studio-gpu',
      provider_kind: 'mesh',
      node_name: 'studio-gpu',
      module: 'Orchestrator',
      service_instance_id: 'orchestrator-studio-gpu',
      latency_ms: 34,
      policy: { ...modelRuntimePolicy, trust_tier: 'paired', mesh_visible: true },
      reason: 'Remote GPU model runtime is eligible through mesh route evidence.'
    }),
    provider({
      provider_id: 'cloud:openai:Orchestrator',
      peer_id: 'cloud-openai',
      provider_kind: 'cloud',
      node_name: 'OpenAI-compatible gateway',
      module: 'Orchestrator',
      service_instance_id: 'orchestrator-cloud',
      latency_ms: 620,
      available_capacity: 2,
      reason_code: 'fallback_only',
      reason: 'Cloud model provider is fallback-only for sensitive prompts.',
      policy: { ...modelRuntimePolicy, trust_tier: 'external', safety_class: 'sensitive' }
    }),
    provider({
      provider_id: 'native:mobile-local-light',
      peer_id: 'native-mobile',
      provider_kind: 'native-mobile',
      node_name: 'Mobile local-light runtime',
      module: 'Orchestrator',
      service_instance_id: 'orchestrator-mobile-local-light',
      eligible: false,
      reason_code: 'native_provider_missing',
      reason: 'Android/iOS local-light runtime needs native provider proof.',
      policy: { ...modelRuntimePolicy, trust_tier: 'device', local_only: true },
      freshness: { ...baseFreshness, source: 'native-manifest', stale: false }
    })
  ],
  actions: [
    action({
      action_id: 'tts-local-synthesize',
      module: 'TTS',
      method: 'Synthesize',
      topic: 'TTS.Synthesize',
      provider_id: 'local:TTS',
      service_instance_id: 'tts-local',
      policy: { ...basePolicy, required_permissions: ['TTS.use'] }
    }),
    action({
      action_id: 'tts-remote-synthesize',
      module: 'TTS',
      method: 'Synthesize',
      topic: 'TTS.Synthesize',
      provider_id: 'remote:kitchen:TTS',
      peer_id: 'kitchen-peer',
      provider_kind: 'remote',
      service_instance_id: 'tts-kitchen',
      selector: { peer_id: 'kitchen-peer', module: 'TTS' },
      policy: {
        ...basePolicy,
        required_permissions: ['TTS.use'],
        trust_tier: 'paired',
        mesh_visible: true
      }
    }),
    action({
      action_id: 'tool-remote-file-search',
      module: 'Tooling',
      method: 'ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:file-search',
      provider_id: 'remote:kitchen:TTS',
      peer_id: 'kitchen-peer',
      provider_kind: 'remote',
      service_instance_id: 'tts-kitchen',
      selector: { peer_id: 'kitchen-peer', tool_id: 'tool:file-search' },
      policy: {
        ...basePolicy,
        required_permissions: ['Tooling.use'],
        trust_tier: 'paired',
        mesh_visible: true
      }
    }),
    action({
      action_id: 'tool-local-notes',
      module: 'Tooling',
      method: 'ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:notes',
      provider_id: 'local:TTS',
      service_instance_id: 'tooling-local',
      policy: { ...basePolicy, required_permissions: ['Tooling.use'] }
    }),
    action({
      action_id: 'tool-remote-notes',
      module: 'Tooling',
      method: 'ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:notes',
      provider_id: 'remote:kitchen:TTS',
      peer_id: 'kitchen-peer',
      provider_kind: 'remote',
      service_instance_id: 'tooling-kitchen',
      selector: { peer_id: 'kitchen-peer', tool_id: 'tool:notes' },
      policy: {
        ...basePolicy,
        required_permissions: ['Tooling.use'],
        trust_tier: 'paired',
        mesh_visible: true
      }
    }),
    action({
      action_id: 'tool-remote-door',
      module: 'Tooling',
      method: 'ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:garage-door',
      provider_id: 'remote:den:TTS',
      peer_id: 'den-peer',
      provider_kind: 'remote',
      service_instance_id: 'tooling-den',
      selector: { peer_id: 'den-peer', tool_id: 'tool:garage-door' },
      bindability: 'denied',
      policy: {
        ...basePolicy,
        required_permissions: ['Tooling.use'],
        trust_tier: 'paired',
        mesh_visible: true,
        explicit_selector_required: true,
        approval_required: true,
        operation_class: 'admin',
        denial_reasons: ['policy_denied']
      }
    }),
    action({
      action_id: 'tool-stale-camera',
      module: 'Tooling',
      method: 'ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      tool_id: 'tool:camera-snapshot',
      provider_id: 'remote:garage:Tooling',
      peer_id: 'garage-peer',
      provider_kind: 'remote',
      service_instance_id: 'tooling-garage',
      selector: { peer_id: 'garage-peer', tool_id: 'tool:camera-snapshot' },
      policy: {
        ...basePolicy,
        required_permissions: ['Tooling.use'],
        trust_tier: 'paired',
        mesh_visible: true
      },
      freshness: { ...baseFreshness, last_probe_age_s: 900, stale: true }
    }),
    action({
      action_id: 'model-runtime-local-catalog',
      module: 'Orchestrator',
      method: 'GetModelCatalog',
      topic: 'Orchestrator.GetModelCatalog',
      provider_id: 'local:Orchestrator:llama-cpp',
      provider_kind: 'local',
      service_instance_id: 'orchestrator-local',
      selector: { peer_id: 'local-peer', module: 'Orchestrator', provider_id: 'local:Orchestrator:llama-cpp' },
      policy: modelRuntimePolicy,
      summary: 'Local model runtime catalog provider.'
    }),
    action({
      action_id: 'model-runtime-mesh-catalog',
      module: 'Orchestrator',
      method: 'GetModelCatalog',
      topic: 'Orchestrator.GetModelCatalog',
      provider_id: 'mesh:studio-gpu:Orchestrator',
      peer_id: 'peer-studio-gpu',
      provider_kind: 'mesh',
      service_instance_id: 'orchestrator-studio-gpu',
      selector: { peer_id: 'peer-studio-gpu', module: 'Orchestrator', provider_id: 'mesh:studio-gpu:Orchestrator' },
      policy: { ...modelRuntimePolicy, trust_tier: 'paired', mesh_visible: true },
      summary: 'Mesh GPU model runtime catalog provider.'
    }),
    action({
      action_id: 'model-runtime-cloud-catalog',
      module: 'Orchestrator',
      method: 'GetModelCatalog',
      topic: 'Orchestrator.GetModelCatalog',
      provider_id: 'cloud:openai:Orchestrator',
      peer_id: 'cloud-openai',
      provider_kind: 'cloud',
      service_instance_id: 'orchestrator-cloud',
      bindability: 'degraded',
      selector: { module: 'Orchestrator', provider_id: 'cloud:openai:Orchestrator' },
      policy: { ...modelRuntimePolicy, trust_tier: 'external', safety_class: 'sensitive' },
      route_hints: ['fallback-only'],
      route_blockers: ['cloud_fallback_requires_policy'],
      summary: 'Cloud model runtime is fallback-only when privacy policy allows it.'
    }),
    action({
      action_id: 'model-runtime-mobile-local-light',
      module: 'Orchestrator',
      method: 'GetModelCatalog',
      topic: 'Orchestrator.GetModelCatalog',
      provider_id: 'native:mobile-local-light',
      peer_id: 'native-mobile',
      provider_kind: 'native-mobile',
      service_instance_id: 'orchestrator-mobile-local-light',
      bindability: 'unavailable',
      selector: { module: 'Orchestrator', provider_id: 'native:mobile-local-light' },
      policy: { ...modelRuntimePolicy, trust_tier: 'device', local_only: true },
      route_blockers: ['native_provider_missing'],
      summary: 'Mobile local-light model runtime is gated by native provider proof.'
    }),
    action({
      action_id: 'model-runtime-import-admin',
      module: 'Orchestrator',
      method: 'ImportModel',
      topic: 'Orchestrator.ImportModel',
      provider_id: 'local:Orchestrator:llama-cpp',
      provider_kind: 'local',
      service_instance_id: 'orchestrator-local',
      selector: { peer_id: 'local-peer', module: 'Orchestrator', provider_id: 'local:Orchestrator:llama-cpp' },
      policy: modelManagePolicy,
      summary: 'Import model requires AdminAction confirmation.'
    })
  ],
  resources: [],
  provider_index: {
    TTS: ['local:TTS', 'remote:kitchen:TTS'],
    Tooling: ['local:TTS', 'remote:kitchen:TTS'],
    Orchestrator: [
      'local:Orchestrator:llama-cpp',
      'mesh:studio-gpu:Orchestrator',
      'cloud:openai:Orchestrator',
      'native:mobile-local-light'
    ]
  },
  action_index: {
    'TTS.Synthesize': ['tts-local-synthesize', 'tts-remote-synthesize'],
    'Tooling.ExecuteTool': [
      'tool-remote-file-search',
      'tool-local-notes',
      'tool-remote-notes',
      'tool-remote-door',
      'tool-stale-camera'
    ],
    'Orchestrator.GetModelCatalog': [
      'model-runtime-local-catalog',
      'model-runtime-mesh-catalog',
      'model-runtime-cloud-catalog',
      'model-runtime-mobile-local-light'
    ],
    'Orchestrator.ImportModel': ['model-runtime-import-admin']
  },
  secrets_redacted: true
}

export const gatewayServicesFixture: GetServicesResponse = {
  mode: 'threads',
  services: [
    {
      module: 'Gateway',
      version: '0.1.0',
      summary: 'Gateway service',
      capabilities: ['registry'],
      method_count: 3,
      last_seen: '2026-06-19T00:00:00Z',
      status: 'healthy',
      instance_id: null
    }
  ]
}

export const deploymentTopologyFixture: DeploymentTopologyResponse = {
  architecture_mode: 'threads',
  runtime_mode: 'thread-local',
  bus_backend: 'LocalBus',
  redis_url_redacted: null,
  redis_reachable: null,
  bullmq_queue_health: {
    backend: 'LocalBus',
    redis_url_redacted: null,
    redis_reachable: null,
    bullmq_available: null,
    queue_lag_known: true,
    queue_depth: null,
    published: 12,
    delivered: 12,
    retries: 0,
    dead_letters: 0,
    status: 'healthy',
    degraded_reasons: [],
    error: null
  },
  service_process_topology: [
    {
      module: 'Gateway',
      status: 'healthy',
      topology: 'thread',
      instance_id: null,
      container_hint: null,
      process_hint: 'single-process',
      last_seen: '2026-06-19T00:00:00Z',
      stale: false
    }
  ],
  container_topology_hints: {
    orchestrator: 'in-process-supervisor',
    compose_file: null,
    redis_service: null,
    gateway_service: null,
    config_service: null,
    notes: [
      'thread mode runs services in one Python process',
      'process controls and per-container health are unsupported in thread mode'
    ]
  },
  mode_capability_degradations: ['thread_mode_no_process_controls'],
  mesh_peer_topology_trusted: null,
  generated_at: '2026-06-19T00:00:00Z',
  secrets_redacted: true
}

export const webrtcDiagnosticsFixture: WebRTCDiagnosticsResponse = {
  enabled: true,
  started: true,
  mesh_enabled: true,
  local_signaling_peer_id: 'signaling-local',
  local_mesh_peer_id: 'local-peer',
  local_node_name: 'aurora-prod-01',
  require_auth: true,
  auth_timeout_seconds: 10,
  pairing_timeout_seconds: 300,
  app_layer_e2ee_enabled: true,
  signaling: {
    strategy: 'mqtt',
    connected: true,
    encrypted_presence: true,
    app_id_configured: true,
    room_configured: true,
    broker_count: 1,
    public_broker_warning: false
  },
  peers: [
    {
      signaling_peer_id: 'session-peer',
      stable_peer_id: 'stable-peer',
      node_name: 'remote-node',
      connection_state: 'connected',
      ice_connection_state: 'completed',
      ice_gathering_state: 'complete',
      signaling_state: 'stable',
      data_channel_state: 'open',
      data_channel_label: 'aurora-rpc',
      has_send_channel: true,
      rtt_ms: 42.5,
      auth_state: 'authenticated',
      identity_source: 'webrtc_peer',
      is_admin: false,
      effective_permission_count: 1,
      pairing_active: false,
      auth_timeout_pending: false,
      pending_pairing_task: false
    }
  ],
  connected_peer_count: 1,
  authenticated_peer_count: 1,
  pairing_peer_count: 0,
  pending_rpc_count: 0,
  recent_errors: [
    {
      timestamp: '2026-06-19T00:00:00Z',
      code: 'rpc_timeout',
      message: 'RPC call timed out',
      peer_id: 'stable-peer'
    }
  ],
  secrets_redacted: true
}

export const gatewayBuiltinRoutesFixture: GatewayBuiltinRouteDescriptor[] = [
  {
    name: 'health_check',
    summary: 'Gateway health check',
    routePath: '/api/health',
    httpMethods: ['GET'],
    routeKind: 'gateway_builtin',
    exposure: 'gateway_builtin',
    methodType: 'gateway',
    requiredPermissions: []
  },
  {
    name: 'list_peers',
    summary: 'List connected WebRTC peers',
    routePath: '/api/admin/peers',
    httpMethods: ['GET'],
    routeKind: 'gateway_builtin',
    exposure: 'gateway_builtin',
    methodType: 'manage',
    requiredPermissions: ['Auth.manage']
  }
]

export const backendInventoryFixture: BackendInventory = {
  generated_by: 'scripts/generate_backend_inventory.py',
  method_count: 11,
  gateway_builtin_count: 2,
  methods: [
    {
      module: 'Orchestrator',
      name: 'GetModelCatalog',
      summary: 'Return UI-safe model runtime provider catalog',
      bus_topic: 'Orchestrator.GetModelCatalog',
      routePath: '/api/Orchestrator/GetModelCatalog',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'use',
      required_perms: ['Orchestrator.use'],
      input_model: 'ModelRuntimeCatalogRequest',
      output_model: 'ModelRuntimeCatalogResponse',
      input_schema: {
        title: 'ModelRuntimeCatalogRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ModelRuntimeCatalogResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    },
    {
      module: 'Orchestrator',
      name: 'GetModelRuntime',
      summary: 'Return selected model runtime provider detail',
      bus_topic: 'Orchestrator.GetModelRuntime',
      routePath: '/api/Orchestrator/GetModelRuntime',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'use',
      required_perms: ['Orchestrator.use'],
      input_model: 'ModelRuntimeRequest',
      output_model: 'ModelRuntimeResponse',
      input_schema: {
        title: 'ModelRuntimeRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ModelRuntimeResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    },
    {
      module: 'Orchestrator',
      name: 'ImportModel',
      summary: 'Import a model through AdminAction-gated backend workflow',
      bus_topic: 'Orchestrator.ImportModel',
      routePath: '/api/Orchestrator/ImportModel',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'manage',
      required_perms: ['Orchestrator.manage'],
      input_model: 'ModelRuntimeOperationRequest',
      output_model: 'ModelRuntimeOperationResponse',
      input_schema: {
        title: 'ModelRuntimeOperationRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ModelRuntimeOperationResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    },
    {
      module: 'Orchestrator',
      name: 'DownloadModel',
      summary: 'Download a model through AdminAction-gated backend workflow',
      bus_topic: 'Orchestrator.DownloadModel',
      routePath: '/api/Orchestrator/DownloadModel',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'manage',
      required_perms: ['Orchestrator.manage'],
      input_model: 'ModelRuntimeOperationRequest',
      output_model: 'ModelRuntimeOperationResponse',
      input_schema: {
        title: 'ModelRuntimeOperationRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ModelRuntimeOperationResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    },
    {
      module: 'Orchestrator',
      name: 'BenchmarkModel',
      summary: 'Benchmark a model runtime provider',
      bus_topic: 'Orchestrator.BenchmarkModel',
      routePath: '/api/Orchestrator/BenchmarkModel',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'manage',
      required_perms: ['Orchestrator.manage'],
      input_model: 'ModelRuntimeOperationRequest',
      output_model: 'ModelRuntimeOperationResponse',
      input_schema: {
        title: 'ModelRuntimeOperationRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ModelRuntimeOperationResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    },
    {
      module: 'Auth',
      name: 'ListPendingPairings',
      summary: 'List pending device and mesh pairing requests for authorized admins',
      bus_topic: 'Auth.ListPendingPairings',
      routePath: '/api/Auth/ListPendingPairings',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'ListPendingPairingsRequest',
      output_model: 'ListPendingPairingsResponse',
      input_schema: {
        title: 'ListPendingPairingsRequest',
        type: 'object'
      },
      output_schema: {
        title: 'ListPendingPairingsResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:100'
    },
    {
      module: 'Gateway',
      name: 'GetRegistry',
      summary: 'Return the aggregated service registry',
      bus_topic: 'Gateway.GetRegistry',
      routePath: '/api/Gateway/GetRegistry',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'use',
      required_perms: ['Gateway.use'],
      input_model: null,
      output_model: 'GetRegistryResponse',
      input_schema: null,
      output_schema: {
        title: 'GetRegistryResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/gateway/service.py:100'
    },
    {
      module: 'Gateway',
      name: 'GetDeploymentTopology',
      summary: 'Get sanitized deployment topology and message bus health',
      bus_topic: 'Gateway.GetDeploymentTopology',
      routePath: '/api/Gateway/GetDeploymentTopology',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'manage',
      required_perms: ['Gateway.manage'],
      input_model: 'EmptyInput',
      output_model: 'DeploymentTopologyResponse',
      input_schema: null,
      output_schema: {
        title: 'DeploymentTopologyResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/gateway/service.py:100'
    },
    {
      module: 'Gateway',
      name: 'GetWebRTCDiagnostics',
      summary: 'Get read-only WebRTC, ICE, and DataChannel diagnostics',
      bus_topic: 'Gateway.GetWebRTCDiagnostics',
      routePath: '/api/Gateway/GetWebRTCDiagnostics',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'manage',
      required_perms: ['Gateway.manage'],
      input_model: 'EmptyInput',
      output_model: 'WebRTCDiagnosticsResponse',
      input_schema: null,
      output_schema: {
        title: 'WebRTCDiagnosticsResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/gateway/service.py:100'
    },
    {
      module: 'Gateway',
      name: 'InternalOnly',
      summary: 'Internal-only method',
      bus_topic: 'Gateway.InternalOnly',
      routePath: null,
      route_kind: 'internal_bus',
      exposure: 'internal',
      method_type: 'manage',
      required_perms: ['Gateway.manage'],
      input_model: null,
      output_model: null,
      input_schema: null,
      output_schema: null,
      source: 'static_contract',
      source_file: 'tests/fixtures/gateway.py:1'
    },
    {
      module: 'Orchestrator',
      name: 'IngestContext',
      summary: 'Ingest assistant attachment and shared context metadata',
      bus_topic: 'Orchestrator.IngestContext',
      routePath: '/api/Orchestrator/IngestContext',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'use',
      required_perms: ['Orchestrator.use'],
      input_model: 'AttachmentContextIngestRequest',
      output_model: 'AttachmentContextIngestResponse',
      input_schema: {
        title: 'AttachmentContextIngestRequest',
        type: 'object'
      },
      output_schema: {
        title: 'AttachmentContextIngestResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/orchestrator/service.py:245'
    }
  ],
  gateway_builtins: [
    {
      name: 'get_registry',
      summary: 'Get aggregated service registry',
      routePath: '/api/registry',
      http_methods: ['GET'],
      route_kind: 'gateway_builtin',
      exposure: 'gateway_builtin',
      method_type: 'gateway',
      required_perms: []
    },
    {
      name: 'list_peers',
      summary: 'List connected WebRTC peers',
      routePath: '/api/admin/peers',
      http_methods: ['GET'],
      route_kind: 'gateway_builtin',
      exposure: 'gateway_builtin',
      method_type: 'manage',
      required_perms: ['Auth.manage']
    }
  ],
  import_errors: [],
  ui_fixture_validation: {
    checked: 0,
    errors: [],
    ok: true
  }
}

export const routeExplainFixture: RouteExplainResponse = {
  topic: 'TTS.Synthesize',
  module: 'TTS',
  selected_target: 'none',
  selected_peer_id: null,
  selected_service_instance_id: null,
  selected_provider_id: null,
  selector_valid: false,
  selector_validation_code: 'explicit_selector_required',
  selector_validation_message: 'Remote TTS synthesis requires an explicit peer selector and consent.',
  fallback_behavior: 'blocked',
  candidates: [
    {
      provider_id: remoteTtsProvider.provider_id,
      peer_id: remoteTtsProvider.peer_id,
      provider_kind: remoteTtsProvider.provider_kind,
      service_instance_id: remoteTtsProvider.service_instance_id,
      module: remoteTtsProvider.module,
      version: remoteTtsProvider.version,
      included: true,
      selected: false,
      reason_code: remoteTtsProvider.reason_code,
      reason: remoteTtsProvider.reason,
      latency_ms: remoteTtsProvider.latency_ms,
      active_calls: remoteTtsProvider.active_calls,
      max_concurrent: remoteTtsProvider.max_concurrent,
      available_capacity: remoteTtsProvider.available_capacity,
      blockers: [
        {
          code: 'explicit_selector_required',
          message: 'Select the target peer before remote raw-audio capable synthesis.',
          severity: 'error',
          provider_id: remoteTtsProvider.provider_id,
          peer_id: remoteTtsProvider.peer_id,
          security_privacy: true
        }
      ]
    }
  ],
  blockers: [
    {
      code: 'explicit_selector_required',
      message: 'Select the target peer before remote raw-audio capable synthesis.',
      severity: 'error',
      provider_id: remoteTtsProvider.provider_id,
      peer_id: remoteTtsProvider.peer_id,
      security_privacy: true
    }
  ],
  security_privacy_blockers: [
    {
      code: 'privacy_indicator_required',
      message: 'Show privacy/consent state before sending audio work to a peer.',
      severity: 'error',
      provider_id: remoteTtsProvider.provider_id,
      peer_id: remoteTtsProvider.peer_id,
      security_privacy: true
    }
  ],
  secrets_redacted: true
}

export const nativeCapabilityManifestFixture: NativeCapabilityManifest = {
  platform: 'tauri-desktop',
  permissions: {
    microphone: false,
    notifications: true,
    secureStorage: true,
    mobileLocalLightRuntime: false
  },
  capabilities: {
    localGateway: true,
    sidecarSupervisor: false,
    voiceCapture: false,
    mobileLocalLightRuntime: false
  }
}

const idleModelProgress = (operationType: string) => ({
  operation_id: null,
  operation_type: operationType,
  status: 'idle',
  progress_percent: 0,
  message: 'No backend operation is active.',
  updated_at: null
})

export const modelRuntimeCatalogFixture: ModelRuntimeCatalogResponse = {
  generated_at: '2026-06-19T00:00:00Z',
  selected_provider_id: 'local:Orchestrator:llama-cpp',
  providers: [
    {
      provider_id: 'local:Orchestrator:llama-cpp',
      display_name: 'llama.cpp desktop',
      backend_kind: 'desktop-local',
      provider_type: 'local',
      enabled: true,
      selected: true,
      health: 'healthy',
      health_reason: 'Local runtime loaded from backend catalog.',
      model_id: 'llama-3-8b-instruct',
      source: 'local-filesystem',
      license: 'user-provided',
      context_window: 8192,
      generation_limit: 2048,
      hardware: {
        accelerator: 'cpu',
        memory_gb: 16,
        quantization: 'Q4_K_M'
      },
      model_files: [
        {
          kind: 'weights',
          display_name: 'llama-3-8b-instruct.Q4_K_M.gguf',
          exists: true,
          size_bytes: 4_920_000_000,
          path_redacted: true
        }
      ],
      capabilities: ['chat', 'tools-context', 'local-only'],
      benchmark: {
        status: 'complete',
        tokens_per_second: 31.4,
        latency_ms: 1200,
        measured_at: '2026-06-19T00:00:00Z',
        reason: null
      },
      import_progress: idleModelProgress('import'),
      download_progress: idleModelProgress('download'),
      secrets_redacted: true
    },
    {
      provider_id: 'mesh:studio-gpu:Orchestrator',
      display_name: 'studio-gpu peer',
      backend_kind: 'mesh-remote',
      provider_type: 'mesh',
      enabled: true,
      selected: false,
      health: 'degraded',
      health_reason: 'Eligible remote provider; policy requires route/privacy review before sensitive prompts.',
      model_id: 'qwen-32b',
      source: 'mesh-peer',
      license: 'peer-managed',
      context_window: 32768,
      generation_limit: 4096,
      hardware: {
        accelerator: 'cuda',
        gpu: 'RTX 4090',
        vram_gb: 24
      },
      model_files: [
        {
          kind: 'weights',
          display_name: 'peer-managed weights',
          exists: true,
          size_bytes: null,
          path_redacted: true
        }
      ],
      capabilities: ['chat', 'large-context', 'mesh-route'],
      benchmark: {
        status: 'complete',
        tokens_per_second: 78.2,
        latency_ms: 34,
        measured_at: '2026-06-19T00:00:00Z',
        reason: 'mesh route latency only; prompt privacy still policy-gated'
      },
      import_progress: idleModelProgress('import'),
      download_progress: idleModelProgress('download'),
      secrets_redacted: true
    },
    {
      provider_id: 'cloud:openai:Orchestrator',
      display_name: 'OpenAI-compatible gateway',
      backend_kind: 'server-cloud',
      provider_type: 'cloud',
      enabled: false,
      selected: false,
      health: 'privacy-blocked',
      health_reason: 'Cloud fallback is disabled until policy allows egress for the selected privacy class.',
      model_id: 'gpt-class-large',
      source: 'external-api',
      license: 'provider-managed',
      context_window: 128000,
      generation_limit: 4096,
      hardware: {
        accelerator: 'provider-managed'
      },
      model_files: [],
      capabilities: ['chat', 'fallback'],
      benchmark: {
        status: 'unavailable',
        tokens_per_second: null,
        latency_ms: 620,
        measured_at: null,
        reason: 'privacy policy blocks cloud fallback'
      },
      import_progress: idleModelProgress('import'),
      download_progress: idleModelProgress('download'),
      secrets_redacted: true
    },
    {
      provider_id: 'native:mobile-local-light',
      display_name: 'Mobile local-light runtime',
      backend_kind: 'mobile-local-light',
      provider_type: 'native-mobile',
      enabled: false,
      selected: false,
      health: 'unsupported',
      health_reason: 'Native Android/iOS provider proof is not available in this manifest.',
      model_id: 'phi-mini',
      source: 'native-manifest',
      license: 'planned',
      context_window: 4096,
      generation_limit: 1024,
      hardware: {
        accelerator: 'mobile-npu',
        proof: 'missing'
      },
      model_files: [],
      capabilities: ['planned-mobile-local-light'],
      benchmark: {
        status: 'unsupported',
        tokens_per_second: null,
        latency_ms: null,
        measured_at: null,
        reason: 'requires native provider benchmark/device proof'
      },
      import_progress: idleModelProgress('import'),
      download_progress: idleModelProgress('download'),
      secrets_redacted: true
    }
  ],
  provider_index: {
    local: ['local:Orchestrator:llama-cpp'],
    mesh: ['mesh:studio-gpu:Orchestrator'],
    cloud: ['cloud:openai:Orchestrator'],
    'native-mobile': ['native:mobile-local-light']
  },
  unavailable: ['native:mobile-local-light'],
  internal_only: [],
  secrets_redacted: true
}

export const toolCatalogFixture = {
  generated_at: '2026-06-19T00:00:00Z',
  tools: [
    {
      global_tool_id: 'tool:local:diagnostics.serviceHealth',
      provider_peer_id: 'local-peer',
      provider_id: 'local:Tooling',
      service_instance_id: 'tool-1a9e',
      display_name: 'diagnostics.serviceHealth',
      safety_class: 'standard',
      approval_required: false,
      required_permissions: ['Tooling.use'],
      correlation_id: 'corr-tool-catalog-fixture',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:local:filesystem.writeConfig',
      local_name: 'filesystem.writeConfig',
      display_name: 'Write local config file',
      description: 'Mutates a local configuration file after approval.',
      provider_id: 'local:Tooling',
      provider_peer_id: 'local-peer',
      service_instance_id: 'tooling-local',
      provider_kind: 'local',
      trust_tier: 'local',
      transport: 'local-bus',
      route_path: ['local-peer', 'tooling-local'],
      risk_class: 'admin-critical',
      safety_class: 'admin-critical',
      approval_required: true,
      explicit_selector_required: false,
      data_egress: false,
      mutating: true,
      admin: true,
      method_type: 'manage',
      required_permissions: ['Tooling.use', 'Tooling.manage'],
      args_hash: 'sha256:local-danger',
      redacted_args_preview: { path: '/config/settings.json', mode: 'append', token: '[redacted]' },
      args_schema: {
        type: 'object',
        required: ['path', 'mode'],
        properties: {
          path: { type: 'string' },
          mode: { enum: ['append', 'replace'] }
        }
      },
      requested_approval_scope: 'once',
      approval_scopes: ['once', 'session', 'local-safe-tools'],
      token_ttl_seconds: 300,
      audit_destination: 'audit.local.tooling',
      correlation_id: 'corr-local-danger',
      policy_decision_id: 'policy-local-danger',
      approval_request_id: 'approval-local-danger',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:remote:garageDoor.open',
      local_name: 'garageDoor.open',
      display_name: 'Open garage door',
      description: 'Controls remote hardware through a mesh peer.',
      provider_id: 'mesh:garage:Tooling',
      provider_peer_id: 'peer-garage',
      service_instance_id: 'tooling-garage',
      provider_kind: 'mesh',
      trust_tier: 'paired-admin',
      transport: 'webrtc-datachannel',
      route_path: ['local-peer', 'peer-garage', 'tooling-garage'],
      risk_class: 'admin',
      safety_class: 'admin',
      approval_required: true,
      explicit_selector_required: true,
      data_egress: true,
      mutating: true,
      admin: true,
      method_type: 'manage',
      required_permissions: ['Tooling.use', 'Hardware.manage'],
      args_hash: 'sha256:garage-open',
      redacted_args_preview: { door: 'garage-main', duration_s: 10, precise_location: '[redacted]' },
      mesh_selector: { peer_id: 'peer-garage', service_instance_id: 'tooling-garage' },
      resource_selector: { resource_id: 'garage-main-door', kind: 'hardware' },
      requested_approval_scope: 'peer',
      approval_scopes: ['once', 'session', 'peer'],
      token_ttl_seconds: 120,
      audit_destination: 'audit.mesh.hardware',
      correlation_id: 'corr-remote-danger',
      policy_decision_id: 'policy-remote-danger',
      approval_request_id: 'approval-remote-danger',
      providers: [
        {
          id: 'mesh:garage:Tooling',
          label: 'garage-node / Tooling.ExecuteTool',
          provider_peer_id: 'peer-garage',
          service_instance_id: 'tooling-garage',
          provider_kind: 'mesh',
          trust_tier: 'paired-admin',
          transport: 'webrtc-datachannel',
          selectable: true,
          reason: 'Explicit selector accepted by backend policy.'
        }
      ],
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:notes.search',
      local_name: 'notes.search',
      display_name: 'Search notes',
      description: 'Read-only notes lookup available locally and from a remote peer.',
      provider_id: 'local:Tooling',
      provider_peer_id: 'local-peer',
      service_instance_id: 'tooling-local',
      provider_kind: 'local',
      trust_tier: 'local',
      transport: 'local-bus',
      route_path: ['local-peer', 'tooling-local'],
      risk_class: 'read-only',
      safety_class: 'standard',
      approval_required: true,
      explicit_selector_required: true,
      provider_selector_required: true,
      data_egress: false,
      mutating: false,
      method_type: 'use',
      required_permissions: ['Tooling.use'],
      args_hash: 'sha256:notes-query',
      redacted_args_preview: { query: 'deployment health', max_results: 5 },
      requested_approval_scope: 'session',
      approval_scopes: ['once', 'session', 'peer'],
      token_ttl_seconds: 900,
      audit_destination: 'audit.tooling.search',
      correlation_id: 'corr-notes-selector',
      providers: [
        {
          id: 'local:Tooling:notes',
          label: 'local / notes.search',
          provider_peer_id: 'local-peer',
          service_instance_id: 'tooling-local',
          provider_kind: 'local',
          trust_tier: 'local',
          transport: 'local-bus',
          selectable: true,
          reason: 'Local provider is privacy-preferred.'
        },
        {
          id: 'mesh:kitchen:Tooling:notes',
          label: 'kitchen-node / notes.search',
          provider_peer_id: 'peer-kitchen',
          service_instance_id: 'tooling-kitchen',
          provider_kind: 'mesh',
          trust_tier: 'paired',
          transport: 'webrtc-datachannel',
          selectable: true,
          reason: 'Remote provider is eligible after explicit selector.'
        }
      ],
      approval_status: 'provider_selector_required',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:cloud:email.send',
      local_name: 'email.send',
      display_name: 'Send email draft',
      description: 'External email send remains dry-run until policy approval is present.',
      provider_id: 'cloud:mcp:mail',
      provider_peer_id: null,
      service_instance_id: 'mcp-mail',
      provider_kind: 'cloud',
      trust_tier: 'external',
      transport: 'mcp',
      route_path: ['local-peer', 'mcp-mail'],
      risk_class: 'external',
      approval_required: true,
      data_egress: true,
      mutating: true,
      method_type: 'manage',
      required_permissions: ['Tooling.use'],
      args_hash: 'sha256:email-send',
      redacted_args_preview: { to: 'ops@example.com', subject: 'Aurora status', body: '[redacted]' },
      requested_approval_scope: 'once',
      approval_scopes: ['once'],
      dry_run_supported: true,
      dry_run_required: true,
      dry_run_preview: { would_send: true, recipients: 1, redactions: ['body'] },
      audit_destination: 'audit.external.mcp',
      approval_status: 'dry_run_only',
      correlation_id: 'corr-dry-run',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:remote:calendar.delete',
      display_name: 'Delete calendar event',
      description: 'Denied by peer policy.',
      provider_id: 'mesh:kitchen:Tooling',
      provider_peer_id: 'peer-kitchen',
      service_instance_id: 'tooling-kitchen',
      provider_kind: 'mesh',
      trust_tier: 'paired',
      transport: 'webrtc-datachannel',
      risk_class: 'mutating',
      approval_required: true,
      data_egress: true,
      mutating: true,
      method_type: 'manage',
      required_permissions: ['Tooling.use'],
      args_hash: 'sha256:calendar-delete',
      redacted_args_preview: { event_id: 'evt_9d72', title: '[redacted]' },
      approval_status: 'denied',
      denial_reason: 'peer policy denies destructive calendar changes',
      audit_destination: 'audit.mesh.tooling',
      correlation_id: 'corr-denied-tool',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:remote:lights.scene',
      display_name: 'Apply lights scene',
      description: 'Approval request expired before confirmation.',
      provider_id: 'mesh:living-room:Tooling',
      provider_peer_id: 'peer-living-room',
      service_instance_id: 'tooling-living-room',
      provider_kind: 'mesh',
      trust_tier: 'paired',
      transport: 'webrtc-datachannel',
      risk_class: 'mutating',
      approval_required: true,
      mutating: true,
      method_type: 'manage',
      args_hash: 'sha256:lights-scene',
      redacted_args_preview: { scene: 'night' },
      approval_status: 'expired',
      expires_at: 1781950000,
      audit_destination: 'audit.mesh.tooling',
      correlation_id: 'corr-expired-tool',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:remote:door.unlock.replay',
      display_name: 'Unlock front door',
      description: 'Replay protection rejected this approval attempt.',
      provider_id: 'mesh:front-door:Tooling',
      provider_peer_id: 'peer-front-door',
      service_instance_id: 'tooling-front-door',
      provider_kind: 'mesh',
      trust_tier: 'paired-admin',
      transport: 'webrtc-datachannel',
      risk_class: 'admin-critical',
      approval_required: true,
      mutating: true,
      admin: true,
      method_type: 'manage',
      args_hash: 'sha256:door-unlock',
      redacted_args_preview: { lock: 'front-door' },
      approval_status: 'replay_rejected',
      denial_reason: 'approval_request_replayed',
      audit_destination: 'audit.mesh.hardware',
      correlation_id: 'corr-replay-tool',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:remote:camera.snapshot',
      display_name: 'Camera snapshot',
      description: 'Remote camera provider is currently unavailable.',
      provider_id: 'mesh:garage:Tooling',
      provider_peer_id: 'peer-garage',
      service_instance_id: 'tooling-garage',
      provider_kind: 'mesh',
      trust_tier: 'paired',
      transport: 'webrtc-datachannel',
      risk_class: 'sensitive',
      approval_required: true,
      data_egress: true,
      required_permissions: ['Tooling.use'],
      disabled_reason: 'service_unavailable',
      approval_status: 'unavailable',
      audit_destination: 'audit.mesh.tooling',
      correlation_id: 'corr-unavailable-tool',
      secrets_redacted: true
    },
    {
      global_tool_id: 'tool:local:diagnostics.collect',
      display_name: 'Collect diagnostics bundle',
      description: 'Completed local diagnostic collection with redacted output.',
      provider_id: 'local:Tooling',
      provider_peer_id: 'local-peer',
      service_instance_id: 'tooling-local',
      provider_kind: 'local',
      trust_tier: 'local',
      transport: 'local-bus',
      route_path: ['local-peer', 'tooling-local'],
      risk_class: 'standard',
      approval_required: false,
      data_egress: false,
      mutating: false,
      method_type: 'use',
      required_permissions: ['Tooling.use'],
      args_hash: 'sha256:diagnostics-collect',
      redacted_args_preview: { include_logs: true, secrets: '[redacted]' },
      approval_status: 'executed',
      correlation_id: 'corr-tool-result',
      audit_destination: 'audit.local.tooling',
      result: {
        status: 'success',
        ok: true,
        provider_peer_id: 'local-peer',
        correlation_id: 'corr-tool-result',
        audit_receipt: 'audit-receipt-tool-result',
        route_path: ['local-peer', 'tooling-local'],
        duration_ms: 842,
        redaction_status: 'secrets_redacted',
        retry_eligible: false,
        fallback_eligible: false,
        redacted_output_preview: { bundle_id: 'diag_123', files: 4, secrets_redacted: true }
      },
      secrets_redacted: true
    }
  ],
  secrets_redacted: true
} as const

export const uiMockReferenceFixtureSummary = {
  source: 'modules/ui-mock-reference/lib/aurora/data.ts',
  deploymentMode: 'Server',
  nodeName: 'aurora-prod-01',
  serviceModules: ['Gateway', 'Auth', 'Orchestrator', 'TTS', 'STT', 'Tooling', 'Scheduler', 'Config', 'DB', 'Supervisor'],
  availabilityStates: [
    'available-local',
    'available-remote',
    'pending',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ],
  privacyClasses: ['public', 'personal', 'sensitive', 'secret', 'raw-audio', 'credential', 'admin-critical'],
  backendTruthRule: 'Fixture labels are deterministic UI/mock references; execution truth stays with Gateway registry, capability catalog, route explain, and native manifest responses.'
} as const

export interface MockAuroraFixtureSet {
  registry: GetRegistryResponse
  services: GetServicesResponse
  deploymentTopology: DeploymentTopologyResponse
  webrtcDiagnostics: WebRTCDiagnosticsResponse
  capabilityCatalog: CapabilityCatalogResponse
  routeExplain: RouteExplainResponse
  nativeManifest: NativeCapabilityManifest
  modelRuntimeCatalog: ModelRuntimeCatalogResponse
  toolCatalog: typeof toolCatalogFixture
  backendInventory: BackendInventory
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[]
}

export const defaultMockAuroraFixtures: MockAuroraFixtureSet = {
  registry: gatewayRegistryFixture,
  services: gatewayServicesFixture,
  deploymentTopology: deploymentTopologyFixture,
  webrtcDiagnostics: webrtcDiagnosticsFixture,
  capabilityCatalog: capabilityGraphCatalogFixture,
  routeExplain: routeExplainFixture,
  nativeManifest: nativeCapabilityManifestFixture,
  modelRuntimeCatalog: modelRuntimeCatalogFixture,
  toolCatalog: toolCatalogFixture,
  backendInventory: backendInventoryFixture,
  gatewayBuiltins: gatewayBuiltinRoutesFixture
}

export interface ContractFixtureComparisonIssue {
  busTopic: string
  field: 'missing' | 'routePath' | 'requiredPermissions' | 'exposure' | 'methodType' | 'availableOverHttp'
  fixture: unknown
  inventory: unknown
}

export interface ContractFixtureComparison {
  ok: boolean
  checked: number
  issues: ContractFixtureComparisonIssue[]
}

export function compareRegistryFixtureToBackendInventory(
  registry: GetRegistryResponse,
  inventory: BackendInventory
): ContractFixtureComparison {
  const inventoryMethods = new Map(
    describeBackendInventory(inventory).methods.map((method) => [method.busTopic, method])
  )
  const issues: ContractFixtureComparisonIssue[] = []
  const registryMethods = describeRegistry(registry)

  for (const fixtureMethod of registryMethods) {
    const inventoryMethod = inventoryMethods.get(fixtureMethod.busTopic)
    if (!inventoryMethod) {
      issues.push({
        busTopic: fixtureMethod.busTopic,
        field: 'missing',
        fixture: fixtureMethod.name,
        inventory: null
      })
      continue
    }
    pushMismatch(issues, fixtureMethod.busTopic, 'routePath', fixtureMethod.routePath, inventoryMethod.routePath)
    pushMismatch(
      issues,
      fixtureMethod.busTopic,
      'requiredPermissions',
      fixtureMethod.requiredPermissions,
      inventoryMethod.requiredPermissions
    )
    pushMismatch(issues, fixtureMethod.busTopic, 'exposure', fixtureMethod.exposure, inventoryMethod.exposure)
    pushMismatch(issues, fixtureMethod.busTopic, 'methodType', fixtureMethod.methodType, inventoryMethod.methodType)
    pushMismatch(
      issues,
      fixtureMethod.busTopic,
      'availableOverHttp',
      fixtureMethod.availableOverHttp,
      inventoryMethod.availableOverHttp
    )
  }

  return {
    ok: issues.length === 0,
    checked: registryMethods.length,
    issues
  }
}

export function cloneFixture<TFixture>(fixture: TFixture): TFixture {
  return JSON.parse(JSON.stringify(fixture)) as TFixture
}

function pushMismatch(
  issues: ContractFixtureComparisonIssue[],
  busTopic: string,
  field: ContractFixtureComparisonIssue['field'],
  fixture: unknown,
  inventory: unknown
): void {
  if (JSON.stringify(fixture) === JSON.stringify(inventory)) return
  issues.push({ busTopic, field, fixture, inventory })
}
