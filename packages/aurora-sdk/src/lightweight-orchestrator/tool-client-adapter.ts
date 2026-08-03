import type { ToolApprovalConfirmRequest, ToolApprovalConfirmResponse, ToolApprovalRequestResponse } from '../admin.js'
import { ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema } from '../generated/index.js'
import {
  computeProjectionChecksum,
  computeProjectionPageHash,
  LocalToolExecutionPolicy,
  type LocalToolAuditPort,
  type LocalToolExportDecisionPort,
  type LocalToolRegistry
} from '../local-tools/index.js'
import { createLocalToolingProviderHandlers } from '../local-tools/index.js'
import type { PeerHostCallContext } from '../peer-host/types.js'
import { parseToolingExportCatalogPage } from '../tools.js'
import type {
  JsonObject,
  ToolingGetExportCatalogRequest,
  ToolingGetExportCatalogResponse,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
  ToolingProjectionAuthorityRevision,
  ToolingProjectionBlockedTool,
  ToolingProjectionRetirement,
  ToolingProjectionToolInfo
} from '../types.js'
import { parseBoundary } from '../validation/index.js'
import { LightweightOrchestratorError } from './limits.js'
import type { LightweightToolClientPort, LightweightToolExecutionResponse } from './types.js'

export interface LightweightToolClientDelegate {
  getExportCatalog?(payload: ToolingGetExportCatalogRequest): Promise<unknown>
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

export interface OnDeviceLightweightToolPolicyOptions {
  readonly localRegistry: LocalToolRegistry
  readonly providerPeerId?: string | undefined
  readonly serviceInstanceId?: string | undefined
  readonly nowMs?: () => number
  readonly randomToken?: () => string
}

export interface LightweightRemoteProjectionCatalogClient {
  getExportCatalog(payload: ToolingGetExportCatalogRequest): Promise<unknown>
}

export interface LightweightRemoteProjectionCatalogOptions {
  readonly pageSize?: number | undefined
  readonly maxPages?: number | undefined
  readonly lastProjectionRevision?: string | null | undefined
  readonly lastProjectionDigest?: string | null | undefined
}

export interface LightweightRemoteProjectionCatalogSnapshot {
  readonly providerPeerId: string
  readonly serviceInstanceId: string
  readonly authorityRevision: ToolingProjectionAuthorityRevision
  readonly projectionRevision: string
  readonly projectionDigest: string
  readonly tools: readonly ToolingProjectionToolInfo[]
}

interface PendingLocalApproval {
  readonly request: ToolingPrepareExecutionRequest
  readonly prepared: ToolingPrepareExecutionResponse
  readonly context: PeerHostCallContext
  readonly expiresAtMs: number
  used: boolean
}

const LOCAL_APPROVAL_PREFIX = 'local-lw-approval'

/**
 * Build the narrow self-authority used by the on-device assistant.
 *
 * Registry membership is the capability boundary: only tools whose browser or
 * native pack was actually registered can pass tool, capability, and resource
 * checks. The execution policy still enforces caller permissions, argument
 * schemas, confirmation tokens, expiry, and replay protection.
 */
export function createOnDeviceLightweightToolPolicy(
  options: OnDeviceLightweightToolPolicyOptions
): LocalToolExecutionPolicy {
  const entries = options.localRegistry.list()
  const publicTools = options.localRegistry.publicTools()
  const providerPeerId = options.providerPeerId ?? publicTools[0]?.provider_peer_id ?? 'local-peer'
  const serviceInstanceId = options.serviceInstanceId
    ?? publicTools[0]?.provider_service_instance_id
    ?? `local:${providerPeerId}:Tooling`
  const toolContractIds = new Set(entries.map((entry) => entry.descriptor.toolContractId))
  const capabilityIds = new Set(entries.flatMap((entry) => entry.descriptor.nativeRequirements.capabilityIds))
  const resourceScopes = new Set(entries.flatMap((entry) => entry.descriptor.resourceScopes))

  return new LocalToolExecutionPolicy({
    providerPeerId,
    providerServiceInstanceId: serviceInstanceId,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.randomToken ? { randomToken: options.randomToken } : {}),
    ports: {
      hasMethodGrant: (methodId) => methodId === 'Tooling.ExecuteTool',
      hasToolGrant: (toolContractId) => toolContractIds.has(toolContractId),
      hasCapabilityGrant: (capabilityId) => capabilityIds.has(capabilityId),
      hasResourceGrant: (resourceScope) => resourceScopes.has(resourceScope)
    }
  })
}

