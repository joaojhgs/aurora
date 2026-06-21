import { AuroraError } from './errors.js'
import { createAuditReceipt, createAuroraEvent, normalizeError, unsupportedTransport, type AuroraTransport } from './transport.js'
import type { AuditReceipt, AuroraEvent, AuroraTransportKind, JsonObject } from './types.js'

export type AuroraEventStreamKind = 'generic' | 'assistant' | 'health' | 'config' | string
export type AuroraStreamProtocol = 'sse' | 'websocket' | 'ipc' | 'mesh' | 'mock' | string

export interface AuroraSubscribeOptions<TPayload = unknown> {
  stream?: AuroraEventStreamKind | undefined
  topics?: string[] | undefined
  kinds?: string[] | undefined
  path?: string | undefined
  protocol?: AuroraStreamProtocol | undefined
  payload?: TPayload | undefined
  headers?: Record<string, string> | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  lastEventId?: string | null | undefined
  replayFrom?: string | null | undefined
  backfill?: boolean | undefined
  reconnect?: boolean | AuroraReconnectOptions | undefined
  audit?: Partial<AuditReceipt> | undefined
}

export interface AuroraReconnectOptions {
  maxAttempts?: number | undefined
  initialDelayMs?: number | undefined
  maxDelayMs?: number | undefined
}

interface NormalizedReconnectOptions {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

export interface AuroraStreamRequest<TPayload = unknown> extends AuroraSubscribeOptions<TPayload> {
  stream: AuroraEventStreamKind
  topics: string[]
  kinds: string[]
}

export interface AuroraEventSubscription<TPayload = unknown> extends AsyncIterable<AuroraEvent<TPayload>> {
  readonly closed: Promise<void>
  close(reason?: unknown): void
}

export interface AuroraEventStreamTransport extends AuroraTransport {
  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> | Promise<AuroraEventSubscription<TEventPayload>>
}

export class EventStreamClient {
  constructor(private readonly transport: AuroraTransport) {}

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    options: AuroraSubscribeOptions<TPayload> = {}
  ): AuroraEventSubscription<TEventPayload> {
    return subscribeWithReconnect<TEventPayload, TPayload>(this.transport, normalizeStreamRequest('generic', options))
  }

  streamAssistant<TEventPayload = unknown, TPayload = unknown>(
    payload?: TPayload,
    options: AuroraSubscribeOptions<TPayload> = {}
  ): AuroraEventSubscription<TEventPayload> {
    return subscribeWithReconnect<TEventPayload, TPayload>(
      this.transport,
      normalizeStreamRequest('assistant', {
        topics: ['Orchestrator.Response'],
        kinds: ['assistant.delta', 'assistant.completed', 'assistant.failed', 'tool.requested', 'tool.completed'],
        ...options,
        payload: payload ?? options.payload
      })
    )
  }

  watchHealth<TEventPayload = unknown>(
    options: AuroraSubscribeOptions = {}
  ): AuroraEventSubscription<TEventPayload> {
    return subscribeWithReconnect<TEventPayload, unknown>(
      this.transport,
      normalizeStreamRequest('health', {
        topics: ['Gateway.Health', 'Service.Announcement'],
        kinds: ['health.updated', 'service.announced', 'service.stale'],
        ...options
      })
    )
  }

  watchConfig<TEventPayload = unknown>(
    options: AuroraSubscribeOptions = {}
  ): AuroraEventSubscription<TEventPayload> {
    return subscribeWithReconnect<TEventPayload, unknown>(
      this.transport,
      normalizeStreamRequest('config', {
        topics: ['Config.Updated'],
        kinds: ['config.updated', 'config.reload', 'config.validation_failed'],
        ...options
      })
    )
  }
}

export function normalizeStreamRequest<TPayload = unknown>(
  stream: AuroraEventStreamKind,
  options: AuroraSubscribeOptions<TPayload> = {}
): AuroraStreamRequest<TPayload> {
  return {
    ...options,
    stream: options.stream ?? stream,
    topics: options.topics ?? [],
    kinds: options.kinds ?? []
  }
}

