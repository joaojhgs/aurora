import { AuroraError } from './errors.js'
import { GATEWAY_EVENT_TOPICS } from './descriptors.js'
import { createAuditReceipt, createAuroraEvent, normalizeError, unsupportedTransport, type AuroraTransport } from './transport.js'
import type { AuditReceipt, AuroraEvent, AuroraTransportKind, JsonObject } from './types.js'

export type AuroraEventStreamKind = 'generic' | 'assistant' | 'health' | 'config' | string
export type AuroraStreamProtocol = 'sse' | 'websocket' | 'ipc' | 'mesh' | 'mock' | string

/** Whitelisted Gateway.StatusChanged projection shared by health and config views. */
export interface GatewayStatusChangedEvent {
  event_id: string
  timestamp: string
  kind: 'config.updated' | 'config.validation_failed' | 'service.announced' | 'service.stale'
  status: 'updated' | 'failed' | 'connected' | 'disconnected'
  freshness: 'current' | 'stale'
  service_id?: string | null
}

export interface AuroraSubscribeOptions<TPayload = unknown> {
  stream?: AuroraEventStreamKind | undefined
  source?: AuroraEventSource | undefined
  topics?: string[] | undefined
  kinds?: string[] | undefined
  subject?: string | NativeEventSubjectFilter | undefined
  subjects?: Array<string | NativeEventSubjectFilter> | undefined
  path?: string | undefined
  protocol?: AuroraStreamProtocol | undefined
  payload?: TPayload | undefined
  headers?: Record<string, string> | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  lastEventId?: string | null | undefined
  replayFrom?: string | null | undefined
  lastSequenceId?: number | string | null | undefined
  correlationId?: string | null | undefined
  backfill?: boolean | undefined
  reconnect?: boolean | AuroraReconnectOptions | undefined
  audit?: Partial<AuditReceipt> | undefined
  diagnostic?: AuroraEventDiagnostic | undefined
}

export type AuroraEventDiagnosticStage = 'received' | 'filter.accepted' | 'filter.rejected'

export type AuroraEventDiagnostic = (input: {
  stage: AuroraEventDiagnosticStage
  stream: AuroraEventStreamKind
  event: Pick<AuroraEvent, 'id' | 'kind'>
}) => void

export type AuroraEventSource = 'gateway' | 'native' | 'mesh' | 'mock' | string
export type NativeEventSubjectFilter = string | { type?: string | null | undefined; id: string }

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
  subjects?: string[] | undefined
}

export interface AuroraEventSnapshotRequest<TPayload = unknown> extends AuroraSubscribeOptions<TPayload> {
  topics: string[]
  kinds: string[]
  subjects?: string[] | undefined
  afterSequence?: number | null | undefined
}

export interface AuroraEventSnapshot<TPayload = unknown> {
  events: Array<AuroraEvent<TPayload>>
  lastSequenceId: string | null
  replayComplete: boolean
  subjects?: unknown[] | undefined
}

export interface AuroraEventSubscription<TPayload = unknown> extends AsyncIterable<AuroraEvent<TPayload>> {
  readonly ready?: Promise<void>
  readonly closed: Promise<void>
  close(reason?: unknown): void
}

export type AuroraNativeResumeUnsubscribe = () => void | Promise<void>
export type AuroraNativeResumeSubscriber = (listener: () => void) => AuroraNativeResumeUnsubscribe | Promise<AuroraNativeResumeUnsubscribe>

export interface AuroraEventStreamTransport extends AuroraTransport {
  subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): AuroraEventSubscription<TEventPayload> | Promise<AuroraEventSubscription<TEventPayload>>
  snapshot?<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraEventSnapshotRequest<TPayload>
  ): AuroraEventSnapshot<TEventPayload> | Promise<AuroraEventSnapshot<TEventPayload>>
}

export class EventStreamClient {
  constructor(
    private readonly transport: AuroraTransport,
    private readonly onStreamError?: ((error: AuroraError) => void) | undefined,
    private readonly nativeSource?: AuroraEventStreamTransport | undefined,
    private readonly nativeResumeSubscriber?: AuroraNativeResumeSubscriber | undefined
  ) {}

