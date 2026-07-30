import type { ToolApprovalConfirmRequest, ToolApprovalConfirmResponse, ToolApprovalRequestResponse } from '../admin.js'
import type {
  LocalToolAuditPort,
  LocalToolExecutionPolicy,
  LocalToolExportDecisionPort,
  LocalToolRegistry
} from '../local-tools/index.js'
import { createLocalToolingProviderHandlers } from '../local-tools/index.js'
import type { PeerHostCallContext } from '../peer-host/types.js'
import type { JsonObject, ToolingPrepareExecutionRequest, ToolingPrepareExecutionResponse, ToolingProjectionToolInfo } from '../types.js'
import { LightweightOrchestratorError } from './limits.js'
import type { LightweightToolClientPort, LightweightToolExecutionResponse } from './types.js'

export interface LightweightToolClientDelegate {
  prepareExecution(payload: ToolingPrepareExecutionRequest): Promise<ToolingPrepareExecutionResponse>
  requestApproval(payload: ToolingPrepareExecutionRequest): Promise<ToolApprovalRequestResponse>
  confirmExecution(payload: ToolApprovalConfirmRequest): Promise<ToolApprovalConfirmResponse>
  execute(payload: ToolingPrepareExecutionRequest): Promise<LightweightToolExecutionResponse>
}

export interface LightweightToolClientAdapterOptions {
  readonly localRegistry: LocalToolRegistry
  readonly localPolicy: LocalToolExecutionPolicy
  readonly remote?: LightweightToolClientDelegate | null | undefined
  readonly availableTools?: readonly ToolingProjectionToolInfo[] | undefined
  readonly providerPeerId?: string | undefined
  readonly serviceInstanceId?: string | undefined
  readonly callerPeerId?: string | undefined
  readonly callerPrincipalId?: string | null | undefined
  readonly callerPermissions?: readonly string[] | undefined
  readonly exportDecision?: LocalToolExportDecisionPort | undefined
  readonly audit?: LocalToolAuditPort | undefined
  readonly signal?: AbortSignal | undefined
  readonly nowMs?: () => number
  readonly ids?: () => string
}

interface PendingLocalApproval {
  readonly request: ToolingPrepareExecutionRequest
  readonly prepared: ToolingPrepareExecutionResponse
  readonly context: PeerHostCallContext
  readonly expiresAtMs: number
  used: boolean
}

const LOCAL_APPROVAL_PREFIX = 'local-lw-approval'

