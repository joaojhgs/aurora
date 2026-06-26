import type { AuroraError } from './errors.js'
import type { LoginLikeResponse, PairingExchangeLikeResponse, ValidateTokenLikeResponse, WhoAmILikeResponse } from './session.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export type AuroraTransportKind = 'http' | 'tauri-local' | 'mesh' | 'native-mobile' | 'mock' | string

export interface RedactionMetadata {
  secretsRedacted: boolean
  redactedFields: string[]
  source: 'backend' | 'transport' | 'sdk' | 'unknown'
  warnings: string[]
}

export interface AuditReceipt {
  correlationId: string | null
  eventKind: string | null
  peerId: string | null
  principalId: string | null
  targetPeerId: string | null
  method: string | null
  busTopic: string | null
  toolId: string | null
  resourceId: string | null
  status: string | null
  transport: AuroraTransportKind | null
  redaction: RedactionMetadata
}

export interface AuroraRequest<TPayload = unknown> {
  method: string
  busTopic?: string | undefined
  path?: string | undefined
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined
  payload?: TPayload | undefined
  timeoutMs?: number | undefined
  headers?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  audit?: Partial<AuditReceipt> | undefined
}

export interface AuroraTransportEnvelope<TData = unknown> {
  data: TData
  status?: number | undefined
  headers?: Headers | Record<string, string> | undefined
  audit?: Partial<AuditReceipt> | undefined
}

export interface AuroraResultSuccess<TData> {
  ok: true
  data: TData
  audit: AuditReceipt
}

export interface AuroraResultFailure {
  ok: false
  error: AuroraError
  audit: AuditReceipt
}

export type AuroraResult<TData> = AuroraResultSuccess<TData> | AuroraResultFailure

export interface AuroraEvent<TPayload = unknown> {
  id: string | null
  kind: string
  topic: string | null
  method: string | null
  busTopic: string | null
  payload: TPayload
  audit: AuditReceipt
  redaction: RedactionMetadata
  receivedAt: string
}

export interface OrchestratorProcessRequest {
  text: string
  source?: string
  session_id?: string | null
}

export interface OrchestratorResponse {
  text: string
  session_id?: string | null
  metadata?: JsonObject
}

export interface AssistantRoutePolicy {
  providerId?: string | null
  peerId?: string | null
  serviceInstanceId?: string | null
  routeState?: AvailabilityState | null
  fallbackBehavior?: string | null
  privacyClass?: PrivacyClass | null
  selectorRequired?: boolean
  approvalRequired?: boolean
}

export interface AssistantSendMessageRequest {
  text: string
  sessionId?: string | null
  routePolicy?: AssistantRoutePolicy | null
  timeoutMs?: number
}

