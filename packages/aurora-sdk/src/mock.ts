import { AuroraError, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import { cloneFixture, defaultMockAuroraFixtures, memorySearchFixture, type MockAuroraFixtureSet } from './fixtures.js'
import type { DBRAGSearchRemoteRequest } from './memory.js'
import type { AuthTokenCreateRequest, AuthTokenListResponse, AuthTokenRevokeRequest, AuthTokenScopeUpdateRequest, AuroraEvent, AuroraTransportEnvelope } from './types.js'
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
  private tokens: AuthTokenListResponse['tokens'] = []

  constructor(options: MockAuroraTransportOptions = {}) {
    const fixtures = options.fixtures === false ? null : options.fixtures ?? defaultMockAuroraFixtures
    if (fixtures) this.registerFixtures(fixtures)
  }

  static empty(): MockAuroraTransport {
    return new MockAuroraTransport({ fixtures: false })
  }

  registerFixtures(fixtures: MockAuroraFixtureSet): this {
    this.tokens = cloneFixture(fixtures.tokens).tokens
    return this
      .register('Gateway.GetRegistry', () => cloneFixture(fixtures.registry))
      .register('Gateway.GetServices', () => cloneFixture(fixtures.services))
      .register('Gateway.GetDeploymentTopology', () => cloneFixture(fixtures.deploymentTopology))
      .register('Gateway.GetWebRTCDiagnostics', () => cloneFixture(fixtures.webrtcDiagnostics))
      .register('Gateway.GetCapabilityCatalog', () => cloneFixture(fixtures.capabilityCatalog))
      .register('Gateway.ExplainRoute', () => cloneFixture(fixtures.routeExplain))
      .register('Gateway.AdminActionDraft', (request) => mockAdminActionDraft(request.payload))
      .register('Gateway.AdminActionConfirm', (request) => mockAdminActionConfirm(request.payload))
      .register('Native.GetCapabilityManifest', () => cloneFixture(fixtures.nativeManifest))
      .register('Auth.ListTokens', (request) => mockListTokens(this.tokens, request.payload))
      .register('Auth.CreateToken', (request) => mockCreateToken(this.tokens, request.payload))
      .register('Auth.UpdateTokenScopes', (request) => mockUpdateTokenScopes(this.tokens, request.payload))
      .register('Auth.RevokeToken', (request) => mockRevokeToken(this.tokens, request.payload))
      .register('Tooling.GetToolCatalog', () => cloneFixture(fixtures.toolCatalog))
      .register('Orchestrator.GetModelCatalog', () => cloneFixture(fixtures.modelRuntimeCatalog))
      .register('Orchestrator.GetModelRuntime', () => ({
        generated_at: fixtures.modelRuntimeCatalog.generated_at,
        selected_provider_id: fixtures.modelRuntimeCatalog.selected_provider_id,
        provider:
          fixtures.modelRuntimeCatalog.providers.find(
            (provider) => provider.provider_id === fixtures.modelRuntimeCatalog.selected_provider_id
          ) ?? null,
        providers: cloneFixture(fixtures.modelRuntimeCatalog.providers),
        secrets_redacted: fixtures.modelRuntimeCatalog.secrets_redacted
      }))
      .register('Orchestrator.IngestContext', (request) => mockIngestContext(request.payload))
      .register('DB.GetMessages', () => cloneFixture(fixtures.memoryMessages))
      .register('DB.RAGListNamespaces', () => cloneFixture(fixtures.memoryNamespaces))
      .register('DB.RAGSearchRemote', (request) => memorySearchFixture(request.payload as DBRAGSearchRemoteRequest))
      .register('DB.RAGExportNamespace', () => cloneFixture(fixtures.memoryExport))
      .register('DB.RAGImportNamespace', () => cloneFixture(fixtures.memoryImport))
      .register('DB.RAGDelete', () => ({ success: true }))
      .register('Auth.ListPrincipals', () => cloneFixture(fixtures.principals))
      .register('Auth.GetPrincipal', (request) => mockPrincipal(fixtures.principals, request.payload))
      .register('Auth.CreatePrincipal', (request) => mockCreatePrincipal(request.payload))
      .register('Auth.UpdatePrincipal', (request) => mockUpdatePrincipal(fixtures.principals, request.payload))
      .register('Auth.DeletePrincipal', () => ({ success: true }))
      .register('Auth.SetPermissions', () => ({ success: true }))
      .register('Auth.PatchPermissions', () => ({ success: true }))
      .register('Auth.AuditLog', () => cloneFixture(fixtures.auditLog))
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

function mockAdminActionDraft(payload: unknown) {
  const methodId = methodIdFromPayload(payload)
  const actionId = `aa-${methodId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return {
    action_id: actionId,
    nonce: `nonce-${actionId}`,
    digest: `digest-${actionId}`,
    method_id: methodId,
    affected_resources: Array.isArray((payload as { affected_resources?: unknown })?.affected_resources)
      ? (payload as { affected_resources: string[] }).affected_resources
      : [],
    required_phrase: methodId.split('.').pop() ?? methodId,
    required_reason: true,
    required_reauth: false,
    expires_at: '2030-01-01T00:00:00Z',
    expires_in_seconds: 300,
    confirmation_headers: adminActionHeaders()
  }
}

function mockAdminActionConfirm(payload: unknown) {
  const actionId = typeof (payload as { action_id?: unknown })?.action_id === 'string'
    ? (payload as { action_id: string }).action_id
    : 'aa-mock'
  return {
    action_id: actionId,
    confirmation_token: `confirm-${actionId}`,
    digest: typeof (payload as { digest?: unknown })?.digest === 'string'
      ? (payload as { digest: string }).digest
      : `digest-${actionId}`,
    confirmed: true,
    expires_at: '2030-01-01T00:00:00Z',
    audit_receipt: `audit-${actionId}`,
    confirmation_headers: adminActionHeaders()
  }
}

function adminActionHeaders() {
  return {
    action_id: 'X-Aurora-AdminAction-Id',
    confirmation_token: 'X-Aurora-AdminAction-Token',
    digest: 'X-Aurora-AdminAction-Digest'
  }
}

function methodIdFromPayload(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const methodId = (payload as { method_id?: unknown }).method_id
    if (typeof methodId === 'string' && methodId.trim()) return methodId
  }
  return 'Gateway.AdminAction'
}

function mockListTokens(tokens: AuthTokenListResponse['tokens'], payload: unknown): AuthTokenListResponse {
  const principalId = typeof (payload as { principal_id?: unknown })?.principal_id === 'string'
    ? (payload as { principal_id: string }).principal_id
    : null
  const deviceId = typeof (payload as { device_id?: unknown })?.device_id === 'string'
    ? (payload as { device_id: string }).device_id
    : null
  return {
    tokens: tokens
      .filter((token) => !principalId || token.user_id === principalId)
      .filter((token) => !deviceId || token.device_id === deviceId)
      .map((token) => ({ ...token, scopes: [...token.scopes] }))
  }
}

function mockCreateToken(tokens: AuthTokenListResponse['tokens'], payload: unknown) {
  const request = payload as Partial<AuthTokenCreateRequest>
  const principalId = typeof request.principal_id === 'string' && request.principal_id.trim()
    ? request.principal_id.trim()
    : 'mock-principal'
  const id = `token-created-${tokens.length + 1}`
  const prefix = `mk_${String(tokens.length + 1).padStart(4, '0')}`
  const expiresAt = '2030-01-01T00:00:00Z'
  const scopes = Array.isArray(request.scopes) && request.scopes.length > 0 ? [...request.scopes] : ['Gateway.use']
  tokens.unshift({
    id,
    prefix,
    device_id: request.device_id ?? null,
    user_id: principalId,
    scopes,
    created_at: '2026-06-25T00:00:00Z',
    expires_at: expiresAt
  })
  return {
    token: `mock-created-token-value-${prefix}`,
    id,
    prefix,
    scopes,
    expires_at: expiresAt
  }
}

function mockUpdateTokenScopes(tokens: AuthTokenListResponse['tokens'], payload: unknown) {
  const request = payload as Partial<AuthTokenScopeUpdateRequest>
  const token = tokens.find((candidate) => candidate.id === request.token_id)
  if (!token || !Array.isArray(request.scopes)) return { success: false }
  token.scopes = [...request.scopes]
  return { success: true }
}

function mockRevokeToken(tokens: AuthTokenListResponse['tokens'], payload: unknown) {
  const request = payload as Partial<AuthTokenRevokeRequest>
  const index = tokens.findIndex((candidate) => candidate.id === request.token_id)
  if (index < 0) return { success: false }
  tokens.splice(index, 1)
  return { success: true }
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

function mockPrincipal(
  principals: { principals: Array<{ id: string; username: string; permissions: string[]; is_admin: boolean; created_at?: string | null }> },
  payload: unknown
) {
  const userId = typeof payload === 'object' && payload !== null ? (payload as { user_id?: unknown }).user_id : null
  const principal = principals.principals.find((candidate) => candidate.id === userId)
  if (!principal) {
    throw new AuroraError({ code: 'unknown', status: 404, message: 'Principal not found', method: 'Auth.GetPrincipal' })
  }
  return cloneFixture(principal)
}

function mockCreatePrincipal(payload: unknown) {
  const request = typeof payload === 'object' && payload !== null ? payload as { username?: unknown; permissions?: unknown; is_admin?: unknown } : {}
  return {
    id: `principal-${String(request.username ?? 'new').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    username: typeof request.username === 'string' ? request.username : 'new-principal',
    permissions: Array.isArray(request.permissions) ? request.permissions.filter((item): item is string => typeof item === 'string') : [],
    is_admin: Boolean(request.is_admin),
    created_at: new Date(0).toISOString()
  }
}

function mockUpdatePrincipal(
  principals: { principals: Array<{ id: string; username: string; permissions: string[]; is_admin: boolean; created_at?: string | null }> },
  payload: unknown
) {
  const request = typeof payload === 'object' && payload !== null ? payload as { user_id?: unknown; username?: unknown; is_admin?: unknown } : {}
  const principal = principals.principals.find((candidate) => candidate.id === request.user_id)
  if (!principal) {
    throw new AuroraError({ code: 'unknown', status: 404, message: 'Principal not found', method: 'Auth.UpdatePrincipal' })
  }
  return {
    ...cloneFixture(principal),
    username: typeof request.username === 'string' ? request.username : principal.username,
    is_admin: typeof request.is_admin === 'boolean' ? request.is_admin : principal.is_admin
  }
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
