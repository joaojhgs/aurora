export type EncryptedDataEnvelopeAlgorithm = 'AES-GCM-256'

export interface EncryptedDataEnvelopeV1 {
  version: 1
  algorithm: EncryptedDataEnvelopeAlgorithm
  keyId: string
  nonceB64Url: string
  ciphertextAndTagB64Url: string
  createdAtMs: number
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

export function parseEncryptedDataEnvelopeV1(value: unknown): EncryptedDataEnvelopeV1 {
  const record = requireRecord(value, 'encrypted envelope')
  assertOnlyKeys(record, ['version', 'algorithm', 'keyId', 'nonceB64Url', 'ciphertextAndTagB64Url', 'createdAtMs'], 'encrypted envelope')
  const envelope: EncryptedDataEnvelopeV1 = {
    version: requireLiteral(record.version, 1, 'version'),
    algorithm: requireLiteral(record.algorithm, 'AES-GCM-256', 'algorithm'),
    keyId: requireBoundedString(record.keyId, 'keyId'),
    nonceB64Url: requireBase64Url(record.nonceB64Url, 'nonceB64Url'),
    ciphertextAndTagB64Url: requireBase64Url(record.ciphertextAndTagB64Url, 'ciphertextAndTagB64Url'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs')
  }
  if (envelope.nonceB64Url.length < 12) {
    throw new TypeError('nonceB64Url must encode a 96-bit nonce')
  }
  if (envelope.ciphertextAndTagB64Url.length < 22) {
    throw new TypeError('ciphertextAndTagB64Url must include a 128-bit tag')
  }
  return envelope
}

export function buildEnvelopeAad(input: {
  table: string
  recordId: string
  field: string
  localNodeId: string
  profileId: string
  envelopeVersion?: 1
}): Uint8Array {
  const json = JSON.stringify({
    envelopeVersion: input.envelopeVersion ?? 1,
    field: input.field,
    localNodeId: input.localNodeId,
    profileId: input.profileId,
    recordId: input.recordId,
    table: input.table
  })
  return new TextEncoder().encode(json)
}

export const encryptedDataEnvelopeV1JsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'EncryptedDataEnvelopeV1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'algorithm', 'keyId', 'nonceB64Url', 'ciphertextAndTagB64Url', 'createdAtMs'],
  properties: {
    version: { const: 1 },
    algorithm: { const: 'AES-GCM-256' },
    keyId: { type: 'string', minLength: 1, maxLength: 256 },
    nonceB64Url: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
    ciphertextAndTagB64Url: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
    createdAtMs: { type: 'integer', minimum: 0 }
  }
} as const)

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new TypeError(`${label} must be ${String(expected)}`)
  return expected
}

function requireBoundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new TypeError(`${label} must be a bounded string`)
  }
  return value
}

function requireBase64Url(value: unknown, label: string): string {
  const parsed = requireBoundedString(value, label)
  if (parsed.includes('=') || !BASE64URL_RE.test(parsed)) {
    throw new TypeError(`${label} must be unpadded base64url`)
  }
  return parsed
}

function requireEpochMs(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be epoch milliseconds`)
  }
  return value
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`)
  }
}
