import { parseEncryptedDataEnvelopeV1, type EncryptedDataEnvelopeV1 } from './encrypted-envelope.js'

export type ConversationMessageRole = 'system' | 'user' | 'assistant' | 'tool'
export type ConversationMessageStatus = 'pending' | 'complete' | 'failed' | 'cancelled'

export interface ConversationRecord {
  id: string
  profileId: string
  localNodeId: string
  titleEnvelope: EncryptedDataEnvelopeV1 | null
  createdAtMs: number
  updatedAtMs: number
  archivedAtMs: number | null
}

export interface ConversationMessageRecord {
  id: string
  conversationId: string
  sequence: number
  role: ConversationMessageRole
  contentEnvelope: EncryptedDataEnvelopeV1 | null
  toolEnvelope: EncryptedDataEnvelopeV1 | null
  status: ConversationMessageStatus
  createdAtMs: number
}

export interface LightweightMemoryRecord {
  id: string
  profileId: string
  localNodeId: string
  namespace: string
  payloadEnvelope: EncryptedDataEnvelopeV1
  sourceType: string | null
  sourceId: string | null
  createdAtMs: number
  updatedAtMs: number
  expiresAtMs: number | null
}

export interface LocalToolStateRecord {
  profileId: string
  localNodeId: string
  toolContractId: string
  descriptorJson: Record<string, unknown>
  descriptorHash: string
  enabled: boolean
  settingsEnvelope: EncryptedDataEnvelopeV1 | null
  revision: number
  updatedAtMs: number
}

export interface PeerGrantMetadataRecord {
  grantId: string
  profileId: string
  localNodeId: string
  claimantPeerId: string
  tokenId: string
  scopeEnvelope: EncryptedDataEnvelopeV1
  revision: number
  createdAtMs: number
  expiresAtMs: number | null
  revokedAtMs: number | null
}

export interface LocalAuditRecord {
  id: string
  profileId: string
  localNodeId: string
  peerId: string | null
  action: string
  decision: string
  resultStatus: string
  connectionEpoch: string | null
  methodId: string | null
  toolContractId: string | null
  correlationId: string | null
  redactedDetailJson: Record<string, unknown>
  createdAtMs: number
}

export interface LocalDataRecordCollections {
  conversations: ConversationRecord[]
  messages: ConversationMessageRecord[]
  memoryItems: LightweightMemoryRecord[]
  localToolStates: LocalToolStateRecord[]
  peerGrantMetadata: PeerGrantMetadataRecord[]
  localAudit: LocalAuditRecord[]
}

export interface SchemaContract<T> {
  parse(value: unknown): T
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error }
  toJSONSchema(): Record<string, unknown>
}

export const conversationRecordSchema = contract(parseConversationRecord, 'ConversationRecord')
export const conversationMessageRecordSchema = contract(parseConversationMessageRecord, 'ConversationMessageRecord')
export const lightweightMemoryRecordSchema = contract(parseLightweightMemoryRecord, 'LightweightMemoryRecord')
export const localToolStateRecordSchema = contract(parseLocalToolStateRecord, 'LocalToolStateRecord')
export const peerGrantMetadataRecordSchema = contract(parsePeerGrantMetadataRecord, 'PeerGrantMetadataRecord')
export const localAuditRecordSchema = contract(parseLocalAuditRecord, 'LocalAuditRecord')

export function parseConversationRecord(value: unknown): ConversationRecord {
  const record = requireRecord(value, 'conversation')
  const parsed: ConversationRecord = {
    id: requireId(record.id, 'id'),
    profileId: requireId(record.profileId, 'profileId'),
    localNodeId: requireId(record.localNodeId, 'localNodeId'),
    titleEnvelope: nullableEnvelope(record.titleEnvelope),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs'),
    updatedAtMs: requireEpochMs(record.updatedAtMs, 'updatedAtMs'),
    archivedAtMs: nullableEpochMs(record.archivedAtMs, 'archivedAtMs')
  }
  requireOrder(parsed.createdAtMs, parsed.updatedAtMs, 'updatedAtMs')
  return parsed
}

