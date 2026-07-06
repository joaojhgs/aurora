import { AuroraError } from './errors.js'
import { TOOLING_METHODS } from './descriptors.js'
import type { AuroraClient } from './client.js'
import type { AuroraResponse } from './transport.js'
import type {
  AuditLogEntry,
  AuditReceipt,
  JsonObject,
  JsonValue,
  OrchestratorPendingToolApproval,
  ToolingApprovalGrant,
  ToolingApprovalGrantScope,
  ToolingGetMcpStatusResponse,
  ToolingSharingPolicy,
  ToolingSharingPolicyRule
} from './types.js'

export type ToolRiskClass = 'read-only' | 'standard' | 'mutating' | 'external' | 'admin' | 'admin-critical' | string
export type ToolApprovalScope =
  | 'once'
  | 'session'
  | 'peer'
  | 'local-safe-tools'
  | 'feature'
  | 'global'
  | string
export type ToolApprovalState =
  | 'ready'
  | 'provider-selector-required'
  | 'dry-run-only'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'replay-rejected'
  | 'unavailable'
  | 'executing'
  | 'executed'
  | 'failed'

export interface ToolProviderOption {
  id: string
  label: string
  providerPeerId: string | null
  serviceInstanceId: string | null
  providerKind: string
  trustTier: string | null
  transport: string | null
  selectable: boolean
  reason: string
}

export interface ToolCatalogEntry {
  global_tool_id: string
  local_name?: string
  display_name?: string
  description?: string
  provider_id?: string | null
  provider_peer_id?: string | null
  service_instance_id?: string | null
  provider_kind?: string | null
  source?: string | null
  source_id?: string | null
  source_type?: string | null
  provider_label?: string | null
  trust_tier?: string | null
  transport?: string | null
  route_path?: readonly string[] | null
  safety_class?: ToolRiskClass | null
  risk_class?: ToolRiskClass | null
  approval_required?: boolean
  explicit_selector_required?: boolean
  provider_selector_required?: boolean
  data_egress?: boolean
  mutating?: boolean
  admin?: boolean
  method_type?: string | null
  required_permissions?: readonly string[]
  args_schema?: unknown
  args_preview?: unknown
  redacted_args_preview?: unknown
  args_hash?: string | null
  mesh_selector?: unknown
  resource_selector?: unknown
  requested_approval_scope?: ToolApprovalScope | null
  approval_scopes?: readonly ToolApprovalScope[]
  token_ttl_seconds?: number | null
  approval_status?: ToolApprovalState | string | null
  denial_reason?: string | null
  disabled_reason?: string | null
  dry_run_supported?: boolean
  dry_run_required?: boolean
  dry_run_preview?: unknown
  audit_destination?: string | null
  correlation_id?: string | null
  policy_decision_id?: string | null
  approval_request_id?: string | null
  expires_at?: number | string | null
  providers?: readonly ToolProviderOptionLike[]
  result?: ToolExecutionResultLike | null
  secrets_redacted?: boolean
  [key: string]: unknown
}

export interface ToolProviderOptionLike {
  id?: string
  provider_id?: string
  label?: string
  provider_peer_id?: string | null
  service_instance_id?: string | null
  provider_kind?: string | null
  trust_tier?: string | null
  transport?: string | null
  selectable?: boolean
  reason?: string | null
}

export interface ToolExecutionResultLike {
  status?: string
  ok?: boolean
  output_preview?: unknown
  redacted_output_preview?: unknown
  provider_peer_id?: string | null
  correlation_id?: string | null
  audit_receipt?: string | null
  route_path?: readonly string[] | null
  duration_ms?: number | null
  redaction_status?: string | null
  retry_eligible?: boolean
  fallback_eligible?: boolean
  error?: string | null
  [key: string]: unknown
}

export interface ToolCatalogProviderInfo {
  provider_peer_id: string
  provider_service_instance_id: string
  provider_kind?: string | null
  eligible?: boolean
  reason_code?: string | null
  reason?: string | null
  cache_status?: string | null
  [key: string]: unknown
}

export interface ToolCatalogBlockedToolInfo {
  tool: ToolCatalogEntry
  reason_code?: string | null
  reason?: string | null
}

export interface ToolCatalogResponse {
  generated_at?: string | null
  tools: readonly ToolCatalogEntry[]
  blocked_tools?: readonly ToolCatalogBlockedToolInfo[]
  providers?: readonly ToolCatalogProviderInfo[]
  count?: number
  blocked_count?: number
  secrets_redacted?: boolean
}

export interface ToolApprovalCardModel {
  id: string
  name: string
  description: string
  providerLabel: string
  providerPeerId: string | null
  serviceInstanceId: string | null
  providerKind: string
  trustTier: string | null
  transport: string | null
  routePath: string[]
  riskClass: ToolRiskClass
  approvalRequired: boolean
  requiresAdminAction: boolean
  selectorRequired: boolean
  providerSelectorRequired: boolean
  dataEgress: boolean
  mutating: boolean
  requiredPermissions: string[]
  argsSchema: JsonObject | null
  argsPreview: JsonObject | null
  argsHash: string | null
  meshSelector: JsonObject | null
  resourceSelector: JsonObject | null
  approvalScopes: ToolApprovalScope[]
  requestedApprovalScope: ToolApprovalScope | null
  tokenTtlSeconds: number | null
  state: ToolApprovalState
  disabledReason: string | null
  denialReason: string | null
  dryRunSupported: boolean
  dryRunRequired: boolean
  dryRunPreview: JsonObject | null
  auditDestination: string | null
  correlationId: string | null
  policyDecisionId: string | null
  approvalRequestId: string | null
  expiresAt: number | string | null
  providers: ToolProviderOption[]
  result: ToolResultCardModel | null
  secretsRedacted: boolean
  sourceId?: string
  sourceType?: string
  catalogCacheState?: string | null
  newChildCount?: number
  schedulerDependencies?: Array<Record<string, unknown>>
}


export interface ToolResultCardModel {
  status: string
  ok: boolean
  providerPeerId: string | null
  correlationId: string | null
  auditReceipt: string | null
  routePath: string[]
  durationMs: number | null
  redactionStatus: string | null
  retryEligible: boolean
  fallbackEligible: boolean
  outputPreview: JsonObject | null
  error: string | null
}

export interface ToolApprovalDecisionInput {
  tool: ToolApprovalCardModel
  scope: ToolApprovalScope
  approverPrincipalId: string
  reason: string
  selectedProviderId?: string | null
  dryRun?: boolean
}

export interface ToolApprovalDenialInput {
  tool: ToolApprovalCardModel
  approverPrincipalId: string
  reason: string
  scope?: ToolApprovalScope
  selectedProviderId?: string | null | undefined
}

