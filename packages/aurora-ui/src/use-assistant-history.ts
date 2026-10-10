import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AuthSessionSnapshot, AuroraClient, AuroraError, DBSessionRecord } from '@aurora/client'
import type { AssistantConversationRow, AssistantSessionSnapshot } from './assistant-view'
import {
  assistantSessionFromPersisted,
  defaultAssistantSessionForTransport,
  emptyAssistantSession,
  loadAssistantSession,
  persistAssistantSession,
  sortSessionsByModification,
  upsertSessionByModification,
} from './assistant-session-persistence'
import { preserveActiveAssistantTurn, updateLocalConversationRowTitle } from './assistant-history-model'
import {
  activateLocalAssistantConversation,
  loadLocalAssistantConversationMessages,
  loadLocalAssistantConversationRows,
  loadLocalAssistantConversationMessagesPage,
  loadLocalAssistantConversationRowsPage,
  loadLocalAssistantConversationRow,
  assistantMessagesFromLocalRecords,
  mergeLocalAssistantMessageRecords,
} from './assistant-history-loaders'
import type { ConversationCursor, ConversationMessageRecord, LocalMessageCursor } from '@aurora/client/local-data'
import { useAuroraQueryKeys, useConversations } from './query-hooks'
import type { LocalAssistantHistoryDependencies } from './assistant-history-persistence'

export {
  assistantConversationRows,
  enrichLatestLocalAssistantMessage,
  preserveActiveAssistantTurnIds,
  updateLocalConversationRowTitle
} from './assistant-history-model'
export {
  activateLocalAssistantConversation,
  loadLocalAssistantConversationMessages,
  loadLocalAssistantConversationRows,
  loadLocalAssistantConversationMessagesPage,
  loadLocalAssistantConversationRowsPage,
  assistantMessagesFromLocalRecords
} from './assistant-history-loaders'
export {
  persistConnectedAssistantTurnToLocalHistory,
  persistLatestLocalAssistantRuntime,
  resolveLocalAssistantHistoryDependencies
} from './assistant-history-persistence'
export type { LocalAssistantHistoryDependencies } from './assistant-history-persistence'

interface UseAssistantHistoryOptions {
  readonly client: AuroraClient
  readonly initialSession: AssistantSessionSnapshot | undefined
  readonly storageKey: string
  readonly localHistory: LocalAssistantHistoryDependencies | null
  readonly supportsPersistedSessions: boolean
  readonly usesLocalConversationHistory: boolean
  readonly resetConversationUi: (nextSession: AssistantSessionSnapshot) => void
  readonly textAreaRef: MutableRefObject<HTMLTextAreaElement | null>
  readonly setLastError: Dispatch<SetStateAction<string | null>>
  readonly productAssistantErrorCopy: (error: AuroraError | Error) => string
}

export interface AssistantHistoryController {
  readonly session: AssistantSessionSnapshot
  readonly setSession: Dispatch<SetStateAction<AssistantSessionSnapshot>>
  readonly sessionRef: MutableRefObject<AssistantSessionSnapshot>
  readonly sessionIndex: DBSessionRecord[]
  readonly setSessionIndex: Dispatch<SetStateAction<DBSessionRecord[]>>
  readonly localConversationRows: AssistantConversationRow[]
  readonly setLocalConversationRows: Dispatch<SetStateAction<AssistantConversationRow[]>>
  readonly localConversationCursor: ConversationCursor | null
  readonly localConversationPageLoading: boolean
  readonly localMessageCursor: LocalMessageCursor | null
  readonly localMessagePageLoading: boolean
  readonly localConversationPageError: string | null
  readonly localMessagePageError: string | null
  readonly localHistoryScopeKey: string
  readonly sessionIndexLoading: boolean
  readonly setSessionIndexLoading: Dispatch<SetStateAction<boolean>>
  readonly sessionIndexError: string | null
  readonly setSessionIndexError: Dispatch<SetStateAction<string | null>>
  readonly mobileHistoryOpen: boolean
  readonly setMobileHistoryOpen: Dispatch<SetStateAction<boolean>>
  readonly sessionAuthScope: string
  readonly openPersistedSession: (sessionId: string, activate?: boolean) => Promise<void>
  readonly openLocalSession: (sessionId: string) => Promise<void>
  readonly refreshPersistedSessionIndex: () => Promise<void>
  readonly refreshLocalSessionIndex: (conversationId?: string) => Promise<void>
  readonly loadMoreLocalSessions: () => Promise<void>
  readonly loadOlderLocalMessages: () => Promise<void>
  readonly createPersistedChatSession: () => Promise<DBSessionRecord | null>
}

