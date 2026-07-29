import {
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  ToolingExecuteToolOutputToolingExecuteToolResponseSchema,
  ToolingGetExportCatalogInputToolingGetExportCatalogRequestSchema,
  ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
  ToolingGetToolsInputToolingGetToolsRequestSchema,
  ToolingGetToolsOutputToolingGetToolsResponseSchema,
  ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema,
  ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema
} from '../generated/backend-contracts.zod.js'
import type { PeerHostCallContext } from '../peer-host/types.js'
import { parseBoundary } from '../validation/index.js'
import { buildLocalToolExportCatalogPage } from './export-catalog.js'
import {
  LocalToolExecutionPolicy,
  safeToolError,
  sanitizeHandlerData,
  type LocalToolExecuteRequest
} from './execution-policy.js'
import { LocalToolRegistry, type LocalToolExecutionContext } from './tool-registry.js'

export interface LocalToolingProviderOptions {
  readonly registry: LocalToolRegistry
  readonly policy: LocalToolExecutionPolicy
  readonly providerPeerId: string
  readonly serviceInstanceId: string
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
      const tools = filterTools(options.registry.publicTools(), request.query ?? null).slice(0, request.top_k ?? 100)
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
      const page = buildLocalToolExportCatalogPage(request, {
        providerPeerId: options.providerPeerId,
        serviceInstanceId: options.serviceInstanceId,
        tools: options.registry.publicTools(),
        context: {
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
      })
      return parseBoundary('Tooling.GetExportCatalog.output.ToolingGetExportCatalogResponse', ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema, page, { boundary: 'webrtc-frame' })
    },

    async prepareExecution(input: unknown, context: PeerHostCallContext) {
      const request = normalizeExecuteRequest(parseBoundary('Tooling.PrepareExecution.input.ToolingPrepareExecutionRequest', ToolingPrepareExecutionInputToolingPrepareExecutionRequestSchema, input, { boundary: 'webrtc-frame' }))
      const entry = options.registry.resolveForDispatch(request.tool_name)
      if (!entry) return deniedPrepare(request, context, 'tool_not_found', options)
      const prepared = await options.policy.prepare(entry, request, executionContext(context))
      return parseBoundary('Tooling.PrepareExecution.output.ToolingPrepareExecutionResponse', ToolingPrepareExecutionOutputToolingPrepareExecutionResponseSchema, prepared, { boundary: 'webrtc-frame' })
    },

    async executeTool(input: unknown, context: PeerHostCallContext) {
      const request = normalizeExecuteRequest(parseBoundary('Tooling.ExecuteTool.input.ToolingExecuteToolRequest', ToolingExecuteToolInputToolingExecuteToolRequestSchema, input, { boundary: 'webrtc-frame' }))
      const entry = options.registry.resolveForDispatch(request.tool_name)
      if (!entry) return deniedExecute(request, 'not_found', 'tool_not_found', options)
      const execution = executionContext(context)
      const prepared = await options.policy.validateForExecute(entry, request, execution)
      if (!prepared.ok || !prepared.policy_decision.allowed) {
        return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: false,
          data: null,
          error: 'Tool execution denied',
          status: request.dry_run ? 'dry_run' : 'denied',
          error_code: prepared.policy_decision.reason ?? 'policy_denied',
          correlation_id: prepared.correlation_id,
          provider_peer_id: prepared.provider_peer_id,
          global_tool_id: prepared.global_tool_id,
          policy_decision_id: prepared.policy_decision.decision_id,
          display_args_preview: prepared.display_args_preview,
          args_hash: prepared.args_hash
        }, { boundary: 'webrtc-frame' })
      }
      if (request.dry_run) {
        return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
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
      }
      if (context.signal.aborted) return cancelledExecute(prepared)
      try {
        const data = await entry.handler({
          arguments: request.arguments,
          signal: context.signal,
          correlationId: prepared.correlation_id,
          context: execution
        })
        if (context.signal.aborted) return cancelledExecute(prepared)
        return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: true,
          data: sanitizeHandlerData(data),
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
      } catch {
        return parseBoundary('Tooling.ExecuteTool.output.ToolingExecuteToolResponse', ToolingExecuteToolOutputToolingExecuteToolResponseSchema, {
          ok: false,
          data: null,
          error: safeToolError(),
          status: 'failed',
          error_code: 'handler_failed',
          correlation_id: prepared.correlation_id,
          provider_peer_id: prepared.provider_peer_id,
          global_tool_id: prepared.global_tool_id,
          policy_decision_id: prepared.policy_decision.decision_id,
          display_args_preview: prepared.display_args_preview,
          args_hash: prepared.args_hash
        }, { boundary: 'webrtc-frame' })
      }
    }
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

function deniedPrepare(request: LocalToolExecuteRequest, context: PeerHostCallContext, reason: string, options: LocalToolingProviderOptions) {
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
  }, { boundary: 'webrtc-frame' })
}

function deniedExecute(request: LocalToolExecuteRequest, status: 'not_found' | 'denied', reason: string, options: LocalToolingProviderOptions) {
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
  }, { boundary: 'webrtc-frame' })
}

function cancelledExecute(prepared: Awaited<ReturnType<LocalToolExecutionPolicy['prepare']>>) {
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
    display_args_preview: prepared.display_args_preview,
    args_hash: prepared.args_hash
  }, { boundary: 'webrtc-frame' })
}
