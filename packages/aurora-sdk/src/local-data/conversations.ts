import { LocalDataError } from './backend.js'
import type { LocalDataSession } from './session.js'
import { compareUtf8 } from './export-v1.js'
import {
  parseConversationMessageRecord,
  parseConversationRecord,
  type ConversationMessageRecord,
  type ConversationRecord
} from './records.zod.js'
import {
  assertNoImplicitPythonHistoryMerge,
  assertScopeIdentity,
  localDataHistoryBoundary,
  parseLocalDataScope,
  requireEpochMs,
  requirePositiveLimit,
  type LocalDataHistoryBoundary,
  type LocalDataScope
} from './provenance.js'
import type { ConversationCursor, MessageListDirection } from './repositories.js'

const MAX_CONVERSATION_LIMIT = 500
const MAX_MESSAGE_LIMIT = 2_000
const CONVERSATION_PROBE_LIMIT = MAX_CONVERSATION_LIMIT + 1
const MESSAGE_PROBE_LIMIT = MAX_MESSAGE_LIMIT + 1

export interface LocalConversationSummary {
  readonly record: ConversationRecord
  readonly messageCount: number
  readonly historyBoundary: LocalDataHistoryBoundary
}

export interface LocalConversationListOptions {
  readonly scope: LocalDataScope
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly cursor?: ConversationCursor
  readonly signal?: AbortSignal
}

export interface LocalConversationMessagesOptions {
  readonly scope: LocalDataScope
  readonly conversationId: string
  readonly afterSequence?: number
  readonly beforeSequence?: number
  readonly direction?: MessageListDirection
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface ArchiveLocalConversationInput {
  readonly scope: LocalDataScope
  readonly conversationId: string
  readonly archivedAtMs: number
  readonly signal?: AbortSignal
}

export interface UpsertLocalConversationInput {
  readonly scope: LocalDataScope
  readonly record: ConversationRecord
  readonly signal?: AbortSignal
}

export interface AppendLocalConversationMessageInput {
  readonly scope: LocalDataScope
  readonly record: ConversationMessageRecord
  readonly signal?: AbortSignal
}

export interface LocalConversationDeleteInput {
  readonly scope: LocalDataScope
  readonly conversationId: string
  readonly signal?: AbortSignal
}

export interface LocalConversationDeleteResult {
  readonly deleted: boolean
  readonly deletedMessages: number
}

export interface LocalConversationsFacade {
  listConversations(options: LocalConversationListOptions): Promise<LocalConversationSummary[]>
  listMessages(options: LocalConversationMessagesOptions): Promise<ConversationMessageRecord[]>
  listConversationsPage(options: LocalConversationListOptions): Promise<LocalConversationPage>
  listMessagesPage(options: LocalConversationMessagesOptions): Promise<LocalMessagesPage>
  upsertConversation(input: UpsertLocalConversationInput): Promise<void>
  appendMessage(input: AppendLocalConversationMessageInput): Promise<void>
  archiveConversation(input: ArchiveLocalConversationInput): Promise<ConversationRecord>
  deleteConversation(input: LocalConversationDeleteInput): Promise<LocalConversationDeleteResult>
}

export interface LocalConversationPage {
  readonly items: LocalConversationSummary[]
  readonly nextCursor: ConversationCursor | null
}

export interface LocalMessagesPage {
  readonly items: ConversationMessageRecord[]
  readonly nextCursor: LocalMessageCursor | null
}

export type LocalMessageCursor =
  | { readonly direction: 'asc'; readonly afterSequence: number }
  | { readonly direction: 'desc'; readonly beforeSequence: number }

export function createLocalConversations(session: LocalDataSession): LocalConversationsFacade {
  return new SessionLocalConversationsFacade(session)
}

class SessionLocalConversationsFacade implements LocalConversationsFacade {
  constructor(private readonly session: LocalDataSession) {}

  async listConversations(options: LocalConversationListOptions): Promise<LocalConversationSummary[]> {
    return (await this.listConversationsPage(options)).items
  }