export interface ToolApprovalDecisionResult {
  toolId: string
  approvalRequestId: string | null
  approvalToken: string | null
  correlationId: string | null
  policyDecisionId: string | null
  approved: boolean
  audit: AuditReceipt | null
}

export function normalizeToolCatalog(
  catalog: ToolCatalogResponse,
  options: { transportKind?: string | null } = {}
): ToolApprovalCardModel[] {
  return catalog.tools.map((tool) => normalizeToolEntry(tool, {
    transportKind: options.transportKind ?? null,
    secretsRedacted: catalog.secrets_redacted ?? true
  }))
}

export async function loadToolApprovalCards(client: AuroraClient): Promise<AuroraResponse<ToolApprovalCardModel[]>> {
  const result = await client.requestResult<ToolCatalogResponse>(
    TOOLING_METHODS.listCatalog,
    {},
    { path: '/api/Tooling/GetToolCatalog' }
  )
  if (!result.ok) return result
  return {
    ok: true,
    audit: result.audit,
    data: normalizeToolCatalog(result.data, { transportKind: client.transport.kind })
  }
}

export async function submitToolApprovalDecision(
  client: AuroraClient,
  input: ToolApprovalDecisionInput
): Promise<ToolApprovalDecisionResult> {
  const approval = await requestToolApproval(client, {
    tool: input.tool,
    scope: input.scope,
    selectedProviderId: input.selectedProviderId,
    dryRun: input.dryRun
  })
  if (!approval.approval_request_id) {
    return {
      toolId: input.tool.id,
      approvalRequestId: null,
      approvalToken: null,
      correlationId: approval.correlation_id,
      policyDecisionId: approval.policy_decision.decision_id ?? input.tool.policyDecisionId,
      approved: false,
      audit: null
    }
  }

  const token = await client.approvals.approve({
    approval_request_id: approval.approval_request_id,
    approver_principal_id: input.approverPrincipalId,
    grant_scope: grantScopeForApproval(input.scope, input.dryRun),
    include_future_tools: includeFutureToolsForApproval(input.scope),
    reason: input.reason,
    correlation_id: approval.correlation_id
  })
  return {
    toolId: input.tool.id,
    approvalRequestId: approval.approval_request_id,
    approvalToken: token.approvalToken,
    correlationId: token.correlationId ?? approval.correlation_id,
    policyDecisionId: token.policyDecisionId ?? approval.policy_decision.decision_id ?? input.tool.policyDecisionId,
    approved: true,
    audit: null
  }
}

export async function submitToolDenialDecision(
  client: AuroraClient,
  input: ToolApprovalDenialInput
): Promise<ToolApprovalDecisionResult> {
  const approval = input.tool.approvalRequestId
    ? null
    : await requestToolApproval(client, {
      tool: input.tool,
      scope: input.tool.requestedApprovalScope ?? 'once',
      selectedProviderId: input.selectedProviderId,
      dryRun: input.tool.dryRunRequired
    })
  const approvalRequestId = input.tool.approvalRequestId ?? approval?.approval_request_id ?? null
  if (!approvalRequestId) {
    throw new AuroraError({
      code: 'validation',
      message: 'A backend approval request ID is required before this tool can be denied.',
      method: TOOLING_METHODS.confirmExecution,
      correlationId: input.tool.correlationId ?? approval?.correlation_id ?? undefined,
      detail: { toolId: input.tool.id }
    })
  }

  const confirmation = await client.approvals.confirm({
    approval_request_id: approvalRequestId,
    approver_principal_id: input.approverPrincipalId,
    approve: false,
    grant_scope: denialGrantScope(input.scope),
    reason: input.reason,
    correlation_id: input.tool.correlationId ?? approval?.correlation_id ?? null
  })
  return {
    toolId: input.tool.id,
    approvalRequestId,
    approvalToken: confirmation.approval_token,
    correlationId: confirmation.correlation_id ?? input.tool.correlationId ?? approval?.correlation_id ?? null,
    policyDecisionId: confirmation.policy_decision_id ?? approval?.policy_decision.decision_id ?? input.tool.policyDecisionId,
    approved: false,
    audit: null
  }
}

function grantScopeForApproval(scope: ToolApprovalScope, dryRun?: boolean): ToolingApprovalGrantScope {
  if (dryRun) return 'once'
  if (scope === 'session') return 'session'
  if (scope === 'peer' || scope === 'local-safe-tools' || scope === 'feature' || scope === 'global') return 'always'
  return 'once'
}

function includeFutureToolsForApproval(scope: ToolApprovalScope): boolean {
  return scope === 'peer' || scope === 'local-safe-tools' || scope === 'global'
}

function denialGrantScope(scope?: ToolApprovalScope): ToolingApprovalGrantScope {
  if (scope === 'global' || scope === 'peer') return 'deny_always'
  return 'deny_once'
}

async function requestToolApproval(
  client: AuroraClient,
  input: {
    tool: ToolApprovalCardModel
    scope: ToolApprovalScope
    selectedProviderId?: string | null | undefined
    dryRun?: boolean | undefined
  }
) {
  const selectedProvider = selectedToolProvider(input.tool, input.selectedProviderId)
  if (input.tool.providerSelectorRequired && !selectedProvider) {
    throw new AuroraError({
      code: 'validation',
      message: 'A backend-accepted provider selector is required before this tool can be approved.',
      method: TOOLING_METHODS.requestApproval,
      detail: { toolId: input.tool.id }
    })
  }

  return client.approvals.request({
    global_tool_id: input.tool.id,
    provider_peer_id: selectedProvider?.providerPeerId ?? input.tool.providerPeerId,
    provider_service_instance_id: selectedProvider?.serviceInstanceId ?? input.tool.serviceInstanceId,
    mesh_selector: input.tool.meshSelector,
    resource_selector: input.tool.resourceSelector,
    args_hash: input.tool.argsHash,
    redacted_args_preview: input.tool.argsPreview,
    risk_class: input.tool.riskClass,
    requested_approval_scope: input.scope,
    expected_audit_event: input.tool.auditDestination,
    dry_run: input.dryRun ?? input.tool.dryRunRequired
  })
}

function selectedToolProvider(tool: ToolApprovalCardModel, selectedProviderId: string | null | undefined) {
  if (selectedProviderId !== undefined && selectedProviderId !== null) {
    return tool.providers.find((provider) => provider.id === selectedProviderId)
  }
  return tool.providers.find((provider) => provider.selectable) ?? tool.providers[0]
}

