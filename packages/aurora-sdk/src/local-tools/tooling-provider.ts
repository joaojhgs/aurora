import {
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  type ToolingExecuteToolOutputToolingExecuteToolResponse,
  ToolingExecuteToolOutputToolingExecuteToolResponseSchema,
  ToolingGetExportCatalogInputToolingGetExportCatalogRequestSchema,
  ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
  ToolingGetToolsInputToolingGetToolsRequestSchema,
  ToolingGetToolsOutputToolingGetToolsResponseSchema,
  ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema,
  ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema
} from '../generated/backend-contracts.zod.js'
import type { PeerHostCallContext } from '../peer-host/types.js'
import type { JsonObject, ToolingPrepareExecutionResponse } from '../types.js'
import { parseBoundary } from '../validation/index.js'
import {
  buildLocalToolExportCatalogPage,
  buildVisibleProjection,
  type LocalToolExportCatalogOptions,
  normalizeProjectionToolAuthority,
  type LocalToolExportDecisionPort,
  type LocalToolProjectionContext
} from './export-catalog.js'
import {
  LocalToolExecutionPolicy,
  safeToolError,
  sanitizeHandlerData,
  type LocalToolExecuteRequest
} from './execution-policy.js'
import { validateJsonAgainstSchema } from './json-schema.js'
import { LocalToolRegistry, type LocalToolExecutionContext } from './tool-registry.js'

export type LocalToolAuditAction = 'prepare' | 'execute'
export type LocalToolAuditResult = 'allowed' | 'denied' | 'dry_run' | 'success' | 'failure' | 'cancelled' | 'not_found'

export interface LocalToolAuditRecord {
  readonly action: LocalToolAuditAction
  readonly result: LocalToolAuditResult
  readonly reason_code?: string | null
  readonly provider_peer_id: string
  readonly provider_service_instance_id: string
  readonly caller_peer_id: string
  readonly caller_principal_id?: string | null
  readonly method_id: string
  readonly global_tool_id?: string | null
  readonly local_tool_name?: string | null
  readonly policy_decision_id?: string | null
  readonly correlation_id?: string | null
  readonly connection_epoch?: string | null
  readonly args_hash?: string | null
  readonly display_args_preview: JsonObject
  readonly redacted: true
  readonly secrets_redacted: true
  readonly detail?: JsonObject | null
}

export type LocalToolAuditPort = (record: LocalToolAuditRecord) => void | Promise<void>

export interface LocalToolingProviderOptions {
  readonly registry: LocalToolRegistry
  readonly policy: LocalToolExecutionPolicy
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly audit: LocalToolAuditPort
  readonly exportDecision?: LocalToolExportDecisionPort
  readonly cursorSecret?: Uint8Array | string
  readonly nowSeconds?: () => number
  readonly connectionEpoch?: string | (() => string | null)
  readonly authorityRevision?: {
    readonly catalog_revision: number
    readonly export_policy_revision: number
    readonly auth_grant_revision: number
    readonly manifest_revision: number
    readonly switch_revision: number
    readonly protocol_revision: number
  }
}

