import { AuthSession } from './session.js'
import {
  auditFromHeaders,
  captureResult,
  createAuditReceipt,
  normalizeError,
  unsupportedTransport,
  type AuroraResponse,
  type AuroraTransport
} from './transport.js'
import { describeRegistry, GATEWAY_METHODS, TOOLING_METHODS, routePath } from './descriptors.js'
import { buildAdminOverviewManifest, buildCapabilityGraph, summarizeCapabilities } from './capabilities.js'
import { buildPermissionCatalog, checkAccess, hasPermission, resolveEffectivePermissions } from './permissions.js'
import type {
  AdminOverviewManifest,
  AdminOverviewManifestInput,
  CapabilityCatalogRequest,
  CapabilityCatalogResponse,
  CapabilityExplanation,
  CapabilityGraph,
  CapabilitySummary,
  GetRegistryResponse,
  GetServicesResponse,
  GatewayBuiltinRouteDescriptor,
  MethodDescriptor,
  NativeCapabilityManifest,
  PeerSummary,
  ContractMethodType,
  RouteExplainRequest,
  RouteExplainResponse
} from './types.js'
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
  readonly capabilities: CapabilityClient
  readonly adminOverview: AdminOverviewClient
  readonly permissions: PermissionClient
  readonly routes: RouteClient
  readonly tools: ToolClient
  readonly native: NativeClient
  private readonly defaultTimeoutMs: number

  constructor(options: AuroraClientOptions) {
    this.transport = options.transport
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.auth = new AuthSession()
    this.registry = new RegistryClient(this)
    this.capabilities = new CapabilityClient(this)
    this.adminOverview = new AdminOverviewClient(this)
    this.permissions = new PermissionClient(this)
    this.routes = new RouteClient(this)
    this.tools = new ToolClient(this)
    this.native = new NativeClient(this)
  }

  async request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options: { path?: string; busTopic?: string; timeoutMs?: number } = {}
  ): Promise<TData> {
    try {
      const response = await this.transport.request<TData, TPayload>({
        method,
        busTopic: options.busTopic ?? method,
        path: options.path,
        payload,
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
    options: { path?: string; busTopic?: string; timeoutMs?: number } = {}
  ): Promise<AuroraResponse<TData>> {
    const busTopic = options.busTopic ?? method
    try {
      const response = await this.transport.request<TData, TPayload>({
        method,
        busTopic,
        path: options.path,
        payload,
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
}

export class RegistryClient {
  constructor(private readonly client: AuroraClient) {}

  getRegistry(): Promise<GetRegistryResponse> {
    return this.client.request<GetRegistryResponse>(GATEWAY_METHODS.getRegistry, {}, { path: '/api/registry' })
  }

  async listMethods(): Promise<MethodDescriptor[]> {
    return describeRegistry(await this.getRegistry())
  }

  listServices(): Promise<GetServicesResponse> {
    return this.client.request<GetServicesResponse>(GATEWAY_METHODS.getServices, {}, { path: '/api/services' })
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
}

export interface AdminOverviewManifestOptions {
  gatewayBuiltins?: GatewayBuiltinRouteDescriptor[]
  nativeManifest?: NativeCapabilityManifest | null
  peers?: PeerSummary[]
  generatedAt?: string
}

export class AdminOverviewClient {
  constructor(private readonly client: AuroraClient) {}

  async getManifest(options: AdminOverviewManifestOptions = {}): Promise<AdminOverviewManifest> {
    const [registry, services, capabilityCatalog] = await Promise.all([
      this.client.registry.getRegistry(),
      this.client.registry.listServices(),
      this.client.capabilities.listCatalog({ include_internal: true, include_unavailable: true })
    ])
    const input: AdminOverviewManifestInput = {
      registry,
      services,
      capabilityCatalog
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

  listCatalog<TResponse = unknown>(request: Record<string, unknown> = {}): Promise<TResponse> {
    return this.client.request<TResponse>(TOOLING_METHODS.listCatalog, request, {
      path: routePath('Tooling', 'GetToolCatalog')
    })
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
