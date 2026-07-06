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
  STT_METHODS,
  TRANSCRIPTION_METHODS,
  TOOLING_METHODS,
  TTS_METHODS,
  routePath
} from './descriptors.js'
import { buildAdminOverviewManifest, buildCapabilityGraph, summarizeCapabilities } from './capabilities.js'
import { ConfigClient } from './config.js'
import { buildPermissionCatalog, checkAccess, hasPermission, resolveEffectivePermissions } from './permissions.js'
import { evaluateRoutePolicy } from './policy.js'
import { BackupClient } from './backup.js'
import { SchedulerClient } from './scheduler.js'
import {
  buildToolingPageView,
  loadToolApprovalCards,
  normalizePolicyAuditEvents,
  normalizePendingApprovals,
  normalizeToolCatalog,
  normalizeToolGrants,
  validateMcpSourceDraft,
  validatePluginSourceDraft,
  submitToolDenialDecision,
  submitToolApprovalDecision,
  type ToolApprovalCardModel,
  type ToolApprovalDenialInput,
  type ToolApprovalDecisionInput,
  type McpSourceWizardDraft,
  type PluginSourceWizardDraft,
  type ToolApprovalDecisionResult,
  type ToolCatalogResponse,
  type ToolingPageViewModel,
  type ToolOnboardingValidationResult,
  type ToolPolicyAuditEventModel,
  type ToolPolicyOverrideModel,
  type ToolPendingApprovalModel,
  type ToolSourceDetailModel,
  type ToolSourceSummaryModel
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
  AuditLogEntry,
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
  AssistantToolStreamEvent,
  AssistantTtsAudioChunkEvent,
  AssistantVoiceListenRequest,
  AssistantVoiceListenResult,
  AssistantStreamMessageRequest,
  AssistantStreamUpdate,
  AuroraEvent,
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
  OrchestratorListPendingToolApprovalsRequest,
  OrchestratorListPendingToolApprovalsResponse,
  OrchestratorResumeToolApprovalRequest,
  OrchestratorResumeToolApprovalResponse,
  STTListenRequest,
  STTListenResponse,
  STTStopListeningRequest,
  TranscribeAudioRequest,
  TranscribeAudioResponse,
  TTSPlaybackRequest,
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
  ToolingApprovalGrant,
  ToolingCreateApprovalGrantRequest,
  ToolingCreateApprovalGrantResponse,
  ToolingEvaluateApprovalGrantRequest,
  ToolingEvaluateApprovalGrantResponse,
  ToolingGetMcpStatusResponse,
  ToolingGetSharingPolicyResponse,
  ToolingListApprovalGrantsRequest,
  ToolingListApprovalGrantsResponse,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
  ToolingRevokeApprovalGrantRequest,
  ToolingRevokeApprovalGrantResponse,
  ToolingSetSharingPolicyRequest,
  ToolingSetSharingPolicyResponse,
  ToolingSharingPolicy,
  ToolingSharingPolicyRule,
  ToolingStatsResponse,
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
  readonly adminAction: AdminActionClient
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
    this.adminAction = this.admin
    this.approvals = new ApprovalClient(this)
    this.native = new NativeClient(this)
    this.events = new EventStreamClient(this.transport, (error) => this.auth.applyError(error))
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
    if (result.ok) {
      this.client.auth.setBearerToken(result.data.token)
      this.client.auth.updateFromLogin(result.data)
    }
    return result
  }

  async validateToken(payload: AuthValidateTokenRequest): Promise<AuroraResponse<AuthValidateTokenResponse>> {
    const result = await this.client.requestResult<AuthValidateTokenResponse, AuthValidateTokenRequest>(
      AUTH_METHODS.validateToken,
      payload,
      { path: routePath('Auth', 'ValidateToken') }
    )
    if (result.ok) {
      this.client.auth.setBearerToken(result.data.valid ? payload.token : null)
      this.client.auth.updateFromTokenValidation(result.data)
    }
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
    if (result.ok) {
      this.client.auth.setBearerToken(result.data.token)
      this.client.auth.updateFromPairingExchange(result.data)
    }
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
    return this.client.requestResult<MeshStatusResponse, Record<string, never>>(
      GATEWAY_METHODS.getMeshStatus,
      {},
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
    return this.client.request<DeploymentTopologyResponse, Record<string, never>>(GATEWAY_METHODS.getDeploymentTopology, {}, {
      path: routePath('Gateway', 'GetDeploymentTopology')
    })
  }

  getWebRTCDiagnostics(): Promise<WebRTCDiagnosticsResponse> {
    return this.client.request<WebRTCDiagnosticsResponse, Record<string, never>>(GATEWAY_METHODS.getWebRTCDiagnostics, {}, {
      path: routePath('Gateway', 'GetWebRTCDiagnostics')
    })
  }
}

type TimedReadCacheEntry<T> = {
  readonly expiresAt: number
  readonly promise: Promise<T>
}

const SDK_READ_DEDUPE_TTL_MS = 2_000

export class CapabilityClient {
  private readonly catalogCache = new Map<string, TimedReadCacheEntry<CapabilityCatalogResponse>>()

  constructor(private readonly client: AuroraClient) {}

  listCatalog(request: CapabilityCatalogRequest = {}): Promise<CapabilityCatalogResponse> {
    const cacheKey = stableRequestKey(request)
    const cached = freshCacheEntry(this.catalogCache, cacheKey)
    if (cached) return cached.promise

    const promise = this.client.request<CapabilityCatalogResponse, CapabilityCatalogRequest>(
      GATEWAY_METHODS.getCapabilityCatalog,
      request,
      { path: routePath('Gateway', 'GetCapabilityCatalog') }
    )
    rememberRead(this.catalogCache, cacheKey, promise)
    return promise
  }

  invalidateCache(): void {
    this.catalogCache.clear()
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

  explainRoute(route: string | RouteExplainRequest): Promise<RouteExplainResponse> {
    return this.client.routes.explain(routeExplainRequest(route))
  }
}

function freshCacheEntry<T>(cache: Map<string, TimedReadCacheEntry<T>>, key: string): TimedReadCacheEntry<T> | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt > Date.now()) return entry
  cache.delete(key)
  return null
}

function rememberRead<T>(cache: Map<string, TimedReadCacheEntry<T>>, key: string, promise: Promise<T>): void {
  cache.set(key, { expiresAt: Date.now() + SDK_READ_DEDUPE_TTL_MS, promise })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
}

function stableRequestKey(value: unknown): string {
  return JSON.stringify(stableRequestValue(value))
}

function stableRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRequestValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableRequestValue(entry)])
  )
}