export function createLocalToolingProviderHandlers(options: LocalToolingProviderOptions) {
  return {
    getTools(input: unknown, context: PeerHostCallContext) {
      const request = parseBoundary('Tooling.GetTools.input.ToolingGetToolsRequest', ToolingGetToolsInputToolingGetToolsRequestSchema, input, { boundary: 'webrtc-frame' })
      const tools = filterTools(visibleTools(options, context), request.query ?? null).slice(0, request.top_k ?? 100)
      return parseBoundary('Tooling.GetTools.output.ToolingGetToolsResponse', ToolingGetToolsOutputToolingGetToolsResponseSchema, {
        tools,
        count: tools.length
      }, { boundary: 'webrtc-frame' })
    },

    getExportCatalog(input: unknown, context: PeerHostCallContext) {
      const request = normalizeExportCatalogRequest({
        ...parseBoundary('Tooling.GetExportCatalog.input.ToolingGetExportCatalogRequest', ToolingGetExportCatalogInputToolingGetExportCatalogRequestSchema, input, { boundary: 'webrtc-frame' }),
        protocol_tier: 'projection_v1' as const
      })
      const catalogOptions: LocalToolExportCatalogOptions = {
        providerPeerId: options.providerPeerId,
        serviceInstanceId: options.serviceInstanceId,
        tools: options.registry.publicTools(),
        context: projectionContext(options, context),
        ...(options.exportDecision ? { exportDecision: options.exportDecision } : {}),
        ...(options.cursorSecret ? { cursorSecret: options.cursorSecret } : {}),
        ...(options.nowSeconds ? { nowSeconds: options.nowSeconds } : {})
      }
      const page = buildLocalToolExportCatalogPage(request, catalogOptions)
      return parseBoundary('Tooling.GetExportCatalog.output.ToolingGetExportCatalogResponse', ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema, page, { boundary: 'webrtc-frame' })
    },

    async prepareExecution(input: unknown, context: PeerHostCallContext) {
      const request = normalizeExecuteRequest(parseBoundary('Tooling.PrepareExecution.input.ToolingPrepareExecutionRequest', ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema, input, { boundary: 'webrtc-frame' }))
      const entry = options.registry.resolveForDispatch(request.tool_name)
      if (!entry) {
        const response = deniedPrepare(request, context, 'tool_not_found', options)
        await audit(options, context, auditFromPrepared('prepare', response, context, options, 'not_found', 'tool_not_found'))
        return response
      }
      const prepared = await options.policy.prepare(entry, request, executionContext(context))
      await audit(options, context, auditFromPrepared('prepare', prepared, context, options, prepared.policy_decision.allowed ? 'allowed' : 'denied', prepared.policy_decision.reason))
      return parseBoundary('Tooling.PrepareExecution.output.ToolingPrepareExecutionResponse', ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema, prepared, { boundary: 'webrtc-frame' })
    },

    async executeTool(input: unknown, context: PeerHostCallContext) {
      const request = normalizeExecuteRequest(parseBoundary('Tooling.ExecuteTool.input.ToolingExecuteToolRequest', ToolingExecuteToolInputToolingExecuteToolRequestSchema, input, { boundary: 'webrtc-frame' }))
      const entry = options.registry.resolveForDispatch(request.tool_name)
      if (!entry) {
        const response = deniedExecute(request, 'not_found', 'tool_not_found', options)
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'not_found'))
        return response
      }
      const execution = executionContext(context)
      const prepared = await options.policy.validateForExecute(entry, request, execution)
      if (!prepared.ok || !prepared.policy_decision.allowed) {
        const response = parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: false,
          data: null,
          error: 'Tool execution denied',
          status: 'denied',
          error_code: prepared.policy_decision.reason ?? 'policy_denied',
          correlation_id: prepared.correlation_id,
          provider_peer_id: prepared.provider_peer_id,
          global_tool_id: prepared.global_tool_id,
          policy_decision_id: prepared.policy_decision.decision_id,
          display_args_preview: prepared.display_args_preview,
          args_hash: prepared.args_hash
        }, { boundary: 'webrtc-frame' })
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'denied'))
        return response
      }
      if (request.dry_run) {
        const response = parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: true,
          data: null,
          error: null,
          status: 'dry_run',
          error_code: null,
          correlation_id: prepared.correlation_id,
          provider_peer_id: prepared.provider_peer_id,
          global_tool_id: prepared.global_tool_id,
          policy_decision_id: prepared.policy_decision.decision_id,
          display_args_preview: prepared.display_args_preview,
          args_hash: prepared.args_hash
        }, { boundary: 'webrtc-frame' })
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'dry_run'))
        return response
      }
      if (context.signal.aborted) {
        const response = cancelledExecute(prepared)
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'cancelled'))
        return response
      }
      try {
        const data = await entry.handler({
          arguments: request.arguments,
          signal: context.signal,
          correlationId: prepared.correlation_id,
          context: execution
        })
        if (context.signal.aborted) {
          const response = cancelledExecute(prepared)
          await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'cancelled'))
          return response
        }
        const output = sanitizeHandlerData(data)
        const outputReason = validateJsonAgainstSchema(entry.descriptor.outputSchema as JsonObject, output)
        if (outputReason) {
          const response = failedExecute(prepared, 'output_schema_invalid')
          await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'failure', { output_reason: outputReason }))
          return response
        }
        const response = parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: true,
          data: output,
          error: null,
          status: 'success',
          error_code: null,
          correlation_id: prepared.correlation_id,
          provider_peer_id: prepared.provider_peer_id,
          global_tool_id: prepared.global_tool_id,
          policy_decision_id: prepared.policy_decision.decision_id,
          display_args_preview: prepared.display_args_preview,
          args_hash: prepared.args_hash
        }, { boundary: 'webrtc-frame' })
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'success'))
        return response
      } catch {
        const response = failedExecute(prepared, 'handler_failed')
        await audit(options, context, auditFromExecuteResponse('execute', response, request, context, options, 'failure'))
        return response
      }
    }
  }
}

