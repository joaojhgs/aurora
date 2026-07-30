'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppendLocalConversationMessageInput,
  ArchiveLocalConversationInput,
  ConversationMessageRecord,
  ConversationRecord,
  LocalConversationSummary,
  UpsertLocalConversationInput
} from '@aurora/client/local-data'

import { localDataProductError, useLocalData } from './local-data-provider.js'

export interface UseLocalConversationsOptions {
  readonly includeArchived?: boolean | undefined
  readonly selectedConversationId?: string | null | undefined
  readonly limit?: number | undefined
  readonly messageLimit?: number | undefined
  readonly autoRefresh?: boolean | undefined
}

export interface UseLocalConversationsResult {
  readonly loading: boolean
  readonly ready: boolean
  readonly error: string | null
  readonly summaries: LocalConversationSummary[]
  readonly messagesByConversation: ReadonlyMap<string, ConversationMessageRecord[]>
  readonly selectedConversationId: string | null
  readonly refresh: () => Promise<void>
  readonly upsertConversation: (record: ConversationRecord) => Promise<void>
  readonly appendMessage: (record: ConversationMessageRecord) => Promise<void>
  readonly archiveConversation: (conversationId: string, archivedAtMs?: number) => Promise<void>
  readonly deleteConversation: (conversationId: string) => Promise<void>
}

interface ConversationsState {
  readonly loading: boolean
  readonly error: string | null
  readonly summaries: LocalConversationSummary[]
  readonly messagesByConversation: ReadonlyMap<string, ConversationMessageRecord[]>
}

const emptyMessages = new Map<string, ConversationMessageRecord[]>()

export function useLocalConversations(options: UseLocalConversationsOptions = {}): UseLocalConversationsResult {
  const localData = useLocalData()
  const requestId = useRef(0)
  const includeArchived = options.includeArchived === true
  const limit = options.limit ?? 100
  const messageLimit = options.messageLimit ?? 500
  const [state, setState] = useState<ConversationsState>(() => ({
    loading: localData.state === 'opening',
    error: null,
    summaries: [],
    messagesByConversation: emptyMessages
  }))

  const selectedConversationId = useMemo(() => {
    if (options.selectedConversationId) return options.selectedConversationId
    return state.summaries[0]?.record.id ?? null
  }, [options.selectedConversationId, state.summaries])

  const refresh = useCallback(async () => {
    const conversations = localData.conversations
    if (localData.state !== 'ready' || conversations === null) {
      setState((current) => ({
        ...current,
        loading: localData.state === 'opening',
        error: localData.error?.title ?? null,
        summaries: [],
        messagesByConversation: emptyMessages
      }))
      return
    }

    const abortController = new AbortController()
    const activeRequest = requestId.current + 1
    requestId.current = activeRequest
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const summaries = await conversations.listConversations({
        scope: localData.scope,
        includeArchived,
        limit,
        signal: abortController.signal
      })
      const pairs = await Promise.all(summaries.map(async (summary) => [
        summary.record.id,
        await conversations.listMessages({
          scope: localData.scope,
          conversationId: summary.record.id,
          limit: messageLimit,
          signal: abortController.signal
        })
      ] as const))
      if (requestId.current !== activeRequest) return
      setState({
        loading: false,
        error: null,
        summaries,
        messagesByConversation: new Map(pairs)
      })
    } catch (error) {
      if (requestId.current !== activeRequest || isAbortError(error)) return
      setState((current) => ({
        ...current,
        loading: false,
        error: localDataProductError(error).title
      }))
    }
  }, [localData, includeArchived, limit, messageLimit])

  useEffect(() => {
    if (options.autoRefresh === false) return
    void refresh()
    return () => {
      requestId.current += 1
    }
  }, [refresh, options.autoRefresh])

  const mutate = useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    const activeRequest = requestId.current + 1
    requestId.current = activeRequest
    const abortController = new AbortController()
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      await work(abortController.signal)
      if (requestId.current !== activeRequest) return
      await refresh()
    } catch (error) {
      if (requestId.current !== activeRequest || isAbortError(error)) return
      setState((current) => ({ ...current, loading: false, error: localDataProductError(error).title }))
    }
  }, [refresh])

  return {
    loading: state.loading,
    ready: localData.state === 'ready',
    error: state.error,
    summaries: state.summaries,
    messagesByConversation: state.messagesByConversation,
    selectedConversationId,
    refresh,
    upsertConversation: async (record) => {
      const conversations = requireConversations(localData)
      await mutate(async (signal) => {
        const input: UpsertLocalConversationInput = { scope: localData.scope, record, signal }
        await conversations.upsertConversation(input)
      })
    },
    appendMessage: async (record) => {
      const conversations = requireConversations(localData)
      await mutate(async (signal) => {
        const input: AppendLocalConversationMessageInput = { scope: localData.scope, record, signal }
        await conversations.appendMessage(input)
      })
    },
    archiveConversation: async (conversationId, archivedAtMs = Date.now()) => {
      const conversations = requireConversations(localData)
      await mutate(async (signal) => {
        const input: ArchiveLocalConversationInput = { scope: localData.scope, conversationId, archivedAtMs, signal }
        await conversations.archiveConversation(input)
      })
    },
    deleteConversation: async (conversationId) => {
      const conversations = requireConversations(localData)
      await mutate(async (signal) => {
        await conversations.deleteConversation({ scope: localData.scope, conversationId, signal })
      })
    }
  }
}

function requireConversations(localData: ReturnType<typeof useLocalData>) {
  if (localData.conversations === null) throw new Error('This device history is unavailable.')
  return localData.conversations
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError'
}
