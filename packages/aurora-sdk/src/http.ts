import { AuroraError, classifyHttpError } from './errors.js'
import { auditFromHeaders } from './transport.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'

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
    const path = request.path ?? `/api/${request.method.replace('.', '/')}`
    const controller = new AbortController()
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const signal = request.signal ?? controller.signal

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(request.headers),
        body: JSON.stringify(request.payload ?? {}),
        signal
      })
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
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AuroraError({
          code: 'timeout',
          message: `Aurora Gateway request timed out after ${timeoutMs}ms`,
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
