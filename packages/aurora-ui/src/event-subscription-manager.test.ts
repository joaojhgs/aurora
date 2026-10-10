// @vitest-environment jsdom

import { AuroraError, type AuroraEvent, type AuroraEventSubscription, type AuroraSubscribeOptions } from '@aurora/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventSubscriptionManager } from './event-subscription-manager'

describe('EventSubscriptionManager', () => {
  let manager: EventSubscriptionManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new EventSubscriptionManager({ maxTopics: 2, leaseTtlMs: 50, reconnectDelayMs: 25 })
  })

  afterEach(() => {
    manager.closeAll('test cleanup')
    vi.useRealTimers()
  })

  it('dedupes equivalent leases and closes only after the final release', async () => {
    const subscriptions: ControlledSubscription[] = []
    const receivedA: string[] = []
    const receivedB: string[] = []
    const open = vi.fn((options: AuroraSubscribeOptions & { signal: AbortSignal }) => {
      const subscription = new ControlledSubscription(options)
      subscriptions.push(subscription)
      return subscription
    })

    const leaseA = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: (event) => receivedA.push(event.id ?? 'missing'),
    })
    const leaseB = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: (event) => receivedB.push(event.id ?? 'missing'),
    })

    await flush()
    subscriptions[0]!.push(shellEvent('health-1', 'service.announced'))
    await flush()

    expect(open).toHaveBeenCalledTimes(1)
    expect(manager.activeSubscriptionCount()).toBe(1)
    expect(receivedA).toEqual(['health-1'])
    expect(receivedB).toEqual(['health-1'])

    leaseA.release()
    expect(subscriptions[0]!.closeReasons).toEqual([])
    leaseB.release()
    expect(subscriptions[0]!.closeReasons).toContain('last listener released')
    expect(manager.activeSubscriptionCount()).toBe(0)
  })

  it('shares equivalent topic sets without depending on caller order', () => {
    const subscriptions: ControlledSubscription[] = []
    const open = vi.fn((options: AuroraSubscribeOptions & { signal: AbortSignal }) => {
      const subscription = new ControlledSubscription(options)
      subscriptions.push(subscription)
      return subscription
    })

    const leaseA = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      kinds: ['service.announced', 'service.stale'],
      open,
      onEvent: () => undefined,
    })
    const leaseB = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      kinds: ['service.stale', 'service.announced'],
      open,
      onEvent: () => undefined,
    })

    expect(open).toHaveBeenCalledTimes(1)
    expect(manager.activeTopicCount()).toBe(1)

    leaseA.release()
    expect(subscriptions[0]!.closeReasons).toEqual([])
    leaseB.release()
    expect(subscriptions[0]!.closeReasons).toContain('last listener released')
  })

  it('keeps a shared listener connecting until the underlying subscription is ready', async () => {
    const ready = deferred<void>()
    const open = vi.fn((options: AuroraSubscribeOptions & { signal: AbortSignal }) => new ControlledSubscription(options, ready.promise))
    const statusesA: string[] = []
    const statusesB: string[] = []

    const leaseA = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: () => undefined,
      onStatus: (status) => statusesA.push(status),
    })
    const leaseB = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: () => undefined,
      onStatus: (status) => statusesB.push(status),
    })

    await flush()
    expect(statusesA).toEqual(['connecting'])
    expect(statusesB).toEqual(['connecting'])

    ready.resolve(undefined)
    await flush()
    expect(statusesA).toEqual(['connecting', 'connected'])
    expect(statusesB).toEqual(['connecting', 'connected'])

    leaseA.release()
    leaseB.release()
  })

  it('enforces exact topic enumeration and the active topic quota', () => {
    const open = vi.fn(() => new ControlledSubscription())

    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'bad', topics: ['Gateway.*'], open, onEvent: () => undefined })).toThrow(/exact Aurora event topic/u)
    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'bad', topics: ['TTS.+'], open, onEvent: () => undefined })).toThrow(/exact Aurora event topic/u)
    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'bad', topics: ['Gateway.#'], open, onEvent: () => undefined })).toThrow(/exact Aurora event topic/u)
    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'bad', topics: ['Gateway@Health'], open, onEvent: () => undefined })).toThrow(/exact Aurora event topic/u)
    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'bad', topics: [], open, onEvent: () => undefined })).toThrow(/explicitly enumerated/u)

    const first = manager.acquire({ scopeId: 'scope-a', stream: 'health', topics: ['Gateway.StatusChanged'], open, onEvent: () => undefined })
    const second = manager.acquire({ scopeId: 'scope-a', stream: 'config', topics: ['Gateway.StatusChanged'], open, onEvent: () => undefined })
    expect(manager.activeTopicCount()).toBe(1)
    expect(() => manager.acquire({ scopeId: 'scope-a', stream: 'services', topics: ['TTS.AudioChunk', 'Orchestrator.Response'], open, onEvent: () => undefined })).toThrow(/quota/u)
    first.release()
    second.release()
  })

  it('renews the underlying subscription at TTL using the last event cursor', async () => {
    const subscriptions: ControlledSubscription[] = []
    const options: Array<AuroraSubscribeOptions & { signal: AbortSignal }> = []
    const open = vi.fn((requestOptions: AuroraSubscribeOptions & { signal: AbortSignal }) => {
      options.push(requestOptions)
      const subscription = new ControlledSubscription(requestOptions)
      subscriptions.push(subscription)
      return subscription
    })

    const lease = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      lastEventId: null,
      open,
      onEvent: () => undefined,
    })
    await flush()
    subscriptions[0]!.push(shellEvent('health-1', 'service.announced'))
    await flush()

    await vi.advanceTimersByTimeAsync(50)
    await flush()

    expect(open).toHaveBeenCalledTimes(2)
    expect(subscriptions[0]!.closeReasons).toContain('event subscription ttl renewal')
    expect(options[1]).toMatchObject({ lastEventId: 'health-1', replayFrom: 'health-1', topics: ['Gateway.StatusChanged'] })
    lease.release()
  })

  it('notifies the acquiring listener when opening fails synchronously', async () => {
    const error = new Error('sync subscribe failed')
    const open = vi.fn(() => { throw error })
    const errors: unknown[] = []
    const statuses: string[] = []

    const lease = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: () => undefined,
      onError: (nextError) => errors.push(nextError),
      onStatus: (status) => statuses.push(status),
    })

    await flush()

    expect(open).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([error])
    expect(statuses).toEqual(['connecting', 'reconnecting'])
    lease.release()
  })

  it.each(['missing scoped subscription capability', 'missing both status capabilities'])('stops status subscriptions for %s without retrying', async (missingCapabilityCase) => {
    const error = new AuroraError({
      code: 'unsupported_feature',
      message: `Gateway status event subscriptions are unsupported: ${missingCapabilityCase}.`
    })
    const open = vi.fn(() => { throw error })
    const errors: unknown[] = []
    const statuses: string[] = []
    const lease = manager.acquire({
      scopeId: 'scope-a',
      stream: 'health',
      topics: ['Gateway.StatusChanged'],
      kinds: ['service.announced', 'service.stale'],
      open,
      onEvent: () => undefined,
      onError: (nextError) => errors.push(nextError),
      onStatus: (status) => statuses.push(status),
      isTerminalError: (nextError) => nextError instanceof AuroraError && nextError.code === 'unsupported_feature'
    })

    await flush()
    await vi.advanceTimersByTimeAsync(100)

    expect(open).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([error])
    expect(statuses).toEqual(['connecting', 'error'])
    lease.release()
  })

  it('resubscribes after a transient close without opening another lease', async () => {
    const subscriptions: ControlledSubscription[] = []
    const options: Array<AuroraSubscribeOptions & { signal: AbortSignal }> = []
    const open = vi.fn((requestOptions: AuroraSubscribeOptions & { signal: AbortSignal }) => {
      options.push(requestOptions)
      const subscription = new ControlledSubscription(requestOptions)
      subscriptions.push(subscription)
      return subscription
    })
    const statuses: string[] = []

    const lease = manager.acquire({
      scopeId: 'scope-a',
      stream: 'config',
      topics: ['Gateway.StatusChanged'],
      open,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
    })
    await flush()
    subscriptions[0]!.push(shellEvent('config-1', 'config.updated'))
    await flush()
    subscriptions[0]!.end()
    await flush()

    expect(statuses).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(25)
    await flush()

    expect(open).toHaveBeenCalledTimes(2)
    expect(options[1]).toMatchObject({ lastEventId: 'config-1', replayFrom: 'config-1' })
    lease.release()
  })
})

