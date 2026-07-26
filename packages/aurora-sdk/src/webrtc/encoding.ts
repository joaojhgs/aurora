const BASE64URL_RE = /^[A-Za-z0-9_-]*$/
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function bytesToUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(value: string): Uint8Array {
  if (!HEX_RE.test(value)) {
    throw new Error('Invalid hex string')
  }
  const out = new Uint8Array(value.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  if (typeof btoa !== 'function') {
    throw new Error('base64 encoder is unavailable')
  }
  const encoded = btoa(binary)
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  if (value.includes('=') || !BASE64URL_RE.test(value)) {
    throw new Error('Invalid unpadded base64url string')
  }
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  if (typeof atob !== 'function') {
    throw new Error('base64 decoder is unavailable')
  }
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index)
  }
  return out
}

function escapeAscii(value: string): string {
  return value.replace(/[\u007f-\uffff]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0')
    return `\\u${code}`
  })
}

function canonicalize(value: unknown, sortKeys: boolean): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, sortKeys))
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (sortKeys) {
    keys.sort()
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const item = record[key]
    if (item !== undefined) {
      out[key] = canonicalize(item, sortKeys)
    }
  }
  return out
}

export interface JsonStringifyOptions {
  sortKeys?: boolean
  ensureAscii?: boolean
}

export function compactJson(value: unknown, options: JsonStringifyOptions = {}): string {
  const json = JSON.stringify(canonicalize(value, options.sortKeys === true))
  if (json === undefined) {
    throw new Error('Value is not JSON serializable')
  }
  return options.ensureAscii === true ? escapeAscii(json) : json
}

export function canonicalJson(value: unknown): string {
  return compactJson(value, { sortKeys: true, ensureAscii: true })
}

export function zeroBytes(value: Uint8Array): void {
  value.fill(0)
}
