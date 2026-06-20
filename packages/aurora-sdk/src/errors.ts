export type AuroraErrorCode =
  | 'auth'
  | 'permission'
  | 'validation'
  | 'timeout'
  | 'unavailable_service'
  | 'unsupported_feature'
  | 'privacy_blocked'
  | 'native_permission_missing'
  | 'transport_loss'
  | 'unknown'

export interface AuroraErrorOptions {
  code: AuroraErrorCode
  message: string
  status?: number | undefined
  method?: string | undefined
  busTopic?: string | undefined
  correlationId?: string | undefined
  cause?: unknown
  detail?: unknown
}

export class AuroraError extends Error {
  readonly code: AuroraErrorCode
  readonly status: number | undefined
  readonly method: string | undefined
  readonly busTopic: string | undefined
  readonly correlationId: string | undefined
  readonly detail: unknown

  constructor(options: AuroraErrorOptions) {
    super(options.message)
    this.name = 'AuroraError'
    this.code = options.code
    this.status = options.status
    this.method = options.method
    this.busTopic = options.busTopic
    this.correlationId = options.correlationId
    this.detail = options.detail
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

export function classifyHttpError(status: number, detail: unknown): AuroraErrorCode {
  const detailCode = readDetailCode(detail)
  const normalizedCode = detailCode?.toLowerCase()
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 400 || status === 422) return 'validation'
  if (status === 503) return 'unavailable_service'
  if (status === 428 && normalizedCode?.includes('privacy')) return 'privacy_blocked'
  if (status === 428 || normalizedCode?.includes('permission')) return 'permission'
  if (normalizedCode?.includes('unsupported')) return 'unsupported_feature'
  if (normalizedCode?.includes('unavailable')) return 'unavailable_service'
  if (normalizedCode?.includes('native_permission')) return 'native_permission_missing'
  if (normalizedCode?.includes('privacy')) return 'privacy_blocked'
  if (normalizedCode?.includes('validation')) return 'validation'
  if (normalizedCode?.includes('auth')) return 'auth'
  return 'unknown'
}

export function readDetailCode(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const maybeCode = (detail as { code?: unknown }).code
  return typeof maybeCode === 'string' ? maybeCode : null
}
