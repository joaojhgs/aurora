import type {
  JsonObject,
  JsonValue,
  ToolingPrepareExecutionResponse
} from '../types.js'
import { hasPermission } from '../permissions.js'
import { randomBytes } from '../webrtc/crypto.js'
import { bytesToHex } from '../webrtc/encoding.js'
import { canonicalJson, canonicalJsonSha256Hex } from './canonical-json.js'
import { validateJsonAgainstSchema } from './json-schema.js'
import type { LocalToolDispatchEntry, LocalToolExecutionContext } from './tool-registry.js'

const SECRET_KEY_PARTS = ['secret', 'token', 'password', 'api_key', 'apikey', 'credential', 'private_key']

export interface LocalToolExecuteRequest {
  readonly tool_name: string
  readonly arguments: JsonObject
  readonly expected_args_schema_hash?: string | null
  readonly mesh_selector?: JsonObject | null
  readonly resource_selector?: JsonObject | null
  readonly confirmed?: boolean
  readonly approval_token?: string | null
  readonly dry_run?: boolean
  readonly correlation_id?: string | null
  readonly caller_peer_id?: string | null
  readonly caller_principal_id?: string | null
  readonly caller_device_id?: string | null
  readonly caller_permissions?: readonly string[] | null
  readonly schedule_id?: string | null
  readonly scheduled_action_hash?: string | null
}

export interface LocalToolPolicyPorts {
  readonly hasMethodGrant?: (methodId: string, context: LocalToolExecutionContext) => boolean | Promise<boolean>
  readonly hasToolGrant?: (toolContractId: string, context: LocalToolExecutionContext) => boolean | Promise<boolean>
  readonly hasCapabilityGrant?: (capabilityId: string, context: LocalToolExecutionContext) => boolean | Promise<boolean>
  readonly hasResourceGrant?: (resourceScope: string, context: LocalToolExecutionContext, request: LocalToolExecuteRequest) => boolean | Promise<boolean>
}

export interface LocalToolExecutionPolicyOptions {
  readonly providerPeerId: string
  readonly providerServiceInstanceId: string
  readonly tokenTtlSeconds?: number
  readonly nowMs?: () => number
  readonly randomToken?: () => string
  readonly ports?: LocalToolPolicyPorts
}

interface StoredApprovalToken {
  readonly tokenHash: string
  readonly claims: ApprovalTokenClaims
  used: boolean
}

interface ApprovalTokenClaims {
  readonly caller_peer_id: string
  readonly caller_principal_id: string | null
  readonly provider_peer_id: string
  readonly provider_service_instance_id: string
  readonly global_tool_id: string
  readonly local_tool_name: string
  readonly args_hash: string
  readonly resource_selector_hash: string
  readonly route_decision_id: string
  readonly schedule_id: string | null
  readonly scheduled_action_hash: string | null
  readonly decision: 'approved'
  readonly nonce: string
  readonly expires_at_ms: number
}

export class LocalToolPolicyError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = reasonCode) {
    super(message)
    this.name = 'LocalToolPolicyError'
    this.reasonCode = reasonCode
  }
}

export class LocalToolExecutionPolicy {
  private readonly options: {
    readonly providerPeerId: string
    readonly providerServiceInstanceId: string
    readonly tokenTtlSeconds: number
    readonly nowMs: () => number
    readonly randomToken: () => string
    readonly ports?: LocalToolPolicyPorts
  }
  private readonly approvalTokensByHash = new Map<string, StoredApprovalToken>()

  constructor(options: LocalToolExecutionPolicyOptions) {
    this.options = {
      providerPeerId: options.providerPeerId,
      providerServiceInstanceId: options.providerServiceInstanceId,
      tokenTtlSeconds: options.tokenTtlSeconds ?? 300,
      nowMs: options.nowMs ?? (() => Date.now()),
      randomToken: options.randomToken ?? secureRandomToken,
      ...(options.ports ? { ports: options.ports } : {})
    }
  }

