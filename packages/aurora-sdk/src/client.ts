import { AuthSession } from './session.js'
import { AuroraError } from './errors.js'
import {
  auditFromHeaders,
  captureResult,
  createAuditReceipt,
  normalizeError,
  unsupportedTransport,
  type AuroraResponse,
  type AuroraTransport
} from './transport.js'
import { EventStreamClient, type AuroraEventSubscription, type AuroraSubscribeOptions } from './events.js'
import { AdminActionClient, ApprovalClient } from './admin.js'
import { MemoryClient } from './memory.js'
import {
  AUTH_METHODS,
  describeRegistry,
  GATEWAY_METHODS,
  ORCHESTRATOR_METHODS,
  ORCHESTRATOR_MODEL_METHODS,
  TOOLING_METHODS,
  routePath
} from './descriptors.js'
import { buildAdminOverviewManifest, buildCapabilityGraph, summarizeCapabilities } from './capabilities.js'
import { ConfigClient } from './config.js'
import { buildPermissionCatalog, checkAccess, hasPermission, resolveEffectivePermissions } from './permissions.js'
import { evaluateRoutePolicy } from './policy.js'
import { BackupClient } from './backup.js'
import { SchedulerClient } from './scheduler.js'
import {
  loadToolApprovalCards,
  normalizeToolCatalog,
  submitToolDenialDecision,
  submitToolApprovalDecision,
  type ToolApprovalCardModel,
  type ToolApprovalDenialInput,
  type ToolApprovalDecisionInput,
  type ToolApprovalDecisionResult,
  type ToolCatalogResponse
} from './tools.js'
import { normalizeVoiceRuntimeEvent, VOICE_EVENT_KINDS, VOICE_EVENT_TOPICS } from './voice.js'
import type {
  AdminOverviewManifest,
  AdminOverviewManifestInput,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthPairingConnectRequest,
  AuthPairingConnectResponse,
  AuthPairingApproveRequest,
  AuthPairingApproveResponse,
  AuthPairingDenyRequest,
  AuthPairingDenyResponse,
  AuthPairingExchangeRequest,
  AuthPairingExchangeResponse,
  AuthPairingStartRequest,
  AuthPairingStartResponse,
  AuditLogRequest,
  AuditLogResponse,
  AuthValidateTokenRequest,
  AuthValidateTokenResponse,
  AuthWhoAmIResponse,
  DeviceDeleteRequest,
  DeviceDeleteResponse,
  DeviceListRequest,
  DeviceListResponse,
  AttachmentContextIngestRequest,
  AttachmentContextIngestResponse,
  AssistantSendMessageRequest,
  AssistantSendMessageResult,
  AssistantCancelRequest,
  AssistantStreamMessageRequest,
  AssistantStreamUpdate,
  CapabilityCatalogRequest,
  CapabilityCatalogResponse,
  CapabilityExplanation,
  CapabilityGraph,
  CapabilitySummary,
  DeploymentTopologyResponse,
  GatewaySupportBundleRequest,
  GatewaySupportBundleResponse,
  GetRegistryResponse,
  GetServicesResponse,
  JsonObject,
  GatewayBuiltinRouteDescriptor,
  ListPendingPairingsRequest,
  ListPendingPairingsResponse,
  MeshBoolResponse,
  MeshPeerApproveRequest,
  MeshPeerDenyRequest,
  MeshPeerGetRequest,
  MeshPeerGetResponse,
  MeshPeerListRequest,
  MeshPeerListResponse,
  MeshPeerRemoveRequest,
  MeshPeerUpdatePermissionsRequest,
  MeshStatusResponse,
  MethodDescriptor,
  ModelRuntimeCatalogRequest,
  ModelRuntimeCatalogResponse,
  ModelRuntimeOperationRequest,
  ModelRuntimeOperationResponse,
  ModelRuntimeOperationStatusRequest,
  ModelRuntimeRequest,
  ModelRuntimeResponse,
  NativeCapabilityManifest,
  OrchestratorProcessRequest,
  OrchestratorResponse,
  OrchestratorInterruptRequest,
  OrchestratorInterruptResponse,
  PeerSummary,
  PermissionPatchRequest,
  PermissionPatchResponse,
  PermissionSetRequest,
  PermissionSetResponse,
  PrincipalCreateRequest,
  PrincipalDeleteRequest,
  PrincipalDeleteResponse,
  PrincipalGetRequest,
  PrincipalListRequest,
  PrincipalListResponse,
  PrincipalResponse,
  PrincipalUpdateRequest,
  ContractMethodType,
  RouteExplainRequest,
  RouteExplainResponse,
  RoutePolicyEvaluation,
  RoutePolicyInput,
  TokenListRequest,
  TokenListResponse,
  TokenRevokeRequest,
  TokenRevokeResponse,
  WebRTCDiagnosticsResponse
} from './types.js'
import type { VoiceRuntimeEvent } from './voice.js'
import type {
  EffectivePermissionInput,
  PermissionAccessDecision,
  PermissionCatalogInput,
  PermissionCatalogEntry
} from './permissions.js'

export interface AuroraClientOptions {
  transport: AuroraTransport
  defaultTimeoutMs?: number
}

