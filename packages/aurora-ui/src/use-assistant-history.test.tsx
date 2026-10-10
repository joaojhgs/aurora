// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuroraClient, AuthSessionSnapshot, DBSessionRecord } from '@aurora/client'
import type { ConversationMessageRecord, ConversationRecord } from '@aurora/client/local-data'
import type { AssistantSessionSnapshot } from './assistant-view'
import { AuroraQueryProvider, createAuroraQueryClient } from './query'
import { useAssistantHistory, type LocalAssistantHistoryDependencies } from './use-assistant-history'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAssistantHistory', () => {
  it('ignores a late persisted-session load after auth scope switches to a newer request', async () => {
    const firstList = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const secondList = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const firstSession = sessionRecord('first-session', 100)
    const secondSession = sessionRecord('second-session', 200)
    const client = historyClient({ lists: [firstList.promise, secondList.promise] })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      client.emitAuth(authSnapshot({ principalId: 'changed-user' }))
      secondList.resolve({ sessions: [secondSession], active_session_id: 'second-session' })
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('second-session')
    expect(harness.result.session.messages.map((message) => message.text)).toEqual(['Loaded second-session'])

    await act(async () => {
      firstList.resolve({ sessions: [firstSession], active_session_id: 'first-session' })
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('second-session')
    expect(harness.result.sessionIndex.map((session) => session.id)).toEqual(['second-session'])
    expect(harness.resetConversationUi).toHaveBeenCalledWith({ sessionId: null, messages: [] })
  })

  it('ignores a late manual persisted-session open after auth scope changes', async () => {
    const firstList = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const secondList = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const manualSession = deferred<{ session: DBSessionRecord; messages: ReturnType<typeof assistantMessage>[] }>()
    const client = historyClient({
      lists: [firstList.promise, secondList.promise],
      sessionLoads: new Map([['manual-session', manualSession.promise]]),
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      firstList.resolve({ sessions: [sessionRecord('first-session', 100)], active_session_id: 'first-session' })
      await flushPromises()
    })

    const manualOpen = harness.result.openPersistedSession('manual-session')
    await act(async () => {
      client.emitAuth(authSnapshot({ principalId: 'changed-user' }))
      secondList.resolve({ sessions: [sessionRecord('second-session', 200)], active_session_id: 'second-session' })
      await flushPromises()
    })

    await act(async () => {
      manualSession.resolve({
        session: sessionRecord('manual-session', 300),
        messages: [assistantMessage('Loaded manual-session')],
      })
      await manualOpen
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('second-session')
    expect(harness.result.session.messages.map((message) => message.text)).toEqual(['Loaded second-session'])
    expect(harness.resetConversationUi).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'manual-session' }))
  })

  it('keeps the latest manual persisted-session open when an earlier open resolves last', async () => {
    const firstList = Promise.resolve({ sessions: [sessionRecord('initial-session', 100)], active_session_id: 'initial-session' })
    const manualA = deferred<{ session: DBSessionRecord; messages: ReturnType<typeof assistantMessage>[] }>()
    const manualB = deferred<{ session: DBSessionRecord; messages: ReturnType<typeof assistantMessage>[] }>()
    const client = historyClient({
      lists: [firstList],
      sessionLoads: new Map([
        ['manual-a', manualA.promise],
        ['manual-b', manualB.promise],
      ]),
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    const openA = harness.result.openPersistedSession('manual-a')
    const openB = harness.result.openPersistedSession('manual-b')

    await act(async () => {
      manualB.resolve({ session: sessionRecord('manual-b', 300), messages: [assistantMessage('Loaded manual-b')] })
      await openB
      await flushPromises()
    })
    await act(async () => {
      manualA.resolve({ session: sessionRecord('manual-a', 200), messages: [assistantMessage('Loaded manual-a')] })
      await openA
      await flushPromises()
    })

    expect(harness.resetConversationUi).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'manual-b' }))
    expect(harness.resetConversationUi).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'manual-a' }))
    expect(client.memory.setActiveSession).toHaveBeenCalledWith({ session_id: 'manual-b' }, expect.any(Object))
    expect(client.memory.setActiveSession).not.toHaveBeenCalledWith({ session_id: 'manual-a' }, expect.any(Object))
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'manual-a', activate: false }), expect.any(Object))
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'manual-b', activate: false }), expect.any(Object))
  })

  it('aborts the older backend activation when a newer persisted selection starts', async () => {
    const firstList = Promise.resolve({ sessions: [sessionRecord('initial-session', 100)], active_session_id: 'initial-session' })
    const activationA = deferred<void>()
    const activationOrder: string[] = []
    const client = historyClient({
      lists: [firstList],
      activationWaits: new Map([['manual-a', activationA.promise]]),
      activationOrder,
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    const openA = harness.result.openPersistedSession('manual-a')
    await act(async () => {
      await flushPromises()
    })
    const activationCalls = client.memory.setActiveSession.mock.calls
    const firstActivationSignal = activationCalls[activationCalls.length - 1]?.[1]?.signal
    const openB = harness.result.openPersistedSession('manual-b')

    await act(async () => {
      await openB
      await openA
      await flushPromises()
    })

    expect(firstActivationSignal?.aborted).toBe(true)
    expect(activationOrder).toEqual(expect.arrayContaining(['manual-b']))
    expect(activationOrder).not.toContain('manual-a')
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'manual-a', activate: false }), expect.any(Object))
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'manual-b', activate: false }), expect.any(Object))
  })

  it('loads, activates, and displays the initial saved persisted conversation', async () => {
    const savedSession = sessionRecord('saved-session', 200)
    const client = historyClient({
      lists: [Promise.resolve({ sessions: [savedSession], active_session_id: 'saved-session' })],
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('saved-session')
    expect(harness.result.session.messages.map((message) => message.text)).toEqual(['Loaded saved-session'])
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'saved-session', activate: false }), expect.any(Object))
    expect(client.memory.setActiveSession).toHaveBeenCalledWith({ session_id: 'saved-session' }, expect.any(Object))
  })

  it('creates, activates, and displays an initial persisted conversation when the saved list is empty', async () => {
    const client = historyClient({
      lists: [Promise.resolve({ sessions: [], active_session_id: null })],
      createdSessionIds: ['created-initial'],
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    expect(client.memory.createSession).toHaveBeenCalledTimes(1)
    expect(harness.result.session.sessionId).toBe('created-initial')
    expect(harness.result.session.messages.map((message) => message.text)).toEqual(['Loaded created-initial'])
    expect(client.memory.getSession).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'created-initial', activate: false }), expect.any(Object))
    expect(client.memory.setActiveSession).toHaveBeenCalledWith({ session_id: 'created-initial' }, expect.any(Object))
  })

  it('dedupes concurrent persisted-session initialization through the shared conversation query', async () => {
    const list = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const client = historyClient({ lists: [list.promise] })
    const harness = await renderDualHistoryHarness({ client, supportsPersistedSessions: true })

    expect(client.memory.listSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      list.resolve({ sessions: [sessionRecord('shared-session', 200)], active_session_id: 'shared-session' })
      await flushPromises()
    })

    expect(client.memory.getSession).toHaveBeenCalledTimes(1)
    expect(harness.first.session.sessionId).toBe('shared-session')
    expect(harness.second.session.sessionId).toBe('shared-session')
  })

  it('dedupes concurrent empty persisted-session initialization creation through the boot query', async () => {
    const list = deferred<{ sessions: DBSessionRecord[]; active_session_id: string | null }>()
    const client = historyClient({ lists: [list.promise] })
    const harness = await renderDualHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      list.resolve({ sessions: [], active_session_id: null })
      await flushPromises()
    })

    expect(client.memory.createSession).toHaveBeenCalledTimes(1)
    expect(client.memory.getSession).toHaveBeenCalledTimes(1)
    expect(harness.first.session.sessionId).toBe('created-session')
    expect(harness.second.session.sessionId).toBe('created-session')
  })

  it('creates a fresh initial chat on a later empty-list remount after the boot create query settles', async () => {
    const sharedQueryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const firstClient = historyClient({
      lists: [Promise.resolve({ sessions: [], active_session_id: null })],
      createdSessionIds: ['created-first'],
    })
    const firstHarness = await renderHistoryHarness({ client: firstClient, supportsPersistedSessions: true, queryClient: sharedQueryClient })

    await act(async () => {
      await flushPromises()
    })

    expect(firstHarness.result.session.sessionId).toBe('created-first')
    act(() => { for (const root of roots.splice(0)) root.unmount() })

    const secondClient = historyClient({
      lists: [Promise.resolve({ sessions: [], active_session_id: null })],
      createdSessionIds: ['created-second'],
    })
    const secondHarness = await renderHistoryHarness({ client: secondClient, supportsPersistedSessions: true, queryClient: sharedQueryClient })

    await act(async () => {
      await flushPromises()
    })

    expect(secondClient.memory.createSession).toHaveBeenCalledTimes(1)
    expect(secondHarness.result.session.sessionId).toBe('created-second')
  })

  it('does not create a chat during a passive persisted-session list refresh', async () => {
    const activeSession = sessionRecord('current-session', 100)
    const client = historyClient({
      lists: [
        Promise.resolve({ sessions: [activeSession], active_session_id: 'current-session' }),
        Promise.resolve({ sessions: [], active_session_id: null }),
      ],
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('current-session')
    expect(client.memory.createSession).not.toHaveBeenCalled()

    await act(async () => {
      await harness.queryClient.refetchQueries()
      await flushPromises()
    })

    expect(client.memory.createSession).not.toHaveBeenCalled()
    expect(harness.result.session.sessionId).toBe('current-session')
  })

  it('keeps the selected persisted conversation when a passive list refetch reports another active session', async () => {
    const currentSession = sessionRecord('current-session', 100)
    const newerSession = sessionRecord('newer-session', 200)
    const client = historyClient({
      lists: [
        Promise.resolve({ sessions: [currentSession], active_session_id: 'current-session' }),
        Promise.resolve({ sessions: [newerSession], active_session_id: 'newer-session' }),
      ],
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('current-session')

    await act(async () => {
      await harness.queryClient.refetchQueries()
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('current-session')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(harness.result.sessionIndex.map((session) => session.id)).toEqual(['newer-session'])
  })

  it('keeps an active local draft when a passive persisted-session list refresh completes', async () => {
    const currentSession = sessionRecord('current-session', 100)
    const newerSession = sessionRecord('newer-session', 200)
    const client = historyClient({
      lists: [
        Promise.resolve({ sessions: [currentSession], active_session_id: 'current-session' }),
        Promise.resolve({ sessions: [newerSession], active_session_id: 'newer-session' }),
      ],
    })
    const harness = await renderHistoryHarness({ client, supportsPersistedSessions: true })

    await act(async () => {
      await flushPromises()
    })
    await act(async () => {
      harness.result.setSession({ sessionId: 'draft-session', messages: [assistantMessage('unsent local draft')] })
      await flushPromises()
    })

    await act(async () => {
      await harness.queryClient.refetchQueries()
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('draft-session')
    expect(harness.result.session.messages.map((message) => message.text)).toEqual(['unsent local draft'])
  })

  it('keeps the latest manual local conversation open when an earlier message load resolves last', async () => {
    const messagesA = deferred<ConversationMessageRecord[]>()
    const messagesB = deferred<ConversationMessageRecord[]>()
    const activationOrder: string[] = []
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-initial', 100), conversationRecord('local-a', 200), conversationRecord('local-b', 300)])],
      messageLoads: new Map([
        ['local-a', messagesA.promise],
        ['local-b', messagesB.promise],
      ]),
    })
    const client = historyClient({ transportKind: 'native-mobile' })
    const harness = await renderHistoryHarness({
      client,
      localHistory,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: true,
    })

    await act(async () => {
      await flushPromises()
    })

    const openA = harness.result.openLocalSession('local-a')
    const openB = harness.result.openLocalSession('local-b')

    await act(async () => {
      messagesB.resolve([localAssistantMessage('local-b')])
      await openB
      await flushPromises()
    })
    await act(async () => {
      messagesA.resolve([localAssistantMessage('local-a')])
      await openA
      await flushPromises()
    })

    expect(harness.resetConversationUi).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'local-b' }))
    expect(harness.resetConversationUi).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'local-a' }))
  })

  it('serializes local activation so the latest open wins after an older activation resolves', async () => {
    const activationA = deferred<void>()
    const activationOrder: string[] = []
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-initial', 100), conversationRecord('local-a', 200), conversationRecord('local-b', 300)])],
      activationWaits: new Map([['local-a', activationA.promise]]),
      activationOrder,
    })
    const client = historyClient({ transportKind: 'native-mobile' })
    const harness = await renderHistoryHarness({
      client,
      localHistory,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: true,
    })

    await act(async () => {
      await flushPromises()
    })

    let openA!: Promise<void>
    await act(async () => {
      openA = harness.result.openLocalSession('local-a')
      await flushPromises()
    })
    expect(localHistory.localData.conversations.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-a' }))

    await act(async () => {
      const openB = harness.result.openLocalSession('local-b')
      activationA.resolve()
      await openA
      await openB
      await flushPromises()
    })

    expect(harness.resetConversationUi).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'local-b' }))
    expect(activationOrder).toEqual(['local-a', 'local-b'])
  })

  it('skips a queued stale local activation after the auth scope changes', async () => {
    const blockerActivation = deferred<void>()
    const activationOrder: string[] = []
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-blocker', 100), conversationRecord('local-a', 200)])],
      activationWaits: new Map([['local-blocker', blockerActivation.promise]]),
      activationOrder,
    })
    const client = historyClient({ transportKind: 'native-mobile' })
    const harness = await renderHistoryHarness({
      client,
      localHistory,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: true,
    })

    await act(async () => {
      await flushPromises()
    })

    const blockerOpen = harness.result.openLocalSession('local-blocker')
    const staleOpen = harness.result.openLocalSession('local-a')

    await act(async () => {
      client.emitAuth(authSnapshot({ principalId: 'changed-local-user' }))
      blockerActivation.resolve()
      await blockerOpen
      await staleOpen
      await flushPromises()
    })

    expect(activationOrder).not.toContain('local-a')
    expect(harness.resetConversationUi).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'local-a' }))
  })

  it('reports current local activation failures without blocking later activation attempts', async () => {
    const activationOrder: string[] = []
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 200), conversationRecord('local-b', 300)])],
      activationFailures: new Set(['local-a']),
      activationOrder,
    })
    const client = historyClient({ transportKind: 'native-mobile' })
    const harness = await renderHistoryHarness({
      client,
      localHistory,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: true,
    })

    await act(async () => {
      await flushPromises()
    })
    await act(async () => {
      await harness.result.openLocalSession('local-a')
      await flushPromises()
    })

    expect(harness.result.sessionIndexError).toBe('This chat could not be opened. Your saved data was not changed.')

    await act(async () => {
      await harness.result.openLocalSession('local-b')
      await flushPromises()
    })

    expect(harness.resetConversationUi).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'local-b' }))
    expect(activationOrder).toContain('local-b')
  })

  it('keeps the current local conversation when an older local row load resolves late', async () => {
    const oldRows = deferred<LocalRow[]>()
    const newRows = deferred<LocalRow[]>()
    const localHistory = localHistoryDependencies({ rows: [oldRows.promise, newRows.promise] })
    const client = historyClient({ transportKind: 'native-mobile' })
    const harness = await renderHistoryHarness({
      client,
      localHistory,
      supportsPersistedSessions: false,
      usesLocalConversationHistory: true,
    })

    await act(async () => {
      client.emitAuth(authSnapshot({ principalId: 'local-user-2' }))
      newRows.resolve([conversationRecord('local-new', 200)])
      await flushPromises()
    })

    await waitForHistoryValue(() => harness.result.session.sessionId, 'local-new')

    expect(harness.result.session.sessionId).toBe('local-new')
    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual(['local-new'])

    await act(async () => {
      oldRows.resolve([conversationRecord('local-old', 100)])
      await flushPromises()
    })

    expect(harness.result.session.sessionId).toBe('local-new')
    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual(['local-new'])
  })

  it('loads conversation index pages without replacing the active local chat', async () => {
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      rawConversationQueries: [
        conversationPageRecords('local-a', 300, 26),
        [conversationRecord('local-b', 200)],
      ],
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })

    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.localConversationCursor?.id ?? null, 'local-a-25')
    expect(harness.result.localConversationCursor).toEqual(expect.objectContaining({ id: 'local-a-25' }))

    await act(async () => {
      await harness.result.loadMoreLocalSessions()
      await flushPromises()
    })

    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual([
      ...conversationPageRecords('local-a', 300, 25).map((row) => row.id),
      'local-b',
    ])
  })

  it('preserves the first page and cursor when restoring an active conversation outside that page', async () => {
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-front', 300), conversationRecord('local-other', 200)])],
      rawConversationQueries: [conversationPageRecords('local-front', 300, 26), [conversationRecord('local-tail', 100)]],
      restoredConversations: new Map([
        ['local-restored', conversationRecord('local-restored', 100)],
      ]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      initialSession: { sessionId: 'local-restored', messages: [] },
      usesLocalConversationHistory: true,
    })

    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.localConversationCursor?.id ?? null, 'local-front-25')

    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual(['local-restored', ...conversationPageRecords('local-front', 300, 25).map((row) => row.id)])
    expect(harness.result.localConversationCursor).toEqual(expect.objectContaining({ id: 'local-front-25' }))
    expect(harness.result.session.sessionId).toBe('local-restored')
  })

  it('dedupes a later page while preserving refreshed front order and incoming page order', async () => {
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-front', 300), conversationRecord('local-existing', 200)])],
      rawConversationQueries: [
        [
          conversationRecord('local-front', 300),
          conversationRecord('local-existing', 299),
          ...conversationPageRecords('local-fill', 298, 24),
        ],
        [conversationRecord('local-front', 150), conversationRecord('local-new', 100)],
      ],
      conversationOverrides: new Map([['local-existing', conversationRecord('local-existing', 400)]]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      initialSession: { sessionId: 'local-existing', messages: [] },
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.localConversationRows.length, 25)
    await act(async () => { await harness.result.openLocalSession('local-existing'); await flushPromises() })
    await waitForHistoryValue(() => harness.result.session.sessionId, 'local-existing')
    await act(async () => {
      await harness.result.refreshLocalSessionIndex('local-existing')
      await flushPromises()
    })
    await act(async () => { await harness.result.loadMoreLocalSessions(); await flushPromises() })
    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual([
      'local-existing',
      'local-front',
      ...conversationPageRecords('local-fill', 298, 23).map((row) => row.id),
      'local-new',
    ])
  })

  it('resets both page loading flags when a newer local session scope begins', async () => {
    const page = deferred<ConversationMessageRecord[]>()
    const conversationPage = deferred<ConversationRecord[]>()
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      rawConversationQueries: [conversationPageRecords('local-a', 300, 26)],
      messageLoads: new Map([['local-a', Promise.resolve(localMessagePageRecords('local-a', 51))]]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => {
      const cursor = harness.result.localMessageCursor
      return cursor?.direction === 'desc' ? cursor.beforeSequence : null
    }, 1)
    vi.spyOn(localHistory.localData.conversations, 'listMessages').mockReturnValueOnce(page.promise)
    vi.spyOn(localHistory.localData.conversations, 'listConversations').mockReturnValueOnce(conversationPage.promise)
    const conversationLoad = harness.result.loadMoreLocalSessions()
    const load = harness.result.loadOlderLocalMessages()
    await act(async () => { await flushPromises() })
    expect(harness.result.localMessagePageLoading).toBe(true)
    expect(harness.result.localConversationPageLoading).toBe(true)
    await act(async () => {
      await harness.result.openLocalSession('local-b')
      await flushPromises()
    })
    expect(harness.result.localConversationPageLoading).toBe(false)
    expect(harness.result.localMessagePageLoading).toBe(false)
    page.resolve([])
    conversationPage.resolve([])
    await act(async () => { await Promise.all([load, conversationLoad]); await flushPromises() })
  })

  it('ignores a deferred older-message projection after switching conversations', async () => {
    const olderPage = deferred<ConversationMessageRecord[]>()
    const firstProjection = deferred<void>()
    const mergedProjection = deferred<void>()
    const older = { ...localAssistantMessage('local-a'), id: 'local-a-older', sequence: -1, contentEnvelope: {} as never }
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300), conversationRecord('local-b', 200)])],
      messageLoads: new Map([['local-a', Promise.resolve(localMessagePageRecords('local-a', 51))], ['local-b', Promise.resolve([localAssistantMessage('local-b')])]]),
      decryptWaits: [firstProjection.promise, mergedProjection.promise],
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.session.sessionId, 'local-a')
    vi.spyOn(localHistory.localData.conversations, 'listMessages').mockReturnValueOnce(olderPage.promise)
    const load = harness.result.loadOlderLocalMessages()
    await act(async () => { await flushPromises() })
    olderPage.resolve([older])
    firstProjection.resolve()
    await act(async () => { await flushPromises() })
    const openB = harness.result.openLocalSession('local-b')
    mergedProjection.resolve()
    await act(async () => { await openB; await flushPromises() })
    await act(async () => { await load; await flushPromises() })
    expect(harness.result.session.sessionId).toBe('local-b')
    expect(harness.result.session.messages.map((message) => message.id)).toEqual(['local-b-assistant'])
  })

  it('commits targeted refresh records only after deferred projection and row loading remain current', async () => {
    const firstProjection = deferred<void>()
    const refreshedProjection = deferred<void>()
    const current = localAssistantMessage('local-a')
    const records = [current]
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300), conversationRecord('local-b', 200)])],
      messageLoads: new Map([['local-a', Promise.resolve(records)], ['local-b', Promise.resolve([localAssistantMessage('local-b')])]]),
      decryptWaits: [firstProjection.promise, refreshedProjection.promise],
    })
    const harness = await renderHistoryHarness({ client: historyClient({ transportKind: 'native-mobile' }), localHistory, usesLocalConversationHistory: true })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.session.sessionId, 'local-a')
    records[0] = { ...current, contentEnvelope: {} as never }
    const refresh = harness.result.refreshLocalSessionIndex('local-a')
    await act(async () => { await flushPromises() })
    firstProjection.resolve()
    await act(async () => { await flushPromises() })
    const openB = harness.result.openLocalSession('local-b')
    refreshedProjection.resolve()
    await act(async () => { await openB; await flushPromises() })
    await act(async () => { await refresh; await flushPromises() })
    expect(harness.result.session.sessionId).toBe('local-b')
    expect(harness.result.session.messages.map((message) => message.id)).toEqual(['local-b-assistant'])
  })

  it('does not let a delayed same-turn refresh replace approval completion', async () => {
    const turnCreatedAt = Date.parse('2026-01-01T00:00:00.000Z')
    const storedTurn = [
      {
        ...localAssistantMessage('local-a'),
        id: 'stored-user',
        role: 'user' as const,
        sequence: 0,
        createdAtMs: turnCreatedAt,
      },
      {
        ...localAssistantMessage('local-a'),
        id: 'stored-assistant',
        sequence: 1,
        createdAtMs: turnCreatedAt + 1,
      },
    ]
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      messageLoads: new Map([['local-a', Promise.resolve(storedTurn)]]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.session.sessionId, 'local-a')

    const rowRead = deferred<ConversationRecord | null>()
    const getConversation = vi.spyOn(localHistory.localData.conversations, 'getConversation')
      .mockReturnValue(rowRead.promise)
    const refresh = harness.result.refreshLocalSessionIndex('local-a')
    await act(async () => { await flushPromises() })
    expect(getConversation).toHaveBeenCalled()

    const liveMessages = [
      {
        id: 'live-user',
        role: 'user' as const,
        text: 'Saved message',
        createdAt: new Date(turnCreatedAt).toISOString(),
        status: 'sent' as const,
      },
      {
        id: 'live-assistant',
        role: 'assistant' as const,
        text: 'Approved action completed.',
        createdAt: new Date(turnCreatedAt + 1).toISOString(),
        status: 'sent' as const,
        toolCalls: [{
          id: 'local-echo',
          name: 'local.echo',
          sessionId: 'local-a',
          status: 'completed' as const,
          riskClass: 'trusted',
          target: 'This device',
          dataLeavesDevice: false,
          summary: 'Approved and completed on this device.',
          auditId: null,
          payloadPreview: null,
          localConfirmationToken: null,
          resolving: false,
        }],
      },
    ]
    await act(async () => {
      harness.result.setSession({ sessionId: 'local-a', messages: liveMessages })
      await flushPromises()
    })

    rowRead.resolve(conversationRecord('local-a', 500))
    await act(async () => { await refresh; await flushPromises() })

    expect(harness.result.session.messages).toEqual(liveMessages)
  })

  it('keeps an A→B→A page flight guard owned by its generation', async () => {
    const oldPage = deferred<ConversationRecord[]>()
    const newPage = deferred<ConversationRecord[]>()
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      rawConversationQueries: [conversationPageRecords('local-a', 300, 26)],
    })
    const harness = await renderHistoryHarness({ client: historyClient({ transportKind: 'native-mobile' }), localHistory, usesLocalConversationHistory: true })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result.localConversationCursor?.id ?? null, 'local-a-25')
    let pageCallCount = 0
    const listPage = vi.spyOn(localHistory.localData.conversations, 'listConversations').mockImplementation(async (options) => {
      if (options?.limit === 26 && options.cursor) {
        pageCallCount += 1
        return await (pageCallCount === 1 ? oldPage.promise : newPage.promise)
      }
      return []
    })
    const oldLoad = harness.result.loadMoreLocalSessions()
    await act(async () => { await harness.result.openLocalSession('local-b'); await harness.result.openLocalSession('local-a'); await flushPromises() })
    const newLoad = harness.result.loadMoreLocalSessions()
    expect(listPage.mock.calls.filter(([options]) => options?.limit === 26 && options.cursor)).toHaveLength(2)
    oldPage.resolve([])
    await act(async () => { await oldLoad; await flushPromises() })
    expect(harness.result.localConversationPageLoading).toBe(true)
    newPage.resolve([])
    await act(async () => { await newLoad; await flushPromises() })
  })

  it('keys concurrent conversation page flights by scope and cursor', async () => {
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      rawConversationQueries: [conversationPageRecords('local-a', 300, 26)],
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result?.localConversationCursor?.id ?? null, 'local-a-25')
    const page = deferred<ConversationRecord[]>()
    const originalListConversations = localHistory.localData.conversations.listConversations
    const listPage = vi.spyOn(localHistory.localData.conversations, 'listConversations').mockImplementation((options) =>
      options?.cursor ? page.promise : originalListConversations(options))

    const first = harness.result.loadMoreLocalSessions()
    const second = harness.result.loadMoreLocalSessions()
    expect(listPage.mock.calls.filter(([options]) => options?.cursor)).toHaveLength(1)
    await act(async () => {
      page.resolve([conversationRecord('local-b', 200)])
      await Promise.all([first, second])
      await flushPromises()
    })

    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual([
      ...conversationPageRecords('local-a', 300, 25).map((row) => row.id),
      'local-b',
    ])
    expect(harness.result.localConversationPageLoading).toBe(false)
  })

  it('loads older local message pages and keeps the scroll anchor callback path available', async () => {
    const older = { ...localAssistantMessage('local-a'), id: 'local-a-older', sequence: 0 }
    const seededMessages = [older, ...localMessagePageRecords('local-a', 51).slice(1)]
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      messageLoads: new Map([['local-a', Promise.resolve(seededMessages)]]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })

    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => {
      const cursor = harness.result?.localMessageCursor
      return cursor?.direction === 'desc' ? cursor.beforeSequence : null
    }, 1)
    expect(harness.result.localMessageCursor).toEqual(expect.objectContaining({ direction: 'desc', beforeSequence: 1 }))
    await act(async () => { await harness.result.loadOlderLocalMessages() })
    expect(harness.result.session.messages.map((message) => message.id)).toEqual(seededMessages.map((message) => message.id))
  })

  it('preserves loaded older local records during a targeted conversation refresh', async () => {
    const older = { ...localAssistantMessage('local-a'), id: 'local-a-older', sequence: 0 }
    const seededMessages = [older, ...localMessagePageRecords('local-a', 51).slice(1)]
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      messageLoads: new Map([['local-a', Promise.resolve(seededMessages)]]),
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })

    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => {
      const cursor = harness.result?.localMessageCursor
      return cursor?.direction === 'desc' ? cursor.beforeSequence : null
    }, 1)
    await act(async () => { await harness.result.loadOlderLocalMessages() })
    await act(async () => { await harness.result.refreshLocalSessionIndex('local-a') })

    expect(harness.result.session.messages.map((message) => message.id)).toEqual(seededMessages.map((message) => message.id))
  })

  it('keeps loaded rows when a subsequent conversation page fails', async () => {
    const localHistory = localHistoryDependencies({
      rows: [Promise.resolve([conversationRecord('local-a', 300)])],
      rawConversationQueries: [conversationPageRecords('local-a', 300, 26)],
    })
    const harness = await renderHistoryHarness({
      client: historyClient({ transportKind: 'native-mobile' }),
      localHistory,
      usesLocalConversationHistory: true,
    })
    await act(async () => { await flushPromises() })
    await waitForHistoryValue(() => harness.result?.localConversationCursor?.id ?? null, 'local-a-25')
    vi.spyOn(localHistory.localData.conversations, 'listConversations').mockRejectedValueOnce(new Error('page unavailable'))
    await act(async () => { await harness.result.loadMoreLocalSessions() })
    expect(harness.result.localConversationRows.map((row) => row.id)).toEqual(conversationPageRecords('local-a', 300, 25).map((row) => row.id))
    expect(harness.result.localConversationPageError).toBe('More saved chats could not be loaded.')
  })
})