function normalizeToolEntry(
  tool: ToolCatalogEntry,
  context: { transportKind: string | null; secretsRedacted: boolean }
): ToolApprovalCardModel {
  const providers = normalizeProviders(tool)
  const riskClass = tool.risk_class ?? tool.safety_class ?? fallbackRiskClass(tool)
  const provider = providers.find((candidate) => candidate.selectable) ?? providers[0]
  const sourceKind = sourceKindFromToolEntry(tool, provider)
  const explicitSelector = Boolean(tool.explicit_selector_required)
  const providerSelectorRequired = Boolean(tool.provider_selector_required) || (explicitSelector && providers.length > 1)
  const approvalRequired = Boolean(tool.approval_required) || isDangerousRisk(riskClass)
  const methodType = tool.method_type ?? null
  const requiresAdminAction = methodType === 'manage' || tool.admin === true || riskClass === 'admin' || riskClass === 'admin-critical'
  return {
    id: tool.global_tool_id,
    name: tool.display_name ?? tool.local_name ?? tool.global_tool_id,
    description: tool.description ?? 'Tool metadata is available from the backend catalog.',
    providerLabel: tool.provider_label ?? provider?.label ?? 'provider pending',
    providerPeerId: tool.provider_peer_id ?? provider?.providerPeerId ?? null,
    serviceInstanceId: tool.service_instance_id ?? provider?.serviceInstanceId ?? null,
    providerKind: tool.provider_kind ?? provider?.providerKind ?? 'local',
    trustTier: tool.trust_tier ?? provider?.trustTier ?? null,
    transport: tool.transport ?? provider?.transport ?? context.transportKind,
    routePath: stringList(tool.route_path),
    riskClass,
    approvalRequired,
    requiresAdminAction,
    selectorRequired: explicitSelector,
    providerSelectorRequired,
    dataEgress: Boolean(tool.data_egress),
    mutating: Boolean(tool.mutating) || requiresAdminAction || isDangerousRisk(riskClass),
    requiredPermissions: [...(tool.required_permissions ?? [])],
    argsSchema: objectOrNull(tool.args_schema),
    argsPreview: safePreviewObject(tool.redacted_args_preview, tool.args_preview, tool.secrets_redacted ?? context.secretsRedacted),
    argsHash: tool.args_hash ?? null,
    meshSelector: objectOrNull(tool.mesh_selector),
    resourceSelector: objectOrNull(tool.resource_selector),
    approvalScopes: [...(tool.approval_scopes ?? defaultScopesForTool(riskClass, tool.provider_kind ?? provider?.providerKind))],
    requestedApprovalScope: tool.requested_approval_scope ?? null,
    tokenTtlSeconds: tool.token_ttl_seconds ?? null,
    state: normalizeToolState(tool),
    disabledReason: tool.disabled_reason ?? null,
    denialReason: tool.denial_reason ?? null,
    dryRunSupported: Boolean(tool.dry_run_supported ?? tool.dry_run_required),
    dryRunRequired: Boolean(tool.dry_run_required),
    dryRunPreview: safePreviewObject(tool.redacted_dry_run_preview, tool.dry_run_preview, tool.secrets_redacted ?? context.secretsRedacted),
    auditDestination: tool.audit_destination ?? null,
    correlationId: tool.correlation_id ?? null,
    policyDecisionId: tool.policy_decision_id ?? null,
    approvalRequestId: tool.approval_request_id ?? null,
    expiresAt: tool.expires_at ?? null,
    providers,
    result: tool.result ? normalizeToolResult(tool.result) : null,
    secretsRedacted: tool.secrets_redacted ?? context.secretsRedacted,
    sourceId: tool.source_id ?? sourceIdFromParts(sourceKind, tool.provider_peer_id ?? provider?.providerPeerId ?? null, tool.service_instance_id ?? provider?.serviceInstanceId ?? null, tool.provider_label ?? provider?.label ?? null),
    sourceType: sourceKind
  }
}

function fallbackRiskClass(tool: ToolCatalogEntry): ToolRiskClass {
  if (tool.admin) return 'admin'
  if (tool.mutating) return 'mutating'
  return 'standard'
}

function sourceKindFromToolEntry(tool: ToolCatalogEntry, provider: ToolProviderOption | undefined): ToolSourceKind {
  const explicit = String(tool.source ?? '').toLowerCase()
  if (explicit === 'core' || explicit === 'mcp' || explicit === 'plugin' || explicit === 'unknown') return explicit
  if (explicit === 'mesh_peer' || explicit === 'mesh') return 'mesh_peer'
  const sourceType = String(tool.source_type ?? '').toLowerCase()
  if (sourceType === 'mesh_peer' || sourceType === 'mesh') return 'mesh_peer'
  return sourceKindFromProviderKind(tool.provider_kind ?? provider?.providerKind ?? tool.transport ?? tool.provider_label)
}

function normalizeProviders(tool: ToolCatalogEntry): ToolProviderOption[] {
  const raw = tool.providers ?? []
  if (raw.length === 0) {
    return [
      {
        id: tool.provider_id ?? tool.provider_peer_id ?? 'local',
        label: tool.provider_label ?? tool.provider_id ?? tool.provider_peer_id ?? 'local provider',
        providerPeerId: tool.provider_peer_id ?? null,
        serviceInstanceId: tool.service_instance_id ?? null,
        providerKind: tool.provider_kind ?? 'local',
        trustTier: tool.trust_tier ?? null,
        transport: tool.transport ?? null,
        selectable: !tool.disabled_reason,
        reason: tool.disabled_reason ?? 'catalog provider'
      }
    ]
  }
  return raw.map((provider, index) => ({
    id: provider.id ?? provider.provider_id ?? `provider-${index}`,
    label: provider.label ?? provider.provider_id ?? provider.provider_peer_id ?? `provider ${index + 1}`,
    providerPeerId: provider.provider_peer_id ?? null,
    serviceInstanceId: provider.service_instance_id ?? null,
    providerKind: provider.provider_kind ?? 'local',
    trustTier: provider.trust_tier ?? null,
    transport: provider.transport ?? null,
    selectable: provider.selectable ?? true,
    reason: provider.reason ?? 'catalog provider'
  }))
}

function normalizeToolResult(result: ToolExecutionResultLike): ToolResultCardModel {
  const status = result.status ?? (result.ok === false ? 'failed' : 'success')
  return {
    status,
    ok: result.ok ?? !['failed', 'denied'].includes(status),
    providerPeerId: result.provider_peer_id ?? null,
    correlationId: result.correlation_id ?? null,
    auditReceipt: result.audit_receipt ?? null,
    routePath: stringList(result.route_path),
    durationMs: result.duration_ms ?? null,
    redactionStatus: result.redaction_status ?? null,
    retryEligible: Boolean(result.retry_eligible),
    fallbackEligible: Boolean(result.fallback_eligible),
    outputPreview: objectOrNull(result.redacted_output_preview ?? result.output_preview),
    error: result.error ?? null
  }
}

