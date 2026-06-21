import { AuroraError, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import { cloneFixture, defaultMockAuroraFixtures, type MockAuroraFixtureSet } from './fixtures.js'
import type { AuroraEvent, AuroraTransportEnvelope } from './types.js'
import type {
  AttachmentContextIngestRequest,
  AttachmentContextIngestResponse,
  AttachmentContextItem,
  AttachmentContextItemResult,
  AttachmentContextPrivacyClass,
  AttachmentContextStoragePolicy
} from './types.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'

export type MockHandler<TPayload = unknown, TData = unknown> = (
  request: AuroraTransportRequest<TPayload>
) => TData | AuroraTransportEnvelope<TData> | Promise<TData | AuroraTransportEnvelope<TData>>
export type MockRegistration<TPayload = unknown, TData = unknown> =
  | MockHandler<TPayload, TData>
  | TData
  | AuroraTransportEnvelope<TData>
export type MockEventRegistration<TPayload = unknown> =
  | Array<AuroraEvent<TPayload> | Record<string, unknown>>
  | ((request: AuroraStreamRequest) => AsyncIterable<AuroraEvent<TPayload> | Record<string, unknown>> | Iterable<AuroraEvent<TPayload> | Record<string, unknown>>)

export interface MockAuroraTransportOptions {
  fixtures?: MockAuroraFixtureSet | false
}

export class MockAuroraTransport implements AuroraTransport {
  readonly kind = 'mock'
  private readonly handlers = new Map<string, MockHandler>()
  private readonly eventHandlers = new Map<string, MockEventRegistration>()

  constructor(options: MockAuroraTransportOptions = {}) {
    const fixtures = options.fixtures === false ? null : options.fixtures ?? defaultMockAuroraFixtures
    if (fixtures) this.registerFixtures(fixtures)
  }

  static empty(): MockAuroraTransport {
    return new MockAuroraTransport({ fixtures: false })
  }

  registerFixtures(fixtures: MockAuroraFixtureSet): this {
    return this
      .register('Gateway.GetRegistry', () => cloneFixture(fixtures.registry))
      .register('Gateway.GetServices', () => cloneFixture(fixtures.services))
      .register('Gateway.GetDeploymentTopology', () => cloneFixture(fixtures.deploymentTopology))
      .register('Gateway.GetWebRTCDiagnostics', () => cloneFixture(fixtures.webrtcDiagnostics))
      .register('Gateway.GetCapabilityCatalog', () => cloneFixture(fixtures.capabilityCatalog))
      .register('Gateway.ExplainRoute', () => cloneFixture(fixtures.routeExplain))
      .register('Native.GetCapabilityManifest', () => cloneFixture(fixtures.nativeManifest))
      .register('Tooling.GetToolCatalog', () => cloneFixture(fixtures.toolCatalog))
      .register('Orchestrator.IngestContext', (request) => mockIngestContext(request.payload))
      .register('Orchestrator.ExternalUserInput', (request) => ({
        text: `Mock Aurora response to "${mockPromptText(request.payload)}"`,
        session_id: mockSessionId(request.payload),
        metadata: {
          model: 'mock-local',
          provider: 'mock-orchestrator'
        }
      }))
  }

  register<TPayload = unknown, TData = unknown>(
    method: string,
    registration: MockRegistration<TPayload, TData>
  ): this {
    const handler: MockHandler<TPayload, TData> =
      typeof registration === 'function'
        ? (registration as MockHandler<TPayload, TData>)
        : () => registration
    this.handlers.set(method, handler as MockHandler)
    return this
  }

  fail(method: string, code: AuroraErrorCode, message: string): this {
    return this.register(method, () => {
      throw new AuroraError({ code, message, method })
    })
  }

  lose(method: string, message = 'mock transport unavailable'): this {
    return this.register(method, () => {
      throw new TypeError(message)
    })
  }

  timeout(method: string, message = 'mock request timed out'): this {
    return this.register(method, () => {
      throw new DOMException(message, 'AbortError')
    })
  }

  stream<TPayload = unknown>(stream: string, registration: MockEventRegistration<TPayload>): this {
    this.eventHandlers.set(stream, registration as MockEventRegistration)
    return this
  }

  failStream(stream: string, code: AuroraErrorCode, message: string): this {
    return this.stream(stream, async function* () {
      throw new AuroraError({ code, message, detail: { stream } })
    })
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const handler = this.handlers.get(request.method) ?? (request.busTopic ? this.handlers.get(request.busTopic) : undefined)
    if (!handler) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: `No mock handler registered for ${request.method}`,
        method: request.method,
        busTopic: request.busTopic
      })
    }
    const value = await handler(request)
    if (isTransportEnvelope<TData>(value)) return value
    return {
      data: value as TData,
      status: 200,
      audit: {
        method: request.method,
        busTopic: request.busTopic ?? null,
        transport: this.kind
      }
    }
  }

  subscribe<TEventPayload = unknown>(
    request: AuroraStreamRequest
  ): AuroraEventSubscription<TEventPayload> {
    const registration = this.eventHandlers.get(request.stream) ?? this.eventHandlers.get('*')
    if (!registration) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: `No mock event stream registered for ${request.stream}`,
        detail: { stream: request.stream, topics: request.topics }
      })
    }
    const source = (typeof registration === 'function' ? registration(request) : registration) as
      | AsyncIterable<AuroraEvent<TEventPayload> | Record<string, unknown>>
      | Iterable<AuroraEvent<TEventPayload> | Record<string, unknown>>
    return createEventSubscription(normalizeMockEvents<TEventPayload>(source, request))
  }
}