export class AuroraClient {
  readonly transport: AuroraTransport
  readonly auth: AuthSession
  readonly registry: RegistryClient
  readonly authApi: AuthApiClient
  readonly mesh: MeshClient
  readonly capabilities: CapabilityClient
  readonly adminOverview: AdminOverviewClient
  readonly permissions: PermissionClient
  readonly routes: RouteClient
  readonly assistant: AssistantClient
  readonly models: ModelRuntimeClient
  readonly memory: MemoryClient
  readonly tools: ToolClient
  readonly backups: BackupClient
  readonly scheduler: SchedulerClient
  readonly config: ConfigClient
  readonly diagnostics: DiagnosticsClient
  readonly admin: AdminActionClient
  readonly approvals: ApprovalClient
  readonly native: NativeClient
  readonly events: EventStreamClient
  private readonly defaultTimeoutMs: number

  constructor(options: AuroraClientOptions) {
    this.transport = options.transport
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.auth = new AuthSession()
    this.registry = new RegistryClient(this)
    this.authApi = new AuthApiClient(this)
    this.mesh = new MeshClient(this)
    this.capabilities = new CapabilityClient(this)
    this.adminOverview = new AdminOverviewClient(this)
    this.permissions = new PermissionClient(this)
    this.routes = new RouteClient(this)
    this.assistant = new AssistantClient(this)
    this.models = new ModelRuntimeClient(this)
    this.memory = new MemoryClient(this)
    this.tools = new ToolClient(this)
    this.backups = new BackupClient(this)
    this.scheduler = new SchedulerClient(this)
    this.config = new ConfigClient(this)
    this.diagnostics = new DiagnosticsClient(this)
    this.admin = new AdminActionClient(this)
    this.approvals = new ApprovalClient(this)
    this.native = new NativeClient(this)
    this.events = new EventStreamClient(this.transport)
  }

  async request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options: { path?: string; busTopic?: string; httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; timeoutMs?: number; headers?: Record<string, string> } = {}
  ): Promise<TData> {
    try {
      const response = await this.transport.request<TData, TPayload>({
        method,
        busTopic: options.busTopic ?? method,
        path: options.path,
        httpMethod: options.httpMethod,
        payload,
        headers: options.headers,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs
      })
      return response.data
    } catch (error) {
      this.auth.applyError(normalizeError(error))
      throw error
    }
  }

  async requestResult<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options: { path?: string; busTopic?: string; httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; timeoutMs?: number; headers?: Record<string, string> } = {}
  ): Promise<AuroraResponse<TData>> {
    const busTopic = options.busTopic ?? method
    try {
      const response = await this.transport.request<TData, TPayload>({
        method,
        busTopic,
        path: options.path,
        httpMethod: options.httpMethod,
        payload,
        headers: options.headers,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs
      })
      return {
        ok: true,
        data: response.data,
        audit: createAuditReceipt(response.data, {
          ...auditFromHeaders(response.headers),
          ...response.audit,
          method,
          busTopic,
          transport: this.transport.kind
        })
      }
    } catch (error) {
      const normalized = normalizeError(error)
      this.auth.applyError(normalized)
      return {
        ok: false,
        error: normalized,
        audit: createAuditReceipt(normalized.detail, {
          correlationId: normalized.correlationId ?? null,
          method: normalized.method ?? method,
          busTopic: normalized.busTopic ?? busTopic,
          status: normalized.code,
          transport: this.transport.kind
        })
      }
    }
  }

  result<TData>(operation: () => Promise<TData>): Promise<AuroraResponse<TData>> {
    return captureResult(operation, { transport: this.transport.kind })
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    options: AuroraSubscribeOptions<TPayload> = {}
  ): AuroraEventSubscription<TEventPayload> {
    return this.events.subscribe<TEventPayload, TPayload>(options)
  }
}

export class AuthApiClient {
  constructor(private readonly client: AuroraClient) {}

  async login(payload: AuthLoginRequest): Promise<AuroraResponse<AuthLoginResponse>> {
    const result = await this.client.requestResult<AuthLoginResponse, AuthLoginRequest>(
      AUTH_METHODS.login,
      payload,
      { path: routePath('Auth', 'Login') }
    )
    if (result.ok) this.client.auth.updateFromLogin(result.data)
    return result
  }

  async validateToken(payload: AuthValidateTokenRequest): Promise<AuroraResponse<AuthValidateTokenResponse>> {
    const result = await this.client.requestResult<AuthValidateTokenResponse, AuthValidateTokenRequest>(
      AUTH_METHODS.validateToken,
      payload,
      { path: routePath('Auth', 'ValidateToken') }
    )
    if (result.ok) this.client.auth.updateFromTokenValidation(result.data)
    return result
  }

  async whoAmI(): Promise<AuroraResponse<AuthWhoAmIResponse>> {
    const result = await this.client.requestResult<AuthWhoAmIResponse>(
      AUTH_METHODS.whoAmI,
      undefined,
      { path: routePath('Auth', 'WhoAmI') }
    )
    if (result.ok) this.client.auth.updateFromWhoAmI(result.data)
    return result
  }

  pairingStart(payload: AuthPairingStartRequest): Promise<AuroraResponse<AuthPairingStartResponse>> {
    return this.client.requestResult<AuthPairingStartResponse, AuthPairingStartRequest>(
      AUTH_METHODS.pairingStart,
      payload,
      { path: routePath('Auth', 'PairingStart') }
    )
  }

  pairingConnect(payload: AuthPairingConnectRequest): Promise<AuroraResponse<AuthPairingConnectResponse>> {
    return this.client.requestResult<AuthPairingConnectResponse, AuthPairingConnectRequest>(
      AUTH_METHODS.pairingConnect,
      payload,
      { path: routePath('Auth', 'PairingConnect') }
    )
  }