export function isEventStreamTransport(transport: AuroraTransport): transport is AuroraEventStreamTransport {
  return typeof (transport as { subscribe?: unknown }).subscribe === 'function'
}

export function createEventSubscription<TPayload = unknown>(
  source: AsyncIterable<AuroraEvent<TPayload>>,
  onClose?: (reason?: unknown) => void
): AuroraEventSubscription<TPayload> {
  let closed = false
  let resolveClosed: () => void = () => undefined
  const activeIterators = new Set<AsyncIterator<AuroraEvent<TPayload>>>()
  const closeWaiters: Array<() => void> = []
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const settleClosed = () => {
    if (closed) return
    closed = true
    resolveClosed()
    closeWaiters.splice(0).forEach((resolve) => resolve())
    for (const iterator of activeIterators) {
      void iterator.return?.()
    }
  }

  return {
    get closed() {
      return closedPromise
    },
    close(reason?: unknown) {
      if (closed) return
      onClose?.(reason)
      settleClosed()
    },
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]()
      activeIterators.add(iterator)
      const nextWhenClosed = (): Promise<IteratorResult<AuroraEvent<TPayload>>> => {
        if (closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<AuroraEvent<TPayload>>>((resolve) => {
          closeWaiters.push(() => resolve({ done: true, value: undefined }))
        })
      }
      const closeIterator = (reason?: unknown) => {
        onClose?.(reason)
        settleClosed()
        activeIterators.delete(iterator)
      }
      return {
        async next(): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          if (closed) return { done: true, value: undefined }
          try {
            const result = await Promise.race([iterator.next(), nextWhenClosed()])
            if (closed) return { done: true, value: undefined }
            if (result.done) {
              closeIterator()
              return { done: true, value: undefined }
            }
            return result
          } catch (error) {
            closeIterator(error)
            throw error
          }
        },
        async return(): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          closeIterator()
          return { done: true, value: undefined }
        },
        async throw(error?: unknown): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          closeIterator(error)
          throw error
        }
      }
    }
  }
}

export function eventFromUnknown<TPayload = unknown>(
  raw: unknown,
  fallback: { kind: string; transport: AuroraTransportKind; audit?: Partial<AuditReceipt> | undefined }
): AuroraEvent<TPayload> {
  if (isAuroraEvent<TPayload>(raw)) return raw
  const payload = readPayload(raw) as TPayload
  const kind = readString(raw, 'kind', 'event_kind', 'eventKind', 'type') ?? fallback.kind
  if (!isObject(raw) || !('payload' in raw || 'data' in raw)) {
    return createAuroraEvent(kind, payload, {
      ...fallback.audit,
      transport: fallback.transport
    })
  }
  const audit = createAuditReceipt(raw, {
    ...fallback.audit,
    eventKind: kind,
    transport: fallback.transport
  })
  return {
    id: readString(raw, 'id', 'event_id', 'eventId'),
    kind,
    topic: readString(raw, 'topic'),
    method: audit.method,
    busTopic: audit.busTopic,
    payload,
    audit,
    redaction: audit.redaction,
    receivedAt: new Date().toISOString()
  }
}

export function parseSseEvent<TPayload = unknown>(
  raw: MessageEvent<string>,
  fallback: { kind: string; transport: AuroraTransportKind; audit?: Partial<AuditReceipt> | undefined }
): AuroraEvent<TPayload> {
  const parsed = safeJson(raw.data)
  const event = eventFromUnknown<TPayload>(parsed ?? { data: raw.data }, {
    ...fallback,
    kind: raw.type === 'message' ? fallback.kind : raw.type
  })
  return {
    ...event,
    id: event.id ?? raw.lastEventId ?? null
  }
}

export function eventStreamUnsupported(kind: AuroraTransportKind): AuroraError {
  return unsupportedTransport(kind, 'Event streams', 'unsupported_feature')
}