function mockPromptText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'prompt'
  const text = (payload as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text.trim() : 'prompt'
}

function mockSessionId(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const sessionId = (payload as { session_id?: unknown }).session_id
    if (typeof sessionId === 'string' && sessionId.trim()) return sessionId
  }
  return 'mock-assistant-session'
}

function mockIngestContext(payload: unknown): AttachmentContextIngestResponse {
  const request = normalizeIngestRequest(payload)
  const acceptedItems: AttachmentContextItemResult[] = []
  const rejectedItems: AttachmentContextItemResult[] = []
  let totalBytes = 0

  request.items.forEach((item, index) => {
    const itemBytes = contextItemSize(item)
    totalBytes += itemBytes
    const base = contextResult(item, index, request.storage_policy, request.privacy_class, itemBytes)

    if (request.storage_policy === 'reject') {
      rejectedItems.push({
        ...base,
        status: 'rejected',
        reason_code: 'storage_policy_reject',
        message: 'Storage policy rejects attachment/context ingestion'
      })
      return
    }

    if (['secret', 'credential', 'raw-audio'].includes(request.privacy_class)) {
      rejectedItems.push({
        ...base,
        status: 'rejected',
        reason_code: 'privacy_class_blocked',
        message: 'Privacy class is not accepted for assistant context ingestion'
      })
      return
    }

    if (itemBytes > request.limits.max_item_bytes) {
      rejectedItems.push({
        ...base,
        status: 'rejected',
        reason_code: 'item_too_large',
        message: `Context item exceeds limit ${request.limits.max_item_bytes} bytes`
      })
      return
    }

    if (totalBytes > request.limits.max_total_bytes) {
      rejectedItems.push({
        ...base,
        status: 'rejected',
        reason_code: 'total_too_large',
        message: `Context batch exceeds limit ${request.limits.max_total_bytes} bytes`
      })
      return
    }

    if (!contextText(item)) {
      rejectedItems.push({
        ...base,
        status: 'unsupported',
        reason_code: 'no_text_context',
        message: 'Only text-like attachment/context content is supported'
      })
      return
    }

    const redacted = contextText(item).includes('sk-') || contextText(item).includes('password')
    acceptedItems.push({
      ...base,
      status: redacted ? 'redacted' : request.storage_policy === 'rag' ? 'stored' : 'accepted',
      stored_namespace: request.storage_policy === 'rag' ? request.namespace : null,
      stored_key: request.storage_policy === 'rag' ? `mock-context-${index}` : null,
      redacted,
      redaction_reasons: redacted ? ['secret_pattern'] : [],
      message: 'Context accepted for assistant use'
    })
  })

  return {
    accepted: acceptedItems.length > 0,
    rejected: rejectedItems.length > 0,
    total_items: request.items.length,
    accepted_items: acceptedItems,
    rejected_items: rejectedItems,
    total_bytes: totalBytes,
    storage_policy: request.storage_policy,
    privacy_class: request.privacy_class,
    audit_event: 'assistant.context.ingested',
    correlation_id: request.correlation_id ?? 'mock-context-correlation',
    secrets_redacted: true
  }
}

