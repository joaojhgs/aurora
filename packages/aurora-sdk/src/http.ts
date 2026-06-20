import { AuroraError, classifyHttpError } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  parseSseEvent,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import { auditFromHeaders } from './transport.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'
import type { AuroraEvent } from './types.js'

type HttpMethod = NonNullable<AuroraTransportRequest['httpMethod']>

export interface HttpTransportOptions {
  baseUrl: string
  apiKey?: string
  bearerToken?: string
  fetchImpl?: typeof fetch
  eventSourceFactory?: EventSourceFactory | undefined
  webSocketFactory?: WebSocketFactory | undefined
  eventStreamPath?: string | undefined
  defaultTimeoutMs?: number
}

export type EventSourceFactory = (url: string, init?: EventSourceInit) => EventSourceLike
export type WebSocketFactory = (url: string) => WebSocketLike

export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

export interface WebSocketLike {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send?(data: string): void
  close(): void
}

export class HttpGatewayTransport implements AuroraTransport {
  readonly kind = 'http'
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly apiKey: string | undefined
  private readonly bearerToken: string | undefined
  private readonly eventSourceFactory: EventSourceFactory | undefined
  private readonly webSocketFactory: WebSocketFactory | undefined
  private readonly eventStreamPath: string
  private readonly defaultTimeoutMs: number

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiKey = options.apiKey
    this.bearerToken = options.bearerToken
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory()
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory()
    this.eventStreamPath = options.eventStreamPath ?? '/api/events'
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

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> {
    if (request.protocol === 'websocket') return this.subscribeWebSocket<TEventPayload, TPayload>(request)
    return this.subscribeSse<TEventPayload, TPayload>(request)
  }

  private subscribeSse<TEventPayload, TPayload>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> {
    if (!this.eventSourceFactory) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'HTTP SSE event streams require EventSource or an eventSourceFactory.'
      })
    }
    let source: EventSourceLike | null = null
    const stream = eventQueue<TEventPayload>((push, fail, done) => {
      const url = this.streamUrl(request)
      source = this.eventSourceFactory!(url, { withCredentials: false })
      source.onmessage = (event) => push(parseSseEvent<TEventPayload>(event, { kind: request.stream, transport: this.kind, audit: request.audit }))
      source.onerror = () => fail(new AuroraError({
        code: 'transport_loss',
        message: `HTTP SSE stream failed for ${request.stream}`,
        detail: { stream: request.stream, topics: request.topics }
      }))
      for (const kind of request.kinds) {
        source.addEventListener?.(kind, (event) => push(parseSseEvent<TEventPayload>(event, { kind, transport: this.kind, audit: request.audit })))
      }
      request.signal?.addEventListener('abort', done, { once: true })
    })
    return createEventSubscription(stream, () => source?.close())
  }

  private subscribeWebSocket<TEventPayload, TPayload>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> {
    if (!this.webSocketFactory) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'HTTP WebSocket event streams require WebSocket or a webSocketFactory.'
      })
    }
    let socket: WebSocketLike | null = null
    const stream = eventQueue<TEventPayload>((push, fail, done) => {
      socket = this.webSocketFactory!(this.websocketUrl(request))
      socket.onmessage = (event) => push(eventFromUnknown<TEventPayload>(parseSocketData(event.data), {
        kind: request.stream,
        transport: this.kind,
        audit: request.audit
      }))
      socket.onerror = () => fail(new AuroraError({
        code: 'transport_loss',
        message: `HTTP WebSocket stream failed for ${request.stream}`,
        detail: { stream: request.stream, topics: request.topics }
      }))
      socket.onclose = () => done()
      socket.send?.(JSON.stringify(streamHandshake(request)))
      request.signal?.addEventListener('abort', done, { once: true })
    })
    return createEventSubscription(stream, () => socket?.close())
  }

  private streamUrl(request: AuroraStreamRequest): string {
    const url = new URL(`${this.baseUrl}${request.path ?? this.eventStreamPath}`)
    url.searchParams.set('stream', request.stream)
    for (const topic of request.topics) url.searchParams.append('topic', topic)
    for (const kind of request.kinds) url.searchParams.append('kind', kind)
    if (request.lastEventId) url.searchParams.set('last_event_id', request.lastEventId)
    if (request.replayFrom) url.searchParams.set('replay_from', request.replayFrom)
    if (request.backfill) url.searchParams.set('backfill', 'true')
    return url.toString()
  }

  private websocketUrl(request: AuroraStreamRequest): string {
    const url = new URL(this.streamUrl(request))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }
}

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  return typeof EventSource === 'undefined' ? undefined : (url, init) => new EventSource(url, init)
}

function defaultWebSocketFactory(): WebSocketFactory | undefined {
  return typeof WebSocket === 'undefined' ? undefined : (url) => new WebSocket(url)
}

function streamHandshake(request: AuroraStreamRequest): Record<string, unknown> {
  return {
    stream: request.stream,
    topics: request.topics,
    kinds: request.kinds,
    payload: request.payload,
    last_event_id: request.lastEventId ?? null,
    replay_from: request.replayFrom ?? null,
    backfill: request.backfill ?? false
  }
}

function parseSocketData(data: unknown): unknown {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data) as unknown
  } catch {
    return { data }
  }
}

function eventQueue<TPayload>(
  start: (
    push: (event: AuroraEvent<TPayload>) => void,
    fail: (error: unknown) => void,
    done: () => void
  ) => void
): AsyncIterable<AuroraEvent<TPayload>> {
  return {
    async *[Symbol.asyncIterator]() {
      const events: Array<AuroraEvent<TPayload>> = []
      const waiters: Array<() => void> = []
      let failure: unknown
      let closed = false
      const wake = () => waiters.splice(0).forEach((resolve) => resolve())
      start(
        (event) => {
          events.push(event)
          wake()
        },
        (error) => {
          failure = error
          closed = true
          wake()
        },
        () => {
          closed = true
          wake()
        }
      )
      while (!closed || events.length > 0) {
        if (events.length > 0) {
          yield events.shift()!
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      if (failure) throw failure
    }
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