interface HistoryHarnessOptions {
  client: ReturnType<typeof historyClient>
  localHistory?: LocalAssistantHistoryDependencies | null
  initialSession?: AssistantSessionSnapshot
  supportsPersistedSessions?: boolean
  usesLocalConversationHistory?: boolean
  queryClient?: ReturnType<typeof createAuroraQueryClient>
}

async function renderHistoryHarness(options: HistoryHarnessOptions) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const textAreaRef = { current: null as HTMLTextAreaElement | null }
  let latest!: ReturnType<typeof useAssistantHistory>
  const resetConversationUi = vi.fn((nextSession: AssistantSessionSnapshot) => {
    latest.setSession(nextSession)
  })

  const queryClient = options.queryClient ?? createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })

  function Harness() {
    const result = useAssistantHistory({
      client: options.client as unknown as AuroraClient,
      initialSession: options.initialSession,
      storageKey: 'history-test-key',
      localHistory: options.localHistory ?? null,
      supportsPersistedSessions: options.supportsPersistedSessions ?? false,
      usesLocalConversationHistory: options.usesLocalConversationHistory ?? false,
      resetConversationUi,
      textAreaRef,
      setLastError: vi.fn(),
      productAssistantErrorCopy: (error) => error instanceof Error ? error.message : String(error),
    })
    latest = result
    return null
  }

  await act(async () => {
    root.render(createElement(AuroraQueryProvider, { client: options.client as unknown as AuroraClient, queryClient, children: createElement(Harness) }))
    await flushPromises()
  })

  return { get result() { return latest }, resetConversationUi, queryClient }
}