export function mergeLightweightAssistantTools(
  localTools: readonly ToolingProjectionToolInfo[],
  remoteTools: readonly ToolingProjectionToolInfo[]
): ToolingProjectionToolInfo[] {
  const tools = new Map(localTools.map((tool) => [tool.global_tool_id, tool]))
  for (const tool of remoteTools) {
    if (tool.execution_location !== 'remote' || tool.exportable !== true || tool.provider_available === false) continue
    if (!tools.has(tool.global_tool_id)) tools.set(tool.global_tool_id, tool)
  }
  return [...tools.values()]
}

export function onDeviceAssistantPermissions(localTools: readonly ToolingProjectionToolInfo[]): string[] {
  return [...new Set([
    'Tooling.ExecuteTool',
    ...localTools.flatMap((tool) => tool.required_permissions)
  ])].sort()
}

export async function loadLightweightRemoteProjectionCatalog(
  client: LightweightRemoteProjectionCatalogClient,
  options: LightweightRemoteProjectionCatalogOptions = {}
): Promise<LightweightRemoteProjectionCatalogSnapshot> {
  const pageSize = options.pageSize ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 256) {
    throw new LightweightOrchestratorError('invalid_projection_page_size')
  }
  const maxPages = options.maxPages ?? 32
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new LightweightOrchestratorError('invalid_projection_page_limit')
  }

  const tools: ToolingProjectionToolInfo[] = []
  const blockedTools: ToolingProjectionBlockedTool[] = []
  const retirements: ToolingProjectionRetirement[] = []
  let cursor: string | null | undefined = null
  let firstPage: ToolingGetExportCatalogResponse | null = null

  for (let index = 0; index < maxPages; index += 1) {
    const page = validateProjectionPage(await client.getExportCatalog({
      protocol_tier: 'projection_v1',
      page_size: pageSize,
      cursor,
      last_projection_revision: options.lastProjectionRevision ?? null,
      last_projection_digest: options.lastProjectionDigest ?? null
    }))
    firstPage ??= page
    validateProjectionPageSequence(firstPage, page, index, pageSize)
    tools.push(...page.tools)
    blockedTools.push(...(page.blocked_tools ?? []))
    retirements.push(...page.retirements)
    if (page.complete) {
      const finalChecksum = computeProjectionChecksum(tools, retirements, blockedTools)
      if (page.final_checksum !== finalChecksum || page.projection_digest !== finalChecksum) {
        throw new LightweightOrchestratorError('projection_final_checksum_mismatch')
      }
      if (page.total_count !== tools.length + blockedTools.length) {
        throw new LightweightOrchestratorError('projection_total_count_mismatch')
      }
      return {
        providerPeerId: page.provider_peer_id,
        serviceInstanceId: page.service_instance_id,
        authorityRevision: page.authority_revision,
        projectionRevision: page.projection_revision,
        projectionDigest: page.projection_digest,
        tools: mergeLightweightAssistantTools(
          [],
          tools.map((tool) => bindRemoteProjectionTool(tool, page.provider_peer_id, page.service_instance_id))
        )
      }
    }
    cursor = page.next_cursor
  }
  throw new LightweightOrchestratorError('projection_page_limit_exceeded')
}

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
  const localRegistryMatches = options.localRegistry.publicTools().filter((tool) => toolMatchesPayload(tool, payload))
  const matches = matchingTools(payload, options)
  const hasLocalRegistryMatch = localRegistryMatches.length > 0
  const localMatches = uniqueTools([
    ...matches.filter((tool) => tool.execution_location === 'local'),
    ...localRegistryMatches
  ])
  const remoteMatches = matches.filter((tool) => tool.execution_location === 'remote')

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

function matchingTools(payload: ToolingPrepareExecutionRequest, options: LightweightToolClientAdapterOptions): ToolingProjectionToolInfo[] {
  const tools = options.availableTools ?? options.localRegistry.publicTools()
  return tools.filter((tool) => toolMatchesPayload(tool, payload))
}

