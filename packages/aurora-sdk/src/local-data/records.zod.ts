import { z } from 'zod/v4'

import { encryptedDataEnvelopeV1Schema } from './encrypted-envelope.js'
import { isJsonRoundTripStable, parseLocalDataBoundary } from './validation.js'

export const localDataIdSchema = z.string().min(1).max(256)
export const nonNegativeSafeIntSchema = z.number().int().safe().nonnegative()
export const epochMsSchema = nonNegativeSafeIntSchema
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite().safe(),
  z.string().max(64 * 1024),
  z.array(jsonValueSchema).max(1024),
  z.record(z.string().min(1).max(256), jsonValueSchema).refine((value) => Object.keys(value).length <= 256, {
    message: 'JSON object has too many keys'
  })
])).refine(isJsonRoundTripStable, {
  message: 'value must JSON round-trip exactly'
})
export const jsonObjectSchema = z.record(z.string().min(1).max(256), jsonValueSchema).refine((value) => Object.keys(value).length <= 256, {
  message: 'JSON object has too many keys'
}).refine(isJsonRoundTripStable, {
  message: 'object must JSON round-trip exactly'
})
export const conversationMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
export const conversationMessageStatusSchema = z.enum(['pending', 'complete', 'failed', 'cancelled'])

export type ConversationMessageRole = z.infer<typeof conversationMessageRoleSchema>
export type ConversationMessageStatus = z.infer<typeof conversationMessageStatusSchema>

export const conversationRecordSchema = z.object({
  id: localDataIdSchema,
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  titleEnvelope: encryptedDataEnvelopeV1Schema.nullable(),
  createdAtMs: epochMsSchema,
  updatedAtMs: epochMsSchema,
  archivedAtMs: epochMsSchema.nullable()
}).strict().refine((record) => record.updatedAtMs >= record.createdAtMs, {
  message: 'updatedAtMs cannot be before createdAtMs',
  path: ['updatedAtMs']
})

export const conversationMessageRecordSchema = z.object({
  id: localDataIdSchema,
  conversationId: localDataIdSchema,
  sequence: nonNegativeSafeIntSchema,
  role: conversationMessageRoleSchema,
  contentEnvelope: encryptedDataEnvelopeV1Schema.nullable(),
  toolEnvelope: encryptedDataEnvelopeV1Schema.nullable(),
  status: conversationMessageStatusSchema,
  createdAtMs: epochMsSchema
}).strict()

export const lightweightMemoryRecordSchema = z.object({
  id: localDataIdSchema,
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  namespace: localDataIdSchema,
  payloadEnvelope: encryptedDataEnvelopeV1Schema,
  sourceType: z.string().max(256).nullable(),
  sourceId: z.string().max(256).nullable(),
  createdAtMs: epochMsSchema,
  updatedAtMs: epochMsSchema,
  expiresAtMs: epochMsSchema.nullable()
}).strict().refine((record) => record.updatedAtMs >= record.createdAtMs, {
  message: 'updatedAtMs cannot be before createdAtMs',
  path: ['updatedAtMs']
})

export const localToolStateRecordSchema = z.object({
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  toolContractId: localDataIdSchema,
  descriptorJson: jsonObjectSchema,
  descriptorHash: sha256HexSchema,
  enabled: z.boolean(),
  settingsEnvelope: encryptedDataEnvelopeV1Schema.nullable(),
  revision: nonNegativeSafeIntSchema,
  updatedAtMs: epochMsSchema
}).strict()

export const peerGrantMetadataRecordSchema = z.object({
  grantId: localDataIdSchema,
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  claimantPeerId: localDataIdSchema,
  tokenId: localDataIdSchema,
  scopeEnvelope: encryptedDataEnvelopeV1Schema,
  revision: nonNegativeSafeIntSchema,
  createdAtMs: epochMsSchema,
  expiresAtMs: epochMsSchema.nullable(),
  revokedAtMs: epochMsSchema.nullable()
}).strict()

export const localAuditRecordSchema = z.object({
  id: localDataIdSchema,
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  peerId: z.string().max(256).nullable(),
  action: localDataIdSchema,
  decision: localDataIdSchema,
  resultStatus: localDataIdSchema,
  connectionEpoch: z.string().max(256).nullable(),
  methodId: z.string().max(256).nullable(),
  toolContractId: z.string().max(256).nullable(),
  correlationId: z.string().max(256).nullable(),
  redactedDetailJson: jsonObjectSchema,
  createdAtMs: epochMsSchema
}).strict()

export const localDataRecordCollectionsSchema = z.object({
  conversations: z.array(conversationRecordSchema),
  messages: z.array(conversationMessageRecordSchema),
  memoryItems: z.array(lightweightMemoryRecordSchema),
  localToolStates: z.array(localToolStateRecordSchema),
  peerGrantMetadata: z.array(peerGrantMetadataRecordSchema),
  localAudit: z.array(localAuditRecordSchema)
}).strict()

export type ConversationRecord = z.infer<typeof conversationRecordSchema>
export type ConversationMessageRecord = z.infer<typeof conversationMessageRecordSchema>
export type LightweightMemoryRecord = z.infer<typeof lightweightMemoryRecordSchema>
export type LocalToolStateRecord = z.infer<typeof localToolStateRecordSchema>
export type PeerGrantMetadataRecord = z.infer<typeof peerGrantMetadataRecordSchema>
export type LocalAuditRecord = z.infer<typeof localAuditRecordSchema>
export type LocalDataRecordCollections = z.infer<typeof localDataRecordCollectionsSchema>

export function parseConversationRecord(value: unknown): ConversationRecord {
  return parseLocalDataBoundary(conversationRecordSchema, value, 'conversation record')
}

export function parseConversationMessageRecord(value: unknown): ConversationMessageRecord {
  return parseLocalDataBoundary(conversationMessageRecordSchema, value, 'conversation message record')
}

export function parseLightweightMemoryRecord(value: unknown): LightweightMemoryRecord {
  return parseLocalDataBoundary(lightweightMemoryRecordSchema, value, 'lightweight memory record')
}

export function parseLocalToolStateRecord(value: unknown): LocalToolStateRecord {
  return parseLocalDataBoundary(localToolStateRecordSchema, value, 'local tool state record')
}

export function parsePeerGrantMetadataRecord(value: unknown): PeerGrantMetadataRecord {
  return parseLocalDataBoundary(peerGrantMetadataRecordSchema, value, 'peer grant metadata record')
}

export function parseLocalAuditRecord(value: unknown): LocalAuditRecord {
  return parseLocalDataBoundary(localAuditRecordSchema, value, 'local audit record')
}

export function parseLocalDataRecordCollections(value: unknown): LocalDataRecordCollections {
  return parseLocalDataBoundary(localDataRecordCollectionsSchema, value, 'local data record collections')
}
