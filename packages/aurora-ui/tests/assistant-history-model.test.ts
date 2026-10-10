import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assistantConversationRows,
  enrichLatestLocalAssistantMessage,
  preserveActiveAssistantTurnIds,
  updateLocalConversationRowTitle
} from '../src/use-assistant-history'
import {
  formatSessionActivity,
  localAssistantMessageStatus,
  preserveActiveAssistantTurn
} from '../src/assistant-history-model'
import type { AssistantUiMessage } from '../src/assistant-view'

describe('assistant history model extraction', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps mock conversation rows stable for the public history facade', () => {
    const rows = assistantConversationRows({ sessionId: 'draft-launch', messages: [] } as any, [], 'mock')

    expect(rows.map((row) => [row.id, row.title, row.route, row.updated, row.active])).toEqual([
      ['draft-launch', 'Plan a weekend trip', 'This device', '2m ago', true],
      ['quarterly', 'Summarize a reading list', 'Connected device', '1h ago', false],
      ['mesh-notes', 'Prepare a grocery list', 'Connected device', '5h ago', false],
      ['journal', 'Personal journal reflection', 'This device', 'yesterday', false]
    ])
  })

  it('formats stored conversation rows and updates only untitled active rows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'))
    const rows = assistantConversationRows(
      { sessionId: 'conversation-2', messages: [] } as any,
      [
        { id: 'conversation-1', title: 'Named chat', type: 'local', updated_at: '2026-01-01T00:09:10.000Z', message_count: 1 },
        { id: 'conversation-2', title: '   ', type: 'remote', updated_at: '2026-01-01T00:05:00.000Z', message_count: 3 }
      ] as any,
      'tauri-local'
    )

    expect(rows).toEqual([
      expect.objectContaining({ id: 'conversation-1', title: 'Named chat', route: 'Local', updated: 'now · 1 message', active: false }),
      expect.objectContaining({ id: 'conversation-2', title: 'New chat', route: 'Remote', updated: '5m ago · 3 messages', active: true })
    ])

    const updated = updateLocalConversationRowTitle(rows, 'conversation-2', [
      message('user-1', 'user', '  Please summarize this very long conversation title with more than sixty four characters for persistence  ')
    ])

    expect(updated.find((row) => row.id === 'conversation-1')?.title).toBe('Named chat')
    expect(updated.find((row) => row.id === 'conversation-2')?.title).toBe('Please summarize this very long conversation title with more…')
  })

  it('enriches the latest local assistant message without touching earlier turns', () => {
    const messages = [
      message('user-1', 'user', 'Question'),
      message('assistant-1', 'assistant', 'Old answer'),
      message('assistant-2', 'assistant', '')
    ]

    expect(enrichLatestLocalAssistantMessage(messages, {
      text: 'Finished answer',
      modelLabel: 'Local model',
      providerLabel: 'This device',
      routeLabel: 'This device'
    })).toEqual([
      messages[0],
      messages[1],
      expect.objectContaining({
        id: 'assistant-2',
        text: 'Finished answer',
        modelLabel: 'Local model',
        providerLabel: 'This device',
        routeLabel: 'This device',
        executionPeerId: null
      })
    ])
  })

  it('preserves active turn ids across persisted local reloads', () => {
    const persisted = [
      message('stored-user', 'user', 'Prompt'),
      message('stored-assistant', 'assistant', 'Answer')
    ]
    const current = [
      message('active-user', 'user', 'Prompt'),
      message('pending-assistant', 'assistant', '')
    ]

    expect(preserveActiveAssistantTurnIds(persisted, current, 'pending-assistant')).toEqual([
      expect.objectContaining({ id: 'active-user' }),
      expect.objectContaining({ id: 'pending-assistant' })
    ])
  })

  it('preserves only live approval metadata when a refresh contains the same active turn', () => {
    const storedApproval = {
      id: 'tool-1',
      name: 'Tool',
      status: 'requires_action' as const,
      riskClass: 'review required',
      target: 'This device',
      dataLeavesDevice: false,
      summary: 'Review this action.',
      auditId: null,
      payloadPreview: null,
      localConfirmationToken: null,
      resolving: false,
    }
    const liveApproval = {
      ...storedApproval,
      localConfirmationToken: 'live-token',
      resolving: true,
    }
    const persisted = [
      message('stored-user', 'user', 'Prompt'),
      { ...message('stored-assistant', 'assistant', 'Review this action.'), toolCalls: [storedApproval] },
    ]
    const current = [
      message('active-user', 'user', 'Prompt'),
      { ...message('pending-assistant', 'assistant', 'Review this action.'), toolCalls: [liveApproval] },
    ]

    expect(preserveActiveAssistantTurn(persisted, current)).toEqual([
      expect.objectContaining({ id: 'active-user' }),
      expect.objectContaining({
        id: 'pending-assistant',
        toolCalls: [expect.objectContaining({ localConfirmationToken: 'live-token', resolving: true })],
      }),
    ])
  })

  it('does not remap a newer active turn onto stale persisted history', () => {
    const persisted = [
      message('stored-user', 'user', 'Same prompt'),
      message('stored-assistant', 'assistant', 'Earlier answer'),
    ]
    const current = [
      { ...message('active-user', 'user', 'Same prompt'), createdAt: '2026-01-01T00:01:00.000Z' },
      message('pending-assistant', 'assistant', ''),
    ]

    expect(preserveActiveAssistantTurn(persisted, current)).toBe(current)
  })

  it('leaves persisted replay messages untouched when the active pending turn is absent', () => {
    const persisted = [
      message('stored-user', 'user', 'Prompt'),
      message('stored-assistant', 'assistant', 'Stored answer')
    ]
    const current = [
      message('active-user', 'user', 'Different prompt'),
      message('active-assistant', 'assistant', 'Different active answer')
    ]

    expect(preserveActiveAssistantTurnIds(persisted, current, 'missing-pending-turn')).toBe(persisted)
  })

  it('maps replayed local message terminal statuses without changing public labels', () => {
    expect(localAssistantMessageStatus('complete')).toBe('sent')
    expect(localAssistantMessageStatus('pending')).toBe('sending')
    expect(localAssistantMessageStatus('cancelled')).toBe('cancelled')
    expect(localAssistantMessageStatus('failed')).toBe('failed')
    expect(formatSessionActivity('not a timestamp')).toBe('recently')
  })
})

function message(
  id: string,
  role: AssistantUiMessage['role'],
  text: string
): AssistantUiMessage {
  return {
    id,
    role,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'sent',
    routeLabel: 'This device',
    executionPeerId: null
  }
}
