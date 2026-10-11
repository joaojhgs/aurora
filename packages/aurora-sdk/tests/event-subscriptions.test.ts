import { describe, expect, it } from 'vitest'

import {
  createAuroraEvent,
  createEventSubscription,
  EventStreamClient,
  type AuroraEvent,
  type AuroraEventStreamTransport,
  type AuroraEventSubscription,
  type AuroraStreamRequest,
  type AuroraTransportRequest,
  type AuroraTransportResponse
} from '../src/index.js'
import { MeshEventSubscriptionRegistry } from '../src/webrtc/index.js'

describe('Mesh event subscriptions', () => {
  it('accepts exact topic subscriptions and expires them', () => {
    const registry = new MeshEventSubscriptionRegistry({ clock: () => 10 })
    const result = registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-001',
      topics: ['Tooling.ProjectionInvalidated'],
      correlationIds: ['corr-event-001'],
      ttlSeconds: 60
    })

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        acceptedTopics: ['Tooling.ProjectionInvalidated'],
        idempotent: false
      })
    )
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Tooling.ProjectionInvalidated', correlationId: 'corr-event-001', now: 20 })).toBe(true)
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Tooling.ProjectionInvalidated', correlationId: 'nope', now: 20 })).toBe(false)
    expect(registry.unsubscribe('peer-a', 'sub-001')).toBe(true)
    expect(registry.snapshot()).toEqual([])
  })

  it('rejects wildcard topics and enforces peer quotas', () => {
    const registry = new MeshEventSubscriptionRegistry({ maxSubscriptionsPerPeer: 1, clock: () => 10 })
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-001',
        topics: ['Tooling.*'],
        ttlSeconds: 60
      })
    ).toThrow()
    registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-001',
      topics: ['Tooling.ProjectionInvalidated'],
      ttlSeconds: 60
    })
    const second = registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-002',
      topics: ['Orchestrator.Response'],
      correlationIds: ['corr-quota'],
      ttlSeconds: 60
    })
    expect(second.accepted).toBe(false)
  })

  it('requires correlation IDs for Orchestrator.Response and TTS.AudioChunk', () => {
    const registry = new MeshEventSubscriptionRegistry({ clock: () => 10 })
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-required',
        topics: ['Orchestrator.Response'],
        ttlSeconds: 60
      })
    ).toThrow(/correlation_id is required/)
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-tts',
        topics: ['TTS.AudioChunk'],
        ttlSeconds: 60
      })
    ).toThrow(/correlation_id is required/)

    registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-scoped',
      topics: ['Orchestrator.Response'],
      correlationIds: ['corr-event-001'],
      ttlSeconds: 60
    })
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      correlationId: 'corr-event-001',
      now: 20
    })).toBe(true)
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      now: 20
    })).toBe(false)
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      correlationId: '',
      now: 20
    })).toBe(false)
  })

  it('activates an event subscription when ready is awaited before iteration', async () => {
    let subscribeCalls = 0
    let eventPulls = 0
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      request: AuroraStreamRequest<TPayload>
    ) {
      subscribeCalls += 1
      expect(request.stream).toBe('health')
      return createEventSubscription(async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
        eventPulls += 1
        yield healthEvent<TEventPayload>('healthy-1')
        eventPulls += 1
        yield healthEvent<TEventPayload>('healthy-2')
      }(), undefined, Promise.resolve())
    })
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await subscription.ready
    await flushMicrotasks()

    expect(subscribeCalls).toBe(1)
    expect(eventPulls).toBe(1)

    const iterator = subscription[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual(expect.objectContaining({
      done: false,
      value: expect.objectContaining({ kind: 'health.updated' })
    }))
    subscription.close('test-complete')
  })

  it('closes an activated event subscription without requiring iteration', async () => {
    let underlyingClosed = false
    const transport = eventTransport(() =>
      createEventSubscription(async function* () {
        await new Promise(() => undefined)
      }(), () => {
        underlyingClosed = true
      }, Promise.resolve())
    )
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await subscription.ready
    subscription.close('test-close')
    await subscription.closed
    await flushMicrotasks()

    expect(underlyingClosed).toBe(true)
  })

  it('rejects readiness setup failures before iteration begins', async () => {
    let subscribeCalls = 0
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      _request: AuroraStreamRequest<TPayload>
    ) {
      subscribeCalls += 1
      return createEventSubscription(async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
        yield healthEvent<TEventPayload>('unexpected')
      }(), undefined, Promise.reject(new Error('subscription setup failed')))
    })
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await expect(subscription.ready).rejects.toThrow('subscription setup failed')
    expect(subscribeCalls).toBe(1)
    subscription.close('test-cleanup')
  })

  it('does not invoke the transport when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let subscribeCalls = 0
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      _request: AuroraStreamRequest<TPayload>
    ) {
      subscribeCalls += 1
      return createEventSubscription(async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
        yield healthEvent<TEventPayload>('unexpected')
      }())
    })
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth({ signal: controller.signal })

    await expect(subscription.ready).rejects.toThrow('Event stream subscription was closed')
    expect(subscribeCalls).toBe(0)
    subscription.close('test-cleanup')
  })

  it('settles readiness and closes the eventual subscription when closed during subscribe setup', async () => {
    const subscribeDeferred = deferredEventSubscription()
    let underlyingClosed = false
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      _request: AuroraStreamRequest<TPayload>
    ) {
      return subscribeDeferred.promiseFor<TEventPayload>()
    })
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    subscription.close('test-close')
    await subscription.closed
    await expect(subscription.ready).rejects.toThrow('Event stream subscription was closed')

    subscribeDeferred.resolve(createEventSubscription(async function* () {
      await new Promise(() => undefined)
    }(), () => {
      underlyingClosed = true
    }, Promise.resolve()))
    await flushMicrotasks()

    expect(underlyingClosed).toBe(true)
  })

  it('settles reconnecting readiness and closes the eventual subscription when closed during subscribe setup', async () => {
    const subscribeDeferred = deferredEventSubscription()
    let underlyingClosed = false
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      _request: AuroraStreamRequest<TPayload>
    ) {
      return subscribeDeferred.promiseFor<TEventPayload>()
    })
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth({ reconnect: true })
    subscription.close('test-close')
    await subscription.closed
    await expect(subscription.ready).rejects.toThrow('Event stream subscription was closed')

    subscribeDeferred.resolve(createEventSubscription(async function* () {
      await new Promise(() => undefined)
    }(), () => {
      underlyingClosed = true
    }, Promise.resolve()))
    await flushMicrotasks()

    expect(underlyingClosed).toBe(true)
  })

  it('rejects reconnecting readiness when closed during initial retry backoff', async () => {
    const originalRandom = Math.random
    Math.random = () => 0.999
    try {
      let subscribeCalls = 0
      const transport = eventTransport(() => {
        subscribeCalls += 1
        throw new Error('initial subscribe failed')
      })
      const events = new EventStreamClient(transport)

      const subscription = events.watchHealth({
        reconnect: { maxAttempts: 3, initialDelayMs: 10_000, maxDelayMs: 10_000 }
      })
      await flushMicrotasks()
      expect(subscribeCalls).toBe(1)

      subscription.close('test-close')
      await subscription.closed
      await expect(subscription.ready).rejects.toThrow('Event stream subscription was closed')
    } finally {
      Math.random = originalRandom
    }
  })

  it('settles readiness and closes the underlying subscription when closed during ready setup', async () => {
    const readyDeferred = deferred<void>()
    let underlyingClosed = false
    const transport = eventTransport(() =>
      createEventSubscription(async function* () {
        await new Promise(() => undefined)
      }(), () => {
        underlyingClosed = true
      }, readyDeferred.promise)
    )
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await flushMicrotasks()
    subscription.close('test-close')
    await subscription.closed
    await expect(subscription.ready).rejects.toThrow('Event stream subscription was closed')
    readyDeferred.resolve()
    await flushMicrotasks()

    expect(underlyingClosed).toBe(true)
  })

  it('returns a no-op native resume cleanup when no native resume subscriber is configured', async () => {
    const events = new EventStreamClient(eventTransport(() => {
      throw new Error('stream transport should not be used')
    }))
    let listenerCalls = 0

    const cleanup = await events.subscribeNativeResume(() => {
      listenerCalls += 1
    })
    await cleanup()

    expect(listenerCalls).toBe(0)
  })

  it('forwards native resume listener registration and cleanup through the injected subscriber', async () => {
    let registeredListener: (() => void) | null = null
    let cleanupCalls = 0
    const events = new EventStreamClient(
      eventTransport(() => {
        throw new Error('stream transport should not be used')
      }),
      undefined,
      undefined,
      async (listener) => {
        registeredListener = listener
        return async () => {
          cleanupCalls += 1
        }
      }
    )
    let resumeCalls = 0

    const cleanup = await events.subscribeNativeResume(() => {
      resumeCalls += 1
    })
    const listener = registeredListener as (() => void) | null
    expect(listener).not.toBeNull()
    listener?.()
    await cleanup()

    expect(resumeCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
  })

  it('surfaces native resume registration errors to direct callers', async () => {
    const events = new EventStreamClient(
      eventTransport(() => {
        throw new Error('stream transport should not be used')
      }),
      undefined,
      undefined,
      async () => {
        throw new Error('resume registration failed')
      }
    )

    await expect(events.subscribeNativeResume(() => undefined)).rejects.toThrow('resume registration failed')
  })

  it('handles rejecting iterator cleanup when closed without consuming', async () => {
    let closeCalls = 0
    const transport = eventTransport(() =>
      createEventSubscription(async function* () {
        await new Promise(() => undefined)
      }(), () => {
        closeCalls += 1
        throw new Error('iterator cleanup failed')
      }, Promise.resolve())
    )
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await subscription.ready
    expect(() => subscription.close('test-close')).not.toThrow()
    await subscription.closed
    await flushMicrotasks()

    expect(closeCalls).toBe(1)
  })

  it('preserves falsy prefetch errors for the consumer', async () => {
    const transport = eventTransport(() =>
      createEventSubscription(async function* () {
        throw null
      }(), undefined, Promise.resolve())
    )
    const events = new EventStreamClient(transport)

    const subscription = events.watchHealth()
    await subscription.ready
    const iterator = subscription[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBeNull()
  })
})

