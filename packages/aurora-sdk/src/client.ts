import { AuthSession } from './session.js'
import { captureResult, unsupportedTransport, type AuroraResponse, type AuroraTransport } from './transport.js'
import { describeRegistry, GATEWAY_METHODS, TOOLING_METHODS, routePath } from './descriptors.js'
import { summarizeCapabilities } from './capabilities.js'
import type {
  CapabilityCatalogRequest,
  CapabilityCatalogResponse,
  CapabilitySummary,
  GetRegistryResponse,
  MethodDescriptor,
  NativeCapabilityManifest,
  RouteExplainRequest,
  RouteExplainResponse
} from './types.js'

export interface AuroraClientOptions {
  transport: AuroraTransport
  defaultTimeoutMs?: number
}

export class AuroraClient {
  readonly transport: AuroraTransport
  readonly auth: AuthSession
  readonly registry: RegistryClient
  readonly capabilities: CapabilityClient
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
    this.routes = new RouteClient(this)
    this.tools = new ToolClient(this)
    this.native = new NativeClient(this)
  }

  async request<TData = unknown, TPayload = unknown>(
    method: string,
    payload?: TPayload,
    options: { path?: string; busTopic?: string; timeoutMs?: number } = {}
  ): Promise<TData> {
    const response = await this.transport.request<TData, TPayload>({
      method,
      busTopic: options.busTopic ?? method,
      path: options.path,
      payload,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs
    })
    return response.data
  }

  result<TData>(operation: () => Promise<TData>): Promise<AuroraResponse<TData>> {
    return captureResult(operation)
  }
}

export class RegistryClient {
  constructor(private readonly client: AuroraClient) {}

  getRegistry(): Promise<GetRegistryResponse> {
    return this.client.request<GetRegistryResponse>(GATEWAY_METHODS.getRegistry, {}, { path: routePath('Gateway', 'GetRegistry') })
  }

  async listMethods(): Promise<MethodDescriptor[]> {
    return describeRegistry(await this.getRegistry())
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
