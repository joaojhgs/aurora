import { LocalDataError } from './backend.js'
import { compareUtf8 } from './export-v1.js'
import {
  parseLightweightMemoryRecord,
  localDataIdSchema,
  type LightweightMemoryRecord
} from './records.zod.js'
import type { LocalDataSession } from './session.js'
import { parseLocalDataBoundary } from './validation.js'
import {
  assertNoImplicitPythonHistoryMerge,
  assertScopeIdentity,
  buildMemoryProvenance,
  isExpiredAt,
  parseLocalDataProvenanceInput,
  parseLocalDataScope,
  requireEpochMs,
  requirePositiveLimit,
  type LocalDataProvenance,
  type LocalDataScope
} from './provenance.js'

const MAX_MEMORY_LIST_LIMIT = 1_000
const MAX_EXPIRED_DELETE_LIMIT = 1_000

export interface LocalMemoryItem {
  readonly record: LightweightMemoryRecord
  readonly provenance: LocalDataProvenance
}

export interface LocalMemoryListOptions {
  readonly scope: LocalDataScope
  readonly namespace?: string
  readonly nowMs: number
  readonly includeExpired?: boolean
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface UpsertLocalMemoryItemInput {
  readonly scope: LocalDataScope
  readonly record: LightweightMemoryRecord
  readonly signal?: AbortSignal
}

export interface DeleteLocalMemoryItemInput {
  readonly scope: LocalDataScope
  readonly memoryItemId: string
  readonly signal?: AbortSignal
}

export interface DeleteExpiredLocalMemoryInput {
  readonly scope: LocalDataScope
  readonly nowMs: number
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface LocalMemoryDeleteResult {
  readonly deleted: boolean
}

export interface LocalMemoryCleanupResult {
  readonly deleted: number
}

export interface LocalLightweightMemoryFacade {
  listMemoryItems(options: LocalMemoryListOptions): Promise<LocalMemoryItem[]>
  upsertMemoryItem(input: UpsertLocalMemoryItemInput): Promise<void>
  deleteMemoryItem(input: DeleteLocalMemoryItemInput): Promise<LocalMemoryDeleteResult>
  deleteExpiredMemoryItems(input: DeleteExpiredLocalMemoryInput): Promise<LocalMemoryCleanupResult>
}

export function createLocalLightweightMemory(session: LocalDataSession): LocalLightweightMemoryFacade {
  return new SessionLocalLightweightMemoryFacade(session)
}

class SessionLocalLightweightMemoryFacade implements LocalLightweightMemoryFacade {
  constructor(private readonly session: LocalDataSession) {}

  async listMemoryItems(options: LocalMemoryListOptions): Promise<LocalMemoryItem[]> {
    assertNoImplicitPythonHistoryMerge(options)
    const scope = this.parseScope(options.scope)
    throwIfAborted(options.signal)
    const namespace = options.namespace === undefined
      ? undefined
      : parseLocalDataBoundary(localDataIdSchema, options.namespace, 'local_data.memory_namespace')
    const nowMs = requireEpochMs(options.nowMs, 'memory_now_ms')
    const limit = requirePositiveLimit(options.limit ?? 200, MAX_MEMORY_LIST_LIMIT, 'memory_list_limit')
    const records = await this.session.memory.listMemoryItems(namespace)
    throwIfAborted(options.signal)
    return records
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .filter((record) => options.includeExpired === true || !isExpiredAt(record, nowMs))
      .sort(compareMemoryItems)
      .slice(0, limit)
      .map((record) => ({
        record,
        provenance: buildMemoryProvenance(record)
      }))
  }

  async upsertMemoryItem(input: UpsertLocalMemoryItemInput): Promise<void> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const record = parseLightweightMemoryRecord(input.record)
    assertScopeIdentity(record, scope)
    parseLocalDataProvenanceInput({
      namespace: record.namespace,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      expiresAtMs: record.expiresAtMs
    })
    await this.session.memory.upsertMemoryItem(record)
  }

  async deleteMemoryItem(input: DeleteLocalMemoryItemInput): Promise<LocalMemoryDeleteResult> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const id = parseLocalDataBoundary(localDataIdSchema, input.memoryItemId, 'local_data.memory_id')
    const existing = (await this.session.memory.listMemoryItems()).find((record) => record.id === id)
    throwIfAborted(input.signal)
    if (existing === undefined) return { deleted: false }
    assertScopeIdentity(existing, scope)
    return await this.session.memory.deleteMemoryItem(id)
  }

  async deleteExpiredMemoryItems(input: DeleteExpiredLocalMemoryInput): Promise<LocalMemoryCleanupResult> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const nowMs = requireEpochMs(input.nowMs, 'memory_cleanup_now_ms')
    const limit = requirePositiveLimit(input.limit, MAX_EXPIRED_DELETE_LIMIT, 'memory_cleanup_limit')
    const before = await this.session.memory.listMemoryItems()
    throwIfAborted(input.signal)
    if (before.some((record) => (record.profileId !== scope.profileId || record.localNodeId !== scope.localNodeId) && isExpiredAt(record, nowMs))) {
      throw new LocalDataError('identity_mismatch', 'Repository contains expired records outside the requested cleanup scope')
    }
    return await this.session.memory.deleteExpiredMemoryItems(nowMs, limit)
  }

  private parseScope(scope: LocalDataScope): LocalDataScope {
    const parsed = parseLocalDataScope(scope)
    assertScopeIdentity(this.session, parsed)
    return parsed
  }
}

function compareMemoryItems(a: LightweightMemoryRecord, b: LightweightMemoryRecord): number {
  return compareUtf8(a.namespace, b.namespace) || b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Local memory operation cancelled', 'AbortError')
  }
}
