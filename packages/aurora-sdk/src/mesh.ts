import { AuroraError, readDetailCode, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'
import type { AuditReceipt, AuroraEvent, AuroraTransportEnvelope, JsonObject } from './types.js'

export type MeshPeerId = string

export interface MeshAddressSelector {
  peer_id?: string | null
  peerId?: string | null
  provider_id?: string | null
  providerId?: string | null
  service_instance_id?: string | null
  serviceInstanceId?: string | null
  module?: string | null
  resource_id?: string | null
  resourceId?: string | null
  tool_id?: string | null
  toolId?: string | null
  [key: string]: unknown
}

export interface MeshRouteCandidate {
  peerId: string
  providerId?: string | null
  serviceInstanceId?: string | null
  module?: string | null
  latencyMs?: number | null
  eligible?: boolean | undefined
  reasonCode?: string | null
  fallback?: boolean | undefined
}

export interface MeshPeerManifest {
  peerId: string
  nodeName?: string | null
  version?: string | null
  trusted?: boolean | undefined
  authenticated?: boolean | undefined
  services?: Array<{
    module: string
    version?: string | null
    methods?: string[]
    capabilities?: string[]
    providerId?: string | null
    serviceInstanceId?: string | null
  }>
  raw?: unknown
}

export interface MeshRpcRequest<TPayload = unknown> {
  peerId: string
  method: string
  busTopic: string
  payload?: TPayload | undefined
  timeoutMs: number
  selector?: MeshAddressSelector | undefined
  candidates: MeshRouteCandidate[]
  correlationId?: string | undefined
  audit?: Partial<AuditReceipt> | undefined
}

export interface MeshRpcResponse<TData = unknown> {
  data?: TData | undefined
  error?: unknown
  status?: string | number | undefined
  correlationId?: string | null | undefined
  fallbackUsed?: boolean | undefined
  peerId?: string | null | undefined
  targetPeerId?: string | null | undefined
  providerId?: string | null | undefined
  serviceInstanceId?: string | null | undefined
  headers?: Headers | Record<string, string> | undefined
  audit?: Partial<AuditReceipt> | undefined
  redactedFields?: string[] | undefined
  secretsRedacted?: boolean | undefined
}

export interface MeshPeerBridge {
  call<TPayload = unknown>(
    request: MeshRpcRequest<TPayload>
  ): Promise<MeshRpcResponse<unknown> | AuroraTransportEnvelope<unknown> | unknown>
  subscribe?<TEventPayload = unknown>(
    request: MeshStreamRpcRequest
  ): AsyncIterable<AuroraEvent<TEventPayload> | Record<string, unknown>> | Iterable<AuroraEvent<TEventPayload> | Record<string, unknown>>
  getManifest?(peerId: string): Promise<MeshPeerManifest | null>
}

export interface MeshStreamRpcRequest extends AuroraStreamRequest {
  peerId: string
  selector?: MeshAddressSelector | undefined
  candidates: MeshRouteCandidate[]
}

export interface MeshRouteResolver {
  resolve(request: AuroraTransportRequest): Promise<MeshRouteResolution> | MeshRouteResolution
}

export interface MeshRouteResolution {
  peerId?: string | null
  selector?: MeshAddressSelector | null
  candidates?: MeshRouteCandidate[]
  fallbackAllowed?: boolean | undefined
  unavailableReason?: string | null
  privacyBlockedReason?: string | null
}

export interface MeshP2PTransportOptions {
  bridge: MeshPeerBridge
  routeResolver?: MeshRouteResolver | ((request: AuroraTransportRequest) => Promise<MeshRouteResolution> | MeshRouteResolution)
  defaultPeerId?: string
  defaultTimeoutMs?: number
  fallbackPeerIds?: string[]
}

export class MeshP2PTransport implements AuroraTransport {
  readonly kind = 'mesh'
  private readonly bridge: MeshPeerBridge
  private readonly routeResolver: MeshRouteResolver | undefined
  private readonly defaultPeerId: string | undefined
  private readonly defaultTimeoutMs: number
  private readonly fallbackPeerIds: string[]

  constructor(options: MeshP2PTransportOptions) {
    this.bridge = options.bridge
    this.routeResolver =
      typeof options.routeResolver === 'function' ? { resolve: options.routeResolver } : options.routeResolver
    this.defaultPeerId = options.defaultPeerId
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
    this.fallbackPeerIds = options.fallbackPeerIds ?? []
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const topic = request.busTopic ?? request.method
    const resolution = await this.resolveRoute(request)
    if (resolution.privacyBlockedReason) {
      throw meshError('privacy_blocked', resolution.privacyBlockedReason, request, {
        reason_code: 'privacy_blocked',
        selector: resolution.selector ?? null
      })
    }
    if (!resolution.peerId) {
      throw meshError('unavailable_service', resolution.unavailableReason ?? `No mesh provider for ${topic}`, request, {
        reason_code: resolution.unavailableReason ?? 'no_route',
        candidates: resolution.candidates ?? []
      })
    }

    const candidates = normalizeCandidates(resolution, this.fallbackPeerIds)
    const callRequest: MeshRpcRequest<TPayload> = {
      peerId: resolution.peerId,
      method: request.method,
      busTopic: topic,
      payload: request.payload,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      candidates
    }
    if (resolution.selector) callRequest.selector = resolution.selector
    if (request.audit?.correlationId) callRequest.correlationId = request.audit.correlationId
    if (request.audit) callRequest.audit = request.audit

    try {
      const response = await this.bridge.call<TPayload>(callRequest)
      const envelope = toMeshEnvelope<TData>(response, request, resolution.peerId, candidates)
      if (envelope.error !== undefined) throw meshError(classifyMeshError(envelope.error), readMeshErrorMessage(envelope.error), request, envelope.error)
      return {
        data: envelope.data as TData,
        status: envelope.status,
        headers: envelope.headers,
        audit: {
          ...envelope.audit,
          method: envelope.audit?.method ?? request.method,
          busTopic: envelope.audit?.busTopic ?? topic,
          targetPeerId: envelope.audit?.targetPeerId ?? envelope.targetPeerId ?? resolution.peerId,
          peerId: envelope.audit?.peerId ?? envelope.peerId ?? null,
          transport: this.kind,
          status: envelope.audit?.status ?? readStatus(envelope.status)
        }
      }
    } catch (error) {
      if (error instanceof AuroraError) throw error
      throw normalizeMeshTransportError(error, request)
    }
  }

  getManifest(peerId: string): Promise<MeshPeerManifest | null> {
    if (!this.bridge.getManifest) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Mesh peer manifest lookup is not supported by this bridge.'
      })
    }
    return this.bridge.getManifest(peerId)
  }

  async subscribe<TEventPayload = unknown>(
    request: AuroraStreamRequest
  ): Promise<AuroraEventSubscription<TEventPayload>> {
    if (!this.bridge.subscribe) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Mesh event subscriptions are not supported by this bridge.',
        detail: { stream: request.stream, topics: request.topics }
      })
    }
    const resolution = await this.resolveRoute({
      method: request.stream,
      busTopic: request.topics[0] ?? request.stream,
      payload: request.payload,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      audit: request.audit
    })
    if (resolution.privacyBlockedReason) {
      throw new AuroraError({
        code: 'privacy_blocked',
        message: resolution.privacyBlockedReason,
        detail: { stream: request.stream, selector: resolution.selector ?? null }
      })
    }
    if (!resolution.peerId) {
      throw new AuroraError({
        code: 'unavailable_service',
        message: resolution.unavailableReason ?? `No mesh provider for ${request.stream}`,
        detail: { stream: request.stream, candidates: resolution.candidates ?? [] }
      })
    }
    const candidates = normalizeCandidates(resolution, this.fallbackPeerIds)
    const streamRequest: MeshStreamRpcRequest = {
      ...request,
      peerId: resolution.peerId,
      candidates
    }
    if (resolution.selector) streamRequest.selector = resolution.selector
    const source = this.bridge.subscribe<TEventPayload>(streamRequest)
    return createEventSubscription(normalizeMeshEvents<TEventPayload>(source, request, resolution.peerId))
  }

  private async resolveRoute(request: AuroraTransportRequest): Promise<MeshRouteResolution> {
    const resolved = this.routeResolver ? await this.routeResolver.resolve(request) : {}
    const selector = resolved.selector ?? selectorFromPayload(request.payload)
    const peerId = resolved.peerId ?? selectorPeerId(selector) ?? this.defaultPeerId ?? null
    const candidates = resolved.candidates ?? []
    return {
      ...resolved,
      peerId,
      selector,
      candidates
    }
  }
}