function subscribeWithReconnect<TEventPayload, TPayload>(
  transport: AuroraTransport,
  request: AuroraStreamRequest<TPayload>
): AuroraEventSubscription<TEventPayload> {
  if (!isEventStreamTransport(transport)) throw eventStreamUnsupported(transport.kind)
  const reconnect = normalizeReconnect(request.reconnect)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (request.signal?.aborted) {
    controller.abort()
  } else {
    request.signal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const source = reconnect.maxAttempts === 0
    ? singleStream<TEventPayload, TPayload>(transport, request, controller.signal)
    : reconnectingStream<TEventPayload, TPayload>(transport, request, reconnect, controller.signal)
  return createEventSubscription(source, () => {
    request.signal?.removeEventListener('abort', abortFromCaller)
    controller.abort()
  })
}

async function* singleStream<TEventPayload, TPayload>(
  transport: AuroraEventStreamTransport,
  request: AuroraStreamRequest<TPayload>,
  signal: AbortSignal
): AsyncIterable<AuroraEvent<TEventPayload>> {
  const subscription = await transport.subscribe<TEventPayload, TPayload>(request)
  const iterator = subscription[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), abortIteratorResult<TEventPayload>(signal)])
      if (result.done || signal.aborted) return
      yield result.value
    }
  } finally {
    subscription.close()
  }
}

async function* reconnectingStream<TEventPayload, TPayload>(
  transport: AuroraEventStreamTransport,
  request: AuroraStreamRequest<TPayload>,
  reconnect: NormalizedReconnectOptions,
  signal: AbortSignal
): AsyncIterable<AuroraEvent<TEventPayload>> {
  let attempt = 0
  let lastEventId = request.lastEventId ?? null
  while (!signal.aborted) {
    const currentRequest = { ...request, lastEventId }
    const subscription = await transport.subscribe<TEventPayload, TPayload>(currentRequest)
    const iterator = subscription[Symbol.asyncIterator]()
    try {
      while (!signal.aborted) {
        const result = await Promise.race([iterator.next(), abortIteratorResult<TEventPayload>(signal)])
        if (result.done || signal.aborted) return
        const event = result.value
        attempt = 0
        lastEventId = event.id ?? lastEventId
        yield event
      }
      return
    } catch (error) {
      subscription.close(error)
      attempt += 1
      if (attempt > reconnect.maxAttempts || signal.aborted) throw normalizeError(error)
      await delay(backoff(attempt, reconnect), signal)
    } finally {
      subscription.close()
    }
  }
}

function abortIteratorResult<TPayload>(signal: AbortSignal): Promise<IteratorResult<AuroraEvent<TPayload>>> {
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined })
  return new Promise<IteratorResult<AuroraEvent<TPayload>>>((resolve) => {
    signal.addEventListener(
      'abort',
      () => resolve({ done: true, value: undefined }),
      { once: true }
    )
  })
}

function normalizeReconnect(value: AuroraSubscribeOptions['reconnect']): NormalizedReconnectOptions {
  if (value === false || value === undefined) {
    return { maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 }
  }
  if (value === true) {
    return { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 2_000 }
  }
  return {
    maxAttempts: value.maxAttempts ?? 3,
    initialDelayMs: value.initialDelayMs ?? 250,
    maxDelayMs: value.maxDelayMs ?? 2_000
  }
}

function backoff(attempt: number, reconnect: NormalizedReconnectOptions): number {
  return Math.min(reconnect.initialDelayMs * 2 ** Math.max(0, attempt - 1), reconnect.maxDelayMs)
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new AuroraError({ code: 'timeout', message: 'Event stream subscription was closed' }))
      },
      { once: true }
    )
  })
}

function readPayload(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  if ('payload' in raw) return raw.payload
  if ('data' in raw) return raw.data
  return raw
}

function readString(value: unknown, ...keys: string[]): string | null {
  if (!isObject(value)) return null
  for (const key of keys) {
    const found = value[key]
    if (typeof found === 'string') return found
  }
  return null
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function isAuroraEvent<TPayload>(value: unknown): value is AuroraEvent<TPayload> {
  return isObject(value) && typeof value.kind === 'string' && 'payload' in value && 'audit' in value
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
