import { AuroraError, type AuroraErrorCode } from './errors.js'
import type {
  AuditReceipt,
  AuroraEvent,
  AuroraRequest,
  AuroraResult,
  AuroraTransportEnvelope,
  AuroraTransportKind,
  JsonObject,
  RedactionMetadata
} from './types.js'

export type AuroraTransportRequest<TPayload = unknown> = AuroraRequest<TPayload>
export type AuroraTransportResponse<TData = unknown> = AuroraTransportEnvelope<TData>

export interface AuroraTransport {
  readonly kind: AuroraTransportKind
  request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>>
}

export type AuroraResponse<TData> = AuroraResult<TData>

export async function captureResult<TData>(
  operation: () => Promise<TData>,
  audit: Partial<AuditReceipt> = {}
): Promise<AuroraResponse<TData>> {
  try {
    const data = await operation()
    return {
      ok: true,
      data,
      audit: createAuditReceipt(data, audit)
    }
  } catch (error) {
    const normalized = normalizeError(error)
    return {
      ok: false,
      error: normalized,
      audit: createAuditReceipt(normalized.detail, {
        ...audit,
        correlationId: normalized.correlationId ?? audit.correlationId ?? null,
        method: normalized.method ?? audit.method ?? null,
        busTopic: normalized.busTopic ?? audit.busTopic ?? null,
        status: normalized.code
      })
    }
  }
}

export function normalizeError(error: unknown): AuroraError {
  if (error instanceof AuroraError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AuroraError({ code: 'timeout', message: 'Aurora request timed out', cause: error })
  }
  if (error instanceof TypeError) {
    return new AuroraError({ code: 'transport_loss', message: error.message, cause: error })
  }
  if (error instanceof Error) {
    return new AuroraError({ code: 'unknown', message: error.message, cause: error })
  }
  return new AuroraError({ code: 'unknown', message: 'Aurora request failed', detail: error })
}

export function unsupportedTransport(kind: string, feature: string, code: AuroraErrorCode): AuroraError {
  return new AuroraError({
    code,
    message: `${feature} is not supported by the ${kind} transport`
  })
}

export function createAuditReceipt(source: unknown, overrides: Partial<AuditReceipt> = {}): AuditReceipt {
  return {
    correlationId: overrides.correlationId ?? readString(source, 'correlation_id', 'correlationId') ?? null,
    eventKind: overrides.eventKind ?? readString(source, 'event_kind', 'eventKind', 'kind') ?? null,
    peerId: overrides.peerId ?? readString(source, 'peer_id', 'peerId') ?? null,
    principalId: overrides.principalId ?? readString(source, 'principal_id', 'principalId') ?? null,
    targetPeerId: overrides.targetPeerId ?? readString(source, 'target_peer_id', 'targetPeerId') ?? null,
    method: overrides.method ?? readString(source, 'method') ?? null,
    busTopic: overrides.busTopic ?? readString(source, 'bus_topic', 'busTopic', 'topic') ?? null,
    toolId: overrides.toolId ?? readString(source, 'tool_id', 'toolId') ?? null,
    resourceId: overrides.resourceId ?? readString(source, 'resource_id', 'resourceId') ?? null,
    status: overrides.status ?? readString(source, 'status', 'result') ?? null,
    transport: overrides.transport ?? null,
    redaction: {
      ...createRedactionMetadata(source),
      ...overrides.redaction,
      redactedFields: overrides.redaction?.redactedFields ?? createRedactionMetadata(source).redactedFields,
      warnings: overrides.redaction?.warnings ?? createRedactionMetadata(source).warnings
    }
  }
}

export function createRedactionMetadata(source: unknown): RedactionMetadata {
  const backendRedactionFlag = readBoolean(source, 'secrets_redacted', 'secretsRedacted')
  const secretsRedacted = backendRedactionFlag ?? true
  return {
    secretsRedacted,
    redactedFields: readStringList(source, 'redacted_fields', 'redactedFields'),
    source: backendRedactionFlag === null ? 'sdk' : 'backend',
    warnings: readStringList(source, 'redaction_warnings', 'redactionWarnings')
  }
}

export function auditFromHeaders(headers: Headers | Record<string, string> | undefined): Partial<AuditReceipt> {
  const correlationId = readHeader(headers, 'x-correlation-id') ?? readHeader(headers, 'x-request-id')
  return correlationId ? { correlationId } : {}
}

export function createAuroraEvent<TPayload = unknown>(
  kind: string,
  payload: TPayload,
  audit: Partial<AuditReceipt> = {}
): AuroraEvent<TPayload> {
  const receipt = createAuditReceipt(payload, {
    ...audit,
    eventKind: audit.eventKind ?? kind
  })
  return {
    id: readString(payload, 'id', 'event_id', 'eventId'),
    kind,
    topic: readString(payload, 'topic'),
    method: receipt.method,
    busTopic: receipt.busTopic,
    payload,
    audit: receipt,
    redaction: receipt.redaction,
    receivedAt: new Date().toISOString()
  }
}

function readString(data: unknown, ...keys: string[]): string | null {
  if (!isObject(data)) return null
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string') return value
  }
  return null
}

function readBoolean(data: unknown, ...keys: string[]): boolean | null {
  if (!isObject(data)) return null
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

function readStringList(data: unknown, ...keys: string[]): string[] {
  if (!isObject(data)) return []
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  }
  return []
}

function readHeader(headers: Headers | Record<string, string> | undefined, key: string): string | null {
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(key)
  const direct = headers[key]
  if (direct) return direct
  const found = Object.entries(headers).find(([header]) => header.toLowerCase() === key)
  return found?.[1] ?? null
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
