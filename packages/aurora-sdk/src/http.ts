import { AuroraError, classifyHttpError } from './errors.js'
import { auditFromHeaders } from './transport.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'

type HttpMethod = NonNullable<AuroraTransportRequest['httpMethod']>

export interface HttpTransportOptions {
  baseUrl: string
  apiKey?: string
  bearerToken?: string
  fetchImpl?: typeof fetch
  defaultTimeoutMs?: number
}

export class HttpGatewayTransport implements AuroraTransport {
  readonly kind = 'http'
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly apiKey: string | undefined
  private readonly bearerToken: string | undefined
  private readonly defaultTimeoutMs: number

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiKey = options.apiKey
    this.bearerToken = options.bearerToken
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const path = request.path ?? builtinPath(request.method) ?? `/api/${request.method.replace('.', '/')}`
    const httpMethod = request.httpMethod ?? builtinHttpMethod(path) ?? 'POST'
    const controller = new AbortController()
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const signal = combineSignals(controller.signal, request.signal)

    try {
      const init: RequestInit = {
        method: httpMethod,
        headers: this.headers(request.headers),
        signal
      }
      const body = requestBody(httpMethod, request.payload)
      if (body !== undefined) init.body = body

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init)
      const data = await parseJson(response)
      if (!response.ok) {
        throw new AuroraError({
          code: classifyHttpError(response.status, readDetail(data)),
          message: readErrorMessage(data) ?? `Aurora Gateway request failed with ${response.status}`,
          status: response.status,
          method: request.method,
          busTopic: request.busTopic,
          correlationId: auditFromHeaders(response.headers).correlationId ?? undefined,
          detail: readDetail(data)
        })
      }
      return {
        data: data as TData,
        status: response.status,
        headers: response.headers,
        audit: {
          ...auditFromHeaders(response.headers),
          method: request.method,
          busTopic: request.busTopic ?? null,
          transport: this.kind
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new AuroraError({
          code: 'timeout',
          message: `Aurora Gateway request timed out after ${timeoutMs}ms`,
          method: request.method,
          busTopic: request.busTopic,
          cause: error
        })
      }
      if (error instanceof TypeError) {
        throw new AuroraError({
          code: 'transport_loss',
          message: error.message,
          method: request.method,
          busTopic: request.busTopic,
          cause: error
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private headers(extra: Record<string, string> | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...extra
    }
    if (this.apiKey) headers['X-API-Key'] = this.apiKey
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`
    return headers
  }
}

function builtinPath(method: string): string | null {
  switch (method) {
    case 'Gateway.GetRegistry':
      return '/api/registry'
    case 'Gateway.GetServices':
      return '/api/services'
    case 'Gateway.Health':
    case 'Gateway.HealthCheck':
      return '/api/health'
    case 'Gateway.OpenAPI':
      return '/api/openapi.json'
    default:
      return null
  }
}

function builtinHttpMethod(path: string): HttpMethod | null {
  return path === '/api/registry' ||
    path === '/api/services' ||
    path === '/api/health' ||
    path === '/api/openapi.json'
    ? 'GET'
    : null
}

function requestBody(method: HttpMethod, payload: unknown): BodyInit | undefined {
  if (method === 'GET') return undefined
  return JSON.stringify(payload ?? {})
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (!secondary) return primary
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([primary, secondary])
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (primary.aborted || secondary.aborted) {
    abort()
  } else {
    primary.addEventListener('abort', abort, { once: true })
    secondary.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { data: text }
  }
}

function readDetail(data: unknown): unknown {
  return typeof data === 'object' && data !== null && 'detail' in data ? data.detail : data
}

function readErrorMessage(data: unknown): string | null {
  const detail = readDetail(data)
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object' && detail !== null) {
    const message = (detail as { message?: unknown; error?: unknown }).message ?? (detail as { error?: unknown }).error
    return typeof message === 'string' ? message : null
  }
  return null
}
