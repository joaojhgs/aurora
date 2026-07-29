import { LocalDataError } from './backend.js'
import { buildEnvelopeAad } from './encrypted-envelope.js'
import type { EnvelopeCryptoPort } from './envelope-crypto-port.js'
import { compareUtf8 } from './export-v1.js'
import { localDataIdSchema, type ConversationMessageRecord, type ConversationRecord, type LightweightMemoryRecord } from './records.zod.js'
import type { LocalDataSession } from './session.js'
import { parseLocalDataBoundary } from './validation.js'
import {
  assertNoImplicitPythonHistoryMerge,
  assertScopeIdentity,
  buildMemoryProvenance,
  buildConversationProvenance,
  buildMessageProvenance,
  isExpiredAt,
  localDataHistoryBoundary,
  parseLocalDataScope,
  requireEpochMs,
  requirePositiveLimit,
  type LocalDataProvenance,
  type LocalDataScope
} from './provenance.js'

const MAX_QUERY_BYTES = 512
const MAX_SCAN_RECORDS = 5_000
const MAX_RESULTS = 200
const MAX_DECRYPT_BYTES = 64 * 1024
const MAX_TOTAL_DECRYPT_BYTES = 512 * 1024
const MAX_HIGHLIGHT_BYTES = 256

export type LocalDataSearchDomain = 'conversations' | 'messages' | 'memory'
export type LocalDataSearchMatchField = 'metadata' | 'decrypted_content'

export interface LocalDataSearchOptions {
  readonly scope: LocalDataScope
  readonly query: string
  readonly nowMs: number
  readonly domains?: readonly LocalDataSearchDomain[]
  readonly namespace?: string
  readonly includeArchived?: boolean
  readonly includeExpired?: boolean
  readonly limit?: number
  readonly maxScanRecords?: number
  readonly maxQueryBytes?: number
  readonly maxDecryptedRecordBytes?: number
  readonly maxTotalDecryptedBytes?: number
  readonly decrypt?: {
    readonly crypto: EnvelopeCryptoPort
    readonly authorized: boolean
  }
  readonly signal?: AbortSignal
}

export interface LocalDataSearchResult {
  readonly domain: LocalDataSearchDomain
  readonly id: string
  readonly conversationId: string | null
  readonly sequence: number | null
  readonly namespace: string | null
  readonly matchField: LocalDataSearchMatchField
  readonly matchedTextPreview: string
  readonly provenance: LocalDataProvenance | null
  readonly historyBoundary: ReturnType<typeof localDataHistoryBoundary>
}

export interface LocalDataSearchSummary {
  query: string
  scannedRecords: number
  decryptedRecords: number
  decryptedBytes: number
  resultCount: number
  bounded: true
  contentSearchAuthorized: boolean
}

export interface LocalDataSearchResponse {
  readonly results: LocalDataSearchResult[]
  readonly summary: LocalDataSearchSummary
}