  async prepare(entry: LocalToolDispatchEntry, request: LocalToolExecuteRequest, context: LocalToolExecutionContext): Promise<ToolingPrepareExecutionResponse> {
    assertCanonicalRequest(request)
    const argsSchemaHash = entry.schemaHash
    const validationReason = request.expected_args_schema_hash && request.expected_args_schema_hash !== argsSchemaHash
      ? 'args_schema_hash_mismatch'
      : validateArguments(entry, request.arguments)
    const grantReason = validationReason ?? await this.firstGrantDenial(entry, request, context)
    const approvalRequired = isApprovalRequired(entry)
    const argsHash = argumentsFingerprint(request.arguments)
    const resourceHash = resourceSelectorFingerprint(request)
    const routeId = routeDecisionId({
      provider_peer_id: this.options.providerPeerId,
      provider_service_instance_id: this.options.providerServiceInstanceId,
      global_tool_id: entry.toolInfo.global_tool_id,
      local_tool_name: entry.toolInfo.local_name,
      resource_selector_hash: resourceHash
    })
    const allowed = !grantReason && !approvalRequired
    return {
      ok: allowed,
      policy_decision: {
        allowed,
        share: !grantReason,
        approval_required: approvalRequired,
        approval_mode: approvalRequired ? 'ask_each_time' : 'approve_all_local_safe',
        decision_id: canonicalJsonSha256Hex({ route_decision_id: routeId, args_hash: argsHash, approval_required: approvalRequired }),
        policy_rule_id: null,
        reason: grantReason ?? (approvalRequired ? 'approval_token_required' : null),
        auto_approved_reason: allowed ? 'local_safe_tool' : null,
        effective_default: approvalRequired ? 'ask_each_time' : 'approve_all_local_safe',
        grant_id: null,
        grant_scope: null,
        token_ttl_seconds: this.options.tokenTtlSeconds
      },
      args_hash: argsHash,
      resource_selector_hash: resourceHash,
      route_decision_id: routeId,
      correlation_id: request.correlation_id ?? routeId,
      provider_peer_id: this.options.providerPeerId,
      provider_service_instance_id: this.options.providerServiceInstanceId,
      global_tool_id: entry.toolInfo.global_tool_id,
      local_tool_name: entry.toolInfo.local_name,
      args_schema_hash: argsSchemaHash,
      source: entry.toolInfo.source,
      source_id: entry.toolInfo.source_id ?? null,
      trust_tier: entry.toolInfo.trust_tier,
      capability_class: entry.toolInfo.capability_class,
      resource_scope: entry.toolInfo.resource_scope,
      display_args_preview: displayArgumentsPreview(request.arguments, entry.toolInfo.argument_visibility),
      argument_visibility: entry.toolInfo.argument_visibility as Record<string, string>,
      secrets_redacted: true
    }
  }

  issueApprovalToken(prepared: ToolingPrepareExecutionResponse, request: LocalToolExecuteRequest, context: LocalToolExecutionContext): string {
    if (!prepared.policy_decision.approval_required) throw new LocalToolPolicyError('approval_not_required')
    const token = `local_tool_approval_${this.options.randomToken()}`
    const tokenHash = approvalTokenHash(token)
    this.approvalTokensByHash.set(tokenHash, {
      tokenHash,
      used: false,
      claims: {
        caller_peer_id: context.callerPeerId,
        caller_principal_id: context.callerPrincipalId ?? null,
        provider_peer_id: prepared.provider_peer_id,
        provider_service_instance_id: prepared.provider_service_instance_id,
        global_tool_id: prepared.global_tool_id,
        local_tool_name: prepared.local_tool_name,
        args_hash: prepared.args_hash,
        resource_selector_hash: prepared.resource_selector_hash,
        route_decision_id: prepared.route_decision_id,
        schedule_id: request.schedule_id ?? null,
        scheduled_action_hash: request.scheduled_action_hash ?? null,
        decision: 'approved',
        nonce: this.options.randomToken(),
        expires_at_ms: this.options.nowMs() + this.options.tokenTtlSeconds * 1000
      }
    })
    return token
  }

  async validateForExecute(entry: LocalToolDispatchEntry, request: LocalToolExecuteRequest, context: LocalToolExecutionContext): Promise<ToolingPrepareExecutionResponse> {
    const prepared = await this.prepare(entry, request, context)
    if (!prepared.policy_decision.share) return prepared
    if (!prepared.policy_decision.approval_required) return { ...prepared, ok: true, policy_decision: { ...prepared.policy_decision, allowed: true } }
    const token = request.approval_token
    const failure = token ? this.consumeApprovalToken(token, prepared, request, context) : 'approval_token_required'
    if (failure) {
      return {
        ...prepared,
        ok: false,
        policy_decision: {
          ...prepared.policy_decision,
          allowed: false,
          reason: failure
        }
      }
    }
    return {
      ...prepared,
      ok: true,
      policy_decision: {
        ...prepared.policy_decision,
        allowed: true,
        reason: null,
        auto_approved_reason: 'approval_token'
      }
    }
  }

  private consumeApprovalToken(token: string, prepared: ToolingPrepareExecutionResponse, request: LocalToolExecuteRequest, context: LocalToolExecutionContext): string | null {
    const tokenHash = approvalTokenHash(token)
    const stored = this.approvalTokensByHash.get(tokenHash)
    if (!stored) return 'approval_token_invalid'
    if (stored.used) return 'approval_token_replayed'
    if (stored.claims.expires_at_ms <= this.options.nowMs()) return 'approval_token_expired'
    const expected: ApprovalTokenClaims = {
      ...stored.claims,
      caller_peer_id: context.callerPeerId,
      caller_principal_id: context.callerPrincipalId ?? null,
      provider_peer_id: prepared.provider_peer_id,
      provider_service_instance_id: prepared.provider_service_instance_id,
      global_tool_id: prepared.global_tool_id,
      local_tool_name: prepared.local_tool_name,
      args_hash: prepared.args_hash,
      resource_selector_hash: prepared.resource_selector_hash,
      route_decision_id: prepared.route_decision_id,
      schedule_id: request.schedule_id ?? null,
      scheduled_action_hash: request.scheduled_action_hash ?? null
    }
    for (const key of Object.keys(expected) as Array<keyof ApprovalTokenClaims>) {
      if (stored.claims[key] !== expected[key]) return `approval_token_${key}_mismatch`
    }
    stored.used = true
    return null
  }