  async pairingExchange(payload: AuthPairingExchangeRequest): Promise<AuroraResponse<AuthPairingExchangeResponse>> {
    const result = await this.client.requestResult<AuthPairingExchangeResponse, AuthPairingExchangeRequest>(
      AUTH_METHODS.pairingExchange,
      payload,
      { path: routePath('Auth', 'PairingExchange') }
    )
    if (result.ok) this.client.auth.updateFromPairingExchange(result.data)
    return result
  }

  listPendingPairings(
    payload: ListPendingPairingsRequest = {}
  ): Promise<AuroraResponse<ListPendingPairingsResponse>> {
    return this.client.requestResult<ListPendingPairingsResponse, ListPendingPairingsRequest>(
      AUTH_METHODS.listPendingPairings,
      payload,
      { path: routePath('Auth', 'ListPendingPairings') }
    )
  }

  pairingApprove(payload: AuthPairingApproveRequest): Promise<AuroraResponse<AuthPairingApproveResponse>> {
    return this.client.requestResult<AuthPairingApproveResponse, AuthPairingApproveRequest>(
      AUTH_METHODS.pairingApprove,
      payload,
      { path: routePath('Auth', 'PairingApprove') }
    )
  }

  pairingDeny(payload: AuthPairingDenyRequest): Promise<AuroraResponse<AuthPairingDenyResponse>> {
    return this.client.requestResult<AuthPairingDenyResponse, AuthPairingDenyRequest>(
      AUTH_METHODS.pairingDeny,
      payload,
      { path: routePath('Auth', 'PairingDeny') }
    )
  }

  listPrincipals(payload: PrincipalListRequest = {}): Promise<AuroraResponse<PrincipalListResponse>> {
    return this.client.requestResult<PrincipalListResponse, PrincipalListRequest>(
      AUTH_METHODS.listPrincipals,
      payload,
      { path: routePath('Auth', 'ListPrincipals') }
    )
  }

  createPrincipal(payload: PrincipalCreateRequest): Promise<AuroraResponse<PrincipalResponse>> {
    return this.client.requestResult<PrincipalResponse, PrincipalCreateRequest>(
      AUTH_METHODS.createPrincipal,
      payload,
      { path: routePath('Auth', 'CreatePrincipal') }
    )
  }

  getPrincipal(payload: PrincipalGetRequest): Promise<AuroraResponse<PrincipalResponse>> {
    return this.client.requestResult<PrincipalResponse, PrincipalGetRequest>(
      AUTH_METHODS.getPrincipal,
      payload,
      { path: routePath('Auth', 'GetPrincipal') }
    )
  }

  updatePrincipal(payload: PrincipalUpdateRequest): Promise<AuroraResponse<PrincipalResponse>> {
    return this.client.requestResult<PrincipalResponse, PrincipalUpdateRequest>(
      AUTH_METHODS.updatePrincipal,
      payload,
      { path: routePath('Auth', 'UpdatePrincipal') }
    )
  }

  deletePrincipal(payload: PrincipalDeleteRequest): Promise<AuroraResponse<PrincipalDeleteResponse>> {
    return this.client.requestResult<PrincipalDeleteResponse, PrincipalDeleteRequest>(
      AUTH_METHODS.deletePrincipal,
      payload,
      { path: routePath('Auth', 'DeletePrincipal') }
    )
  }

  setPermissions(payload: PermissionSetRequest): Promise<AuroraResponse<PermissionSetResponse>> {
    return this.client.requestResult<PermissionSetResponse, PermissionSetRequest>(
      AUTH_METHODS.setPermissions,
      payload,
      { path: routePath('Auth', 'SetPermissions') }
    )
  }

  patchPermissions(payload: PermissionPatchRequest): Promise<AuroraResponse<PermissionPatchResponse>> {
    return this.client.requestResult<PermissionPatchResponse, PermissionPatchRequest>(
      AUTH_METHODS.patchPermissions,
      payload,
      { path: routePath('Auth', 'PatchPermissions') }
    )
  }

  listTokens(payload: TokenListRequest = {}): Promise<AuroraResponse<TokenListResponse>> {
    return this.client.requestResult<TokenListResponse, TokenListRequest>(
      AUTH_METHODS.listTokens,
      payload,
      { path: routePath('Auth', 'ListTokens') }
    )
  }

  revokeToken(payload: TokenRevokeRequest): Promise<AuroraResponse<TokenRevokeResponse>> {
    return this.client.requestResult<TokenRevokeResponse, TokenRevokeRequest>(
      AUTH_METHODS.revokeToken,
      payload,
      { path: routePath('Auth', 'RevokeToken') }
    )
  }

  listDevices(payload: DeviceListRequest = {}): Promise<AuroraResponse<DeviceListResponse>> {
    return this.client.requestResult<DeviceListResponse, DeviceListRequest>(
      AUTH_METHODS.listDevices,
      payload,
      { path: routePath('Auth', 'ListDevices') }
    )
  }

  deleteDevice(payload: DeviceDeleteRequest): Promise<AuroraResponse<DeviceDeleteResponse>> {
    return this.client.requestResult<DeviceDeleteResponse, DeviceDeleteRequest>(
      AUTH_METHODS.deleteDevice,
      payload,
      { path: routePath('Auth', 'DeleteDevice') }
    )
  }