async function* normalizeMeshEvents<TPayload>(
  source: AsyncIterable<AuroraEvent<TPayload> | Record<string, unknown>> | Iterable<AuroraEvent<TPayload> | Record<string, unknown>>,
  request: AuroraStreamRequest,
  targetPeerId: string
): AsyncIterable<AuroraEvent<TPayload>> {
  for await (const raw of source) {
    yield eventFromUnknown<TPayload>(raw, {
      kind: request.stream,
      transport: 'mesh',
      audit: {
        ...request.audit,
        targetPeerId
      }
    })
  }
}

interface MeshEnvelope<TData> extends AuroraTransportEnvelope<TData> {
  error?: unknown
  fallbackUsed?: boolean
  peerId?: string | null
  targetPeerId?: string | null
}

function toMeshEnvelope<TData>(
  value: MeshRpcResponse<unknown> | AuroraTransportEnvelope<unknown> | unknown,
  request: AuroraTransportRequest,
  targetPeerId: string,
  candidates: MeshRouteCandidate[]
): MeshEnvelope<TData> {
  if (isObject(value) && ('data' in value || 'error' in value || 'audit' in value || 'status' in value)) {
    const response = value as unknown as MeshRpcResponse<TData> & AuroraTransportEnvelope<TData>
    const audit: Partial<AuditReceipt> = {
      ...response.audit,
      correlationId: response.audit?.correlationId ?? response.correlationId ?? null,
      method: response.audit?.method ?? request.method,
      busTopic: response.audit?.busTopic ?? request.busTopic ?? request.method,
      targetPeerId: response.audit?.targetPeerId ?? response.targetPeerId ?? targetPeerId,
      peerId: response.audit?.peerId ?? response.peerId ?? null,
      status: response.audit?.status ?? readStatus(response.status),
      redaction: {
        secretsRedacted: response.secretsRedacted ?? response.audit?.redaction?.secretsRedacted ?? true,
        redactedFields: response.redactedFields ?? response.audit?.redaction?.redactedFields ?? [],
        source: response.secretsRedacted === undefined ? response.audit?.redaction?.source ?? 'sdk' : 'backend',
        warnings: response.audit?.redaction?.warnings ?? []
      }
    }
    return {
      data: response.data as TData,
      error: response.error,
      status: typeof response.status === 'number' ? response.status : undefined,
      headers: response.headers,
      audit,
      fallbackUsed: response.fallbackUsed ?? candidates.some((candidate) => candidate.fallback),
      peerId: response.peerId ?? null,
      targetPeerId: response.targetPeerId ?? targetPeerId
    }
  }
  return {
    data: value as TData,
    audit: {
      method: request.method,
      busTopic: request.busTopic ?? request.method,
      targetPeerId,
      transport: 'mesh'
    }
  }
}