async function renderDualHistoryHarness(options: HistoryHarnessOptions) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const queryClient = options.queryClient ?? createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
  const resetConversationUi = vi.fn()
  const textAreaRef = { current: null as HTMLTextAreaElement | null }
  const results: Array<ReturnType<typeof useAssistantHistory>> = []

  function HookHarness({ index }: { index: number }) {
    results[index] = useAssistantHistory({
      client: options.client as unknown as AuroraClient,
      initialSession: undefined,
      storageKey: `history-test-key-${index}`,
      localHistory: options.localHistory ?? null,
      supportsPersistedSessions: options.supportsPersistedSessions ?? false,
      usesLocalConversationHistory: options.usesLocalConversationHistory ?? false,
      resetConversationUi,
      textAreaRef,
      setLastError: vi.fn(),
      productAssistantErrorCopy: (error) => error instanceof Error ? error.message : String(error),
    })
    return null
  }

  function Harness() {
    return createElement(
      AuroraQueryProvider,
      { client: options.client as unknown as AuroraClient, queryClient, children: createElement('div', null, createElement(HookHarness, { index: 0 }), createElement(HookHarness, { index: 1 })) }
    )
  }

  await act(async () => {
    root.render(createElement(Harness))
    await flushPromises()
  })

  return { get first() { return results[0]! }, get second() { return results[1]! }, resetConversationUi, queryClient }
}

