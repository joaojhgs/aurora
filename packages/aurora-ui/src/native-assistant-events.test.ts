import { describe, expect, it } from 'vitest'
import type { AuroraEvent, AuditReceipt } from '@aurora/client'
import {
  isNativeAssistantSubjectSnapshot,
  isNativeAssistantTerminalEvent,
  nativeAssistantEventIdentity,
  nativeAssistantEventPersisted,
  nativeAssistantPendingTurnDecision,
  nativeAssistantSnapshotRecoveryDecision,
  nativeAssistantEventToStreamUpdate,
  nativeAssistantSubjectSnapshotToEvent
} from './native-assistant-events'

describe('native assistant event adapter', () => {
  it('maps native assistant deltas onto the foreground stream update shape', () => {
    const event = nativeEvent('assistant.delta', {
      generation: 17,
      conversationId: 'conversation-a',
      requestId: 'request-a',
      transcript: 'What is on my calendar?',
      textDelta: 'You have ',
      modelLabel: 'local-model'
    })

    expect(nativeAssistantEventIdentity(event)).toEqual({
      key: 'generation:17',
      generation: 17,
      requestId: 'request-a',
      conversationId: 'conversation-a',
      transcript: 'What is on my calendar?'
    })
    expect(nativeAssistantEventToStreamUpdate(event)).toMatchObject({
      kind: 'delta',
      sessionId: 'conversation-a',
      requestId: 'request-a',
      textDelta: 'You have ',
      modelLabel: 'local-model'
    })
  })


  it('maps native hub observation payloads onto the foreground stream update shape', () => {
    const event = nativeEvent('assistant.delta', {
      requestId: 'request-nested',
      peerId: 'peer-a',
      observation: {
        conversationId: 'conversation-nested',
        transcript: 'Summarize this',
        textDelta: 'Here is ',
        modelLabel: 'native-model'
      }
    })

    expect(nativeAssistantEventIdentity(event)).toEqual({
      key: 'request:request-nested',
      generation: null,
      requestId: 'request-nested',
      conversationId: 'conversation-nested',
      transcript: 'Summarize this'
    })
    expect(nativeAssistantEventToStreamUpdate(event)).toMatchObject({
      kind: 'delta',
      sessionId: 'conversation-nested',
      requestId: 'request-nested',
      textDelta: 'Here is ',
      modelLabel: 'native-model'
    })
  })

  it('maps terminal completion events and exposes persistence state for one-time reconciliation', () => {
    const event = nativeEvent('assistant.completed', {
      generation: 18,
      conversation_id: 'conversation-b',
      request_id: 'request-b',
      assistant_text: 'Done.',
      persisted: true
    })

    expect(isNativeAssistantTerminalEvent(event)).toBe(true)
    expect(nativeAssistantEventPersisted(event)).toBe(true)
    expect(nativeAssistantEventToStreamUpdate(event)).toMatchObject({
      kind: 'completed',
      text: 'Done.',
      sessionId: 'conversation-b',
      requestId: 'request-b'
    })
  })


  it('converts bounded native subject snapshots into authoritative assistant events', () => {
    const subject = {
      subject: 'request-snapshot',
      kind: 'assistant.delta',
      generation: 21,
      requestId: 'request-snapshot',
      conversationId: 'conversation-snapshot',
      transcript: 'Continue',
      accumulatedText: 'Current answer text',
      status: 'streaming',
      terminal: false,
      persisted: false,
      updatedAt: '2026-09-16T00:00:01.000Z'
    }

    expect(isNativeAssistantSubjectSnapshot(subject)).toBe(true)
    const event = nativeAssistantSubjectSnapshotToEvent(subject)
    expect(event).toMatchObject({
      id: 'native:snapshot:request-snapshot',
      kind: 'assistant.delta',
      payload: {
        generation: 21,
        requestId: 'request-snapshot',
        conversationId: 'conversation-snapshot',
        accumulatedText: 'Current answer text',
        text: 'Current answer text',
        transcript: 'Continue'
      }
    })
    expect(nativeAssistantEventIdentity(event)).toMatchObject({
      key: 'generation:21',
      transcript: 'Continue'
    })
    expect(nativeAssistantEventToStreamUpdate(event)).toMatchObject({
      kind: 'delta',
      sessionId: 'conversation-snapshot',
      requestId: 'request-snapshot',
      text: 'Current answer text',
      textDelta: 'Current answer text'
    })
  })


  it('keeps a provisional native turn when the real conversation id arrives later', () => {
    const started = nativeEvent('voice.turn.started', {
      generation: 31,
      requestId: 'request-provisional',
      transcript: 'Start a note'
    })
    const startedIdentity = nativeAssistantEventIdentity(started)!
    const firstDecision = nativeAssistantPendingTurnDecision({
      activeConversationId: null,
      identity: startedIdentity,
      existing: null
    })

    expect(firstDecision).toEqual({
      accepted: true,
      pendingId: 'request-provisional',
      conversationId: null
    })

    const assigned = nativeEvent('assistant.delta', {
      generation: 31,
      requestId: 'request-provisional',
      conversationId: 'conversation-real',
      accumulatedText: 'Writing',
      textDelta: 'Writing'
    })
    const assignedIdentity = nativeAssistantEventIdentity(assigned)!
    const assignedDecision = nativeAssistantPendingTurnDecision({
      activeConversationId: 'request-provisional',
      identity: assignedIdentity,
      existing: {
        pendingId: 'request-provisional',
        conversationId: null,
        transcript: 'Start a note'
      }
    })

    expect(assignedDecision).toEqual({
      accepted: true,
      pendingId: 'request-provisional',
      conversationId: 'conversation-real'
    })

    const persisted = nativeEvent('assistant.completed', {
      generation: 31,
      requestId: 'request-provisional',
      conversationId: 'conversation-real',
      assistantText: 'Note saved.',
      persisted: true
    })

    expect(nativeAssistantEventIdentity(persisted)).toMatchObject({
      key: 'generation:31',
      conversationId: 'conversation-real'
    })
    expect(nativeAssistantEventToStreamUpdate(persisted)).toMatchObject({
      kind: 'completed',
      sessionId: 'conversation-real',
      requestId: 'request-provisional',
      text: 'Note saved.'
    })
  })

  it('rejects a new provisional native turn while another conversation is selected', () => {
    const event = nativeEvent('voice.turn.started', {
      generation: 34,
      requestId: 'request-provisional-other',
      transcript: 'Background prompt without conversation yet'
    })
    const identity = nativeAssistantEventIdentity(event)!

    expect(nativeAssistantPendingTurnDecision({
      activeConversationId: 'conversation-selected',
      identity,
      existing: null
    })).toEqual({
      accepted: false,
      pendingId: null,
      conversationId: null
    })
  })

  it('rejects a native turn for another selected conversation before changing foreground state', () => {
    const event = nativeEvent('assistant.delta', {
      generation: 32,
      requestId: 'request-other',
      conversationId: 'conversation-other',
      textDelta: 'Other answer'
    })
    const identity = nativeAssistantEventIdentity(event)!

    expect(nativeAssistantPendingTurnDecision({
      activeConversationId: 'conversation-selected',
      identity,
      existing: null
    })).toEqual({
      accepted: false,
      pendingId: null,
      conversationId: 'conversation-other'
    })
  })

  it('rejects an existing native turn when the selected conversation is unrelated', () => {
    const event = nativeEvent('assistant.delta', {
      generation: 33,
      requestId: 'request-existing',
      conversationId: 'conversation-existing',
      textDelta: 'Existing answer'
    })
    const identity = nativeAssistantEventIdentity(event)!

    expect(nativeAssistantPendingTurnDecision({
      activeConversationId: 'conversation-selected',
      identity,
      existing: {
        pendingId: 'request-existing',
        conversationId: 'conversation-existing',
        transcript: 'Existing prompt'
      }
    })).toEqual({
      accepted: false,
      pendingId: null,
      conversationId: 'conversation-existing'
    })
  })


  it('does not acknowledge a native snapshot without relevant authoritative state', () => {
    expect(nativeAssistantSnapshotRecoveryDecision(false)).toBeUndefined()
    expect(nativeAssistantSnapshotRecoveryDecision(true)).toEqual({
      recovered: true,
      replayEvents: false
    })
  })

  it('does not convert native TTS events into playback updates', () => {
    expect(nativeAssistantEventToStreamUpdate(nativeEvent('tts.audio_chunk', {
      generation: 19,
      audioData: 'abc123'
    }))).toBeNull()
  })

  it('maps redacted tool events without raw argument fields', () => {
    const event = nativeEvent('tool.completed', {
      generation: 20,
      name: 'calendar.search',
      status: 'completed',
      summary: 'Calendar checked.',
      payloadPreview: { date: 'today' },
      resultPreview: { count: 2 },
      dataLeavesDevice: false
    })

    expect(nativeAssistantEventToStreamUpdate(event)).toMatchObject({
      kind: 'tool',
      tool: {
        name: 'calendar.search',
        status: 'completed',
        summary: 'Calendar checked.',
        payloadPreview: { date: 'today' },
        resultPreview: { count: 2 },
        dataLeavesDevice: false
      }
    })
  })
})

function nativeEvent(kind: string, payload: Record<string, unknown>): AuroraEvent<unknown> {
  return {
    id: `native:${payload.generation ?? kind}`,
    kind,
    topic: null,
    method: null,
    busTopic: null,
    payload,
    audit: auditForNativeAssistantTest({ correlationId: typeof payload.requestId === 'string' ? payload.requestId : null }),
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'transport',
      warnings: []
    },
    receivedAt: '2026-09-16T00:00:00.000Z'
  }
}

function auditForNativeAssistantTest(overrides: Partial<AuditReceipt> = {}): AuditReceipt {
  return {
    correlationId: null,
    eventKind: null,
    peerId: null,
    principalId: null,
    targetPeerId: null,
    method: null,
    busTopic: null,
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'native',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'transport',
      warnings: []
    },
    ...overrides
  }
}
