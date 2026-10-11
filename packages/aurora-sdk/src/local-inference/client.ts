import {
  assertSerializedBound,
  LightweightOrchestratorError
} from '../lightweight-orchestrator/limits.js'
import type { JsonObject, JsonValue } from '../types.js'
import type {
  LocalInferenceCompletionRequest,
  LocalInferenceCompletionResponse,
  LocalInferenceCatalogEntry,
  LocalInferenceEngineDescriptor,
  LocalInferenceModelStatus,
  LocalInferenceSessionDescriptor,
  LocalInferenceSessionPort,
} from './types.js'

const MAX_NATIVE_RESPONSE_BYTES = 256 * 1024
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000

export type LocalInferenceInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export interface LocalInferenceClientOptions {
  readonly cancelTimeoutMs?: number
  readonly createRequestId?: () => string
}

type ManagedSession = LocalInferenceSessionDescriptor

interface ActiveCompletion {
  readonly sessionId: string
  readonly requestId: string
  cancelPromise: Promise<void> | null
  done: Promise<void>
  resolveDone: () => void
}

/** Runtime-independent adapter for the bounded native local-inference command surface. */
export class LocalInferenceClient implements LocalInferenceSessionPort {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly cancelTimeoutMs: number
  private readonly createRequestId: () => string
  private activeCompletion: ActiveCompletion | null = null
  private lifecycleOperation = false
  private unavailableAfterCancellationFailure = false
  private closing = false
  private closed = false

  constructor(private readonly invoke: LocalInferenceInvoke, options: LocalInferenceClientOptions = {}) {
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
    this.createRequestId = options.createRequestId ?? defaultRequestId
    if (!Number.isSafeInteger(this.cancelTimeoutMs) || this.cancelTimeoutMs <= 0) {
      throw new LightweightOrchestratorError('validation', 'Cancellation timeout must be a positive safe integer')
    }
  }

  async engines(): Promise<LocalInferenceEngineDescriptor[]> {
    this.assertUsable()
    const data = await this.invokeData('aurora_local_inference_engines', undefined)
    if (!Array.isArray(data)) throw malformed()
    return data.map(parseEngineDescriptor)
  }

  async catalog(): Promise<readonly LocalInferenceCatalogEntry[]> {
    this.assertUsable()
    const data = await this.invokeData('aurora_local_inference_catalog', undefined)
    if (!Array.isArray(data)) throw malformed()
    return data.map(parseCatalogEntry)
  }

  async modelStatus(modelId: string): Promise<LocalInferenceModelStatus> {
    this.assertUsable()
    assertIdentifier(modelId, 'model')
    return parseModelStatus(await this.invokeData('aurora_local_inference_model_status', { modelId }), modelId)
  }

  async downloadModel(modelId: string): Promise<LocalInferenceModelStatus> {
    this.assertUsable()
    assertIdentifier(modelId, 'model')
    this.assertIdle()
    this.lifecycleOperation = true
    try {
      return parseModelStatus(await this.invokeData('aurora_local_inference_download_model', { modelId }), modelId)
    } finally {
      this.lifecycleOperation = false
    }
  }

  async deleteModel(modelId: string): Promise<LocalInferenceModelStatus> {
    this.assertUsable()
    assertIdentifier(modelId, 'model')
    this.assertIdle()
    if ([...this.sessions.values()].some((session) => session.modelId === modelId)) {
      throw new LightweightOrchestratorError('inference_busy', 'Destroy the selected session before removing its model')
    }
    this.lifecycleOperation = true
    try {
      return parseModelStatus(await this.invokeData('aurora_local_inference_delete_model', { modelId }), modelId)
    } finally {
      this.lifecycleOperation = false
    }
  }

  async sessionCreate(
    modelId: string,
    sessionId: string
  ): Promise<LocalInferenceSessionDescriptor> {
    this.assertUsable()
    assertIdentifier(modelId, 'model')
    assertIdentifier(sessionId, 'session')
    this.assertIdle()
    this.lifecycleOperation = true
    try {
      const existing = this.sessions.get(sessionId)
      if (existing) {
        if (existing.modelId === modelId) return existing
        throw new LightweightOrchestratorError('validation', 'Session is already bound to a different model')
      }
      const status = await this.modelStatus(modelId)
      if (status.state !== 'ready') throw new LightweightOrchestratorError('unavailable_service', 'Selected on-device model is not ready')
      const args = {
        modelId,
        sessionId
      }
      assertSerializedBound(args, MAX_NATIVE_RESPONSE_BYTES, 'provider_request_too_large')
      const descriptor = parseSessionDescriptor(
        await this.invokeData('aurora_local_inference_session_create', args),
        modelId,
        sessionId
      )
      this.sessions.set(sessionId, descriptor)
      return descriptor
    } finally {
      this.lifecycleOperation = false
    }
  }

