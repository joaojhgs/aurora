import type {
  BackendInventory,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityFreshnessInfo,
  CapabilityPolicyDecisionInfo,
  CapabilityProviderInfo,
  DeploymentTopologyResponse,
  GatewaySupportBundleResponse,
  GatewayBuiltinRouteDescriptor,
  GetRegistryResponse,
  GetServicesResponse,
  ListPendingPairingsResponse,
  MeshPeerListResponse,
  MeshStatusResponse,
  AuditLogResponse,
  DeviceListResponse,
  ModelRuntimeCatalogResponse,
  NativeCapabilityManifest,
  PrincipalListResponse,
  PrincipalResponse,
  RouteExplainResponse,
  TokenListResponse,
  WebRTCDiagnosticsResponse
} from './types.js'
import type { BackupListResponse } from './backup.js'
import type { SchedulerListJobsResponse } from './scheduler.js'
import type {
  DBGetMessagesResponse,
  DBRAGExportNamespaceResponse,
  DBRAGExportRecord,
  DBRAGImportNamespaceResponse,
  DBRAGListNamespacesResponse,
  DBRAGProvenance,
  DBRAGSearchRemoteResponse,
  DBRAGSearchRemoteRequest
} from './memory.js'
import type {
  ConfigDiffPreviewResponse,
  ConfigGetResponse,
  ConfigReloadImpactResponse,
  ConfigRollbackResponse,
  ConfigSchemaMetadataResponse,
  ConfigSetResponse,
  ConfigValidateResponse,
  ConfigVersionHistoryResponse
} from './config.js'
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
          name: 'GetMeshStatus',
          summary: 'Return read-only mesh peer and route diagnostics',
          bus_topic: 'Gateway.GetMeshStatus',
          exposure: 'external',
          input_model: 'EmptyInput',
          output_model: 'GetMeshStatusResponse',
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
    },
    {
      module: 'Auth',
      version: '0.1.0',
      summary: 'Authentication, authorization, pairing, and principal management',
      capabilities: ['login', 'pairing', 'principals', 'permissions', 'tokens', 'devices', 'audit', 'mesh'],
      methods: [
        {
          name: 'ListPendingPairings',
          summary: 'List pending device and mesh pairing requests for authorized admins',
          bus_topic: 'Auth.ListPendingPairings',
          exposure: 'both',
          input_model: 'ListPendingPairingsRequest',
          output_model: 'ListPendingPairingsResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshListPeers',
          summary: 'List persisted mesh peers and trust state',
          bus_topic: 'Auth.MeshListPeers',
          exposure: 'both',
          input_model: 'MeshPeerListRequest',
          output_model: 'MeshPeerListResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshGetPeer',
          summary: 'Get one persisted mesh peer trust record',
          bus_topic: 'Auth.MeshGetPeer',
          exposure: 'both',
          input_model: 'MeshPeerGetRequest',
          output_model: 'MeshPeerGetResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshApprovePeer',
          summary: 'Approve a mesh peer and granted outbound permissions',
          bus_topic: 'Auth.MeshApprovePeer',
          exposure: 'both',
          input_model: 'MeshPeerApproveRequest',
          output_model: 'MeshBoolResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshDenyPeer',
          summary: 'Deny a persisted mesh peer',
          bus_topic: 'Auth.MeshDenyPeer',
          exposure: 'both',
          input_model: 'MeshPeerDenyRequest',
          output_model: 'MeshBoolResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshUpdatePeerPermissions',
          summary: 'Replace outbound mesh peer permissions',
          bus_topic: 'Auth.MeshUpdatePeerPermissions',
          exposure: 'both',
          input_model: 'MeshPeerUpdatePermissionsRequest',
          output_model: 'MeshBoolResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'MeshRemovePeer',
          summary: 'Remove a mesh peer record and optionally revoke its token',
          bus_topic: 'Auth.MeshRemovePeer',
          exposure: 'both',
          input_model: 'MeshPeerRemoveRequest',
          output_model: 'MeshBoolResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'ListPrincipals',
          summary: 'List all principals',
          bus_topic: 'Auth.ListPrincipals',
          exposure: 'both',
          input_model: 'PrincipalListRequest',
          output_model: 'PrincipalListResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'CreatePrincipal',
          summary: 'Create a new principal',
          bus_topic: 'Auth.CreatePrincipal',
          exposure: 'both',
          input_model: 'PrincipalCreateRequest',
          output_model: 'PrincipalResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'UpdatePrincipal',
          summary: 'Update a principal',
          bus_topic: 'Auth.UpdatePrincipal',
          exposure: 'both',
          input_model: 'PrincipalUpdateRequest',
          output_model: 'PrincipalResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'DeletePrincipal',
          summary: 'Delete a principal',
          bus_topic: 'Auth.DeletePrincipal',
          exposure: 'both',
          input_model: 'PrincipalDeleteRequest',
          output_model: 'PrincipalDeleteResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'SetPermissions',
          summary: 'Set permissions for a principal',
          bus_topic: 'Auth.SetPermissions',
          exposure: 'both',
          input_model: 'PermissionSetRequest',
          output_model: 'PermissionSetResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'PatchPermissions',
          summary: 'Add/remove specific permissions for a principal',
          bus_topic: 'Auth.PatchPermissions',
          exposure: 'both',
          input_model: 'PermissionPatchRequest',
          output_model: 'PermissionPatchResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'ListTokens',
          summary: 'List tokens, optionally filtered by principal or device',
          bus_topic: 'Auth.ListTokens',
          exposure: 'both',
          input_model: 'TokenListRequest',
          output_model: 'TokenListResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'RevokeToken',
          summary: 'Revoke a token',
          bus_topic: 'Auth.RevokeToken',
          exposure: 'both',
          input_model: 'TokenRevokeRequest',
          output_model: 'TokenRevokeResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'ListDevices',
          summary: 'List devices, optionally filtered by principal',
          bus_topic: 'Auth.ListDevices',
          exposure: 'both',
          input_model: 'DeviceListRequest',
          output_model: 'DeviceListResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'DeleteDevice',
          summary: 'Delete a device',
          bus_topic: 'Auth.DeleteDevice',
          exposure: 'both',
          input_model: 'DeviceDeleteRequest',
          output_model: 'DeviceDeleteResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'AuditLog',
          summary: 'Get audit log entries',
          bus_topic: 'Auth.AuditLog',
          exposure: 'both',
          input_model: 'AuditLogRequest',
          output_model: 'AuditLogResponse',
          required_perms: ['Auth.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        }
      ]
    },
    {
      module: 'Scheduler',
      version: '0.1.0',
      summary: 'Scheduler jobs and delegated automation management',
      capabilities: ['jobs', 'delegation', 'automation'],
      methods: [
        {
          name: 'ListJobs',
          summary: 'List scheduler jobs visible to the caller namespace',
          bus_topic: 'Scheduler.ListJobs',
          exposure: 'both',
          input_model: 'SchedulerListJobsRequest',
          output_model: 'SchedulerListJobsResponse',
          required_perms: ['Scheduler.use'],
          method_type: 'use',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'Schedule',
          summary: 'Schedule a local or delegated automation job',
          bus_topic: 'Scheduler.Schedule',
          exposure: 'both',
          input_model: 'SchedulerScheduleJobRequest',
          output_model: 'SchedulerActionResponse',
          required_perms: ['Scheduler.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'Cancel',
          summary: 'Cancel a scheduler job in an authorized owner namespace',
          bus_topic: 'Scheduler.Cancel',
          exposure: 'both',
          input_model: 'SchedulerScopedJobRequest',
          output_model: 'SchedulerActionResponse',
          required_perms: ['Scheduler.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'Pause',
          summary: 'Pause a scheduler job when backend management support is enabled',
          bus_topic: 'Scheduler.Pause',
          exposure: 'both',
          input_model: 'SchedulerScopedJobRequest',
          output_model: 'SchedulerActionResponse',
          required_perms: ['Scheduler.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        },
        {
          name: 'Resume',
          summary: 'Resume a scheduler job when backend management support is enabled',
          bus_topic: 'Scheduler.Resume',
          exposure: 'both',
          input_model: 'SchedulerScopedJobRequest',
          output_model: 'SchedulerActionResponse',
          required_perms: ['Scheduler.manage'],
          method_type: 'manage',
          input_schema: null,
          output_schema: null
        }
      ]
    }
  ],
  digest: 'fixture',
  service_count: 4,
  method_count: 25
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

const localBackupProvider: CapabilityProviderInfo = {
  provider_id: 'local:Backup',
  peer_id: 'local-peer',
  provider_kind: 'local',
  node_name: 'aurora-prod-01',
  status: 'healthy',
  service_instance_id: 'backup-local-01',
  module: 'Backup',
  version: '0.1.0',
  latency_ms: 2,
  max_concurrent: 2,
  active_calls: 0,
  available_capacity: 2,
  eligible: true,
  reason_code: 'eligible',
  reason: 'Local Backup service fixture is available.',
  policy: {
    ...standardPolicy,
    required_permissions: ['Backup.manage'],
    safety_class: 'admin',
    operation_class: 'admin'
  },
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
  providers: [localGatewayProvider, remoteTtsProvider, staleDbProvider, localBackupProvider],
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
    }),
    actionFixture(localBackupProvider, {
      action_id: 'backup-list-local',
      method: 'List',
      topic: 'Backup.List',
      summary: 'List UI-safe backup manifests through the Backup service.',
      bindability: 'available'
    })
  ],
  resources: [],
  provider_index: {
    Gateway: ['local:Gateway'],
    TTS: ['mesh:studio-gpu:TTS'],
    DB: ['mesh:cabin-node:DB'],
    Backup: ['local:Backup']
  },
  action_index: {
    Gateway: ['gateway-registry-local'],
    TTS: ['tts-remote-privacy-blocked'],
    DB: ['db-stale-rag-search'],
    Backup: ['backup-list-local']
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
      provider_id: 'local:Backup',
      module: 'Backup',
      service_instance_id: 'backup-local',
      policy: {
        ...basePolicy,
        required_permissions: ['Backup.manage'],
        operation_class: 'admin',
        safety_class: 'admin'
      }
    }),
    provider({
      provider_id: 'local:Scheduler',
      module: 'Scheduler',
      service_instance_id: 'scheduler-local',
      reason: 'Local Scheduler service exposes namespace-scoped job management.',
      policy: {
        ...basePolicy,
        required_permissions: ['Scheduler.manage'],
        operation_class: 'admin',
        safety_class: 'admin'
      }
    }),
    provider({
      provider_id: 'mesh:studio-gpu:Scheduler',
      peer_id: 'peer-studio-gpu',
      provider_kind: 'mesh',
      node_name: 'studio-gpu',
      module: 'Scheduler',
      service_instance_id: 'scheduler-studio-gpu',
      latency_ms: 42,
      reason: 'Remote scheduler delegation provider is eligible when selector and policy are present.',
      policy: {
        ...basePolicy,
        required_permissions: ['Scheduler.manage'],
        trust_tier: 'paired',
        mesh_visible: true,
        operation_class: 'admin',
        safety_class: 'admin'
      }
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
    }),
    provider({
      provider_id: 'local:Auth',
      module: 'Auth',
      service_instance_id: 'auth-local',
      reason: 'Local Auth service exposes RBAC management contracts.',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'admin' }
    })
  ],
  actions: [
    action({
      action_id: 'gateway-mesh-status-local',
      module: 'Gateway',
      method: 'GetMeshStatus',
      topic: 'Gateway.GetMeshStatus',
      provider_id: 'local:Gateway',
      service_instance_id: 'gateway-local',
      policy: { ...basePolicy, required_permissions: ['Gateway.use'] },
      summary: 'Return read-only mesh peer lifecycle and route diagnostics.'
    }),
    action({
      action_id: 'auth-mesh-list-peers-local',
      module: 'Auth',
      method: 'MeshListPeers',
      topic: 'Auth.MeshListPeers',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'admin' },
      summary: 'List persisted mesh peer trust state.'
    }),
    action({
      action_id: 'auth-mesh-approve-peer-local',
      module: 'Auth',
      method: 'MeshApprovePeer',
      topic: 'Auth.MeshApprovePeer',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Approve a persisted mesh peer through AdminAction.'
    }),
    action({
      action_id: 'auth-mesh-deny-peer-local',
      module: 'Auth',
      method: 'MeshDenyPeer',
      topic: 'Auth.MeshDenyPeer',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Deny a persisted mesh peer through AdminAction.'
    }),
    action({
      action_id: 'auth-mesh-update-peer-permissions-local',
      module: 'Auth',
      method: 'MeshUpdatePeerPermissions',
      topic: 'Auth.MeshUpdatePeerPermissions',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Update persisted mesh peer permissions through AdminAction.'
    }),
    action({
      action_id: 'auth-mesh-remove-peer-local',
      module: 'Auth',
      method: 'MeshRemovePeer',
      topic: 'Auth.MeshRemovePeer',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Remove a persisted mesh peer through AdminAction.'
    }),
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
      action_id: 'backup-list-local',
      module: 'Backup',
      method: 'List',
      topic: 'Backup.List',
      provider_id: 'local:Backup',
      service_instance_id: 'backup-local',
      summary: 'List UI-safe backup manifests through the Backup service.',
      policy: {
        ...basePolicy,
        required_permissions: ['Backup.manage'],
        operation_class: 'admin',
        safety_class: 'admin'
      }
    }),
    action({
      action_id: 'scheduler-list-local',
      module: 'Scheduler',
      method: 'ListJobs',
      topic: 'Scheduler.ListJobs',
      provider_id: 'local:Scheduler',
      service_instance_id: 'scheduler-local',
      selector: { peer_id: 'local-peer', module: 'Scheduler' },
      policy: { ...basePolicy, required_permissions: ['Scheduler.use'], operation_class: 'admin', safety_class: 'admin' },
      summary: 'List namespace-scoped scheduler jobs through Scheduler.'
    }),
    action({
      action_id: 'scheduler-schedule-local',
      module: 'Scheduler',
      method: 'Schedule',
      topic: 'Scheduler.Schedule',
      provider_id: 'local:Scheduler',
      service_instance_id: 'scheduler-local',
      selector: { peer_id: 'local-peer', module: 'Scheduler' },
      policy: { ...basePolicy, required_permissions: ['Scheduler.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Create scheduler jobs through AdminAction.'
    }),
    action({
      action_id: 'scheduler-cancel-local',
      module: 'Scheduler',
      method: 'Cancel',
      topic: 'Scheduler.Cancel',
      provider_id: 'local:Scheduler',
      service_instance_id: 'scheduler-local',
      selector: { peer_id: 'local-peer', module: 'Scheduler' },
      policy: { ...basePolicy, required_permissions: ['Scheduler.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Cancel scheduler jobs through AdminAction.'
    }),
    action({
      action_id: 'scheduler-pause-local',
      module: 'Scheduler',
      method: 'Pause',
      topic: 'Scheduler.Pause',
      provider_id: 'local:Scheduler',
      service_instance_id: 'scheduler-local',
      selector: { peer_id: 'local-peer', module: 'Scheduler' },
      policy: { ...basePolicy, required_permissions: ['Scheduler.manage'], operation_class: 'admin', safety_class: 'admin', approval_required: true },
      summary: 'Pause scheduler jobs through AdminAction.'
    }),
    action({
      action_id: 'scheduler-resume-remote',
      module: 'Scheduler',
      method: 'Resume',
      topic: 'Scheduler.Resume',
      provider_id: 'mesh:studio-gpu:Scheduler',
      peer_id: 'peer-studio-gpu',
      provider_kind: 'mesh',
      service_instance_id: 'scheduler-studio-gpu',
      selector: { peer_id: 'peer-studio-gpu', module: 'Scheduler', provider_id: 'mesh:studio-gpu:Scheduler' },
      policy: { ...basePolicy, required_permissions: ['Scheduler.manage'], trust_tier: 'paired', mesh_visible: true, operation_class: 'admin', safety_class: 'admin', approval_required: true },
      summary: 'Resume delegated remote scheduler jobs with visible peer/provider context.'
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
    }),
    action({
      action_id: 'auth-list-principals',
      module: 'Auth',
      method: 'ListPrincipals',
      topic: 'Auth.ListPrincipals',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'admin' },
      summary: 'List RBAC principals through Auth.'
    }),
    action({
      action_id: 'auth-create-principal',
      module: 'Auth',
      method: 'CreatePrincipal',
      topic: 'Auth.CreatePrincipal',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'admin', approval_required: true },
      summary: 'Create principal through AdminAction.'
    }),
    action({
      action_id: 'auth-update-principal',
      module: 'Auth',
      method: 'UpdatePrincipal',
      topic: 'Auth.UpdatePrincipal',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'admin', approval_required: true },
      summary: 'Update principal through AdminAction.'
    }),
    action({
      action_id: 'auth-delete-principal',
      module: 'Auth',
      method: 'DeletePrincipal',
      topic: 'Auth.DeletePrincipal',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Delete principal through AdminAction.'
    }),
    action({
      action_id: 'auth-set-permissions',
      module: 'Auth',
      method: 'SetPermissions',
      topic: 'Auth.SetPermissions',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Replace principal permissions through AdminAction.'
    }),
    action({
      action_id: 'auth-patch-permissions',
      module: 'Auth',
      method: 'PatchPermissions',
      topic: 'Auth.PatchPermissions',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'admin', approval_required: true },
      summary: 'Patch principal permissions through AdminAction.'
    }),
    action({
      action_id: 'auth-list-tokens',
      module: 'Auth',
      method: 'ListTokens',
      topic: 'Auth.ListTokens',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'credential' },
      summary: 'List token/session evidence through Auth.'
    }),
    action({
      action_id: 'auth-revoke-token',
      module: 'Auth',
      method: 'RevokeToken',
      topic: 'Auth.RevokeToken',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'credential', approval_required: true },
      summary: 'Revoke token through AdminAction.'
    }),
    action({
      action_id: 'auth-list-devices',
      module: 'Auth',
      method: 'ListDevices',
      topic: 'Auth.ListDevices',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'credential' },
      summary: 'List trusted devices and session evidence through Auth.'
    }),
    action({
      action_id: 'auth-delete-device',
      module: 'Auth',
      method: 'DeleteDevice',
      topic: 'Auth.DeleteDevice',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin-critical', safety_class: 'credential', approval_required: true },
      summary: 'Delete device through AdminAction.'
    }),
    action({
      action_id: 'auth-audit-log',
      module: 'Auth',
      method: 'AuditLog',
      topic: 'Auth.AuditLog',
      provider_id: 'local:Auth',
      service_instance_id: 'auth-local',
      selector: { peer_id: 'local-peer', module: 'Auth' },
      policy: { ...basePolicy, required_permissions: ['Auth.manage'], operation_class: 'admin', safety_class: 'read-only' },
      summary: 'Read RBAC audit events from Auth.'
    })
  ],
  resources: [],
  provider_index: {
    Gateway: ['local:Gateway'],
    TTS: ['local:TTS', 'remote:kitchen:TTS'],
    Tooling: ['local:TTS', 'remote:kitchen:TTS'],
    Orchestrator: [
      'local:Orchestrator:llama-cpp',
      'mesh:studio-gpu:Orchestrator',
      'cloud:openai:Orchestrator',
      'native:mobile-local-light'
    ],
    Auth: ['local:Auth'],
    Backup: ['local:Backup'],
    Scheduler: ['local:Scheduler', 'mesh:studio-gpu:Scheduler']
  },
  action_index: {
    'Gateway.GetMeshStatus': ['gateway-mesh-status-local'],
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
    'Orchestrator.ImportModel': ['model-runtime-import-admin'],
    'Auth.ListPrincipals': ['auth-list-principals'],
    'Auth.CreatePrincipal': ['auth-create-principal'],
    'Auth.UpdatePrincipal': ['auth-update-principal'],
    'Auth.DeletePrincipal': ['auth-delete-principal'],
    'Auth.SetPermissions': ['auth-set-permissions'],
    'Auth.PatchPermissions': ['auth-patch-permissions'],
    'Auth.ListTokens': ['auth-list-tokens'],
    'Auth.RevokeToken': ['auth-revoke-token'],
    'Auth.ListDevices': ['auth-list-devices'],
    'Auth.DeleteDevice': ['auth-delete-device'],
    'Auth.AuditLog': ['auth-audit-log'],
    'Auth.MeshListPeers': ['auth-mesh-list-peers-local'],
    'Auth.MeshApprovePeer': ['auth-mesh-approve-peer-local'],
    'Auth.MeshDenyPeer': ['auth-mesh-deny-peer-local'],
    'Auth.MeshUpdatePeerPermissions': ['auth-mesh-update-peer-permissions-local'],
    'Auth.MeshRemovePeer': ['auth-mesh-remove-peer-local'],
    'Backup.List': ['backup-list-local'],
    'Scheduler.ListJobs': ['scheduler-list-local'],
    'Scheduler.Schedule': ['scheduler-schedule-local'],
    'Scheduler.Cancel': ['scheduler-cancel-local'],
    'Scheduler.Pause': ['scheduler-pause-local'],
    'Scheduler.Resume': ['scheduler-resume-remote']
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
    },
    {
      module: 'Auth',
      version: '0.1.0',
      summary: 'Authentication, authorization, pairing, and principal management',
      capabilities: ['login', 'pairing', 'principals', 'permissions', 'tokens', 'devices', 'audit', 'mesh'],
      method_count: 7,
      last_seen: '2026-06-19T00:00:00Z',
      status: 'healthy',
      instance_id: 'auth-local'
    },
    {
      module: 'Scheduler',
      version: '0.1.0',
      summary: 'Scheduler jobs and delegated automation management',
      capabilities: ['jobs', 'delegation', 'automation'],
      method_count: 5,
      last_seen: '2026-06-19T00:00:00Z',
      status: 'healthy',
      instance_id: 'scheduler-local'
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

export const meshStatusFixture: MeshStatusResponse = {
  local: {
    mesh_enabled: true,
    mesh_started: true,
    webrtc_started: true,
    peer_id: 'local-peer',
    node_name: 'aurora-prod-01',
    peer_selection: 'latency',
    version_policy: 'compatible',
    shared_modules: ['Gateway', 'Auth', 'TTS'],
    routed_modules: ['TTS', 'Tooling', 'Scheduler']
  },
  peers: [
    {
      peer_id: 'peer-kitchen',
      node_name: 'Kitchen node',
      status: 'authenticated',
      latency_ms: 28,
      last_ping_age_s: 4,
      last_manifest_age_s: 18,
      active_calls: 0,
      services: [
        {
          module: 'TTS',
          version: '0.1.0',
          capabilities: ['synthesize'],
          method_names: ['Synthesize'],
          max_concurrent: 2,
          active_calls: 0,
          available_capacity: 2,
          digest: 'tts-kitchen-digest'
        }
      ],
      compatibility: {
        local_compatible: ['TTS'],
        local_incompatible: [],
        local_unused: ['DB'],
        remote_compatible: ['Gateway'],
        remote_incompatible: [],
        remote_unused: []
      }
    },
    {
      peer_id: 'peer-studio-gpu',
      node_name: 'Studio GPU',
      status: 'negotiated',
      latency_ms: 34,
      last_ping_age_s: 2,
      last_manifest_age_s: 8,
      active_calls: 1,
      services: [
        {
          module: 'Orchestrator',
          version: '0.1.0',
          capabilities: ['models'],
          method_names: ['GetModelCatalog'],
          max_concurrent: 2,
          active_calls: 1,
          available_capacity: 1,
          digest: 'orchestrator-studio-digest'
        },
        {
          module: 'Scheduler',
          version: '0.1.0',
          capabilities: ['delegation'],
          method_names: ['ListJobs', 'Schedule'],
          max_concurrent: 2,
          active_calls: 0,
          available_capacity: 2,
          digest: 'scheduler-studio-digest'
        }
      ],
      compatibility: {
        local_compatible: ['Orchestrator', 'Scheduler'],
        local_incompatible: [],
        local_unused: [],
        remote_compatible: ['Gateway', 'Auth'],
        remote_incompatible: [],
        remote_unused: []
      }
    },
    {
      peer_id: 'peer-den',
      node_name: 'Den node',
      status: 'stale',
      latency_ms: null,
      last_ping_age_s: 900,
      last_manifest_age_s: 900,
      active_calls: 0,
      services: [],
      compatibility: {
        local_compatible: [],
        local_incompatible: ['Tooling'],
        local_unused: [],
        remote_compatible: [],
        remote_incompatible: [],
        remote_unused: []
      }
    }
  ],
  routes: [
    {
      module: 'TTS',
      configured: true,
      share: true,
      prefer: 'remote',
      fallback: 'local',
      min_version: '0.1.0',
      required_capabilities: ['synthesize'],
      decision_target: 'remote',
      decision_peer_id: 'peer-kitchen',
      decision_version: '0.1.0',
      decision_latency_ms: 28,
      reason: 'remote provider eligible',
      providers: [
        {
          peer_id: 'peer-kitchen',
          node_name: 'Kitchen node',
          status: 'authenticated',
          version: '0.1.0',
          latency_ms: 28,
          active_calls: 0,
          max_concurrent: 2,
          eligible: true,
          reason_code: 'eligible',
          reason: 'compatible TTS provider'
        },
        {
          peer_id: 'peer-den',
          node_name: 'Den node',
          status: 'stale',
          version: '',
          latency_ms: null,
          active_calls: 0,
          max_concurrent: 0,
          eligible: false,
          reason_code: 'stale_provider',
          reason: 'manifest is stale'
        }
      ]
    },
    {
      module: 'Scheduler',
      configured: true,
      share: false,
      prefer: 'local',
      fallback: 'none',
      min_version: null,
      required_capabilities: ['delegation'],
      decision_target: 'local',
      decision_peer_id: null,
      decision_version: '',
      decision_latency_ms: null,
      reason: 'local provider selected by policy',
      providers: [
        {
          peer_id: 'peer-studio-gpu',
          node_name: 'Studio GPU',
          status: 'negotiated',
          version: '0.1.0',
          latency_ms: 34,
          active_calls: 0,
          max_concurrent: 2,
          eligible: true,
          reason_code: 'eligible',
          reason: 'remote scheduler candidate available'
        }
      ]
    }
  ],
  compatibility_failures: [
    {
      peer_id: 'peer-den',
      module: 'Tooling',
      direction: 'local',
      reason: 'remote manifest stale'
    }
  ],
  secrets_redacted: true
}

export const meshPeerListFixture: MeshPeerListResponse = {
  peers: [
    {
      id: 'mesh-peer-kitchen',
      peer_id: 'peer-kitchen',
      node_name: 'Kitchen node',
      room_name: 'home',
      ip: '192.0.2.10',
      port: null,
      outbound_status: 'pending',
      outbound_permissions: [],
      outbound_approved_at: null,
      outbound_approved_by: null,
      inbound_status: 'pending',
      inbound_permissions: ['Gateway.use'],
      inbound_approved_at: null,
      connection_status: 'connected',
      first_seen_at: '2026-06-24T12:00:00Z',
      last_seen_at: '2026-06-25T15:00:00Z',
      last_status_change_at: '2026-06-25T15:00:00Z'
    },
    {
      id: 'mesh-peer-studio-gpu',
      peer_id: 'peer-studio-gpu',
      node_name: 'Studio GPU',
      room_name: 'home',
      ip: '192.0.2.20',
      port: null,
      outbound_status: 'approved',
      outbound_permissions: ['TTS.use', 'Orchestrator.use'],
      outbound_approved_at: '2026-06-20T14:00:00Z',
      outbound_approved_by: 'admin',
      inbound_status: 'approved',
      inbound_permissions: ['Gateway.use'],
      inbound_approved_at: '2026-06-20T14:05:00Z',
      connection_status: 'connected',
      first_seen_at: '2026-06-20T13:50:00Z',
      last_seen_at: '2026-06-25T15:01:00Z',
      last_status_change_at: '2026-06-20T14:05:00Z'
    },
    {
      id: 'mesh-peer-den',
      peer_id: 'peer-den',
      node_name: 'Den node',
      room_name: 'home',
      ip: null,
      port: null,
      outbound_status: 'denied',
      outbound_permissions: [],
      outbound_approved_at: null,
      outbound_approved_by: null,
      inbound_status: 'denied',
      inbound_permissions: [],
      inbound_approved_at: null,
      connection_status: 'disconnected',
      first_seen_at: '2026-06-18T10:00:00Z',
      last_seen_at: '2026-06-18T10:10:00Z',
      last_status_change_at: '2026-06-18T10:15:00Z'
    },
    {
      id: 'mesh-peer-removed',
      peer_id: 'peer-removed',
      node_name: 'Removed lab node',
      room_name: 'lab',
      ip: null,
      port: null,
      outbound_status: 'removed',
      outbound_permissions: [],
      outbound_approved_at: null,
      outbound_approved_by: null,
      inbound_status: 'unknown',
      inbound_permissions: [],
      inbound_approved_at: null,
      connection_status: 'disconnected',
      first_seen_at: '2026-06-10T09:00:00Z',
      last_seen_at: '2026-06-10T09:30:00Z',
      last_status_change_at: '2026-06-10T09:30:00Z'
    }
  ],
  total: 4
}

export const pendingPairingsFixture: ListPendingPairingsResponse = {
  pairings: [
    {
      request_id: 'mesh-pairing-peer-kitchen',
      code: 'mesh-pairing-secret',
      device_name: 'Kitchen tablet',
      client_ip: '192.168.10.42',
      status: 'pending',
      expires_at: '2026-06-25T16:30:00Z',
      created_at: '2026-06-25T16:00:00Z',
      remote_peer_id: 'peer-kitchen',
      remote_node_name: 'Kitchen node',
      approved_by: null,
      denied_by: null,
      denied_reason: '',
      granted_permissions: ['Gateway.use'],
      granted_is_admin: false
    }
  ],
  total: 1,
  expired_count: 0,
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

export const principalListFixture: PrincipalListResponse = {
  principals: [
    {
      id: 'principal-owner',
      username: 'owner',
      permissions: ['*'],
      is_admin: true,
      created_at: '2026-06-19T00:00:00Z'
    },
    {
      id: 'principal-ops',
      username: 'ops.admin',
      permissions: ['Auth.manage', 'Gateway.manage', 'Supervisor.manage'],
      is_admin: true,
      created_at: '2026-06-19T00:10:00Z'
    },
    {
      id: 'principal-assistant',
      username: 'assistant.user',
      permissions: ['Orchestrator.use', 'Tooling.use', 'DB.use'],
      is_admin: false,
      created_at: '2026-06-19T00:20:00Z'
    },
    {
      id: 'principal-device',
      username: 'studio-mac',
      permissions: ['Gateway.use', 'TTS.use'],
      is_admin: false,
      created_at: '2026-06-19T00:30:00Z'
    }
  ]
}

export const tokenListFixture: TokenListResponse = {
  tokens: [
    {
      id: 'token-studio-mac-active',
      prefix: 'aur_stu',
      device_id: 'device-studio-mac',
      user_id: 'principal-owner',
      scopes: ['*'],
      created_at: '2026-06-19T00:35:00Z',
      expires_at: '2026-07-19T00:35:00Z'
    },
    {
      id: 'token-ops-tablet-active',
      prefix: 'aur_ops',
      device_id: 'device-ops-tablet',
      user_id: 'principal-ops',
      scopes: ['Auth.manage', 'Gateway.manage'],
      created_at: '2026-06-19T00:45:00Z',
      expires_at: '2026-07-19T00:45:00Z'
    },
    {
      id: 'token-assistant-phone-expired',
      prefix: 'aur_ast',
      device_id: 'device-assistant-phone',
      user_id: 'principal-assistant',
      scopes: ['Orchestrator.use', 'Tooling.use'],
      created_at: '2026-05-19T00:55:00Z',
      expires_at: '2026-06-20T00:55:00Z'
    }
  ]
}

export const deviceListFixture: DeviceListResponse = {
  devices: [
    {
      id: 'device-studio-mac',
      user_id: 'principal-owner',
      name: 'Studio Mac',
      is_trusted: true,
      created_at: '2026-06-19T00:30:00Z',
      last_seen: '2026-06-25T02:30:00Z'
    },
    {
      id: 'device-ops-tablet',
      user_id: 'principal-ops',
      name: 'Ops tablet',
      is_trusted: true,
      created_at: '2026-06-19T00:40:00Z',
      last_seen: '2026-06-24T20:15:00Z'
    },
    {
      id: 'device-assistant-phone',
      user_id: 'principal-assistant',
      name: 'Assistant phone',
      is_trusted: false,
      created_at: '2026-06-19T00:50:00Z',
      last_seen: null
    }
  ]
}

export const auditLogFixture: AuditLogResponse = {
  total: 7,
  events: [
    {
      id: 'audit-rbac-1',
      event: 'admin_action.confirmed',
      principal_id: 'principal-owner',
      action: 'Auth.PatchPermissions',
      correlation_id: 'corr-rbac-001',
      details: '{"target":"principal-assistant","grant":["Tooling.use"],"approval_mode":"admin_action","audit_receipt":"receipt-rbac-001","payload_hash":"sha256:rbac001","support_bundle_correlation_ids":["corr-rbac-001"],"secrets_redacted":true}',
      created_at: '2026-06-19T01:00:00Z'
    },
    {
      id: 'audit-rbac-2',
      event: 'auth.permissions.updated',
      principal_id: 'principal-ops',
      action: 'Auth.SetPermissions',
      correlation_id: 'corr-rbac-002',
      details: '{"target":"principal-device","revoke":["DB.use"],"secrets_redacted":true}',
      created_at: '2026-06-19T01:05:00Z'
    },
    {
      id: 'audit-rbac-3',
      event: 'admin_action.denied',
      principal_id: 'principal-assistant',
      action: 'Auth.DeletePrincipal',
      correlation_id: 'corr-rbac-003',
      details: '{"reason":"permission_denied","secrets_redacted":true}',
      created_at: '2026-06-19T01:10:00Z'
    },
    {
      id: 'audit-tool-approval-1',
      event: 'tooling.approval.requested',
      principal_id: 'principal-owner',
      action: 'Tooling.RequestApproval',
      correlation_id: 'corr-tool-approval-001',
      peer_id: 'peer-studio',
      provider_id: 'provider-tooling-studio',
      tool_id: 'tool:studio:files.write',
      route: 'mesh://peer-studio/Tooling.ExecuteTool',
      details: '{"approval_mode":"single","global_tool_id":"tool:studio:files.write","provider_peer_id":"peer-studio","route_path":"mesh://peer-studio/Tooling.ExecuteTool","args_hash":"sha256:toolargs001","token":"redacted-by-backend","support_bundle_correlation_ids":["corr-tool-approval-001"],"secrets_redacted":true}',
      created_at: '2026-06-19T01:15:00Z'
    },
    {
      id: 'audit-tool-denied-1',
      event: 'tooling.approval.denied',
      principal_id: 'principal-ops',
      action: 'Tooling.ConfirmExecution',
      correlation_id: 'corr-tool-denied-001',
      peer_id: 'peer-studio',
      provider_id: 'provider-tooling-studio',
      tool_id: 'tool:studio:shell.exec',
      route: 'mesh://peer-studio/Tooling.ExecuteTool',
      details: '{"approval_mode":"single","denial_reason":"policy_denied","global_tool_id":"tool:studio:shell.exec","provider_peer_id":"peer-studio","route_path":"mesh://peer-studio/Tooling.ExecuteTool","payload_hash":"sha256:denied001","secrets_redacted":true}',
      created_at: '2026-06-19T01:20:00Z'
    },
    {
      id: 'audit-data-audio-scheduler-1',
      event: 'mesh.audit.executed',
      principal_id: 'principal-owner',
      action: 'Scheduler.DelegatedRun',
      correlation_id: 'corr-scheduler-001',
      peer_id: 'peer-kitchen',
      provider_id: 'provider-scheduler-kitchen',
      route: 'mesh://peer-kitchen/Scheduler.RunJob',
      details: '{"approval_mode":"approve_all","data_namespace":"recipes","audio_session_id":"audio-session-77","scheduler_job_id":"job-nightly-sync","route_path":"mesh://peer-kitchen/Scheduler.RunJob","audit_receipt":"receipt-scheduler-001","payload_hash":"sha256:scheduler001","support_bundle_correlation_ids":["corr-scheduler-001","bundle-corr-001"],"secrets_redacted":true}',
      created_at: '2026-06-19T01:25:00Z'
    },
    {
      id: 'audit-replay-1',
      event: 'tooling.approval_replay_rejected',
      principal_id: 'principal-owner',
      action: 'Tooling.ExecuteTool',
      correlation_id: 'corr-replay-001',
      peer_id: 'peer-studio',
      provider_id: 'provider-tooling-studio',
      tool_id: 'tool:studio:files.write',
      route: 'mesh://peer-studio/Tooling.ExecuteTool',
      details: '{"approval_mode":"single","denial_reason":"replay_rejected","payload_hash":"sha256:replay001","secrets_redacted":true}',
      created_at: '2026-06-19T01:30:00Z'
    }
  ]
}

export function principalFixture(id: string): PrincipalResponse | null {
  return principalListFixture.principals.find((principal) => principal.id === id) ?? null
}

export const backendInventoryFixture: BackendInventory = {
  generated_by: 'scripts/generate_backend_inventory.py',
  method_count: 31,
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
      module: 'Auth',
      name: 'MeshListPeers',
      summary: 'List persisted mesh peer trust state',
      bus_topic: 'Auth.MeshListPeers',
      routePath: '/api/Auth/MeshListPeers',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerListRequest',
      output_model: 'MeshPeerListResponse',
      input_schema: {
        title: 'MeshPeerListRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshPeerListResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:969'
    },
    {
      module: 'Auth',
      name: 'MeshGetPeer',
      summary: 'Get a single persisted mesh peer trust record',
      bus_topic: 'Auth.MeshGetPeer',
      routePath: '/api/Auth/MeshGetPeer',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerGetRequest',
      output_model: 'MeshPeerGetResponse',
      input_schema: {
        title: 'MeshPeerGetRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshPeerGetResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:983'
    },
    {
      module: 'Auth',
      name: 'MeshApprovePeer',
      summary: 'Approve a mesh peer',
      bus_topic: 'Auth.MeshApprovePeer',
      routePath: '/api/Auth/MeshApprovePeer',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerApproveRequest',
      output_model: 'MeshBoolResponse',
      input_schema: {
        title: 'MeshPeerApproveRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshBoolResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:988'
    },
    {
      module: 'Auth',
      name: 'MeshDenyPeer',
      summary: 'Deny/block a mesh peer',
      bus_topic: 'Auth.MeshDenyPeer',
      routePath: '/api/Auth/MeshDenyPeer',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerDenyRequest',
      output_model: 'MeshBoolResponse',
      input_schema: {
        title: 'MeshPeerDenyRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshBoolResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:998'
    },
    {
      module: 'Auth',
      name: 'MeshUpdatePeerPermissions',
      summary: 'Update outbound permissions granted to a mesh peer',
      bus_topic: 'Auth.MeshUpdatePeerPermissions',
      routePath: '/api/Auth/MeshUpdatePeerPermissions',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerUpdatePermissionsRequest',
      output_model: 'MeshBoolResponse',
      input_schema: {
        title: 'MeshPeerUpdatePermissionsRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshBoolResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:1008'
    },
    {
      module: 'Auth',
      name: 'MeshRemovePeer',
      summary: 'Remove a persisted mesh peer',
      bus_topic: 'Auth.MeshRemovePeer',
      routePath: '/api/Auth/MeshRemovePeer',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'MeshPeerRemoveRequest',
      output_model: 'MeshBoolResponse',
      input_schema: {
        title: 'MeshPeerRemoveRequest',
        type: 'object'
      },
      output_schema: {
        title: 'MeshBoolResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:1018'
    },
    {
      module: 'Auth',
      name: 'ListPrincipals',
      summary: 'List RBAC principals with roles, permissions, and effective access',
      bus_topic: 'Auth.ListPrincipals',
      routePath: '/api/Auth/ListPrincipals',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PrincipalListRequest',
      output_model: 'PrincipalListResponse',
      input_schema: {
        title: 'PrincipalListRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PrincipalListResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:472'
    },
    {
      module: 'Auth',
      name: 'CreatePrincipal',
      summary: 'Create an RBAC principal through the AdminAction approval workflow',
      bus_topic: 'Auth.CreatePrincipal',
      routePath: '/api/Auth/CreatePrincipal',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PrincipalCreateRequest',
      output_model: 'PrincipalResponse',
      input_schema: {
        title: 'PrincipalCreateRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PrincipalResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:496'
    },
    {
      module: 'Auth',
      name: 'UpdatePrincipal',
      summary: 'Update an RBAC principal through the AdminAction approval workflow',
      bus_topic: 'Auth.UpdatePrincipal',
      routePath: '/api/Auth/UpdatePrincipal',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PrincipalUpdateRequest',
      output_model: 'PrincipalResponse',
      input_schema: {
        title: 'PrincipalUpdateRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PrincipalResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:545'
    },
    {
      module: 'Auth',
      name: 'DeletePrincipal',
      summary: 'Delete an RBAC principal through the AdminAction approval workflow',
      bus_topic: 'Auth.DeletePrincipal',
      routePath: '/api/Auth/DeletePrincipal',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PrincipalDeleteRequest',
      output_model: 'PrincipalDeleteResponse',
      input_schema: {
        title: 'PrincipalDeleteRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PrincipalDeleteResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:575'
    },
    {
      module: 'Auth',
      name: 'SetPermissions',
      summary: 'Replace RBAC permissions through the AdminAction approval workflow',
      bus_topic: 'Auth.SetPermissions',
      routePath: '/api/Auth/SetPermissions',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PermissionSetRequest',
      output_model: 'PermissionSetResponse',
      input_schema: {
        title: 'PermissionSetRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PermissionSetResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:590'
    },
    {
      module: 'Auth',
      name: 'PatchPermissions',
      summary: 'Patch RBAC permissions through the AdminAction approval workflow',
      bus_topic: 'Auth.PatchPermissions',
      routePath: '/api/Auth/PatchPermissions',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'PermissionPatchRequest',
      output_model: 'PermissionPatchResponse',
      input_schema: {
        title: 'PermissionPatchRequest',
        type: 'object'
      },
      output_schema: {
        title: 'PermissionPatchResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:603'
    },
    {
      module: 'Auth',
      name: 'ListTokens',
      summary: 'List tokens, optionally filtered by principal or device',
      bus_topic: 'Auth.ListTokens',
      routePath: '/api/Auth/ListTokens',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'TokenListRequest',
      output_model: 'TokenListResponse',
      input_schema: {
        title: 'TokenListRequest',
        type: 'object'
      },
      output_schema: {
        title: 'TokenListResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:636'
    },
    {
      module: 'Auth',
      name: 'RevokeToken',
      summary: 'Revoke a token',
      bus_topic: 'Auth.RevokeToken',
      routePath: '/api/Auth/RevokeToken',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'TokenRevokeRequest',
      output_model: 'TokenRevokeResponse',
      input_schema: {
        title: 'TokenRevokeRequest',
        type: 'object'
      },
      output_schema: {
        title: 'TokenRevokeResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:713'
    },
    {
      module: 'Auth',
      name: 'ListDevices',
      summary: 'List devices, optionally filtered by principal',
      bus_topic: 'Auth.ListDevices',
      routePath: '/api/Auth/ListDevices',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'DeviceListRequest',
      output_model: 'DeviceListResponse',
      input_schema: {
        title: 'DeviceListRequest',
        type: 'object'
      },
      output_schema: {
        title: 'DeviceListResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:727'
    },
    {
      module: 'Auth',
      name: 'DeleteDevice',
      summary: 'Delete a device',
      bus_topic: 'Auth.DeleteDevice',
      routePath: '/api/Auth/DeleteDevice',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'DeviceDeleteRequest',
      output_model: 'DeviceDeleteResponse',
      input_schema: {
        title: 'DeviceDeleteRequest',
        type: 'object'
      },
      output_schema: {
        title: 'DeviceDeleteResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:751'
    },
    {
      module: 'Auth',
      name: 'AuditLog',
      summary: 'List RBAC audit events for principals and permission changes',
      bus_topic: 'Auth.AuditLog',
      routePath: '/api/Auth/AuditLog',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Auth.manage'],
      input_model: 'AuditLogRequest',
      output_model: 'AuditLogResponse',
      input_schema: {
        title: 'AuditLogRequest',
        type: 'object'
      },
      output_schema: {
        title: 'AuditLogResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/auth/service.py:800'
    },
    {
      module: 'Scheduler',
      name: 'ListJobs',
      summary: 'List namespace-scoped scheduler jobs with ownership and delegation policy evidence',
      bus_topic: 'Scheduler.ListJobs',
      routePath: '/api/Scheduler/ListJobs',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'use',
      required_perms: ['Scheduler.use'],
      input_model: 'SchedulerListJobsRequest',
      output_model: 'SchedulerListJobsResponse',
      input_schema: {
        title: 'SchedulerListJobsRequest',
        type: 'object'
      },
      output_schema: {
        title: 'SchedulerListJobsResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/scheduler/service.py:120'
    },
    {
      module: 'Scheduler',
      name: 'Schedule',
      summary: 'Schedule an automation job through AdminAction with explicit target and policy provenance',
      bus_topic: 'Scheduler.Schedule',
      routePath: '/api/Scheduler/Schedule',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Scheduler.manage'],
      input_model: 'SchedulerScheduleJobRequest',
      output_model: 'SchedulerActionResponse',
      input_schema: {
        title: 'SchedulerScheduleJobRequest',
        type: 'object'
      },
      output_schema: {
        title: 'SchedulerActionResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/scheduler/service.py:120'
    },
    {
      module: 'Scheduler',
      name: 'Cancel',
      summary: 'Cancel a scheduler job through AdminAction with namespace authorization',
      bus_topic: 'Scheduler.Cancel',
      routePath: '/api/Scheduler/Cancel',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Scheduler.manage'],
      input_model: 'SchedulerScopedJobRequest',
      output_model: 'SchedulerActionResponse',
      input_schema: {
        title: 'SchedulerScopedJobRequest',
        type: 'object'
      },
      output_schema: {
        title: 'SchedulerActionResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/scheduler/service.py:120'
    },
    {
      module: 'Scheduler',
      name: 'Pause',
      summary: 'Pause a scheduler job through AdminAction with namespace authorization',
      bus_topic: 'Scheduler.Pause',
      routePath: '/api/Scheduler/Pause',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Scheduler.manage'],
      input_model: 'SchedulerScopedJobRequest',
      output_model: 'SchedulerActionResponse',
      input_schema: {
        title: 'SchedulerScopedJobRequest',
        type: 'object'
      },
      output_schema: {
        title: 'SchedulerActionResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/scheduler/service.py:120'
    },
    {
      module: 'Scheduler',
      name: 'Resume',
      summary: 'Resume a scheduler job through AdminAction with namespace authorization',
      bus_topic: 'Scheduler.Resume',
      routePath: '/api/Scheduler/Resume',
      route_kind: 'dynamic',
      exposure: 'both',
      method_type: 'manage',
      required_perms: ['Scheduler.manage'],
      input_model: 'SchedulerScopedJobRequest',
      output_model: 'SchedulerActionResponse',
      input_schema: {
        title: 'SchedulerScopedJobRequest',
        type: 'object'
      },
      output_schema: {
        title: 'SchedulerActionResponse',
        type: 'object'
      },
      source: 'live_registry',
      source_file: 'app/services/scheduler/service.py:120'
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
      name: 'GetMeshStatus',
      summary: 'Get read-only mesh peer, service, route, and compatibility diagnostics',
      bus_topic: 'Gateway.GetMeshStatus',
      routePath: '/api/Gateway/GetMeshStatus',
      route_kind: 'dynamic',
      exposure: 'external',
      method_type: 'use',
      required_perms: ['Gateway.use'],
      input_model: 'EmptyInput',
      output_model: 'MeshStatusResponse',
      input_schema: null,
      output_schema: {
        title: 'MeshStatusResponse',
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
    'aurora.command': true,
    'aurora.request': true,
    'aurora.subscribe': true,
    'aurora.nativeCapabilityManifest': true,
    'aurora.sidecarStatus': true,
    'aurora.sidecarSession': true,
    'aurora.sidecarStart': true,
    'aurora.sidecarStop': true,
    'aurora.shutdown': true,
    'aurora.logTail': true,
    'aurora.updater': true,
    'aurora.secureStorage': true,
    'aurora.iosKeychain': false,
    'aurora.iosBiometricUnlock': false,
    'aurora.nativePermissionStatus': true,
    'aurora.trayStatus': true,
    'aurora.notificationsStatus': true,
    'aurora.notificationsSend': false,
    'aurora.dialogStatus': true,
    'aurora.dialogOpen': false,
    'aurora.localFileRead': false,
    'aurora.localFileWrite': false,
    'aurora.secureFileHandle': false,
    'aurora.audioBridgeStatus': true,
    'aurora.audioCapture': false,
    'aurora.audioPlayback': false,
    'aurora.shell': false,
    'aurora.processSpawn': false
  },
  capabilities: {
    'desktop.thinGateway': true,
    'desktop.localSidecarHealth': true,
    'desktop.signedUpdater': true,
    'desktop.bundledSidecarPolicy': true,
    'desktop.logTail': false,
    'desktop.localSidecarSupervision': true,
    'desktop.tray': true,
    'native.secureCredentialStorage': true,
    'ios.keychain.secureCredentialStorage': false,
    'ios.biometric.adminUnlock': false,
    'ios.appIntents': false,
    'ios.shortcuts': false,
    'ios.shareExtension': false,
    'ios.widgets': false,
    'ios.deepLinks': false,
    'ios.siriReplacement': false,
    'native.permissionsManifest': true,
    'native.notifications': false,
    'native.dialogs': false,
    'native.secureFileHandles': false,
    'native.filesystem': false,
    'native.audio': false,
    'native.audioCapture': false,
    'native.audioPlayback': false
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

const memoryProvenanceFixture: DBRAGProvenance = {
  source_peer_id: 'local-peer',
  owner_peer_id: 'local-peer',
  namespace: 'main.memories',
  record_id: 'memory-001',
  origin_principal_id: 'user-local',
  created_at: '2026-06-19T00:00:00Z',
  updated_at: '2026-06-19T00:05:00Z',
  schema_version: 'rag-provenance.v1',
  policy_decision_id: 'policy-local-memory',
  correlation_id: 'corr-memory-local',
  imported_at: null,
  import_operation_id: null,
  tombstone: false,
  deleted_at: null,
  deleted_by: null,
  delete_reason: null
}

const remoteMemoryProvenanceFixture: DBRAGProvenance = {
  ...memoryProvenanceFixture,
  source_peer_id: 'peer-studio-gpu',
  owner_peer_id: 'peer-studio-gpu',
  namespace: 'peer-studio-gpu.memories',
  record_id: 'remote-memory-002',
  origin_principal_id: 'remote-user',
  policy_decision_id: 'policy-remote-memory',
  correlation_id: 'corr-memory-remote'
}

export const memoryMessagesFixture: DBGetMessagesResponse = {
  total: 2,
  has_more: false,
  messages: [
    {
      id: 'conversation-001',
      role: 'user',
      content: 'Summarize recent mesh pairing failures.',
      message_type: 'TEXT',
      created_at: '2026-06-19T00:00:00Z',
      privacy_class: 'personal',
      source: 'DB.GetMessages'
    },
    {
      id: 'conversation-002',
      role: 'assistant',
      content: 'Mesh pairing failures were denied by explicit selector policy.',
      message_type: 'TEXT',
      created_at: '2026-06-19T00:01:00Z',
      privacy_class: 'personal',
      source: 'DB.GetMessages'
    }
  ]
}

export const memoryNamespacesFixture: DBRAGListNamespacesResponse = {
  namespaces: [
    {
      namespace: 'main.memories',
      source_peer_id: 'local-peer',
      owner_peer_id: 'local-peer',
      provider_peer_id: 'local-peer',
      availability: 'available',
      record_count: 42,
      embedding_model: 'mock-local-embeddings',
      schema_version: 'rag-provenance.v1',
      freshness: 'fresh',
      policy: {
        sharing_mode: 'remote_query',
        privacy_class: 'personal',
        allowed_operations: ['search', 'export', 'delete'],
        explicit_selector_required: false,
        export_supported: true,
        import_supported: false,
        delete_supported: true,
        requires_admin_approval: true,
        denial_reason: null
      }
    },
    {
      namespace: 'main.rag',
      source_peer_id: 'local-peer',
      owner_peer_id: 'local-peer',
      provider_peer_id: 'local-peer',
      availability: 'available',
      record_count: 12,
      embedding_model: 'mock-local-embeddings',
      schema_version: 'rag-provenance.v1',
      freshness: 'fresh',
      policy: {
        sharing_mode: 'export_import',
        privacy_class: 'sensitive',
        allowed_operations: ['search', 'export', 'import'],
        explicit_selector_required: false,
        export_supported: true,
        import_supported: true,
        delete_supported: false,
        requires_admin_approval: true,
        denial_reason: null
      }
    },
    {
      namespace: 'peer-studio-gpu.memories',
      source_peer_id: 'peer-studio-gpu',
      owner_peer_id: 'peer-studio-gpu',
      provider_peer_id: 'peer-studio-gpu',
      availability: 'available',
      record_count: 7,
      embedding_model: 'mock-remote-embeddings',
      schema_version: 'rag-provenance.v1',
      freshness: 'last probe 4s ago',
      policy: {
        sharing_mode: 'remote_query',
        privacy_class: 'personal',
        allowed_operations: ['search'],
        explicit_selector_required: true,
        export_supported: false,
        import_supported: false,
        delete_supported: false,
        requires_admin_approval: false,
        denial_reason: null
      }
    },
    {
      namespace: 'peer-cabin-node.archive',
      source_peer_id: 'peer-cabin-node',
      owner_peer_id: 'peer-cabin-node',
      provider_peer_id: 'peer-cabin-node',
      availability: 'stale',
      record_count: null,
      embedding_model: 'legacy-embedding-v0',
      schema_version: 'rag-provenance.v1',
      freshness: 'last probe 900s ago',
      policy: {
        sharing_mode: 'remote_query',
        privacy_class: 'sensitive',
        allowed_operations: [],
        explicit_selector_required: true,
        export_supported: false,
        import_supported: false,
        delete_supported: false,
        requires_admin_approval: false,
        denial_reason: 'stale peer'
      }
    },
    {
      namespace: 'peer-denied.secret',
      source_peer_id: 'peer-denied',
      owner_peer_id: 'peer-denied',
      provider_peer_id: 'peer-denied',
      availability: 'denied',
      record_count: null,
      embedding_model: null,
      schema_version: 'rag-provenance.v1',
      freshness: null,
      policy: {
        sharing_mode: 'never',
        privacy_class: 'secret',
        allowed_operations: [],
        explicit_selector_required: true,
        export_supported: false,
        import_supported: false,
        delete_supported: false,
        requires_admin_approval: false,
        denial_reason: 'remote namespace denied by policy'
      }
    }
  ]
}

export function memorySearchFixture(request: DBRAGSearchRemoteRequest): DBRAGSearchRemoteResponse {
  if (request.namespace.includes('denied')) {
    return {
      decision: 'denied',
      items: [],
      denial_reason: 'remote namespace denied by policy',
      policy_decision_id: 'policy-denied-memory',
      correlation_id: request.correlation_id ?? 'corr-memory-denied'
    }
  }
  if (request.namespace.includes('cabin')) {
    return {
      decision: 'unavailable',
      items: [],
      denial_reason: 'stale peer',
      policy_decision_id: 'policy-stale-memory',
      correlation_id: request.correlation_id ?? 'corr-memory-stale'
    }
  }
  const provenance = request.namespace.includes('peer-studio')
    ? remoteMemoryProvenanceFixture
    : memoryProvenanceFixture
  return {
    decision: 'allowed',
    denial_reason: null,
    policy_decision_id: provenance.policy_decision_id,
    correlation_id: request.correlation_id ?? provenance.correlation_id,
    items: [
      {
        key: provenance.record_id,
        namespace: request.namespace,
        value: request.query
          ? `Search hit for "${request.query}" from ${request.namespace}`
          : `Recent memory from ${request.namespace}`,
        search_score: 0.92,
        provenance: { ...provenance, namespace: request.namespace },
        redacted: request.namespace.includes('peer-studio'),
        redaction_reasons: request.namespace.includes('peer-studio') ? ['remote snippet redacted'] : []
      }
    ]
  }
}

const memoryExportRecordFixture: DBRAGExportRecord = {
  key: 'memory-001',
  value: 'Redacted export preview',
  provenance: memoryProvenanceFixture,
  redacted: true,
  redaction_reasons: ['mock fixture redacts export payloads']
}

export const memoryExportFixture: DBRAGExportNamespaceResponse = {
  decision: 'allowed',
  namespace: 'main.memories',
  source_peer_id: 'local-peer',
  owner_peer_id: 'local-peer',
  schema_version: 'rag-export.v1',
  records: [memoryExportRecordFixture],
  tombstone_count: 1,
  denial_reason: null,
  policy_decision_id: 'policy-local-memory',
  correlation_id: 'corr-memory-export'
}

export const memoryImportFixture: DBRAGImportNamespaceResponse = {
  decision: 'allowed',
  imported_count: 1,
  skipped_count: 0,
  target_namespace: 'imports.preview',
  import_operation_id: 'import-preview-001',
  denial_reason: null,
  policy_decision_id: 'policy-import-memory',
  correlation_id: 'corr-memory-import'
}

export const configGetFixture: ConfigGetResponse = {
  config: {
    services: {
      gateway: {
        api: {
          host: '127.0.0.1',
          port: 8000,
          token_secret: '[REDACTED]'
        }
      }
    }
  }
}

export const configValidateFixture: ConfigValidateResponse = {
  errors: []
}

export const configSchemaMetadataFixture: ConfigSchemaMetadataResponse = {
  fields: [
    {
      key_path: 'services.gateway.api.host',
      title: 'Gateway host',
      description: 'Host interface used by the Gateway API.',
      type: 'string',
      default: '127.0.0.1',
      current_value: '127.0.0.1',
      source_layer: 'config.json',
      secret: false,
      reload_required: true,
      restart_required: false,
      affected_services: ['gateway'],
      constraints: {},
      choices: null
    },
    {
      key_path: 'services.gateway.api.port',
      title: 'Gateway port',
      description: 'HTTP port exposed by the Gateway API.',
      type: 'integer',
      default: 8000,
      current_value: 8000,
      source_layer: 'config.json',
      secret: false,
      reload_required: true,
      restart_required: true,
      affected_services: ['gateway'],
      constraints: { minimum: 1, maximum: 65535 },
      choices: null
    },
    {
      key_path: 'services.gateway.api.token_secret',
      title: 'Token secret',
      description: 'Secret used for Gateway token signing.',
      type: 'string',
      default: null,
      current_value: '[REDACTED]',
      source_layer: 'env',
      secret: true,
      reload_required: true,
      restart_required: true,
      affected_services: ['gateway', 'auth'],
      constraints: {},
      choices: null
    }
  ],
  secrets_redacted: true
}

export const configDiffPreviewFixture: ConfigDiffPreviewResponse = {
  valid: true,
  diffs: [
    {
      key_path: 'services.gateway.api.port',
      old_value: 8000,
      new_value: 8080,
      changed: true,
      source_layer: 'config.json',
      secret: false,
      reload_required: true,
      restart_required: true,
      affected_services: ['gateway']
    }
  ],
  errors: [],
  secrets_redacted: true
}

export const configVersionHistoryFixture: ConfigVersionHistoryResponse = {
  versions: [
    {
      version_id: 'cfgv-gateway-port-001',
      timestamp: '2026-06-20T00:00:00Z',
      key_path: 'services.gateway.api.port',
      old_value: 7000,
      new_value: 8000,
      affected_sections: ['services', 'services.gateway', 'services.gateway.api'],
      secret: false
    },
    {
      version_id: 'cfgv-token-secret-001',
      timestamp: '2026-06-19T00:00:00Z',
      key_path: 'services.gateway.api.token_secret',
      old_value: null,
      new_value: '[REDACTED]',
      affected_sections: ['services', 'services.gateway', 'services.gateway.api'],
      secret: true
    }
  ],
  secrets_redacted: true
}

export const configReloadImpactFixture: ConfigReloadImpactResponse = {
  impacts: [
    {
      key_path: 'services.gateway.api.port',
      reload_required: true,
      restart_required: true,
      affected_services: ['gateway'],
      reason: 'Gateway bind address changes require a process restart.'
    }
  ]
}

export const configSetFixture: ConfigSetResponse = {
  success: true,
  previous_value: 8000
}

export const configRollbackFixture: ConfigRollbackResponse = {
  success: true,
  version_id: 'cfgv-gateway-port-001',
  key_path: 'services.gateway.api.port',
  rolled_back_to: 7000,
  affected_sections: ['services', 'services.gateway', 'services.gateway.api'],
  error: null,
  secrets_redacted: true
}

export const supportBundleFixture: GatewaySupportBundleResponse = {
  generated_at: '2026-06-19T00:05:00Z',
  correlation_id: 'corr-diagnostics-fixture',
  registry: gatewayRegistryFixture,
  services: gatewayServicesFixture.services,
  service_health: [
    {
      module: 'Gateway',
      status: 'healthy',
      checks: {
        registry: 'present',
        heartbeat: 'healthy',
        contracts: 'present'
      },
      timestamp: '2026-06-19T00:05:00Z'
    }
  ],
  mesh_status: {
    enabled: true,
    local_peer_id: 'local-peer',
    local_node_name: 'aurora-prod-01',
    routes: [
      {
        module: 'Tooling',
        selected_target: 'remote',
        selected_peer_id: 'stable-peer',
        selected_provider_id: 'mesh:studio-gpu:Tooling',
        fallback_behavior: 'blocked',
        secrets_redacted: true
      }
    ],
    secrets_redacted: true
  },
  webrtc_diagnostics: webrtcDiagnosticsFixture,
  route_diagnostics: [
    {
      module: 'Tooling',
      selected_target: 'remote',
      selected_peer_id: 'stable-peer',
      selected_provider_id: 'mesh:studio-gpu:Tooling',
      fallback_behavior: 'blocked',
      secrets_redacted: true
    }
  ],
  capability_catalog_summary: {
    providers: capabilityGraphCatalogFixture.providers.length,
    actions: capabilityGraphCatalogFixture.actions.length,
    resources: capabilityGraphCatalogFixture.resources.length,
    modules: ['Gateway', 'Tooling', 'TTS'],
    blocked_actions: capabilityGraphCatalogFixture.actions.filter((action) => action.bindability !== 'available').length
  },
  recent_events: [
    {
      id: 'evt-diagnostics-1',
      kind: 'Tooling.ExecuteTool',
      topic: 'Tooling.ExecuteTool',
      bus_topic: 'Tooling.ExecuteTool',
      correlation_id: 'corr-diagnostics-fixture',
      peer_id: 'local-peer',
      target_peer_id: 'stable-peer',
      status: 'denied',
      timestamp: '2026-06-19T00:04:50Z',
      payload_summary: {
        tool_id: 'tool:local:diagnostics.serviceHealth',
        args_redacted: true
      },
      secrets_redacted: true
    }
  ],
  recent_audit_events: [
    {
      event: 'diagnostics.support_bundle.exported',
      correlation_id: 'corr-diagnostics-fixture',
      audit_receipt: 'support_bundle:fixture',
      secrets_redacted: true
    }
  ],
  native_capabilities: [
    {
      name: 'native_capability_manifest',
      status: 'unavailable',
      source: 'tauri/native manifest',
      details: {
        reason: 'no native manifest is registered in this backend runtime',
        backend_coverage: 'deferred'
      },
      redacted: true
    }
  ],
  sidecar_logs: [
    {
      name: 'gateway_sidecar_logs',
      status: 'metadata_only',
      source: 'gateway runtime',
      details: {
        reason: 'raw logs are omitted; metadata only',
        omitted_payloads: ['host paths', 'tokens', 'raw audio', 'personal content']
      },
      redacted: true
    }
  ],
  config_shape: {
    api: {
      token_secret: '[REDACTED]',
      redis_url: '[REDACTED_URL]'
    },
    mesh: {
      node_name: 'aurora-prod-01'
    }
  },
  correlation_ids: ['corr-diagnostics-fixture'],
  audit_receipt: 'support_bundle:fixture',
  audit_error: null,
  redaction: {
    secrets_redacted: true,
    redacted_fields: ['token', 'secret', 'password', 'redis_url', 'path', 'args', 'audio', 'rag'],
    omitted_payloads: [
      'raw audio',
      'unredacted tool arguments',
      'RAG contents',
      'tokens and credentials'
    ]
  },
  secrets_redacted: true
}

export const backupListFixture: BackupListResponse = {
  total: 2,
  secrets_redacted: true,
  backups: [
    {
      backup_id: 'backup-20260625T120000Z-config-rag',
      created_at: '2026-06-25T12:00:00Z',
      status: 'ok',
      storage: {
        kind: 'local',
        uri: '.aurora/backups',
        encryption: 'none',
        key_ref: null,
        credential_ref: null,
        metadata: {}
      },
      components: [
        {
          component: 'config',
          status: 'included',
          item_count: 1,
          bytes: 4096,
          fingerprint: 'sha256:config-fixture',
          redacted: true,
          message: 'Config snapshot metadata captured with secret values redacted.'
        },
        {
          component: 'rag',
          status: 'included',
          item_count: 3,
          bytes: null,
          fingerprint: 'sha256:rag-fixture',
          redacted: true,
          message: 'RAG namespace metadata captured; record payloads remain redacted.'
        },
        {
          component: 'models',
          status: 'unsupported',
          item_count: null,
          bytes: null,
          fingerprint: null,
          redacted: true,
          message: 'Model binary backup awaits model runtime contracts.'
        }
      ],
      manifest_digest: 'sha256:backup-fixture-a',
      schema_version: 'aurora.backup.v1',
      encrypted: false,
      secrets_redacted: true,
      audit_receipt: 'audit-backup-create-fixture'
    },
    {
      backup_id: 'backup-20260624T090000Z-config-only',
      created_at: '2026-06-24T09:00:00Z',
      status: 'ok',
      storage: {
        kind: 'local',
        uri: '.aurora/backups',
        encryption: 'none',
        key_ref: null,
        credential_ref: null,
        metadata: {}
      },
      components: [
        {
          component: 'config',
          status: 'included',
          item_count: 1,
          bytes: 2048,
          fingerprint: 'sha256:config-only-fixture',
          redacted: true,
          message: 'Config snapshot metadata captured.'
        }
      ],
      manifest_digest: 'sha256:backup-fixture-b',
      schema_version: 'aurora.backup.v1',
      encrypted: false,
      secrets_redacted: true,
      audit_receipt: 'audit-backup-create-fixture-b'
    }
  ]
}

export const schedulerJobsFixture: SchedulerListJobsResponse = {
  total: 4,
  jobs: [
    {
      job_id: 'job-local-daily-digest',
      name: 'daily-digest',
      schedule: '0 8 * * *',
      action: 'Orchestrator.ExternalUserInput',
      enabled: true,
      next_run: '2026-06-26T08:00:00Z',
      last_run: '2026-06-25T08:00:00Z',
      status: 'active',
      namespace: 'local:automation',
      owner_peer_id: 'local-peer',
      owner_principal_id: 'principal-admin',
      target_peer_id: null,
      target_resource_namespace: null,
      delegated_permissions: ['Orchestrator.use'],
      policy_decision_id: 'policy-local-digest',
      delegated_approval_token_present: false,
      correlation_id: 'corr-scheduler-local-digest',
      blocked_reason: null,
      timezone: 'UTC',
      source: 'admin',
      failure_count: 0,
      privacy_class: 'personal',
      last_error: null,
      action_support: [
        { action: 'cancel', supported: true, status: 'supported', reason: null },
        { action: 'pause', supported: true, status: 'supported', reason: null },
        { action: 'resume', supported: false, status: 'not_applicable', reason: 'Job is already active.' }
      ]
    },
    {
      job_id: 'job-delegated-index',
      name: 'remote-knowledge-index',
      schedule: '*/30 * * * *',
      action: 'Tooling.ExecuteTool',
      enabled: true,
      next_run: '2026-06-25T16:30:00Z',
      last_run: '2026-06-25T16:00:00Z',
      status: 'delegated',
      namespace: 'local:delegated',
      owner_peer_id: 'local-peer',
      owner_principal_id: 'principal-admin',
      target_peer_id: 'peer-studio-gpu',
      target_resource_namespace: 'rag:studio',
      delegated_permissions: ['Tooling.use', 'DB.use'],
      policy_decision_id: 'policy-remote-index',
      delegated_approval_token_present: true,
      correlation_id: 'corr-scheduler-remote-index',
      blocked_reason: null,
      timezone: 'UTC',
      source: 'mesh-delegation',
      failure_count: 0,
      privacy_class: 'sensitive',
      last_error: null,
      action_support: [
        { action: 'cancel', supported: true, status: 'supported', reason: null },
        { action: 'pause', supported: true, status: 'supported', reason: null },
        { action: 'resume', supported: false, status: 'not_applicable', reason: 'Job is already active.' }
      ]
    },
    {
      job_id: 'job-remote-running',
      name: 'studio-render-cleanup',
      schedule: '15 * * * *',
      action: 'Tooling.ExecuteTool',
      enabled: true,
      next_run: '2026-06-25T17:15:00Z',
      last_run: '2026-06-25T16:15:00Z',
      status: 'remote-running',
      namespace: 'peer-studio-gpu:automation',
      owner_peer_id: 'peer-studio-gpu',
      owner_principal_id: 'remote-operator',
      target_peer_id: 'peer-studio-gpu',
      target_resource_namespace: 'tool:render-cleanup',
      delegated_permissions: ['Tooling.use'],
      policy_decision_id: 'policy-remote-owner',
      delegated_approval_token_present: true,
      correlation_id: 'corr-scheduler-remote-owner',
      blocked_reason: null,
      timezone: 'UTC',
      source: 'remote-peer',
      failure_count: 1,
      privacy_class: 'sensitive',
      last_error: 'Previous run used fallback capacity.',
      action_support: [
        { action: 'cancel', supported: false, status: 'denied', reason: 'Foreign owner namespace; local node may only observe.' },
        { action: 'pause', supported: false, status: 'denied', reason: 'Foreign owner namespace; local node may only observe.' },
        { action: 'resume', supported: false, status: 'denied', reason: 'Foreign owner namespace; local node may only observe.' }
      ]
    },
    {
      job_id: 'job-denied-foreign',
      name: 'cabin-lights',
      schedule: '0 22 * * *',
      action: 'Tooling.ExecuteTool',
      enabled: false,
      next_run: null,
      last_run: null,
      status: 'denied',
      namespace: 'peer-cabin-node:automation',
      owner_peer_id: 'peer-cabin-node',
      owner_principal_id: 'remote-cabin-admin',
      target_peer_id: 'peer-cabin-node',
      target_resource_namespace: 'hardware:lights',
      delegated_permissions: [],
      policy_decision_id: 'policy-denied-foreign',
      delegated_approval_token_present: false,
      correlation_id: 'corr-scheduler-denied-foreign',
      blocked_reason: 'Caller is outside the owner namespace.',
      timezone: 'UTC',
      source: 'remote-peer',
      failure_count: 0,
      privacy_class: 'admin-critical',
      last_error: null,
      action_support: [
        { action: 'cancel', supported: false, status: 'denied', reason: 'Owner namespace denies cancellation.' },
        { action: 'pause', supported: false, status: 'denied', reason: 'Owner namespace denies pause.' },
        { action: 'resume', supported: false, status: 'denied', reason: 'Owner namespace denies resume.' }
      ]
    }
  ]
}

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
  meshStatus: MeshStatusResponse
  meshPeers: MeshPeerListResponse
  pendingPairings: ListPendingPairingsResponse
  capabilityCatalog: CapabilityCatalogResponse
  routeExplain: RouteExplainResponse
  nativeManifest: NativeCapabilityManifest
  backups: BackupListResponse
  schedulerJobs: SchedulerListJobsResponse
  modelRuntimeCatalog: ModelRuntimeCatalogResponse
  toolCatalog: typeof toolCatalogFixture
  configGet: ConfigGetResponse
  configValidate: ConfigValidateResponse
  configSchemaMetadata: ConfigSchemaMetadataResponse
  configDiffPreview: ConfigDiffPreviewResponse
  configVersionHistory: ConfigVersionHistoryResponse
  configReloadImpact: ConfigReloadImpactResponse
  configSet: ConfigSetResponse
  configRollback: ConfigRollbackResponse
  memoryMessages: DBGetMessagesResponse
  memoryNamespaces: DBRAGListNamespacesResponse
  memoryExport: DBRAGExportNamespaceResponse
  memoryImport: DBRAGImportNamespaceResponse
  principals: PrincipalListResponse
  tokens: TokenListResponse
  devices: DeviceListResponse
  auditLog: AuditLogResponse
  supportBundle: GatewaySupportBundleResponse
  backendInventory: BackendInventory
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[]
}

export const defaultMockAuroraFixtures: MockAuroraFixtureSet = {
  registry: gatewayRegistryFixture,
  services: gatewayServicesFixture,
  deploymentTopology: deploymentTopologyFixture,
  webrtcDiagnostics: webrtcDiagnosticsFixture,
  meshStatus: meshStatusFixture,
  meshPeers: meshPeerListFixture,
  pendingPairings: pendingPairingsFixture,
  capabilityCatalog: capabilityGraphCatalogFixture,
  routeExplain: routeExplainFixture,
  nativeManifest: nativeCapabilityManifestFixture,
  backups: backupListFixture,
  schedulerJobs: schedulerJobsFixture,
  modelRuntimeCatalog: modelRuntimeCatalogFixture,
  toolCatalog: toolCatalogFixture,
  configGet: configGetFixture,
  configValidate: configValidateFixture,
  configSchemaMetadata: configSchemaMetadataFixture,
  configDiffPreview: configDiffPreviewFixture,
  configVersionHistory: configVersionHistoryFixture,
  configReloadImpact: configReloadImpactFixture,
  configSet: configSetFixture,
  configRollback: configRollbackFixture,
  memoryMessages: memoryMessagesFixture,
  memoryNamespaces: memoryNamespacesFixture,
  memoryExport: memoryExportFixture,
  memoryImport: memoryImportFixture,
  principals: principalListFixture,
  tokens: tokenListFixture,
  devices: deviceListFixture,
  auditLog: auditLogFixture,
  supportBundle: supportBundleFixture,
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