export function parseConversationMessageRecord(value: unknown): ConversationMessageRecord {
  const record = requireRecord(value, 'message')
  return {
    id: requireId(record.id, 'id'),
    conversationId: requireId(record.conversationId, 'conversationId'),
    sequence: requireNonNegativeInt(record.sequence, 'sequence'),
    role: requireEnum(record.role, ['system', 'user', 'assistant', 'tool'], 'role'),
    contentEnvelope: nullableEnvelope(record.contentEnvelope),
    toolEnvelope: nullableEnvelope(record.toolEnvelope),
    status: requireEnum(record.status, ['pending', 'complete', 'failed', 'cancelled'], 'status'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs')
  }
}

export function parseLightweightMemoryRecord(value: unknown): LightweightMemoryRecord {
  const record = requireRecord(value, 'memory item')
  const parsed: LightweightMemoryRecord = {
    id: requireId(record.id, 'id'),
    profileId: requireId(record.profileId, 'profileId'),
    localNodeId: requireId(record.localNodeId, 'localNodeId'),
    namespace: requireId(record.namespace, 'namespace'),
    payloadEnvelope: parseEncryptedDataEnvelopeV1(record.payloadEnvelope),
    sourceType: nullableString(record.sourceType, 'sourceType'),
    sourceId: nullableString(record.sourceId, 'sourceId'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs'),
    updatedAtMs: requireEpochMs(record.updatedAtMs, 'updatedAtMs'),
    expiresAtMs: nullableEpochMs(record.expiresAtMs, 'expiresAtMs')
  }
  requireOrder(parsed.createdAtMs, parsed.updatedAtMs, 'updatedAtMs')
  return parsed
}

export function parseLocalToolStateRecord(value: unknown): LocalToolStateRecord {
  const record = requireRecord(value, 'local tool state')
  return {
    profileId: requireId(record.profileId, 'profileId'),
    localNodeId: requireId(record.localNodeId, 'localNodeId'),
    toolContractId: requireId(record.toolContractId, 'toolContractId'),
    descriptorJson: requireJsonObject(record.descriptorJson, 'descriptorJson'),
    descriptorHash: requireHash(record.descriptorHash, 'descriptorHash'),
    enabled: requireBoolean(record.enabled, 'enabled'),
    settingsEnvelope: nullableEnvelope(record.settingsEnvelope),
    revision: requireNonNegativeInt(record.revision, 'revision'),
    updatedAtMs: requireEpochMs(record.updatedAtMs, 'updatedAtMs')
  }
}

export function parsePeerGrantMetadataRecord(value: unknown): PeerGrantMetadataRecord {
  const record = requireRecord(value, 'peer grant metadata')
  return {
    grantId: requireId(record.grantId, 'grantId'),
    profileId: requireId(record.profileId, 'profileId'),
    localNodeId: requireId(record.localNodeId, 'localNodeId'),
    claimantPeerId: requireId(record.claimantPeerId, 'claimantPeerId'),
    tokenId: requireId(record.tokenId, 'tokenId'),
    scopeEnvelope: parseEncryptedDataEnvelopeV1(record.scopeEnvelope),
    revision: requireNonNegativeInt(record.revision, 'revision'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs'),
    expiresAtMs: nullableEpochMs(record.expiresAtMs, 'expiresAtMs'),
    revokedAtMs: nullableEpochMs(record.revokedAtMs, 'revokedAtMs')
  }
}

export function parseLocalAuditRecord(value: unknown): LocalAuditRecord {
  const record = requireRecord(value, 'local audit')
  return {
    id: requireId(record.id, 'id'),
    profileId: requireId(record.profileId, 'profileId'),
    localNodeId: requireId(record.localNodeId, 'localNodeId'),
    peerId: nullableString(record.peerId, 'peerId'),
    action: requireId(record.action, 'action'),
    decision: requireId(record.decision, 'decision'),
    resultStatus: requireId(record.resultStatus, 'resultStatus'),
    connectionEpoch: nullableString(record.connectionEpoch, 'connectionEpoch'),
    methodId: nullableString(record.methodId, 'methodId'),
    toolContractId: nullableString(record.toolContractId, 'toolContractId'),
    correlationId: nullableString(record.correlationId, 'correlationId'),
    redactedDetailJson: requireJsonObject(record.redactedDetailJson, 'redactedDetailJson'),
    createdAtMs: requireEpochMs(record.createdAtMs, 'createdAtMs')
  }
}

export function parseLocalDataRecordCollections(value: unknown): LocalDataRecordCollections {
  const record = requireRecord(value, 'local data record collections')
  return {
    conversations: requireArray(record.conversations, 'conversations').map(parseConversationRecord),
    messages: requireArray(record.messages, 'messages').map(parseConversationMessageRecord),
    memoryItems: requireArray(record.memoryItems, 'memoryItems').map(parseLightweightMemoryRecord),
    localToolStates: requireArray(record.localToolStates, 'localToolStates').map(parseLocalToolStateRecord),
    peerGrantMetadata: requireArray(record.peerGrantMetadata, 'peerGrantMetadata').map(parsePeerGrantMetadataRecord),
    localAudit: requireArray(record.localAudit, 'localAudit').map(parseLocalAuditRecord)
  }
}

export const localDataRecordCollectionsSchema = contract(parseLocalDataRecordCollections, 'LocalDataRecordCollections')

function contract<T>(parser: (value: unknown) => T, title: string): SchemaContract<T> {
  return {
    parse: parser,
    safeParse(value: unknown) {
      try {
        return { success: true, data: parser(value) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
      }
    },
    toJSONSchema() {
      return { $schema: 'https://json-schema.org/draft/2020-12/schema', title, type: 'object' }
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  return requireRecord(value, label)
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new TypeError(`${label} must be a bounded identifier`)
  }
  return value
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash`)
  }
  return value
}

function requireEpochMs(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be epoch milliseconds`)
  return value
}

function nullableEpochMs(value: unknown, label: string): number | null {
  if (value === null) return null
  return requireEpochMs(value, label)
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 256) throw new TypeError(`${label} must be null or a bounded string`)
  return value
}

function requireNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function requireEnum<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new TypeError(`${label} must be one of ${options.join(', ')}`)
  }
  return value as T
}

function nullableEnvelope(value: unknown): EncryptedDataEnvelopeV1 | null {
  if (value === null) return null
  return parseEncryptedDataEnvelopeV1(value)
}

function requireOrder(createdAtMs: number, updatedAtMs: number, label: string): void {
  if (updatedAtMs < createdAtMs) throw new TypeError(`${label} cannot be before createdAtMs`)
}
