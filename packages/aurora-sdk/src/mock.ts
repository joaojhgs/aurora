import { AuroraError, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import { cloneFixture, defaultMockAuroraFixtures, memorySearchFixture, type MockAuroraFixtureSet } from './fixtures.js'
import type { DBRAGSearchRemoteRequest } from './memory.js'
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
      .register('Backup.List', () => cloneFixture(fixtures.backups))
      .register('Scheduler.ListJobs', () => cloneFixture(fixtures.schedulerJobs))
      .register('Scheduler.Schedule', () => mockSchedulerAction('schedule', 'job-mock-created'))
      .register('Scheduler.Cancel', (request) => mockSchedulerAction('cancel', schedulerJobId(request.payload)))
      .register('Scheduler.Pause', (request) => mockSchedulerAction('pause', schedulerJobId(request.payload)))
      .register('Scheduler.Resume', (request) => mockSchedulerAction('resume', schedulerJobId(request.payload)))
      .register('Gateway.GetSupportBundle', () => cloneFixture(fixtures.supportBundle))
      .register('Gateway.AdminActionDraft', (request) => {
        const payload = request.payload as { method_id?: string; affected_resources?: string[] } | undefined
        return {
          action_id: 'mock-admin-action',
          nonce: 'mock-nonce',
          digest: 'mock-digest',
          method_id: payload?.method_id ?? 'Gateway.GetSupportBundle',
          affected_resources: payload?.affected_resources ?? ['diagnostics.support_bundle'],
          required_phrase: 'CONFIRM',
          required_reason: true,
          required_reauth: true,
          expires_at: '2026-06-19T00:10:00Z',
          expires_in_seconds: 300,
          confirmation_headers: {
            action_id: 'X-Aurora-AdminAction-Id',
            confirmation_token: 'X-Aurora-AdminAction-Token',
            digest: 'X-Aurora-AdminAction-Digest'
          }
        }
      })
      .register('Gateway.AdminActionConfirm', () => ({
        action_id: 'mock-admin-action',
        confirmation_token: 'mock-confirmation-token',
        digest: 'mock-digest',
        confirmed: true,
        expires_at: '2026-06-19T00:10:00Z',
        audit_receipt: 'aar-mock-admin-action',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }))
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
      .register('Auth.ListTokens', (request) => mockListTokens(fixtures.tokens, request.payload))
      .register('Auth.RevokeToken', () => ({ success: true }))
      .register('Auth.ListDevices', (request) => mockListDevices(fixtures.devices, request.payload))
      .register('Auth.DeleteDevice', () => ({ success: true }))
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

function schedulerJobId(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const jobId = (payload as { job_id?: unknown }).job_id
    if (typeof jobId === 'string' || typeof jobId === 'number') return String(jobId)
  }
  return 'job-mock'
}

function mockSchedulerAction(action: string, jobId: string) {
  return {
    ok: true,
    status: 'ok',
    job_id: jobId,
    action,
    reason: null,
    audit_event: `audit:scheduler:${action}:${jobId}`
  }
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

function mockListTokens(
  tokens: { tokens: Array<{ device_id?: string | null; user_id?: string | null }> },
  payload: unknown
) {
  const request = typeof payload === 'object' && payload !== null
    ? payload as { device_id?: unknown; principal_id?: unknown }
    : {}
  const deviceId = typeof request.device_id === 'string' ? request.device_id : null
  const principalId = typeof request.principal_id === 'string' ? request.principal_id : null
  return {
    tokens: cloneFixture(tokens.tokens).filter((token) => {
      if (deviceId && token.device_id !== deviceId) return false
      if (principalId && token.user_id !== principalId) return false
      return true
    })
  }
}

function mockListDevices(
  devices: { devices: Array<{ user_id?: string | null }> },
  payload: unknown
) {
  const request = typeof payload === 'object' && payload !== null ? payload as { principal_id?: unknown } : {}
  const principalId = typeof request.principal_id === 'string' ? request.principal_id : null
  return {
    devices: cloneFixture(devices.devices).filter((device) => !principalId || device.user_id === principalId)
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
