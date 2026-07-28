import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod/v4'

import type { LocalDataBackendKind } from './backend.js'
import {
  localDataRecordCollectionsSchema,
  parseLocalDataRecordCollections,
  type LocalDataRecordCollections
} from './records.zod.js'

export type LocalDataTransferState = 'not_started' | 'copying' | 'verifying' | 'committed' | 'failed'

export const localDataBackendKindSchema = z.enum(['sqlite-wasm-opfs', 'sqlite-tauri', 'indexeddb', 'memory'])
export const localDataRecordCountsSchema = z.object({
  conversations: z.number().int().safe().nonnegative(),
  messages: z.number().int().safe().nonnegative(),
  memoryItems: z.number().int().safe().nonnegative(),
  localToolStates: z.number().int().safe().nonnegative(),
  peerGrantMetadata: z.number().int().safe().nonnegative(),
  localAudit: z.number().int().safe().nonnegative()
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
  schemaVersion: z.number().int().safe().nonnegative(),
  profileId: z.string().min(1),
  localNodeId: z.string().min(1),
  exportedAtMs: z.number().int().safe().nonnegative(),
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
  return localDataExportV1Schema.parse({
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
  })
}

export function parseLocalDataExportV1(value: unknown): LocalDataExportV1 {
  const parsed = localDataExportV1Schema.parse(value)
  const counts = countLocalDataRecords(parsed.records)
  const hashes = hashLocalDataCollections(parsed.records)
  if (JSON.stringify(counts) !== JSON.stringify(parsed.recordCounts)) {
    throw new TypeError('local data export record counts do not match records')
  }
  if (JSON.stringify(hashes) !== JSON.stringify(parsed.collectionHashes)) {
    throw new TypeError('local data export hashes do not match records')
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
    messages: [...records.messages].sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.sequence - b.sequence || a.id.localeCompare(b.id)),
    memoryItems: [...records.memoryItems].sort(byId),
    localToolStates: [...records.localToolStates].sort((a, b) => a.profileId.localeCompare(b.profileId) || a.localNodeId.localeCompare(b.localNodeId) || a.toolContractId.localeCompare(b.toolContractId)),
    peerGrantMetadata: [...records.peerGrantMetadata].sort((a, b) => a.grantId.localeCompare(b.grantId)),
    localAudit: [...records.localAudit].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
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
  for (const key of Object.keys(record).sort()) {
    const item = record[key]
    if (item !== undefined) sorted[key] = canonicalize(item)
  }
  return sorted
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id)
}