function historyClient(options: { transportKind?: string; lists?: Array<Promise<{ sessions: DBSessionRecord[]; active_session_id: string | null }>>; sessionLoads?: Map<string, Promise<{ session: DBSessionRecord; messages: ReturnType<typeof assistantMessage>[] }>>; createdSessionIds?: string[]; activationWaits?: Map<string, Promise<void>>; activationOrder?: string[] } = {}) {
  let auth = authSnapshot({ principalId: 'initial-user' })
  const listeners = new Set<(auth: AuthSessionSnapshot) => void>()
  const lists = [...(options.lists ?? [])]
  const createdSessionIds = [...(options.createdSessionIds ?? ['created-session'])]
  const client = {
    transport: { kind: options.transportKind ?? 'http' },
    auth: {
      snapshot: vi.fn(() => auth),
      subscribe: vi.fn((listener: (auth: AuthSessionSnapshot) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }),
    },
    memory: {
      listSessions: vi.fn(async (_request?: unknown, _options?: { signal?: AbortSignal }) => ({ ok: true, data: await (lists.shift() ?? Promise.resolve({ sessions: [sessionRecord('fallback-session', 1)], active_session_id: 'fallback-session' })) })),
      getSession: vi.fn(async ({ session_id }: { session_id: string }, _options?: { signal?: AbortSignal }) => ({
        ok: true,
        data: await (options.sessionLoads?.get(session_id) ?? Promise.resolve({
          session: sessionRecord(session_id, session_id === 'second-session' ? 200 : 100),
          messages: [assistantMessage(`Loaded ${session_id}`)],
        })),
      })),
      createSession: vi.fn(async (_request?: unknown, _options?: { signal?: AbortSignal }) => {
        const id = createdSessionIds.shift() ?? 'created-session'
        return { ok: true, data: { session: sessionRecord(id, 300) } }
      }),
      setActiveSession: vi.fn(async ({ session_id }: { session_id: string }, optionsArg?: { signal?: AbortSignal }) => {
        const wait = options.activationWaits?.get(session_id)
        if (wait) await waitForAbortable(wait, optionsArg?.signal)
        if (optionsArg?.signal?.aborted) throw new DOMException('Assistant history request was cancelled', 'AbortError')
        options.activationOrder?.push(session_id)
        return { ok: true, data: { session: sessionRecord(session_id, 400) } }
      }),
    },
    emitAuth(next: AuthSessionSnapshot) {
      auth = next
      for (const listener of listeners) listener(next)
    },
  }
  return client
}