function healthEvent<TEventPayload = unknown>(status: string) {
  return createAuroraEvent<TEventPayload>('health.updated', { status } as TEventPayload, { transport: 'mock' })
}

function deferredEventSubscription() {
  const pending = deferred<AuroraEventSubscription<unknown>>()
  return {
    promiseFor<TEventPayload = unknown>(): Promise<AuroraEventSubscription<TEventPayload>> {
      return pending.promise as Promise<AuroraEventSubscription<TEventPayload>>
    },
    resolve(subscription: AuroraEventSubscription<unknown>): void {
      pending.resolve(subscription)
    },
    reject(error: unknown): void {
      pending.reject(error)
    }
  }
}

describe('Gateway status event streams', () => {
  it('uses the status topic and preserves the typed projection payload', async () => {
    const requests: AuroraStreamRequest[] = []
    const transport = eventTransport(function subscribe<TEventPayload = unknown, TPayload = unknown>(
      request: AuroraStreamRequest<TPayload>
    ) {
      requests.push(request)
      return createEventSubscription(async function* (): AsyncIterable<AuroraEvent<TEventPayload>> {
        yield createAuroraEvent<TEventPayload>('config.updated', {
          event_id: 'status-1',
          timestamp: '2026-09-17T00:00:00Z',
          kind: 'config.updated',
          status: 'updated',
          freshness: 'current'
        } as TEventPayload, { transport: 'mock', eventKind: 'config.updated', busTopic: 'Gateway.StatusChanged' })
      }())
    })
    const client = new EventStreamClient(transport)
    const subscription = client.watchConfig()
    await subscription.ready
    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: expect.objectContaining({
        kind: 'config.updated',
        payload: expect.objectContaining({ event_id: 'status-1', status: 'updated', freshness: 'current' })
      })
    })
    expect(requests[0]).toMatchObject({ topics: ['Gateway.StatusChanged'], kinds: ['config.updated', 'config.validation_failed'] })
    subscription.close('test-complete')
  })
})

function eventTransport(
  subscribe: AuroraEventStreamTransport['subscribe']
): AuroraEventStreamTransport {
  return {
    kind: 'mock',
    async request<TData = unknown, TPayload = unknown>(
      _request: AuroraTransportRequest<TPayload>
    ): Promise<AuroraTransportResponse<TData>> {
      return { data: {} as TData }
    },
    subscribe
  }
}

async function flushMicrotasks(cycles = 3): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
  }
}

function deferred<TValue>(): {
  promise: Promise<TValue>
  resolve(value: TValue | PromiseLike<TValue>): void
  reject(error: unknown): void
} {
  let resolvePromise: (value: TValue | PromiseLike<TValue>) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  }
}