export async function searchLocalData(session: LocalDataSession, options: LocalDataSearchOptions): Promise<LocalDataSearchResponse> {
  assertNoImplicitPythonHistoryMerge(options)
  const scope = parseLocalDataScope(options.scope)
  assertScopeIdentity(session, scope)
  const query = normalizeQuery(options.query, options.maxQueryBytes ?? MAX_QUERY_BYTES)
  const nowMs = requireEpochMs(options.nowMs, 'search_now_ms')
  const limit = requirePositiveLimit(options.limit ?? 50, MAX_RESULTS, 'search_result_limit')
  const maxScanRecords = requirePositiveLimit(options.maxScanRecords ?? 1_000, MAX_SCAN_RECORDS, 'search_scan_limit')
  const maxDecryptedRecordBytes = requirePositiveLimit(options.maxDecryptedRecordBytes ?? MAX_DECRYPT_BYTES, MAX_DECRYPT_BYTES, 'search_decrypted_record_limit')
  const maxTotalDecryptedBytes = requirePositiveLimit(options.maxTotalDecryptedBytes ?? MAX_TOTAL_DECRYPT_BYTES, MAX_TOTAL_DECRYPT_BYTES, 'search_decrypted_total_limit')
  const domains = normalizeDomains(options.domains)
  const namespace = options.namespace === undefined
    ? undefined
    : parseLocalDataBoundary(localDataIdSchema, options.namespace, 'local_data.search_namespace')
  const contentAuthorized = options.decrypt?.authorized === true && options.decrypt.crypto !== undefined
  const results: LocalDataSearchResult[] = []
  const summary: LocalDataSearchSummary = {
    query,
    scannedRecords: 0,
    decryptedRecords: 0,
    decryptedBytes: 0,
    resultCount: 0,
    bounded: true,
    contentSearchAuthorized: contentAuthorized
  }

  const checkBounds = (): boolean => summary.scannedRecords < maxScanRecords && results.length < limit
  if (domains.has('conversations') && checkBounds()) {
    const conversations = (await session.conversations.listConversations())
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .filter((record) => options.includeArchived === true || record.archivedAtMs === null)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id))
    for (const record of conversations) {
      throwIfAborted(options.signal)
      if (!checkBounds()) break
      summary.scannedRecords += 1
      addMetadataResult(results, query, conversationMetadata(record), {
        domain: 'conversations',
        id: record.id,
        conversationId: record.id,
        sequence: null,
        namespace: null,
        provenance: buildConversationProvenance(record)
      })
      if (contentAuthorized && record.titleEnvelope !== null) {
        await addDecryptedResult(options.decrypt?.crypto, summary, results, query, maxDecryptedRecordBytes, maxTotalDecryptedBytes, {
          envelope: record.titleEnvelope,
          aad: buildEnvelopeAad({ table: 'aurora_conversations', recordId: record.id, field: 'title_envelope_json', profileId: record.profileId, localNodeId: record.localNodeId }),
          domain: 'conversations',
          id: record.id,
          conversationId: record.id,
          sequence: null,
          namespace: null,
          provenance: buildConversationProvenance(record),
          signal: options.signal
        })
      }
    }
  }

  if (domains.has('messages') && checkBounds()) {
    const conversations = new Map((await session.conversations.listConversations())
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .map((record) => [record.id, record]))
    for (const conversation of [...conversations.values()].sort((a, b) => compareUtf8(a.id, b.id))) {
      if (options.includeArchived !== true && conversation.archivedAtMs !== null) continue
      const messages = (await session.conversations.listMessages(conversation.id)).sort((a, b) => a.sequence - b.sequence || compareUtf8(a.id, b.id))
      for (const record of messages) {
        throwIfAborted(options.signal)
        if (!checkBounds()) break
        summary.scannedRecords += 1
        addMetadataResult(results, query, messageMetadata(record), {
          domain: 'messages',
          id: record.id,
          conversationId: record.conversationId,
          sequence: record.sequence,
          namespace: null,
          provenance: buildMessageProvenance(record, scope)
        })
        if (contentAuthorized && record.contentEnvelope !== null) {
          await addDecryptedResult(options.decrypt?.crypto, summary, results, query, maxDecryptedRecordBytes, maxTotalDecryptedBytes, {
            envelope: record.contentEnvelope,
            aad: buildEnvelopeAad({ table: 'aurora_messages', recordId: record.id, field: 'content_envelope_json', profileId: scope.profileId, localNodeId: scope.localNodeId }),
            domain: 'messages',
            id: record.id,
            conversationId: record.conversationId,
            sequence: record.sequence,
            namespace: null,
            provenance: buildMessageProvenance(record, scope),
            signal: options.signal
          })
        }
        if (!checkBounds()) break
      }
    }
  }

  if (domains.has('memory') && checkBounds()) {
    const records = (await session.memory.listMemoryItems(namespace))
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .filter((record) => options.includeExpired === true || !isExpiredAt(record, nowMs))
      .sort((a, b) => compareUtf8(a.namespace, b.namespace) || b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id))
    for (const record of records) {
      throwIfAborted(options.signal)
      if (!checkBounds()) break
      summary.scannedRecords += 1
      const provenance = buildMemoryProvenance(record)
      addMetadataResult(results, query, memoryMetadata(record), {
        domain: 'memory',
        id: record.id,
        conversationId: null,
        sequence: null,
        namespace: record.namespace,
        provenance
      })
      if (contentAuthorized) {
        await addDecryptedResult(options.decrypt?.crypto, summary, results, query, maxDecryptedRecordBytes, maxTotalDecryptedBytes, {
          envelope: record.payloadEnvelope,
          aad: buildEnvelopeAad({ table: 'aurora_memory_items', recordId: record.id, field: 'payload_envelope_json', profileId: record.profileId, localNodeId: record.localNodeId }),
          domain: 'memory',
          id: record.id,
          conversationId: null,
          sequence: null,
          namespace: record.namespace,
          provenance,
          signal: options.signal
        })
      }
    }
  }

  const sorted = results.sort(compareResults).slice(0, limit)
  return {
    results: sorted,
    summary: {
      ...summary,
      resultCount: sorted.length
    }
  }
}

