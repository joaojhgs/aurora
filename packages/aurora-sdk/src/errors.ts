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


export type AuroraUiErrorState =
  | 'auth-required'
  | 'permission-required'
  | 'invalid-request'
  | 'timeout'
  | 'offline'
  | 'unavailable'
  | 'unsupported'
  | 'privacy-blocked'
  | 'native-permission-required'
  | 'error'

export interface AuroraUiErrorShape {
  state: AuroraUiErrorState
  code: AuroraErrorCode
  message: string
  status?: number | undefined
  method?: string | undefined
  busTopic?: string | undefined
  correlationId?: string | undefined
  retryable: boolean
  requiresAuth: boolean
  requiresAdminAction: boolean
  repairAction: string
  secretsRedacted: true
}

export function normalizeAuroraErrorForUi(error: unknown): AuroraUiErrorShape {
  const normalized = error instanceof AuroraError
    ? error
    : error instanceof DOMException && error.name === 'AbortError'
      ? new AuroraError({ code: 'timeout', message: 'Aurora request timed out', cause: error })
      : error instanceof TypeError
        ? new AuroraError({ code: 'transport_loss', message: error.message, cause: error })
        : error instanceof Error
          ? new AuroraError({ code: 'unknown', message: error.message, cause: error })
          : new AuroraError({ code: 'unknown', message: 'Aurora request failed', detail: error })
  return {
    state: uiStateForErrorCode(normalized.code),
    code: normalized.code,
    message: normalized.message,
    status: normalized.status,
    method: normalized.method,
    busTopic: normalized.busTopic,
    correlationId: normalized.correlationId,
    retryable: retryableForErrorCode(normalized.code),
    requiresAuth: normalized.code === 'auth',
    requiresAdminAction: requiresAdminActionForError(normalized),
    repairAction: repairActionForErrorCode(normalized.code),
    secretsRedacted: true
  }
}

function uiStateForErrorCode(code: AuroraErrorCode): AuroraUiErrorState {
  switch (code) {
    case 'auth':
      return 'auth-required'
    case 'permission':
      return 'permission-required'
    case 'validation':
      return 'invalid-request'
    case 'timeout':
      return 'timeout'
    case 'transport_loss':
      return 'offline'
    case 'unavailable_service':
      return 'unavailable'
    case 'unsupported_feature':
      return 'unsupported'
    case 'privacy_blocked':
      return 'privacy-blocked'
    case 'native_permission_missing':
      return 'native-permission-required'
    case 'unknown':
      return 'error'
  }
}

function retryableForErrorCode(code: AuroraErrorCode): boolean {
  return code === 'timeout' || code === 'transport_loss' || code === 'unavailable_service' || code === 'unknown'
}

function repairActionForErrorCode(code: AuroraErrorCode): string {
  switch (code) {
    case 'auth':
      return 'Sign in or pair this device before retrying.'
    case 'permission':
      return 'Request the required permission or complete an AdminAction flow if the route is a mutation.'
    case 'validation':
      return 'Fix the highlighted request fields and retry.'
    case 'timeout':
      return 'Retry after checking Gateway readiness and local service health.'
    case 'transport_loss':
      return 'Reconnect to Gateway or switch to clearly labeled offline demo mode.'
    case 'unavailable_service':
      return 'Start or repair the required Aurora service, then refresh.'
    case 'unsupported_feature':
      return 'Use a supported platform or hide this unsupported capability.'
    case 'privacy_blocked':
      return 'Collect explicit consent and show the required privacy indicator before retrying.'
    case 'native_permission_missing':
      return 'Grant the native platform permission, then retry.'
    case 'unknown':
      return 'Check logs with secrets redacted and retry.'
  }
}

function requiresAdminActionForError(error: AuroraError): boolean {
  const text = [error.message, readDetailText(error.detail), readDetailCode(error.detail) ?? ''].join(' ').toLowerCase()
  return text.includes('adminaction') || text.includes('admin action')
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