  private async firstGrantDenial(entry: LocalToolDispatchEntry, request: LocalToolExecuteRequest, context: LocalToolExecutionContext): Promise<string | null> {
    if (!hasPermission('Tooling.ExecuteTool', context.permissions, 'use')) return 'recipient_missing_execute_permission'
    for (const permission of entry.toolInfo.required_permissions) {
      if (!hasPermission(permission, context.permissions, 'use')) return 'recipient_missing_tool_permissions'
    }
    if (this.options.ports?.hasMethodGrant && !await this.options.ports.hasMethodGrant('Tooling.ExecuteTool', context)) return 'method_not_granted'
    if (!this.options.ports?.hasToolGrant || !await this.options.ports.hasToolGrant(entry.descriptor.toolContractId, context)) return 'tool_not_granted'
    for (const capabilityId of entry.descriptor.nativeRequirements.capabilityIds) {
      if (!this.options.ports?.hasCapabilityGrant || !await this.options.ports.hasCapabilityGrant(capabilityId, context)) return 'capability_not_granted'
    }
    for (const resourceScope of entry.toolInfo.resource_scope) {
      if (!this.options.ports?.hasResourceGrant || !await this.options.ports.hasResourceGrant(resourceScope, context, request)) return 'resource_not_granted'
    }
    return null
  }
}

export function argumentsFingerprint(argumentsValue: JsonObject): string {
  return canonicalJsonSha256Hex(argumentsValue)
}

export function resourceSelectorFingerprint(request: LocalToolExecuteRequest): string {
  const mesh = request.mesh_selector ?? {}
  return canonicalJsonSha256Hex({
    resource_selector: request.resource_selector ?? {},
    mesh_resource_namespace: mesh.resource_namespace ?? null,
    mesh_hardware_target: mesh.hardware_target ?? null,
    mesh_data_scope: mesh.data_scope ?? null,
    mesh_tool_id: mesh.tool_id ?? null
  })
}

export function displayArgumentsPreview(argumentsValue: JsonObject, visibility: JsonObject = {}): JsonObject {
  return Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => {
    const fieldVisibility = visibility[key]
    if (fieldVisibility === 'secret' || fieldVisibility === 'raw_never' || isImplicitSecretKey(key)) return [key, '<redacted>']
    if (fieldVisibility === 'hash_only' || fieldVisibility === 'support_bundle_redacted') return [key, `sha256:${canonicalJsonSha256Hex({ [key]: value })}`]
    return [key, redactNested(value)]
  })) as JsonObject
}

export function sanitizeHandlerData(value: JsonValue | undefined): JsonValue | null {
  if (value === undefined) return null
  canonicalJson(value)
  return value
}

function secureRandomToken(): string {
  try {
    return bytesToHex(randomBytes(32))
  } catch {
    throw new LocalToolPolicyError('approval_random_unavailable')
  }
}

export function safeToolError(): string {
  return 'Tool execution failed'
}

function assertCanonicalRequest(request: LocalToolExecuteRequest): void {
  canonicalJson(request.arguments)
  if (request.resource_selector) canonicalJson(request.resource_selector)
  if (request.mesh_selector) canonicalJson(request.mesh_selector)
}

function isApprovalRequired(entry: LocalToolDispatchEntry): boolean {
  return entry.descriptor.confirmationPolicy === 'always'
    || entry.descriptor.safetyClass === 'dangerous'
    || entry.descriptor.safetyClass === 'sensitive'
    || (entry.descriptor.confirmationPolicy === 'sensitive' && entry.toolInfo.confirmation_required)
}

function validateArguments(entry: LocalToolDispatchEntry, args: JsonObject): string | null {
  return validateJsonAgainstSchema(entry.descriptor.argsSchema as JsonObject, args) ? 'argument_schema_invalid' : null
}

function routeDecisionId(value: JsonObject): string {
  return canonicalJsonSha256Hex(value)
}

function approvalTokenHash(token: string): string {
  return canonicalJsonSha256Hex({ token })
}

function redactNested(value: JsonValue | undefined): JsonValue {
  if (value === undefined || value === null || typeof value !== 'object') return value ?? null
  if (Array.isArray(value)) return value.map((item) => redactNested(item))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isImplicitSecretKey(key) ? '<redacted>' : redactNested(item)
  ])) as JsonObject
}

function isImplicitSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-.]/g, '_')
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}
