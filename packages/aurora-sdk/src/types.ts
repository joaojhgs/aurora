export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export type ContractExposure = 'internal' | 'external' | 'both' | 'gateway_builtin' | string
export type ContractMethodType = 'use' | 'manage' | 'event' | 'gateway' | string

export interface MethodInfo {
  name: string
  summary: string
  bus_topic: string | null
  exposure: ContractExposure
  input_model: string | null
  output_model: string | null
  required_perms: string[]
  method_type: ContractMethodType
  input_schema?: JsonObject | null
  output_schema?: JsonObject | null
}

export interface ModuleRegistryInfo {
  module: string
  version: string
  summary: string
  capabilities: string[]
  methods: MethodInfo[]
}

export interface GetRegistryResponse {
  modules: ModuleRegistryInfo[]
  digest: string
  service_count: number
  method_count: number
}

export interface ServiceAnnouncement {
  module: string
  version: string
  summary: string
  capabilities: string[]
  methods: MethodInfo[]
  timestamp: string
  instance_id: string | null
}

export interface MethodDescriptor {
  module: string
  name: string
  busTopic: string
  routePath: string | null
  exposure: ContractExposure
  methodType: ContractMethodType
  summary: string
  inputModel: string | null
  outputModel: string | null
  requiredPermissions: string[]
  inputSchema: JsonObject | null
  outputSchema: JsonObject | null
  availableOverHttp: boolean
}

export type AvailabilityState =
  | 'available-local'
  | 'available-remote'
  | 'pending'
  | 'denied'
  | 'degraded'
  | 'stale'
  | 'privacy-blocked'
  | 'unsupported'

export type PrivacyClass =
  | 'public'
  | 'personal'
  | 'sensitive'
  | 'secret'
  | 'raw-audio'
  | 'credential'
  | 'admin-critical'

export interface CapabilityPolicyDecisionInfo {
  required_permissions: string[]
  trust_tier: string
  safety_class: string
  explicit_selector_required: boolean
  consent_required: boolean
  privacy_indicator_required: boolean
  bandwidth_check_required: boolean
  approval_required: boolean
  selector_required: boolean
  mesh_visible: boolean
  local_only: boolean
  allowed_peers: string[] | null
  operation_class: string | null
  resource_scope: string | null
  denial_reasons: string[]
}

export interface CapabilityFreshnessInfo {
  source: string
  manifest_time: string | null
  last_probe_age_s: number | null
  ttl_s: number | null
  stale: boolean
  registry_digest: string
}

export interface CapabilityProviderInfo {
  provider_id: string
  peer_id: string
  provider_kind: string
  node_name: string
  status: string
  service_instance_id: string
  module: string
  version: string
  latency_ms: number | null
  max_concurrent: number
  active_calls: number
  available_capacity: number | null
  eligible: boolean
  reason_code: string
  reason: string
  policy: CapabilityPolicyDecisionInfo
  freshness: CapabilityFreshnessInfo
}

export interface CapabilityActionInfo {
  action_id: string
  module: string
  method: string
  topic: string | null
  tool_id: string | null
  resource_id: string | null
  provider_id: string
  peer_id: string
  provider_kind: string
  service_instance_id: string
  selector: unknown
  bindability: string
  sdk_operation_kind: string
  route_hints: string[]
  route_blockers: string[]
  summary: string
  input_schema: JsonObject | null
  output_schema: JsonObject | null
  policy: CapabilityPolicyDecisionInfo
  freshness: CapabilityFreshnessInfo
}

export interface CapabilityCatalogResourceInfo {
  resource_id: string
  resource_type: string
  owner_peer_id: string
  service_instance_id: string | null
  namespace: string | null
  display_name: string
  capabilities: string[]
  selector: unknown
  policy: CapabilityPolicyDecisionInfo
  freshness: CapabilityFreshnessInfo
}

export interface CapabilityCatalogRequest {
  modules?: string[] | null
  include_unavailable?: boolean
  include_internal?: boolean
  include_schemas?: boolean
}

export interface CapabilityCatalogResponse {
  generated_at: string
  local_peer_id: string | null
  local_node_name: string
  providers: CapabilityProviderInfo[]
  actions: CapabilityActionInfo[]
  resources: CapabilityCatalogResourceInfo[]
  provider_index: Record<string, string[]>
  action_index: Record<string, string[]>
  secrets_redacted: boolean
}

export interface CapabilitySummary {
  id: string
  module: string
  method: string
  busTopic: string | null
  providerId: string
  peerId: string
  serviceInstanceId: string
  availability: AvailabilityState
  privacyClass: PrivacyClass
  requiredPermissions: string[]
  routeBlockers: string[]
  selector: unknown
  raw: CapabilityActionInfo
}

export interface RouteExplainRequest {
  topic?: string | null
  module?: string | null
  method?: string | null
  selector?: unknown
  include_candidates?: boolean
}

export interface RouteBlockerInfo {
  code: string
  message: string
  severity: string
  provider_id: string | null
  peer_id: string | null
  security_privacy: boolean
}

export interface RouteCandidateDecision {
  provider_id: string
  peer_id: string
  provider_kind: string
  service_instance_id: string
  module: string
  version: string
  included: boolean
  selected: boolean
  reason_code: string
  reason: string
  latency_ms: number | null
  active_calls: number
  max_concurrent: number
  available_capacity: number | null
  blockers: RouteBlockerInfo[]
}

export interface RouteExplainResponse {
  topic: string
  module: string
  selected_target: string
  selected_peer_id: string | null
  selected_service_instance_id: string | null
  selected_provider_id: string | null
  selector_valid: boolean
  selector_validation_code: string
  selector_validation_message: string
  fallback_behavior: string
  candidates: RouteCandidateDecision[]
  blockers: RouteBlockerInfo[]
  security_privacy_blockers: RouteBlockerInfo[]
  secrets_redacted: boolean
}

export interface AuditReference {
  correlationId: string | null
  eventKind: string | null
  peerId: string | null
  method: string | null
  toolId: string | null
  resourceId: string | null
  status: string | null
  redacted: boolean
}

export interface NativeCapabilityManifest {
  platform: 'tauri-desktop' | 'android' | 'ios' | string
  permissions: Record<string, boolean>
  capabilities: Record<string, boolean>
}
