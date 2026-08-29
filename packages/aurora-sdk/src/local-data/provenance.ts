import { z } from 'zod/v4'

import { LocalDataError } from './backend.js'
import {
  localDataIdSchema,
  epochMsSchema,
  type ConversationMessageRecord,
  type ConversationRecord,
  type LightweightMemoryRecord
} from './records.zod.js'
import { parseLocalDataBoundary } from './validation.js'

export const LOCAL_DATA_HISTORY_AUTHORITY = 'local-sdk' as const
export const LOCAL_DATA_REPLICATION_STATE = 'local-only' as const

export interface LocalDataScope {
  readonly profileId: string
  readonly localNodeId: string
}

export interface LocalDataHistoryBoundary {
  readonly authority: typeof LOCAL_DATA_HISTORY_AUTHORITY
  readonly replicationState: typeof LOCAL_DATA_REPLICATION_STATE
}

export interface LocalDataProvenance {
  readonly origin: 'local'
  readonly profileId: string
  readonly localNodeId: string
  readonly namespace: string
  readonly conversationId: string | null
  readonly messageId: string | null
  readonly sourceType: string | null
  readonly sourceId: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly expiresAtMs: number | null
  readonly retention: 'retained' | 'expires'
  readonly redactedFields: readonly string[]
  readonly historyBoundary: LocalDataHistoryBoundary
}

export const localDataScopeSchema = z.object({
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema
}).strict()

const nullableSourceSchema = z.string().min(1).max(256).nullable()

export const localDataProvenanceInputSchema = z.object({
  namespace: localDataIdSchema,
  sourceType: nullableSourceSchema,
  sourceId: nullableSourceSchema,
  createdAtMs: epochMsSchema,
  updatedAtMs: epochMsSchema,
  expiresAtMs: epochMsSchema.nullable()
}).strict().refine((value) => value.updatedAtMs >= value.createdAtMs, {
  message: 'updatedAtMs cannot be before createdAtMs',
  path: ['updatedAtMs']
}).refine((value) => (value.sourceType === null) === (value.sourceId === null), {
  message: 'sourceType and sourceId must be both present or both null',
  path: ['sourceId']
}).refine((value) => value.expiresAtMs === null || value.expiresAtMs >= value.createdAtMs, {
  message: 'expiresAtMs cannot be before createdAtMs',
  path: ['expiresAtMs']
})

export type LocalDataProvenanceInput = z.infer<typeof localDataProvenanceInputSchema>

export function parseLocalDataScope(value: unknown): LocalDataScope {
  return parseLocalDataBoundary(localDataScopeSchema, value, 'local_data.scope')
}

export function parseLocalDataProvenanceInput(value: unknown): LocalDataProvenanceInput {
  return parseLocalDataBoundary(localDataProvenanceInputSchema, value, 'local_data.provenance')
}

export function buildMemoryProvenance(record: LightweightMemoryRecord): LocalDataProvenance {
  const parsed = parseLocalDataProvenanceInput({
    namespace: record.namespace,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    expiresAtMs: record.expiresAtMs
  })
  return {
    origin: 'local',
    profileId: record.profileId,
    localNodeId: record.localNodeId,
    ...parsed,
    conversationId: parsed.sourceType === 'conversation' ? parsed.sourceId : null,
    messageId: parsed.sourceType === 'message' ? parsed.sourceId : null,
    retention: parsed.expiresAtMs === null ? 'retained' : 'expires',
    redactedFields: ['payloadEnvelope'],
    historyBoundary: localDataHistoryBoundary()
  }
}

export function buildConversationProvenance(record: ConversationRecord): LocalDataProvenance {
  return {
    origin: 'local',
    profileId: record.profileId,
    localNodeId: record.localNodeId,
    namespace: 'conversations',
    conversationId: record.id,
    messageId: null,
    sourceType: 'conversation',
    sourceId: record.id,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    expiresAtMs: null,
    retention: 'retained',
    redactedFields: record.titleEnvelope === null ? [] : ['titleEnvelope'],
    historyBoundary: localDataHistoryBoundary()
  }
}

export function buildMessageProvenance(record: ConversationMessageRecord, scope: LocalDataScope): LocalDataProvenance {
  return {
    origin: 'local',
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
    namespace: 'messages',
    conversationId: record.conversationId,
    messageId: record.id,
    sourceType: 'message',
    sourceId: record.id,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.createdAtMs,
    expiresAtMs: null,
    retention: 'retained',
    redactedFields: [
      ...(record.contentEnvelope === null ? [] : ['contentEnvelope']),
      ...(record.toolEnvelope === null ? [] : ['toolEnvelope'])
    ],
    historyBoundary: localDataHistoryBoundary()
  }
}

export function localDataHistoryBoundary(): LocalDataHistoryBoundary {
  return {
    authority: LOCAL_DATA_HISTORY_AUTHORITY,
    replicationState: LOCAL_DATA_REPLICATION_STATE
  }
}

export function assertScopeIdentity(record: LocalDataScope, scope: LocalDataScope): void {
  if (record.profileId !== scope.profileId || record.localNodeId !== scope.localNodeId) {
    throw new LocalDataError('identity_mismatch', 'Local data record identity does not match the requested scope')
  }
}

export function assertNoImplicitPythonHistoryMerge(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const object = value as Record<string, unknown>
  if (
    object.replicateToPython === true ||
    object.pythonHistoryId !== undefined ||
    object.pythonConversationId !== undefined ||
    object.backendHistoryId !== undefined
  ) {
    throw new LocalDataError('invalid_record', 'Local SDK history cannot be merged into Python history implicitly', {
      reason: 'implicit_python_history_merge'
    })
  }
}

export function isExpiredAt(record: { readonly expiresAtMs: number | null }, nowMs: number): boolean {
  return record.expiresAtMs !== null && record.expiresAtMs <= nowMs
}

export function requireEpochMs(value: number, reason: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new LocalDataError('invalid_record', 'Timestamp must be a non-negative safe integer', { reason })
  }
  return value
}

export function requirePositiveLimit(value: number, max: number, reason: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new LocalDataError('invalid_record', 'Limit must be a positive safe integer within the SDK bound', { reason })
  }
  return value
}
