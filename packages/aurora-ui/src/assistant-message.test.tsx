// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { ChatBubble } from './assistant-message'
import type { AssistantUiMessage } from './assistant-view'
import { useAssistantStreamStore } from './state/assistant-stream-store'
import { ASSISTANT_RECONNECTING_TEXT, ASSISTANT_RESPONDING_TEXT } from './assistant-session-model'

describe('ChatBubble', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    useAssistantStreamStore.getState().reset('scope-a')
    useAssistantStreamStore.getState().reset('scope-b')
  })

  it.each([ASSISTANT_RESPONDING_TEXT, ASSISTANT_RECONNECTING_TEXT])('shows pending progress for %s until the first token', async (text) => {
    const { container, root } = mountedRoot()
    try {
      await act(async () => {
        root.render(<ChatBubble message={assistantMessage({ text })} streamScopeId="scope-a" />)
      })
      expect(container.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain(text)
      expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull()
      expect(container.querySelector('[aria-label="Assistant message actions"]')).toBeNull()
      await act(async () => {
        useAssistantStreamStore.getState().begin('assistant-1', { scopeId: 'scope-a' })
        useAssistantStreamStore.getState().setText('First answer token', { scopeId: 'scope-a' })
      })
      expect(container.textContent).toContain('First answer token')
      expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('renders streaming text from the active assistant scope', async () => {
    const { container, root } = mountedRoot()
    useAssistantStreamStore.getState().begin('assistant-1', { scopeId: 'scope-a' })
    useAssistantStreamStore.getState().setText('Scoped answer in progress', { scopeId: 'scope-a' })
    useAssistantStreamStore.getState().begin('assistant-1', { scopeId: 'scope-b' })
    useAssistantStreamStore.getState().setText('Other scope text', { scopeId: 'scope-b' })

    await act(async () => {
      root.render(<ChatBubble message={assistantMessage()} streamScopeId="scope-a" />)
      await flushReactWork()
    })

    expect(container.textContent).toContain('Scoped answer in progress')
    expect(container.textContent).not.toContain('Saved answer')
    expect(container.textContent).not.toContain('Other scope text')
  })

  it('renders tool-only assistant placeholders as action cards', async () => {
    const { container, root } = mountedRoot()

    await act(async () => {
      root.render(
        <ChatBubble
          message={{
            ...assistantMessage(),
            text: 'Aurora is using a tool.',
            toolCalls: [{
              id: 'tool-1',
              name: 'calendar.search',
              status: 'requires_action',
              riskClass: 'low',
              target: 'This device',
              dataLeavesDevice: false,
              summary: 'Review this action before Aurora continues.',
              auditId: null,
              payloadPreview: { date: 'today' },
              resultPreview: null,
              pendingId: 'pending-1',
            }]
          }}
          streamScopeId="scope-a"
        />
      )
      await flushReactWork()
    })

    expect(container.textContent).toContain('Action needs approval')
    expect(container.textContent).toContain('Approve once')
    expect(container.textContent).not.toContain('Aurora is using a tool.')
  })
})

function assistantMessage(overrides: Partial<AssistantUiMessage> = {}): AssistantUiMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    text: 'Saved answer',
    createdAt: '2026-09-16T00:00:00.000Z',
    status: 'streaming',
    modelLabel: 'Local model',
    providerLabel: 'This device',
    routeLabel: 'Local',
    executionPeerId: null,
    ...overrides,
  }
}

function mountedRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, root: createRoot(container) }
}

async function flushReactWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