function localHistoryDependencies(options: { rows: Array<Promise<LocalRow[]>>; rawConversationQueries?: LocalRow[][]; messageLoads?: Map<string, Promise<ConversationMessageRecord[]>>; activationWaits?: Map<string, Promise<void>>; activationFailures?: Set<string>; activationOrder?: string[]; restoredConversations?: Map<string, LocalRow>; conversationOverrides?: Map<string, LocalRow>; decryptWaits?: Array<Promise<void>> }): LocalAssistantHistoryDependencies {
  const rows = [...options.rows]
  const rawConversationQueries = [...(options.rawConversationQueries ?? [])]
  let lastRows: LocalRow[] = []
  const messages = new Map<string, ConversationMessageRecord[]>([
    ['local-new', [localAssistantMessage('local-new')]],
    ['local-old', [localAssistantMessage('local-old')]],
  ])
  const conversations = {
    listConversations: vi.fn(async ({ limit, cursor }: { limit?: number; cursor?: { updatedAtMs: number; id: string } } = {}) => {
      if (rawConversationQueries.length > 0 && (limit ?? lastRows.length) > 1) {
        lastRows = rawConversationQueries.shift()!
      } else {
        const nextRows = rows.shift()
        if (nextRows) lastRows = await nextRows
      }
      const ordered = [...lastRows].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id))
      const eligible = cursor
        ? ordered.filter((row) => row.updatedAtMs < cursor.updatedAtMs || (row.updatedAtMs === cursor.updatedAtMs && row.id > cursor.id))
        : ordered
      return eligible.slice(0, limit ?? eligible.length)
    }),
    listMessageCounts: vi.fn(async () => ({ 'local-new': 1, 'local-old': 1 })),
    listFirstUserMessages: vi.fn(async () => ({})),
    listMessages: vi.fn(async (conversationId: string, { limit, beforeSequence, afterSequence, direction = 'desc' }: { limit?: number; beforeSequence?: number; afterSequence?: number; direction?: 'asc' | 'desc' } = {}) => {
      const source = await (options.messageLoads?.get(conversationId) ?? Promise.resolve(messages.get(conversationId) ?? []))
      const filtered = source.filter((message) => (beforeSequence === undefined || message.sequence < beforeSequence) && (afterSequence === undefined || message.sequence > afterSequence))
      const ordered = [...filtered].sort((left, right) => direction === 'desc' ? right.sequence - left.sequence : left.sequence - right.sequence)
      return ordered.slice(0, limit ?? ordered.length)
    }),
    getConversation: vi.fn(async (conversationId: string) => options.conversationOverrides?.get(conversationId) ?? lastRows.find((row) => row.id === conversationId) ?? options.restoredConversations?.get(conversationId) ?? null),
    getMessage: vi.fn(async (conversationId: string, messageId: string) => (messages.get(conversationId) ?? []).find((message) => message.id === messageId) ?? null),
    getLatestMessageSequence: vi.fn(async (conversationId: string) => Math.max(-1, ...(messages.get(conversationId) ?? []).map((message) => message.sequence))),
    upsertConversation: vi.fn(async (record: ConversationRecord) => {
      const wait = options.activationWaits?.get(record.id)
      if (wait) await wait
      if (options.activationFailures?.has(record.id)) throw new Error('Local activation failed.')
      options.activationOrder?.push(record.id)
      lastRows = [record, ...lastRows.filter((row) => row.id !== record.id)]
    }),
    appendMessage: vi.fn(async () => undefined),
  }
  return {
    localData: {
      profileId: 'profile',
      localNodeId: 'node',
      schemaVersion: 1,
      conversations,
      transaction: vi.fn(async (work: (repositories: { conversations: typeof conversations }) => Promise<unknown>) => await work({ conversations })),
      exportV1: vi.fn(),
      importV1: vi.fn(),
      close: vi.fn(),
    },
    envelopeCrypto: {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => {
        const wait = options.decryptWaits?.shift()
        if (wait) await wait
        return new TextEncoder().encode('local message text')
      }),
    },
    scope: { localNodeId: 'node', profileId: 'profile' },
  } as unknown as LocalAssistantHistoryDependencies
}