function normalizeDomains(domains: readonly LocalDataSearchDomain[] | undefined): ReadonlySet<LocalDataSearchDomain> {
  const allowed = new Set<LocalDataSearchDomain>(['conversations', 'messages', 'memory'])
  if (domains === undefined) return allowed
  if (domains.length < 1 || domains.length > allowed.size) {
    throw new LocalDataError('invalid_record', 'Search domains must be a non-empty bounded list', { reason: 'search_domains' })
  }
  const selected = new Set<LocalDataSearchDomain>()
  for (const domain of domains) {
    if (!allowed.has(domain) || selected.has(domain)) {
      throw new LocalDataError('invalid_record', 'Search domains must be known and unique', { reason: 'search_domains' })
    }
    selected.add(domain)
  }
  return selected
}

function normalizeQuery(query: string, maxBytes: number): string {
  requirePositiveLimit(maxBytes, MAX_QUERY_BYTES, 'search_query_limit')
  if (typeof query !== 'string') throw new LocalDataError('invalid_record', 'Search query must be a string', { reason: 'search_query' })
  const normalized = query.trim().toLocaleLowerCase()
  const bytes = new TextEncoder().encode(normalized).byteLength
  if (normalized.length < 1 || bytes > maxBytes) {
    throw new LocalDataError('invalid_record', 'Search query must be non-empty and within the byte bound', { reason: 'search_query' })
  }
  return normalized
}

function conversationMetadata(record: ConversationRecord): string {
  return [record.id, record.profileId, record.localNodeId, record.archivedAtMs === null ? 'active' : 'archived'].join(' ')
}

function messageMetadata(record: ConversationMessageRecord): string {
  return [record.id, record.conversationId, String(record.sequence), record.role, record.status].join(' ')
}

function memoryMetadata(record: LightweightMemoryRecord): string {
  return [record.id, record.namespace, record.sourceType, record.sourceId, record.expiresAtMs === null ? 'retained' : 'expires'].filter((value) => value !== null).join(' ')
}

function addMetadataResult(
  results: LocalDataSearchResult[],
  query: string,
  metadata: string,
  base: Omit<LocalDataSearchResult, 'matchField' | 'matchedTextPreview' | 'historyBoundary'>
): void {
  if (!metadata.toLocaleLowerCase().includes(query)) return
  results.push({
    ...base,
    matchField: 'metadata',
    matchedTextPreview: boundedPreview(metadata),
    historyBoundary: localDataHistoryBoundary()
  })
}

async function addDecryptedResult(
  crypto: EnvelopeCryptoPort | undefined,
  summary: LocalDataSearchSummary,
  results: LocalDataSearchResult[],
  query: string,
  maxDecryptedRecordBytes: number,
  maxTotalDecryptedBytes: number,
  input: Omit<LocalDataSearchResult, 'matchField' | 'matchedTextPreview' | 'historyBoundary'> & {
    readonly envelope: Parameters<EnvelopeCryptoPort['decrypt']>[0]
    readonly aad: Uint8Array
    readonly signal: AbortSignal | undefined
  }
): Promise<void> {
  if (crypto === undefined) return
  throwIfAborted(input.signal)
  const plaintext = await crypto.decrypt(input.envelope, input.aad)
  throwIfAborted(input.signal)
  if (plaintext.byteLength > maxDecryptedRecordBytes) {
    throw new LocalDataError('invalid_record', 'Decrypted record exceeds local search byte bound', { reason: 'search_decrypted_record_bytes' })
  }
  if (summary.decryptedBytes + plaintext.byteLength > maxTotalDecryptedBytes) {
    throw new LocalDataError('invalid_record', 'Decrypted search scan exceeds total byte bound', { reason: 'search_decrypted_total_bytes' })
  }
  summary.decryptedRecords += 1
  summary.decryptedBytes += plaintext.byteLength
  const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  if (!text.toLocaleLowerCase().includes(query)) return
  results.push({
    ...input,
    matchField: 'decrypted_content',
    matchedTextPreview: boundedPreview(text),
    historyBoundary: localDataHistoryBoundary()
  })
}

function boundedPreview(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= MAX_HIGHLIGHT_BYTES) return value
  return new TextDecoder().decode(bytes.slice(0, MAX_HIGHLIGHT_BYTES))
}

function compareResults(a: LocalDataSearchResult, b: LocalDataSearchResult): number {
  return compareUtf8(a.domain, b.domain) || compareUtf8(a.namespace ?? '', b.namespace ?? '') || compareUtf8(a.conversationId ?? '', b.conversationId ?? '') || (a.sequence ?? -1) - (b.sequence ?? -1) || compareUtf8(a.id, b.id) || compareUtf8(a.matchField, b.matchField)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Local data search cancelled', 'AbortError')
  }
}
