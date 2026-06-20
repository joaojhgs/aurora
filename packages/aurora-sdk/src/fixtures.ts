import type {
  BackendInventory,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityFreshnessInfo,
  CapabilityPolicyDecisionInfo,
  CapabilityProviderInfo,
  GatewayBuiltinRouteDescriptor,
  GetRegistryResponse,
  GetServicesResponse
} from './types.js'

export const emptyRegistryFixture: GetRegistryResponse = {
  modules: [],
  digest: '',
  service_count: 0,
  method_count: 0
}

export const gatewayRegistryFixture: GetRegistryResponse = {
  modules: [
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
  service_count: 1,
  method_count: 2
}

export const capabilityCatalogFixture: CapabilityCatalogResponse = {
  generated_at: '2026-06-19T00:00:00Z',
  local_peer_id: 'local-peer',
  local_node_name: 'local',
  providers: [],
  actions: [],
  resources: [],
  provider_index: {},
  action_index: {},
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
    })
  ],
  resources: [],
  provider_index: {
    TTS: ['local:TTS', 'remote:kitchen:TTS'],
    Tooling: ['local:TTS', 'remote:kitchen:TTS']
  },
  action_index: {
    'TTS.Synthesize': ['tts-local-synthesize', 'tts-remote-synthesize'],
    'Tooling.ExecuteTool': [
      'tool-remote-file-search',
      'tool-local-notes',
      'tool-remote-notes',
      'tool-remote-door',
      'tool-stale-camera'
    ]
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
      method_count: 2,
      last_seen: '2026-06-19T00:00:00Z',
      status: 'healthy',
      instance_id: null
    }
  ]
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
  method_count: 2,
  gateway_builtin_count: 2,
  methods: [
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