type LocalRow = ConversationRecord

function authSnapshot(overrides: Partial<AuthSessionSnapshot>): AuthSessionSnapshot {
  return {
    state: 'authenticated',
    principalId: overrides.principalId ?? 'principal',
    effectivePermissions: new Set(['assistant:use']),
    ...overrides,
  } as AuthSessionSnapshot
}

function sessionRecord(id: string, updatedAt: number): DBSessionRecord {
  return {
    id,
    type: 'chat',
    title: id,
    created_at: new Date(updatedAt).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    principal_id: 'principal',
    last_active_at: new Date(updatedAt).toISOString(),
    message_count: 1,
  }
}

function conversationRecord(id: string, updatedAt: number): ConversationRecord {
  return {
    id,
    profileId: 'profile',
    localNodeId: 'node',
    titleEnvelope: null,
    createdAtMs: updatedAt,
    updatedAtMs: updatedAt,
    archivedAtMs: null,
  }
}

function conversationPageRecords(prefix: string, newestUpdatedAt: number, count: number): ConversationRecord[] {
  return Array.from({ length: count }, (_, index) => conversationRecord(
    index === 0 ? prefix : `${prefix}-${index + 1}`,
    newestUpdatedAt - index,
  ))
}

function localMessagePageRecords(conversationId: string, count: number): ConversationMessageRecord[] {
  return Array.from({ length: count }, (_, sequence) => ({
    ...localAssistantMessage(conversationId),
    id: sequence === 0 ? `${conversationId}-assistant` : `${conversationId}-assistant-${sequence}`,
    sequence,
  }))
}

function localAssistantMessage(conversationId: string): ConversationMessageRecord {
  return {
    id: `${conversationId}-assistant`,
    conversationId,
    sequence: 0,
    role: 'assistant',
    contentEnvelope: null,
    toolEnvelope: null,
    status: 'complete',
    createdAtMs: 200,
  }
}

function assistantMessage(text: string) {
  return {
    id: `assistant-${text}`,
    role: 'assistant' as const,
    text,
    createdAt: new Date().toISOString(),
    status: 'sent' as const,
  }
}

async function waitForAbortable(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await wait
    return
  }
  if (signal.aborted) throw new DOMException('Assistant history request was cancelled', 'AbortError')
  await Promise.race([
    wait,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Assistant history request was cancelled', 'AbortError')), { once: true })
    }),
  ])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

async function waitForHistoryValue<T>(read: () => T, expected: T): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (Object.is(read(), expected)) return
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  }
  throw new Error(`Timed out waiting for history value ${String(expected)}`)
}
