import { z } from 'zod/v4'

export type EncryptedDataEnvelopeAlgorithm = 'AES-GCM-256'

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u

export const encryptedDataEnvelopeV1Schema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-GCM-256'),
  keyId: z.string().min(1).max(256),
  nonceB64Url: z.string().min(12).max(256).regex(BASE64URL_RE),
  ciphertextAndTagB64Url: z.string().min(22).regex(BASE64URL_RE),
  createdAtMs: z.number().int().safe().nonnegative()
}).strict()

export type EncryptedDataEnvelopeV1 = z.infer<typeof encryptedDataEnvelopeV1Schema>

export function parseEncryptedDataEnvelopeV1(value: unknown): EncryptedDataEnvelopeV1 {
  return encryptedDataEnvelopeV1Schema.parse(value)
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
