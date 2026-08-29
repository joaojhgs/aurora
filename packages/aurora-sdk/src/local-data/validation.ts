import { z, type ZodType } from 'zod/v4'

import { LocalDataError } from './backend.js'

const SAFE_BOUNDARY_ID_RE = /^[a-z0-9_.:-]{1,96}$/u
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

export interface JsonSafetyLimits {
  maxDepth: number
  maxNodes: number
  maxBytes: number
  maxArrayItems: number
  maxObjectKeys: number
  maxStringBytes: number
}

export const localDataJsonSafetyLimits: JsonSafetyLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 200_000,
  maxBytes: 16 * 1024 * 1024,
  maxArrayItems: 100_000,
  maxObjectKeys: 2_048,
  maxStringBytes: 2 * 1024 * 1024
})

export const nonNegativeSafeIntSchema = z.number().int().safe().nonnegative().refine((value) => !Object.is(value, -0), {
  message: 'negative zero is not valid JSON state'
})

export function parseLocalDataBoundary<T>(schema: ZodType<T>, value: unknown, boundaryId: string): T {
  const safeBoundaryId = normalizeBoundaryId(boundaryId)
  assertJsonSafety(value, safeBoundaryId)
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new LocalDataError('invalid_record', `Invalid local data boundary: ${safeBoundaryId}`, {
    boundaryId: safeBoundaryId,
    validation: 'redacted',
    issues: result.error.issues.slice(0, 8).map((issue) => ({
      code: issue.code,
      path: normalizeIssuePath(issue.path)
    }))
  })
}

export function isJsonRoundTripStable(value: unknown): boolean {
  try {
    if (typeof value === 'number' && Object.is(value, -0)) return false
    const encoded = JSON.stringify(value)
    return encoded !== undefined && JSON.stringify(JSON.parse(encoded)) === encoded
  } catch {
    return false
  }
}

export function assertJsonSafety(
  value: unknown,
  boundaryId: string,
  limits: JsonSafetyLimits = localDataJsonSafetyLimits
): void {
  const safeBoundaryId = normalizeBoundaryId(boundaryId)
  let nodes = 0
  let bytes = 0
  const active = new Set<object>()
  const stack: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    const current = item.value
    if (item.leaving) {
      if (current !== null && typeof current === 'object') active.delete(current)
      continue
    }
    nodes += 1
    if (nodes > limits.maxNodes) throwJsonSafetyError(safeBoundaryId, 'max_nodes')
    if (item.depth > limits.maxDepth) throwJsonSafetyError(safeBoundaryId, 'max_depth')
    if (current === null || typeof current === 'boolean') {
      bytes += current === null ? 4 : current ? 4 : 5
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current) || !Number.isSafeInteger(current) || Object.is(current, -0)) {
        throwJsonSafetyError(safeBoundaryId, 'unsafe_number')
      }
      bytes += String(current).length
    } else if (typeof current === 'string') {
      const encoded = new TextEncoder().encode(current).byteLength
      if (encoded > limits.maxStringBytes) throwJsonSafetyError(safeBoundaryId, 'max_string_bytes')
      bytes += encoded + 2
    } else if (Array.isArray(current)) {
      if (active.has(current)) throwJsonSafetyError(safeBoundaryId, 'cycle')
      active.add(current)
      if (current.length > limits.maxArrayItems) throwJsonSafetyError(safeBoundaryId, 'max_array_items')
      bytes += current.length + 2
      stack.push({ value: current, depth: item.depth, leaving: true })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current[index], depth: item.depth + 1 })
      }
    } else if (typeof current === 'object') {
      if (active.has(current)) throwJsonSafetyError(safeBoundaryId, 'cycle')
      if (Object.getPrototypeOf(current) !== Object.prototype) throwJsonSafetyError(safeBoundaryId, 'non_plain_object')
      active.add(current)
      const entries = Object.entries(current as Record<string, unknown>)
      if (entries.length > limits.maxObjectKeys) throwJsonSafetyError(safeBoundaryId, 'max_object_keys')
      bytes += entries.length + 2
      stack.push({ value: current, depth: item.depth, leaving: true })
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index] ?? ['', undefined]
        const keyBytes = new TextEncoder().encode(key).byteLength
        if (key.length < 1 || keyBytes > 256) throwJsonSafetyError(safeBoundaryId, 'unsafe_key')
        bytes += keyBytes + 3
        if (child === undefined) throwJsonSafetyError(safeBoundaryId, 'undefined_value')
        stack.push({ value: child, depth: item.depth + 1 })
      }
    } else {
      throwJsonSafetyError(safeBoundaryId, 'unsupported_type')
    }
    if (bytes > limits.maxBytes) throwJsonSafetyError(safeBoundaryId, 'max_bytes')
  }
}

function normalizeBoundaryId(boundaryId: string): string {
  return SAFE_BOUNDARY_ID_RE.test(boundaryId) ? boundaryId : 'unknown'
}

function normalizeIssuePath(path: z.core.$ZodIssue['path']): string {
  const safeSegments: string[] = []
  for (const segment of path.slice(0, 16)) {
    if (typeof segment === 'number') {
      safeSegments.push('[]')
    } else if (typeof segment === 'string' && SAFE_PATH_SEGMENT_RE.test(segment)) {
      safeSegments.push(segment)
    } else {
      safeSegments.push('*')
    }
  }
  return safeSegments.join('.')
}

function throwJsonSafetyError(boundaryId: string, reason: string): never {
  throw new LocalDataError('invalid_record', `Invalid local data boundary: ${boundaryId}`, {
    boundaryId,
    validation: 'redacted',
    issues: [{ code: reason, path: '' }]
  })
}
