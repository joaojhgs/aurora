import { describe, expect, it, vi } from 'vitest'

import { AuroraClient, AuroraError, EventStreamClient, TauriLocalTransport, type AuroraTransport } from '../src/index.js'
import {
  NATIVE_EVENT_SOURCE,
  normalizeNativeAuroraEvent,
  prepareNativeEventSubscribeRequest,
  type NativeEventSubjectFilter
} from '../src/native-events.js'

describe('native event SDK source', () => {
  it('routes native subscriptions and snapshots to the optional native event source', async () => {
    const defaultTransport: AuroraTransport = {
      kind: 'mock',
      async request<TData>() {
        return { data: {} as TData }
      }
    }
    const calls: string[] = []
    const nativeTransport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push(command)
        if (command === 'aurora_subscribe') {
          expect(args?.request).toEqual(expect.objectContaining({ source: 'native' }))
          return [{ id: 'native:1', kind: 'assistant.delta', payload: { text: 'native-source' } }]
        }
        if (command === 'aurora_native_event_snapshot') {
          return { events: [], lastSequenceId: 'native:1', replayComplete: true, subjects: [] }
        }
        throw new Error(`Unexpected command ${command}`)
      }
    })
    const events = new EventStreamClient(defaultTransport, undefined, nativeTransport)

    expect((await collectEvents(events.subscribe({ source: 'native', kinds: ['assistant.delta'] }), 1))[0]).toEqual(
      expect.objectContaining({ id: 'native:1' })
    )
    await expect(events.snapshot({ source: 'native', afterSequence: 1 })).resolves.toEqual({
      events: [],
      lastSequenceId: 'native:1',
      replayComplete: true,
      subjects: []
    })
    expect(calls).toEqual(['aurora_subscribe', 'aurora_native_event_snapshot'])
  })

  it('normalizes native bridge events onto the AuroraEvent envelope', () => {
    const event = normalizeNativeAuroraEvent({
      sequence: 42,
      kind: 'assistant.delta',
      topic: 'Native.Assistant',
      payload: { text: 'hello', subject: 'conversation-1' },
      correlation_id: 'corr-native',
      peer_id: 'peer-phone'
    })

    expect(event).toEqual(expect.objectContaining({
      id: 'native:42',
      kind: 'assistant.delta',
      topic: 'Native.Assistant',
      payload: { text: 'hello', subject: 'conversation-1' },
      audit: expect.objectContaining({
        correlationId: 'corr-native',
        peerId: 'peer-phone',
        transport: 'native'
      })
    }))
  })

  it('preserves replay, source, kinds, and subject filters for aurora_subscribe', () => {
    const subject: NativeEventSubjectFilter = { type: 'conversation', id: 'conversation-1' }
    const request = prepareNativeEventSubscribeRequest({
      stream: 'generic',
      topics: [],
      kinds: ['assistant.delta'],
      source: NATIVE_EVENT_SOURCE,
      subject,
      lastEventId: 'native:39',
      replayFrom: 'native:39',
      lastSequenceId: 39,
      backfill: true
    })

    expect(request).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['conversation-1'],
      lastEventId: 'native:39',
      replayFrom: 'native:39',
      lastSequenceId: 39,
      backfill: true
    }))

    expect(prepareNativeEventSubscribeRequest({
      stream: 'generic',
      topics: [],
      kinds: [],
      source: NATIVE_EVENT_SOURCE,
      lastEventId: 'native:39'
    })).toEqual(expect.objectContaining({ lastSequenceId: 39 }))
    expect(prepareNativeEventSubscribeRequest({
      stream: 'generic',
      topics: [],
      kinds: [],
      source: NATIVE_EVENT_SOURCE,
      lastEventId: 'native:gap:40'
    })).toEqual(expect.objectContaining({ lastSequenceId: 39 }))
  })

  it('receives replayed and live native events through TauriLocalTransport with native audit evidence', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const subscribedRequests: unknown[] = []
    const ackedEvents: unknown[] = []
    let activateReady: () => void = () => undefined
    const activated = new Promise<void>((resolve) => {
      activateReady = resolve
    })

    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        expect(command).not.toBe('aurora_sidecar_session')
        if (command === 'aurora_subscribe') {
          subscribedRequests.push(args?.request)
          return { subscriptionId: 'native-sub', eventName: 'aurora://native-events/native-sub' }
        }
        if (command === 'aurora_activate_subscription') {
          activateReady()
          return { activated: true }
        }
        if (command === 'aurora_native_event_ack') {
          ackedEvents.push(args?.request)
          return { acknowledged: true }
        }
        if (command === 'aurora_unsubscribe') return { closed: true }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })
    const client = new AuroraClient({ transport })
    const subscription = client.events.subscribe<Record<string, unknown>>({
      source: 'native',
      kinds: ['assistant.delta'],
      subjects: ['conversation-1'],
      lastEventId: 'native:39',
      lastSequenceId: 39,
      backfill: true
    })

    const eventsPromise = collectEvents(subscription, 2)
    await activated
    listeners.get('aurora://native-events/native-sub')?.({
      event: 'aurora://native-events/native-sub',
      payload: {
        subscriptionId: 'native-sub',
        event: {
          sequence: 40,
          kind: 'assistant.delta',
          payload: { text: 'replayed', subject: 'conversation-1' },
          correlation_id: 'corr-replay'
        }
      }
    })
    await vi.waitFor(() => expect(ackedEvents).toEqual([
      { subscriptionId: 'native-sub', eventId: 'native:40' }
    ]))
    listeners.get('aurora://native-events/native-sub')?.({
      event: 'aurora://native-events/native-sub',
      payload: {
        subscriptionId: 'native-sub',
        event: {
          id: 'native:41',
          kind: 'assistant.completed',
          payload: { subject: 'conversation-1' },
          correlation_id: 'corr-live'
        }
      }
    })

    expect(subscribedRequests[0]).toEqual(expect.objectContaining({
      source: 'native',
      kinds: ['assistant.delta'],
      subjects: ['conversation-1'],
      lastEventId: 'native:39',
      lastSequenceId: 39,
      backfill: true
    }))
    expect(await eventsPromise).toEqual([
      expect.objectContaining({
        id: 'native:40',
        audit: expect.objectContaining({ correlationId: 'corr-replay', transport: 'native' })
      }),
      expect.objectContaining({
        id: 'native:41',
        audit: expect.objectContaining({ correlationId: 'corr-live', transport: 'native' })
      })
    ])
  })

  it('exposes native snapshots through the existing events contract', async () => {
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        expect(command).toBe('aurora_native_event_snapshot')
        expect(args?.request).toEqual(expect.objectContaining({
          kinds: ['assistant.delta'],
          subjects: ['request-1'],
          afterSequence: 7
        }))
        return {
          events: [
            { sequence: 8, kind: 'assistant.delta', payload: { text: 'recovered' } }
          ],
          lastSequenceId: 'native:8',
          replayComplete: true,
          subjects: [{ id: 'request-1', active: true }]
        }
      }
    })
    const client = new AuroraClient({ transport })

    await expect(client.events.snapshot({
      source: 'native',
      kinds: ['assistant.delta'],
      subject: 'request-1',
      afterSequence: 7
    })).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: 'native:8',
          audit: expect.objectContaining({ transport: 'native' })
        })
      ],
      lastSequenceId: 'native:8',
      replayComplete: true,
      subjects: [{ id: 'request-1', active: true }]
    })
  })

  it('closes protocol-violating native floods without synthesizing a guaranteed-event gap', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const unsubscribeRequests: unknown[] = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        if (command === 'aurora_subscribe') return { subscriptionId: 'native-flood', eventName: 'aurora://native-events/flood' }
        if (command === 'aurora_activate_subscription') return { activated: true }
        if (command === 'aurora_native_event_ack') return { acknowledged: true }
        if (command === 'aurora_unsubscribe') {
          unsubscribeRequests.push(args?.request)
          return { closed: true }
        }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })

    const subscription = await transport.subscribe({
      stream: 'generic',
      source: 'native',
      topics: [],
      kinds: ['assistant.delta'],
      subjects: ['request-1'],
      lastEventId: 'native:9'
    })
    const iterator = subscription[Symbol.asyncIterator]()
    const listener = listeners.get('aurora://native-events/flood')
    listener?.({
      event: 'aurora://native-events/flood',
      payload: { subscriptionId: 'native-flood', event: { sequence: 10, kind: 'assistant.delta', payload: {} } }
    })
    listener?.({
      event: 'aurora://native-events/flood',
      payload: { subscriptionId: 'native-flood', event: { sequence: 11, kind: 'assistant.delta', payload: {} } }
    })

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'transport_loss',
      detail: expect.objectContaining({ code: 'native_event_ack_window_exceeded' })
    })
    await vi.waitFor(() => expect(unsubscribeRequests).toEqual([{ subscriptionId: 'native-flood' }]))
  })

  it('closes and unsubscribes when a second native event arrives while the first is yielded but unacknowledged', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const ackedEvents: unknown[] = []
    const unsubscribeRequests: unknown[] = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        if (command === 'aurora_subscribe') return { subscriptionId: 'native-yielded', eventName: 'aurora://native-events/yielded' }
        if (command === 'aurora_activate_subscription') return { activated: true }
        if (command === 'aurora_native_event_ack') {
          ackedEvents.push(args?.request)
          return { acknowledged: true }
        }
        if (command === 'aurora_unsubscribe') {
          unsubscribeRequests.push(args?.request)
          return { closed: true }
        }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })

    const subscription = await transport.subscribe({
      stream: 'generic',
      source: 'native',
      topics: [],
      kinds: ['assistant.delta'],
      subjects: ['request-1'],
      lastEventId: 'native:9'
    })
    const iterator = subscription[Symbol.asyncIterator]()
    const listener = listeners.get('aurora://native-events/yielded')
    listener?.({
      event: 'aurora://native-events/yielded',
      payload: { subscriptionId: 'native-yielded', event: { sequence: 10, kind: 'assistant.delta', payload: {} } }
    })

    const first = await iterator.next()
    expect(first.value).toEqual(expect.objectContaining({ id: 'native:10', kind: 'assistant.delta' }))
    listener?.({
      event: 'aurora://native-events/yielded',
      payload: { subscriptionId: 'native-yielded', event: { sequence: 11, kind: 'assistant.delta', payload: {} } }
    })

    await vi.waitFor(() => expect(unsubscribeRequests).toEqual([{ subscriptionId: 'native-yielded' }]))
    expect(ackedEvents).toEqual([])
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'transport_loss',
      detail: expect.objectContaining({ code: 'native_event_ack_window_exceeded' })
    })
  })

  it('unsubscribes native streams when acknowledgement fails locally', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const unsubscribeRequests: unknown[] = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        if (command === 'aurora_subscribe') return { subscriptionId: 'native-ack-failure', eventName: 'aurora://native-events/ack-failure' }
        if (command === 'aurora_activate_subscription') return { activated: true }
        if (command === 'aurora_native_event_ack') throw new Error('ack failed')
        if (command === 'aurora_unsubscribe') {
          unsubscribeRequests.push(args?.request)
          return { closed: true }
        }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })

    const subscription = await transport.subscribe({
      stream: 'generic',
      source: 'native',
      topics: [],
      kinds: ['assistant.delta'],
      subjects: ['request-1'],
      lastEventId: 'native:9'
    })
    const iterator = subscription[Symbol.asyncIterator]()
    listeners.get('aurora://native-events/ack-failure')?.({
      event: 'aurora://native-events/ack-failure',
      payload: { subscriptionId: 'native-ack-failure', event: { sequence: 10, kind: 'assistant.delta', payload: {} } }
    })

    const first = await iterator.next()
    expect(first.value).toEqual(expect.objectContaining({ id: 'native:10', kind: 'assistant.delta' }))
    try {
      await iterator.next()
      throw new Error('Expected acknowledgement failure')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'transport_loss',
        message: 'Native event acknowledgement failed',
        detail: expect.objectContaining({
          eventId: 'native:10',
          secretsRedacted: true
        })
      })
      expect(error).not.toMatchObject({ message: 'ack failed' })
    }
    await vi.waitFor(() => expect(unsubscribeRequests).toEqual([{ subscriptionId: 'native-ack-failure' }]))
  })

  it('preserves classified native acknowledgement failures', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const unsubscribeRequests: unknown[] = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        if (command === 'aurora_subscribe') return { subscriptionId: 'native-ack-permission', eventName: 'aurora://native-events/ack-permission' }
        if (command === 'aurora_activate_subscription') return { activated: true }
        if (command === 'aurora_native_event_ack') {
          throw new AuroraError({
            code: 'permission',
            message: 'Native event acknowledgement denied',
            method: 'aurora_native_event_ack',
            detail: { secretsRedacted: true }
          })
        }
        if (command === 'aurora_unsubscribe') {
          unsubscribeRequests.push(args?.request)
          return { closed: true }
        }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })

    const subscription = await transport.subscribe({
      stream: 'generic',
      source: 'native',
      topics: [],
      kinds: ['assistant.delta'],
      subjects: ['request-1']
    })
    const iterator = subscription[Symbol.asyncIterator]()
    listeners.get('aurora://native-events/ack-permission')?.({
      event: 'aurora://native-events/ack-permission',
      payload: { subscriptionId: 'native-ack-permission', event: { sequence: 11, kind: 'assistant.delta', payload: {} } }
    })

    const first = await iterator.next()
    expect(first.value).toEqual(expect.objectContaining({ id: 'native:11', kind: 'assistant.delta' }))
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'permission',
      message: 'Native event acknowledgement denied',
      method: 'aurora_native_event_ack'
    })
    await vi.waitFor(() => expect(unsubscribeRequests).toEqual([{ subscriptionId: 'native-ack-permission' }]))
  })

  it('acks native events only when the iterator advances and keeps delivery lossless under the bridge window', async () => {
    const listeners = new Map<string, (event: { event: string; payload: unknown }) => void>()
    const ackedEvents: unknown[] = []
    let resolveAck: () => void = () => undefined
    let activateReady: () => void = () => undefined
    const activated = new Promise<void>((resolve) => {
      activateReady = resolve
    })
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        if (command === 'aurora_subscribe') return { subscriptionId: 'native-window', eventName: 'aurora://native-events/window' }
        if (command === 'aurora_activate_subscription') {
          activateReady()
          return { activated: true }
        }
        if (command === 'aurora_native_event_ack') {
          ackedEvents.push(args?.request)
          return new Promise((resolve) => {
            resolveAck = () => resolve({ acknowledged: true })
          })
        }
        if (command === 'aurora_unsubscribe') return { closed: true }
        throw new Error(`Unexpected command ${command}`)
      },
      listen: async (event, handler) => {
        listeners.set(event, handler as (event: { event: string; payload: unknown }) => void)
        return () => listeners.delete(event)
      }
    })

    const subscription = await transport.subscribe({
      stream: 'generic',
      source: 'native',
      topics: [],
      kinds: ['assistant.delta'],
      subjects: ['request-1'],
      lastEventId: 'native:9'
    })
    const iterator = subscription[Symbol.asyncIterator]()
    await activated
    listeners.get('aurora://native-events/window')?.({
      event: 'aurora://native-events/window',
      payload: {
        subscriptionId: 'native-window',
        event: { sequence: 10, kind: 'assistant.delta', payload: { text: 'first' } }
      }
    })

    const first = await iterator.next()
    expect(first.value).toEqual(expect.objectContaining({ id: 'native:10', kind: 'assistant.delta' }))
    expect(ackedEvents).toEqual([])

    const secondRead = iterator.next()
    await vi.waitFor(() => expect(ackedEvents).toEqual([
      { subscriptionId: 'native-window', eventId: 'native:10' }
    ]))
    listeners.get('aurora://native-events/window')?.({
      event: 'aurora://native-events/window',
      payload: {
        subscriptionId: 'native-window',
        event: { sequence: 11, kind: 'assistant.completed', payload: { text: 'second' } }
      }
    })
    resolveAck()

    const second = await secondRead
    expect(second.value).toEqual(expect.objectContaining({ id: 'native:11', kind: 'assistant.completed' }))
    expect(second.value).not.toEqual(expect.objectContaining({ kind: 'native.events.gap' }))
    subscription.close?.()
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