function normalizeCandidates(resolution: MeshRouteResolution, fallbackPeerIds: string[]): MeshRouteCandidate[] {
  const candidates = [...(resolution.candidates ?? [])]
  const seen = new Set(candidates.map((candidate) => candidate.peerId))
  if (resolution.peerId && !seen.has(resolution.peerId)) {
    candidates.unshift({ peerId: resolution.peerId, eligible: true })
    seen.add(resolution.peerId)
  }
  if (resolution.fallbackAllowed) {
    for (const peerId of fallbackPeerIds) {
      if (!seen.has(peerId)) candidates.push({ peerId, eligible: true, fallback: true })
    }
  }
  return candidates
}

function selectorFromPayload(payload: unknown): MeshAddressSelector | null {
  if (!isObject(payload)) return null
  const direct = payload.selector ?? payload.mesh_selector ?? payload.meshSelector ?? payload.target_selector ?? payload.targetSelector
  return isObject(direct) ? (direct as MeshAddressSelector) : null
}

function selectorPeerId(selector: MeshAddressSelector | null): string | null {
  if (!selector) return null
  const value = selector.peer_id ?? selector.peerId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeMeshTransportError(error: unknown, request: AuroraTransportRequest): AuroraError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return meshError('timeout', 'Mesh RPC request timed out', request, error)
  }
  if (error instanceof TypeError) {
    return meshError('transport_loss', error.message, request, error)
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return meshError('timeout', error.message, request, error)
  }
  if (error instanceof Error) {
    return meshError('transport_loss', error.message, request, error)
  }
  return meshError(classifyMeshError(error), readMeshErrorMessage(error), request, error)
}

function meshError(
  code: AuroraErrorCode,
  message: string,
  request: AuroraTransportRequest,
  detail?: unknown
): AuroraError {
  return new AuroraError({
    code,
    message,
    method: request.method,
    busTopic: request.busTopic ?? request.method,
    correlationId: readString(detail, 'correlation_id', 'correlationId') ?? undefined,
    detail
  })
}

function classifyMeshError(error: unknown): AuroraErrorCode {
  const code = readDetailCode(error)?.toLowerCase()
  const text = readMeshErrorMessage(error).toLowerCase()
  if (code?.includes('native_permission') || text.includes('native permission')) return 'native_permission_missing'
  if (code?.includes('privacy') || text.includes('privacy')) return 'privacy_blocked'
  if (code?.includes('permission') || text.includes('permission') || text.includes('forbidden')) return 'permission'
  if (code?.includes('auth') || text.includes('auth')) return 'auth'
  if (code?.includes('validation') || text.includes('validation')) return 'validation'
  if (code?.includes('timeout') || text.includes('timed out') || text.includes('timeout')) return 'timeout'
  if (code?.includes('unsupported') || text.includes('unsupported')) return 'unsupported_feature'
  if (code?.includes('unavailable') || code?.includes('no_route') || text.includes('unavailable') || text.includes('no route')) {
    return 'unavailable_service'
  }
  if (code?.includes('transport') || text.includes('datachannel') || text.includes('not connected')) return 'transport_loss'
  return 'unknown'
}

function readMeshErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (isObject(error)) {
    const value = error.message ?? error.error ?? error.detail ?? error.reason ?? error.reason_code ?? error.code
    if (typeof value === 'string') return value
  }
  if (error instanceof Error) return error.message
  return 'Mesh RPC request failed'
}

function readStatus(status: unknown): string | null {
  if (typeof status === 'string') return status
  if (typeof status === 'number') return String(status)
  return null
}

function readString(data: unknown, ...keys: string[]): string | null {
  if (!isObject(data)) return null
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string') return value
  }
  return null
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