function normalizeToolState(tool: ToolCatalogEntry): ToolApprovalState {
  if (tool.disabled_reason) return 'unavailable'
  const status = tool.approval_status
  if (status === 'replay_rejected') return 'replay-rejected'
  if (status === 'dry_run_only') return 'dry-run-only'
  if (status === 'provider_selector_required') return 'provider-selector-required'
  if (typeof status === 'string' && isToolApprovalState(status)) return status
  if (tool.provider_selector_required) return 'provider-selector-required'
  if (tool.dry_run_required) return 'dry-run-only'
  if (tool.result) return 'executed'
  return 'ready'
}

function isToolApprovalState(value: string): value is ToolApprovalState {
  return [
    'ready',
    'provider-selector-required',
    'dry-run-only',
    'approved',
    'denied',
    'expired',
    'replay-rejected',
    'unavailable',
    'executing',
    'executed',
    'failed'
  ].includes(value)
}

function defaultScopesForTool(riskClass: string, providerKind: string | null | undefined): ToolApprovalScope[] {
  if (riskClass === 'read-only' || riskClass === 'standard') return ['once', 'session']
  if (providerKind === 'local') return ['once', 'session', 'local-safe-tools']
  return ['once', 'session', 'peer']
}

function isDangerousRisk(riskClass: string): boolean {
  return ['mutating', 'external', 'admin', 'admin-critical'].includes(riskClass)
}