  auditLog(payload: AuditLogRequest = {}): Promise<AuroraResponse<AuditLogResponse>> {
    return this.client.requestResult<AuditLogResponse, AuditLogRequest>(
      AUTH_METHODS.auditLog,
      payload,
      { path: routePath('Auth', 'AuditLog') }
    )
  }
}

export class MeshClient {
  constructor(private readonly client: AuroraClient) {}

  getStatus(): Promise<AuroraResponse<MeshStatusResponse>> {
    return this.client.requestResult<MeshStatusResponse>(
      GATEWAY_METHODS.getMeshStatus,
      undefined,
      { path: routePath('Gateway', 'GetMeshStatus') }
    )
  }

  listPeers(payload: MeshPeerListRequest = {}): Promise<AuroraResponse<MeshPeerListResponse>> {
    return this.client.requestResult<MeshPeerListResponse, MeshPeerListRequest>(
      AUTH_METHODS.meshListPeers,
      payload,
      { path: routePath('Auth', 'MeshListPeers') }
    )
  }

  getPeer(payload: MeshPeerGetRequest): Promise<AuroraResponse<MeshPeerGetResponse>> {
    return this.client.requestResult<MeshPeerGetResponse, MeshPeerGetRequest>(
      AUTH_METHODS.meshGetPeer,
      payload,
      { path: routePath('Auth', 'MeshGetPeer') }
    )
  }

  approvePeer(payload: MeshPeerApproveRequest): Promise<AuroraResponse<MeshBoolResponse>> {
    return this.client.requestResult<MeshBoolResponse, MeshPeerApproveRequest>(
      AUTH_METHODS.meshApprovePeer,
      payload,
      { path: routePath('Auth', 'MeshApprovePeer') }
    )
  }

  denyPeer(payload: MeshPeerDenyRequest): Promise<AuroraResponse<MeshBoolResponse>> {
    return this.client.requestResult<MeshBoolResponse, MeshPeerDenyRequest>(
      AUTH_METHODS.meshDenyPeer,
      payload,
      { path: routePath('Auth', 'MeshDenyPeer') }
    )
  }

  updatePeerPermissions(
    payload: MeshPeerUpdatePermissionsRequest
  ): Promise<AuroraResponse<MeshBoolResponse>> {
    return this.client.requestResult<MeshBoolResponse, MeshPeerUpdatePermissionsRequest>(
      AUTH_METHODS.meshUpdatePeerPermissions,
      payload,
      { path: routePath('Auth', 'MeshUpdatePeerPermissions') }
    )
  }

  removePeer(payload: MeshPeerRemoveRequest): Promise<AuroraResponse<MeshBoolResponse>> {
    return this.client.requestResult<MeshBoolResponse, MeshPeerRemoveRequest>(
      AUTH_METHODS.meshRemovePeer,
      payload,
      { path: routePath('Auth', 'MeshRemovePeer') }
    )
  }
}

export class RegistryClient {
  constructor(private readonly client: AuroraClient) {}

  getRegistry(): Promise<GetRegistryResponse> {
    return this.client.request<GetRegistryResponse>(GATEWAY_METHODS.getRegistry, undefined, {
      path: '/api/registry',
      httpMethod: 'GET'
    })
  }

  async listMethods(): Promise<MethodDescriptor[]> {
    return describeRegistry(await this.getRegistry())
  }

  listServices(): Promise<GetServicesResponse> {
    return this.client.request<GetServicesResponse>(GATEWAY_METHODS.getServices, undefined, {
      path: '/api/services',
      httpMethod: 'GET'
    })
  }

  getDeploymentTopology(): Promise<DeploymentTopologyResponse> {
    return this.client.request<DeploymentTopologyResponse>(GATEWAY_METHODS.getDeploymentTopology, undefined, {
      path: routePath('Gateway', 'GetDeploymentTopology')
    })
  }

  getWebRTCDiagnostics(): Promise<WebRTCDiagnosticsResponse> {
    return this.client.request<WebRTCDiagnosticsResponse>(GATEWAY_METHODS.getWebRTCDiagnostics, undefined, {
      path: routePath('Gateway', 'GetWebRTCDiagnostics')
    })
  }
}

export class CapabilityClient {
  constructor(private readonly client: AuroraClient) {}

  listCatalog(request: CapabilityCatalogRequest = {}): Promise<CapabilityCatalogResponse> {
    return this.client.request<CapabilityCatalogResponse, CapabilityCatalogRequest>(
      GATEWAY_METHODS.getCapabilityCatalog,
      request,
      { path: routePath('Gateway', 'GetCapabilityCatalog') }
    )
  }

  async listSummaries(request: CapabilityCatalogRequest = {}): Promise<CapabilitySummary[]> {
    return summarizeCapabilities(await this.listCatalog(request))
  }

  async getGraph(
    request: CapabilityCatalogRequest = { include_unavailable: true, include_internal: true }
  ): Promise<CapabilityGraph> {
    const [catalog, registry] = await Promise.all([
      this.listCatalog(request),
      this.client.registry.getRegistry()
    ])
    return buildCapabilityGraph({
      catalog,
      registry,
      transportKind: this.client.transport.kind
    })
  }

  async explain(featureId: string): Promise<CapabilityExplanation> {
    return (await this.getGraph()).explain(featureId)
  }
}

