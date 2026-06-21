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
  const normalizedText = readDetailText(detail).toLowerCase()
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 408 || status === 504) return 'timeout'
  if (normalizedCode?.includes('native_permission') || normalizedText.includes('native permission')) {
    return 'native_permission_missing'
  }
  if (normalizedCode?.includes('privacy') || normalizedText.includes('privacy')) return 'privacy_blocked'
  if (normalizedCode?.includes('unsupported') || normalizedText.includes('unsupported')) return 'unsupported_feature'
  if (normalizedCode?.includes('unavailable') || normalizedText.includes('unavailable')) return 'unavailable_service'
  if (normalizedCode?.includes('validation') || normalizedText.includes('validation')) return 'validation'
  if (normalizedCode?.includes('auth') || normalizedText.includes('authentication')) return 'auth'
  if (status === 400 || status === 422) return 'validation'
  if (status === 503) return 'unavailable_service'
  if (status === 428 || normalizedCode?.includes('permission')) return 'permission'
  return 'unknown'
}

export function readDetailCode(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const maybeCode =
    (detail as { code?: unknown }).code ??
    (detail as { error_code?: unknown }).error_code ??
    (detail as { reason_code?: unknown }).reason_code ??
    (detail as { reason?: unknown }).reason
  return typeof maybeCode === 'string' ? maybeCode : null
}

function readDetailText(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(readDetailText).join(' ')
  if (typeof detail !== 'object' || detail === null) return ''
  const values = [
    (detail as { message?: unknown }).message,
    (detail as { error?: unknown }).error,
    (detail as { detail?: unknown }).detail,
    (detail as { reason?: unknown }).reason,
    (detail as { reason_code?: unknown }).reason_code,
    (detail as { code?: unknown }).code
  ]
  return values.map(readDetailText).filter(Boolean).join(' ')
}