export function createLightweightToolClientAdapter(options: LightweightToolClientAdapterOptions): LightweightToolClientPort {
  const localTools = options.localRegistry.publicTools()
  const providerPeerId = options.providerPeerId ?? localTools[0]?.provider_peer_id ?? 'local-peer'
  const serviceInstanceId = options.serviceInstanceId ?? localTools[0]?.provider_service_instance_id ?? `local:${providerPeerId}:Tooling`
  const localProvider = createLocalToolingProviderHandlers({
    registry: options.localRegistry,
    policy: options.localPolicy,
    providerPeerId,
    serviceInstanceId,
    audit: options.audit ?? (() => undefined),
    ...(options.exportDecision ? { exportDecision: options.exportDecision } : {})
  })
  const pending = new Map<string, PendingLocalApproval>()
  const ids = options.ids ?? (() => crypto.randomUUID())
  const nowMs = options.nowMs ?? (() => Date.now())

  return {
    async prepareExecution(payload) {
      if (routeForPayload(payload, options) === 'remote') return await remote(options).prepareExecution(payload)
      return await localProvider.prepareExecution(payload, contextFor(options, 'Tooling.PrepareExecution', nowMs())) as ToolingPrepareExecutionResponse
    },

    async requestApproval(payload) {
      if (routeForPayload(payload, options) === 'remote') return await remote(options).requestApproval(payload)
      const context = contextFor(options, 'Tooling.RequestApproval', nowMs())
      const prepared = await localProvider.prepareExecution(payload, context) as ToolingPrepareExecutionResponse
      if (!prepared.policy_decision.share) return deniedApproval(prepared, prepared.policy_decision.reason ?? 'policy_denied')
      if (!prepared.policy_decision.approval_required) return deniedApproval(prepared, 'approval_not_required')
      const approvalRequestId = `${LOCAL_APPROVAL_PREFIX}-${ids()}`
      const expiresAtMs = nowMs() + (prepared.policy_decision.token_ttl_seconds ?? 300) * 1000
      pending.set(approvalRequestId, {
        request: clonePayload(payload),
        prepared,
        context,
        expiresAtMs,
        used: false
      })
      return {
        ok: true,
        approval_request_id: approvalRequestId,
        policy_decision: {
          ...prepared.policy_decision,
          allowed: false,
          approval_required: true
        },
        expires_at: Math.floor(expiresAtMs / 1000),
        correlation_id: prepared.correlation_id,
        error: null
      }
    },

    async confirmExecution(payload) {
      if (payload.approval_request_id.startsWith(LOCAL_APPROVAL_PREFIX)) {
        return confirmLocalApproval(payload, pending, options, nowMs())
      }
      return await remote(options).confirmExecution(payload)
    },

    async execute(payload) {
      if (routeForPayload(payload, options) === 'remote') return await remote(options).execute(payload)
      return await localProvider.executeTool(payload, contextFor(options, 'Tooling.ExecuteTool', nowMs())) as LightweightToolExecutionResponse
    }
  }
}

function confirmLocalApproval(
  payload: ToolApprovalConfirmRequest,
  pending: Map<string, PendingLocalApproval>,
  options: LightweightToolClientAdapterOptions,
  nowMs: number
): ToolApprovalConfirmResponse {
  const record = pending.get(payload.approval_request_id)
  if (!record || record.used) return approvalTokenDenied(payload, 'approval_request_invalid')
  record.used = true
  pending.delete(payload.approval_request_id)
  if (record.expiresAtMs <= nowMs) return approvalTokenDenied(payload, 'approval_request_expired')
  if (payload.approve === false) return approvalTokenDenied(payload, 'approval_denied')
  try {
    const token = options.localPolicy.issueApprovalToken(record.prepared, record.request, executionContext(record.context))
    return {
      ok: true,
      approval_token: token,
      expires_at: Math.floor(record.expiresAtMs / 1000),
      policy_decision_id: record.prepared.policy_decision.decision_id,
      correlation_id: payload.correlation_id ?? record.prepared.correlation_id,
      error: null
    }
  } catch (error) {
    return approvalTokenDenied(payload, error instanceof Error ? error.message : 'approval_token_required')
  }
}

function routeForPayload(payload: ToolingPrepareExecutionRequest, options: LightweightToolClientAdapterOptions): 'local' | 'remote' {
  const requested = requestedExecutionLocation(payload)
  const matches = matchingTools(payload.tool_name, options)
  const hasLocalRegistryMatch = options.localRegistry.resolveForDispatch(payload.tool_name) !== undefined
  const localMatches = matches.filter((tool) => tool.execution_location === 'local')
  const remoteMatches = matches.filter((tool) => tool.execution_location === 'remote')
  if (hasLocalRegistryMatch && !localMatches.some((tool) => options.localRegistry.resolveForDispatch(tool.global_tool_id))) {
    localMatches.push(...options.localRegistry.publicTools().filter((tool) => toolMatches(tool, payload.tool_name)))
  }

  if (requested === 'local') {
    if (localMatches.length !== 1 || hasRemoteMatch(remoteMatches, payload.tool_name)) throw new LightweightOrchestratorError('ambiguous_tool_route')
    return 'local'
  }
  if (requested === 'remote') {
    if (remoteMatches.length !== 1 || hasLocalRegistryMatch) throw new LightweightOrchestratorError('ambiguous_tool_route')
    return 'remote'
  }
  if (localMatches.length === 1 && remoteMatches.length === 0) return 'local'
  if (remoteMatches.length === 1 && localMatches.length === 0 && !hasLocalRegistryMatch) return 'remote'
  throw new LightweightOrchestratorError(matches.length === 0 && !hasLocalRegistryMatch ? 'unknown_tool_id' : 'ambiguous_tool_route')
}

