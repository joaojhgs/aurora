import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod/v4'

import { LocalDataError, type LocalDataBackendKind } from './backend.js'
import {
  localDataCollectionLimits,
  localDataIdSchema,
  localDataRecordCollectionsSchema,
  parseLocalDataRecordCollections,
  type LocalDataRecordCollections
} from './records.zod.js'
import { assertJsonSafety, parseLocalDataBoundary } from './validation.js'

export type LocalDataTransferState = 'not_started' | 'copying' | 'verifying' | 'committed' | 'failed'

export const localDataBackendKindSchema = z.enum(['sqlite-wasm-opfs', 'sqlite-tauri', 'indexeddb', 'memory'])
export const localDataRecordCountsSchema = z.object({
  conversations: z.number().int().safe().nonnegative().max(localDataCollectionLimits.conversations).refine((value) => !Object.is(value, -0)),
  messages: z.number().int().safe().nonnegative().max(localDataCollectionLimits.messages).refine((value) => !Object.is(value, -0)),
  memoryItems: z.number().int().safe().nonnegative().max(localDataCollectionLimits.memoryItems).refine((value) => !Object.is(value, -0)),
  localToolStates: z.number().int().safe().nonnegative().max(localDataCollectionLimits.localToolStates).refine((value) => !Object.is(value, -0)),
  peerGrantMetadata: z.number().int().safe().nonnegative().max(localDataCollectionLimits.peerGrantMetadata).refine((value) => !Object.is(value, -0)),
  localAudit: z.number().int().safe().nonnegative().max(localDataCollectionLimits.localAudit).refine((value) => !Object.is(value, -0))
}).strict()
export const localDataCollectionHashesSchema = z.object({
  conversations: z.string().regex(/^[a-f0-9]{64}$/u),
  messages: z.string().regex(/^[a-f0-9]{64}$/u),
  memoryItems: z.string().regex(/^[a-f0-9]{64}$/u),
  localToolStates: z.string().regex(/^[a-f0-9]{64}$/u),
  peerGrantMetadata: z.string().regex(/^[a-f0-9]{64}$/u),
  localAudit: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict()
export const localDataExportV1Schema = z.object({
  version: z.literal(1),
  sourceBackend: localDataBackendKindSchema,
  schemaVersion: z.number().int().safe().nonnegative().refine((value) => !Object.is(value, -0)),
  profileId: localDataIdSchema,
  localNodeId: localDataIdSchema,
  exportedAtMs: z.number().int().safe().nonnegative().refine((value) => !Object.is(value, -0)),
  encryptionEnvelopeVersions: z.tuple([z.literal(1)]),
  recordCounts: localDataRecordCountsSchema,
  collectionHashes: localDataCollectionHashesSchema,
  records: localDataRecordCollectionsSchema
}).strict()

export type LocalDataCollectionHashes = z.infer<typeof localDataCollectionHashesSchema>
export type LocalDataRecordCounts = z.infer<typeof localDataRecordCountsSchema>
export type LocalDataExportV1 = z.infer<typeof localDataExportV1Schema>

export interface LocalDataImportResult {
  imported: true
  recordCounts: LocalDataRecordCounts
  collectionHashes: LocalDataCollectionHashes
}

export function buildLocalDataExportV1(input: {
  sourceBackend: LocalDataBackendKind
  schemaVersion: number
  profileId: string
  localNodeId: string
  exportedAtMs: number
  records: LocalDataRecordCollections
}): LocalDataExportV1 {
  const records = parseLocalDataRecordCollections(input.records)
  assertJsonSafety(records, 'records.collections')
  return parseLocalDataBoundary(localDataExportV1Schema, {
    version: 1,
    sourceBackend: input.sourceBackend,
    schemaVersion: input.schemaVersion,
    profileId: input.profileId,
    localNodeId: input.localNodeId,
    exportedAtMs: input.exportedAtMs,
    encryptionEnvelopeVersions: [1],
    recordCounts: countLocalDataRecords(records),
    collectionHashes: hashLocalDataCollections(records),
    records: sortLocalDataRecords(records)
  }, 'export.v1')
}

export function parseLocalDataExportV1(value: unknown): LocalDataExportV1 {
  assertJsonSafety(value, 'export.v1')
  const parsed = parseLocalDataBoundary(localDataExportV1Schema, value, 'export.v1')
  const counts = countLocalDataRecords(parsed.records)
  const hashes = hashLocalDataCollections(parsed.records)
  if (JSON.stringify(counts) !== JSON.stringify(parsed.recordCounts)) {
    throw new LocalDataError('invalid_record', 'Local data export record counts do not match records', { reason: 'record_count_mismatch' })
  }
  if (JSON.stringify(hashes) !== JSON.stringify(parsed.collectionHashes)) {
    throw new LocalDataError('invalid_record', 'Local data export hashes do not match records', { reason: 'collection_hash_mismatch' })
  }
  return { ...parsed, records: sortLocalDataRecords(parsed.records) }
}

export function countLocalDataRecords(records: LocalDataRecordCollections): LocalDataRecordCounts {
  return {
    conversations: records.conversations.length,
    messages: records.messages.length,
    memoryItems: records.memoryItems.length,
    localToolStates: records.localToolStates.length,
    peerGrantMetadata: records.peerGrantMetadata.length,
    localAudit: records.localAudit.length
  }
}

export function hashLocalDataCollections(records: LocalDataRecordCollections): LocalDataCollectionHashes {
  const sorted = sortLocalDataRecords(records)
  return {
    conversations: hashJson(sorted.conversations),
    messages: hashJson(sorted.messages),
    memoryItems: hashJson(sorted.memoryItems),
    localToolStates: hashJson(sorted.localToolStates),
    peerGrantMetadata: hashJson(sorted.peerGrantMetadata),
    localAudit: hashJson(sorted.localAudit)
  }
}

export function sortLocalDataRecords(records: LocalDataRecordCollections): LocalDataRecordCollections {
  return {
    conversations: [...records.conversations].sort(byId),
    messages: [...records.messages].sort((a, b) => compareUtf8(a.conversationId, b.conversationId) || a.sequence - b.sequence || compareUtf8(a.id, b.id)),
    memoryItems: [...records.memoryItems].sort(byId),
    localToolStates: [...records.localToolStates].sort((a, b) => compareUtf8(a.profileId, b.profileId) || compareUtf8(a.localNodeId, b.localNodeId) || compareUtf8(a.toolContractId, b.toolContractId)),
    peerGrantMetadata: [...records.peerGrantMetadata].sort((a, b) => compareUtf8(a.grantId, b.grantId)),
    localAudit: [...records.localAudit].sort((a, b) => a.createdAtMs - b.createdAtMs || compareUtf8(a.id, b.id))
  }
}

export const localDataExportV1JsonSchema = z.toJSONSchema(localDataExportV1Schema)

function hashJson(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(canonicalJson(value))), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort(compareUtf8)) {
    const item = record[key]
    if (item !== undefined) sorted[key] = canonicalize(item)
  }
  return sorted
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareUtf8(a.id, b.id)
}

export function compareUtf8(a: string, b: string): number {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return left.byteLength - right.byteLength
}
