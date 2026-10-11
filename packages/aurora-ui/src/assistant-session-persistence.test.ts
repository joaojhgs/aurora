// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  loadAssistantSession,
  persistAssistantSession,
  type AssistantSessionSnapshot,
} from './assistant-session-persistence'

describe('assistant session persistence', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('round-trips valid assistant sessions through browser storage', () => {
    const session: AssistantSessionSnapshot = {
      sessionId: 'session-a',
      messages: [{
        id: 'message-a',
        role: 'assistant',
        text: 'Saved answer',
        createdAt: '2026-09-16T10:00:00.000Z',
        status: 'sent'
      }]
    }

    persistAssistantSession('assistant:test', session)

    expect(loadAssistantSession('assistant:test')).toEqual(session)
  })

  it('drops invalid stored messages and falls back to an empty session for bad storage', () => {
    window.localStorage.setItem('assistant:test', JSON.stringify({
      sessionId: 7,
      messages: [
        { id: 'valid', role: 'user', text: 'Hello', createdAt: '2026-09-16T10:00:00.000Z', status: 'sent' },
        { id: 'invalid', role: 'assistant', text: 'Missing status', createdAt: '2026-09-16T10:00:00.000Z' }
      ]
    }))

    expect(loadAssistantSession('assistant:test')).toEqual({
      sessionId: null,
      messages: [{ id: 'valid', role: 'user', text: 'Hello', createdAt: '2026-09-16T10:00:00.000Z', status: 'sent' }]
    })

    window.localStorage.setItem('assistant:test', '{bad json')
    expect(loadAssistantSession('assistant:test')).toEqual({ sessionId: null, messages: [] })
  })
})