  async subscribeNativeResume(listener: () => void): Promise<AuroraNativeResumeUnsubscribe> {
    if (!this.nativeResumeSubscriber) return () => undefined
    return await this.nativeResumeSubscriber(listener)
  }

  subscribe<TEventPayload = unknown, TPayload = unknown>(
    options: AuroraSubscribeOptions<TPayload> = {}
  ): AuroraEventSubscription<TEventPayload> {
    const request = normalizeStreamRequest('generic', options)
    return this.withStreamErrorHandling(
      subscribeWithReconnect<TEventPayload, TPayload>(this.transportForRequest(request), request)
    )
  }

  streamAssistant<TEventPayload = unknown, TPayload = unknown>(
    payload?: TPayload,
    options: AuroraSubscribeOptions<TPayload> = {}
  ): AuroraEventSubscription<TEventPayload> {
    const request = normalizeStreamRequest('assistant', {
      topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      kinds: [
        'assistant.delta',
        'assistant.completed',
        'assistant.failed',
        'tool.requested',
        'tool.running',
        'tool.completed',
        'tool.failed',
        'tool.requires_action',
        'tts.audio_chunk',
        'tts.audio.chunk',
        'tts.chunk'
      ],
      ...options,
      payload: payload ?? options.payload
    })
    const subscription = subscribeWithReconnect<TEventPayload, TPayload>(
      this.transportForRequest(request),
      request
    )
    return this.withStreamErrorHandling(sanitizeAssistantSubscription(subscription))
  }

  watchHealth<TEventPayload = unknown>(
    options: AuroraSubscribeOptions = {}
  ): AuroraEventSubscription<TEventPayload> {
    const request = normalizeStreamRequest('health', {
      topics: [GATEWAY_EVENT_TOPICS.statusChanged],
      kinds: ['service.announced', 'service.stale'],
      ...options
    })
    return this.withStreamErrorHandling(subscribeWithReconnect<TEventPayload, unknown>(
      this.transportForRequest(request),
      request
    ))
  }

  watchConfig<TEventPayload = unknown>(
    options: AuroraSubscribeOptions = {}
  ): AuroraEventSubscription<TEventPayload> {
    const request = normalizeStreamRequest('config', {
      topics: [GATEWAY_EVENT_TOPICS.statusChanged],
      kinds: ['config.updated', 'config.validation_failed'],
      ...options
    })
    return this.withStreamErrorHandling(subscribeWithReconnect<TEventPayload, unknown>(
      this.transportForRequest(request),
      request
    ))
  }

  async snapshot<TEventPayload = unknown, TPayload = unknown>(
    options: AuroraSubscribeOptions<TPayload> & { afterSequence?: number | null | undefined } = {}
  ): Promise<AuroraEventSnapshot<TEventPayload>> {
    const request = normalizeSnapshotRequest(options)
    const transport = this.transportForRequest(request)
    if (!isEventSnapshotTransport(transport)) throw eventStreamUnsupported(transport.kind)
    try {
      return await transport.snapshot<TEventPayload, TPayload>(request)
    } catch (error) {
      const normalized = normalizeError(error)
      this.onStreamError?.(normalized)
      throw normalized
    }
  }

  private transportForRequest<TPayload>(request: AuroraSubscribeOptions<TPayload>): AuroraTransport {
    return request.source === 'native' && this.nativeSource ? this.nativeSource : this.transport
  }

  private withStreamErrorHandling<TPayload>(subscription: AuroraEventSubscription<TPayload>): AuroraEventSubscription<TPayload> {
    if (!this.onStreamError) return subscription
    const onStreamError = this.onStreamError
    const source = async function* (): AsyncIterable<AuroraEvent<TPayload>> {
      try {
        for await (const event of subscription) yield event
      } catch (error) {
        onStreamError(normalizeError(error))
        throw error
      }
    }
    return createEventSubscription(source(), (reason) => subscription.close(reason), subscription.ready)
  }
}