  async listConversationsPage(options: LocalConversationListOptions): Promise<LocalConversationPage> {
    assertNoImplicitPythonHistoryMerge(options)
    const scope = this.parseScope(options.scope)
    throwIfAborted(options.signal)
    const limit = requirePositiveLimit(options.limit ?? 100, MAX_CONVERSATION_LIMIT, 'conversation_limit')
    const records = await this.session.conversations.listConversations({
      limit: Math.min(limit + 1, CONVERSATION_PROBE_LIMIT),
      includeArchived: options.includeArchived === true,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor })
    })
    throwIfAborted(options.signal)
    const scoped = records
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .filter((record) => options.includeArchived === true || record.archivedAtMs === null)
      .sort(compareConversations)
    const hasMore = scoped.length > limit
    const items = scoped.slice(0, limit)
    const messageCounts = await this.session.conversations.listMessageCounts(items.map((record) => record.id))
    throwIfAborted(options.signal)
    return {
      items: items.map((record) => ({
      record,
      messageCount: messageCounts[record.id] ?? 0,
      historyBoundary: localDataHistoryBoundary()
      })),
      nextCursor: hasMore && items.length > 0 ? {
        updatedAtMs: items[items.length - 1]!.updatedAtMs,
        id: items[items.length - 1]!.id
      } : null
    }
  }

  async listMessages(options: LocalConversationMessagesOptions): Promise<ConversationMessageRecord[]> {
    return (await this.listMessagesPage({ ...options, direction: options.direction ?? 'asc' })).items
  }

  async listMessagesPage(options: LocalConversationMessagesOptions): Promise<LocalMessagesPage> {
    assertNoImplicitPythonHistoryMerge(options)
    const scope = this.parseScope(options.scope)
    throwIfAborted(options.signal)
    const conversation = await this.requireConversation(options.conversationId, scope)
    void conversation
    const limit = requirePositiveLimit(options.limit ?? 500, MAX_MESSAGE_LIMIT, 'message_limit')
    if (options.afterSequence !== undefined) requireEpochMs(options.afterSequence, 'message_after_sequence')
    if (options.beforeSequence !== undefined) requireEpochMs(options.beforeSequence, 'message_before_sequence')
    const direction = options.direction ?? 'desc'
    const messages = await this.session.conversations.listMessages(options.conversationId, {
      limit: Math.min(limit + 1, MESSAGE_PROBE_LIMIT),
      direction,
      ...(options.beforeSequence === undefined ? {} : { beforeSequence: options.beforeSequence }),
      ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence })
    })
    throwIfAborted(options.signal)
    const page = messages.slice(0, limit)
    const hasMore = messages.length > limit
    const items = direction === 'desc' ? [...page].reverse() : page
    return {
      items,
      nextCursor: hasMore && items.length > 0
        ? direction === 'desc'
          ? { direction, beforeSequence: items[0]!.sequence }
          : { direction, afterSequence: items[items.length - 1]!.sequence }
        : null
    }
  }

  async upsertConversation(input: UpsertLocalConversationInput): Promise<void> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const record = parseConversationRecord(input.record)
    assertScopeIdentity(record, scope)
    await this.session.conversations.upsertConversation(record)
  }

  async appendMessage(input: AppendLocalConversationMessageInput): Promise<void> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const record = parseConversationMessageRecord(input.record)
    await this.requireConversation(record.conversationId, scope)
    throwIfAborted(input.signal)
    try {
      await this.session.conversations.appendMessage(record)
    } catch (error) {
      if (error instanceof LocalDataError && error.code === 'invalid_record' && error.metadata?.reason === 'duplicate_message_id') {
        throw new LocalDataError('invalid_record', 'Message IDs must be unique within scoped local history', { reason: 'duplicate_message_id' })
      }
      throw error
    }
  }

  async archiveConversation(input: ArchiveLocalConversationInput): Promise<ConversationRecord> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    const archivedAtMs = requireEpochMs(input.archivedAtMs, 'conversation_archived_at')
    const conversation = await this.requireConversation(input.conversationId, scope)
    const archived = parseConversationRecord({
      ...conversation,
      archivedAtMs,
      updatedAtMs: Math.max(conversation.updatedAtMs, archivedAtMs)
    })
    await this.session.conversations.upsertConversation(archived)
    return archived
  }

  async deleteConversation(input: LocalConversationDeleteInput): Promise<LocalConversationDeleteResult> {
    assertNoImplicitPythonHistoryMerge(input)
    const scope = this.parseScope(input.scope)
    throwIfAborted(input.signal)
    await this.requireConversation(input.conversationId, scope)
    return await this.session.conversations.deleteConversation(input.conversationId)
  }

  private parseScope(scope: LocalDataScope): LocalDataScope {
    const parsed = parseLocalDataScope(scope)
    assertScopeIdentity(this.session, parsed)
    return parsed
  }

  private async requireConversation(conversationId: string, scope: LocalDataScope): Promise<ConversationRecord> {
    const conversation = await this.session.conversations.getConversation(conversationId)
    if (conversation === null) {
      throw new LocalDataError('invalid_record', 'Conversation does not exist in local history', { reason: 'conversation_missing' })
    }
    assertScopeIdentity(conversation, scope)
    return conversation
  }
}

function compareConversations(a: ConversationRecord, b: ConversationRecord): number {
  return b.updatedAtMs - a.updatedAtMs || compareUtf8(a.id, b.id)
}

function compareMessages(a: ConversationMessageRecord, b: ConversationMessageRecord): number {
  return compareUtf8(a.conversationId, b.conversationId) || a.sequence - b.sequence || compareUtf8(a.id, b.id)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Local conversation operation cancelled', 'AbortError')
  }
}