export function useAssistantHistory({
  client,
  initialSession,
  storageKey,
  localHistory,
  supportsPersistedSessions,
  usesLocalConversationHistory,
  resetConversationUi,
  textAreaRef,
  setLastError,
  productAssistantErrorCopy,
}: UseAssistantHistoryOptions): AssistantHistoryController {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => initialSession ?? defaultAssistantSessionForTransport(client.transport.kind))
  const sessionRef = useRef(session)
  const [sessionIndex, setSessionIndex] = useState<DBSessionRecord[]>([])
  const [localConversationRows, setLocalConversationRows] = useState<AssistantConversationRow[]>([])
  const [localConversationCursor, setLocalConversationCursor] = useState<ConversationCursor | null>(null)
  const [localConversationPageLoading, setLocalConversationPageLoading] = useState(false)
  const [localMessageCursor, setLocalMessageCursor] = useState<LocalMessageCursor | null>(null)
  const [localMessagePageLoading, setLocalMessagePageLoading] = useState(false)
  const [localConversationPageError, setLocalConversationPageError] = useState<string | null>(null)
  const [localMessagePageError, setLocalMessagePageError] = useState<string | null>(null)
  const localMessageRecordsRef = useRef<ConversationMessageRecord[]>([])
  const localMessageConversationIdRef = useRef<string | null>(null)
  const localPageFlightsRef = useRef(new Set<string>())
  const [sessionIndexLoading, setSessionIndexLoading] = useState(false)
  const [sessionIndexError, setSessionIndexError] = useState<string | null>(null)
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false)
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const [sessionAuthScope, setSessionAuthScope] = useState(() => assistantAuthScope(client.auth.snapshot()))
  const [localHistoryScopeGeneration, setLocalHistoryScopeGeneration] = useState(0)
  const sessionAuthScopeRef = useRef(sessionAuthScope)
  const sessionLoadGenerationRef = useRef(0)
  const resetConversationUiRef = useRef(resetConversationUi)
  const productAssistantErrorCopyRef = useRef(productAssistantErrorCopy)
  const localHistoryRef = useRef(localHistory)
  const latestLocalOpenSessionIdRef = useRef<string | null>(null)
  const persistedActivationAbortRef = useRef<AbortController | null>(null)
  const persistedActivationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const localActivationQueueRef = useRef<Promise<void>>(Promise.resolve())

  const isCurrentSessionLoadGeneration = (generation: number): boolean => sessionLoadGenerationRef.current === generation
  const isCurrentPersistedSelection = (generation: number, scope: string): boolean => isCurrentSessionLoadGeneration(generation) && sessionAuthScopeRef.current === scope
  const persistedSessionsEnabled = supportsPersistedSessions && !usesLocalConversationHistory && client.transport.kind !== 'mock'
  const persistedConversationScope = useMemo(() => persistedConversationScopeForAuth(sessionAuthScope), [sessionAuthScope])
  const persistedSessionsQuery = useConversations<PersistedConversationListResult>(
    persistedConversationScope,
    (auroraClient, signal) => loadPersistedConversationList(auroraClient, signal),
    { enabled: persistedSessionsEnabled }
  )

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    localHistoryRef.current = localHistory
  }, [localHistory])

  useEffect(() => () => {
    invalidateSessionLoads()
  }, [])

  useEffect(() => {
    resetConversationUiRef.current = resetConversationUi
    productAssistantErrorCopyRef.current = productAssistantErrorCopy
  }, [productAssistantErrorCopy, resetConversationUi])

  useEffect(() => {
    return client.auth.subscribe((auth) => {
      const nextScope = assistantAuthScope(auth)
      if (sessionAuthScopeRef.current === nextScope) return
      sessionAuthScopeRef.current = nextScope
      if (supportsPersistedSessions || usesLocalConversationHistory) {
        invalidateSessionLoads()
        resetConversationUiRef.current(emptyAssistantSession())
        setSessionIndex([])
        setLocalConversationRows([])
        setLocalConversationCursor(null)
        setLocalMessageCursor(null)
        setSessionIndexError(null)
        setSessionIndexLoading(true)
      }
      setSessionAuthScope(nextScope)
    })
  }, [client, supportsPersistedSessions, usesLocalConversationHistory])

  useEffect(() => {
    if (usesLocalConversationHistory && localHistory) {
      const generation = beginSessionLoad()
      setSessionIndex([])
      setLocalConversationRows([])
      setLocalConversationCursor(null)
      setLocalMessageCursor(null)
      void initializeLocalSessions(generation, localHistory)
      return
    }
    if (client.transport.kind === 'mock') {
      const stored = loadAssistantSession(storageKey)
      const nextSession = initialSession ?? (stored.sessionId || stored.messages.length > 0 ? stored : defaultAssistantSessionForTransport(client.transport.kind))
      setSession(nextSession)
      setSessionIndex([])
      setLocalConversationRows([])
      setLocalConversationCursor(null)
      setLocalMessageCursor(null)
      setSessionIndexLoading(false)
      setSessionIndexError(null)
      return
    }
    if (!supportsPersistedSessions) {
      setSession(emptyAssistantSession())
      setSessionIndex([])
      setLocalConversationRows([])
      setLocalConversationCursor(null)
      setLocalMessageCursor(null)
      setSessionIndexLoading(false)
      setSessionIndexError('Saved chats are unavailable for this connection.')
      return
    }

    const generation = beginSessionLoad()
    setSession(emptyAssistantSession())
    setSessionIndex([])
    setLocalConversationRows([])
    setLocalConversationCursor(null)
    setLocalMessageCursor(null)
    setSessionIndexError(null)
    setSessionIndexLoading(true)
    void initializePersistedSessions(generation)
  }, [client, client.transport.kind, initialSession, localHistory, sessionAuthScope, storageKey, supportsPersistedSessions, usesLocalConversationHistory])

  useEffect(() => {
    if (client.transport.kind !== 'mock') return
    persistAssistantSession(storageKey, session)
  }, [client.transport.kind, session, storageKey])

  useEffect(() => {
    if (!persistedSessionsEnabled) return
    if (!persistedSessionsQuery.data) return
    setSessionIndex(persistedSessionsQuery.data.sessions)
    setSessionIndexError(null)
  }, [persistedSessionsEnabled, persistedSessionsQuery.data])

  useEffect(() => {
    if (!persistedSessionsEnabled) return
    const error = persistedSessionsQuery.error
    if (!error) return
    setSessionIndexError(productAssistantErrorCopyRef.current(error instanceof Error ? error : new Error(String(error))))
  }, [persistedSessionsEnabled, persistedSessionsQuery.error])

  function invalidateSessionLoads(): void {
    sessionLoadGenerationRef.current += 1
    setLocalHistoryScopeGeneration(sessionLoadGenerationRef.current)
    latestLocalOpenSessionIdRef.current = null
    persistedActivationAbortRef.current?.abort()
    persistedActivationAbortRef.current = null
    localPageFlightsRef.current.clear()
    setLocalConversationPageError(null)
    setLocalMessagePageError(null)
    setLocalConversationPageLoading(false)
    setLocalMessagePageLoading(false)
  }

  function beginSessionLoad(): number {
    invalidateSessionLoads()
    return sessionLoadGenerationRef.current
  }

  function isCurrentLocalSelection(
    generation: number,
    history: LocalAssistantHistoryDependencies,
    sessionId: string,
  ): boolean {
    return isCurrentSessionLoadGeneration(generation)
      && localHistoryRef.current === history
      && latestLocalOpenSessionIdRef.current === sessionId
  }

  async function activatePersistedSession(sessionId: string, generation: number, authScope: string): Promise<void> {
    persistedActivationAbortRef.current?.abort()
    const controller = new AbortController()
    persistedActivationAbortRef.current = controller
    const activation = persistedActivationQueueRef.current.catch(() => undefined).then(async () => {
      if (!isCurrentPersistedSelection(generation, authScope) || controller.signal.aborted) return
      const activated = await client.memory.setActiveSession({ session_id: sessionId }, { signal: controller.signal })
      if (!activated.ok) throw activated.error
    })
    persistedActivationQueueRef.current = activation.catch(() => undefined)
    try {
      await activation
    } finally {
      if (persistedActivationAbortRef.current === controller) persistedActivationAbortRef.current = null
    }
  }

  async function activateLocalSessionForSelection(
    history: LocalAssistantHistoryDependencies,
    sessionId: string,
    generation: number,
  ): Promise<boolean> {
    const activation = localActivationQueueRef.current.catch(() => undefined).then(async () => {
      if (!isCurrentLocalSelection(generation, history, sessionId)) return false
      await activateLocalAssistantConversation(history, sessionId)
      return isCurrentLocalSelection(generation, history, sessionId)
    })
    localActivationQueueRef.current = activation.then(() => undefined, () => undefined)
    return await activation
  }

  async function initializePersistedSessions(generation: number) {
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    const authScope = sessionAuthScopeRef.current
    const listQueryKey = queryKeys.conversations(persistedConversationScopeForAuth(authScope))
    try {
      const listed = await queryClient.fetchQuery({
        queryKey: listQueryKey,
        queryFn: ({ signal }) => loadPersistedConversationList(client, signal),
        staleTime: 0,
      })
      if (!isCurrentSessionLoadGeneration(generation)) return

      let sessions = listed.sessions
      let activeSessionId = listed.activeSessionId
      if (!activeSessionId) {
        const initialSessionQueryKey = [...listQueryKey, 'initial-session']
        const initialized = await queryClient.fetchQuery({
          queryKey: initialSessionQueryKey,
          queryFn: async ({ signal }) => {
            const cachedList = queryClient.getQueryData<PersistedConversationListResult>(listQueryKey)
            if (cachedList?.activeSessionId) return cachedList
            throwIfAborted(signal)
            const created = await client.memory.createSession({ type: 'chat' }, { signal })
            throwIfAborted(signal)
            if (!created.ok) throw created.error
            const nextList = {
              sessions: upsertSessionByModification(cachedList?.sessions ?? sessions, created.data.session),
              activeSessionId: created.data.session.id,
            }
            queryClient.setQueryData<PersistedConversationListResult>(listQueryKey, nextList)
            return nextList
          },
          staleTime: 0,
        }).finally(() => {
          queryClient.removeQueries({ queryKey: initialSessionQueryKey, exact: true })
        })
        if (!isCurrentSessionLoadGeneration(generation)) return
        sessions = initialized.sessions
        activeSessionId = initialized.activeSessionId
      } else {
        setSessionIndex(sessions)
      }

      if (!activeSessionId) {
        setSession(emptyAssistantSession())
        setSessionIndex(sessions)
        return
      }

      const loaded = await queryClient.fetchQuery({
        queryKey: queryKeys.conversation(activeSessionId),
        queryFn: ({ signal }) => loadPersistedConversation(client, activeSessionId, false, signal),
        staleTime: 0,
      })
      if (!isCurrentPersistedSelection(generation, authScope)) return
      await activatePersistedSession(activeSessionId, generation, authScope)
      if (!isCurrentPersistedSelection(generation, authScope)) return
      setSessionIndex((current) => upsertSessionByModification(current.length > 0 ? current : sessions, loaded.session.session))
      setSession(assistantSessionFromPersisted(loaded.session))
      setSessionIndexError(null)
    } catch (error) {
      if (!isCurrentSessionLoadGeneration(generation)) return
      setSessionIndex([])
      setSession(emptyAssistantSession())
      setSessionIndexError(productAssistantErrorCopyRef.current(error instanceof Error ? error : new Error(String(error))))
    } finally {
      if (isCurrentSessionLoadGeneration(generation)) setSessionIndexLoading(false)
    }
  }

  async function initializeLocalSessions(
    generation: number,
    history: LocalAssistantHistoryDependencies,
  ) {
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const firstPage = await loadLocalAssistantConversationRowsPage(history)
      if (!isCurrentSessionLoadGeneration(generation)) return
      const currentSessionId = sessionRef.current.sessionId
      const restoredConversation = currentSessionId
        ? await history.localData.conversations.getConversation(currentSessionId)
        : null
      const activeSessionId = restoredConversation
        && restoredConversation.profileId === history.scope.profileId
        && restoredConversation.localNodeId === history.scope.localNodeId
        && restoredConversation.archivedAtMs === null
        ? currentSessionId
        : firstPage.rows[0]?.id ?? null
      let initialRows = firstPage.rows
      if (restoredConversation && currentSessionId !== null && activeSessionId === currentSessionId && !firstPage.rows.some((row) => row.id === currentSessionId)) {
        const restoredRow = await loadLocalAssistantConversationRow(history, currentSessionId)
        if (restoredRow) initialRows = [restoredRow, ...firstPage.rows]
      }
      if (!isCurrentSessionLoadGeneration(generation)) return
      setLocalConversationRows(initialRows)
      setLocalConversationCursor(firstPage.nextCursor)
      if (activeSessionId) {
        const messagesPage = await loadLocalAssistantConversationMessagesPage(history, activeSessionId)
        const messages = messagesPage.messages
        if (!isCurrentSessionLoadGeneration(generation)) return
        setLocalConversationRows((current) => updateLocalConversationRowTitle(current, activeSessionId, messages))
        setLocalMessageCursor(messagesPage.nextCursor)
        localMessageRecordsRef.current = messagesPage.records
        localMessageConversationIdRef.current = activeSessionId
        setSession({ sessionId: activeSessionId, messages })
      } else {
        setSession(emptyAssistantSession())
      }
    } catch {
      if (!isCurrentSessionLoadGeneration(generation)) return
      setLocalConversationRows([])
      setLocalConversationCursor(null)
      localMessageRecordsRef.current = []
      localMessageConversationIdRef.current = null
      setSession(emptyAssistantSession())
      setSessionIndexError('Saved chats could not be opened. Your data was not changed.')
    } finally {
      if (isCurrentSessionLoadGeneration(generation)) {
        setSessionIndexLoading(false)
      }
    }
  }

  async function openPersistedSession(sessionId: string, activate = true) {
    if (!supportsPersistedSessions) return
    const generation = beginSessionLoad()
    const authScope = sessionAuthScopeRef.current
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const loaded = await queryClient.fetchQuery({
        queryKey: queryKeys.conversation(sessionId),
        queryFn: ({ signal }) => loadPersistedConversation(client, sessionId, false, signal),
        staleTime: 0,
      })
      if (!isCurrentPersistedSelection(generation, authScope)) return
      if (activate) {
        await activatePersistedSession(sessionId, generation, authScope)
        if (!isCurrentPersistedSelection(generation, authScope)) return
      }
      setSessionIndex((current) => upsertSessionByModification(current, loaded.session.session))
      resetConversationUi(assistantSessionFromPersisted(loaded.session))
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(persistedConversationScopeForAuth(sessionAuthScopeRef.current)) })
      window.setTimeout(() => {
        if (isCurrentSessionLoadGeneration(generation)) textAreaRef.current?.focus()
      }, 0)
    } catch (error) {
      if (!isCurrentSessionLoadGeneration(generation)) return
      setSessionIndexError(productAssistantErrorCopyRef.current(error instanceof Error ? error : new Error(String(error))))
    } finally {
      if (isCurrentSessionLoadGeneration(generation)) setSessionIndexLoading(false)
    }
  }

  async function openLocalSession(sessionId: string) {
    if (!localHistory) return
    const generation = beginSessionLoad()
    latestLocalOpenSessionIdRef.current = sessionId
    const history = localHistory
    localMessageRecordsRef.current = []
    localMessageConversationIdRef.current = null
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const messagesPage = await loadLocalAssistantConversationMessagesPage(history, sessionId)
      const messages = messagesPage.messages
      if (!isCurrentLocalSelection(generation, history, sessionId)) return
      const activated = await activateLocalSessionForSelection(history, sessionId, generation)
      if (!activated || !isCurrentLocalSelection(generation, history, sessionId)) return
      setLocalConversationRows((current) => updateLocalConversationRowTitle(current, sessionId, messages))
      setLocalMessageCursor(messagesPage.nextCursor)
      localMessageRecordsRef.current = messagesPage.records
      localMessageConversationIdRef.current = sessionId
      resetConversationUi({ sessionId, messages })
      setMobileHistoryOpen(false)
      window.setTimeout(() => {
        if (isCurrentSessionLoadGeneration(generation)) textAreaRef.current?.focus()
      }, 0)
    } catch {
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history) return
      setSessionIndexError('This chat could not be opened. Your saved data was not changed.')
    } finally {
      if (isCurrentSessionLoadGeneration(generation) && localHistoryRef.current === history) setSessionIndexLoading(false)
    }
  }

  async function refreshPersistedSessionIndex() {
    if (!supportsPersistedSessions) return
    const generation = sessionLoadGenerationRef.current
    try {
      const listed = await queryClient.fetchQuery({
        queryKey: queryKeys.conversations(persistedConversationScopeForAuth(sessionAuthScopeRef.current)),
        queryFn: ({ signal }) => loadPersistedConversationList(client, signal),
        staleTime: 0,
      })
      if (!isCurrentSessionLoadGeneration(generation)) return
      setSessionIndex(listed.sessions)
      setSessionIndexError(null)
    } catch (error) {
      if (!isCurrentSessionLoadGeneration(generation)) return
      setSessionIndexError(productAssistantErrorCopyRef.current(error instanceof Error ? error : new Error(String(error))))
    }
  }

  async function refreshLocalSessionIndex(conversationId?: string) {
    if (!localHistory) return
    const refreshSession = sessionRef.current
    const refreshMessages = refreshSession.messages
    const generation = sessionLoadGenerationRef.current
    const history = localHistory
    try {
      if (conversationId) {
        if (refreshSession.sessionId !== conversationId) return
        const page = await loadLocalAssistantConversationMessagesPage(history, conversationId)
        if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history) return
        const mergedRecords = mergeLocalAssistantMessageRecords(
          localMessageConversationIdRef.current === conversationId ? localMessageRecordsRef.current : [],
          page.records
        )
        const mergedMessages = await assistantMessagesFromLocalRecords(history, mergedRecords)
        if (
          !isCurrentSessionLoadGeneration(generation)
          || localHistoryRef.current !== history
          || sessionRef.current.sessionId !== conversationId
          || sessionRef.current.messages !== refreshMessages
        ) return
        const refreshedRow = await loadLocalAssistantConversationRow(history, conversationId)
        if (
          !isCurrentSessionLoadGeneration(generation)
          || localHistoryRef.current !== history
          || sessionRef.current.sessionId !== conversationId
          || sessionRef.current.messages !== refreshMessages
        ) return
        localMessageRecordsRef.current = mergedRecords
        localMessageConversationIdRef.current = conversationId
        setSession((current) => current.sessionId === conversationId
          && current.messages === refreshMessages
          ? { ...current, messages: preserveActiveAssistantTurn(mergedMessages, current.messages) }
          : current)
        setLocalConversationRows((current) => refreshedRow
          ? [refreshedRow, ...current.filter((row) => row.id !== conversationId)]
          : current.filter((row) => row.id !== conversationId))
        setSessionIndexError(null)
        return
      }
      const page = await loadLocalAssistantConversationRowsPage(history)
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history) return
      setLocalConversationRows(updateLocalConversationRowTitle(page.rows, sessionRef.current.sessionId, sessionRef.current.messages))
      setLocalConversationCursor(page.nextCursor)
      setSessionIndexError(null)
    } catch {
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history) return
      setSessionIndexError('Saved chats could not be refreshed. Your data was not changed.')
    }
  }

  async function loadMoreLocalSessions(): Promise<void> {
    if (!localHistory || localConversationCursor !== null && localConversationPageLoading) return
    if (!localConversationCursor) return
    const history = localHistory
    const generation = sessionLoadGenerationRef.current
    const flightKey = `conversations:${generation}:${history.scope.profileId}:${history.scope.localNodeId}:${JSON.stringify(localConversationCursor)}`
    if (localPageFlightsRef.current.has(flightKey)) return
    localPageFlightsRef.current.add(flightKey)
    setLocalConversationPageError(null)
    setLocalConversationPageLoading(true)
    try {
      const page = await loadLocalAssistantConversationRowsPage(history, localConversationCursor)
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history) return
      setLocalConversationRows((current) => {
        const currentIds = new Set(current.map((row) => row.id))
        const refreshedRows = current.map((row) => page.rows.find((incoming) => incoming.id === row.id) ?? row)
        return [...refreshedRows, ...page.rows.filter((row) => !currentIds.has(row.id))]
      })
      setLocalConversationCursor(page.nextCursor)
    } catch {
      if (isCurrentSessionLoadGeneration(generation) && localHistoryRef.current === history) setLocalConversationPageError('More saved chats could not be loaded.')
    } finally {
      localPageFlightsRef.current.delete(flightKey)
      if (isCurrentSessionLoadGeneration(generation) && localHistoryRef.current === history) setLocalConversationPageLoading(false)
    }
  }

  async function loadOlderLocalMessages(): Promise<void> {
    if (!localHistory || localMessagePageLoading || !localMessageCursor || localMessageCursor.direction !== 'desc') return
    const history = localHistory
    const conversationId = sessionRef.current.sessionId
    if (!conversationId) return
    const generation = sessionLoadGenerationRef.current
    const flightKey = `messages:${generation}:${history.scope.profileId}:${history.scope.localNodeId}:${conversationId}:${JSON.stringify(localMessageCursor)}`
    if (localPageFlightsRef.current.has(flightKey)) return
    localPageFlightsRef.current.add(flightKey)
    setLocalMessagePageError(null)
    setLocalMessagePageLoading(true)
    try {
      const page = await loadLocalAssistantConversationMessagesPage(history, conversationId, localMessageCursor)
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history || sessionRef.current.sessionId !== conversationId) return
      const mergedRecords = mergeLocalAssistantMessageRecords(
        localMessageConversationIdRef.current === conversationId ? localMessageRecordsRef.current : [],
        page.records
      )
      const mergedMessages = await assistantMessagesFromLocalRecords(history, mergedRecords)
      if (!isCurrentSessionLoadGeneration(generation) || localHistoryRef.current !== history || sessionRef.current.sessionId !== conversationId) return
      localMessageRecordsRef.current = mergedRecords
      localMessageConversationIdRef.current = conversationId
      setSession((current) => current.sessionId === conversationId
        ? { ...current, messages: mergedMessages }
        : current)
      setLocalMessageCursor(page.nextCursor)
    } catch {
      if (isCurrentSessionLoadGeneration(generation) && localHistoryRef.current === history) setLocalMessagePageError('Older saved messages could not be loaded.')
    } finally {
      localPageFlightsRef.current.delete(flightKey)
      if (isCurrentSessionLoadGeneration(generation) && localHistoryRef.current === history) setLocalMessagePageLoading(false)
    }
  }

  async function createPersistedChatSession(): Promise<DBSessionRecord | null> {
    if (!supportsPersistedSessions) return null
    const generation = sessionLoadGenerationRef.current
    const createSessionQueryKey = [
      ...queryKeys.conversations(persistedConversationScopeForAuth(sessionAuthScopeRef.current)),
      'create-session',
      generation,
    ]
    const created = await queryClient.fetchQuery({
      queryKey: createSessionQueryKey,
      queryFn: ({ signal }) => client.memory.createSession({ type: 'chat' }, { signal }),
      staleTime: 0,
    }).finally(() => {
      queryClient.removeQueries({ queryKey: createSessionQueryKey, exact: true })
    })
    if (!isCurrentSessionLoadGeneration(generation)) return null
    if (!created.ok) {
      const failureCopy = productAssistantErrorCopyRef.current(created.error)
      setSessionIndexError(failureCopy)
      setLastError(failureCopy)
      return null
    }
    setSessionIndex((current) => upsertSessionByModification(current, created.data.session))
    queryClient.setQueryData<PersistedConversationListResult>(
      queryKeys.conversations(persistedConversationScopeForAuth(sessionAuthScopeRef.current)),
      (current) => ({
        sessions: upsertSessionByModification(current?.sessions ?? [], created.data.session),
        activeSessionId: current?.activeSessionId ?? created.data.session.id,
      })
    )
    setSessionIndexError(null)
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(persistedConversationScopeForAuth(sessionAuthScopeRef.current)) })
    return created.data.session
  }

  const querySessionIndexLoading = persistedSessionsEnabled && persistedSessionsQuery.isPending && sessionIndex.length === 0

  return {
    session,
    setSession,
    sessionRef,
    sessionIndex,
    setSessionIndex,
    localConversationRows,
    setLocalConversationRows,
    localConversationCursor,
    localConversationPageLoading,
    localMessageCursor,
    localMessagePageLoading,
    localConversationPageError,
    localMessagePageError,
    localHistoryScopeKey: localHistory
      ? JSON.stringify([localHistory.scope.profileId, localHistory.scope.localNodeId, sessionAuthScope, localHistoryScopeGeneration])
      : '',
    sessionIndexLoading: sessionIndexLoading || querySessionIndexLoading,
    setSessionIndexLoading,
    sessionIndexError,
    setSessionIndexError,
    mobileHistoryOpen,
    setMobileHistoryOpen,
    sessionAuthScope,
    openPersistedSession,
    openLocalSession,
    refreshPersistedSessionIndex,
    refreshLocalSessionIndex,
    loadMoreLocalSessions,
    loadOlderLocalMessages,
    createPersistedChatSession,
  }
}