function sanitizeAssistantSubscription<TEventPayload>(
  subscription: AuroraEventSubscription<TEventPayload>
): AuroraEventSubscription<TEventPayload> {
  const source = async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
    for await (const event of subscription) yield sanitizeAssistantEvent(event)
  }
  return createEventSubscription(source(), (reason) => subscription.close(reason), subscription.ready)
}

function sanitizeAssistantEvent<TEventPayload>(event: AuroraEvent<TEventPayload>): AuroraEvent<TEventPayload> {
  if (!event.kind.startsWith('tool.')) return event
  const payload = sanitizeToolValue(event.payload) as TEventPayload
  if (payload === event.payload) return event
  return { ...event, payload }
}

function sanitizeToolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const cleaned = value.map((item) => {
      const next = sanitizeToolValue(item)
      changed ||= next !== item
      return next
    })
    return changed ? cleaned : value
  }
  if (!isObject(value)) return value
  let changed = false
  const cleaned: JsonObject = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'args' || key === 'arguments') {
      changed = true
      continue
    }
    const nested = sanitizeToolValue(nestedValue)
    cleaned[key] = nested as JsonObject[string]
    changed ||= nested !== nestedValue
  }
  return changed ? cleaned : value
}

export function normalizeStreamRequest<TPayload = unknown>(
  stream: AuroraEventStreamKind,
  options: AuroraSubscribeOptions<TPayload> = {}
): AuroraStreamRequest<TPayload> {
  const subjects = normalizeEventSubjects(options.subject, options.subjects)
  return {
    ...options,
    stream: options.stream ?? stream,
    topics: options.topics ?? [],
    kinds: options.kinds ?? [],
    subjects
  }
}

export function normalizeSnapshotRequest<TPayload = unknown>(
  options: AuroraSubscribeOptions<TPayload> & { afterSequence?: number | null | undefined } = {}
): AuroraEventSnapshotRequest<TPayload> {
  const request = normalizeStreamRequest('generic', options)
  return {
    ...request,
    afterSequence: options.afterSequence ?? null
  }
}

export function normalizeEventSubjects(
  subject?: string | NativeEventSubjectFilter | null,
  subjects: Array<string | NativeEventSubjectFilter> = []
): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  const add = (value: string | NativeEventSubjectFilter | null | undefined) => {
    const subjectId = normalizeEventSubject(value)
    if (!subjectId || seen.has(subjectId)) return
    seen.add(subjectId)
    normalized.push(subjectId)
  }
  add(subject)
  for (const value of subjects) add(value)
  return normalized
}

export function normalizeEventSubject(value: string | NativeEventSubjectFilter | null | undefined): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  const id = value.id.trim()
  if (!id) return null
  return id
}

export function isEventStreamTransport(transport: AuroraTransport): transport is AuroraEventStreamTransport {
  return typeof (transport as { subscribe?: unknown }).subscribe === 'function'
}

export function isEventSnapshotTransport(
  transport: AuroraTransport
): transport is AuroraEventStreamTransport & Required<Pick<AuroraEventStreamTransport, 'snapshot'>> {
  return typeof (transport as { snapshot?: unknown }).snapshot === 'function'
}

export function createEventSubscription<TPayload = unknown>(
  source: AsyncIterable<AuroraEvent<TPayload>>,
  onClose?: (reason?: unknown) => void,
  ready?: Promise<void>
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

  const subscription: AuroraEventSubscription<TPayload> = {
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
  if (ready) {
    Object.defineProperty(subscription, 'ready', {
      value: ready,
      enumerable: true
    })
  }
  return subscription
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
  const readiness = createReadinessGate()
  if (controller.signal.aborted) {
    readiness.reject(eventStreamClosedError())
    return createEventSubscription(async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
      // The caller cancelled before activation; do not touch the underlying transport.
    }(), () => {
      request.signal?.removeEventListener('abort', abortFromCaller)
    }, readiness.promise)
  }
  const active = reconnect.maxAttempts === 0
    ? createActiveEventStream<TEventPayload>(() => singleStream<TEventPayload, TPayload>(transport, request, controller.signal, readiness))
    : createActiveEventStream<TEventPayload>(() => reconnectingStream<TEventPayload, TPayload>(transport, request, reconnect, controller.signal, readiness))
  return createEventSubscription(active, () => {
    request.signal?.removeEventListener('abort', abortFromCaller)
    controller.abort()
    active.close()
  }, readiness.promise)
}