function normalizeIngestRequest(payload: unknown): Required<Pick<
  AttachmentContextIngestRequest,
  'items' | 'namespace' | 'storage_policy' | 'privacy_class'
>> & Pick<AttachmentContextIngestRequest, 'correlation_id'> & {
  limits: Required<NonNullable<AttachmentContextIngestRequest['limits']>>
} {
  const input = typeof payload === 'object' && payload !== null ? payload as AttachmentContextIngestRequest : { items: [] }
  return {
    items: Array.isArray(input.items) ? input.items : [],
    namespace: input.namespace ?? 'assistant.attachments',
    storage_policy: input.storage_policy ?? 'ephemeral',
    privacy_class: input.privacy_class ?? 'personal',
    correlation_id: input.correlation_id ?? null,
    limits: {
      max_items: input.limits?.max_items ?? 8,
      max_item_bytes: input.limits?.max_item_bytes ?? 262_144,
      max_total_bytes: input.limits?.max_total_bytes ?? 1_048_576,
      max_text_chars: input.limits?.max_text_chars ?? 120_000
    }
  }
}

function contextResult(
  item: AttachmentContextItem,
  index: number,
  storagePolicy: AttachmentContextStoragePolicy,
  privacyClass: AttachmentContextPrivacyClass,
  acceptedBytes: number
): AttachmentContextItemResult {
  return {
    item_id: `mock-context-${index}`,
    kind: item.kind,
    status: 'accepted',
    storage_policy: storagePolicy,
    privacy_class: privacyClass,
    accepted_bytes: acceptedBytes,
    stored_namespace: null,
    stored_key: null,
    redacted: false,
    redaction_reasons: [],
    reason_code: null,
    message: ''
  }
}

function contextItemSize(item: AttachmentContextItem): number {
  if (typeof item.size_bytes === 'number') return item.size_bytes
  return new TextEncoder().encode(contextText(item)).length
}

function contextText(item: AttachmentContextItem): string {
  return item.content_text ?? item.url ?? item.title ?? ''
}

async function* normalizeMockEvents<TPayload>(
  source: AsyncIterable<AuroraEvent<TPayload> | Record<string, unknown>> | Iterable<AuroraEvent<TPayload> | Record<string, unknown>>,
  request: AuroraStreamRequest
): AsyncIterable<AuroraEvent<TPayload>> {
  for await (const raw of source) {
    const event = eventFromUnknown<TPayload>(raw, {
      kind: request.stream,
      transport: 'mock',
      audit: request.audit
    })
    if (request.lastEventId && event.id && event.id <= request.lastEventId) continue
    if (request.kinds.length > 0 && !request.kinds.includes(event.kind)) continue
    yield event
  }
}

function isTransportEnvelope<TData>(value: unknown): value is AuroraTransportEnvelope<TData> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    ('status' in value || 'headers' in value || 'audit' in value)
  )
}