function routeExplainRequest(route: string | RouteExplainRequest): RouteExplainRequest {
  if (typeof route !== 'string') {
    return { include_candidates: true, ...route }
  }
  const request: RouteExplainRequest = { topic: route, include_candidates: true }
  const separator = route.indexOf('.')
  if (separator > 0 && separator < route.length - 1) {
    request.module = route.slice(0, separator)
    request.method = route.slice(separator + 1)
  }
  return request
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
  private readonly explainCache = new Map<string, TimedReadCacheEntry<RouteExplainResponse>>()

  constructor(private readonly client: AuroraClient) {}

  explain(request: RouteExplainRequest): Promise<RouteExplainResponse> {
    const cacheKey = stableRequestKey(request)
    const cached = freshCacheEntry(this.explainCache, cacheKey)
    if (cached) return cached.promise

    const promise = this.client.request<RouteExplainResponse, RouteExplainRequest>(
      GATEWAY_METHODS.explainRoute,
      request,
      { path: routePath('Gateway', 'ExplainRoute') }
    )
    rememberRead(this.explainCache, cacheKey, promise)
    return promise
  }

  invalidateCache(): void {
    this.explainCache.clear()
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
      source: 'ui'
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
        modelLabel: metadataString(response.data.metadata, 'model') ?? metadataString(response.data.metadata, 'provider_label') ?? metadataString(response.data.metadata, 'provider'),
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
      source: 'ui'
    }
    if (input.sessionId !== undefined) payload.session_id = input.sessionId
    const requestId = input.requestId ?? `assistant-${cryptoRandomId()}`
    payload.request_id = requestId
    payload.correlation_id = requestId
    payload.stream = true
    if (input.clientTtsPlayback !== undefined) payload.client_tts_playback = input.clientTtsPlayback

    let sawEvent = false
    const requestState: { response: AuroraResponse<OrchestratorResponse> | null } = { response: null }
    let stream: AuroraEventSubscription<Record<string, unknown>> | null = null
    let iterator: AsyncIterator<AuroraEvent<Record<string, unknown>>> | null = null
    let awaitingTtsDrain = false
    try {
      const correlationId = requestId
      const openAssistantStream = () => {
        const openedStream = this.client.events.streamAssistant<Record<string, unknown>, OrchestratorProcessRequest>(payload, {
          signal: input.signal,
          lastEventId: input.lastEventId ?? null,
          replayFrom: input.replayFrom ?? input.lastEventId ?? null,
          correlationId,
          backfill: true,
          reconnect: { maxAttempts: 1, initialDelayMs: 250, maxDelayMs: 1_000 },
          audit: {
            correlationId,
            method: ORCHESTRATOR_METHODS.externalUserInput,
            busTopic: ORCHESTRATOR_METHODS.externalUserInput,
            transport: this.client.transport.kind
          }
        })
        return {
          stream: openedStream,
          iterator: openedStream[Symbol.asyncIterator]()
        }
      }
      const preopenStream = this.client.transport.kind !== 'mock'
      let firstEvent: ReturnType<typeof readFirstIteratorEvent<Record<string, unknown>>> | null = null
      if (preopenStream) {
        const opened = openAssistantStream()
        stream = opened.stream
        iterator = opened.iterator
        firstEvent = readFirstIteratorEvent(iterator)
      }
      const requestOptions: { path: string; timeoutMs?: number } = {
        path: routePath('Orchestrator', 'ExternalUserInput')
      }
      if (input.timeoutMs !== undefined) requestOptions.timeoutMs = input.timeoutMs
      const requestPromise = this.client.requestResult<OrchestratorResponse, OrchestratorProcessRequest>(
        ORCHESTRATOR_METHODS.externalUserInput,
        payload,
        requestOptions
      ).then((response) => {
        requestState.response = response
        return response
      })
      // The assistant stream is the product surface. Do not block token/tool/TTS
      // delivery on the POST response, because the POST completes only after the
      // orchestrator has finished. Keep the promise observed so a late HTTP
      // failure never becomes an unhandled rejection after a terminal stream.
      void requestPromise.catch(() => undefined)

      if (!preopenStream && !transportHasAssistantStream(this.client.transport)) {
        const request = await requestPromise
        if (!request.ok) {
          yield streamFailure(request.error, this.client.transport.kind)
          return
        }
        yield fallbackUpdateFromResponse(request, input, requestId)
        return
      }

      if (!firstEvent) {
        const opened = openAssistantStream()
        stream = opened.stream
        iterator = opened.iterator
        firstEvent = readFirstIteratorEvent(iterator)
      }
      const firstRace = await raceAssistantFirstEventOrRequest(firstEvent, requestPromise, preopenStream ? 5_000 : 30_000)
      if (firstRace.status === 'request') {
        const request = firstRace.response
        if (!request.ok) {
          yield streamFailure(request.error, this.client.transport.kind)
          return
        }
        const lateFirst = await raceEventIterator(firstEvent, 750)
        if (lateFirst === 'timeout' || lateFirst.status === 'error' || lateFirst.value.done) {
          yield fallbackUpdateFromResponse(request, input, requestId)
          return
        }
        sawEvent = true
        const firstUpdate = assistantStreamUpdateFromEvent(lateFirst.value.value, request.data)
        yield firstUpdate
        if (assistantCompletionAwaitsTtsDrain(firstUpdate)) {
          awaitingTtsDrain = true
        } else if (isTerminalAssistantStreamUpdate(firstUpdate)) {
          return
        }
      } else if (firstRace.status === 'timeout' || firstRace.result.status === 'error' || firstRace.result.value.done) {
        const request = await requestPromise
        if (!request.ok) {
          yield streamFailure(request.error, this.client.transport.kind)
          return
        }
        yield fallbackUpdateFromResponse(request, input, requestId)
        return
      } else {
        sawEvent = true
        const firstUpdate = assistantStreamUpdateFromEvent(
          firstRace.result.value.value,
          requestState.response?.ok ? requestState.response.data : undefined
        )
        yield firstUpdate
        if (assistantCompletionAwaitsTtsDrain(firstUpdate)) {
          awaitingTtsDrain = true
        } else if (isTerminalAssistantStreamUpdate(firstUpdate)) {
          return
        }
      }

      const activeIterator = iterator
      if (!activeIterator) return
      const eventIdleTimeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 5_000), 120_000)
      while (!input.signal?.aborted) {
        const result = await raceEventIterator(activeIterator.next(), eventIdleTimeoutMs)
        if (result === 'timeout') {
          if (awaitingTtsDrain) return
          if (requestState.response?.ok) {
            yield fallbackUpdateFromResponse(requestState.response, input, requestId)
            return
          }
          yield streamFailure(new AuroraError({
            code: 'timeout',
            message: 'Assistant stream stalled before Aurora returned a final response.',
            method: ORCHESTRATOR_METHODS.externalUserInput,
            busTopic: ORCHESTRATOR_METHODS.externalUserInput,
            correlationId: requestId
          }), this.client.transport.kind, sawEvent ? 'transport_lost' : 'failed')
          return
        }
        if (result.done) return
        sawEvent = true
        const update = assistantStreamUpdateFromEvent(
          result.value,
          requestState.response?.ok ? requestState.response.data : undefined
        )
        yield update
        if (isFinalTtsAudioUpdate(update) && awaitingTtsDrain) return
        if (assistantCompletionAwaitsTtsDrain(update)) {
          awaitingTtsDrain = true
          continue
        }
        if (isTerminalAssistantStreamUpdate(update)) return
      }
    } catch (error) {
      const normalized = normalizeError(error)
      this.client.auth.applyError(normalized)
      if (input.signal?.aborted) return
      if (sawEvent) {
        yield streamFailure(normalized, this.client.transport.kind, 'transport_lost')
        return
      }

      if (requestState.response?.ok) {
        yield fallbackUpdateFromResponse(requestState.response, input, requestId)
        return
      }

      const fallback = await this.sendMessage(input)
      if (fallback.ok) {
        yield {
          kind: 'fallback',
          eventId: fallback.data.response.id,
          messageId: fallback.data.response.id,
          sessionId: fallback.data.sessionId,
          text: fallback.data.response.text,
          textDelta: fallback.data.response.text,
          modelLabel: fallback.data.modelLabel,
          requestId,
          error: null,
          audit: fallback.audit,
          metadata: fallback.data.metadata,
          tool: null,
          ttsAudio: null
        }
        return
      }
      yield streamFailure(fallback.error, this.client.transport.kind, 'fallback')
    } finally {
      if (stream) stream.close('assistant-stream-message-complete')
    }
  }

  async *streamVoiceEvents(
    options: AuroraSubscribeOptions = {}
  ): AsyncIterable<VoiceRuntimeEvent> {
    const stream = this.client.events.subscribe<unknown>({
      stream: 'voice',
      topics: [...VOICE_EVENT_TOPICS],
      kinds: [...VOICE_EVENT_KINDS],
      reconnect: { maxAttempts: 120, initialDelayMs: 250, maxDelayMs: 2_000 },
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

  async *streamVoiceAssistantResponses(
    options: AuroraSubscribeOptions = {}
  ): AsyncIterable<AssistantStreamUpdate> {
    const stream = this.client.events.streamAssistant<Record<string, unknown>, unknown>(undefined, {
      topics: [ORCHESTRATOR_METHODS.response, TTS_METHODS.audioChunk],
      kinds: ['assistant.completed', 'assistant.delta', 'assistant.failed', 'tool.requested', 'tool.running', 'tool.completed', 'tool.failed', 'tts.audio_chunk', 'tts.audio.chunk', 'tts.chunk'],
      reconnect: { maxAttempts: 120, initialDelayMs: 250, maxDelayMs: 2_000 },
      ...options,
      audit: {
        ...options.audit,
        transport: this.client.transport.kind
      }
    })
    for await (const event of stream) {
      const source = streamMetadata(event.payload ?? {}).source
      if (typeof source === 'string' && source !== 'stt') continue
      yield assistantStreamUpdateFromEvent(event)
    }
  }

  async startVoiceListen(input: AssistantVoiceListenRequest = {}): Promise<AuroraResponse<AssistantVoiceListenResult>> {
    const sessionId = input.sessionId ?? `voice-${cryptoRandomId()}`
    const requestOptions: { path: string; timeoutMs?: number } = {
      path: routePath('STTCoordinator', 'Listen')
    }
    if (input.timeoutMs !== undefined) requestOptions.timeoutMs = input.timeoutMs
    const response = await this.client.requestResult<STTListenResponse, STTListenRequest>(
      STT_METHODS.listen,
      { session_id: sessionId },
      requestOptions
    )
    if (!response.ok) return response
    const data = response.data ?? {}
    const activeSessionId = data.session_id ?? sessionId
    const status = data.status === 'stopped' || data.status === 'unavailable' ? data.status : 'listening'
    const source = data.source === 'wakeword' || data.source === 'sdk' ? data.source : 'push_to_talk'
    return {
      ok: true,
      audit: response.audit,
      data: {
        sessionId: activeSessionId,
        status,
        source
      }
    }
  }

  async stopVoiceListen(input: AssistantVoiceListenRequest = {}): Promise<AuroraResponse<AssistantVoiceListenResult>> {
    const sessionId = input.sessionId ?? stableSessionId()
    const requestOptions: { path: string; timeoutMs?: number } = {
      path: routePath('STTCoordinator', 'StopListening')
    }
    if (input.timeoutMs !== undefined) requestOptions.timeoutMs = input.timeoutMs
    const response = await this.client.requestResult<unknown, STTStopListeningRequest>(
      STT_METHODS.stopListening,
      { reason: input.reason ?? 'user_request' },
      requestOptions
    )
    if (!response.ok) return response
    return {
      ok: true,
      audit: response.audit,
      data: {
        sessionId,
        status: 'stopped',
        source: 'push_to_talk'
      }
    }
  }

  transcribeVoiceAudio(input: TranscribeAudioRequest): Promise<AuroraResponse<TranscribeAudioResponse>> {
    return this.client.requestResult<TranscribeAudioResponse, TranscribeAudioRequest>(
      TRANSCRIPTION_METHODS.transcribe,
      input,
      { path: routePath('Transcription', 'Transcribe'), timeoutMs: 120_000 }
    )
  }


  requestReadAloud(input: TTSPlaybackRequest): Promise<AuroraResponse<unknown>> {
    return this.client.requestResult<unknown, TTSPlaybackRequest>(
      TTS_METHODS.request,
      {
        text: input.text,
        voice: input.voice ?? null,
        speed: input.speed ?? 1.0,
        interrupt: input.interrupt ?? true
      },
      { path: routePath('TTS', 'Request'), timeoutMs: 15_000 }
    )
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

  listPendingToolApprovals(
    input: OrchestratorListPendingToolApprovalsRequest = {}
  ): Promise<AuroraResponse<OrchestratorListPendingToolApprovalsResponse>> {
    return this.client.requestResult<
      OrchestratorListPendingToolApprovalsResponse,
      OrchestratorListPendingToolApprovalsRequest
    >(
      ORCHESTRATOR_METHODS.listPendingToolApprovals,
      input,
      { path: routePath('Orchestrator', 'ListPendingToolApprovals') }
    )
  }

  approveToolCall(
    input: Omit<OrchestratorResumeToolApprovalRequest, 'approve'> = {}
  ): Promise<AuroraResponse<OrchestratorResumeToolApprovalResponse>> {
    return this.resumeToolApproval({ ...input, approve: true })
  }

  denyToolCall(
    input: Omit<OrchestratorResumeToolApprovalRequest, 'approve'> = {}
  ): Promise<AuroraResponse<OrchestratorResumeToolApprovalResponse>> {
    return this.resumeToolApproval({ ...input, approve: false })
  }

  resumeToolApproval(
    input: OrchestratorResumeToolApprovalRequest
  ): Promise<AuroraResponse<OrchestratorResumeToolApprovalResponse>> {
    return this.client.requestResult<
      OrchestratorResumeToolApprovalResponse,
      OrchestratorResumeToolApprovalRequest
    >(
      ORCHESTRATOR_METHODS.resumeToolApproval,
      input,
      { path: routePath('Orchestrator', 'ResumeToolApproval'), timeoutMs: 60_000 }
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

function transportHasAssistantStream(transport: AuroraTransport): boolean {
  const probe = (transport as { hasStream?: (stream: string) => boolean }).hasStream
  if (typeof probe !== 'function') return true
  return probe.call(transport, 'assistant')
}

async function readFirstIteratorEvent<TPayload>(
  iterator: AsyncIterator<AuroraEvent<TPayload>>
): Promise<
  | { status: 'value'; value: IteratorResult<AuroraEvent<TPayload>> }
  | { status: 'error'; error: unknown }
> {
  try {
    return { status: 'value', value: await iterator.next() }
  } catch (error) {
    return { status: 'error', error }
  }
}

function assistantStreamUpdateFromEvent(
  event: import('./types.js').AuroraEvent<Record<string, unknown>>,
  requestResponse?: OrchestratorResponse
): AssistantStreamUpdate {
  const payload = event.payload ?? {}
  const eventText = streamText(payload)
  const metadata = { ...(requestResponse?.metadata ?? {}), ...streamMetadata(payload) }
  const sessionId = streamString(payload, 'session_id', 'sessionId') ?? requestResponse?.session_id ?? null
  const requestId = streamString(payload, 'request_id', 'requestId') ?? event.audit.correlationId
  const messageId = streamString(payload, 'message_id', 'messageId') ?? requestId ?? event.id
  const modelLabel = metadataString(metadata, 'model') ?? metadataString(metadata, 'provider_label') ?? metadataString(metadata, 'provider')
  const text = event.kind === 'assistant.completed' && !eventText ? requestResponse?.text ?? '' : eventText
  const tool = event.kind.startsWith('tool.') ? assistantToolStreamEventFromPayload(event, payload, metadata) : null
  const ttsAudio = isTtsAudioChunkKind(event.kind) ? assistantTtsAudioChunkFromPayload(payload) : null
  if (event.kind === 'assistant.completed') {
    return {
      kind: 'completed',
      eventId: event.id,
      messageId,
      sessionId,
      text,
      textDelta: text,
      modelLabel,
      requestId,
      error: null,
      audit: event.audit,
      metadata,
      tool: null,
      ttsAudio: null
    }
  }
  if (event.kind === 'assistant.failed') {
    return {
      kind: 'failed',
      eventId: event.id,
      messageId,
      sessionId,
      text,
      textDelta: '',
      modelLabel,
      requestId,
      error: new AuroraError({
        code: 'unavailable_service',
        message: text || 'Assistant stream failed.',
        detail: payload,
        correlationId: event.audit.correlationId ?? undefined,
        method: event.method ?? ORCHESTRATOR_METHODS.externalUserInput,
        busTopic: event.busTopic ?? ORCHESTRATOR_METHODS.externalUserInput
      }),
      audit: event.audit,
      metadata,
      tool: null,
      ttsAudio: null
    }
  }
  if (tool) {
    return {
      kind: 'tool',
      eventId: event.id,
      messageId,
      sessionId,
      text: text || tool.summary || '',
      textDelta: '',
      modelLabel,
      requestId,
      error: null,
      audit: event.audit,
      metadata,
      tool,
      ttsAudio: null
    }
  }
  if (ttsAudio) {
    return {
      kind: 'tts_audio_chunk',
      eventId: event.id,
      messageId,
      sessionId,
      text,
      textDelta: '',
      modelLabel,
      requestId,
      error: null,
      audit: event.audit,
      metadata,
      tool: null,
      ttsAudio
    }
  }
  return {
    kind: 'delta',
    eventId: event.id,
    messageId,
    sessionId,
    text,
    textDelta: streamString(payload, 'delta', 'text_delta', 'textDelta') ?? text,
    modelLabel,
    requestId,
    error: null,
    audit: event.audit,
    metadata,
    tool: null,
    ttsAudio: null
  }
}

function isTerminalAssistantStreamUpdate(update: AssistantStreamUpdate): boolean {
  return update.kind === 'completed' || update.kind === 'fallback' || update.kind === 'failed' || update.kind === 'transport_lost'
}

function assistantCompletionAwaitsTtsDrain(update: AssistantStreamUpdate): boolean {
  return update.kind === 'completed' && (
    metadataString(update.metadata, 'tts_status') === 'streaming' ||
    metadataString(update.metadata, 'tts_stream_id') !== null
  )
}

function isFinalTtsAudioUpdate(update: AssistantStreamUpdate): boolean {
  return update.kind === 'tts_audio_chunk' && update.ttsAudio?.final === true
}


function fallbackUpdateFromResponse(
  response: Extract<AuroraResponse<OrchestratorResponse>, { ok: true }>,
  input: AssistantStreamMessageRequest,
  requestId: string
): AssistantStreamUpdate {
  const sessionId = response.data.session_id ?? input.sessionId ?? stableSessionId()
  const metadata = response.data.metadata ?? {}
  return {
    kind: 'fallback',
    eventId: response.audit.correlationId ?? response.data.correlation_id ?? requestId,
    messageId: response.data.request_id ?? response.data.correlation_id ?? requestId,
    sessionId,
    text: response.data.text,
    textDelta: response.data.text,
    modelLabel: metadataString(metadata, 'model') ?? metadataString(metadata, 'provider_label') ?? metadataString(metadata, 'provider'),
    requestId,
    error: null,
    audit: response.audit,
    metadata,
    tool: null,
    ttsAudio: null
  }
}

async function raceEventIterator<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number
): Promise<TResult | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs)
    })
  ])
}

