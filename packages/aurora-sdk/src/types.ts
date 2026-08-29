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
  request_id?: string | null
  correlation_id?: string | null
  stream?: boolean
  client_tts_playback?: boolean | null
  dispatch_selector?: JsonObject
  mesh_selector?: JsonObject
  selector?: JsonObject
  inference_selector?: JsonObject
  inference_provider_id?: string
  inference_model_id?: string
}

export interface OrchestratorResponse {
  text: string
  session_id?: string | null
  request_id?: string | null
  correlation_id?: string | null
  metadata?: JsonObject
}

export interface OrchestratorChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string | null
  tool_call_id?: string | null
  tool_calls?: JsonObject[]
  metadata?: JsonObject
}

export interface OrchestratorInferChatRequest {
  messages: OrchestratorChatMessage[]
  stream?: boolean
  model_id?: string | null
  provider_id?: string | null
  tools?: JsonObject[]
  tool_choice?: JsonObject | string | boolean | null
  params?: JsonObject
  correlation_id?: string | null
  session_id?: string | null
  request_id?: string | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
  metadata?: JsonObject
}

export interface OrchestratorInferChatResponse {
  text: string
  message?: OrchestratorChatMessage | null
  model_id?: string | null
  provider_id?: string | null
  finish_reason?: string | null
  correlation_id?: string | null
  session_id?: string | null
  request_id?: string | null
  metadata?: JsonObject
  secrets_redacted: boolean
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
  inferencePolicy?: AssistantInferencePolicy | null
  timeoutMs?: number
}

export interface AssistantInferencePolicy extends AssistantRoutePolicy {
  runtimeProviderId?: string | null
  modelId?: string | null
  dataLeavesDevice?: boolean | null
}

export interface AssistantStreamMessageRequest extends AssistantSendMessageRequest {
  signal?: AbortSignal
  lastEventId?: string | null
  replayFrom?: string | null
  requestId?: string | null
  clientTtsPlayback?: boolean | null
}


export interface TTSPlaybackRequest {
  text: string
  voice?: string | null
  speed?: number
  interrupt?: boolean
  routePolicy?: AssistantRoutePolicy | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
}

export interface TTSSynthesisRequest {
  text: string
  voice?: string | null
  speed?: number
  format?: 'wav' | 'raw' | string
  sample_rate?: number | null
  routePolicy?: AssistantRoutePolicy | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
}