function objectOrNull(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function safePreviewObject(redactedValue: unknown, rawValue: unknown, sourceSecretsRedacted: boolean): JsonObject | null {
  const explicitRedacted = objectOrNull(redactedValue)
  if (explicitRedacted) return redactObject(explicitRedacted)
  const raw = objectOrNull(rawValue)
  if (!raw) return null
  return sourceSecretsRedacted ? redactObject(raw) : { redacted: true, secrets_redacted: true }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export type ToolSourceKind = 'core' | 'mcp' | 'plugin' | 'mesh_peer' | 'unknown' | 'blocked' | string
export type ToolSourceStatus = 'active' | 'blocked' | 'stale' | 'removed' | 'unshared' | 'needs-review' | 'unknown' | string
export type ToolGrantStatus = 'active' | 'expired' | 'revoked' | 'stale' | 'needs-review'
export type ToolOnboardingKind = 'mcp' | 'plugin'

export interface ToolingPolicySummaryModel {
  mode: string
  defaultApprovalMode: string
  defaultShare: boolean
  defaultTokenTtlSeconds: number
  dryRunOnly: boolean
  denyAll: boolean
  unrestrictedExceptBlocked: boolean
  ruleCount: number
  activeGrantCount: number
  pendingApprovalCount: number
  sourceCount: number
  blockedSourceCount: number
  blockedToolCount: number
  toolCount: number
  mcpServerCount: number
  activeMcpServerCount: number
  lastPolicyChangeActor: string | null
  lastPolicyChangeAt: string | null
  lastPolicyCorrelationId: string | null
  secretsRedacted: boolean
}

export interface ToolPolicyOverrideModel {
  id: string
  targetKind: 'source' | 'tool' | 'provider' | 'resource' | 'unknown'
  sourceId: string | null
  toolId: string | null
  providerPeerId: string | null
  providerServiceInstanceId: string | null
  sourceType: string | null
  approvalMode: string
  share: boolean
  trustTier: string | null
  includeFutureTools: boolean
  tokenTtlSeconds: number | null
  rawRule: ToolingSharingPolicyRule
}

export interface ToolApprovalGrantModel {
  id: string
  scope: string
  type: string
  status: ToolGrantStatus
  active: boolean
  principalId: string | null
  callerDeviceId: string | null
  callerPeerId: string | null
  providerPeerId: string | null
  providerServiceInstanceId: string | null
  toolId: string | null
  localToolName: string | null
  argsHash: string | null
  scheduleId: string | null
  trustTier: string | null
  capabilityClass: string | null
  resourceScope: string[]
  includeFutureTools: boolean
  createdBy: string | null
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
  reason: string | null
  metadata: JsonObject
  secretsRedacted: boolean
  raw: ToolingApprovalGrant
}

export interface ToolPendingApprovalModel {
  id: string
  approvalRequestId: string | null
  status: string
  runId: string
  threadId: string
  sessionId: string | null
  ownerPrincipalId: string | null
  ownerPeerId: string | null
  messageId: string
  toolCallId: string
  toolName: string
  displayName: string
  argumentsPreview: JsonObject
  policyDecisionId: string | null
  correlationId: string | null
  createdAt: number
  expiresAt: number | null
  metadata: JsonObject
  inlineAssistantOnly: true
  secretsRedacted: boolean
}

export interface ToolPolicyAuditEventModel {
  id: string
  event: string
  action: string | null
  principalId: string | null
  correlationId: string | null
  peerId: string | null
  providerId: string | null
  toolId: string | null
  policyDecisionId: string | null
  route: string | null
  createdAt: string | null
  details: JsonObject
  secretsRedacted: boolean
  raw: AuditLogEntry
}

export interface ToolSourceSummaryModel {
  id: string
  kind: ToolSourceKind
  label: string
  providerPeerId: string | null
  providerServiceInstanceId: string | null
  providerKind: string | null
  transport: string | null
  trustTier: string | null
  status: ToolSourceStatus
  toolCount: number
  blockedToolCount: number
  approvalRequiredCount: number
  newOrReviewCount: number
  activeGrantCount: number
  staleGrantCount: number
  includeFutureTools: boolean
  cacheStatus: string | null
  catalogEpoch: number | null
  catalogHash: string | null
  generatedAt: string | null
  lastAnnouncementAt: string | null
  secretsRedacted: boolean
  sourceId?: string
  sourceType?: string
  catalogCacheState?: string | null
  newChildCount?: number
  schedulerDependencies?: Array<Record<string, unknown>>
}

export interface ToolSourceDetailModel {
  source: ToolSourceSummaryModel
  tools: ToolApprovalCardModel[]
  blockedTools: ToolApprovalCardModel[]
  grants: ToolApprovalGrantModel[]
  overrides: ToolPolicyOverrideModel[]
  pendingApprovals: ToolPendingApprovalModel[]
  auditEvents: ToolPolicyAuditEventModel[]
  mcpServers: ToolingGetMcpStatusResponse['servers']
  secretsRedacted: boolean
}

export interface ToolingPageViewModel {
  policy: ToolingPolicySummaryModel
  sources: ToolSourceSummaryModel[]
  grants: ToolApprovalGrantModel[]
  pendingApprovals: ToolPendingApprovalModel[]
  auditEvents: ToolPolicyAuditEventModel[]
  mcpStatus: ToolingGetMcpStatusResponse | null
  generatedAt: string | null
  fixtureMode: boolean
  secretsRedacted: boolean
}

export interface McpSourceWizardDraft {
  name: string
  command?: string | null
  args?: string[]
  env?: Record<string, string | undefined>
  url?: string | null
  transport?: string | null
  trustTier?: string | null
  includeFutureTools?: boolean
  reason?: string | null
}

export interface PluginSourceWizardDraft {
  packageName: string
  pluginId?: string | null
  version?: string | null
  sourceUrl?: string | null
  trustTier?: string | null
  includeFutureTools?: boolean
  reason?: string | null
  metadata?: JsonObject
}

export interface ToolOnboardingValidationResult {
  kind: ToolOnboardingKind
  ok: boolean
  supported: boolean
  status: 'valid' | 'invalid' | 'unsupported'
  redactedPreview: JsonObject
  errors: string[]
  secretsRedacted: boolean
}

export interface ToolingViewInput {
  catalog: ToolCatalogResponse
  policy?: ToolingSharingPolicy | null
  grants?: readonly ToolingApprovalGrant[] | readonly ToolApprovalGrantModel[] | null
  pendingApprovals?: readonly OrchestratorPendingToolApproval[] | readonly ToolPendingApprovalModel[] | null
  auditEvents?: readonly AuditLogEntry[] | readonly ToolPolicyAuditEventModel[] | null
  mcpStatus?: ToolingGetMcpStatusResponse | null
  transportKind?: string | null
  fixtureMode?: boolean
}

export function buildToolingPageView(input: ToolingViewInput): ToolingPageViewModel {
  const cards = normalizeToolCatalog(input.catalog, { transportKind: input.transportKind ?? null })
  const blockedTools = normalizeBlockedTools(input.catalog, input.transportKind ?? null)
  const grants = normalizeToolGrants(input.grants ?? [])
  const pendingApprovals = normalizePendingApprovals(input.pendingApprovals ?? [])
  const auditEvents = normalizePolicyAuditEvents(input.auditEvents ?? [])
  const overrides = normalizePolicyOverrides(input.policy)
  const sources = buildToolSources(cards, blockedTools, grants, overrides, input.catalog, input.mcpStatus)
  return {
    policy: buildPolicySummary({
      policy: input.policy ?? null,
      grants,
      pendingApprovals,
      auditEvents,
      sources,
      catalog: input.catalog,
      mcpStatus: input.mcpStatus ?? null
    }),
    sources,
    grants,
    pendingApprovals,
    auditEvents,
    mcpStatus: input.mcpStatus ?? null,
    generatedAt: input.catalog.generated_at ?? null,
    fixtureMode: Boolean(input.fixtureMode),
    secretsRedacted: input.catalog.secrets_redacted ?? true
  }
}

export function getToolSourceDetailFromView(view: ToolingPageViewModel, sourceId: string, catalog: ToolCatalogResponse): ToolSourceDetailModel | null {
  const source = view.sources.find((candidate) => candidate.id === sourceId)
  if (!source) return null
  const cards = normalizeToolCatalog(catalog)
  const blockedTools = normalizeBlockedTools(catalog, null)
  const matches = (tool: ToolApprovalCardModel) => sourceIdForTool(tool) === sourceId
  return {
    source,
    tools: cards.filter(matches),
    blockedTools: blockedTools.filter(matches),
    grants: view.grants.filter((grant) => grantSourceId(grant) === sourceId || (grant.toolId ? cards.some((tool) => tool.id === grant.toolId && matches(tool)) : false)),
    overrides: [],
    pendingApprovals: view.pendingApprovals.filter((approval) => cards.some((tool) => tool.id === approval.toolName || tool.name === approval.toolName)),
    auditEvents: view.auditEvents.filter((event) => !event.toolId || cards.some((tool) => tool.id === event.toolId && matches(tool))),
    mcpServers: view.mcpStatus?.servers.filter((server) => mcpServerSourceId(server) === sourceId) ?? [],
    secretsRedacted: source.secretsRedacted && view.secretsRedacted
  }
}

export function normalizeToolGrants(grants: readonly (ToolingApprovalGrant | ToolApprovalGrantModel)[]): ToolApprovalGrantModel[] {
  return grants.map((grant) => isGrantModel(grant) ? grant : normalizeToolGrant(grant))
}

export function normalizePendingApprovals(approvals: readonly (OrchestratorPendingToolApproval | ToolPendingApprovalModel)[]): ToolPendingApprovalModel[] {
  return approvals.map((approval) => 'inlineAssistantOnly' in approval ? approval : {
    id: approval.pending_id,
    approvalRequestId: approval.approval_request_id ?? null,
    status: approval.status,
    runId: approval.run_id,
    threadId: approval.thread_id,
    sessionId: approval.session_id ?? null,
    ownerPrincipalId: approval.owner_principal_id ?? null,
    ownerPeerId: approval.owner_peer_id ?? null,
    messageId: approval.message_id,
    toolCallId: approval.tool_call_id,
    toolName: approval.tool_name,
    displayName: approval.display_name ?? approval.tool_name,
    argumentsPreview: objectOrEmpty(approval.arguments_preview),
    policyDecisionId: approval.policy_decision_id ?? null,
    correlationId: approval.correlation_id ?? null,
    createdAt: approval.created_at,
    expiresAt: approval.expires_at ?? null,
    metadata: objectOrEmpty(approval.metadata),
    inlineAssistantOnly: true,
    secretsRedacted: true
  })
}

export function normalizePolicyAuditEvents(events: readonly (AuditLogEntry | ToolPolicyAuditEventModel)[]): ToolPolicyAuditEventModel[] {
  return events.map((event) => isPolicyAuditEventModel(event) ? event : normalizePolicyAuditEvent(event))
}

export function normalizePolicyOverrides(policy: ToolingSharingPolicy | null | undefined): ToolPolicyOverrideModel[] {
  return (policy?.rules ?? []).map((rule) => {
    const targetKind = policyOverrideTargetKind(rule)
    const sourceId = sourceIdFromParts(rule.source_type ?? null, rule.provider_peer_id ?? null, rule.provider_service_instance_id ?? null, rule.toolkit_name ?? null)
    return {
      id: rule.rule_id,
      targetKind,
      sourceId,
      toolId: rule.global_tool_id ?? rule.tool_name ?? null,
      providerPeerId: rule.provider_peer_id ?? null,
      providerServiceInstanceId: rule.provider_service_instance_id ?? null,
      sourceType: rule.source_type ?? null,
      approvalMode: rule.approval_mode ?? 'ask_each_time',
      share: rule.share ?? true,
      trustTier: rule.share === false ? 'blocked' : null,
      includeFutureTools: !rule.global_tool_id && !rule.tool_name,
      tokenTtlSeconds: rule.token_ttl_seconds ?? null,
      rawRule: rule
    }
  })
}

function policyOverrideTargetKind(rule: ToolingSharingPolicyRule): ToolPolicyOverrideModel['targetKind'] {
  if (rule.global_tool_id || rule.tool_name) return 'tool'
  if (rule.provider_peer_id || rule.provider_service_instance_id) return 'provider'
  if (rule.source_type) return 'source'
  return 'unknown'
}

export function validateMcpSourceDraft(draft: McpSourceWizardDraft): ToolOnboardingValidationResult {
  const errors: string[] = []
  if (!String(draft.name ?? '').trim()) errors.push('name_required')
  if (!draft.command && !draft.url) errors.push('command_or_url_required')
  return {
    kind: 'mcp',
    ok: false,
    supported: false,
    status: errors.length === 0 ? 'unsupported' : 'invalid',
    redactedPreview: redactObject({ ...draft, source_id: `local:mcp:${safeSourceSegment(String(draft.name ?? 'default'))}`, env: redactObject(draft.env ?? {}) }),
    errors,
    secretsRedacted: true
  }
}

export function validatePluginSourceDraft(draft: PluginSourceWizardDraft): ToolOnboardingValidationResult {
  const errors: string[] = []
  if (!String(draft.packageName ?? '').trim()) errors.push('package_name_required')
  return {
    kind: 'plugin',
    ok: false,
    supported: false,
    status: errors.length === 0 ? 'unsupported' : 'invalid',
    redactedPreview: redactObject({ ...(draft as unknown as JsonObject), source_id: `local:plugin:${safeSourceSegment(String(draft.pluginId ?? draft.packageName ?? 'default'))}` }),
    errors,
    secretsRedacted: true
  }
}

function normalizeToolGrant(grant: ToolingApprovalGrant): ToolApprovalGrantModel {
  const nowSeconds = Date.now() / 1000
  const status = grantStatus(grant, nowSeconds)
  return {
    id: grant.grant_id,
    scope: grant.grant_scope,
    type: grant.grant_type,
    status,
    active: grant.active,
    principalId: grant.principal_id ?? null,
    callerDeviceId: grant.caller_device_id ?? null,
    callerPeerId: grant.caller_peer_id ?? null,
    providerPeerId: grant.provider_peer_id ?? null,
    providerServiceInstanceId: grant.provider_service_instance_id ?? null,
    toolId: grant.global_tool_id ?? null,
    localToolName: grant.local_tool_name ?? null,
    argsHash: grant.args_hash ?? null,
    scheduleId: grant.schedule_id ?? null,
    trustTier: grant.trust_tier ?? null,
    capabilityClass: grant.capability_class ?? null,
    resourceScope: [...(grant.resource_scope ?? [])],
    includeFutureTools: Boolean(grant.include_future_tools),
    createdBy: grant.created_by ?? null,
    createdAt: grant.created_at,
    expiresAt: grant.expires_at ?? null,
    revokedAt: grant.revoked_at ?? null,
    reason: grant.reason ?? null,
    metadata: objectOrEmpty(grant.metadata),
    secretsRedacted: metadataSecretsRedacted(grant.metadata),
    raw: grant
  }
}

function grantStatus(grant: ToolingApprovalGrant, nowSeconds: number): ToolGrantStatus {
  if (grant.revoked_at || !grant.active) return 'revoked'
  if (grant.expires_at && grant.expires_at <= nowSeconds) return 'expired'
  if (grant.include_future_tools && !grant.trust_tier) return 'needs-review'
  return 'active'
}

function isPolicyAuditEventModel(event: AuditLogEntry | ToolPolicyAuditEventModel): event is ToolPolicyAuditEventModel {
  return 'secretsRedacted' in event && 'principalId' in event
}

function normalizePolicyAuditEvent(event: AuditLogEntry): ToolPolicyAuditEventModel {
  const details = parseDetails(event.details)
  return {
    id: event.id ?? event.correlation_id ?? 'audit-event',
    event: event.event ?? 'unknown',
    action: event.action ?? null,
    principalId: event.principal_id ?? null,
    correlationId: event.correlation_id ?? null,
    peerId: event.peer_id ?? null,
    providerId: event.provider_id ?? null,
    toolId: event.tool_id ?? stringOrNull(details.global_tool_id),
    policyDecisionId: event.policy_decision_id ?? stringOrNull(details.policy_decision_id),
    route: event.route ?? stringOrNull(details.route_path),
    createdAt: event.created_at ?? null,
    details: redactObject(details),
    secretsRedacted: details.secrets_redacted !== false,
    raw: event
  }
}

function buildPolicySummary(input: {
  policy: ToolingSharingPolicy | null
  grants: ToolApprovalGrantModel[]
  pendingApprovals: ToolPendingApprovalModel[]
  auditEvents: ToolPolicyAuditEventModel[]
  sources: ToolSourceSummaryModel[]
  catalog: ToolCatalogResponse
  mcpStatus: ToolingGetMcpStatusResponse | null
}): ToolingPolicySummaryModel {
  const policy = input.policy
  const lastPolicy = input.auditEvents.find((event) => event.event.startsWith('tooling.policy') || event.action === TOOLING_METHODS.setSharingPolicy)
  const mode = policy?.policy_mode ?? 'enforce'
  return {
    mode,
    defaultApprovalMode: policy?.default_approval_mode ?? 'approve_all_local_safe',
    defaultShare: policy?.default_share ?? true,
    defaultTokenTtlSeconds: policy?.default_token_ttl_seconds ?? 300,
    dryRunOnly: mode === 'dry_run_only',
    denyAll: mode === 'deny_all',
    unrestrictedExceptBlocked: mode === 'unrestricted_except_blocked',
    ruleCount: policy?.rules.length ?? 0,
    activeGrantCount: input.grants.filter((grant) => grant.status === 'active').length,
    pendingApprovalCount: input.pendingApprovals.filter((approval) => approval.status === 'pending').length,
    sourceCount: input.sources.length,
    blockedSourceCount: input.sources.filter((source) => source.status === 'blocked' || source.trustTier === 'blocked').length,
    blockedToolCount: input.catalog.blocked_count ?? input.catalog.blocked_tools?.length ?? 0,
    toolCount: input.catalog.tools.length,
    mcpServerCount: input.mcpStatus?.total_servers ?? 0,
    activeMcpServerCount: input.mcpStatus?.active_servers ?? 0,
    lastPolicyChangeActor: lastPolicy?.principalId ?? null,
    lastPolicyChangeAt: lastPolicy?.createdAt ?? null,
    lastPolicyCorrelationId: lastPolicy?.correlationId ?? null,
    secretsRedacted: input.catalog.secrets_redacted ?? true
  }
}

function buildToolSources(
  tools: ToolApprovalCardModel[],
  blockedTools: ToolApprovalCardModel[],
  grants: ToolApprovalGrantModel[],
  overrides: ToolPolicyOverrideModel[],
  catalog: ToolCatalogResponse,
  mcpStatus: ToolingGetMcpStatusResponse | null | undefined
): ToolSourceSummaryModel[] {
  const grouped = new Map<string, { tools: ToolApprovalCardModel[]; blocked: ToolApprovalCardModel[] }>()
  for (const tool of tools) addGroupedTool(grouped, tool, false)
  for (const tool of blockedTools) addGroupedTool(grouped, tool, true)
  const summaries = [...grouped.entries()].map(([id, group]) => sourceSummaryFromGroup(id, group.tools, group.blocked, grants, overrides, catalog))
  for (const server of mcpStatus?.servers ?? []) {
    const id = mcpServerSourceId(server)
    if (!summaries.some((source) => source.id === id)) {
      summaries.push({
        id,
        kind: 'mcp',
        label: String(server.name ?? server.id ?? id),
        providerPeerId: null,
        providerServiceInstanceId: typeof server.id === 'string' ? server.id : null,
        providerKind: 'mcp',
        transport: typeof server.transport === 'string' ? server.transport : 'mcp',
        trustTier: null,
        status: server.active === false ? 'stale' : 'active',
        toolCount: typeof server.tool_count === 'number' ? server.tool_count : 0,
        blockedToolCount: 0,
        approvalRequiredCount: 0,
        newOrReviewCount: 0,
        activeGrantCount: 0,
        staleGrantCount: 0,
        includeFutureTools: false,
        cacheStatus: typeof server.status === 'string' ? server.status : null,
        catalogEpoch: null,
        catalogHash: null,
        generatedAt: catalog.generated_at ?? null,
        lastAnnouncementAt: null,
        secretsRedacted: server.secrets_redacted ?? true,
        sourceId: id,
        sourceType: 'mcp',
        catalogCacheState: typeof server.status === 'string' ? server.status : null,
        newChildCount: 0,
        schedulerDependencies: []
      })
    }
  }
  return summaries.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.label.localeCompare(b.label))
}

function sourceSummaryFromGroup(
  id: string,
  tools: ToolApprovalCardModel[],
  blocked: ToolApprovalCardModel[],
  grants: ToolApprovalGrantModel[],
  overrides: ToolPolicyOverrideModel[],
  catalog: ToolCatalogResponse
): ToolSourceSummaryModel {
  const sample = tools[0] ?? blocked[0]
  const provider = catalog.providers?.find((candidate) => sourceIdFromParts(candidate.provider_kind, candidate.provider_peer_id, candidate.provider_service_instance_id, null) === id)
  const sourceGrants = grants.filter((grant) => grantSourceId(grant) === id || tools.some((tool) => tool.id === grant.toolId))
  const sourceOverrides = overrides.filter((override) => override.sourceId === id || tools.some((tool) => tool.id === override.toolId))
  const trustTier = sourceOverrides.find((override) => override.trustTier)?.trustTier ?? sample?.trustTier ?? null
  const kind = sourceKindForTool(sample)
  const status = sourceSummaryStatus(trustTier, blocked, tools, provider, sourceGrants)
  return {
    id,
    kind,
    label: sourceLabel(sample, id),
    providerPeerId: sample?.providerPeerId ?? provider?.provider_peer_id ?? null,
    providerServiceInstanceId: sample?.serviceInstanceId ?? provider?.provider_service_instance_id ?? null,
    providerKind: sample?.providerKind ?? provider?.provider_kind ?? null,
    transport: sample?.transport ?? null,
    trustTier,
    status,
    toolCount: tools.length,
    blockedToolCount: blocked.length,
    approvalRequiredCount: tools.filter((tool) => tool.approvalRequired).length,
    newOrReviewCount: sourceGrants.filter((grant) => grant.status === 'needs-review').length,
    activeGrantCount: sourceGrants.filter((grant) => grant.status === 'active').length,
    staleGrantCount: sourceGrants.filter((grant) => grant.status === 'expired' || grant.status === 'revoked' || grant.status === 'stale').length,
    includeFutureTools: sourceGrants.some((grant) => grant.includeFutureTools) || sourceOverrides.some((override) => override.includeFutureTools),
    cacheStatus: provider?.cache_status ?? null,
    catalogEpoch: numberOrNull((provider as Record<string, unknown> | undefined)?.catalog_epoch),
    catalogHash: stringOrNull((provider as Record<string, unknown> | undefined)?.catalog_hash ?? (provider as Record<string, unknown> | undefined)?.full_schema_hash),
    generatedAt: catalog.generated_at ?? null,
    lastAnnouncementAt: stringOrNull((provider as Record<string, unknown> | undefined)?.last_announcement_at),
    secretsRedacted: tools.every((tool) => tool.secretsRedacted) && blocked.every((tool) => tool.secretsRedacted),
    sourceId: id,
    sourceType: kind,
    catalogCacheState: provider?.cache_status ?? null,
    newChildCount: sourceGrants.filter((grant) => grant.status === 'needs-review').length,
    schedulerDependencies: schedulerDependenciesForSource(sourceGrants)
  }
}

function sourceSummaryStatus(
  trustTier: string | null,
  blocked: ToolApprovalCardModel[],
  tools: ToolApprovalCardModel[],
  provider: ToolCatalogProviderInfo | undefined,
  sourceGrants: ToolApprovalGrantModel[]
): ToolSourceStatus {
  if (trustTier === 'blocked' || (blocked.length > 0 && tools.length === 0)) return 'blocked'
  if (provider?.cache_status === 'miss' || provider?.cache_status === 'failed') return 'stale'
  if (sourceGrants.some((grant) => grant.status === 'needs-review')) return 'needs-review'
  return 'active'
}

function schedulerDependenciesForSource(grants: ToolApprovalGrantModel[]): Array<Record<string, unknown>> {
  return grants
    .filter((grant) => grant.scheduleId)
    .map((grant) => ({
      jobId: grant.scheduleId,
      grantState: grant.status,
      nextRun: typeof grant.metadata.next_run === 'string' ? grant.metadata.next_run : null
    }))
}

function normalizeBlockedTools(catalog: ToolCatalogResponse, transportKind: string | null): ToolApprovalCardModel[] {
  return (catalog.blocked_tools ?? []).map((blocked) => ({
    ...normalizeToolEntry(blocked.tool, { transportKind, secretsRedacted: catalog.secrets_redacted ?? true }),
    state: 'unavailable',
    disabledReason: blocked.reason_code ?? blocked.reason ?? 'blocked'
  }))
}

function addGroupedTool(grouped: Map<string, { tools: ToolApprovalCardModel[]; blocked: ToolApprovalCardModel[] }>, tool: ToolApprovalCardModel, blocked: boolean) {
  const id = sourceIdForTool(tool)
  const group = grouped.get(id) ?? { tools: [], blocked: [] }
  if (blocked) group.blocked.push(tool)
  else group.tools.push(tool)
  grouped.set(id, group)
}

function sourceIdForTool(tool: ToolApprovalCardModel): string {
  if (tool.sourceId) return tool.sourceId
  return sourceIdFromParts(tool.providerKind, tool.providerPeerId, tool.serviceInstanceId, tool.providerLabel)
}

function sourceIdFromParts(kind: unknown, peerId: unknown, serviceInstanceId: unknown, fallback: unknown): string {
  const sourceKind = sourceKindFromProviderKind(kind)
  if (sourceKind === 'mesh_peer') {
    const normalizedPeer = typeof peerId === 'string' && peerId ? peerId : 'remote'
    const normalizedService = typeof serviceInstanceId === 'string' && serviceInstanceId ? safeSourceSegment(serviceInstanceId) : 'Tooling'
    return `mesh:${normalizedPeer}:${normalizedService}`
  }
  if (sourceKind === 'mcp' || sourceKind === 'plugin') {
    const localInstance = localSourceInstanceId(sourceKind, serviceInstanceId, fallback)
    return `local:${sourceKind}:${localInstance}`
  }
  return `local:${sourceKind}`
}

function localSourceInstanceId(sourceKind: 'mcp' | 'plugin', serviceInstanceId: unknown, fallback: unknown): string {
  const explicitService = typeof serviceInstanceId === 'string' && serviceInstanceId ? serviceInstanceId : null
  const explicitFallback = typeof fallback === 'string' && fallback ? fallback : null
  const candidate = explicitService ?? explicitFallback ?? 'default'
  const prefixPattern = sourceKind === 'mcp' ? /^mcp[-_:]/i : /^plugin[-_:]/i
  return safeSourceSegment(candidate.replace(prefixPattern, ''))
}

function safeSourceSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'default'
}