interface PersistedConversationListResult {
  sessions: DBSessionRecord[]
  activeSessionId: string | null
}

interface PersistedConversationSessionResult {
  session: Parameters<typeof assistantSessionFromPersisted>[0]
}

function persistedConversationScopeForAuth(authScope: string): string {
  return `assistant:persisted:${authScope}`
}

async function loadPersistedConversationList(
  client: AuroraClient,
  signal: AbortSignal,
): Promise<PersistedConversationListResult> {
  throwIfAborted(signal)
  const listed = await client.memory.listSessions({ type: 'chat', limit: 100 }, { signal })
  throwIfAborted(signal)
  if (!listed.ok) throw listed.error

  const sessions = sortSessionsByModification(listed.data.sessions)
  const activeSessionId = listed.data.active_session_id ?? sessions[0]?.id ?? null

  return { sessions, activeSessionId }
}

async function loadPersistedConversation(
  client: AuroraClient,
  conversationId: string,
  activate: boolean,
  signal: AbortSignal,
): Promise<PersistedConversationSessionResult> {
  throwIfAborted(signal)
  const loaded = await client.memory.getSession({
    session_id: conversationId,
    activate,
  }, { signal })
  throwIfAborted(signal)
  if (!loaded.ok) throw loaded.error
  return { session: loaded.data }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Assistant history request was cancelled', 'AbortError')
}

function assistantAuthScope(auth: AuthSessionSnapshot): string {
  return JSON.stringify([auth.state, auth.principalId ?? null, [...auth.effectivePermissions].sort()])
}
