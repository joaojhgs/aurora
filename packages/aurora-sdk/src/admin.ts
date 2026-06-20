import { AuroraError, type AuroraErrorCode } from './errors.js'
import { GATEWAY_METHODS, TOOLING_METHODS, routePath } from './descriptors.js'
import type { AuroraResponse, AuroraTransport } from './transport.js'
import type { AuditReceipt, JsonObject, JsonValue } from './types.js'

export interface AdminActionHeaderNames {
  action_id: string
  confirmation_token: string
  digest: string
}

export interface AdminActionDraftRequest {
  method_id: string
  payload?: JsonObject
  affected_resources?: string[]
}

export interface AdminActionDraftResponse {
  action_id: string
  nonce: string
  digest: string
  method_id: string
  affected_resources: string[]
  required_phrase: string
  required_reason: boolean
  required_reauth: boolean
  expires_at: string
  expires_in_seconds: number
  confirmation_headers: AdminActionHeaderNames
}

export interface AdminActionConfirmRequest {
  action_id: string
  nonce: string
  digest: string
  reason: string
  reauth_confirmed: boolean
  phrase?: string
}

export interface AdminActionConfirmResponse {
  action_id: string
  confirmation_token: string
  digest: string
  confirmed: boolean
  expires_at: string
  audit_receipt: string
  confirmation_headers: AdminActionHeaderNames
}

export interface AdminActionSubmitOptions {
  methodId: string
  payload?: JsonObject
  confirmation: AdminActionConfirmResponse
  path?: string
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  timeoutMs?: number
  extraHeaders?: Record<string, string>
}

export interface ToolApprovalRequest {
  global_tool_id?: string
  local_name?: string
  provider_peer_id?: string | null
  provider_service_instance_id?: string | null
  mesh_selector?: JsonObject | null
  resource_selector?: JsonObject | null
  args?: JsonObject
  args_hash?: string | null
  args_preview?: JsonObject | null
  redacted_args_preview?: JsonObject | null
  risk_class?: string | null
  requested_approval_scope?: string | null
  expected_audit_event?: string | null
  requested_by_principal_id?: string | null
  caller_principal_id?: string | null
  dry_run?: boolean
  [key: string]: JsonValue | undefined
}

export interface ToolApprovalPolicyDecision {
  decision_id?: string | null
  allowed?: boolean
  approval_required?: boolean
  approval_mode?: string
  token_ttl_seconds?: number
  reason?: string | null
  risk_class?: string | null
  safety_class?: string | null
  [key: string]: JsonValue | undefined
}

export interface ToolApprovalRequestResponse {
  ok: boolean
  approval_request_id: string | null
  policy_decision: ToolApprovalPolicyDecision
  expires_at: number | null
  correlation_id: string
  error: string | null
}

export interface ToolApprovalConfirmRequest {
  approval_request_id: string
  approver_principal_id: string
  approve?: boolean
  reason?: string | null
  correlation_id?: string | null
}

export interface ToolApprovalConfirmResponse {
  ok: boolean
  approval_token: string | null
  expires_at: number | null
  policy_decision_id: string | null
  correlation_id: string | null
  error: string | null
}

export interface ApprovalTokenScope {
  approvalRequestId: string
  approvalToken: string
  expiresAt: number | null
  policyDecisionId: string | null
  correlationId: string | null
}

export interface AdminActionControllerClient {
  request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options?: {
      path?: string
      busTopic?: string
      httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      timeoutMs?: number
      headers?: Record<string, string>
    }
  ): Promise<TData>
  requestResult<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options?: {
      path?: string
      busTopic?: string
      httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      timeoutMs?: number
      headers?: Record<string, string>
    }
  ): Promise<AuroraResponse<TData>>
  readonly transport: AuroraTransport
}

export class AdminActionClient {
  constructor(private readonly client: AdminActionControllerClient) {}

  draft(request: AdminActionDraftRequest): Promise<AdminActionDraftResponse> {
    return this.client.request<AdminActionDraftResponse, AdminActionDraftRequest>(
      GATEWAY_METHODS.adminActionDraft,
      request,
      { path: routePath('Gateway', 'AdminActionDraft') }
    )
  }

  confirm(
    draft: AdminActionDraftResponse,
    input: { reason: string; reauthConfirmed: boolean; phrase?: string }
  ): Promise<AdminActionConfirmResponse> {
    const request: AdminActionConfirmRequest = {
      action_id: draft.action_id,
      nonce: draft.nonce,
      digest: draft.digest,
      reason: input.reason,
      reauth_confirmed: input.reauthConfirmed,
      phrase: input.phrase ?? draft.required_phrase
    }
    return this.client.request<AdminActionConfirmResponse, AdminActionConfirmRequest>(
      GATEWAY_METHODS.adminActionConfirm,
      request,
      { path: routePath('Gateway', 'AdminActionConfirm') }
    )
  }

  headers(confirmation: AdminActionConfirmResponse): Record<string, string> {
    return {
      [confirmation.confirmation_headers.action_id]: confirmation.action_id,
      [confirmation.confirmation_headers.confirmation_token]: confirmation.confirmation_token,
      [confirmation.confirmation_headers.digest]: confirmation.digest
    }
  }

  async submit<TData = unknown>(options: AdminActionSubmitOptions): Promise<TData> {
    const requestOptions: Parameters<AdminActionControllerClient['request']>[2] = {
      path: options.path ?? pathFromMethodId(options.methodId),
      httpMethod: options.httpMethod ?? 'POST',
      headers: {
        ...this.headers(options.confirmation),
        ...options.extraHeaders
      }
    }
    if (options.timeoutMs !== undefined) requestOptions.timeoutMs = options.timeoutMs
    return this.client.request<TData, JsonObject>(
      options.methodId,
      options.payload ?? {},
      requestOptions
    )
  }