interface ReadinessGate {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function createReadinessGate(): ReadinessGate {
  let settled = false
  let resolvePromise: () => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  void promise.catch(() => undefined)
  return {
    promise,
    resolve() {
      if (settled) return
      settled = true
      resolvePromise()
    },
    reject(error: unknown) {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  }
}

function createActiveEventStream<TPayload>(
  sourceFactory: () => AsyncIterable<AuroraEvent<TPayload>>
): AsyncIterable<AuroraEvent<TPayload>> & { close(): void } {
  const source = sourceFactory()
  const iterator = source[Symbol.asyncIterator]()
  let closed = false
  let reading = false
  let buffered: IteratorResult<AuroraEvent<TPayload>> | null = null
  let bufferedError: unknown
  let hasBufferedError = false
  const waiters: Array<() => void> = []

  const wake = () => {
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const handleCleanupFailure = (error: unknown) => {
    bufferedError = error
    hasBufferedError = true
    closed = true
    wake()
  }
  const closeActive = () => {
    if (closed) return
    closed = true
    try {
      const cleanup = iterator.return?.()
      if (cleanup) void Promise.resolve(cleanup).catch(handleCleanupFailure)
    } catch (error) {
      handleCleanupFailure(error)
    }
    wake()
  }

  const prefetch = () => {
    if (closed || reading || buffered || hasBufferedError) return
    reading = true
    void iterator.next().then(
      (result) => {
        reading = false
        buffered = result
        if (result.done) closed = true
        wake()
      },
      (error) => {
        reading = false
        bufferedError = error
        hasBufferedError = true
        closed = true
        wake()
      }
    )
  }

  const waitForBufferedResult = async (): Promise<void> => {
    while (!closed && !buffered && !hasBufferedError) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  }

  prefetch()

  return {
    close: closeActive,
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          prefetch()
          await waitForBufferedResult()
          if (hasBufferedError) {
            const error = bufferedError
            bufferedError = undefined
            hasBufferedError = false
            throw error
          }
          if (!buffered) return { done: true, value: undefined }
          const result = buffered
          buffered = null
          return result
        },
        async return(): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          closeActive()
          return { done: true, value: undefined }
        },
        async throw(error?: unknown): Promise<IteratorResult<AuroraEvent<TPayload>>> {
          closeActive()
          throw error
        }
      }
    }
  }
}