export interface PermissionCatalogOptions {
  gatewayBuiltins?: GatewayBuiltinRouteDescriptor[]
}

export class PermissionClient {
  constructor(private readonly client: AuroraClient) {}

  async listCatalog(options: PermissionCatalogOptions = {}): Promise<PermissionCatalogEntry[]> {
    const input: PermissionCatalogInput = {
      methods: await this.client.registry.listMethods(),
      source: 'registry'
    }
    if (options.gatewayBuiltins !== undefined) input.gatewayBuiltins = options.gatewayBuiltins
    return buildPermissionCatalog(input)
  }

  has(permission: string, methodType: ContractMethodType | null = null): boolean {
    return hasPermission(permission, this.client.auth.snapshot().effectivePermissions, methodType)
  }

  check(requiredPermissions: string[], methodType: ContractMethodType | null = null): PermissionAccessDecision {
    return checkAccess(this.client.auth.snapshot().effectivePermissions, requiredPermissions, methodType)
  }

  resolveEffective(input: EffectivePermissionInput): string[] {
    return resolveEffectivePermissions(input)
  }
}

export class RouteClient {
  constructor(private readonly client: AuroraClient) {}

  explain(request: RouteExplainRequest): Promise<RouteExplainResponse> {
    return this.client.request<RouteExplainResponse, RouteExplainRequest>(
      GATEWAY_METHODS.explainRoute,
      request,
      { path: routePath('Gateway', 'ExplainRoute') }
    )
  }

  async evaluatePolicy(input: Omit<RoutePolicyInput, 'route' | 'catalog' | 'transportKind'> & {
    route?: RouteExplainResponse
    catalog?: RoutePolicyInput['catalog']
    routeRequest?: RouteExplainRequest
  }): Promise<RoutePolicyEvaluation> {
    const fallbackRouteRequest: RouteExplainRequest = {}
    if (input.topic !== undefined) fallbackRouteRequest.topic = input.topic
    if (input.method !== undefined) fallbackRouteRequest.method = input.method
    if (input.selector !== undefined) fallbackRouteRequest.selector = input.selector
    const route = input.route ?? await this.explain(input.routeRequest ?? fallbackRouteRequest)
    const catalog = input.catalog ?? await this.client.capabilities.listCatalog({ include_unavailable: true })
    return evaluateRoutePolicy({
      ...input,
      route,
      catalog,
      transportKind: this.client.transport.kind
    })
  }
}

export class AssistantClient {
  constructor(private readonly client: AuroraClient) {}

  ingestContext(
    input: AttachmentContextIngestRequest
  ): Promise<AuroraResponse<AttachmentContextIngestResponse>> {
    return this.client.requestResult<AttachmentContextIngestResponse, AttachmentContextIngestRequest>(
      ORCHESTRATOR_METHODS.ingestContext,
      input,
      { path: routePath('Orchestrator', 'IngestContext') }
    )
  }

  async sendMessage(input: AssistantSendMessageRequest): Promise<AuroraResponse<AssistantSendMessageResult>> {
    const text = input.text.trim()
    if (!text) {
      return this.client.result<AssistantSendMessageResult>(() => {
        throw new AuroraError({
          code: 'validation',
          message: 'Assistant message text is required.',
          method: ORCHESTRATOR_METHODS.externalUserInput,
          busTopic: ORCHESTRATOR_METHODS.externalUserInput
        })
      })
    }

    const payload: OrchestratorProcessRequest = {
      text,
      source: 'external'
    }
    if (input.sessionId !== undefined) payload.session_id = input.sessionId

    const requestOptions: { path: string; timeoutMs?: number } = {
      path: routePath('Orchestrator', 'ExternalUserInput')
    }
    if (input.timeoutMs !== undefined) requestOptions.timeoutMs = input.timeoutMs

    const response = await this.client.requestResult<OrchestratorResponse, OrchestratorProcessRequest>(
      ORCHESTRATOR_METHODS.externalUserInput,
      payload,
      requestOptions
    )

    if (!response.ok) return response

    const sessionId = response.data.session_id ?? input.sessionId ?? stableSessionId()
    return {
      ok: true,
      audit: response.audit,
      data: {
        sessionId,
        response: {
          id: response.audit.correlationId ?? `assistant-${Date.now()}`,
          role: 'assistant',
          text: response.data.text,
          createdAt: new Date().toISOString()
        },
        routePolicy: input.routePolicy ?? null,
        modelLabel: metadataString(response.data.metadata, 'model') ?? metadataString(response.data.metadata, 'provider'),
        privacyClass: input.routePolicy?.privacyClass ?? 'personal',
        metadata: response.data.metadata ?? {}
      }
    }
  }