function visibleTools(options: LocalToolingProviderOptions, context: PeerHostCallContext) {
  const candidates = options.registry.publicTools()
    .map((tool) => normalizeProjectionToolAuthority(tool, options.providerPeerId, options.serviceInstanceId))
  return buildVisibleProjection(candidates, projectionContext(options, context), options.exportDecision)
}

function projectionContext(options: LocalToolingProviderOptions, context: PeerHostCallContext): LocalToolProjectionContext {
  return {
    recipientPeerId: context.identity.callerPeerId,
    recipientPermissions: context.identity.effectivePermissions,
    authorityRevision: options.authorityRevision ?? {
      catalog_revision: options.registry.publicTools().length,
      export_policy_revision: 0,
      auth_grant_revision: Number(context.identity.authGrantRevision ?? 0),
      manifest_revision: Number(context.identity.manifestRevision ?? 0),
      switch_revision: 0,
      protocol_revision: 1
    },
    providerEnabled: true,
    serviceExported: true,
    discoveryExported: true,
    executionExported: true
  }
}

function executionContext(context: PeerHostCallContext): LocalToolExecutionContext {
  return {
    callerPeerId: context.identity.callerPeerId,
    callerPrincipalId: context.identity.principalId ?? null,
    permissions: [...context.identity.effectivePermissions],
    methodId: context.methodId,
    nowMs: context.receivedAtMs
  }
}

function filterTools<T extends { name: string; local_name: string; display_name: string; description: string }>(tools: T[], query: string | null): T[] {
  if (!query) return tools
  const normalized = query.toLowerCase()
  return tools.filter((tool) => `${tool.name} ${tool.local_name} ${tool.display_name} ${tool.description}`.toLowerCase().includes(normalized))
}

function normalizeExportCatalogRequest(request: Record<string, unknown> & { protocol_tier: 'projection_v1' }) {
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined)
  ) as {
    protocol_tier: 'projection_v1'
    page_size?: number
    cursor?: string | null
    last_projection_revision?: string | null
    last_projection_digest?: string | null
  }
}

function normalizeExecuteRequest(request: Record<string, unknown> & {
  readonly tool_name: string
  readonly arguments: LocalToolExecuteRequest['arguments']
}): LocalToolExecuteRequest {
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined)
  ) as unknown as LocalToolExecuteRequest
}

function deniedPrepare(request: LocalToolExecuteRequest, context: PeerHostCallContext, reason: string, options: LocalToolingProviderOptions): ToolingPrepareExecutionResponse {
  return parseBoundary('Tooling.PrepareExecution.output.ToolingPrepareExecutionResponse', ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema, {
    ok: false,
    policy_decision: {
      allowed: false,
      share: false,
      approval_required: false,
      approval_mode: 'deny_all',
      decision_id: request.correlation_id ?? context.id,
      reason,
      token_ttl_seconds: 0
    },
    args_hash: '0'.repeat(64),
    resource_selector_hash: '0'.repeat(64),
    route_decision_id: request.correlation_id ?? context.id,
    correlation_id: request.correlation_id ?? context.id,
    provider_peer_id: options.providerPeerId,
    provider_service_instance_id: options.serviceInstanceId,
    global_tool_id: request.tool_name,
    local_tool_name: request.tool_name,
    args_schema_hash: null,
    display_args_preview: {},
    argument_visibility: {},
    secrets_redacted: true
  }, { boundary: 'webrtc-frame' }) as unknown as ToolingPrepareExecutionResponse
}

function deniedExecute(request: LocalToolExecuteRequest, status: 'not_found' | 'denied', reason: string, options: LocalToolingProviderOptions): ToolingExecuteToolOutputToolingExecuteToolResponse {
  return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
    ok: false,
    data: null,
    error: status === 'not_found' ? 'Tool not found' : 'Tool execution denied',
    status,
    error_code: reason,
    correlation_id: request.correlation_id ?? null,
    provider_peer_id: options.providerPeerId,
    global_tool_id: request.tool_name,
    policy_decision_id: null,
    display_args_preview: {},
    args_hash: null
  }, { boundary: 'webrtc-frame' }) as ToolingExecuteToolOutputToolingExecuteToolResponse
}