function sourceKindForTool(tool: ToolApprovalCardModel | undefined): ToolSourceKind {
  if (!tool) return 'unknown'
  return sourceKindFromProviderKind(tool.providerKind || tool.transport || tool.providerLabel)
}

function sourceKindFromProviderKind(kind: unknown): ToolSourceKind {
  const value = String(kind ?? '').toLowerCase()
  if (value.includes('mesh')) return 'mesh_peer'
  if (value.includes('mcp') || value.includes('cloud')) return 'mcp'
  if (value.includes('plugin')) return 'plugin'
  if (value.includes('local') || value.includes('core')) return 'core'
  if (value.includes('blocked')) return 'blocked'
  return 'unknown'
}

function sourceLabel(tool: ToolApprovalCardModel | undefined, id: string): string {
  if (!tool) return id
  if (tool.providerKind === 'mesh' || tool.providerKind === 'mesh_peer') return tool.providerPeerId ?? tool.providerLabel
  return tool.providerLabel || tool.serviceInstanceId || id
}

function grantSourceId(grant: ToolApprovalGrantModel): string | null {
  const metadataSourceId = stringOrNull(grant.metadata.source_id)
  if (metadataSourceId) return metadataSourceId
  if (!grant.providerPeerId && !grant.providerServiceInstanceId) return null
  return sourceIdFromParts(sourceKindForGrant(grant), grant.providerPeerId, grant.providerServiceInstanceId, null)
}