  async *streamMessage(input: AssistantStreamMessageRequest): AsyncIterable<AssistantStreamUpdate> {
    const text = input.text.trim()
    if (!text) {
      yield streamFailure(
        new AuroraError({
          code: 'validation',
          message: 'Assistant message text is required.',
          method: ORCHESTRATOR_METHODS.externalUserInput,
          busTopic: ORCHESTRATOR_METHODS.externalUserInput
        }),
        this.client.transport.kind
      )
      return
    }

    const payload: OrchestratorProcessRequest = {
      text,
      source: 'external'
    }
    if (input.sessionId !== undefined) payload.session_id = input.sessionId

    let sawEvent = false
    try {
      const stream = this.client.events.streamAssistant<Record<string, unknown>, OrchestratorProcessRequest>(payload, {
        signal: input.signal,
        lastEventId: input.lastEventId ?? null,
        replayFrom: input.replayFrom ?? input.lastEventId ?? null,
        reconnect: { maxAttempts: 1, initialDelayMs: 250, maxDelayMs: 1_000 },
        audit: {
          method: ORCHESTRATOR_METHODS.externalUserInput,
          busTopic: ORCHESTRATOR_METHODS.externalUserInput,
          transport: this.client.transport.kind
        }
      })
      for await (const event of stream) {
        sawEvent = true
        yield assistantStreamUpdateFromEvent(event)
      }
    } catch (error) {
      const normalized = normalizeError(error)
      this.client.auth.applyError(normalized)
      if (input.signal?.aborted) return
      if (sawEvent) {
        yield streamFailure(normalized, this.client.transport.kind, 'transport_lost')
        return
      }

      const fallback = await this.sendMessage(input)
      if (fallback.ok) {
        yield {
          kind: 'fallback',
          eventId: fallback.data.response.id,
          sessionId: fallback.data.sessionId,
          text: fallback.data.response.text,
          textDelta: fallback.data.response.text,
          modelLabel: fallback.data.modelLabel,
          error: null,
          audit: fallback.audit,
          metadata: fallback.data.metadata
        }
        return
      }
      yield streamFailure(fallback.error, this.client.transport.kind, 'fallback')
    }
  }

  async *streamVoiceEvents(
    options: AuroraSubscribeOptions = {}
  ): AsyncIterable<VoiceRuntimeEvent> {
    const stream = this.client.events.subscribe<unknown>({
      stream: 'voice',
      topics: [...VOICE_EVENT_TOPICS],
      kinds: [...VOICE_EVENT_KINDS],
      reconnect: { maxAttempts: 1, initialDelayMs: 250, maxDelayMs: 1_000 },
      ...options,
      audit: {
        ...options.audit,
        transport: this.client.transport.kind
      }
    })
    for await (const event of stream) {
      const normalized = normalizeVoiceRuntimeEvent(event)
      if (normalized) yield normalized
    }
  }

  cancel(input: AssistantCancelRequest = {}): Promise<AuroraResponse<OrchestratorInterruptResponse>> {
    const payload: OrchestratorInterruptRequest = {
      scopes: input.scopes ?? ['generation', 'tool_call', 'tts_playback', 'session'],
      reason: input.reason ?? 'user_interrupt'
    }
    if (input.sessionId !== undefined) payload.session_id = input.sessionId
    if (input.requestId !== undefined) payload.request_id = input.requestId
    return this.client.requestResult<OrchestratorInterruptResponse, OrchestratorInterruptRequest>(
      ORCHESTRATOR_METHODS.interrupt,
      payload,
      { path: routePath('Orchestrator', 'Interrupt') }
    )
  }
}

export interface AdminOverviewManifestOptions {
  gatewayBuiltins?: GatewayBuiltinRouteDescriptor[]
  deploymentTopology?: DeploymentTopologyResponse | null
  nativeManifest?: NativeCapabilityManifest | null
  peers?: PeerSummary[]
  generatedAt?: string
}

