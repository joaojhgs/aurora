// @vitest-environment jsdom
import { Profiler, act, memo, useMemo, type ProfilerOnRenderCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { ChatBubble } from '../src/assistant-message'
import type { AssistantUiMessage } from '../src/assistant-view'
import { useAssistantStreamStore } from '../src/state/assistant-stream-store'

const STREAM_SCOPE_ID = 'assistant-stream-render-scope'
const ACTIVE_MESSAGE_ID = 'assistant-stream-active'
const MESSAGE_COUNT = 48
const DELTA_COUNT = 140

const roots: Root[] = []

describe('assistant streaming render scope', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount())
    }
    document.body.innerHTML = ''
    useAssistantStreamStore.getState().reset(STREAM_SCOPE_ID)
  })

  it('commits streaming deltas only through the active message subtree', async () => {
    const messages = buildMessages()
    const activeMessage = messages.find((message) => message.id === ACTIVE_MESSAGE_ID)
    const stableInactiveMessage = messages[0]
    if (!activeMessage || !stableInactiveMessage) throw new Error('test messages were not created')

    useAssistantStreamStore.getState().reset(STREAM_SCOPE_ID)
    useAssistantStreamStore.getState().begin(ACTIVE_MESSAGE_ID, { scopeId: STREAM_SCOPE_ID })
    useAssistantStreamStore.getState().markStreaming({ scopeId: STREAM_SCOPE_ID })

    const commits = new Map<string, string[]>()
    let parentRenderCount = 0
    const recordCommit: ProfilerOnRenderCallback = (id, phase) => {
      commits.set(id, [...(commits.get(id) ?? []), phase])
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <ProfiledConversation
          messages={messages}
          streamScopeId={STREAM_SCOPE_ID}
          onParentRender={() => { parentRenderCount += 1 }}
          onProfilerCommit={recordCommit}
        />
      )
    })

    const parentRenderCountAfterMount = parentRenderCount
    commits.clear()

    const deltas = Array.from({ length: DELTA_COUNT }, (_, index) => `delta-${String(index).padStart(3, '0')} `)
    for (const delta of deltas) {
      await act(async () => {
        useAssistantStreamStore.getState().append(delta, { scopeId: STREAM_SCOPE_ID })
      })
    }

    const expectedText = deltas.join('')
    const activeNode = container.querySelector(`[data-message-id="${ACTIVE_MESSAGE_ID}"]`)
    const inactiveNode = container.querySelector(`[data-message-id="${stableInactiveMessage.id}"]`)
    const activeCommits = commits.get(ACTIVE_MESSAGE_ID) ?? []
    const inactiveCommits = [...commits]
      .filter(([id]) => id !== ACTIVE_MESSAGE_ID)
      .flatMap(([, phases]) => phases)

    expect(parentRenderCount).toBe(parentRenderCountAfterMount)
    expect(activeCommits).toHaveLength(DELTA_COUNT)
    expect(activeCommits.every((phase) => phase === 'update')).toBe(true)
    expect(inactiveCommits).toHaveLength(0)
    expect(activeNode?.textContent).toContain(expectedText)
    expect(inactiveNode?.textContent).toContain(stableInactiveMessage.text)
    expect(inactiveNode?.textContent).not.toContain('delta-')
    expect(messages.find((message) => message.id === ACTIVE_MESSAGE_ID)).toBe(activeMessage)
    expect(activeMessage.text).toBe('Saved answer before streaming.')
    expect(messages[0]).toBe(stableInactiveMessage)
  })
})

const ProfiledConversation = memo(function ProfiledConversation({
  messages,
  streamScopeId,
  onParentRender,
  onProfilerCommit,
}: {
  messages: readonly AssistantUiMessage[]
  streamScopeId: string
  onParentRender: () => void
  onProfilerCommit: ProfilerOnRenderCallback
}) {
  onParentRender()
  const memoizedMessages = useMemo(() => messages, [messages])
  return (
    <div aria-label="Assistant conversation render scope">
      {memoizedMessages.map((message) => (
        <ProfiledMessage
          key={message.id}
          message={message}
          streamScopeId={streamScopeId}
          onProfilerCommit={onProfilerCommit}
        />
      ))}
    </div>
  )
})

const ProfiledMessage = memo(function ProfiledMessage({
  message,
  streamScopeId,
  onProfilerCommit,
}: {
  message: AssistantUiMessage
  streamScopeId: string
  onProfilerCommit: ProfilerOnRenderCallback
}) {
  return (
    <div data-message-id={message.id}>
      <Profiler id={message.id} onRender={onProfilerCommit}>
        <ChatBubble message={message} streamScopeId={streamScopeId} />
      </Profiler>
    </div>
  )
})

function buildMessages(): AssistantUiMessage[] {
  return Array.from({ length: MESSAGE_COUNT }, (_, index) => {
    if (index === Math.floor(MESSAGE_COUNT / 2)) {
      return assistantMessage({
        id: ACTIVE_MESSAGE_ID,
        text: 'Saved answer before streaming.',
        status: 'streaming',
      })
    }
    if (index % 5 === 0) {
      return {
        id: `user-${index}`,
        role: 'user',
        text: `User prompt ${index}`,
        createdAt: '2026-09-16T00:00:00.000Z',
        status: 'sent',
      }
    }
    return assistantMessage({
      id: `assistant-${index}`,
      text: `Saved assistant answer ${index}`,
      status: 'sent',
    })
  })
}

function assistantMessage(overrides: Partial<AssistantUiMessage> = {}): AssistantUiMessage {
  return {
    id: 'assistant-message',
    role: 'assistant',
    text: 'Saved assistant answer',
    createdAt: '2026-09-16T00:00:00.000Z',
    status: 'sent',
    modelLabel: 'Local model',
    providerLabel: 'This device',
    routeLabel: 'Local',
    executionPeerId: null,
    ...overrides,
  }
}
