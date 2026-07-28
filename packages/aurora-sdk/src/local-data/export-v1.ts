import { sha256 } from '@noble/hashes/sha2.js'

import type { LocalDataBackendKind } from './backend.js'
import {
  parseLocalDataRecordCollections,
  type LocalDataRecordCollections
} from './records.zod.js'

export type LocalDataTransferState = 'not_started' | 'copying' | 'verifying' | 'committed' | 'failed'

export interface LocalDataCollectionHashes {
  conversations: string
  messages: string
  memoryItems: string
  localToolStates: string
  peerGrantMetadata: string
  localAudit: string
}

export interface LocalDataRecordCounts {
  conversations: number
  messages: number
  memoryItems: number
  localToolStates: number
  peerGrantMetadata: number
  localAudit: number
}

export interface LocalDataExportV1 {
  version: 1
  sourceBackend: LocalDataBackendKind
  schemaVersion: number
  profileId: string
  localNodeId: string
  exportedAtMs: number
  encryptionEnvelopeVersions: [1]
  recordCounts: LocalDataRecordCounts
  collectionHashes: LocalDataCollectionHashes
  records: LocalDataRecordCollections
}

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
  return {
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
  }
}

export function parseLocalDataExportV1(value: unknown): LocalDataExportV1 {
  const record = requireRecord(value, 'local data export')
  if (record.version !== 1) throw new TypeError('local data export version must be 1')
  const records = parseLocalDataRecordCollections(record.records)
  const parsed: LocalDataExportV1 = {
    version: 1,
    sourceBackend: requireBackendKind(record.sourceBackend),
    schemaVersion: requireNonNegativeInt(record.schemaVersion, 'schemaVersion'),
    profileId: requireString(record.profileId, 'profileId'),
    localNodeId: requireString(record.localNodeId, 'localNodeId'),
    exportedAtMs: requireNonNegativeInt(record.exportedAtMs, 'exportedAtMs'),
    encryptionEnvelopeVersions: parseEnvelopeVersions(record.encryptionEnvelopeVersions),
    recordCounts: parseCounts(record.recordCounts),
    collectionHashes: parseHashes(record.collectionHashes),
    records
  }
  const counts = countLocalDataRecords(records)
  const hashes = hashLocalDataCollections(records)
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

export const localDataExportV1JsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'LocalDataExportV1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'sourceBackend', 'schemaVersion', 'profileId', 'localNodeId', 'exportedAtMs', 'encryptionEnvelopeVersions', 'recordCounts', 'collectionHashes', 'records'],
  properties: {
    version: { const: 1 },
    sourceBackend: { enum: ['sqlite-wasm-opfs', 'sqlite-tauri', 'indexeddb', 'memory'] },
    schemaVersion: { type: 'integer', minimum: 0 },
    profileId: { type: 'string', minLength: 1 },
    localNodeId: { type: 'string', minLength: 1 },
    exportedAtMs: { type: 'integer', minimum: 0 },
    encryptionEnvelopeVersions: { type: 'array', items: { const: 1 }, minItems: 1, maxItems: 1 },
    recordCounts: { type: 'object' },
    collectionHashes: { type: 'object' },
    records: { type: 'object' }
  }
} as const)

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) throw new TypeError(`${label} must be a string`)
  return value
}

function requireNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

function requireBackendKind(value: unknown): LocalDataBackendKind {
  if (value === 'sqlite-wasm-opfs' || value === 'sqlite-tauri' || value === 'indexeddb' || value === 'memory') return value
  throw new TypeError('sourceBackend must be a supported local data backend kind')
}

function parseEnvelopeVersions(value: unknown): [1] {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 1) throw new TypeError('encryptionEnvelopeVersions must be [1]')
  return [1]
}

function parseCounts(value: unknown): LocalDataRecordCounts {
  const record = requireRecord(value, 'recordCounts')
  return {
    conversations: requireNonNegativeInt(record.conversations, 'conversations'),
    messages: requireNonNegativeInt(record.messages, 'messages'),
    memoryItems: requireNonNegativeInt(record.memoryItems, 'memoryItems'),
    localToolStates: requireNonNegativeInt(record.localToolStates, 'localToolStates'),
    peerGrantMetadata: requireNonNegativeInt(record.peerGrantMetadata, 'peerGrantMetadata'),
    localAudit: requireNonNegativeInt(record.localAudit, 'localAudit')
  }
}

function parseHashes(value: unknown): LocalDataCollectionHashes {
  const record = requireRecord(value, 'collectionHashes')
  return {
    conversations: requireHash(record.conversations, 'conversations'),
    messages: requireHash(record.messages, 'messages'),
    memoryItems: requireHash(record.memoryItems, 'memoryItems'),
    localToolStates: requireHash(record.localToolStates, 'localToolStates'),
    peerGrantMetadata: requireHash(record.peerGrantMetadata, 'peerGrantMetadata'),
    localAudit: requireHash(record.localAudit, 'localAudit')
  }
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`)
  return value
}