export interface AssistantStreamMessageRequest extends AssistantSendMessageRequest {
  signal?: AbortSignal
  lastEventId?: string | null
  replayFrom?: string | null
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface AssistantSendMessageResult {
  sessionId: string
  response: AssistantMessage
  routePolicy: AssistantRoutePolicy | null
  modelLabel: string | null
  privacyClass: PrivacyClass
  metadata: JsonObject
}

export type AssistantStreamUpdateKind = 'delta' | 'completed' | 'failed' | 'tool' | 'transport_lost' | 'fallback'

export interface AssistantStreamUpdate {
  kind: AssistantStreamUpdateKind
  eventId: string | null
  sessionId: string | null
  text: string
  textDelta: string
  modelLabel: string | null
  error: AuroraError | null
  audit: AuditReceipt
  metadata: JsonObject
}

export type OrchestratorInterruptScope = 'generation' | 'tool_call' | 'tts_playback' | 'session'
export type OrchestratorInterruptStatus = 'cancelled' | 'no_active_work' | 'not_supported' | 'failed'

export interface OrchestratorInterruptRequest {
  scopes?: OrchestratorInterruptScope[]
  session_id?: string | null
  request_id?: string | null
  reason?: string
}

export interface OrchestratorInterruptScopeResult {
  scope: OrchestratorInterruptScope
  status: OrchestratorInterruptStatus
  message: string
  cancelled_count: number
}

export interface OrchestratorInterruptResponse {
  interrupt_id: string
  status: string
  requested_scopes: OrchestratorInterruptScope[]
  results: OrchestratorInterruptScopeResult[]
  session_id: string | null
  request_id: string | null
  event_topic: string
  audit_event: string
  idempotent: boolean
  secrets_redacted: boolean
}

export interface AssistantCancelRequest {
  sessionId?: string | null
  requestId?: string | null
  scopes?: OrchestratorInterruptScope[]
  reason?: string
}

export type AttachmentContextKind = 'text' | 'url' | 'file' | 'image'
export type AttachmentContextPrivacyClass = Exclude<PrivacyClass, 'admin-critical'>
export type AttachmentContextSourceChannel =
  | 'chat'
  | 'api'
  | 'desktop'
  | 'mobile_share_sheet'
  | 'deep_link'
  | 'browser_extension'
export type AttachmentContextStoragePolicy = 'ephemeral' | 'rag' | 'reject'
export type AttachmentContextStatus =
  | 'accepted'
  | 'stored'
  | 'rejected'
  | 'redacted'
  | 'unsupported'

export interface AttachmentContextLimits {
  max_items: number
  max_item_bytes: number
  max_total_bytes: number
  max_text_chars: number
}

export interface AttachmentContextSource {
  channel: AttachmentContextSourceChannel
  display_name?: string | null
  uri?: string | null
  mime_type?: string | null
  platform?: string | null
  originating_app?: string | null
  shared_at?: string | null
  principal_id?: string | null
  device_id?: string | null
  peer_id?: string | null
}

export interface AttachmentContextItem {
  kind: AttachmentContextKind
  content_text?: string | null
  url?: string | null
  title?: string | null
  filename?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  source?: Partial<AttachmentContextSource> | null
  metadata?: JsonObject
}

export interface AttachmentContextIngestRequest {
  items: AttachmentContextItem[]
  session_id?: string | null
  namespace?: string
  storage_policy?: AttachmentContextStoragePolicy
  privacy_class?: AttachmentContextPrivacyClass
  caller_principal_id?: string | null
  correlation_id?: string | null
  policy_decision_id?: string | null
  limits?: Partial<AttachmentContextLimits>
}

export interface AttachmentContextItemResult {
  item_id: string
  kind: AttachmentContextKind
  status: AttachmentContextStatus
  storage_policy: AttachmentContextStoragePolicy
  privacy_class: AttachmentContextPrivacyClass
  accepted_bytes: number
  stored_namespace: string | null
  stored_key: string | null
  redacted: boolean
  redaction_reasons: string[]
  reason_code: string | null
  message: string
}

export interface AttachmentContextIngestResponse {
  accepted: boolean
  rejected: boolean
  total_items: number
  accepted_items: AttachmentContextItemResult[]
  rejected_items: AttachmentContextItemResult[]
  total_bytes: number
  storage_policy: AttachmentContextStoragePolicy
  privacy_class: AttachmentContextPrivacyClass
  audit_event: string
  correlation_id: string | null
  secrets_redacted: boolean
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


export interface AuthLoginRequest {
  username: string
  password: string
}

export interface AuthLoginResponse extends LoginLikeResponse {
  token: string
}

export interface AuthValidateTokenRequest {
  token: string
}

export type AuthValidateTokenResponse = ValidateTokenLikeResponse

export type AuthWhoAmIResponse = WhoAmILikeResponse

export interface AuthPairingStartRequest {
  device_name: string
  client_ip?: string
  remote_peer_id?: string
  remote_node_name?: string
}

export interface AuthPairingStartResponse {
  code: string
  expires_in_seconds: number
}

export interface AuthPairingConnectRequest {
  code: string
}

export interface AuthPairingConnectResponse {
  request_id: string
  device_name: string
  status: string
}

export interface AuthPairingExchangeRequest {
  code: string
}

export interface AuthPairingExchangeResponse extends PairingExchangeLikeResponse {
  token: string
  token_id?: string
}

export interface AuthPairingApproveRequest {
  code: string
  permissions?: string[] | null
  is_admin?: boolean
}

export interface AuthPairingApproveResponse {
  success: boolean
}

export interface AuthPairingDenyRequest {
  code: string
  reason?: string
}

export interface AuthPairingDenyResponse {
  success: boolean
}

export interface PendingPairingEntry {
  request_id: string
  code: string
  device_name: string
  client_ip: string
  status: string
  expires_at: string
  created_at: string
  remote_peer_id: string
  remote_node_name: string
  approved_by: string | null
  denied_by: string | null
  denied_reason: string
  granted_permissions: string[]
  granted_is_admin: boolean
}

export interface ListPendingPairingsRequest {
  include_non_pending?: boolean
}

export interface ListPendingPairingsResponse {
  pairings: PendingPairingEntry[]
  total: number
  expired_count: number
  secrets_redacted: boolean
}

export interface PrincipalCreateRequest {
  username: string
  password?: string | null
  permissions?: string[] | null
  is_admin?: boolean
}

export interface PrincipalResponse {
  id: string
  username: string
  permissions: string[]
  is_admin: boolean
  created_at?: string | null
}

export interface PrincipalListRequest {}

export interface PrincipalListResponse {
  principals: PrincipalResponse[]
}

export interface PrincipalGetRequest {
  user_id: string
}

export interface PrincipalUpdateRequest {
  user_id: string
  username?: string | null
  password?: string | null
  is_admin?: boolean | null
}

export interface PrincipalDeleteRequest {
  user_id: string
}

export interface PrincipalDeleteResponse {
  success: boolean
}

export interface PermissionSetRequest {
  user_id: string
  permissions: string[]
}

export interface PermissionSetResponse {
  success: boolean
}

export interface PermissionPatchRequest {
  user_id: string
  grant?: string[] | null
  revoke?: string[] | null
}

export interface PermissionPatchResponse {
  success: boolean
}

export interface TokenListRequest {
  principal_id?: string | null
  device_id?: string | null
}

export interface TokenResponse {
  id: string
  prefix: string
  device_id?: string | null
  user_id?: string | null
  scopes: string[]
  created_at?: string | null
  expires_at?: string | null
}

export interface TokenListResponse {
  tokens: TokenResponse[]
}

export interface TokenRevokeRequest {
  token_id: string
}

export interface TokenRevokeResponse {
  success: boolean
}

export interface DeviceListRequest {
  principal_id?: string | null
}

export interface DeviceResponse {
  id: string
  user_id?: string | null
  name: string
  is_trusted: boolean
  created_at?: string | null
  last_seen?: string | null
}

export interface DeviceListResponse {
  devices: DeviceResponse[]
}

export interface DeviceDeleteRequest {
  device_id: string
}

export interface DeviceDeleteResponse {
  success: boolean
}

export interface AuditLogRequest {
  limit?: number
  offset?: number
  principal_id?: string | null
  event?: string | null
  correlation_id?: string | null
  peer_id?: string | null
  provider_id?: string | null
  tool_id?: string | null
  action?: string | null
  policy_decision_id?: string | null
  route?: string | null
}

export interface AuditLogEntry {
  id?: string | null
  event?: string | null
  principal_id?: string | null
  details?: string | null
  ip_address?: string | null
  created_at?: string | null
  correlation_id?: string | null
  peer_id?: string | null
  provider_id?: string | null
  tool_id?: string | null
  action?: string | null
  policy_decision_id?: string | null
  route?: string | null
  [key: string]: JsonValue | undefined
}

export interface AuditLogResponse {
  events: AuditLogEntry[]
  total: number
}

export interface ServiceInfo {
  module: string
  version: string
  summary: string
  capabilities: string[]
  method_count: number
  last_seen: string
  status: string
  instance_id: string | null
}

export interface GetServicesResponse {
  services: ServiceInfo[]
  mode: string
}

export interface BusHealth {
  backend: string
  redis_url_redacted: string | null
  redis_reachable: boolean | null
  bullmq_available: boolean | null
  queue_lag_known: boolean
  queue_depth: number | null
  published: number | null
  delivered: number | null
  retries: number | null
  dead_letters: number | null
  status: string
  degraded_reasons: string[]
  error: string | null
}

export interface ServiceProcessTopology {
  module: string
  status: string
  topology: string
  instance_id: string | null
  container_hint: string | null
  process_hint: string | null
  last_seen: string | null
  stale: boolean
}

export interface ContainerTopologyHints {
  orchestrator: string
  compose_file: string | null
  redis_service: string | null
  gateway_service: string | null
  config_service: string | null
  notes: string[]
}

export interface DeploymentTopologyResponse {
  architecture_mode: string
  runtime_mode: string
  bus_backend: string
  redis_url_redacted: string | null
  redis_reachable: boolean | null
  bullmq_queue_health: BusHealth
  service_process_topology: ServiceProcessTopology[]
  container_topology_hints: ContainerTopologyHints
  mode_capability_degradations: string[]
  mesh_peer_topology_trusted: boolean | null
  generated_at: string
  secrets_redacted: boolean
}

export interface WebRTCSignalingDiagnostic {
  strategy: string
  connected: boolean
  encrypted_presence: boolean
  app_id_configured: boolean
  room_configured: boolean
  broker_count: number
  public_broker_warning: boolean
}

export interface WebRTCPeerDiagnostic {
  signaling_peer_id: string
  stable_peer_id: string
  node_name: string
  connection_state: string
  ice_connection_state: string
  ice_gathering_state: string
  signaling_state: string
  data_channel_state: string
  data_channel_label: string
  has_send_channel: boolean
  rtt_ms: number | null
  auth_state: string
  identity_source: string
  is_admin: boolean
  effective_permission_count: number
  pairing_active: boolean
  auth_timeout_pending: boolean
  pending_pairing_task: boolean
}

export interface WebRTCDiagnosticError {
  timestamp: string
  code: string
  message: string
  peer_id: string | null
}

export interface WebRTCDiagnosticsResponse {
  enabled: boolean
  started: boolean
  mesh_enabled: boolean
  local_signaling_peer_id: string | null
  local_mesh_peer_id: string | null
  local_node_name: string
  require_auth: boolean
  auth_timeout_seconds: number
  pairing_timeout_seconds: number
  app_layer_e2ee_enabled: boolean
  signaling: WebRTCSignalingDiagnostic
  peers: WebRTCPeerDiagnostic[]
  connected_peer_count: number
  authenticated_peer_count: number
  pairing_peer_count: number
  pending_rpc_count: number
  recent_errors: WebRTCDiagnosticError[]
  secrets_redacted: boolean
}

export interface MeshLocalStatus {
  mesh_enabled: boolean
  mesh_started: boolean
  webrtc_started: boolean
  peer_id: string | null
  node_name: string
  peer_selection: string
  version_policy: string
  shared_modules: string[]
  routed_modules: string[]
}

export interface MeshPeerServiceDiagnostic {
  module: string
  version: string
  capabilities: string[]
  method_names: string[]
  max_concurrent: number
  active_calls: number
  available_capacity: number | null
  digest: string
}

export interface MeshPeerCompatibilityDiagnostic {
  local_compatible: string[]
  local_incompatible: string[]
  local_unused: string[]
  remote_compatible: string[]
  remote_incompatible: string[]
  remote_unused: string[]
}

export interface MeshPeerDiagnostic {
  peer_id: string
  node_name: string
  status: string
  latency_ms: number | null
  last_ping_age_s: number | null
  last_manifest_age_s: number | null
  active_calls: number
  services: MeshPeerServiceDiagnostic[]
  compatibility: MeshPeerCompatibilityDiagnostic
}

export interface MeshRouteProviderDiagnostic {
  peer_id: string
  node_name: string
  status: string
  version: string
  latency_ms: number | null
  active_calls: number
  max_concurrent: number
  eligible: boolean
  reason_code: string
  reason: string
}

export interface MeshRouteDiagnostic {
  module: string
  configured: boolean
  share: boolean
  prefer: string
  fallback: string
  min_version: string | null
  required_capabilities: string[]
  decision_target: string
  decision_peer_id: string | null
  decision_version: string
  decision_latency_ms: number | null
  reason: string
  providers: MeshRouteProviderDiagnostic[]
}

export interface MeshCompatibilityFailure {
  peer_id: string
  module: string
  direction: string
  reason: string
}

export interface MeshStatusResponse {
  local: MeshLocalStatus
  peers: MeshPeerDiagnostic[]
  routes: MeshRouteDiagnostic[]
  compatibility_failures: MeshCompatibilityFailure[]
  secrets_redacted: boolean
}

export interface MeshPeerInfo {
  id: string
  peer_id: string
  node_name: string
  room_name: string
  ip: string | null
  port: number | null
  outbound_status: string
  outbound_permissions: string[]
  outbound_approved_at: string | null
  outbound_approved_by: string | null
  inbound_status: string
  inbound_permissions: string[]
  inbound_approved_at: string | null
  connection_status: string
  first_seen_at: string
  last_seen_at: string | null
  last_status_change_at: string
}

export interface MeshPeerListRequest {
  room_name?: string | null
  outbound_status?: string | null
  include_disconnected?: boolean
}

export interface MeshPeerListResponse {
  peers: MeshPeerInfo[]
  total: number
}

export interface MeshPeerGetRequest {
  peer_id: string
  room_name?: string | null
}

export interface MeshPeerGetResponse {
  peer: MeshPeerInfo | null
}

export interface MeshPeerApproveRequest {
  peer_id: string
  permissions: string[]
  approved_by?: string | null
}

export interface MeshPeerDenyRequest {
  peer_id: string
}

export interface MeshPeerUpdatePermissionsRequest {
  peer_id: string
  permissions: string[]
}

export interface MeshPeerRemoveRequest {
  peer_id: string
  revoke_token?: boolean
}

export interface MeshBoolResponse {
  success: boolean
  message: string
}

export interface GatewayEventStreamEvent {
  id: string
  kind: string
  topic: string | null
  bus_topic: string | null
  correlation_id: string | null
  peer_id: string | null
  target_peer_id: string | null
  status: string | null
  timestamp: string
  payload_summary: JsonObject
  secrets_redacted: boolean
}

export interface SupportBundleRedactionInfo {
  secrets_redacted: boolean
  redacted_fields: string[]
  omitted_payloads: string[]
}

export interface SupportBundleDiagnosticItem {
  name: string
  status: string
  source: string
  details: JsonObject
  redacted: boolean
}

export interface GatewaySupportBundleRequest {
  correlation_id?: string | null
  event_limit?: number
  audit_limit?: number
  include_capability_catalog?: boolean
}

export interface CapabilityCatalogSummary {
  providers: number
  actions: number
  resources: number
  modules: string[]
  blocked_actions: number
}

export interface GatewaySupportBundleResponse {
  generated_at: string
  correlation_id: string | null
  registry: GetRegistryResponse
  services: ServiceInfo[]
  service_health: Array<{
    module: string
    status: string
    checks: Record<string, JsonValue>
    timestamp: string
  }>
  mesh_status: JsonObject
  webrtc_diagnostics: WebRTCDiagnosticsResponse
  route_diagnostics: JsonObject[]
  capability_catalog_summary: CapabilityCatalogSummary
  recent_events: GatewayEventStreamEvent[]
  recent_audit_events: JsonObject[]
  native_capabilities: SupportBundleDiagnosticItem[]
  sidecar_logs: SupportBundleDiagnosticItem[]
  config_shape: JsonObject
  correlation_ids: string[]
  audit_receipt: string | null
  audit_error: string | null
  redaction: SupportBundleRedactionInfo
  secrets_redacted: boolean
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

export interface GatewayBuiltinRouteDescriptor {
  name: string
  summary: string
  routePath: string
  httpMethods: string[]
  routeKind: 'gateway_builtin'
  exposure: 'gateway_builtin'
  methodType: ContractMethodType
  requiredPermissions: string[]
}

export type BackendInventoryRouteKind = 'dynamic' | 'internal_bus' | 'gateway_builtin' | string

export interface BackendInventoryMethod {
  module: string
  name: string
  summary?: string | null
  bus_topic: string | null
  routePath?: string | null
  route_path?: string | null
  route_kind?: BackendInventoryRouteKind
  exposure: ContractExposure
  method_type: ContractMethodType
  required_perms: string[]
  input_model?: string | null
  output_model?: string | null
  input_schema?: JsonObject | null
  output_schema?: JsonObject | null
  source?: string | null
  source_file?: string | null
}

export interface GatewayBuiltinInventoryRoute {
  name: string
  summary?: string | null
  routePath?: string | null
  route_path?: string | null
  http_methods: string[]
  route_kind: 'gateway_builtin' | string
  exposure: 'gateway_builtin' | string
  method_type: ContractMethodType
  required_perms: string[]
}

export interface BackendInventory {
  generated_by?: string
  method_count?: number
  gateway_builtin_count?: number
  methods: BackendInventoryMethod[]
  gateway_builtins?: GatewayBuiltinInventoryRoute[]
  import_errors?: Array<Record<string, JsonValue>>
  ui_fixture_validation?: Record<string, JsonValue>
}

export interface GeneratedMethodDescriptor extends MethodDescriptor {
  routeKind: BackendInventoryRouteKind
  source: string | null
  sourceFile: string | null
}

export interface BackendMethodTypeDescriptor<
  TRequest = JsonObject,
  TResponse = JsonObject
> {
  busTopic: string
  requestModel: string | null
  responseModel: string | null
  requestSchema: JsonObject | null
  responseSchema: JsonObject | null
  descriptor: GeneratedMethodDescriptor
}

export interface BackendInventoryDescriptors {
  methods: GeneratedMethodDescriptor[]
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[]
  methodTypes: Record<string, BackendMethodTypeDescriptor>
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

export type CapabilityProviderIdentity =
  | 'local'
  | `remote:${string}`
  | `native:${string}`
  | 'cloud'
  | 'unavailable'
  | 'blocked'
  | string

export interface CapabilityProviderCandidate {
  id: string
  featureId: string
  providerIdentity: CapabilityProviderIdentity
  providerId: string
  providerKind: string
  peerId: string | null
  serviceInstanceId: string | null
  module: string
  method: string
  busTopic: string | null
  toolId: string | null
  resourceId: string | null
  availability: AvailabilityState
  selectable: boolean
  selected: boolean
  trustTier: string
  routeability: string
  freshness: CapabilityFreshnessInfo
  requiredPermissions: string[]
  privacyClass: PrivacyClass
  disabledReasons: string[]
  requiredAction: string | null
  selector: unknown
  source: 'catalog' | 'registry' | 'native-manifest'
  raw: CapabilityActionInfo | MethodDescriptor | null
}

export interface CapabilityGraphNode {
  featureId: string
  module: string
  method: string
  busTopic: string | null
  kind: 'method' | 'tool' | 'resource' | 'native' | string
  availability: AvailabilityState
  privacyClass: PrivacyClass
  providerIdentity: CapabilityProviderIdentity
  selectedProvider: CapabilityProviderCandidate | null
  providers: CapabilityProviderCandidate[]
  alternateProviders: CapabilityProviderCandidate[]
  requiredPermissions: string[]
  disabledReason: string | null
  requiredAction: string | null
  freshness: CapabilityFreshnessInfo | null
  selectorRequired: boolean
  approvalRequired: boolean
  routeable: boolean
  trustTier: string | null
  rawActions: CapabilityActionInfo[]
}

export interface CapabilityExplanation {
  featureId: string
  state: AvailabilityState
  summary: string
  selectedProvider: CapabilityProviderCandidate | null
  providerCandidates: CapabilityProviderCandidate[]
  alternateProviders: CapabilityProviderCandidate[]
  disabledReason: string | null
  nextRepairAction: string | null
  selectorRequired: boolean
  approvalRequired: boolean
  routeable: boolean
  requiredPermissions: string[]
  privacyClass: PrivacyClass
  evidence: {
    generatedAt: string
    secretsRedacted: boolean
    sources: string[]
  }
}

export interface CapabilityGraph {
  generatedAt: string
  localPeerId: string | null
  localNodeName: string
  secretsRedacted: boolean
  nodes: CapabilityGraphNode[]
  byFeatureId: Record<string, CapabilityGraphNode>
  providerIndex: Record<string, string[]>
  candidateProviderIndex: Record<string, string[]>
  explain(featureId: string): CapabilityExplanation
}

export interface CapabilityGraphInput {
  catalog: CapabilityCatalogResponse
  registry?: GetRegistryResponse | null
  nativeManifest?: NativeCapabilityManifest | null
  transportKind?: AuroraTransportKind | null
}

export interface ModelRuntimeFileInfo {
  kind: string
  display_name: string
  exists: boolean | null
  size_bytes: number | null
  path_redacted: boolean
}

export interface ModelRuntimeBenchmarkInfo {
  status: string
  tokens_per_second: number | null
  latency_ms: number | null
  measured_at: string | null
  reason: string | null
}

export interface ModelRuntimeProgressInfo {
  operation_id: string | null
  operation_type: string
  status: string
  progress_percent: number
  message: string
  updated_at: string | null
}

export interface ModelRuntimeProviderInfo {
  provider_id: string
  display_name: string
  backend_kind: string
  provider_type: string
  enabled: boolean
  selected: boolean
  health: string
  health_reason: string | null
  model_id: string | null
  source: string | null
  license: string | null
  context_window: number | null
  generation_limit: number | null
  hardware: JsonObject
  model_files: ModelRuntimeFileInfo[]
  capabilities: string[]
  benchmark: ModelRuntimeBenchmarkInfo
  import_progress: ModelRuntimeProgressInfo
  download_progress: ModelRuntimeProgressInfo
  secrets_redacted: boolean
}

export interface ModelRuntimeRequest {
  provider_id?: string | null
  include_unavailable?: boolean
}

export interface ModelRuntimeCatalogRequest {
  include_unavailable?: boolean
  include_operations?: boolean
}

export interface ModelRuntimeCatalogResponse {
  generated_at: string
  selected_provider_id: string | null
  providers: ModelRuntimeProviderInfo[]
  provider_index: Record<string, string[]>
  unavailable: string[]
  internal_only: string[]
  secrets_redacted: boolean
}

export interface ModelRuntimeResponse {
  generated_at: string
  selected_provider_id: string | null
  provider: ModelRuntimeProviderInfo | null
  providers: ModelRuntimeProviderInfo[]
  secrets_redacted: boolean
}

export interface ModelRuntimeOperationRequest {
  provider_id?: string | null
  model_id?: string | null
  source_uri?: string | null
  target_name?: string | null
  options?: JsonObject
  dry_run?: boolean
}

export interface ModelRuntimeOperationStatusRequest {
  operation_id: string
}

export interface ModelRuntimeOperationResponse {
  operation_id: string
  operation_type: string
  status: string
  provider_id: string | null
  model_id: string | null
  progress_percent: number
  message: string
  reason_code: string | null
  started_at: string | null
  updated_at: string | null
  completed_at: string | null
  audit_event: string | null
  secrets_redacted: boolean
}

export interface PeerSummary {
  peerId: string
  nodeName: string
  lifecycleState: string
  trustState: string
  latencyMs: number | null
  staleAgeSeconds: number | null
  serviceCount: number
  lastEvidenceSource: string
}

export interface NativeCapabilityState {
  platform: string
  availability: AvailabilityState
  permissions: Record<string, boolean>
  capabilityKeys: string[]
  evidenceSource: string
}

export interface AdminOverviewServiceSummary {
  module: string
  version: string
  status: string
  methodCount: number
  externalMethodCount: number
  internalMethodCount: number
  requiredPermissions: string[]
  lastSeen: string
}

export interface AdminOverviewManifestInput {
  registry: GetRegistryResponse
  services?: GetServicesResponse | ServiceInfo[]
  deploymentTopology?: DeploymentTopologyResponse | null
  deploymentTopologyError?: string | null
  capabilityCatalog?: CapabilityCatalogResponse | null
  gatewayBuiltins?: GatewayBuiltinRouteDescriptor[]
  nativeManifest?: NativeCapabilityManifest | null
  peers?: PeerSummary[]
  generatedAt?: string
}

export interface AdminOverviewManifest {
  generatedAt: string
  registryDigest: string
  serviceMode: string
  deploymentTopology: DeploymentTopologyResponse | null
  deploymentTopologyError: string | null
  services: AdminOverviewServiceSummary[]
  methods: MethodDescriptor[]
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[]
  capabilities: CapabilitySummary[]
  native: NativeCapabilityState
  peers: PeerSummary[]
  unavailable: CapabilitySummary[]
  internalOnly: MethodDescriptor[]
  permissionCatalog: string[]
  totals: {
    services: number
    methods: number
    externalMethods: number
    internalMethods: number
    gatewayBuiltins: number
    capabilityActions: number
    peers: number
  }
  privacy: {
    secretsRedacted: boolean
    nativeStateInvented: false
    peerStateInvented: false
  }
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

export interface ApprovalScope {
  scope: 'single' | 'tool-args' | 'peer-provider' | 'session' | 'local-safe-tools' | 'deny-all' | string
  decision: 'approve' | 'deny' | 'deny-all'
  approvalId?: string | null
  peerId?: string | null
  providerId?: string | null
  toolId?: string | null
  resourceId?: string | null
  argsHash?: string | null
  sessionId?: string | null
  expiresAt?: string | null
}

export interface RoutePolicyInput {
  route: RouteExplainResponse
  catalog?: CapabilityCatalogResponse | null
  payload?: unknown
  selector?: unknown
  topic?: string | null
  method?: string | null
  actionId?: string | null
  toolId?: string | null
  resourceId?: string | null
  sessionId?: string | null
  argsHash?: string | null
  dataClasses?: PrivacyClass[]
  privacyClass?: PrivacyClass
  approvalScopes?: ApprovalScope[]
  consentGranted?: boolean
  privacyIndicatorShown?: boolean
  allowCloudFallback?: boolean
  auditReceiptTarget?: string | null
  transportKind?: AuroraTransportKind | null
  now?: string
}

export interface RoutePreview {
  topic: string
  module: string
  method: string | null
  providerId: string | null
  peerId: string | null
  serviceInstanceId: string | null
  providerKind: string
  trustTier: string
  transport: AuroraTransportKind | null
  fallbackBehavior: string
  egressDestination: 'local' | 'peer' | 'cloud' | 'none'
  expectedPersistence: string
  auditReceiptTarget: string | null
  dataClasses: PrivacyClass[]
  privacyClass: PrivacyClass
  selector: unknown
  payloadPreview: unknown
  secretsRedacted: boolean
  blockers: Array<{
    code: string
    message: string
    securityPrivacy: boolean
  }>
}

export interface RoutePolicyEvaluation {
  decision: 'allowed' | 'blocked' | 'privacy-blocked'
  allowed: boolean
  availability: AvailabilityState
  reasonCode: string
  repairPath: string | null
  privacyClass: PrivacyClass
  dataClasses: PrivacyClass[]
  explicitSelectorRequired: boolean
  approval: {
    required: boolean
    status: 'not-required' | 'required' | 'approved' | 'expired' | 'rejected'
    scopes: ApprovalScope[]
    matchedScope?: ApprovalScope
  }
  route: RouteExplainResponse
  selectedCandidate: RouteCandidateDecision | null
  blockers: RouteBlockerInfo[]
  preview: RoutePreview
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
  mobileIntegrations?: NativeMobileIntegration[]
  platformLimitations?: NativePlatformLimitation[]
}

export type NativeIntegrationSupport = 'supported' | 'supported-path' | 'planned' | 'unsupported' | 'blocked'

export interface NativeMobileIntegration {
  platform: 'android' | 'ios' | string
  id: string
  label: string
  support: NativeIntegrationSupport
  capability: string
  permission: string | null
  privacyClass: PrivacyClass
  evidenceSource: string
  userCopy: string
  verifier: string
}

export interface NativePlatformLimitation {
  platform: 'android' | 'ios' | string
  id: string
  label: string
  reason: string
  userCopy: string
  evidenceSource: string
}
