import { z } from 'zod/v4'

import { encryptedDataEnvelopeV1Schema } from './encrypted-envelope.js'
import { assertJsonSafety, isJsonRoundTripStable, nonNegativeSafeIntSchema, parseLocalDataBoundary } from './validation.js'

export const localDataIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:@/-]+$/u)
export { nonNegativeSafeIntSchema }
export const epochMsSchema = nonNegativeSafeIntSchema
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const localDataCollectionLimits = Object.freeze({
  conversations: 10_000,
  messages: 100_000,
  memoryItems: 50_000,
  localToolStates: 10_000,
  peerGrantMetadata: 50_000,
  localAudit: 100_000,
  transcriptSessions: 5_000,
  transcriptSegments: 100_000
})

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite().safe().refine((value) => !Object.is(value, -0), {
    message: 'negative zero is not valid JSON state'
  }),
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
}).refine((value) => {
  try {
    assertJsonSafety(value, 'json.object')
    return true
  } catch {
    return false
  }
}, {
  message: 'object exceeds local data JSON safety bounds'
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

export const transcriptCaptureModeSchema = z.enum(['ambient', 'notification'])
export const transcriptLifecycleSchema = z.enum(['active', 'completed', 'interrupted', 'failed'])
export const transcriptDiarizationStateSchema = z.enum(['not_requested', 'pending', 'partial', 'available', 'unavailable'])
export const transcriptTerminalLifecycleSchema = z.enum(['completed', 'interrupted', 'failed'])

export const transcriptModelProvenanceSchema = z.object({
  provider: z.string().max(256).nullable(),
  modelId: z.string().max(256).nullable(),
  version: z.string().max(256).nullable()
}).strict()

export const transcriptSessionRecordSchema = z.object({
  id: localDataIdSchema,
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  captureMode: transcriptCaptureModeSchema,
  createdAtMs: epochMsSchema,
  startedAtMs: epochMsSchema,
  endedAtMs: epochMsSchema.nullable(),
  lifecycle: transcriptLifecycleSchema,
  terminalReason: z.string().max(512).nullable(),
  expiresAtMs: epochMsSchema.nullable(),
  language: z.string().max(64).nullable(),
  modelProvenance: transcriptModelProvenanceSchema,
  diarizationState: transcriptDiarizationStateSchema
}).strict().superRefine((record, context) => {
  if (record.startedAtMs < record.createdAtMs) {
    context.addIssue({ code: 'custom', message: 'startedAtMs cannot be before createdAtMs', path: ['startedAtMs'] })
  }
  if (record.endedAtMs !== null && record.endedAtMs < record.startedAtMs) {
    context.addIssue({ code: 'custom', message: 'endedAtMs cannot be before startedAtMs', path: ['endedAtMs'] })
  }
  if (record.expiresAtMs !== null && record.expiresAtMs < record.createdAtMs) {
    context.addIssue({ code: 'custom', message: 'expiresAtMs cannot be before createdAtMs', path: ['expiresAtMs'] })
  }
  if (record.lifecycle === 'active') {
    if (record.endedAtMs !== null) context.addIssue({ code: 'custom', message: 'active sessions cannot have endedAtMs', path: ['endedAtMs'] })
    if (record.terminalReason !== null) context.addIssue({ code: 'custom', message: 'active sessions cannot have terminalReason', path: ['terminalReason'] })
  } else {
    if (record.endedAtMs === null) context.addIssue({ code: 'custom', message: 'terminal sessions require endedAtMs', path: ['endedAtMs'] })
    if (record.terminalReason === null || record.terminalReason.trim().length === 0) {
      context.addIssue({ code: 'custom', message: 'terminal sessions require a reason', path: ['terminalReason'] })
    }
  }
})

export const transcriptSegmentRecordSchema = z.object({
  id: localDataIdSchema,
  sessionId: localDataIdSchema,
  sequence: nonNegativeSafeIntSchema,
  startAtMs: epochMsSchema,
  endAtMs: epochMsSchema,
  textEnvelope: encryptedDataEnvelopeV1Schema,
  confidence: z.number().finite().min(0).max(1).nullable(),
  speakerId: z.string().max(256).nullable(),
  speakerLabel: z.string().max(256).nullable(),
  createdAtMs: epochMsSchema
}).strict().refine((record) => record.endAtMs >= record.startAtMs, {
  message: 'endAtMs cannot be before startAtMs',
  path: ['endAtMs']
})

export const localDataRecordCollectionsSchema = z.object({
  conversations: z.array(conversationRecordSchema).max(localDataCollectionLimits.conversations),
  messages: z.array(conversationMessageRecordSchema).max(localDataCollectionLimits.messages),
  memoryItems: z.array(lightweightMemoryRecordSchema).max(localDataCollectionLimits.memoryItems),
  localToolStates: z.array(localToolStateRecordSchema).max(localDataCollectionLimits.localToolStates),
  peerGrantMetadata: z.array(peerGrantMetadataRecordSchema).max(localDataCollectionLimits.peerGrantMetadata),
  localAudit: z.array(localAuditRecordSchema).max(localDataCollectionLimits.localAudit),
  transcriptSessions: z.array(transcriptSessionRecordSchema).max(localDataCollectionLimits.transcriptSessions).default([]),
  transcriptSegments: z.array(transcriptSegmentRecordSchema).max(localDataCollectionLimits.transcriptSegments).default([])
}).strict()

export type ConversationRecord = z.infer<typeof conversationRecordSchema>
export type ConversationMessageRecord = z.infer<typeof conversationMessageRecordSchema>
export type LightweightMemoryRecord = z.infer<typeof lightweightMemoryRecordSchema>
export type LocalToolStateRecord = z.infer<typeof localToolStateRecordSchema>
export type PeerGrantMetadataRecord = z.infer<typeof peerGrantMetadataRecordSchema>
export type LocalAuditRecord = z.infer<typeof localAuditRecordSchema>
export type TranscriptCaptureMode = z.infer<typeof transcriptCaptureModeSchema>
export type TranscriptLifecycle = z.infer<typeof transcriptLifecycleSchema>
export type TranscriptTerminalLifecycle = z.infer<typeof transcriptTerminalLifecycleSchema>
export type TranscriptDiarizationState = z.infer<typeof transcriptDiarizationStateSchema>
export type TranscriptModelProvenance = z.infer<typeof transcriptModelProvenanceSchema>
export type TranscriptSessionRecord = z.infer<typeof transcriptSessionRecordSchema>
export type TranscriptSegmentRecord = z.infer<typeof transcriptSegmentRecordSchema>
export type LocalDataRecordCollections = z.infer<typeof localDataRecordCollectionsSchema>

export function parseConversationRecord(value: unknown): ConversationRecord {
  return parseLocalDataBoundary(conversationRecordSchema, value, 'record.conversation')
}

export function parseConversationMessageRecord(value: unknown): ConversationMessageRecord {
  return parseLocalDataBoundary(conversationMessageRecordSchema, value, 'record.conversation_message')
}

export function parseLightweightMemoryRecord(value: unknown): LightweightMemoryRecord {
  return parseLocalDataBoundary(lightweightMemoryRecordSchema, value, 'record.lightweight_memory')
}

export function parseLocalToolStateRecord(value: unknown): LocalToolStateRecord {
  return parseLocalDataBoundary(localToolStateRecordSchema, value, 'record.local_tool_state')
}

export function parsePeerGrantMetadataRecord(value: unknown): PeerGrantMetadataRecord {
  return parseLocalDataBoundary(peerGrantMetadataRecordSchema, value, 'record.peer_grant_metadata')
}

export function parseLocalAuditRecord(value: unknown): LocalAuditRecord {
  return parseLocalDataBoundary(localAuditRecordSchema, value, 'record.local_audit')
}

export function parseTranscriptSessionRecord(value: unknown): TranscriptSessionRecord {
  return parseLocalDataBoundary(transcriptSessionRecordSchema, value, 'record.transcript_session')
}

export function parseTranscriptSegmentRecord(value: unknown): TranscriptSegmentRecord {
  return parseLocalDataBoundary(transcriptSegmentRecordSchema, value, 'record.transcript_segment', {
    numericPathPolicy: 'transcript_segment'
  })
}

export function parseLocalDataRecordCollections(value: unknown): LocalDataRecordCollections {
  return parseLocalDataBoundary(localDataRecordCollectionsSchema, value, 'records.collections', {
    numericPathPolicy: 'transcript_collections'
  })
}