async function* singleStream<TEventPayload, TPayload>(
  transport: AuroraEventStreamTransport,
  request: AuroraStreamRequest<TPayload>,
  signal: AbortSignal,
  readiness: ReadinessGate
): AsyncIterable<AuroraEvent<TEventPayload>> {
  let subscription: AuroraEventSubscription<TEventPayload>
  try {
    subscription = await openEventSubscription<TEventPayload, TPayload>(transport, request, signal)
    readiness.resolve()
  } catch (error) {
    readiness.reject(error)
    throw error
  }
  const iterator = subscription[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const result = await nextWithAbort(iterator, signal)
      if (result.done || signal.aborted) return
      notifyEventDiagnostic(request, result.value)
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
  signal: AbortSignal,
  readiness: ReadinessGate
): AsyncIterable<AuroraEvent<TEventPayload>> {
  let attempt = 0
  let lastEventId = request.lastEventId ?? null
  while (!signal.aborted) {
    const currentRequest = { ...request, lastEventId }
    let subscription: AuroraEventSubscription<TEventPayload>
    try {
      subscription = await openEventSubscription<TEventPayload, TPayload>(transport, currentRequest, signal)
      readiness.resolve()
    } catch (error) {
      attempt += 1
      if (attempt > reconnect.maxAttempts || signal.aborted) {
        const normalized = normalizeError(error)
        readiness.reject(normalized)
        throw normalized
      }
      try {
        await delay(backoff(attempt, reconnect), signal)
      } catch (delayError) {
        const normalized = normalizeError(delayError)
        readiness.reject(normalized)
        throw normalized
      }
      continue
    }
    const iterator = subscription[Symbol.asyncIterator]()
    let endedCleanly = false
    try {
      while (!signal.aborted) {
        const result = await nextWithAbort(iterator, signal)
        if (signal.aborted) return
        if (result.done) {
          endedCleanly = true
          break
        }
        const event = result.value
        attempt = 0
        lastEventId = event.id ?? lastEventId
        notifyEventDiagnostic(currentRequest, event)
        yield event
      }
    } catch (error) {
      subscription.close(error)
      attempt += 1
      if (attempt > reconnect.maxAttempts || signal.aborted) throw normalizeError(error)
      try {
        await delay(backoff(attempt, reconnect), signal)
      } catch (delayError) {
        throw normalizeError(delayError)
      }
    } finally {
      subscription.close()
    }
    if (endedCleanly && !signal.aborted) {
      attempt += 1
      if (attempt > reconnect.maxAttempts) {
        throw new AuroraError({
          code: 'transport_loss',
          message: 'Event stream ended before it was closed'
        })
      }
      await delay(backoff(attempt, reconnect), signal)
    }
  }
}

async function openEventSubscription<TEventPayload, TPayload>(
  transport: AuroraEventStreamTransport,
  request: AuroraStreamRequest<TPayload>,
  signal: AbortSignal
): Promise<AuroraEventSubscription<TEventPayload>> {
  if (signal.aborted) throw eventStreamClosedError()
  const { diagnostic: _diagnostic, ...transportRequest } = request
  const pendingSubscription = Promise.resolve(transport.subscribe<TEventPayload, TPayload>(transportRequest))
  void pendingSubscription.then(
    (subscription) => {
      if (signal.aborted) subscription.close('subscription-aborted')
    },
    () => undefined
  )
  const subscription = await raceWithAbort(pendingSubscription, signal)
  try {
    if (subscription.ready) await raceWithAbort(subscription.ready, signal)
    return subscription
  } catch (error) {
    subscription.close(error)
    throw error
  }
}

function notifyEventDiagnostic<TPayload>(
  request: AuroraStreamRequest<TPayload>,
  event: Pick<AuroraEvent, 'id' | 'kind'>,
): void {
  const diagnostic = request.diagnostic
  if (!diagnostic) return
  try {
    diagnostic({ stage: 'received', stream: request.stream, event })
    diagnostic({
      stage: request.kinds.includes(event.kind) ? 'filter.accepted' : 'filter.rejected',
      stream: request.stream,
      event,
    })
  } catch {
    // Diagnostics are strictly observational and must never affect delivery.
  }
}

function raceWithAbort<TValue>(promise: Promise<TValue>, signal: AbortSignal): Promise<TValue> {
  if (signal.aborted) return Promise.reject(eventStreamClosedError())
  return new Promise<TValue>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(eventStreamClosedError())
    }
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function nextWithAbort<TPayload>(
  iterator: AsyncIterator<AuroraEvent<TPayload>>,
  signal: AbortSignal
): Promise<IteratorResult<AuroraEvent<TPayload>>> {
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined })
  const next = iterator.next()
  return new Promise<IteratorResult<AuroraEvent<TPayload>>>((resolve, reject) => {
    const abort = () => {
      cleanup()
      resolve({ done: true, value: undefined })
    }
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
    }
    signal.addEventListener('abort', abort, { once: true })
    next.then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function eventStreamClosedError(): AuroraError {
  return new AuroraError({ code: 'timeout', message: 'Event stream subscription was closed' })
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
  const ceiling = Math.min(reconnect.initialDelayMs * 2 ** Math.max(0, attempt - 1), reconnect.maxDelayMs)
  return Math.floor(Math.random() * (ceiling + 1))
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw eventStreamClosedError()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      cleanup()
      if (timeout) clearTimeout(timeout)
      reject(eventStreamClosedError())
    }
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
    }
    signal.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}

function readPayload(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  if ('payload' in raw) return raw.payload
  if ('data' in raw) return raw.data
  if ('redacted_payload' in raw) return raw.redacted_payload
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
