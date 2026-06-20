import type {
  BackendInventory,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityFreshnessInfo,
  CapabilityPolicyDecisionInfo,
  CapabilityProviderInfo,
  GatewayBuiltinRouteDescriptor,
  GetRegistryResponse,
  GetServicesResponse,
  NativeCapabilityManifest,
  RouteExplainResponse
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
    secureStorage: true
  },
  capabilities: {
    localGateway: true,
    sidecarSupervisor: false,
    voiceCapture: false
  }
}

export const toolCatalogFixture = {
  generated_at: '2026-06-19T00:00:00Z',
  tools: [
    {
      global_tool_id: 'tool:local:diagnostics.serviceHealth',
      provider_peer_id: 'local-peer',
      service_instance_id: 'tool-1a9e',
      display_name: 'diagnostics.serviceHealth',
      safety_class: 'standard',
      approval_required: false,
      required_permissions: ['Tooling.use'],
      correlation_id: 'corr-tool-catalog-fixture',
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
  capabilityCatalog: CapabilityCatalogResponse
  routeExplain: RouteExplainResponse
  nativeManifest: NativeCapabilityManifest
  toolCatalog: typeof toolCatalogFixture
  backendInventory: BackendInventory
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[]
}

export const defaultMockAuroraFixtures: MockAuroraFixtureSet = {
  registry: gatewayRegistryFixture,
  services: gatewayServicesFixture,
  capabilityCatalog: capabilityGraphCatalogFixture,
  routeExplain: routeExplainFixture,
  nativeManifest: nativeCapabilityManifestFixture,
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
