import { z } from 'zod/v4'

import { nonNegativeSafeIntSchema, parseLocalDataBoundary } from './validation.js'

export type EncryptedDataEnvelopeAlgorithm = 'AES-GCM-256'

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u
const MAX_ENVELOPE_TEXT_BYTES = 2 * 1024 * 1024

export const encryptedDataEnvelopeV1Schema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-GCM-256'),
  keyId: z.string().min(1).max(256),
  nonceB64Url: z.string().max(256).regex(BASE64URL_RE).refine((value) => isCanonicalBase64Url(value) && base64UrlDecode(value).byteLength === 12, {
    message: 'nonceB64Url must be canonical unpadded base64url for exactly 12 bytes'
  }),
  ciphertextAndTagB64Url: z.string().max(MAX_ENVELOPE_TEXT_BYTES).regex(BASE64URL_RE).refine((value) => {
    if (!isCanonicalBase64Url(value)) return false
    return base64UrlDecode(value).byteLength >= 16
  }, {
    message: 'ciphertextAndTagB64Url must be canonical unpadded base64url with a 16-byte tag'
  }),
  createdAtMs: nonNegativeSafeIntSchema
}).strict()

export type EncryptedDataEnvelopeV1 = z.infer<typeof encryptedDataEnvelopeV1Schema>

export function parseEncryptedDataEnvelopeV1(value: unknown): EncryptedDataEnvelopeV1 {
  return parseLocalDataBoundary(encryptedDataEnvelopeV1Schema, value, 'envelope.v1')
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

export const encryptedDataEnvelopeV1JsonSchema = z.toJSONSchema(encryptedDataEnvelopeV1Schema)

function isCanonicalBase64Url(value: string): boolean {
  if (value.includes('=')) return false
  try {
    return base64UrlEncode(base64UrlDecode(value)) === value
  } catch {
    return false
  }
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}
