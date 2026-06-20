import type {
  BackendInventory,
  CapabilityCatalogResponse,
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