class ControlledSubscription implements AuroraEventSubscription {
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  readonly closeReasons: unknown[] = []
  private readonly queued: AuroraEvent[] = []
  private pending: { resolve: (result: IteratorResult<AuroraEvent>) => void; reject: (error: unknown) => void } | null = null
  private ended = false
  private failure: unknown = null
  private resolveClosed: () => void = () => undefined

  constructor(
    readonly options: Partial<AuroraSubscribeOptions & { signal: AbortSignal }> = {},
    ready: Promise<void> = Promise.resolve(),
  ) {
    this.ready = ready
    this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve })
  }

  [Symbol.asyncIterator](): AsyncIterator<AuroraEvent> {
    return this
  }

  next(): Promise<IteratorResult<AuroraEvent>> {
    if (this.failure) return Promise.reject(this.failure)
    const event = this.queued.shift()
    if (event) return Promise.resolve({ done: false, value: event })
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  push(event: AuroraEvent): void {
    if (this.ended) return
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.resolve({ done: false, value: event })
      return
    }
    this.queued.push(event)
  }

  fail(error: unknown): void {
    if (this.ended) return
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.reject(error)
      return
    }
    this.failure = error
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.resolve({ done: true, value: undefined })
    }
    this.resolveClosed()
  }

  close(reason?: unknown): void {
    this.closeReasons.push(reason)
    this.end()
  }
}

function shellEvent(id: string, kind: string): AuroraEvent {
  return {
    id,
    kind,
    topic: null,
    method: null,
    busTopic: null,
    payload: {},
    audit: {
      correlationId: null,
      eventKind: kind,
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: null,
      busTopic: null,
      toolId: null,
      resourceId: null,
      status: null,
      transport: 'mock',
      redaction: { secretsRedacted: true, redactedFields: [], source: 'sdk', warnings: [] }
    },
    redaction: { secretsRedacted: true, redactedFields: [], source: 'sdk', warnings: [] },
    receivedAt: new Date(0).toISOString()
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