function metadataString(metadata: OrchestratorResponse['metadata'] | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function assistantStreamUpdateFromEvent(event: import('./types.js').AuroraEvent<Record<string, unknown>>): AssistantStreamUpdate {
  const payload = event.payload ?? {}
  const text = streamText(payload)
  const metadata = streamMetadata(payload)
  const sessionId = streamString(payload, 'session_id', 'sessionId') ?? null
  const modelLabel = metadataString(metadata, 'model') ?? metadataString(metadata, 'provider')
  if (event.kind === 'assistant.completed') {
    return {
      kind: 'completed',
      eventId: event.id,
      sessionId,
      text,
      textDelta: text,
      modelLabel,
      error: null,
      audit: event.audit,
      metadata
    }
  }
  if (event.kind === 'assistant.failed') {
    return {
      kind: 'failed',
      eventId: event.id,
      sessionId,
      text,
      textDelta: '',
      modelLabel,
      error: new AuroraError({
        code: 'unavailable_service',
        message: text || 'Assistant stream failed.',
        detail: payload,
        correlationId: event.audit.correlationId ?? undefined,
        method: event.method ?? ORCHESTRATOR_METHODS.externalUserInput,
        busTopic: event.busTopic ?? ORCHESTRATOR_METHODS.externalUserInput
      }),
      audit: event.audit,
      metadata
    }
  }
  if (event.kind.startsWith('tool.')) {
    return {
      kind: 'tool',
      eventId: event.id,
      sessionId,
      text,
      textDelta: '',
      modelLabel,
      error: null,
      audit: event.audit,
      metadata
    }
  }
  return {
    kind: 'delta',
    eventId: event.id,
    sessionId,
    text,
    textDelta: streamString(payload, 'delta', 'text_delta', 'textDelta') ?? text,
    modelLabel,
    error: null,
    audit: event.audit,
    metadata
  }
}

function streamFailure(
  error: AuroraError,
  transport: string,
  kind: 'failed' | 'transport_lost' | 'fallback' = 'failed'
): AssistantStreamUpdate {
  return {
    kind,
    eventId: null,
    sessionId: null,
    text: error.message,
    textDelta: '',
    modelLabel: null,
    error,
    audit: createAuditReceipt(error.detail, {
      correlationId: error.correlationId ?? null,
      method: error.method ?? ORCHESTRATOR_METHODS.externalUserInput,
      busTopic: error.busTopic ?? ORCHESTRATOR_METHODS.externalUserInput,
      status: error.code,
      transport
    }),
    metadata: {}
  }
}

function streamText(payload: Record<string, unknown>): string {
  return streamString(payload, 'text', 'content', 'message', 'delta', 'text_delta', 'textDelta') ?? ''
}

function streamMetadata(payload: Record<string, unknown>): Record<string, import('./types.js').JsonValue | undefined> {
  const metadata = payload.metadata
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, import('./types.js').JsonValue | undefined>
    : {}
}

function streamString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function stableSessionId(): string {
  return `assistant-session-${Date.now().toString(36)}`
}

export class AdminOverviewClient {
  constructor(private readonly client: AuroraClient) {}

  async getManifest(options: AdminOverviewManifestOptions = {}): Promise<AdminOverviewManifest> {
    const [registry, services, capabilityCatalog, topologyResult] = await Promise.all([
      this.client.registry.getRegistry(),
      this.client.registry.listServices(),
      this.client.capabilities.listCatalog({ include_internal: true, include_unavailable: true }),
      options.deploymentTopology !== undefined
        ? Promise.resolve<AuroraResponse<DeploymentTopologyResponse>>(
            options.deploymentTopology
              ? {
                  ok: true,
                  data: options.deploymentTopology,
                  audit: createAuditReceipt(options.deploymentTopology, {
                    method: GATEWAY_METHODS.getDeploymentTopology,
                    busTopic: GATEWAY_METHODS.getDeploymentTopology,
                    transport: this.client.transport.kind
                  })
                }
              : {
                  ok: false,
                  error: new AuroraError({
                    code: 'unsupported_feature',
                    message: 'Deployment topology evidence was not provided',
                    method: GATEWAY_METHODS.getDeploymentTopology,
                    busTopic: GATEWAY_METHODS.getDeploymentTopology
                  }),
                  audit: createAuditReceipt(null, {
                    method: GATEWAY_METHODS.getDeploymentTopology,
                    busTopic: GATEWAY_METHODS.getDeploymentTopology,
                    transport: this.client.transport.kind,
                    status: 'unsupported_feature'
                  })
                }
          )
        : this.client.requestResult<DeploymentTopologyResponse>(
            GATEWAY_METHODS.getDeploymentTopology,
            undefined,
            {
              path: routePath('Gateway', 'GetDeploymentTopology')
            }
          )
    ])
    const input: AdminOverviewManifestInput = {
      registry,
      services,
      capabilityCatalog,
      deploymentTopology: topologyResult.ok ? topologyResult.data : null,
      deploymentTopologyError: topologyResult.ok ? null : topologyResult.error.message
    }
    if (options.gatewayBuiltins !== undefined) input.gatewayBuiltins = options.gatewayBuiltins
    if (options.nativeManifest !== undefined) input.nativeManifest = options.nativeManifest
    if (options.peers !== undefined) input.peers = options.peers
    if (options.generatedAt !== undefined) input.generatedAt = options.generatedAt
    return buildAdminOverviewManifest(input)
  }
}

export class ToolClient {
  constructor(private readonly client: AuroraClient) {}

  listCatalog<TResponse = ToolCatalogResponse>(request: Record<string, unknown> = {}): Promise<TResponse> {
    return this.client.request<TResponse>(TOOLING_METHODS.listCatalog, request, {
      path: routePath('Tooling', 'GetToolCatalog')
    })
  }

  async listApprovalCards(request: Record<string, unknown> = {}): Promise<ToolApprovalCardModel[]> {
    const catalog = await this.listCatalog<ToolCatalogResponse>(request)
    return normalizeToolCatalog(catalog, { transportKind: this.client.transport.kind })
  }

  loadApprovalCards(): Promise<AuroraResponse<ToolApprovalCardModel[]>> {
    return loadToolApprovalCards(this.client)
  }

  submitApprovalDecision(input: ToolApprovalDecisionInput): Promise<ToolApprovalDecisionResult> {
    return submitToolApprovalDecision(this.client, input)
  }

  submitDenialDecision(input: ToolApprovalDenialInput): Promise<ToolApprovalDecisionResult> {
    return submitToolDenialDecision(this.client, input)
  }

  prepareExecution<TResponse = unknown, TPayload = unknown>(payload: TPayload): Promise<TResponse> {
    return this.client.request<TResponse, TPayload>(TOOLING_METHODS.prepareExecution, payload, {
      path: routePath('Tooling', 'PrepareExecution')
    })
  }

  requestApproval<TResponse = unknown, TPayload = unknown>(payload: TPayload): Promise<TResponse> {
    return this.client.request<TResponse, TPayload>(TOOLING_METHODS.requestApproval, payload, {
      path: routePath('Tooling', 'RequestApproval')
    })
  }

  confirmExecution<TResponse = unknown, TPayload = unknown>(payload: TPayload): Promise<TResponse> {
    return this.client.request<TResponse, TPayload>(TOOLING_METHODS.confirmExecution, payload, {
      path: routePath('Tooling', 'ConfirmExecution')
    })
  }

  execute<TResponse = unknown, TPayload = unknown>(payload: TPayload): Promise<TResponse> {
    return this.client.request<TResponse, TPayload>(TOOLING_METHODS.executeTool, payload, {
      path: routePath('Tooling', 'ExecuteTool')
    })
  }
}

export class ModelRuntimeClient {
  constructor(private readonly client: AuroraClient) {}

  listCatalog(request: ModelRuntimeCatalogRequest = {}): Promise<ModelRuntimeCatalogResponse> {
    return this.client.request<ModelRuntimeCatalogResponse, ModelRuntimeCatalogRequest>(
      ORCHESTRATOR_MODEL_METHODS.getCatalog,
      request,
      { path: routePath('Orchestrator', 'GetModelCatalog') }
    )
  }

  getRuntime(request: ModelRuntimeRequest = {}): Promise<ModelRuntimeResponse> {
    return this.client.request<ModelRuntimeResponse, ModelRuntimeRequest>(
      ORCHESTRATOR_MODEL_METHODS.getRuntime,
      request,
      { path: routePath('Orchestrator', 'GetModelRuntime') }
    )
  }

  importModel(request: ModelRuntimeOperationRequest): Promise<AuroraResponse<ModelRuntimeOperationResponse>> {
    return this.client.requestResult<ModelRuntimeOperationResponse, ModelRuntimeOperationRequest>(
      ORCHESTRATOR_MODEL_METHODS.importModel,
      request,
      { path: routePath('Orchestrator', 'ImportModel') }
    )
  }

  downloadModel(request: ModelRuntimeOperationRequest): Promise<AuroraResponse<ModelRuntimeOperationResponse>> {
    return this.client.requestResult<ModelRuntimeOperationResponse, ModelRuntimeOperationRequest>(
      ORCHESTRATOR_MODEL_METHODS.downloadModel,
      request,
      { path: routePath('Orchestrator', 'DownloadModel') }
    )
  }

  benchmarkModel(request: ModelRuntimeOperationRequest): Promise<AuroraResponse<ModelRuntimeOperationResponse>> {
    return this.client.requestResult<ModelRuntimeOperationResponse, ModelRuntimeOperationRequest>(
      ORCHESTRATOR_MODEL_METHODS.benchmarkModel,
      request,
      { path: routePath('Orchestrator', 'BenchmarkModel') }
    )
  }

  getOperation(
    request: ModelRuntimeOperationStatusRequest
  ): Promise<AuroraResponse<ModelRuntimeOperationResponse>> {
    return this.client.requestResult<ModelRuntimeOperationResponse, ModelRuntimeOperationStatusRequest>(
      ORCHESTRATOR_MODEL_METHODS.getOperation,
      request,
      { path: routePath('Orchestrator', 'GetModelOperation') }
    )
  }
}

export class DiagnosticsClient {
  constructor(private readonly client: AuroraClient) {}

  getSupportBundle(
    request: GatewaySupportBundleRequest = {}
  ): Promise<AuroraResponse<GatewaySupportBundleResponse>> {
    return this.client.requestResult<GatewaySupportBundleResponse, GatewaySupportBundleRequest>(
      GATEWAY_METHODS.getSupportBundle,
      request,
      { path: routePath('Gateway', 'GetSupportBundle') }
    )
  }

  exportSupportBundle(input: {
    request?: GatewaySupportBundleRequest
    reason: string
    reauthConfirmed: boolean
    phrase?: string
    affectedResources?: string[]
    timeoutMs?: number
  }): Promise<{
    draft: import('./admin.js').AdminActionDraftResponse
    confirmation: import('./admin.js').AdminActionConfirmResponse
    data: GatewaySupportBundleResponse
  }> {
    const executeInput: Parameters<AdminActionClient['execute']>[0] = {
      methodId: GATEWAY_METHODS.getSupportBundle,
      payload: supportBundlePayload(input.request),
      reason: input.reason,
      reauthConfirmed: input.reauthConfirmed,
      affectedResources: input.affectedResources ?? [
        'diagnostics.support_bundle',
        'diagnostics.redaction_preview',
        'diagnostics.audit_receipt'
      ],
      path: routePath('Gateway', 'GetSupportBundle')
    }
    if (input.phrase !== undefined) executeInput.phrase = input.phrase
    if (input.timeoutMs !== undefined) executeInput.timeoutMs = input.timeoutMs
    return this.client.admin.execute<GatewaySupportBundleResponse>(executeInput)
  }
}

function supportBundlePayload(request: GatewaySupportBundleRequest | undefined): JsonObject {
  const payload: JsonObject = {}
  if (!request) return payload
  if (request.correlation_id !== undefined) payload.correlation_id = request.correlation_id
  if (request.event_limit !== undefined) payload.event_limit = request.event_limit
  if (request.audit_limit !== undefined) payload.audit_limit = request.audit_limit
  if (request.include_capability_catalog !== undefined) {
    payload.include_capability_catalog = request.include_capability_catalog
  }
  return payload
}

export class NativeClient {
  constructor(private readonly client: AuroraClient) {}

  getManifest(): Promise<NativeCapabilityManifest> {
    if (!['tauri-local', 'native-mobile', 'mock'].includes(this.client.transport.kind)) {
      throw unsupportedTransport(this.client.transport.kind, 'Native capability manifest', 'unsupported_feature')
    }
    return this.client.request<NativeCapabilityManifest>('Native.GetCapabilityManifest')
  }

  requirePermission(permission: string, manifest: NativeCapabilityManifest): void {
    if (!manifest.permissions[permission]) {
      throw unsupportedTransport(manifest.platform, permission, 'native_permission_missing')
    }
  }
}