function cancelledExecute(prepared: ToolingPrepareExecutionResponse): ToolingExecuteToolOutputToolingExecuteToolResponse {
  return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
    ok: false,
    data: null,
    error: 'Tool execution cancelled',
    status: 'failed',
    error_code: 'cancelled',
    correlation_id: prepared.correlation_id,
    provider_peer_id: prepared.provider_peer_id,
    global_tool_id: prepared.global_tool_id,
    policy_decision_id: prepared.policy_decision.decision_id,
    display_args_preview: prepared.display_args_preview ?? {},
    args_hash: prepared.args_hash
  }, { boundary: 'webrtc-frame' }) as ToolingExecuteToolOutputToolingExecuteToolResponse
}

function failedExecute(prepared: ToolingPrepareExecutionResponse, reason: 'handler_failed' | 'output_schema_invalid'): ToolingExecuteToolOutputToolingExecuteToolResponse {
  return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
    ok: false,
    data: null,
    error: safeToolError(),
    status: 'failed',
    error_code: reason,
    correlation_id: prepared.correlation_id,
    provider_peer_id: prepared.provider_peer_id,
    global_tool_id: prepared.global_tool_id,
    policy_decision_id: prepared.policy_decision.decision_id,
    display_args_preview: prepared.display_args_preview ?? {},
    args_hash: prepared.args_hash
  }, { boundary: 'webrtc-frame' }) as ToolingExecuteToolOutputToolingExecuteToolResponse
}

async function audit(options: LocalToolingProviderOptions, context: PeerHostCallContext, record: LocalToolAuditRecord): Promise<void> {
  await options.audit({
    ...record,
    method_id: context.methodId,
    connection_epoch: resolveConnectionEpoch(options)
  })
}

function auditFromPrepared(
  action: LocalToolAuditAction,
  prepared: ToolingPrepareExecutionResponse,
  context: PeerHostCallContext,
  options: LocalToolingProviderOptions,
  result: LocalToolAuditResult,
  reasonCode: string | null | undefined
): LocalToolAuditRecord {
  return {
    action,
    result,
    reason_code: reasonCode ?? null,
    provider_peer_id: prepared.provider_peer_id,
    provider_service_instance_id: prepared.provider_service_instance_id,
    caller_peer_id: context.identity.callerPeerId,
    caller_principal_id: context.identity.principalId ?? null,
    method_id: context.methodId,
    global_tool_id: prepared.global_tool_id,
    local_tool_name: prepared.local_tool_name,
    policy_decision_id: prepared.policy_decision.decision_id,
    correlation_id: prepared.correlation_id,
    connection_epoch: resolveConnectionEpoch(options),
    args_hash: prepared.args_hash,
    display_args_preview: prepared.display_args_preview ?? {},
    redacted: true,
    secrets_redacted: true,
    detail: null
  }
}

function auditFromExecuteResponse(
  action: LocalToolAuditAction,
  response: {
    readonly error_code?: string | null | undefined
    readonly correlation_id?: string | null | undefined
    readonly provider_peer_id?: string | null | undefined
    readonly global_tool_id?: string | null | undefined
    readonly policy_decision_id?: string | null | undefined
    readonly display_args_preview?: JsonObject | null | undefined
    readonly args_hash?: string | null | undefined
  },
  request: LocalToolExecuteRequest,
  context: PeerHostCallContext,
  options: LocalToolingProviderOptions,
  result: LocalToolAuditResult,
  detail: JsonObject | null = null
): LocalToolAuditRecord {
  return {
    action,
    result,
    reason_code: response.error_code ?? null,
    provider_peer_id: response.provider_peer_id ?? options.providerPeerId,
    provider_service_instance_id: options.serviceInstanceId,
    caller_peer_id: context.identity.callerPeerId,
    caller_principal_id: context.identity.principalId ?? null,
    method_id: context.methodId,
    global_tool_id: response.global_tool_id ?? request.tool_name,
    local_tool_name: request.tool_name,
    policy_decision_id: response.policy_decision_id ?? null,
    correlation_id: response.correlation_id ?? request.correlation_id ?? context.id,
    connection_epoch: resolveConnectionEpoch(options),
    args_hash: response.args_hash ?? null,
    display_args_preview: response.display_args_preview ?? {},
    redacted: true,
    secrets_redacted: true,
    detail
  }
}

function resolveConnectionEpoch(options: LocalToolingProviderOptions): string | null {
  return typeof options.connectionEpoch === 'function' ? options.connectionEpoch() : (options.connectionEpoch ?? null)
}
