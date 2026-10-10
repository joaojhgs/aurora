import { describe, expect, it } from 'vitest'

import {
  EventStreamClient,
  ORCHESTRATOR_METHODS,
  TauriLocalTransport,
  createEventSubscription,
  eventFromUnknown,
  type AuroraEvent,
  type AuroraEventStreamTransport,
  type AuroraStreamRequest,
  type AuroraTransportResponse
} from '../src/index.js'
import { normalizeSnapshotRequest } from '../src/events.js'
import {
  createNativeEventGap,
  nativeEventSequenceNumber,
  normalizeNativeAuroraEvent,
  prepareNativeEventSubscribeRequest
} from '../src/native-events.js'

describe('native event transport-envelope conformance', () => {
  it('normalizes native, gateway, and mesh events to the same AuroraEvent envelope fields', () => {
    const raw = {
      id: 'event-42',
      kind: 'assistant.delta',
      topic: ORCHESTRATOR_METHODS.response,
      payload: {
        requestId: 'request-42',
        textDelta: 'hello',
        secretToolArgs: '[redacted]'
      },
      correlation_id: 'corr-42',
      peer_id: 'source-peer',
      target_peer_id: 'target-peer',
      principal_id: 'principal-42',
      bus_topic: ORCHESTRATOR_METHODS.response,
      status: 'streaming',
      secrets_redacted: true,
      redacted_fields: ['payload.secretToolArgs'],
      redaction_warnings: ['payload redacted before SDK normalization']
    }

    const events = [
      {
        source: 'native',
        event: normalizeNativeAuroraEvent(raw),
        transport: 'native'
      },
      {
        source: 'gateway',
        event: eventFromUnknown(raw, {
          kind: 'assistant.delta',
          transport: 'tauri-local',
          audit: { transport: 'tauri-local' }
        }),
        transport: 'tauri-local'
      },
      {
        source: 'mesh',
        event: eventFromUnknown(raw, {
          kind: 'assistant.delta',
          transport: 'mesh',
          audit: { transport: 'mesh', targetPeerId: 'target-peer' }
        }),
        transport: 'mesh'
      }
    ] as const

    for (const { source, event, transport } of events) {
      expect(event, source).toEqual(expect.objectContaining({
        id: 'event-42',
        kind: 'assistant.delta',
        topic: ORCHESTRATOR_METHODS.response,
        busTopic: ORCHESTRATOR_METHODS.response,
        payload: raw.payload,
        receivedAt: expect.any(String),
        audit: expect.objectContaining({
          correlationId: 'corr-42',
          eventKind: 'assistant.delta',
          peerId: 'source-peer',
          principalId: 'principal-42',
          targetPeerId: 'target-peer',
          busTopic: ORCHESTRATOR_METHODS.response,
          status: 'streaming',
          transport,
          redaction: expect.objectContaining({
            secretsRedacted: true,
            redactedFields: ['payload.secretToolArgs'],
            source: 'backend',
            warnings: ['payload redacted before SDK normalization']
          })
        }),
        redaction: expect.objectContaining({
          secretsRedacted: true,
          redactedFields: ['payload.secretToolArgs'],
          source: 'backend',
          warnings: ['payload redacted before SDK normalization']
        })
      }))
      expect(Date.parse(event.receivedAt), source).not.toBeNaN()
      expect(event.redaction, source).toBe(event.audit.redaction)
    }
  })

  it('preserves native sequence ids, gap recovery ids, replay cursors, and subject filters across subscribe and snapshot requests', () => {
    const subscribe = prepareNativeEventSubscribeRequest({
      stream: 'generic',
      source: 'native',
      topics: [ORCHESTRATOR_METHODS.response],
      kinds: ['assistant.delta'],
      subject: { type: 'conversation', id: 'conversation-42' },
      subjects: ['request-42', 'conversation-42'],
      lastEventId: 'native:gap:43',
      replayFrom: 'native:41',
      backfill: true
    })

    expect(subscribe).toEqual(expect.objectContaining({
      source: 'native',
      topics: [ORCHESTRATOR_METHODS.response],
      kinds: ['assistant.delta'],
      subjects: ['conversation-42', 'request-42'],
      lastSequenceId: 42,
      backfill: true
    }))
    expect(nativeEventSequenceNumber('native:42')).toBe(42)
    expect(nativeEventSequenceNumber('native:gap:43')).toBe(43)
    expect(createNativeEventGap(43, 'native:42')).toEqual(expect.objectContaining({
      id: 'native:gap:43',
      kind: 'native.events.gap',
      payload: expect.objectContaining({
        source: 'native',
        firstMissingSequence: 43,
        previousEventId: 'native:42',
        recovery: 'resubscribe',
        reason: 'client_queue_overflow'
      }),
      audit: expect.objectContaining({
        eventKind: 'native.events.gap',
        status: 'client_queue_overflow',
        transport: 'native',
        redaction: expect.objectContaining({ secretsRedacted: true })
      })
    }))

    const snapshot = normalizeSnapshotRequest({
      source: 'native',
      topics: [ORCHESTRATOR_METHODS.response],
      kinds: ['assistant.delta'],
      subjects: ['conversation-42', { type: 'request', id: 'request-42' }],
      afterSequence: 42
    })
    expect(snapshot).toEqual(expect.objectContaining({
      source: 'native',
      topics: [ORCHESTRATOR_METHODS.response],
      kinds: ['assistant.delta'],
      subjects: ['conversation-42', 'request-42'],
      afterSequence: 42
    }))
  })

  it('returns native snapshots with normalized events, cursor, replay completeness, and authoritative subjects through the generic event client', async () => {
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        expect(command).toBe('aurora_native_event_snapshot')
        expect(args?.request).toEqual(expect.objectContaining({
          kinds: ['assistant.delta'],
          subjects: ['conversation-42'],
          afterSequence: 42
        }))
        return {
          events: [
            {
              sequence: 43,
              kind: 'assistant.delta',
              topic: ORCHESTRATOR_METHODS.response,
              payload: { requestId: 'request-42', textDelta: 'recovered' },
              correlation_id: 'corr-43',
              secrets_redacted: true
            }
          ],
          lastSequenceId: 'native:43',
          replayComplete: false,
          subjects: [
            {
              id: 'conversation-42',
              active: true,
              lastSequenceId: 'native:43',
              accumulatedText: 'recovered'
            }
          ]
        }
      }
    })
    const client = new EventStreamClient({
      kind: 'mock',
      async request<TData>(): Promise<AuroraTransportResponse<TData>> {
        return { data: {} as TData }
      }
    }, undefined, transport)

    await expect(client.snapshot({
      source: 'native',
      kinds: ['assistant.delta'],
      subjects: ['conversation-42'],
      afterSequence: 42
    })).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: 'native:43',
          kind: 'assistant.delta',
          topic: ORCHESTRATOR_METHODS.response,
          payload: { requestId: 'request-42', textDelta: 'recovered' },
          audit: expect.objectContaining({
            correlationId: 'corr-43',
            transport: 'native',
            redaction: expect.objectContaining({ secretsRedacted: true })
          }),
          receivedAt: expect.any(String)
        })
      ],
      lastSequenceId: 'native:43',
      replayComplete: false,
      subjects: [
        {
          id: 'conversation-42',
          active: true,
          lastSequenceId: 'native:43',
          accumulatedText: 'recovered'
        }
      ]
    })
  })

  it('keeps native envelope parity when subscriptions reconnect from the last delivered cursor after a gap', async () => {
    const requests: Array<AuroraStreamRequest<unknown>> = []
    const transport: AuroraEventStreamTransport = {
      kind: 'native-conformance',
      async request<TData>(): Promise<AuroraTransportResponse<TData>> {
        return { data: {} as TData }
      },
      subscribe<TEventPayload>(request: AuroraStreamRequest) {
        requests.push(request)
        const source = async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
          if (requests.length === 1) {
            yield createNativeEventGap(43, 'native:42') as AuroraEvent<TEventPayload>
            throw new TypeError('native subscription interrupted after gap')
          }
          yield normalizeNativeAuroraEvent<TEventPayload>({
            sequence: 43,
            kind: 'assistant.delta',
            topic: ORCHESTRATOR_METHODS.response,
            payload: { textDelta: 'after-gap' },
            correlation_id: 'corr-43',
            secrets_redacted: true
          })
        }()
        return createEventSubscription(source)
      }
    }
    const events = new EventStreamClient(transport)

    const subscription = events.subscribe({
      source: 'native',
      kinds: ['assistant.delta'],
      subjects: ['conversation-42'],
      lastEventId: 'native:42',
      reconnect: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }
    })

    await expect(collectEvents(subscription, 2)).resolves.toEqual([
      expect.objectContaining({
        id: 'native:gap:43',
        kind: 'native.events.gap',
        audit: expect.objectContaining({ transport: 'native' })
      }),
      expect.objectContaining({
        id: 'native:43',
        kind: 'assistant.delta',
        audit: expect.objectContaining({ transport: 'native' })
      })
    ])
    expect(requests).toEqual([
      expect.objectContaining({ lastEventId: 'native:42' }),
      expect.objectContaining({ lastEventId: 'native:gap:43' })
    ])
  })
})

async function collectEvents<TPayload>(
  subscription: AsyncIterable<TPayload> & { close?: () => void },
  count: number
): Promise<TPayload[]> {
  const events: TPayload[] = []
  try {
    for await (const event of subscription) {
      events.push(event)
      if (events.length >= count) break
    }
    return events
  } finally {
    subscription.close?.()
  }
}
