import { AuroraError, type AuroraErrorCode } from './errors.js'
import type { JsonObject } from './types.js'

export interface AuroraTransportRequest<TPayload = unknown> {
  method: string
  busTopic?: string | undefined
  path?: string | undefined
  payload?: TPayload | undefined
  timeoutMs?: number | undefined
  headers?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
}

export interface AuroraTransportResponse<TData = unknown> {
  data: TData
  status?: number
  headers?: Headers | Record<string, string>
}

export interface AuroraTransport {
  readonly kind: 'http' | 'tauri-local' | 'mesh' | 'native-mobile' | 'mock' | string
  request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>>
}

export interface AuroraResult<TData> {
  ok: true
  data: TData
  audit: {
    correlationId: string | null
    redacted: boolean
  }
}

export interface AuroraFailure {
  ok: false
  error: AuroraError
}

export type AuroraResponse<TData> = AuroraResult<TData> | AuroraFailure

export async function captureResult<TData>(
  operation: () => Promise<TData>
): Promise<AuroraResponse<TData>> {
  try {
    const data = await operation()
    return {
      ok: true,
      data,
      audit: {
        correlationId: readCorrelationId(data),
        redacted: readRedactionFlag(data)
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error)
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

function readCorrelationId(data: unknown): string | null {
  if (!isObject(data)) return null
  const value = data.correlation_id ?? data.correlationId
  return typeof value === 'string' ? value : null
}

function readRedactionFlag(data: unknown): boolean {
  if (!isObject(data)) return true
  const value = data.secrets_redacted ?? data.secretsRedacted
  return typeof value === 'boolean' ? value : true
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