function sourceKindForGrant(grant: ToolApprovalGrantModel): ToolSourceKind {
  const metadataSourceType = stringOrNull(grant.metadata.source_type)
  if (metadataSourceType) return sourceKindFromProviderKind(metadataSourceType)
  if (grant.providerPeerId?.startsWith('peer-')) return 'mesh_peer'
  const service = grant.providerServiceInstanceId ?? ''
  if (/^mcp[-_:]/i.test(service)) return 'mcp'
  if (/^plugin[-_:]/i.test(service)) return 'plugin'
  return 'core'
}

function mcpServerSourceId(server: ToolingGetMcpStatusResponse['servers'][number]): string {
  return `local:mcp:${localSourceInstanceId('mcp', server.id ?? null, server.name ?? null)}`
}

function isGrantModel(grant: ToolingApprovalGrant | ToolApprovalGrantModel): grant is ToolApprovalGrantModel {
  return 'id' in grant && 'status' in grant && 'raw' in grant
}

function objectOrEmpty(value: unknown): JsonObject {
  return objectOrNull(value) ?? {}
}

function parseDetails(details: unknown): JsonObject {
  if (typeof details === 'string') {
    try {
      const parsed = JSON.parse(details)
      return objectOrEmpty(parsed)
    } catch {
      return { raw: '[unparseable-redacted]' }
    }
  }
  return objectOrEmpty(details)
}

function redactObject<T extends JsonObject>(value: T): JsonObject {
  const out: JsonObject = {}
  for (const [key, raw] of Object.entries(value)) {
    if (isSecretKey(key)) out[key] = '[REDACTED]'
    else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) out[key] = redactObject(raw as JsonObject)
    else if (Array.isArray(raw)) out[key] = raw.map((item) => typeof item === 'object' && item !== null && !Array.isArray(item) ? redactObject(item as JsonObject) : item as JsonValue)
    else out[key] = raw as JsonValue
  }
  if (out.secrets_redacted === undefined) out.secrets_redacted = true
  return out
}

function isSecretKey(key: string): boolean {
  if (key === 'secrets_redacted' || key === 'secretsRedacted') return false
  return /token|secret|password|credential|api[_-]?key|authorization/i.test(key)
}

function metadataSecretsRedacted(metadata: unknown): boolean {
  const object = objectOrNull(metadata)
  return object?.secrets_redacted !== false
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function kindRank(kind: string): number {
  return ({ core: 0, mcp: 1, plugin: 2, mesh_peer: 3, unknown: 4, blocked: 5 } as Record<string, number>)[kind] ?? 9
}
