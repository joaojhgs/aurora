import {
  AURORA_VOICE_WORKER_MAX_REQUEST_ID,
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  AuroraVoiceWebRuntimeError,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerHost,
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerRequestOptions,
  type AuroraVoiceWorkerResponse,
  type AuroraVoiceWorkerResponseEnvelope
} from './types.js'

const DEFAULT_MAX_IN_FLIGHT = 16
const DEFAULT_TIMEOUT_MS = 5_000

export interface AuroraBrowserWorkerPort {
  postMessage(message: AuroraVoiceWorkerRequestEnvelope, transfer?: readonly Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'messageerror' | 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'messageerror' | 'error', listener: (event: Event) => void): void
  terminate?(): void
}

interface PendingRequest {
  readonly resolve: (response: AuroraVoiceWorkerResponse) => void
  readonly reject: (error: AuroraVoiceWebRuntimeError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class AuroraAcknowledgedWorkerHost implements AuroraVoiceWorkerHost {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly maxInFlight: number
  private readonly defaultTimeoutMs: number
  private nextRequestId = 1
  private closed = false

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    this.handleMessage(event.data)
  }

  private readonly onFatal = (): void => {
    this.rejectAll('worker_failed')
  }

  constructor(private readonly worker: AuroraBrowserWorkerPort, options: { readonly maxInFlight?: number; readonly timeoutMs?: number } = {}) {
    this.maxInFlight = boundedInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, 'maxInFlight', 1, 256)
    this.defaultTimeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 1, 60_000)
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('messageerror', this.onFatal)
    worker.addEventListener('error', this.onFatal)
  }

  request(command: AuroraVoiceWorkerCommand, options: AuroraVoiceWorkerRequestOptions = {}): Promise<AuroraVoiceWorkerResponse> {
    if (this.closed) return Promise.reject(new AuroraVoiceWebRuntimeError('worker_closed', 'Voice worker is not available'))
    if (this.pending.size >= this.maxInFlight) {
      return Promise.reject(new AuroraVoiceWebRuntimeError('worker_backpressure', 'Voice worker is busy'))
    }
    const requestId = this.allocateRequestId()
    const envelope: AuroraVoiceWorkerRequestEnvelope = Object.freeze({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId,
      command
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new AuroraVoiceWebRuntimeError('worker_timeout', 'Voice worker did not respond'))
      }, boundedInteger(options.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs', 1, 60_000))
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.worker.postMessage(envelope, options.transfer ?? [])
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new AuroraVoiceWebRuntimeError('worker_post_failed', 'Voice worker is not available'))
      }
    })
  }

  shutdown(): void {
    this.closed = true
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('messageerror', this.onFatal)
    this.worker.removeEventListener('error', this.onFatal)
    this.rejectAll('worker_closed')
    this.worker.terminate?.()
  }

  private handleMessage(data: unknown): void {
    const envelope = validateResponseEnvelope(data)
    if (envelope === null) {
      this.rejectAll('worker_protocol')
      return
    }
    const pending = this.pending.get(envelope.requestId)
    if (pending === undefined) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(envelope.requestId)
    if (envelope.response.type === 'reject') {
      pending.reject(new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker rejected the request'))
      return
    }
    pending.resolve(envelope.response)
  }

  private rejectAll(code: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AuroraVoiceWebRuntimeError(code, 'Voice worker is not available'))
      this.pending.delete(requestId)
    }
  }

  private allocateRequestId(): number {
    const requestId = this.nextRequestId
    this.nextRequestId += 1
    if (this.nextRequestId > AURORA_VOICE_WORKER_MAX_REQUEST_ID) this.nextRequestId = 1
    return requestId
  }
}

function validateResponseEnvelope(data: unknown): AuroraVoiceWorkerResponseEnvelope | null {
  if (typeof data !== 'object' || data === null) return null
  const envelope = data as Partial<AuroraVoiceWorkerResponseEnvelope>
  const requestId = envelope.requestId
  if (
    envelope.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION ||
    !Number.isSafeInteger(requestId) ||
    requestId === undefined ||
    requestId < 1 ||
    requestId > AURORA_VOICE_WORKER_MAX_REQUEST_ID ||
    typeof envelope.response !== 'object' ||
    envelope.response === null
  ) {
    return null
  }
  return envelope as AuroraVoiceWorkerResponseEnvelope
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${label} is out of range`)
  }
  return value
}