function toolMatchesPayload(tool: ToolingProjectionToolInfo, payload: ToolingPrepareExecutionRequest): boolean {
  return toolMatches(tool, payload.tool_name) && selectorMatchesTool(tool, payload)
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

interface ToolRouteSelector {
  readonly executionLocation: 'local' | 'remote' | null
  readonly providerPeerId: string | null
  readonly serviceInstanceId: string | null
  readonly globalToolId: string | null
}

function selectorMatchesTool(tool: ToolingProjectionToolInfo, payload: ToolingPrepareExecutionRequest): boolean {
  const selector = readToolRouteSelector(payload)
  if (selector.executionLocation && tool.execution_location !== selector.executionLocation) return false
  if (selector.providerPeerId && tool.provider_peer_id !== selector.providerPeerId) return false
  if (selector.serviceInstanceId && tool.provider_service_instance_id !== selector.serviceInstanceId) return false
  if (selector.globalToolId && tool.global_tool_id !== selector.globalToolId) return false
  return true
}

function readToolRouteSelector(payload: ToolingPrepareExecutionRequest): ToolRouteSelector {
  const resource = payload.resource_selector
  const mesh = payload.mesh_selector
  return {
    executionLocation: mergeSelectorValue(readExecutionLocation(resource), readExecutionLocation(mesh)),
    providerPeerId: mergeSelectorValue(readStringSelector(resource, 'provider_peer_id'), readStringSelector(mesh, 'provider_peer_id')),
    serviceInstanceId: mergeSelectorValue(readStringSelector(resource, 'provider_service_instance_id'), readStringSelector(mesh, 'provider_service_instance_id')),
    globalToolId: mergeSelectorValue(readStringSelector(resource, 'global_tool_id'), readStringSelector(mesh, 'global_tool_id'))
  }
}

function mergeSelectorValue<T extends string>(left: T | null, right: T | null): T | null {
  if (left && right && left !== right) throw new LightweightOrchestratorError('ambiguous_tool_route')
  return left ?? right
}

function readStringSelector(value: JsonObject | null | undefined, key: string): string | null {
  const raw = value?.[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function uniqueTools(tools: readonly ToolingProjectionToolInfo[]): ToolingProjectionToolInfo[] {
  return [...new Map(tools.map((tool) => [tool.global_tool_id, tool])).values()]
}

function remote(options: LightweightToolClientAdapterOptions): LightweightToolClientDelegate {
  if (!options.remote) throw new LightweightOrchestratorError('remote_tool_delegate_unavailable')
  return options.remote
}

function validateProjectionPage(raw: unknown): ToolingGetExportCatalogResponse {
  const parsed = parseToolingExportCatalogPage(raw)
  if (!parsed.ok) throw new LightweightOrchestratorError(parsed.reasonCode)
  parseBoundary(
    'Tooling.GetExportCatalog.output.ToolingGetExportCatalogResponse',
    ToolingGetExportCatalogOutputToolingGetExportCatalogResponseSchema,
    parsed.page,
    { boundary: 'webrtc-frame' }
  )
  const page = parsed.page
  if (page.page_hash !== computeProjectionPageHash(page)) throw new LightweightOrchestratorError('projection_page_hash_mismatch')
  validateProjectionToolIdentities(page)
  return page
}

function validateProjectionPageSequence(
  firstPage: ToolingGetExportCatalogResponse,
  page: ToolingGetExportCatalogResponse,
  expectedPageIndex: number,
  expectedPageSize: number
): void {
  if (
    page.provider_peer_id !== firstPage.provider_peer_id
    || page.service_instance_id !== firstPage.service_instance_id
    || page.projection_revision !== firstPage.projection_revision
    || page.projection_digest !== firstPage.projection_digest
    || JSON.stringify(page.authority_revision) !== JSON.stringify(firstPage.authority_revision)
    || page.page_index !== expectedPageIndex
    || page.page_size !== expectedPageSize
  ) {
    throw new LightweightOrchestratorError('projection_page_sequence_mismatch')
  }
}

function validateProjectionToolIdentities(page: ToolingGetExportCatalogResponse): void {
  for (const tool of page.tools) validateProjectionToolIdentity(page, tool)
  for (const blocked of page.blocked_tools ?? []) validateProjectionToolIdentity(page, blocked.tool)
}

function validateProjectionToolIdentity(page: ToolingGetExportCatalogResponse, tool: ToolingProjectionToolInfo): void {
  if (
    tool.provider_peer_id !== page.provider_peer_id
    || tool.provider_service_instance_id !== page.service_instance_id
    || tool.provenance.provider_peer_id !== page.provider_peer_id
    || tool.provenance.provider_service_instance_id !== page.service_instance_id
  ) {
    throw new LightweightOrchestratorError('projection_tool_identity_mismatch')
  }
}

/**
 * Translate an authenticated provider-local projection into the receiving
 * device's routing view. Page hashes and the final checksum are intentionally
 * verified before this conversion so consumer-owned fields cannot weaken the
 * signed provider projection.
 */
function bindRemoteProjectionTool(
  tool: ToolingProjectionToolInfo,
  providerPeerId: string,
  serviceInstanceId: string
): ToolingProjectionToolInfo {
  return {
    ...tool,
    provider_peer_id: providerPeerId,
    provider_service_instance_id: serviceInstanceId,
    provider_granted_permissions: null,
    source_type: 'mesh_peer',
    source: 'mesh_peer',
    source_id: `mesh:${providerPeerId}:${safeProjectionSourceSegment(serviceInstanceId)}`,
    trust_tier: 'untrusted',
    execution_location: 'remote',
    provenance: {
      ...tool.provenance,
      provider_peer_id: providerPeerId,
      provider_service_instance_id: serviceInstanceId,
      provider_kind: 'mesh_peer'
    }
  }
}

function safeProjectionSourceSegment(value: string): string {
  return value.trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Tooling'
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
