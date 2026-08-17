import { sha256 } from '@noble/hashes/sha2.js'

import type { JsonValue } from '../types.js'

const textEncoder = new TextEncoder()
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface CanonicalJsonSafetyLimits {
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxArrayItems: number
  readonly maxObjectKeys: number
  readonly maxStringBytes: number
}

export const canonicalJsonSafetyLimits: CanonicalJsonSafetyLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 100_000,
  maxArrayItems: 100_000,
  maxObjectKeys: 2_048,
  maxStringBytes: 2 * 1024 * 1024
})

export class CanonicalJsonError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string, message = `Value is not canonical JSON: ${reasonCode}`) {
    super(message)
    this.name = 'CanonicalJsonError'
    this.reasonCode = reasonCode
  }
}

export interface CanonicalJsonOptions {
  readonly ensureAscii?: boolean
}

export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  return renderCanonicalJson(value, 0, { nodes: 0 }, canonicalJsonSafetyLimits, options)
}

export function canonicalJsonBytes(value: unknown, options: CanonicalJsonOptions = {}): Uint8Array {
  return textEncoder.encode(canonicalJson(value, options))
}

export function canonicalJsonSha256Hex(value: unknown, options: CanonicalJsonOptions = {}): string {
  return bytesToHex(sha256(canonicalJsonBytes(value, options)))
}

export function assertCanonicalJsonValue(value: unknown): asserts value is JsonValue {
  void canonicalJson(value)
}

function renderCanonicalJson(
  value: unknown,
  depth: number,
  state: { nodes: number },
  limits: CanonicalJsonSafetyLimits,
  options: CanonicalJsonOptions
): string {
  state.nodes += 1
  if (state.nodes > limits.maxNodes) throw new CanonicalJsonError('max_nodes')
  if (depth > limits.maxDepth) throw new CanonicalJsonError('max_depth')

  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (textEncoder.encode(value).byteLength > limits.maxStringBytes) throw new CanonicalJsonError('max_string_bytes')
    return renderJsonString(value, options)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('non_finite_number')
    if (Object.is(value, -0)) throw new CanonicalJsonError('negative_zero')
    if (!Number.isInteger(value)) throw new CanonicalJsonError('non_integer_number')
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('unsafe_integer')
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new CanonicalJsonError('unsupported_number')
    return encoded
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) throw new CanonicalJsonError('max_array_items')
    const rendered: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new CanonicalJsonError('sparse_array')
      rendered.push(renderCanonicalJson(value[index], depth + 1, state, limits, options))
    }
    return `[${rendered.join(',')}]`
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new CanonicalJsonError('non_plain_object')
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > limits.maxObjectKeys) throw new CanonicalJsonError('max_object_keys')
    const rendered = entries
      .map(([key, item]) => {
        if (UNSAFE_OBJECT_KEYS.has(key)) throw new CanonicalJsonError('unsafe_object_key')
        if (item === undefined) throw new CanonicalJsonError('undefined_value')
        if (textEncoder.encode(key).byteLength > 256) throw new CanonicalJsonError('max_key_bytes')
        return [key, renderCanonicalJson(item, depth + 1, state, limits, options)] as const
      })
      .sort(([left], [right]) => comparePythonStringOrder(left, right))
      .map(([key, item]) => `${renderJsonString(key, options)}:${item}`)
      .join(',')
    return `{${rendered}}`
  }
  throw new CanonicalJsonError('unsupported_type')
}

function renderJsonString(value: string, options: CanonicalJsonOptions): string {
  const encoded = JSON.stringify(value)
  return options.ensureAscii === true ? escapeAscii(encoded) : encoded
}

function escapeAscii(value: string): string {
  // Python's json encoder escapes everything outside ` ` (0x20) to `~` (0x7E),
  // so U+007F is escaped there. Excluding it here left the two languages
  // producing different digests for the same value — the exact class of bug the
  // cross-language vectors exist to prevent. Codepoints below 0x20 are already
  // escaped by JSON.stringify before this runs, identically to Python.
  return value.replace(/[^\x00-\x7E]/gu, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0xFFFF) return `\\u${codePoint.toString(16).padStart(4, '0')}`
    const normalized = codePoint - 0x10000
    const high = 0xD800 + (normalized >> 10)
    const low = 0xDC00 + (normalized & 0x3FF)
    return `\\u${high.toString(16)}\\u${low.toString(16)}`
  })
}

function comparePythonStringOrder(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0)
    if (diff !== 0) return diff
  }
  return leftPoints.length - rightPoints.length
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
