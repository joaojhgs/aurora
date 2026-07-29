const GENERIC_READ_ERROR = 'Aurora could not read this information. Try again.'
const GENERIC_ACTION_ERROR = 'Aurora could not complete that action. Try again.'

export function productErrorText(error: unknown, fallback = GENERIC_READ_ERROR): string {
  const code = errorCode(error)
  if (isDenied(code, error)) return 'Permission is needed to view this information.'
  if (isTimeout(code, error)) return 'Aurora took too long to respond. Try again.'
  if (isUnavailable(code, error)) return 'This information is unavailable right now. Check the affected device, then try again.'
  return fallback
}

export function productActionErrorText(error: unknown): string {
  const code = errorCode(error)
  if (isDenied(code, error)) return 'Permission is needed to complete this action.'
  if (isTimeout(code, error)) return 'Aurora took too long to complete this action. Try again.'
  if (isUnavailable(code, error)) return 'This action is unavailable right now. Check the affected device, then try again.'
  return GENERIC_ACTION_ERROR
}

export function productStatusText(value: unknown, fallback = 'Status unavailable'): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.toLowerCase()
  if (normalized.includes('healthy') || normalized.includes('available') || normalized.includes('connected')) {
    return 'Available'
  }
  if (normalized.includes('denied') || normalized.includes('permission') || normalized.includes('forbidden')) {
    return 'Permission needed'
  }
  if (normalized.includes('degraded') || normalized.includes('timeout') || normalized.includes('lag')) {
    return 'Needs attention'
  }
  if (normalized.includes('unsupported') || normalized.includes('disabled') || normalized.includes('unavailable')) {
    return 'Unavailable'
  }
  if (normalized.includes('pending') || normalized.includes('loading')) return 'Checking'
  return fallback
}

export function yesNo(value: unknown): string {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return 'Unknown'
}

export function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = 'code' in error ? (error as { code?: unknown }).code : null
  return typeof code === 'string' ? code.toLowerCase() : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : typeof error === 'string' ? error.toLowerCase() : ''
}

function isDenied(code: string | null, error: unknown): boolean {
  const text = errorText(error)
  return code === 'permission_denied' || code === 'forbidden' || text.includes('permission') || text.includes('forbidden')
}

function isTimeout(code: string | null, error: unknown): boolean {
  const text = errorText(error)
  return code === 'timeout' || text.includes('timeout')
}

function isUnavailable(code: string | null, error: unknown): boolean {
  const text = errorText(error)
  return code === 'unsupported'
    || code === 'transport_loss'
    || code === 'unavailable_service'
    || text.includes('unavailable')
    || text.includes('unsupported')
}
