import { describe, expect, it } from 'vitest'
import type { AssistantStreamUpdate, DBGetSessionResponse, DBSessionRecord } from '@aurora/client'

import {
  ASSISTANT_RESPONDING_TEXT,
  applyAssistantStreamDelta,
  applyAssistantTerminalUpdate,
  applyAssistantToolUpdate,
  type AssistantUiMessage,
} from './assistant-session-model'
import {
  assistantSessionFromPersisted,
  defaultAssistantSessionForTransport,
  persistedToolStatus,
  sortSessionsByModification,
  upsertSessionByModification,
} from './assistant-session-persistence'

describe('assistant session model', () => {
  it('maps persisted messages and tool metadata into UI messages', () => {
    const snapshot = assistantSessionFromPersisted({
      session: sessionRecord('session-a', '2026-09-16T10:00:00.000Z'),
      messages: [
        {
          id: 'message-a',
          role: 'assistant',
          content: 'Here is the answer.',
          timestamp: '2026-09-16T10:00:01.000Z',
          metadata: {
            model: 'local-model',
            provider_label: 'This device',
            execution: 'local'
          }
        },
        {
          id: 'tool-message',
          role: 'tool',
          text: 'Calendar entry saved.',
          created_at: '2026-09-16T10:00:02.000Z',
          metadata: {
            execution: 'remote',
            execution_peer_name: 'Kitchen laptop',
            session_id: 'session-a',
            tool: {
              id: 'tool-a',
              name: 'calendar.create',
              status: 'approval-required',
              risk_class: 'review required',
              data_leaves_device: true,
              payload_preview: { title: 'Planning' }
            }
          }
        }
      ]
    } as DBGetSessionResponse)

    expect(snapshot.sessionId).toBe('session-a')
    expect(snapshot.messages[0]).toMatchObject({
      id: 'message-a',
      role: 'assistant',
      text: 'Here is the answer.',
      status: 'sent',
      modelLabel: 'local-model',
      providerLabel: 'This device',
      routeLabel: 'Local'
    })
    expect(snapshot.messages[1]?.toolCalls?.[0]).toMatchObject({
      id: 'tool-a',
      name: 'calendar.create',
      sessionId: 'session-a',
      status: 'requires_action',
      target: 'Kitchen laptop',
      dataLeavesDevice: true,
      payloadPreview: { title: 'Planning' }
    })
  })

  it('keeps the latest modified session first when upserting records', () => {
    const older = sessionRecord('older', '2026-09-16T09:00:00.000Z')
    const replaced = sessionRecord('replaced', '2026-09-16T10:00:00.000Z')
    const updated = sessionRecord('replaced', '2026-09-16T11:00:00.000Z')

    expect(upsertSessionByModification([older, replaced], updated).map((session) => session.id)).toEqual(['replaced', 'older'])
    expect(sortSessionsByModification([older, replaced]).map((session) => session.id)).toEqual(['replaced', 'older'])
  })

  it('applies stream, tool, and terminal updates without overwriting cancelled messages', () => {
    const pending = message({ text: ASSISTANT_RESPONDING_TEXT, status: 'streaming' })
    const streamed = applyAssistantStreamDelta(pending, streamUpdate({ textDelta: 'Hello', provider: 'Local provider' }))
    const toolUpdated = applyAssistantToolUpdate(streamed, streamUpdate({
      kind: 'tool',
      text: 'Checking calendar',
      tool: { id: 'tool-a', name: 'calendar.search', status: 'running' }
    }))
    const terminal = applyAssistantTerminalUpdate(toolUpdated, streamUpdate({ kind: 'completed', text: 'Done.' }))
    const cancelled = message({ status: 'cancelled', text: 'Stop.' })

    expect(streamed).toMatchObject({ text: 'Hello', providerLabel: 'Local provider', status: 'streaming' })
    expect(toolUpdated.toolCalls?.[0]).toMatchObject({ id: 'tool-a', status: 'running' })
    expect(terminal).toMatchObject({ text: 'Done.', status: 'sent' })
    expect(applyAssistantStreamDelta(cancelled, streamUpdate({ textDelta: ' ignored' }))).toBe(cancelled)
  })

  it('normalizes persisted tool status and keeps non-mock defaults empty', () => {
    expect(persistedToolStatus('approval-required')).toBe('requires_action')
    expect(persistedToolStatus('failed')).toBe('failed')
    expect(persistedToolStatus('completed')).toBe('completed')
    expect(defaultAssistantSessionForTransport('mesh')).toEqual({ sessionId: null, messages: [] })
    expect(defaultAssistantSessionForTransport('mock').messages.length).toBeGreaterThan(0)
  })
})

function sessionRecord(id: string, updatedAt: string): DBSessionRecord {
  return {
    id,
    principal_id: 'principal-a',
    type: 'assistant',
    title: id,
    created_at: '2026-09-16T08:00:00.000Z',
    updated_at: updatedAt,
    last_active_at: updatedAt,
    message_count: 1
  }
}

function message(overrides: Partial<AssistantUiMessage> = {}): AssistantUiMessage {
  return {
    id: 'assistant-a',
    role: 'assistant',
    text: '',
    createdAt: '2026-09-16T10:00:00.000Z',
    status: 'streaming',
    ...overrides,
  }
}

function streamUpdate(input: {
  kind?: AssistantStreamUpdate['kind']
  text?: string
  textDelta?: string
  provider?: string
  tool?: Partial<NonNullable<AssistantStreamUpdate['tool']>>
} = {}): AssistantStreamUpdate {
  return {
    kind: input.kind ?? 'delta',
    eventId: 'event-a',
    sessionId: 'session-a',
    messageId: 'message-a',
    text: input.text ?? '',
    textDelta: input.textDelta ?? '',
    modelLabel: null,
    metadata: input.provider ? { provider_label: input.provider } : {},
    tool: input.tool ? { id: 'tool-a', name: 'tool.run', status: 'requested', ...input.tool } : null,
    audit: { correlationId: 'audit-a' }
  } as AssistantStreamUpdate
}