type AssistantFirstEventResult = Awaited<ReturnType<typeof readFirstIteratorEvent<Record<string, unknown>>>>

async function raceAssistantFirstEventOrRequest(
  firstEvent: ReturnType<typeof readFirstIteratorEvent<Record<string, unknown>>>,
  request: Promise<AuroraResponse<OrchestratorResponse>>,
  timeoutMs: number
): Promise<
  | { status: 'event'; result: AssistantFirstEventResult }
  | { status: 'request'; response: AuroraResponse<OrchestratorResponse> }
  | { status: 'timeout' }
> {
  return Promise.race([
    firstEvent.then((result) => ({ status: 'event' as const, result })),
    request.then((response) => ({ status: 'request' as const, response })),
    new Promise<{ status: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
    })
  ])
}

function streamFailure(
  error: AuroraError,
  transport: string,
  kind: 'failed' | 'transport_lost' | 'fallback' = 'failed'
): AssistantStreamUpdate {
  return {
    kind,
    eventId: null,
    messageId: null,
    sessionId: null,
    text: error.message,
    textDelta: '',
    modelLabel: null,
    requestId: null,
    error,
    audit: createAuditReceipt(error.detail, {
      correlationId: error.correlationId ?? null,
      method: error.method ?? ORCHESTRATOR_METHODS.externalUserInput,
      busTopic: error.busTopic ?? ORCHESTRATOR_METHODS.externalUserInput,
      status: error.code,
      transport
    }),
    metadata: {},
    tool: null,
    ttsAudio: null
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

function assistantToolStreamEventFromPayload(
  event: import('./types.js').AuroraEvent<Record<string, unknown>>,
  payload: Record<string, unknown>,
  metadata: Record<string, import('./types.js').JsonValue | undefined>
): AssistantToolStreamEvent {
  const toolPayload = streamObject(payload, 'tool', 'tool_call', 'toolCall') ?? payload
  const status = toolStatusFromEvent(event.kind, toolPayload, metadata)
  const name = streamString(toolPayload, 'name', 'tool_name', 'toolName')
    ?? streamString(metadata, 'name', 'tool_name', 'toolName')
    ?? event.audit.toolId
    ?? 'tool.requested'
  const payloadPreview = streamObject(toolPayload, 'payload_preview', 'payloadPreview', 'redacted_args_preview', 'argsPreview')
    ?? streamObject(metadata, 'payload_preview', 'payloadPreview', 'redacted_args_preview', 'argsPreview')
  return {
    id: streamString(toolPayload, 'id', 'tool_id', 'toolId', 'tool_call_id', 'toolCallId', 'call_id', 'callId')
      ?? event.audit.toolId
      ?? event.id
      ?? name,
    name,
    status,
    riskClass: streamString(toolPayload, 'risk_class', 'riskClass') ?? streamString(metadata, 'risk_class', 'riskClass'),
    target: streamString(toolPayload, 'target', 'provider', 'provider_label', 'providerLabel') ?? streamString(metadata, 'target', 'provider', 'provider_label', 'providerLabel'),
    dataLeavesDevice: streamBoolean(toolPayload, 'data_leaves_device', 'dataLeavesDevice') ?? streamBoolean(metadata, 'data_leaves_device', 'dataLeavesDevice'),
    summary: streamString(toolPayload, 'summary', 'message', 'text') ?? streamString(metadata, 'summary', 'message'),
    payloadPreview,
    resultPreview: streamObject(toolPayload, 'result_preview', 'resultPreview', 'result')
      ?? streamString(toolPayload, 'result_preview', 'resultPreview', 'result')
      ?? streamObject(metadata, 'result_preview', 'resultPreview')
      ?? streamString(metadata, 'result_preview', 'resultPreview'),
    error: streamString(toolPayload, 'error', 'error_message', 'errorMessage')
      ?? streamString(metadata, 'error', 'error_message', 'errorMessage'),
    errorDetails: streamObject(toolPayload, 'error_details', 'errorDetails', 'details')
      ?? streamString(toolPayload, 'error_details', 'errorDetails', 'details')
      ?? streamObject(metadata, 'error_details', 'errorDetails')
      ?? streamString(metadata, 'error_details', 'errorDetails'),
    pendingId: streamString(toolPayload, 'pending_id', 'pendingId')
      ?? streamString(metadata, 'pending_id', 'pendingId'),
    approvalRequestId: streamString(toolPayload, 'approval_request_id', 'approvalRequestId')
      ?? streamString(metadata, 'approval_request_id', 'approvalRequestId'),
    approvalExpiresAt: streamNumber(toolPayload, 'approval_expires_at', 'approvalExpiresAt', 'expires_at', 'expiresAt')
      ?? streamNumber(metadata, 'approval_expires_at', 'approvalExpiresAt', 'expires_at', 'expiresAt'),
    policyDecisionId: streamString(toolPayload, 'policy_decision_id', 'policyDecisionId')
      ?? streamString(metadata, 'policy_decision_id', 'policyDecisionId')
  }
}

function assistantTtsAudioChunkFromPayload(payload: Record<string, unknown>): AssistantTtsAudioChunkEvent {
  return {
    chunkId: streamString(payload, 'chunk_id', 'chunkId', 'id') ?? null,
    sequence: streamNumber(payload, 'sequence', 'seq', 'index'),
    audioData: streamString(payload, 'audio_data', 'audioData', 'chunk', 'data', 'base64') ?? null,
    encoding: streamString(payload, 'encoding', 'format', 'codec') ?? null,
    mimeType: streamString(payload, 'mime_type', 'mimeType', 'content_type', 'contentType') ?? null,
    sampleRate: streamNumber(payload, 'sample_rate', 'sampleRate'),
    channels: streamNumber(payload, 'channels'),
    durationMs: streamNumber(payload, 'duration_ms', 'durationMs'),
    final: streamBoolean(payload, 'final', 'is_final', 'isFinal') ?? false
  }
}

function toolStatusFromEvent(
  kind: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>
): string {
  const status = (streamString(payload, 'status', 'state') ?? streamString(metadata, 'status', 'state'))?.toLowerCase()
  if (status) return status
  const normalized = kind.toLowerCase()
  if (normalized.includes('completed')) return 'completed'
  if (normalized.includes('failed') || normalized.includes('error')) return 'failed'
  if (normalized.includes('running') || normalized.includes('started')) return 'running'
  return 'requested'
}

function isTtsAudioChunkKind(kind: string): boolean {
  const normalized = kind.toLowerCase().replace(/[_-]/g, '.')
  return normalized === 'tts.audio.chunk' || normalized === 'tts.audio' || normalized === 'tts.chunk' || normalized.includes('tts.audio.chunk')
}

function streamString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return null
}

function streamNumber(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function streamBoolean(payload: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

function streamObject(payload: Record<string, unknown>, ...keys: string[]): JsonObject | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject
  }
  return null
}

function stableSessionId(): string {
  return `assistant-session-${Date.now().toString(36)}`
}

function cryptoRandomId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) return randomUUID.call(globalThis.crypto)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
        : this.client.requestResult<DeploymentTopologyResponse, Record<string, never>>(
            GATEWAY_METHODS.getDeploymentTopology,
            {},
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

  getStats(): Promise<ToolingStatsResponse> {
    return this.client.request<ToolingStatsResponse, Record<string, never>>(TOOLING_METHODS.getStats, {}, {
      path: routePath('Tooling', 'GetStats')
    })
  }

  getMcpStatus(): Promise<ToolingGetMcpStatusResponse> {
    return this.client.request<ToolingGetMcpStatusResponse, Record<string, never>>(TOOLING_METHODS.getMcpStatus, {}, {
      path: routePath('Tooling', 'GetMCPStatus')
    })
  }

  reloadMcpTools(): Promise<Record<string, never>> {
    return this.client.request<Record<string, never>, Record<string, never>>(TOOLING_METHODS.reloadMcpTools, {}, {
      path: routePath('Tooling', 'ReloadMCPTools')
    })
  }

  async getSharingPolicy(): Promise<ToolingSharingPolicy> {
    const response = await this.client.request<ToolingGetSharingPolicyResponse, Record<string, never>>(
      TOOLING_METHODS.getSharingPolicy,
      {},
      { path: routePath('Tooling', 'GetSharingPolicy') }
    )
    return response.policy
  }

  setSharingPolicy(request: ToolingSetSharingPolicyRequest): Promise<ToolingSetSharingPolicyResponse> {
    return this.client.request<ToolingSetSharingPolicyResponse, ToolingSetSharingPolicyRequest>(
      TOOLING_METHODS.setSharingPolicy,
      request,
      { path: routePath('Tooling', 'SetSharingPolicy') }
    )
  }

  testSharingPolicy(request: ToolingPrepareExecutionRequest): Promise<ToolingPrepareExecutionResponse> {
    return this.client.request<ToolingPrepareExecutionResponse, ToolingPrepareExecutionRequest>(
      TOOLING_METHODS.testSharingPolicy,
      request,
      { path: routePath('Tooling', 'TestSharingPolicy') }
    )
  }

  listGrants(request: ToolingListApprovalGrantsRequest = {}): Promise<ToolingListApprovalGrantsResponse> {
    return this.client.request<ToolingListApprovalGrantsResponse, ToolingListApprovalGrantsRequest>(
      TOOLING_METHODS.listApprovalGrants,
      request,
      { path: routePath('Tooling', 'ListApprovalGrants') }
    )
  }

  createGrant(request: ToolingCreateApprovalGrantRequest): Promise<ToolingCreateApprovalGrantResponse> {
    return this.client.request<ToolingCreateApprovalGrantResponse, ToolingCreateApprovalGrantRequest>(
      TOOLING_METHODS.createApprovalGrant,
      request,
      { path: routePath('Tooling', 'CreateApprovalGrant') }
    )
  }

  revokeGrant(request: ToolingRevokeApprovalGrantRequest): Promise<ToolingRevokeApprovalGrantResponse> {
    return this.client.request<ToolingRevokeApprovalGrantResponse, ToolingRevokeApprovalGrantRequest>(
      TOOLING_METHODS.revokeApprovalGrant,
      request,
      { path: routePath('Tooling', 'RevokeApprovalGrant') }
    )
  }

  evaluateGrant(request: ToolingEvaluateApprovalGrantRequest): Promise<ToolingEvaluateApprovalGrantResponse> {
    return this.client.request<ToolingEvaluateApprovalGrantResponse, ToolingEvaluateApprovalGrantRequest>(
      TOOLING_METHODS.evaluateApprovalGrant,
      request,
      { path: routePath('Tooling', 'EvaluateApprovalGrant') }
    )
  }

  async listNormalizedGrants(request: ToolingListApprovalGrantsRequest = {}) {
    const response = await this.listGrants(request)
    return normalizeToolGrants(response.grants)
  }

  async listPendingApprovals(request: Record<string, unknown> = {}): Promise<ToolPendingApprovalModel[]> {
    const response = await this.client.request<{ approvals?: unknown[]; count?: number; secrets_redacted?: boolean }, Record<string, unknown>>(
      TOOLING_METHODS.listPendingApprovals,
      request,
      { path: routePath('Tooling', 'ListPendingApprovals') }
    )
    return (response.approvals ?? []).map(normalizeToolingPendingApproval)
  }

  async listInlinePendingApprovals(request: OrchestratorListPendingToolApprovalsRequest = {}) {
    const response = await this.client.request<OrchestratorListPendingToolApprovalsResponse, OrchestratorListPendingToolApprovalsRequest>(
      ORCHESTRATOR_METHODS.listPendingToolApprovals,
      request,
      { path: routePath('Orchestrator', 'ListPendingToolApprovals') }
    )
    return normalizePendingApprovals(response.approvals)
  }

  async listPolicyAuditEvents(request: Record<string, unknown> = {}): Promise<ToolPolicyAuditEventModel[]> {
    const response = await this.client.request<{ events?: unknown[]; total?: number; secrets_redacted?: boolean }, Record<string, unknown>>(
      TOOLING_METHODS.listPolicyAuditEvents,
      request,
      { path: routePath('Tooling', 'ListPolicyAuditEvents') }
    )
    return (response.events ?? []).map(normalizeToolingAuditEvent)
  }

  async getPolicySummary(): Promise<ToolingPageViewModel['policy']> {
    const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
      TOOLING_METHODS.getPolicySummary,
      { include_counts: true },
      { path: routePath('Tooling', 'GetPolicySummary') }
    )
    return normalizeToolingPolicySummaryResponse(response)
  }

  async listSources(): Promise<ToolSourceSummaryModel[]> {
    const response = await this.client.request<{ sources?: unknown[]; secrets_redacted?: boolean }, Record<string, unknown>>(
      TOOLING_METHODS.listToolSources,
      { include_blocked_tools: true, include_counts: true },
      { path: routePath('Tooling', 'ListToolSources') }
    )
    return (response.sources ?? []).map((source) => normalizeToolingSourceSummary(source, response.secrets_redacted !== false))
  }

  async getSourceDetail(sourceId: string): Promise<ToolSourceDetailModel | null> {
    const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
      TOOLING_METHODS.getToolSourceDetail,
      { source_id: sourceId, include_tools: true, include_grants: true, include_pending_approvals: true, include_blocked_tools: true },
      { path: routePath('Tooling', 'GetToolSourceDetail') }
    )
    if (response.found === false || !response.source) return null
    const source = normalizeToolingSourceSummary(response.source, response.secrets_redacted !== false)
    const blockedRows = Array.isArray(response.blocked_tools) ? response.blocked_tools as NonNullable<ToolCatalogResponse['blocked_tools']> : []
    const catalog: ToolCatalogResponse = {
      tools: Array.isArray(response.tools) ? response.tools as ToolCatalogResponse['tools'] : [],
      blocked_tools: blockedRows,
      generated_at: null,
      secrets_redacted: response.secrets_redacted !== false
    }
    return {
      source,
      tools: normalizeToolCatalog(catalog, { transportKind: this.client.transport.kind }),
      blockedTools: normalizeToolCatalog({ tools: blockedRows.map((blocked) => blocked.tool), secrets_redacted: response.secrets_redacted !== false }, { transportKind: this.client.transport.kind }).map((tool) => ({ ...tool, state: 'unavailable' as const })),
      grants: normalizeToolGrants(Array.isArray(response.grants) ? response.grants as never[] : []),
      overrides: Array.isArray(response.policy_rules) ? (response.policy_rules as ToolingSharingPolicyRule[]).map((rule) => normalizeToolingRuleOverride(rule, source.id)) : [],
      pendingApprovals: Array.isArray(response.pending_approvals) ? response.pending_approvals.map(normalizeToolingPendingApproval) : [],
      auditEvents: [],
      mcpServers: [],
      secretsRedacted: response.secrets_redacted !== false
    }
  }

  async getPageView(catalogOverride?: ToolCatalogResponse): Promise<ToolingPageViewModel> {
    const [catalogResult, policyResult, grantsResult, pendingResult, auditResult, mcpResult] = await Promise.allSettled([
      catalogOverride ? Promise.resolve(catalogOverride) : this.listCatalog<ToolCatalogResponse>(),
      this.getSharingPolicy(),
      this.listGrants({ include_revoked: true }),
      this.client.request<OrchestratorListPendingToolApprovalsResponse, OrchestratorListPendingToolApprovalsRequest>(
        ORCHESTRATOR_METHODS.listPendingToolApprovals,
        {},
        { path: routePath('Orchestrator', 'ListPendingToolApprovals') }
      ),
      this.client.authApi.auditLog({ limit: 100 }),
      this.getMcpStatus()
    ])
    const failures = settledFailureAuditEvents([
      ['Tooling.GetToolCatalog', catalogResult],
      ['Tooling.GetSharingPolicy', policyResult],
      ['Tooling.ListApprovalGrants', grantsResult],
      ['Orchestrator.ListPendingToolApprovals', pendingResult],
      ['Auth.AuditLog', auditResult],
      ['Tooling.GetMCPStatus', mcpResult]
    ])
    const catalog = settledValue(catalogResult) ?? { tools: [], generated_at: null, secrets_redacted: true }
    const auditEvents = [
      ...auditEventsFromSettled(settledValue(auditResult)),
      ...failures
    ]
    return buildToolingPageView({
      catalog,
      policy: settledValue(policyResult) ?? null,
      grants: settledValue(grantsResult)?.grants ?? [],
      pendingApprovals: settledValue(pendingResult)?.approvals ?? [],
      auditEvents,
      mcpStatus: settledValue(mcpResult) ?? null,
      transportKind: this.client.transport.kind,
      fixtureMode: this.client.transport.kind === 'mock'
    })
  }

  setPolicyMode(input: {
    policyMode: string
    confirmationText?: string | null
    reason?: string | null
    actorPrincipalId?: string | null
    correlationId?: string | null
  }): Promise<unknown> {
    return this.client.request<unknown, Record<string, unknown>>(TOOLING_METHODS.setPolicyMode, {
      policy_mode: input.policyMode,
      actor_principal_id: input.actorPrincipalId ?? this.client.auth.snapshot().principalId ?? 'current-principal',
      reason: input.reason ?? `Updated Tooling policy mode to ${input.policyMode}`,
      confirmation_text: input.confirmationText ?? null,
      correlation_id: input.correlationId ?? null
    }, { path: routePath('Tooling', 'SetPolicyMode') })
  }

  async upsertSourcePolicy(input: {
    sourceId: string
    sourceType?: string | null
    providerPeerId?: string | null
    providerServiceInstanceId?: string | null
    trustTier: string
    includeFutureTools?: boolean
    reason?: string | null
    actorPrincipalId?: string | null
    correlationId?: string | null
  }): Promise<unknown> {
    return this.client.request<unknown, Record<string, unknown>>(TOOLING_METHODS.upsertSourcePolicy, {
      source_id: input.sourceId,
      trust_tier: input.trustTier,
      actor_principal_id: input.actorPrincipalId ?? this.client.auth.snapshot().principalId ?? 'current-principal',
      reason: input.reason ?? `Updated source policy for ${input.sourceId}`,
      include_future_tools: input.includeFutureTools ?? false,
      provider_peer_id: input.providerPeerId ?? null,
      provider_service_instance_id: input.providerServiceInstanceId ?? null,
      correlation_id: input.correlationId ?? null
    }, { path: routePath('Tooling', 'UpsertSourcePolicy') })
  }

  async upsertToolOverride(input: {
    toolId: string
    approvalMode: string
    share?: boolean
    providerPeerId?: string | null
    providerServiceInstanceId?: string | null
    tokenTtlSeconds?: number | null
    reason?: string | null
    actorPrincipalId?: string | null
    correlationId?: string | null
  }): Promise<unknown> {
    return this.client.request<unknown, Record<string, unknown>>(TOOLING_METHODS.upsertToolPolicyOverride, {
      global_tool_id: input.toolId,
      trust_tier: toolOverrideTrustTier(input.approvalMode, input.share),
      actor_principal_id: input.actorPrincipalId ?? this.client.auth.snapshot().principalId ?? 'current-principal',
      reason: input.reason ?? `Updated tool override for ${input.toolId}`,
      expected_schema_hash: null,
      include_future_tools: false,
      correlation_id: input.correlationId ?? null
    }, { path: routePath('Tooling', 'UpsertToolPolicyOverride') })
  }

  async testMcpSource(input: McpSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const local = validateMcpSourceDraft(input)
    if (local.status === 'invalid') return local
    try {
      const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
        TOOLING_METHODS.testMcpSource,
        mcpSourcePayload(input, this.client.auth.snapshot().principalId),
        { path: routePath('Tooling', 'TestMCPSource') }
      )
      return normalizeOnboardingResponse('mcp', response, local.redactedPreview)
    } catch (error) {
      if (this.client.transport.kind === 'mock') return local
      throw error
    }
  }

  async createMcpSource(input: McpSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const local = validateMcpSourceDraft(input)
    if (local.status === 'invalid') return local
    try {
      const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
        TOOLING_METHODS.createMcpSource,
        mcpSourcePayload(input, this.client.auth.snapshot().principalId, true),
        { path: routePath('Tooling', 'CreateMCPSource') }
      )
      return normalizeOnboardingResponse('mcp', response, local.redactedPreview)
    } catch (error) {
      if (this.client.transport.kind === 'mock') return local
      throw error
    }
  }

  async testPluginSource(input: PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const local = validatePluginSourceDraft(input)
    if (local.status === 'invalid') return local
    try {
      const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
        TOOLING_METHODS.testPluginSource,
        pluginSourcePayload(input, this.client.auth.snapshot().principalId),
        { path: routePath('Tooling', 'TestPluginSource') }
      )
      return normalizeOnboardingResponse('plugin', response, local.redactedPreview)
    } catch (error) {
      if (this.client.transport.kind === 'mock') return local
      throw error
    }
  }

  async createPluginSource(input: PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const local = validatePluginSourceDraft(input)
    if (local.status === 'invalid') return local
    try {
      const response = await this.client.request<Record<string, unknown>, Record<string, unknown>>(
        TOOLING_METHODS.createPluginSource,
        pluginSourcePayload(input, this.client.auth.snapshot().principalId, true),
        { path: routePath('Tooling', 'CreatePluginSource') }
      )
      return normalizeOnboardingResponse('plugin', response, local.redactedPreview)
    } catch (error) {
      if (this.client.transport.kind === 'mock') return local
      throw error
    }
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



function normalizeToolingPolicySummaryResponse(response: Record<string, unknown>): ToolingPageViewModel['policy'] {
  const policy = asRecord(response.policy)
  const mode = stringValue(response.policy_mode ?? policy.policy_mode) ?? 'enforce'
  return {
    mode,
    defaultApprovalMode: stringValue(response.default_approval_mode ?? policy.default_approval_mode) ?? 'approve_all_local_safe',
    defaultShare: booleanValue(response.default_share ?? policy.default_share) ?? true,
    defaultTokenTtlSeconds: numberValue(policy.default_token_ttl_seconds) ?? 300,
    dryRunOnly: Boolean(response.dry_run_only ?? mode === 'dry_run_only'),
    denyAll: Boolean(response.deny_all ?? mode === 'deny_all'),
    unrestrictedExceptBlocked: Boolean(response.unrestricted_except_blocked ?? mode === 'unrestricted_except_blocked'),
    ruleCount: Array.isArray(policy.rules) ? policy.rules.length : 0,
    activeGrantCount: numberValue(response.active_grant_count) ?? 0,
    pendingApprovalCount: numberValue(response.pending_approval_count) ?? 0,
    sourceCount: numberValue(response.source_count) ?? 0,
    blockedSourceCount: numberValue(response.blocked_source_count) ?? 0,
    blockedToolCount: numberValue(response.blocked_tool_count) ?? 0,
    toolCount: numberValue(response.tool_count) ?? 0,
    mcpServerCount: 0,
    activeMcpServerCount: 0,
    lastPolicyChangeActor: stringValue(response.last_policy_change_actor),
    lastPolicyChangeAt: response.last_policy_change_at == null ? null : String(response.last_policy_change_at),
    lastPolicyCorrelationId: null,
    secretsRedacted: response.secrets_redacted !== false
  }
}

function normalizeToolingSourceSummary(raw: unknown, defaultSecretsRedacted = true): ToolSourceSummaryModel {
  const source = asRecord(raw)
  const kind = sourceKindFromBackend(stringValue(source.source ?? source.source_type) ?? 'unknown')
  const sourceId = stringValue(source.source_id) ?? fallbackSourceIdForKind(kind)
  return {
    id: sourceId,
    kind,
    label: stringValue(source.display_name) ?? sourceId,
    providerPeerId: stringValue(source.provider_peer_id),
    providerServiceInstanceId: stringValue(source.provider_service_instance_id),
    providerKind: stringValue(source.provider_kind),
    transport: stringValue(source.transport),
    trustTier: stringValue(source.trust_tier),
    status: sourceStatusFromBackend(stringValue(source.status) ?? (source.shared_by_policy === false ? 'unshared' : 'active')),
    toolCount: numberValue(source.tool_count) ?? 0,
    blockedToolCount: numberValue(source.blocked_tool_count ?? source.blocked_count) ?? 0,
    approvalRequiredCount: numberValue(source.pending_approval_count) ?? 0,
    newOrReviewCount: numberValue(source.unreviewed_tool_count ?? source.new_child_count) ?? 0,
    activeGrantCount: numberValue(source.active_grant_count) ?? 0,
    staleGrantCount: numberValue(source.stale_grant_count) ?? 0,
    includeFutureTools: Boolean((numberValue(source.include_future_tools_grants) ?? 0) > 0 || source.include_future_tools === true),
    cacheStatus: stringValue(source.cache_status ?? source.catalog_cache_state),
    catalogEpoch: numberValue(source.catalog_epoch),
    catalogHash: stringValue(source.catalog_hash),
    generatedAt: stringValue(source.generated_at),
    lastAnnouncementAt: stringValue(source.last_announcement_at ?? source.updated_at),
    secretsRedacted: source.secrets_redacted !== false && defaultSecretsRedacted,
    sourceId,
    sourceType: kind,
    catalogCacheState: stringValue(source.catalog_cache_state ?? source.cache_status),
    newChildCount: numberValue(source.new_child_count ?? source.unreviewed_tool_count) ?? 0,
    schedulerDependencies: []
  }
}

function fallbackSourceIdForKind(kind: ToolSourceSummaryModel['kind']): string {
  if (kind === 'mcp') return 'local:mcp:default'
  if (kind === 'plugin') return 'local:plugin:default'
  if (kind === 'core') return 'local:core'
  if (kind === 'mesh_peer') return 'mesh:unknown:unknown'
  return `${kind}:unknown`
}

function normalizeToolingPendingApproval(raw: unknown): ToolPendingApprovalModel {
  const approval = asRecord(raw)
  const id = stringValue(approval.approval_request_id) ?? stringValue(approval.id) ?? 'pending-approval'
  const expired = approval.expired === true
  const used = approval.used === true
  const toolName = stringValue(approval.global_tool_id ?? approval.local_tool_name) ?? 'unknown-tool'
  return {
    id,
    approvalRequestId: id,
    status: stringValue(approval.status) ?? pendingApprovalStatus(expired, used),
    runId: stringValue(approval.run_id) ?? id,
    threadId: stringValue(approval.thread_id) ?? id,
    sessionId: stringValue(approval.session_id),
    ownerPrincipalId: stringValue(approval.requested_by_principal_id ?? approval.owner_principal_id),
    ownerPeerId: stringValue(approval.caller_peer_id ?? approval.owner_peer_id),
    messageId: stringValue(approval.message_id) ?? id,
    toolCallId: stringValue(approval.tool_call_id) ?? toolName,
    toolName,
    displayName: stringValue(approval.local_tool_name) ?? toolName,
    argumentsPreview: asJsonObject(approval.display_args_preview ?? approval.arguments_preview),
    policyDecisionId: stringValue(approval.policy_decision_id),
    correlationId: stringValue(approval.correlation_id),
    createdAt: numberValue(approval.created_at) ?? 0,
    expiresAt: numberValue(approval.expires_at),
    metadata: asJsonObject(approval.metadata),
    inlineAssistantOnly: true,
    secretsRedacted: approval.secrets_redacted !== false
  }
}

function pendingApprovalStatus(expired: boolean, used: boolean): string {
  if (expired) return 'expired'
  if (used) return 'used'
  return 'pending'
}

function normalizeToolingAuditEvent(raw: unknown): ToolPolicyAuditEventModel {
  const row = asRecord(raw)
  const details = asJsonObject(row.details)
  return {
    id: stringValue(row.id ?? row.correlation_id) ?? 'tooling-audit-event',
    event: stringValue(row.event) ?? 'tooling.audit',
    action: stringValue(row.action),
    principalId: stringValue(row.principal_id),
    correlationId: stringValue(row.correlation_id ?? details.correlation_id),
    peerId: stringValue(row.peer_id),
    providerId: stringValue(row.provider_peer_id ?? row.provider_id),
    toolId: stringValue(row.global_tool_id ?? row.tool_id),
    policyDecisionId: stringValue(row.policy_decision_id ?? details.policy_decision_id),
    route: stringValue(row.route),
    createdAt: row.created_at == null ? null : String(row.created_at),
    details,
    secretsRedacted: row.secrets_redacted !== false,
    raw: row as AuditLogEntry
  }
}

function normalizeToolingRuleOverride(rule: ToolingSharingPolicyRule, sourceId: string): ToolPolicyOverrideModel {
  const targetKind = toolingRuleTargetKind(rule)
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
}

function toolingRuleTargetKind(rule: ToolingSharingPolicyRule): ToolPolicyOverrideModel['targetKind'] {
  if (rule.global_tool_id || rule.tool_name) return 'tool'
  if (rule.source_type) return 'source'
  return 'provider'
}

function toolOverrideTrustTier(approvalMode: string, share: boolean | undefined): 'trusted' | 'untrusted' | 'blocked' {
  if (approvalMode === 'deny_all' || share === false) return 'blocked'
  if (approvalMode === 'approve_all_for_peer') return 'trusted'
  return 'untrusted'
}

function mcpSourcePayload(input: McpSourceWizardDraft, principalId: string | null | undefined, create = false): Record<string, unknown> {
  const name = input.name.trim()
  const transport = input.transport === 'streamable_http' || input.transport === 'sse' ? input.transport : 'stdio'
  return {
    actor_principal_id: principalId ?? 'current-principal',
    source_id: localSourceId('mcp', name),
    source_label: name,
    transport,
    command: input.command ?? null,
    args: input.args ?? [],
    url: input.url ?? null,
    env: input.env ?? {},
    reason: input.reason ?? `Validate MCP source ${name}`,
    trust_tier: create ? input.trustTier ?? 'untrusted' : undefined,
    include_future_tools: create ? input.includeFutureTools ?? false : undefined
  }
}

function pluginSourcePayload(input: PluginSourceWizardDraft, principalId: string | null | undefined, create = false): Record<string, unknown> {
  const packageName = input.packageName.trim()
  const pluginIdentifier = input.pluginId ?? packageName
  return {
    actor_principal_id: principalId ?? 'current-principal',
    source_id: localSourceId('plugin', pluginIdentifier),
    source_label: pluginIdentifier,
    package: packageName,
    plugin_name: input.pluginId ?? null,
    version: input.version ?? null,
    reason: input.reason ?? `Validate plugin source ${packageName}`,
    trust_tier: create ? input.trustTier ?? 'untrusted' : undefined,
    include_future_tools: create ? input.includeFutureTools ?? false : undefined
  }
}

function normalizeOnboardingResponse(
  kind: ToolOnboardingValidationResult['kind'],
  raw: Record<string, unknown>,
  localRedactedPreview: JsonObject
): ToolOnboardingValidationResult {
  const ok = raw.ok === true
  const error = stringValue(raw.error)
  const unsupported = /unsupported/i.test(error ?? '') || /unsupported/i.test(stringValue(raw.message) ?? '')
  const validationErrors = error && !unsupported ? [error] : []
  const status = onboardingValidationStatus(unsupported, ok)
  return {
    kind,
    ok: ok && !unsupported,
    supported: !unsupported,
    status,
    redactedPreview: {
      ...localRedactedPreview,
      source_id: stringValue(raw.source_id),
      message: stringValue(raw.message),
      tool_count: numberValue(raw.tool_count),
      created: booleanValue(raw.created),
      secrets_redacted: raw.secrets_redacted !== false
    },
    errors: validationErrors,
    secretsRedacted: raw.secrets_redacted !== false
  }
}

function onboardingValidationStatus(unsupported: boolean, ok: boolean): ToolOnboardingValidationResult['status'] {
  if (unsupported) return 'unsupported'
  if (ok) return 'valid'
  return 'invalid'
}

function sourceKindFromBackend(kind: string): ToolSourceSummaryModel['kind'] {
  if (kind === 'core' || kind === 'local') return 'core'
  if (kind === 'mcp' || kind === 'mcp_server') return 'mcp'
  if (kind === 'plugin') return 'plugin'
  if (kind === 'mesh' || kind === 'mesh_peer') return 'mesh_peer'
  if (kind === 'blocked') return 'blocked'
  return 'unknown'
}

function sourceStatusFromBackend(status: string): ToolSourceSummaryModel['status'] {
  if (status === 'blocked') return 'blocked'
  if (status === 'stale' || status === 'removed' || status === 'unshared') return status
  if (status === 'needs-review' || status === 'needs_review') return 'needs-review'
  return 'active'
}

function localSourceId(kind: 'mcp' | 'plugin', identifier: string): string {
  const safe = identifier.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return `local:${kind}:${safe || 'default'}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return asJsonObject(JSON.parse(value)) } catch { return { value } }
  }
  return asRecord(value) as JsonObject
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function auditEventsFromSettled(result: AuroraResponse<AuditLogResponse> | null): AuditLogEntry[] {
  return result?.ok ? result.data.events : []
}

function settledFailureAuditEvents(results: Array<[string, PromiseSettledResult<unknown>]>): AuditLogEntry[] {
  return results
    .filter(([, result]) => result.status === 'rejected')
    .map(([method, result]) => {
      const reason = result.status === 'rejected' ? errorText(result.reason) : 'unknown error'
      const [module, methodName] = method.split('.')
      return {
        id: `tooling-page-view-failure:${method}`,
        event: 'tooling.page_view.partial_failure',
        action: method,
        principal_id: null,
        correlation_id: null,
        peer_id: null,
        provider_id: null,
        tool_id: null,
        policy_decision_id: null,
        route: routePath(module ?? 'Tooling', methodName ?? method),
        created_at: new Date().toISOString(),
        details: JSON.stringify({ method, error: reason, secrets_redacted: true })
      }
    })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  async getManifest(): Promise<NativeCapabilityManifest> {
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