export interface TTSSynthesisResponse {
  audio_data: string
  format: string
  sample_rate: number
  channels: number
  duration_ms: number
  text: string
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

export type AssistantStreamUpdateKind =
  | 'delta'
  | 'completed'
  | 'failed'
  | 'tool'
  | 'tts_audio_chunk'
  | 'transport_lost'
  | 'fallback'

export type AssistantToolStreamStatus = 'requested' | 'running' | 'completed' | 'failed' | 'requires_action' | string

export interface AssistantToolStreamEvent {
  id: string
  name: string
  status: AssistantToolStreamStatus
  riskClass: string | null
  target: string | null
  dataLeavesDevice: boolean | null
  summary: string | null
  payloadPreview: JsonObject | null
  resultPreview: JsonObject | string | null
  error?: string | null
  errorDetails?: JsonObject | string | null
  pendingId?: string | null
  approvalRequestId?: string | null
  approvalExpiresAt?: number | null
  policyDecisionId?: string | null
}

export interface AssistantTtsAudioChunkEvent {
  chunkId: string | null
  sequence: number | null
  audioData: string | null
  encoding: string | null
  mimeType: string | null
  sampleRate: number | null
  channels: number | null
  durationMs: number | null
  final: boolean
}

export interface AssistantStreamUpdate {
  kind: AssistantStreamUpdateKind
  eventId: string | null
  messageId: string | null
  sessionId: string | null
  text: string
  textDelta: string
  modelLabel: string | null
  requestId?: string | null
  error: AuroraError | null
  audit: AuditReceipt
  metadata: JsonObject
  tool: AssistantToolStreamEvent | null
  ttsAudio: AssistantTtsAudioChunkEvent | null
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

export type OrchestratorToolApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'executed'
  | 'failed'
  | 'expired'

export type ToolingApprovalGrantScope =
  | 'once'
  | 'session'
  | 'until_expiry'
  | 'always'
  | 'scheduled_execution'
  | 'deny_once'
  | 'deny_always'
  | string

export interface OrchestratorPendingToolApproval {
  pending_id: string
  approval_request_id?: string | null
  status: OrchestratorToolApprovalStatus
  run_id: string
  thread_id: string
  session_id?: string | null
  owner_principal_id?: string | null
  owner_peer_id?: string | null
  message_id: string
  tool_call_id: string
  tool_name: string
  display_name?: string | null
  arguments_preview?: JsonObject
  policy_decision_id?: string | null
  correlation_id?: string | null
  created_at: number
  expires_at?: number | null
  metadata?: JsonObject
}

export interface OrchestratorListPendingToolApprovalsRequest {
  session_id?: string | null
  run_id?: string | null
  status?: OrchestratorToolApprovalStatus | null
}

export interface OrchestratorListPendingToolApprovalsResponse {
  approvals: OrchestratorPendingToolApproval[]
  count: number
}

export interface OrchestratorResumeToolApprovalRequest {
  pending_id?: string | null
  approval_request_id?: string | null
  session_id?: string | null
  approve?: boolean
  grant_scope?: ToolingApprovalGrantScope
  approver_principal_id?: string | null
  expires_at?: number | null
  include_future_tools?: boolean
  reason?: string | null
  correlation_id?: string | null
}

export interface OrchestratorResumeToolApprovalResponse {
  ok: boolean
  status: OrchestratorToolApprovalStatus
  pending?: OrchestratorPendingToolApproval | null
  tool_result?: JsonObject | null
  assistant_text?: string | null
  error?: string | null
  correlation_id?: string | null
}


export type ToolingApprovalMode =
  | 'deny_all'
  | 'ask_each_time'
  | 'allow_once'
  | 'allow_until_expiry'
  | 'approve_all_for_session'
  | 'approve_all_for_peer'
  | 'approve_all_local_safe'
  | 'dry_run_only'
  | string

export type ToolingPolicyMode = 'enforce' | 'dry_run_only' | 'deny_all' | 'unrestricted_except_blocked' | string
export type ToolingTrustTier = 'trusted' | 'untrusted' | 'blocked' | string
export type ToolingCapabilityClass = 'read' | 'write' | 'execute' | 'network' | 'secrets' | 'device' | 'admin' | string
export type ToolingSourceClass = 'core' | 'plugin' | 'mcp' | 'toolkit' | 'mesh_peer' | 'unknown' | string

export interface ToolingSharingPolicyRule {
  rule_id: string
  share?: boolean
  approval_mode?: ToolingApprovalMode
  tool_name?: string | null
  global_tool_id?: string | null
  execution_location?: 'local' | 'remote' | string | null
  source_type?: ToolingSourceClass | null
  toolkit_name?: string | null
  safety_class?: string | null
  operation_class?: string | null
  resource_namespace?: string | null
  hardware_target?: string | null
  data_scope?: string | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
  caller_device_id?: string | null
  caller_permissions?: string[] | null
  provider_peer_id?: string | null
  provider_service_instance_id?: string | null
  route_privacy_class?: string | null
  token_ttl_seconds?: number
  [key: string]: JsonValue | undefined
}

export interface ToolingSharingPolicy {
  default_share: boolean
  default_approval_mode: ToolingApprovalMode
  policy_mode: ToolingPolicyMode
  default_token_ttl_seconds: number
  rules: ToolingSharingPolicyRule[]
}

export interface ToolingGetSharingPolicyResponse {
  policy: ToolingSharingPolicy
}

export interface ToolingSetSharingPolicyRequest {
  policy: ToolingSharingPolicy
  actor_principal_id?: string | null
  confirmation_text?: string | null
  correlation_id?: string | null
}

export interface ToolingSetSharingPolicyResponse {
  ok: boolean
  policy: ToolingSharingPolicy
  error?: string | null
  correlation_id?: string | null
}

export type ToolingExportState = 'shared' | 'unshared'
export type ToolingExportScopeType = 'group' | 'tool'
export type ToolingExportDecisionSource =
  | 'peer_tool'
  | 'global_tool'
  | 'peer_group'
  | 'global_group'
  | 'global_default'
export type ToolingExportProtocolTier = 'legacy_unsupported' | 'projection_v1' | 'projection_v1_delta'
export type ToolingRemoteAvailability =
  | 'active'
  | 'unshared'
  | 'permission_blocked'
  | 'provider_unavailable'
  | 'removed'
  | 'stale'
  | 'schema_changed'
  | 'protocol_unsupported'

/** Every authority dimension bound into a recipient-specific Tooling projection. */
export interface ToolingProjectionAuthorityRevision {
  catalog_revision: number
  export_policy_revision: number
  auth_grant_revision: number
  manifest_revision: number
  switch_revision: number
  protocol_revision: number
}

/**
 * Request one page of the authenticated caller's Tooling projection.
 *
 * Deliberately has no peer/provider selector: the authenticated RPC envelope
 * is the only recipient authority.
 */
export interface ToolingGetExportCatalogRequest {
  protocol_tier?: 'projection_v1'
  page_size?: number
  cursor?: string | null
  last_projection_revision?: string | null
  last_projection_digest?: string | null
}

export interface ToolingProjectionRetirement {
  global_tool_id: string
  availability: Extract<ToolingRemoteAvailability, 'unshared' | 'permission_blocked' | 'removed' | 'stale'>
  reason_code: string
  last_schema_hash?: string | null
}

export interface ToolingProjectionBlockedTool {
  tool: ToolingProjectionToolInfo
  reason_code: 'recipient_missing_tool_permissions'
  missing_permissions: string[]
}

/** Wire metadata for an authorized projection member. */
export interface ToolingProjectionToolInfo {
  name: string
  local_name: string
  global_tool_id: string
  tool_id_scheme: 'aurora-tool' | 'legacy'
  tool_id_version: 0 | 1
  tool_contract_id: string
  share_group_id: string
  share_group_label: string
  legacy_global_tool_ids: string[]
  exportable: boolean
  provider_peer_id: string
  provider_service_instance_id: string
  provider_label?: string | null
  provider_granted_permissions?: string[] | null
  provider_available?: boolean | null
  namespace: string
  display_name: string
  aliases: string[]
  description: string
  args_schema: JsonObject
  schema: JsonObject
  argument_visibility: JsonObject
  source_type: 'local' | 'mesh_peer'
  source: 'core' | 'plugin' | 'mcp' | 'mesh_peer' | 'unknown'
  source_id?: string | null
  trust_tier: ToolingTrustTier
  capability_class: ToolingCapabilityClass
  resource_scope: string[]
  execution_location: 'local' | 'remote'
  safety_class: string
  risk_class: string
  data_egress: boolean
  mutating: boolean
  external: boolean
  admin: boolean
  privacy_hints: string[]
  required_permissions: string[]
  confirmation_required: boolean
  rate_limit_hints?: JsonObject | null
  provenance: ToolingToolProvenance
}

export interface ToolingExportCatalogPageBase {
  ok: boolean
  reason_code?: string | null
  provider_peer_id: string
  service_instance_id: string
  selected_protocol_tier: 'projection_v1'
  authority_revision: ToolingProjectionAuthorityRevision
  projection_revision: string
  projection_digest: string
  page_index: number
  page_size: number
  page_hash: string
  tools: ToolingProjectionToolInfo[]
  blocked_tools?: ToolingProjectionBlockedTool[]
  retirements: ToolingProjectionRetirement[]
}

export interface ToolingExportCatalogPartialPage extends ToolingExportCatalogPageBase {
  complete: false
  next_cursor: string
  total_count?: never
  final_checksum?: never
}

export interface ToolingExportCatalogCompletePage extends ToolingExportCatalogPageBase {
  complete: true
  next_cursor?: null
  total_count: number
  final_checksum: string
}

/** A page is non-bindable until a complete snapshot checksum is committed. */
export type ToolingGetExportCatalogResponse =
  | ToolingExportCatalogPartialPage
  | ToolingExportCatalogCompletePage

/** Metadata-only, targeted invalidation. Tool membership must never be added. */
export interface ToolingProjectionInvalidated {
  provider_peer_id: string
  service_instance_id: string
  authority_revision: ToolingProjectionAuthorityRevision
  reason_code: string
  correlation_id: string
}

/** Local refresh status keyed by the provider's stable peer and service IDs. */
export interface ToolingProjectionSyncRequested {
  provider_peer_id: string
  service_instance_id: string
  reason_code: string
  force_full_snapshot: boolean
}

export type ToolingRemoteCatalogSyncState = 'idle' | 'syncing' | 'committed' | 'failed' | 'legacy_stale'
export type ToolingRemoteProviderAvailability = 'active' | 'provider_unavailable' | 'stale' | 'protocol_unsupported'

export interface ToolingRemoteCatalogHeader {
  peer_id: string
  provider_id: string
  service_instance_id: string
  protocol_tier: Exclude<ToolingExportProtocolTier, 'projection_v1_delta'>
  projection_revision?: string | null
  projection_digest?: string | null
  authority_revision: ToolingProjectionAuthorityRevision
  current_generation: number
  sync_state: ToolingRemoteCatalogSyncState
  availability: ToolingRemoteProviderAvailability
  last_error_reason?: string | null
  committed_at?: number | null
  updated_at: number
}

export interface ToolingRemoteCatalogToolStatus {
  peer_id: string
  provider_id: string
  tool: ToolingProjectionToolInfo
  schema_hash: string
  availability: ToolingRemoteAvailability
  reason_code: string
  missing_permissions: string[]
  active_generation?: number | null
  projection_revision?: string | null
  authority_revision: ToolingProjectionAuthorityRevision
  review_required: boolean
  first_seen_at: number
  last_seen_at: number
  updated_at: number
}

export interface ToolingRemoteCatalogStatus {
  headers: ToolingRemoteCatalogHeader[]
  tools: ToolingRemoteCatalogToolStatus[]
  mesh_switches: ToolingMeshKillSwitches
  refresh_required: boolean
  refresh_reason_code?: string | null
  secrets_redacted: boolean
}

export interface ToolingExportPolicy {
  default_state: ToolingExportState
  revision: number
  initialized: boolean
  migrated_from_legacy: boolean
  updated_at?: number | null
}

export interface ToolingExportRule {
  rule_id: string
  peer_id?: string | null
  scope_type: ToolingExportScopeType
  scope_id: string
  state: ToolingExportState
  actor_principal_id: string
  reason: string
  created_at: number
  updated_at: number
}

export interface ToolingMeshKillSwitches {
  provider_mesh_tooling_enabled: boolean
  consumer_mesh_tooling_enabled: boolean
  revision: number
  updated_at?: number | null
  enforcement_active: boolean
}

export interface ToolingExportPrerequisites {
  local_exportable: boolean
  provider_mesh_tooling_enabled?: boolean | null
  consumer_mesh_tooling_enabled?: boolean | null
  service_shared?: boolean | null
  catalog_method_shared?: boolean | null
  prepare_method_shared?: boolean | null
  discovery_method_shared?: boolean | null
  execute_method_shared?: boolean | null
  peer_catalog_rbac?: boolean | null
  peer_prepare_rbac?: boolean | null
  peer_discovery_rbac?: boolean | null
  peer_execute_rbac?: boolean | null
  tool_required_permissions_granted?: boolean | null
  enforcement_active: boolean
  evidence?: ToolingExportPrerequisiteEvidence[]
}

export interface ToolingExportPrerequisiteEvidence {
  key: string
  state: 'satisfied' | 'blocked' | 'unknown' | 'not_applicable'
  source: 'tool_identity' | 'mesh_policy' | 'mesh_switch' | 'peer_authority' | 'runtime' | string
  reason_code: string
  required_permissions?: string[]
  observed_permissions?: string[]
}

export interface ToolingExportDecision {
  effective_state: ToolingExportState
  inherited_from: ToolingExportDecisionSource
  matched_rule_id?: string | null
  peer_id?: string | null
  global_tool_id: string
  share_group_id: string
  exportable: boolean
  stale_tool_id: boolean
  stale_group_id: boolean
  prerequisites: ToolingExportPrerequisites
  policy_revision: number
  reason_code: string
}

export interface ToolingGetToolExportPolicyRequest {
  peer_id?: string | null
  include_rules?: boolean
  include_stale?: boolean
}

export interface ToolingGetToolExportPolicyResponse {
  policy: ToolingExportPolicy
  rules: ToolingExportRule[]
  stale_tool_ids: string[]
  stale_group_ids: string[]
  recipient_scopes?: ToolingExportRecipientScope[]
  protocol_tier: ToolingExportProtocolTier
  mesh_switches: ToolingMeshKillSwitches
  secrets_redacted: boolean
}

export interface ToolingExportRecipientScope {
  peer_id: string
  display_name: string
  stale: boolean
  rule_count: number
  last_rule_updated_at: number
}

export interface ToolingExportMutationRequest {
  state: ToolingExportState
  expected_revision: number
  actor_principal_id: string
  reason: string
  confirmation_text: string
  correlation_id?: string | null
}

export type ToolingSetToolExportDefaultRequest = ToolingExportMutationRequest

export interface ToolingUpsertToolGroupExportPolicyRequest extends ToolingExportMutationRequest {
  share_group_id: string
  peer_id?: string | null
}

export interface ToolingUpsertToolExportOverrideRequest extends ToolingExportMutationRequest {
  global_tool_id: string
  peer_id?: string | null
}

export interface ToolingClearToolExportOverrideRequest {
  scope_type: ToolingExportScopeType
  scope_id: string
  peer_id?: string | null
  expected_revision: number
  actor_principal_id: string
  reason: string
  confirmation_text: string
  correlation_id?: string | null
}

export interface ToolingExportMutationResponse {
  ok: boolean
  policy?: ToolingExportPolicy | null
  rule?: ToolingExportRule | null
  cleared: boolean
  changed: boolean
  audit_id?: string | null
  previous_revision: number
  revision: number
  error?: string | null
  correlation_id?: string | null
}

export type ToolingSetToolExportDefaultResponse = ToolingExportMutationResponse
export type ToolingUpsertToolGroupExportPolicyResponse = ToolingExportMutationResponse
export type ToolingUpsertToolExportOverrideResponse = ToolingExportMutationResponse
export type ToolingClearToolExportOverrideResponse = ToolingExportMutationResponse

export interface ToolingPreviewToolExportDecisionRequest {
  global_tool_id: string
  share_group_id?: string | null
  peer_id?: string | null
}

export interface ToolingPreviewToolExportDecisionResponse {
  decision: ToolingExportDecision
}

export interface ToolingPolicyDecisionResponse {
  allowed: boolean
  share: boolean
  approval_required: boolean
  approval_mode: ToolingApprovalMode
  decision_id: string
  policy_rule_id?: string | null
  reason?: string | null
  auto_approved_reason?: string | null
  effective_default?: ToolingApprovalMode | null
  grant_id?: string | null
  grant_scope?: ToolingApprovalGrantScope | null
  token_ttl_seconds?: number
}

export interface ToolingPrepareExecutionRequest {
  tool_name: string
  arguments: JsonObject
  expected_args_schema_hash?: string | null
  mesh_selector?: JsonObject | null
  resource_selector?: JsonObject | null
  confirmed?: boolean
  approval_token?: string | null
  dry_run?: boolean
  correlation_id?: string | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
  caller_device_id?: string | null
  caller_permissions?: string[] | null
  schedule_id?: string | null
  scheduled_action_hash?: string | null
}

export interface ToolingPrepareExecutionResponse {
  ok: boolean
  policy_decision: ToolingPolicyDecisionResponse
  args_hash: string
  resource_selector_hash: string
  route_decision_id: string
  correlation_id: string
  provider_peer_id: string
  provider_service_instance_id: string
  global_tool_id: string
  local_tool_name: string
  args_schema_hash?: string | null
  source?: ToolingSourceClass
  source_id?: string | null
  trust_tier?: ToolingTrustTier
  capability_class?: ToolingCapabilityClass
  resource_scope?: string[]
  display_args_preview?: JsonObject
  argument_visibility?: Record<string, string>
  secrets_redacted?: boolean
}

export interface ToolingApprovalGrant {
  grant_id: string
  grant_scope: ToolingApprovalGrantScope
  grant_type: 'approval' | 'trust' | 'capability' | 'scheduled_execution' | string
  active: boolean
  principal_id?: string | null
  caller_device_id?: string | null
  caller_peer_id?: string | null
  provider_peer_id?: string | null
  provider_service_instance_id?: string | null
  global_tool_id?: string | null
  local_tool_name?: string | null
  args_hash?: string | null
  resource_selector_hash?: string | null
  route_decision_id?: string | null
  schedule_id?: string | null
  trust_tier?: ToolingTrustTier | null
  capability_class?: ToolingCapabilityClass | null
  resource_scope: string[]
  include_future_tools: boolean
  created_by?: string | null
  created_at: number
  expires_at?: number | null
  revoked_at?: number | null
  reason?: string | null
  metadata?: JsonObject
}

export interface ToolingListApprovalGrantsRequest {
  principal_id?: string | null
  provider_peer_id?: string | null
  global_tool_id?: string | null
  include_revoked?: boolean
}

/** Provider-supplied immutable identity provenance for a Tooling catalog entry. */
export interface ToolingToolProvenance {
  provider_peer_id: string
  provider_service_instance_id: string
  provider_kind?: 'local' | 'mesh_peer' | string
  source?: 'core' | 'plugin' | 'mcp' | 'unknown' | string
  advertised_name: string
  stable_source_id?: string | null
  provider_tool_id?: string | null
  [key: string]: unknown
}

export interface ToolingListApprovalGrantsResponse {
  grants: ToolingApprovalGrant[]
  count: number
}

export interface ToolingCreateApprovalGrantRequest extends Omit<ToolingApprovalGrant, 'grant_id' | 'active' | 'created_at' | 'revoked_at'> {
  active?: boolean
  correlation_id?: string | null
}

export interface ToolingCreateApprovalGrantResponse {
  ok: boolean
  grant?: ToolingApprovalGrant | null
  error?: string | null
  correlation_id?: string | null
}

export interface ToolingRevokeApprovalGrantRequest {
  grant_id: string
  revoked_by?: string | null
  reason?: string | null
  correlation_id?: string | null
}

export interface ToolingRevokeApprovalGrantResponse {
  ok: boolean
  grant_id: string
  error?: string | null
  correlation_id?: string | null
}

export interface ToolingEvaluateApprovalGrantRequest extends ToolingPrepareExecutionRequest {
  schedule_id?: string | null
  scheduled_action_hash?: string | null
  grant_scope?: ToolingApprovalGrantScope | null
}

export interface ToolingEvaluateApprovalGrantResponse {
  ok: boolean
  grant?: ToolingApprovalGrant | null
  policy_decision?: ToolingPolicyDecisionResponse | null
  reason?: string | null
  correlation_id?: string | null
}

export interface ToolingMcpServerStatus {
  name?: string
  id?: string
  command?: string
  url?: string
  status?: string
  active?: boolean
  tool_count?: number
  error?: string | null
  last_error?: string | null
  secrets_redacted?: boolean
  [key: string]: JsonValue | undefined
}

export interface ToolingGetMcpStatusResponse {
  servers: ToolingMcpServerStatus[]
  total_servers: number
  active_servers: number
}

export interface ToolingStatsResponse {
  total_tools: number
  mcp_tools_loaded: number
  core_tools?: number | null
  plugin_tools?: number | null
}

export interface AssistantVoiceListenRequest {
  sessionId?: string | null
  reason?: string | null
  timeoutMs?: number
  routePolicy?: AssistantRoutePolicy | null
}

export interface AssistantVoiceListenResult {
  sessionId: string
  status: 'listening' | 'stopped' | 'unavailable'
  source: 'wakeword' | 'push_to_talk' | 'sdk'
}

export interface STTListenRequest {
  session_id?: string | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
}

export interface STTListenResponse {
  success?: boolean
  status?: string | null
  session_id?: string | null
  current_state?: string | null
  source?: 'wakeword' | 'push_to_talk' | 'sdk' | string | null
  message?: string | null
}

export interface STTStopListeningRequest {
  reason?: string | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
}

export interface TranscribeAudioRequest {
  audio_data: string
  format?: 'wav' | 'raw' | 'mp3' | string
  sample_rate?: number
  channels?: number
  language?: string | null
  model?: 'realtime' | 'accurate' | string
  routePolicy?: AssistantRoutePolicy | null
  mesh_selector?: JsonObject | null
  selector?: JsonObject | null
}

export interface TranscribeAudioResponse {
  text: string
  confidence?: number | null
  language?: string | null
  duration_ms: number
  model_used: string
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
  callable_feature_ids?: string[]
  callable_features?: CallableFeatureContract[]
  speech_constraints?: JsonObject | null
  public_infrastructure?: boolean
  method_type: ContractMethodType
  input_schema?: JsonObject | null
  output_schema?: JsonObject | null
}

export interface CallableFeatureContract {
  feature_id: string
  module: string
  label: string
  summary: string
  method_ids: string[]
}

export interface ModuleRegistryInfo {
  module: string
  version: string
  summary: string
  capabilities: string[]
  callable_features?: CallableFeatureContract[]
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
  pairing_session_id?: string
  verification_code?: string
}

export interface AuthPairingStartResponse {
  code: string
  expires_in_seconds: number
  pairing_session_id?: string
  verification_code?: string
}

export interface AuthPairingConnectRequest {
  code: string
  pairing_session_id?: string
}

export interface AuthPairingConnectResponse {
  request_id: string
  device_name: string
  status: string
  pairing_session_id?: string
  verification_code?: string
}

export interface AuthPairingExchangeRequest {
  code: string
  pairing_session_id?: string
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
  pairing_session_id?: string
  verification_code?: string
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
  callable_features?: CallableFeatureContract[]
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
  pairing_session_id?: string
  verification_code?: string
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

export interface MeshInviteConfigResponse {
  app_id: string
  room: string
  room_password: string
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

/** Stable, payload-free compatibility reasons exposed by mesh diagnostics. */
export type MeshCompatibilityReasonCode =
  | 'provider_not_allowed'
  | 'service_not_shared'
  | 'method_not_shared'
  | 'service_not_advertised'
  | 'method_not_advertised'
  | 'permissions_unknown'
  | 'permission_denied'
  | 'missing_required_features'
  | 'missing_required_capability_tags'
  | 'manifest_projection_stale'
  | 'incompatible_version'
  | 'provider_at_capacity'
  | 'legacy_unverifiable'

/** Stable route-ineligibility reasons, including transient provider availability. */
export type MeshRoutingReasonCode =
  | MeshCompatibilityReasonCode
  | 'provider_unavailable'

export type MeshServiceCompatibilityStatus = 'compatible' | 'incompatible' | 'unused'

export interface ManifestServiceCompatibility {
  service_id: string
  /** Wire ACKs never carry presentation labels. */
  service_label: ''
  status: MeshServiceCompatibilityStatus
  reason_codes: MeshCompatibilityReasonCode[]
  /** Wire ACKs carry stable codes only; public status adds bounded local copy. */
  reason: ''
}

/** Additive manifest ACK contract. Legacy service arrays remain authoritative for old peers. */
export interface ManifestAck {
  compatible_services: string[]
  incompatible_services: string[]
  unused_services: string[]
  active_protocol?: string | null
  active_version?: string | null
  active_tier?: string | null
  protocol_revision?: string | null
  registry_revision?: string | null
  export_policy_revision?: string | null
  auth_grant_revision?: number | null
  projection_digest?: string | null
  services?: ManifestServiceCompatibility[]
}

export interface MeshRevisionDiagnostic {
  active_protocol: string
  active_version: string
  active_tier: string
  protocol_revision: string | null
  registry_revision: string
  export_policy_revision: string
  auth_grant_revision: number | null
  projection_digest: string
}

export interface MeshServiceCompatibilityDiagnostic {
  service_id: string
  service_label: string
  status: MeshServiceCompatibilityStatus
  reason_codes: MeshCompatibilityReasonCode[]
  reason: string
}

export interface MeshPeerCompatibilityDiagnostic {
  local_compatible: string[]
  local_incompatible: string[]
  local_unused: string[]
  remote_compatible: string[]
  remote_incompatible: string[]
  remote_unused: string[]
  /** Present on G009+ gateways; omitted by legacy gateways. */
  local_revision?: MeshRevisionDiagnostic
  remote_revision?: MeshRevisionDiagnostic
  local_services?: MeshServiceCompatibilityDiagnostic[]
  remote_services?: MeshServiceCompatibilityDiagnostic[]
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
  /** Present on G009+ gateways; absent on legacy gateways. */
  reason_code?: MeshCompatibilityReasonCode | ''
  reason: string
}

export interface MeshServiceExportSummary {
  service_id: string
  service_label: string
  shared: boolean
  policy_revision: number
  reason_codes: MeshCompatibilityReasonCode[]
  excluded_method_count: number
  excluded_feature_count: number
}

export interface MeshServiceRoutingSummary {
  service_id: string
  service_label: string
  configured: boolean
  prefer: string
  fallback: string
  policy_revision: number
  eligible_provider_ids: string[]
  ineligible_provider_ids: string[]
  reason_codes: MeshRoutingReasonCode[]
}

export interface MeshStatusResponse {
  local: MeshLocalStatus
  peers: MeshPeerDiagnostic[]
  routes: MeshRouteDiagnostic[]
  compatibility_failures: MeshCompatibilityFailure[]
  /** Independent provider/export view; absent on legacy gateways. */
  export_summaries?: MeshServiceExportSummary[]
  /** Independent consumer/routing view; absent on legacy gateways. */
  routing_summaries?: MeshServiceRoutingSummary[]
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

export interface MeshRolloutPeerMetrics {
  peer_id: string
  manifest_revision: number
  catalog_revision: number
  export_policy_revision: number
  auth_grant_revision: number
  switch_revision: number
  projection_size: number
  last_sync_duration_ms?: number | null
  protocol_status: string
  last_reason_code?: string | null
  counters: Record<string, number>
}

export interface MeshRolloutMetricsSnapshot {
  counters: Record<string, number>
  denied_by_reason: Record<string, number>
  peers: MeshRolloutPeerMetrics[]
  provider_mesh_tooling_enabled?: boolean | null
  consumer_mesh_tooling_enabled?: boolean | null
  rbac_preflight_release_blocking?: boolean | null
  downgrade_status: string
  secrets_redacted: boolean
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
  mesh_rollout: MeshRolloutMetricsSnapshot
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
  callable_features?: CallableFeatureContract[]
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
  callableFeatureIds: string[]
  callableFeatures: CallableFeatureContract[]
  speechConstraints: JsonObject | null
  publicInfrastructure: boolean
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
  callable_feature_ids?: string[]
  callable_features?: CallableFeatureContract[]
  speech_constraints?: JsonObject | null
  public_infrastructure?: boolean
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
  gateway_openapi?: JsonObject
  gateway_openapi_paths?: string[]
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
  | 'offline'
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
  required_callable_feature_ids?: string[]
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
  allowed_provider_peer_ids: string[] | null
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
  peer_id: string | null
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
  callable_feature_ids?: string[]
  callable_features?: CallableFeatureContract[]
  tool_id: string | null
  resource_id: string | null
  provider_id: string
  peer_id: string | null
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
  /** Unified monorepo version reported by the connected server, when provided. */
  aurora_version?: string
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
  peerId: string | null
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
  nodeName?: string | null
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
  /** Aurora version reported by the connected server; null when not provided. */
  serverVersion?: string | null
  secretsRedacted: boolean
  nodes: CapabilityGraphNode[]
  byFeatureId: Record<string, CapabilityGraphNode>
  providerIndex: Record<string, string[]>
  callableFeatureIndex: Record<string, string[]>
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
  provider_kind?: string | null
  upstream_provider_type?: string | null
  provider_peer_id?: string | null
  provider_service_instance_id?: string | null
  default_model_id?: string | null
  models?: ModelRuntimeModelInfo[]
  model_catalog?: JsonObject | null
}

export interface ModelRuntimeModelInfo {
  model_id: string
  display_name: string
  provider_id: string
  provider_kind?: string | null
  upstream_provider_type?: string | null
  source?: string | null
  context_window?: number | null
  generation_limit?: number | null
  capabilities?: string[]
  default?: boolean
  available?: boolean
  metadata?: JsonObject
  secrets_redacted: boolean
}

export interface ModelRuntimeRequest {
  provider_id?: string | null
  include_unavailable?: boolean
}

export interface ModelRuntimeCatalogRequest {
  include_unavailable?: boolean
  include_operations?: boolean
  includeRemote?: boolean
  includeCloudModels?: boolean
  meshSelector?: {
    peerId?: string | null
    providerId?: string | null
    serviceInstanceId?: string | null
    dataScope?: string | null
  } | null
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

export interface RouteExplainSelector {
  peer_id?: string | null
  provider_id?: string | null
  service_instance_id?: string | null
  resource_namespace?: string | null
  tool_id?: string | null
  hardware_target?: string | null
  data_scope?: string | null
}

export interface RouteExplainRequest {
  topic?: string | null
  module?: string | null
  method?: string | null
  selector?: RouteExplainSelector | null
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
  permissionStates?: Record<string, NativeCapabilityManifestState>
  capabilityStates?: Record<string, NativeCapabilityManifestState>
  mobileIntegrations?: NativeMobileIntegration[]
  platformLimitations?: NativePlatformLimitation[]
  iosInvocation?: IOSInvocationStatus | null
  assistantRole?: AndroidAssistantRoleStatus | null
  localLightInference?: AndroidLocalLightInferenceStatus | null
  voiceForegroundService?: AndroidVoiceForegroundServiceStatus | null
  adminUnlock?: AndroidAdminUnlockStatus | null
  secureStorage?: AndroidSecureStorageStatus | null
  fallbackEntrypoints?: AndroidFallbackEntrypoint[]
  release?: AndroidNativeReleaseStatus | null
  entrypoints?: NativeEntrypoint[]
  lastEntrypointPayload?: NativeEntrypointPayload | null
  evidenceSource?: string
  secretsRedacted?: boolean
  platformIntegrations?: NativePlatformIntegration[]
  releaseGates?: NativeReleaseGate[]
  policyNotes?: string[]
  deviceMatrix?: NativeDeviceMatrixRow[]
}

export interface AndroidNativePermissionRequestResult {
  started: boolean
  permission: string
  requestCode?: number
  requestedPermissions?: string[]
  reason?: string
  manifest?: JsonObject
}

export interface AndroidVoiceForegroundServiceStatus {
  platform: 'android' | string
  running: boolean
  startable: boolean
  microphoneGranted: boolean
  notificationsGranted: boolean
  foregroundServiceReady: boolean
  manifestReady: boolean
  state: AndroidNativeState
  reason: string
  privacyClass: PrivacyClass | string
  backendAudioEvidenceRequired: boolean
  /** Native AudioRecord -> Rust ingress is actively accepting bounded PCM chunks. */
  captureActive?: boolean
  /** Redacted native capture backend identifier, when the platform reports one. */
  captureBackend?: string
  sampleRateHz?: number
  acceptedChunks?: number
  acceptedSamples?: number
  droppedChunks?: number
  discontinuities?: number
  queuedChunks?: number
  captureError?: string | null
  evidenceSource: string
  secretsRedacted: boolean
}

export interface AndroidVoiceForegroundServiceRequestResult {
  started?: boolean
  stopped?: boolean
  status: AndroidVoiceForegroundServiceStatus
  reason: string
}

export interface AndroidAdminUnlockStatus {
  platform: 'android' | string
  available: boolean
  requestable: boolean
  deviceSecure: boolean
  biometricReady: boolean
  lastDenied: boolean
  state: AndroidNativeState
  reason: string
  privacyClass: PrivacyClass | string
  evidenceSource: string
  secretsRedacted: boolean
}

export interface AndroidSecureStorageStatus {
  platform: 'android' | string
  available: boolean
  backend: string
  persisted: boolean
  privacyClass: PrivacyClass | string
  allowedKeyPrefixes: string
  evidenceSource: string
  secretsRedacted: boolean
}

export type NativeIntegrationSupport = 'supported' | 'supported-path' | 'planned' | 'pending' | 'unsupported' | 'blocked'

export interface NativeMobileIntegration {
  platform: 'android' | 'ios' | string
  id: string
  label: string
  support: NativeIntegrationSupport
  capability: string
  permission: string | null
  invocation?: 'app-intent' | 'shortcut' | 'widget' | 'share-extension' | 'deep-link' | 'tauri-command' | string
  backendMethod?: string | null
  privacyClass: PrivacyClass
  requiresConfirmation?: boolean
  siriReplacement?: false
  evidenceSource: string
  reason?: string
  userCopy: string
  verifier: string
  publicActionId?: string
}

export interface NativePlatformLimitation {
  platform: 'android' | 'ios' | string
  id: string
  label: string
  reason: string
  userCopy: string
  evidenceSource: string
}

export type NativeCapabilityManifestState =
  | 'available'
  | 'needs_native_permission'
  | 'unsupported_platform'
  | 'degraded'
  | 'pending_native_target'
  | 'fallback'

export type AndroidNativeState = NativeCapabilityManifestState

export interface AndroidAssistantRoleStatus {
  platform: 'android' | string
  roleName: string
  sdkSupportsRole?: boolean
  handlesAssistActivity?: boolean
  declaresVoiceInteractionService?: boolean
  roleAvailable: boolean
  packageQualified: boolean
  roleHeld: boolean
  requestable: boolean
  denied: boolean
  oemUnavailable: boolean
  fallbackAvailable: boolean
  reason: string
  evidenceSource: string
  secretsRedacted: boolean
}

export interface AndroidAssistantRoleRequestResult {
  started: boolean
  requestCode?: number
  status: AndroidAssistantRoleStatus
  reason?: string
}

export interface AndroidLocalLightInferenceStatus {
  platform: 'android' | string
  providerId: string
  available: boolean
  requestable: boolean
  modelRuntimeProvider: boolean
  backendModelCatalogRequired: boolean
  hardwareAcceleration: 'npu' | 'gpu' | 'cpu' | 'unknown' | string
  modelId: string | null
  modelPresent: boolean
  permissionGranted: boolean
  state: AndroidNativeState
  fallbackAvailable: boolean
  fallbackProviderId: string | null
  reason: string
  evidenceSource: string
  secretsRedacted: boolean
}

export interface AndroidFallbackEntrypoint {
  id: string
  state: AndroidNativeState
  available: boolean
  reason: string
  capability?: string
  permission?: string | null
  intentAction?: string | null
  manifestDeclared?: boolean
  backendRequired?: boolean
}

export interface AndroidNativeEntrypoint {
  id: string
  platform: 'android' | string
  label: string
  state: AndroidNativeState
  available: boolean
  capability: string
  permission: string | null
  intentAction: string
  intakeType: string
  manifestDeclared: boolean
  backendRequired: boolean
  payloadCommand: string
  reason: string
}

export interface IOSNativeEntrypoint {
  id: string
  platform: 'ios' | string
  label: string
  state: AndroidNativeState
  available: boolean
  capability: string
  permission: string | null
  intakeType: 'share_extension' | 'deep_link' | 'widget' | 'file_association' | 'app_intent' | string
  urlScheme?: string | null
  universalLinkHost?: string | null
  fileExtensions?: string[]
  xcodeTarget: string
  backendRequired: boolean
  payloadCommand: string
  privacyClass: PrivacyClass
  reason: string
}

export type NativeEntrypoint = AndroidNativeEntrypoint | IOSNativeEntrypoint

export interface AndroidEntrypointPayload {
  source: string
  action: string | null
  type: string | null
  scheme: string | null
  host: string | null
  path: string | null
  categories: string[]
  extras: string[]
  secretsRedacted: boolean
}

export type AndroidReleaseGateStatus = 'passed' | 'blocked' | 'manual' | 'not-run'

export interface AndroidReleaseMatrixRow {
  id: string
  label: string
  mode: 'thin' | 'mesh' | 'assistant-role' | 'fallback'
  apiLevel: number | null
  architecture: string
  expectedState: AndroidNativeState
  status: AndroidReleaseGateStatus
  requiredEvidence: string[]
  actualEvidence: string[]
  notes: string
}

export interface AndroidReleaseSigningStatus {
  aabCommand: string
  apkCommand: string
  signingConfigured: boolean
  signingEvidence: string[]
  playUploadManual: boolean
  notes: string
}

export interface AndroidNativeReleaseStatus {
  signing: AndroidReleaseSigningStatus
  deviceMatrix: AndroidReleaseMatrixRow[]
  smokePayloadRecorded: boolean
  generatedAt: string
}

export interface IOSEntrypointPayload {
  source: string
  invocation: 'share_extension' | 'deep_link' | 'widget' | 'file_association' | 'app_intent' | 'none' | string
  url: string | null
  scheme: string | null
  host: string | null
  path: string | null
  fileExtension: string | null
  uniformTypeIdentifier: string | null
  originatingBundleId: string | null
  sharedItemCount: number
  privacyLabels: PrivacyClass[]
  backendHandoffRequired: boolean
  correlationId: string | null
  secretsRedacted: boolean
}

export type NativeEntrypointPayload = AndroidEntrypointPayload | IOSEntrypointPayload

export interface IOSInvocationStatus {
  platform: 'ios' | string
  appIntentsAvailable: boolean
  shortcutsAvailable: boolean
  shareExtensionAvailable: boolean
  deepLinksAvailable: boolean
  widgetsAvailable: boolean
  fileAssociationsAvailable: boolean
  siriReplacement: false
  backendHandoffRequired: boolean
  privacyLabels: PrivacyClass[]
  state: AndroidNativeState
  reason: string
  evidenceSource: string
  secretsRedacted: boolean
}

export type NativeIntegrationStatus = 'supported' | 'partial' | 'unsupported' | 'deferred' | 'requires-native-target'
export type NativeReleaseGateStatus =
  | 'passed'
  | 'pending'
  | 'blocked'
  | 'requires-macos'
  | 'requires-xcode'
  | 'requires-credentials'
  | 'not-applicable'

export interface NativePlatformIntegration {
  id: string
  label: string
  status: NativeIntegrationStatus
  detail: string
  evidence: string[]
  privacyClass: PrivacyClass
  actions?: Array<{
    id: string
    label: string
    privacyClass: PrivacyClass
    backendMethod: string
    policy: string
  }>
}

export interface NativeReleaseGate {
  id: string
  label: string
  status: NativeReleaseGateStatus
  requiredEvidence: string
  detail: string
  command?: string
  artifact?: string
  privacyClass?: PrivacyClass
}

export interface NativeDeviceMatrixRow {
  id: string
  platform: string
  target: string
  minimumOs: string
  evidence: string
  status: NativeReleaseGateStatus
}
