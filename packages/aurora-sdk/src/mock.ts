import { AuroraError, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import { cloneFixture, defaultMockAuroraFixtures, type MockAuroraFixtureSet } from './fixtures.js'
import type { AuroraEvent, AuroraTransportEnvelope } from './types.js'
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
      .register('Config.Get', () => cloneFixture(fixtures.configGet))
      .register('Config.Validate', () => cloneFixture(fixtures.configValidate))
      .register('Config.GetSchemaMetadata', () => cloneFixture(fixtures.configSchemaMetadata))
      .register('Config.PreviewDiff', () => cloneFixture(fixtures.configDiffPreview))
      .register('Config.GetVersionHistory', () => cloneFixture(fixtures.configVersionHistory))
      .register('Config.PreviewReloadImpact', () => cloneFixture(fixtures.configReloadImpact))
      .register('Config.Set', () => cloneFixture(fixtures.configSet))
      .register('Config.Rollback', () => cloneFixture(fixtures.configRollback))
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
