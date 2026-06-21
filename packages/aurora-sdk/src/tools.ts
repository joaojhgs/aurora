import { AuroraError } from './errors.js'
import { TOOLING_METHODS } from './descriptors.js'
import type { AuroraClient } from './client.js'
import type { AuroraResponse } from './transport.js'
import type { AuditReceipt, JsonObject, JsonValue } from './types.js'

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

export interface ToolCatalogResponse {
  generated_at?: string | null
  tools: readonly ToolCatalogEntry[]
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

export interface ToolApprovalDecisionResult {
  toolId: string
  approvalRequestId: string | null
  approvalToken: string | null
  correlationId: string | null
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
  const selectedProvider =
    input.selectedProviderId !== undefined
      ? input.tool.providers.find((provider) => provider.id === input.selectedProviderId)
      : input.tool.providers.find((provider) => provider.selectable) ?? input.tool.providers[0]

  if (input.tool.providerSelectorRequired && !selectedProvider) {
    throw new AuroraError({
      code: 'validation',
      message: 'A backend-accepted provider selector is required before this tool can be approved.',
      method: TOOLING_METHODS.requestApproval,
      detail: { toolId: input.tool.id }
    })
  }

  const approval = await client.approvals.request({
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
  if (!approval.approval_request_id) {
    return {
      toolId: input.tool.id,
      approvalRequestId: null,
      approvalToken: null,
      correlationId: approval.correlation_id,
      audit: null
    }
  }

  const token = await client.approvals.approve({
    approval_request_id: approval.approval_request_id,
    approver_principal_id: input.approverPrincipalId,
    reason: input.reason,
    correlation_id: approval.correlation_id
  })
  return {
    toolId: input.tool.id,
    approvalRequestId: approval.approval_request_id,
    approvalToken: token.approvalToken,
    correlationId: token.correlationId ?? approval.correlation_id,
    audit: null
  }
}

function normalizeToolEntry(
  tool: ToolCatalogEntry,
  context: { transportKind: string | null; secretsRedacted: boolean }
): ToolApprovalCardModel {
  const providers = normalizeProviders(tool)
  const riskClass = tool.risk_class ?? tool.safety_class ?? (tool.admin ? 'admin' : tool.mutating ? 'mutating' : 'standard')
  const provider = providers.find((candidate) => candidate.selectable) ?? providers[0]
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
    argsPreview: objectOrNull(tool.redacted_args_preview ?? tool.args_preview),
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
    dryRunPreview: objectOrNull(tool.dry_run_preview),
    auditDestination: tool.audit_destination ?? null,
    correlationId: tool.correlation_id ?? null,
    policyDecisionId: tool.policy_decision_id ?? null,
    approvalRequestId: tool.approval_request_id ?? null,
    expiresAt: tool.expires_at ?? null,
    providers,
    result: tool.result ? normalizeToolResult(tool.result) : null,
    secretsRedacted: tool.secrets_redacted ?? context.secretsRedacted
  }
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