  async execute<TData = unknown>(input: {
    methodId: string
    payload?: JsonObject
    reason: string
    reauthConfirmed: boolean
    phrase?: string
    affectedResources?: string[]
    path?: string
    timeoutMs?: number
  }): Promise<{ draft: AdminActionDraftResponse; confirmation: AdminActionConfirmResponse; data: TData }> {
    const draftRequest: AdminActionDraftRequest = {
      method_id: input.methodId,
      payload: input.payload ?? {}
    }
    if (input.affectedResources !== undefined) draftRequest.affected_resources = input.affectedResources
    const draft = await this.draft(draftRequest)
    const confirmInput: { reason: string; reauthConfirmed: boolean; phrase?: string } = {
      reason: input.reason,
      reauthConfirmed: input.reauthConfirmed
    }
    if (input.phrase !== undefined) confirmInput.phrase = input.phrase
    const confirmation = await this.confirm(draft, confirmInput)
    const submitOptions: AdminActionSubmitOptions = {
      methodId: input.methodId,
      payload: input.payload ?? {},
      confirmation
    }
    if (input.path !== undefined) submitOptions.path = input.path
    if (input.timeoutMs !== undefined) submitOptions.timeoutMs = input.timeoutMs
    const data = await this.submit<TData>(submitOptions)
    return { draft, confirmation, data }
  }
}

export class ApprovalClient {
  constructor(private readonly client: AdminActionControllerClient) {}

  async request(input: ToolApprovalRequest): Promise<ToolApprovalRequestResponse> {
    const response = await this.client.request<ToolApprovalRequestResponse, ToolApprovalRequest>(
      TOOLING_METHODS.requestApproval,
      input,
      { path: routePath('Tooling', 'RequestApproval') }
    )
    assertBackendOk(response.ok, response.error, {
      method: TOOLING_METHODS.requestApproval,
      correlationId: response.correlation_id,
      detail: response
    })
    return response
  }

  async confirm(input: ToolApprovalConfirmRequest): Promise<ToolApprovalConfirmResponse> {
    const response = await this.client.request<ToolApprovalConfirmResponse, ToolApprovalConfirmRequest>(
      TOOLING_METHODS.confirmExecution,
      input,
      { path: routePath('Tooling', 'ConfirmExecution') }
    )
    const context: { method: string; correlationId?: string; detail: unknown } = {
      method: TOOLING_METHODS.confirmExecution,
      detail: response
    }
    const correlationId = response.correlation_id ?? input.correlation_id
    if (correlationId !== null && correlationId !== undefined) context.correlationId = correlationId
    assertBackendOk(response.ok, response.error, context)
    return response
  }

  async approve(input: ToolApprovalConfirmRequest): Promise<ApprovalTokenScope> {
    const response = await this.confirm({ ...input, approve: input.approve ?? true })
    if (!response.approval_token) {
      throw new AuroraError({
        code: 'validation',
        message: 'Tool approval confirmation did not include a backend-issued approval token',
        method: TOOLING_METHODS.confirmExecution,
        correlationId: response.correlation_id ?? undefined,
        detail: response
      })
    }
    return {
      approvalRequestId: input.approval_request_id,
      approvalToken: response.approval_token,
      expiresAt: response.expires_at,
      policyDecisionId: response.policy_decision_id,
      correlationId: response.correlation_id
    }
  }
}

export function adminActionAudit(confirmation: AdminActionConfirmResponse): Partial<AuditReceipt> {
  return {
    eventKind: 'admin_action.confirmed',
    method: GATEWAY_METHODS.adminActionConfirm,
    status: confirmation.confirmed ? 'confirmed' : 'unconfirmed'
  }
}

function pathFromMethodId(methodId: string): string {
  const separator = methodId.indexOf('.')
  if (separator <= 0 || separator === methodId.length - 1) {
    throw new AuroraError({
      code: 'validation',
      message: `AdminAction method ID must be a backend bus topic like Service.Method: ${methodId}`,
      method: methodId
    })
  }
  return routePath(methodId.slice(0, separator), methodId.slice(separator + 1))
}

function assertBackendOk(
  ok: boolean,
  backendError: string | null | undefined,
  context: { method: string; correlationId?: string; detail: unknown }
): void {
  if (ok) return
  const backendCode = backendError ?? 'approval_failed'
  throw new AuroraError({
    code: approvalErrorCode(backendCode),
    message: backendCode.replace(/_/g, ' '),
    method: context.method,
    correlationId: context.correlationId,
    detail: context.detail
  })
}

function approvalErrorCode(backendCode: string): AuroraErrorCode {
  if (backendCode.includes('expired')) return 'timeout'
  if (backendCode.includes('denied')) return 'permission'
  if (backendCode.includes('permission') || backendCode.includes('forbidden')) return 'permission'
  if (backendCode.includes('privacy')) return 'privacy_blocked'
  if (backendCode.includes('unavailable') || backendCode.includes('not_found')) return 'unavailable_service'
  if (backendCode.includes('auth')) return 'auth'
  if (
    backendCode.includes('mismatch') ||
    backendCode.includes('replay') ||
    backendCode.includes('changed') ||
    backendCode.includes('downgraded') ||
    backendCode.includes('invalid') ||
    backendCode.includes('required')
  ) {
    return 'validation'
  }
  return 'unknown'
}