  async sessionReset(sessionId: string): Promise<void> {
    this.assertUsable()
    this.requireSession(sessionId)
    this.assertIdle()
    this.lifecycleOperation = true
    try {
      await this.invokeVoid('aurora_local_inference_session_reset', { sessionId })
    } finally {
      this.lifecycleOperation = false
    }
  }

  async sessionDestroy(sessionId: string): Promise<void> {
    this.assertUsable()
    this.requireSession(sessionId)
    const active = this.activeCompletion
    if (active) {
      if (active.sessionId !== sessionId) throw busy()
      await this.requestCancel(active)
      await this.waitForCompletion(active)
    }
    this.lifecycleOperation = true
    try {
      await this.invokeVoid('aurora_local_inference_session_destroy', { sessionId })
      this.sessions.delete(sessionId)
    } finally {
      this.lifecycleOperation = false
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    const active = this.activeCompletion
    if (active) {
      if (active.sessionId !== sessionId) throw busy()
      await this.requestCancel(active)
      return
    }
    // Native cancellation is request-scoped. There is no safe command to cancel
    // a session when this client does not own an active completion request.
  }

  async isReady(modelId: string, sessionId: string): Promise<boolean> {
    if (this.closed || this.closing || this.unavailableAfterCancellationFailure) return false
    const session = this.sessions.get(sessionId)
    if (!session || session.modelId !== modelId) return false
    try {
      return (await this.modelStatus(modelId)).state === 'ready'
    } catch {
      return false
    }
  }

  async complete(
    request: LocalInferenceCompletionRequest,
    signal: AbortSignal
  ): Promise<LocalInferenceCompletionResponse> {
    this.assertUsable()
    if (signal.aborted) throw cancelled()
    const session = this.requireSession(request.sessionId)
    if (session.modelId !== request.modelId) {
      throw new LightweightOrchestratorError('validation', 'Completion does not match its selected model')
    }
    if (!await this.isReady(request.modelId, request.sessionId)) {
      throw new LightweightOrchestratorError('unavailable_service', 'Selected on-device session is not ready')
    }
    if (signal.aborted) throw cancelled()
    this.assertIdle()
    const requestId = this.createRequestId()
    assertIdentifier(requestId, 'request')
    const operation = newActiveCompletion(request.sessionId, requestId)
    this.activeCompletion = operation
    const onAbort = () => {
      if (this.activeCompletion === operation) void this.requestCancel(operation).catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      const args = { sessionId: request.sessionId, requestId, request }
      assertSerializedBound(args, 128 * 1024, 'provider_request_too_large')
      const response = parseCompletionResponse(await this.invokeData('aurora_local_inference_complete', args))
      if (signal.aborted || this.closing || this.closed) throw cancelled()
      return response
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (operation.cancelPromise) await operation.cancelPromise
      if (this.activeCompletion === operation) this.activeCompletion = null
      operation.resolveDone()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    let failure: unknown
    const active = this.activeCompletion
    try {
      if (active) {
        await this.requestCancel(active)
        await this.waitForCompletion(active)
      }
      if (!this.unavailableAfterCancellationFailure) {
        for (const sessionId of this.sessions.keys()) {
          await this.invokeVoid('aurora_local_inference_session_destroy', { sessionId })
        }
      }
    } catch (error) {
      failure = error
    } finally {
      this.closed = true
      this.sessions.clear()
    }
    if (failure !== undefined) throw failure
  }

  private async invokeData(command: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    let raw: unknown
    try {
      raw = await this.invoke(command, args)
    } catch {
      throw new LightweightOrchestratorError('unavailable_service', 'On-device assistant command is unavailable')
    }
    assertSerializedBound(raw, MAX_NATIVE_RESPONSE_BYTES, 'provider_response_too_large')
    if (!isRecord(raw) || typeof raw.ok !== 'boolean') throw malformed()
    if (!raw.ok) throw nativeFailure(raw.error)
    if (!Object.hasOwn(raw, 'data')) throw malformed()
    return raw.data
  }

  private async invokeVoid(command: string, args: Record<string, unknown>): Promise<void> {
    const data = await this.invokeData(command, args)
    if (data !== null && data !== undefined) throw malformed()
  }

  private async requestCancel(operation: ActiveCompletion): Promise<void> {
    if (this.activeCompletion !== operation) return
    if (!operation.cancelPromise) operation.cancelPromise = this.invokeCancelBounded(operation)
    await operation.cancelPromise
  }

  private async invokeCancelBounded(operation: ActiveCompletion): Promise<void> {
    try {
      await withTimeout(
        this.invokeVoid('aurora_local_inference_cancel', {
          sessionId: operation.sessionId,
          requestId: operation.requestId
        }),
        this.cancelTimeoutMs
      )
    } catch (error) {
      this.unavailableAfterCancellationFailure = true
      if (error instanceof LightweightOrchestratorError) throw error
      throw new LightweightOrchestratorError('unknown', 'On-device completion could not be safely cancelled')
    }
  }

  private async waitForCompletion(operation: ActiveCompletion): Promise<void> {
    try {
      await withTimeout(operation.done, this.cancelTimeoutMs)
    } catch {
      this.unavailableAfterCancellationFailure = true
      throw new LightweightOrchestratorError('timeout', 'On-device completion did not stop in time')
    }
  }

  private requireSession(sessionId: string): ManagedSession {
    assertIdentifier(sessionId, 'session')
    const session = this.sessions.get(sessionId)
    if (!session) throw new LightweightOrchestratorError('validation', 'On-device session is not managed by this client')
    return session
  }

  private assertUsable(): void {
    if (this.closed || this.closing || this.unavailableAfterCancellationFailure) {
      throw new LightweightOrchestratorError('unavailable_service', 'On-device assistant is unavailable')
    }
  }

  private assertIdle(): void {
    this.assertUsable()
    if (this.activeCompletion || this.lifecycleOperation) throw busy()
  }
}

function parseEngineDescriptor(value: unknown): LocalInferenceEngineDescriptor {
  if (!isRecord(value) || !isOneOf(value.engine, ['cactus', 'llamacpp', 'litert', 'needle2']) ||
    !isOneOf(value.surface, ['android', 'ios', 'desktop']) || typeof value.version !== 'string' ||
    !Array.isArray(value.accelerators) ||
    !isPositiveInteger(value.maxConcurrentModels)) throw malformed()
  const accelerators = value.accelerators.map((accelerator) => {
    if (!isOneOf(accelerator, ['cpu', 'gpu', 'npu'])) throw malformed()
    return accelerator
  })
  return {
    engine: value.engine,
    surface: value.surface,
    version: boundedString(value.version, 'native engine version'),
    accelerators,
    maxConcurrentModels: value.maxConcurrentModels
  }
}

function parseModelStatus(value: unknown, expectedModelId: string): LocalInferenceModelStatus {
  if (!isRecord(value) || value.modelId !== expectedModelId ||
    !isOneOf(value.state, ['absent', 'downloading', 'verifying', 'ready', 'corrupt', 'incompatible'])) throw malformed()
  const status: LocalInferenceModelStatus = { modelId: expectedModelId, state: value.state }
  if (value.bytesOnDisk !== undefined) {
    if (!isNonNegativeInteger(value.bytesOnDisk)) throw malformed()
    Object.assign(status, { bytesOnDisk: value.bytesOnDisk })
  }
  if (value.downloadProgress01 !== undefined) {
    if (typeof value.downloadProgress01 !== 'number' || !Number.isFinite(value.downloadProgress01) || value.downloadProgress01 < 0 || value.downloadProgress01 > 1) throw malformed()
    Object.assign(status, { downloadProgress01: value.downloadProgress01 })
  }
  if (value.lastError !== undefined) {
    if (value.lastError !== null && typeof value.lastError !== 'string') throw malformed()
    Object.assign(status, { lastError: value.lastError === null ? null : 'Engine reported an error' })
  }
  return status
}

function parseCatalogEntry(value: unknown): LocalInferenceCatalogEntry {
  if (!isRecord(value) || typeof value.modelId !== 'string' || value.modelId.length === 0 ||
    typeof value.displayLabel !== 'string' || typeof value.bytes !== 'number' || !isNonNegativeInteger(value.bytes) ||
    !isRecord(value.capabilities) || typeof value.capabilities.chat !== 'boolean' ||
    typeof value.capabilities.tools !== 'boolean') throw malformed()
  return {
    modelId: boundedString(value.modelId, 'model identifier'),
    displayLabel: boundedString(value.displayLabel, 'model label'),
    bytes: value.bytes,
    capabilities: { chat: value.capabilities.chat, tools: value.capabilities.tools }
  }
}

function parseSessionDescriptor(value: unknown, modelId: string, sessionId: string): LocalInferenceSessionDescriptor {
  if (!isRecord(value) || value.modelId !== modelId || value.sessionId !== sessionId) {
    throw malformed()
  }
  const contextBytes = value.contextBytes
  const contextTokens = value.contextTokens
  if ((contextBytes !== null && !isNonNegativeInteger(contextBytes)) ||
    (contextTokens !== undefined && !isNonNegativeInteger(contextTokens))) throw malformed()
  return {
    modelId,
    sessionId,
    contextBytes,
    ...(contextTokens === undefined ? {} : { contextTokens })
  }
}

function parseCompletionResponse(value: unknown): LocalInferenceCompletionResponse {
  if (!isRecord(value) || typeof value.content !== 'string') throw malformed()
  const confidence = value.confidence
  if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw malformed()
  const usage = parseUsage(value.usage)
  if (value.type === 'message') {
    return {
      type: 'message',
      content: boundedString(value.content, 'assistant response'),
      ...(confidence === undefined ? {} : { confidence }),
      ...(usage === undefined ? {} : { usage })
    }
  }
  if (value.type !== 'tool_calls' || !Array.isArray(value.toolCalls) || value.toolCalls.length === 0) throw malformed()
  const toolCalls = value.toolCalls.map((call): { name: string; arguments: JsonObject } => {
    if (!isRecord(call) || typeof call.name !== 'string' || !isJsonObject(call.arguments)) throw malformed()
    return { name: boundedString(call.name, 'tool name'), arguments: call.arguments }
  })
  return {
    type: 'tool_calls',
    content: boundedString(value.content, 'assistant response'),
    toolCalls,
    ...(confidence === undefined ? {} : { confidence }),
    ...(usage === undefined ? {} : { usage })
  }
}

function parseUsage(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw malformed()
  const fields = ['prefillTokens', 'decodeTokens', 'ramUsageMb', 'timeToFirstTokenMs', 'decodeTokensPerSecond'] as const
  const result: Record<string, number> = {}
  for (const field of fields) {
    const metric = value[field]
    if (metric === undefined) continue
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) throw malformed()
    result[field] = metric
  }
  return result
}

function nativeFailure(value: unknown): LightweightOrchestratorError {
  const code = isRecord(value) && typeof value.code === 'string' ? value.code : 'unknown'
  const reasons = new Set(['unsupported_feature', 'unavailable_service', 'validation', 'timeout', 'native_permission_missing'])
  const reason = reasons.has(code) ? code : 'unknown'
  const messages: Record<string, string> = {
    unsupported_feature: 'This on-device feature is unavailable',
    unavailable_service: 'On-device assistant is unavailable',
    validation: 'On-device assistant request is invalid',
    timeout: 'On-device assistant request timed out',
    native_permission_missing: 'On-device permission is required',
    unknown: 'On-device assistant request failed'
  }
  return new LightweightOrchestratorError(reason, messages[reason]!)
}

function newActiveCompletion(sessionId: string, requestId: string): ActiveCompletion {
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  return { sessionId, requestId, cancelPromise: null, done, resolveDone }
}

let requestSequence = 0

function defaultRequestId(): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER
  return `local-${Date.now().toString(36)}-${requestSequence.toString(36)}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LightweightOrchestratorError('timeout', 'On-device cancellation timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertIdentifier(value: string, label: 'model' | 'session' | 'request'): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new LightweightOrchestratorError('validation', `On-device ${label} identifier is invalid`)
  }
}

function boundedString(value: string, label: string): string {
  if (value.length > 16_384) throw new LightweightOrchestratorError('provider_response_too_large', `Native ${label} exceeded its size limit`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.includes(value as T)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function malformed(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('provider_response_malformed', 'On-device assistant returned an invalid response')
}

function busy(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('inference_busy', 'On-device assistant is already working')
}

function cancelled(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('provider_call_cancelled')
}