function matchingTools(payloadToolName: string, options: LightweightToolClientAdapterOptions): ToolingProjectionToolInfo[] {
  const tools = options.availableTools ?? options.localRegistry.publicTools()
  return tools.filter((tool) => toolMatches(tool, payloadToolName))
}

function toolMatches(tool: ToolingProjectionToolInfo, id: string): boolean {
  return tool.name === id || tool.local_name === id || tool.global_tool_id === id || tool.tool_contract_id === id
}

function hasRemoteMatch(tools: readonly ToolingProjectionToolInfo[], id: string): boolean {
  return tools.some((tool) => toolMatches(tool, id))
}

function requestedExecutionLocation(payload: ToolingPrepareExecutionRequest): 'local' | 'remote' | null {
  const resourceLocation = readExecutionLocation(payload.resource_selector)
  const meshLocation = readExecutionLocation(payload.mesh_selector)
  if (resourceLocation && meshLocation && resourceLocation !== meshLocation) throw new LightweightOrchestratorError('ambiguous_tool_route')
  return resourceLocation ?? meshLocation
}

function readExecutionLocation(value: JsonObject | null | undefined): 'local' | 'remote' | null {
  const raw = value?.execution_location
  return raw === 'local' || raw === 'remote' ? raw : null
}

function remote(options: LightweightToolClientAdapterOptions): LightweightToolClientDelegate {
  if (!options.remote) throw new LightweightOrchestratorError('remote_tool_delegate_unavailable')
  return options.remote
}

function contextFor(options: LightweightToolClientAdapterOptions, methodId: string, receivedAtMs: number): PeerHostCallContext {
  const callerPeerId = options.callerPeerId ?? 'local-lightweight-assistant'
  return {
    id: `lw-tool-${receivedAtMs}`,
    methodId,
    remotePeerId: callerPeerId,
    identity: {
      callerPeerId,
      principalId: options.callerPrincipalId ?? null,
      effectivePermissions: options.callerPermissions ?? ['Tooling.ExecuteTool'],
      authGrantRevision: 1,
      manifestRevision: 1
    },
    signal: options.signal ?? neverAbortedSignal(),
    receivedAtMs,
    deadlineAtMs: receivedAtMs + 30_000
  }
}

function executionContext(context: PeerHostCallContext) {
  return {
    callerPeerId: context.identity.callerPeerId,
    callerPrincipalId: context.identity.principalId ?? null,
    permissions: [...context.identity.effectivePermissions],
    methodId: 'Tooling.ExecuteTool',
    nowMs: context.receivedAtMs
  }
}

function deniedApproval(prepared: ToolingPrepareExecutionResponse, reason: string): ToolApprovalRequestResponse {
  return {
    ok: false,
    approval_request_id: null,
    policy_decision: {
      ...prepared.policy_decision,
      allowed: false,
      reason
    },
    expires_at: null,
    correlation_id: prepared.correlation_id,
    error: reason
  }
}

function approvalTokenDenied(payload: ToolApprovalConfirmRequest, reason: string): ToolApprovalConfirmResponse {
  return {
    ok: false,
    approval_token: null,
    expires_at: null,
    policy_decision_id: null,
    correlation_id: payload.correlation_id ?? null,
    error: reason
  }
}

function clonePayload(payload: ToolingPrepareExecutionRequest): ToolingPrepareExecutionRequest {
  return structuredClone(payload)
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal
}
