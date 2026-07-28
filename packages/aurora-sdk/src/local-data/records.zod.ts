import { z } from 'zod/v4'

import { encryptedDataEnvelopeV1Schema } from './encrypted-envelope.js'

export const localDataIdSchema = z.string().min(1).max(256)
export const nonNegativeSafeIntSchema = z.number().int().safe().nonnegative()
export const epochMsSchema = nonNegativeSafeIntSchema
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export const jsonObjectSchema = z.record(z.string(), z.unknown())
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
  return conversationRecordSchema.parse(value)
}

export function parseConversationMessageRecord(value: unknown): ConversationMessageRecord {
  return conversationMessageRecordSchema.parse(value)
}

export function parseLightweightMemoryRecord(value: unknown): LightweightMemoryRecord {
  return lightweightMemoryRecordSchema.parse(value)
}

export function parseLocalToolStateRecord(value: unknown): LocalToolStateRecord {
  return localToolStateRecordSchema.parse(value)
}

export function parsePeerGrantMetadataRecord(value: unknown): PeerGrantMetadataRecord {
  return peerGrantMetadataRecordSchema.parse(value)
}

export function parseLocalAuditRecord(value: unknown): LocalAuditRecord {
  return localAuditRecordSchema.parse(value)
}

export function parseLocalDataRecordCollections(value: unknown): LocalDataRecordCollections {
  return localDataRecordCollectionsSchema.parse(value)
}
