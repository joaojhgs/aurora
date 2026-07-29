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

const MAX_CONVERSATION_LIMIT = 500
const MAX_MESSAGE_LIMIT = 2_000

export interface LocalConversationSummary {
  readonly record: ConversationRecord
  readonly messageCount: number
  readonly historyBoundary: LocalDataHistoryBoundary
}

export interface LocalConversationListOptions {
  readonly scope: LocalDataScope
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface LocalConversationMessagesOptions {
  readonly scope: LocalDataScope
  readonly conversationId: string
  readonly afterSequence?: number
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
  upsertConversation(input: UpsertLocalConversationInput): Promise<void>
  appendMessage(input: AppendLocalConversationMessageInput): Promise<void>
  archiveConversation(input: ArchiveLocalConversationInput): Promise<ConversationRecord>
  deleteConversation(input: LocalConversationDeleteInput): Promise<LocalConversationDeleteResult>
}

export function createLocalConversations(session: LocalDataSession): LocalConversationsFacade {
  return new SessionLocalConversationsFacade(session)
}

class SessionLocalConversationsFacade implements LocalConversationsFacade {
  constructor(private readonly session: LocalDataSession) {}

  async listConversations(options: LocalConversationListOptions): Promise<LocalConversationSummary[]> {
    assertNoImplicitPythonHistoryMerge(options)
    const scope = this.parseScope(options.scope)
    throwIfAborted(options.signal)
    const limit = requirePositiveLimit(options.limit ?? 100, MAX_CONVERSATION_LIMIT, 'conversation_limit')
    const records = await this.session.conversations.listConversations()
    throwIfAborted(options.signal)
    const scoped = records
      .filter((record) => record.profileId === scope.profileId && record.localNodeId === scope.localNodeId)
      .filter((record) => options.includeArchived === true || record.archivedAtMs === null)
      .sort(compareConversations)
      .slice(0, limit)
    return await Promise.all(scoped.map(async (record) => ({
      record,
      messageCount: (await this.session.conversations.listMessages(record.id)).length,
      historyBoundary: localDataHistoryBoundary()
    })))
  }

  async listMessages(options: LocalConversationMessagesOptions): Promise<ConversationMessageRecord[]> {
    assertNoImplicitPythonHistoryMerge(options)
    const scope = this.parseScope(options.scope)
    throwIfAborted(options.signal)
    const conversation = await this.requireConversation(options.conversationId, scope)
    void conversation
    const limit = requirePositiveLimit(options.limit ?? 500, MAX_MESSAGE_LIMIT, 'message_limit')
    const afterSequence = options.afterSequence === undefined
      ? undefined
      : requireEpochMs(options.afterSequence, 'message_after_sequence')
    const messages = await this.session.conversations.listMessages(options.conversationId)
    throwIfAborted(options.signal)
    return messages
      .filter((record) => afterSequence === undefined || record.sequence > afterSequence)
      .sort(compareMessages)
      .slice(0, limit)
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
    const existing = await this.session.conversations.listMessages(record.conversationId)
    throwIfAborted(input.signal)
    if (existing.some((message) => message.id === record.id)) {
      throw new LocalDataError('invalid_record', 'Message IDs must be unique within local history', { reason: 'duplicate_message_id' })
    }
    if (existing.some((message) => message.sequence === record.sequence)) {
      throw new LocalDataError('invalid_record', 'Message sequence must be unique within a conversation', { reason: 'duplicate_message_sequence' })
    }
    await this.session.conversations.appendMessage(record)
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
    const conversations = await this.session.conversations.listConversations()
    const conversation = conversations.find((record) => record.id === conversationId)
    if (conversation === undefined) {
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
