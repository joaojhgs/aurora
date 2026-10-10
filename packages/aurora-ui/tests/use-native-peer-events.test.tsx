// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  AuroraError,
  createAuroraEvent,
  createEventSubscription,
  type AuroraEvent,
  type AuroraEventSubscription,
  type AuroraStreamRequest,
  type AuroraTransport
} from '@aurora/client'

import {
  applyPeerConnectionState,
  useNativePeerEvents,
  type NativePeerConnectionBadgeState,
  type NativePeerConnectionStorePort,
  type NativePeerEventsResult,
  type NativePeerRuntimeSnapshot
} from '../src/use-native-peer-events'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useNativePeerEvents', () => {
  it('bootstraps from the existing runtime peer snapshot without requiring native events', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const snapshots: NativePeerEventsResult[] = []

    function Probe() {
      const state = useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        runtimePeer: runtimePeer({ expectedStablePeerId: 'peer-phone', state: 'authorized' }),
        nativeEventsSupported: false
      })
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)

    expect(transport.requests).toEqual([])
    expect(store.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }]
    ])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      nativeEventsEnabled: false,
      peerId: 'peer-phone',
      scopeId: 'scope-a'
    }))
  })

  it('initializes a replacement connection store for the same scope and runtime state', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const firstStore = createConnectionStore()
    const secondStore = createConnectionStore()
    const runtime = runtimePeer({ expectedStablePeerId: 'peer-phone', state: 'authorized' })

    function Probe({ store }: { store: NativePeerConnectionStorePort }) {
      useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        runtimePeer: runtime,
        nativeEventsSupported: false
      })
      return null
    }

    const root = await render(<Probe store={firstStore} />)
    expect(firstStore.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }]
    ])

    await act(async () => {
      root.render(<Probe store={secondStore} />)
      await flushAsyncWork()
    })

    expect(secondStore.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }]
    ])
  })

  it('subscribes to native mesh peer state and updates only the matching peer badge', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe() {
      useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    await render(<Probe />)
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      source: 'native',
      kinds: ['mesh.peer.state_changed'],
      subjects: ['peer-phone']
    }))

    await act(async () => {
      transport.push(nativePeerEvent('native:1', { peerId: 'peer-other', connected: true, sessions: 1 }))
      transport.push(nativePeerEvent('native:2', { peerId: 'peer-phone', connected: true, sessions: 1 }))
      await flushAsyncWork()
    })

    expect(store.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: 'native:2', error: null }]
    ])
  })

  it('does not mark the badge reconnecting when the native source is unsupported', async () => {
    const unsupported = Object.assign(new Error('Native event source unsupported'), { code: 'unsupported_feature' })
    const client = {
      events: {
        snapshot: vi.fn(async () => { throw unsupported }),
        subscribe: vi.fn()
      }
    } as unknown as Pick<AuroraClient, 'events'>
    const store = createConnectionStore()

    function Probe() {
      useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    await render(<Probe />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(client.events.snapshot).toHaveBeenCalled()
    expect(client.events.subscribe).not.toHaveBeenCalled()
    expect(store.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['disconnected', { peerConnectionScopeId: null, lastEventId: null, error: null }]
    ])
  })

  it('switches mounted peer scopes and rejects delayed writes from the old scope', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe({ peerId, scopeId }: { peerId: string; scopeId: string }) {
      useNativePeerEvents({
        client,
        peerId,
        scopeId,
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    const root = await render(<Probe peerId="peer-a" scopeId="scope-a" />)
    store.calls.splice(0)
    transport.snapshotLastSequenceId = 'native:10'
    transport.snapshotSubjects = [{ subject: 'peer-b', status: 'connected' }]

    await act(async () => {
      root.render(<Probe peerId="peer-b" scopeId="scope-b" />)
      await flushAsyncWork()
    })

    expect(store.calls).toEqual([
      ['disconnected', { peerConnectionScopeId: null, lastEventId: null, error: null }],
      ['connecting', { peerConnectionScopeId: 'scope-b', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-b', lastEventId: 'native:10', error: null }]
    ])

    const callsAfterScopeSwitch = [...store.calls]
    expect(applyPeerConnectionState(store, 'scope-a', 'connected', { lastEventId: 'native:old' })).toBe(false)
    expect(store.calls).toEqual(callsAfterScopeSwitch)

    await act(async () => {
      transport.push(nativePeerEvent('native:11', { peerId: 'peer-b', connected: false, sessions: 0 }))
      await flushAsyncWork()
    })

    expect(store.calls.at(-1)).toEqual([
      'disconnected',
      { peerConnectionScopeId: 'scope-b', lastEventId: 'native:11', error: null }
    ])
  })

  it('switches peer subjects within one mounted scope and ignores late events from the old peer', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe({ peerId }: { peerId: string }) {
      useNativePeerEvents({
        client,
        peerId,
        scopeId: 'scope-stable-profile',
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    const root = await render(<Probe peerId="peer-a" />)
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      kinds: ['mesh.peer.state_changed'],
      subjects: ['peer-a']
    }))
    store.calls.splice(0)
    transport.snapshotLastSequenceId = 'native:profile:2'
    transport.snapshotSubjects = [{ subject: 'peer-b', status: 'connected' }]

    await act(async () => {
      root.render(<Probe peerId="peer-b" />)
      await flushAsyncWork()
    })

    expect(transport.snapshotRequests.at(-1)).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['peer-b']
    }))
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      kinds: ['mesh.peer.state_changed'],
      subjects: ['peer-b'],
      lastEventId: 'native:profile:2',
      lastSequenceId: 'native:profile:2'
    }))
    expect(store.calls).toEqual([
      ['connected', { peerConnectionScopeId: 'scope-stable-profile', lastEventId: 'native:profile:2', error: null }]
    ])

    await act(async () => {
      transport.push(nativePeerEvent('native:profile:old', { peerId: 'peer-a', connected: false, sessions: 0 }))
      await flushAsyncWork()
    })
    expect(store.calls).toEqual([
      ['connected', { peerConnectionScopeId: 'scope-stable-profile', lastEventId: 'native:profile:2', error: null }]
    ])

    await act(async () => {
      transport.push(nativePeerEvent('native:profile:3', { peerId: 'peer-b', connected: false, sessions: 0 }))
      await flushAsyncWork()
    })
    expect(store.calls.at(-1)).toEqual([
      'disconnected',
      { peerConnectionScopeId: 'scope-stable-profile', lastEventId: 'native:profile:3', error: null }
    ])
  })

  it('bootstraps authoritative peer subject state before subscribing', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotReplayComplete = false
    transport.snapshotLastSequenceId = 'native:5'
    transport.snapshotSubjects = [{ subject: 'peer-phone', status: 'connected' }]
    transport.snapshotEvents = [nativePeerEvent('native:gap:2', { peerId: 'peer-phone', connected: false })]
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe() {
      useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    await render(<Probe />)

    expect(store.calls).toEqual([
      ['connecting', { peerConnectionScopeId: 'scope-a', lastEventId: null, error: null }],
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: 'native:5', error: null }]
    ])
    expect(transport.snapshotRequests[0]).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['peer-phone']
    }))
    expect(transport.snapshotRequests[0]).toEqual(expect.objectContaining({ afterSequence: null }))
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      lastEventId: 'native:5',
      lastSequenceId: 'native:5'
    }))
  })

  it('recovers later incomplete native history from authoritative peer subject state', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe() {
      useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        nativeEventsSupported: true
      })
      return null
    }

    await render(<Probe />)
    store.calls.splice(0)
    transport.snapshotReplayComplete = false
    transport.snapshotLastSequenceId = 'native:5'
    transport.snapshotSubjects = [{ subject: 'peer-phone', status: 'connected' }]
    transport.snapshotEvents = [nativePeerEvent('native:gap:2', { peerId: 'peer-phone', connected: false })]

    await act(async () => {
      transport.push({
        ...nativePeerEvent('native:gap:2', { peerId: 'peer-phone', connected: false }),
        kind: 'native.events.gap',
        payload: { firstMissingSequence: 2 }
      })
      await flushAsyncWork()
    })

    expect(store.calls).toEqual([
      ['connected', { peerConnectionScopeId: 'scope-a', lastEventId: 'native:5', error: null }]
    ])
    expect(transport.snapshotRequests.at(-1)).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['peer-phone'],
      afterSequence: 1
    }))
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      lastEventId: 'native:5',
      lastSequenceId: 'native:5'
    }))
  })

  it('recovers a native transport loss from the scoped peer snapshot before resubscribing', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const states: NativePeerEventsResult[] = []

    function Probe() {
      const state = useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-a',
        connectionStore: store,
        nativeEventsSupported: true
      })
      useEffect(() => { states.push(state) }, [state])
      return null
    }

    await render(<Probe />)
    expect(transport.requests).toHaveLength(1)
    store.calls.splice(0)
    transport.snapshotLastSequenceId = 'native:4'
    transport.snapshotSubjects = [{ subject: 'peer-phone', status: 'connected' }]

    await act(async () => {
      transport.fail(0, new AuroraError({
        code: 'transport_loss',
        message: 'Native event acknowledgement failed',
        method: 'aurora_native_event_ack'
      }))
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(2)
    expect(transport.snapshotRequests.at(-1)).toEqual(expect.objectContaining({
      source: 'native',
      kinds: ['mesh.peer.state_changed'],
      subjects: ['peer-phone']
    }))
    expect(store.calls).toContainEqual([
      'connected',
      { peerConnectionScopeId: 'scope-a', lastEventId: 'native:4', error: null }
    ])
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      kinds: ['mesh.peer.state_changed'],
      subjects: ['peer-phone'],
      lastEventId: 'native:4',
      lastSequenceId: 'native:4'
    }))
    expect(transport.requests).toHaveLength(2)

    await act(async () => {
      transport.fail(1, new AuroraError({ code: 'transport_loss', message: 'second ack lost' }))
      await flushAsyncWork(10)
    })
    expect(transport.snapshotRequests).toHaveLength(2)
    expect(transport.requests).toHaveLength(2)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.any(AuroraError)
    }))
  })

  it('recovers an active native subscription readiness transport loss from a peer snapshot', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const states: NativePeerEventsResult[] = []
    const readyWasRead = vi.fn()
    const delayedReady = deferred<void>()
    deferFirstSubscriptionReady(client, delayedReady.promise, readyWasRead)

    function Probe() {
      const state = useNativePeerEvents({
        client,
        peerId: 'peer-phone',
        scopeId: 'scope-ready',
        connectionStore: store,
        nativeEventsSupported: true
      })
      useEffect(() => { states.push(state) }, [state])
      return null
    }

    await render(<Probe />)
    expect(transport.requests).toHaveLength(1)
    expect(readyWasRead).toHaveBeenCalledTimes(1)
    transport.snapshotLastSequenceId = 'native:6'
    transport.snapshotSubjects = [{ subject: 'peer-phone', status: 'connected' }]

    await act(async () => {
      delayedReady.reject(new AuroraError({ code: 'transport_loss', message: 'Native subscription readiness failed' }))
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(2)
    expect(transport.snapshotRequests.at(-1)).toEqual(expect.objectContaining({ subjects: ['peer-phone'] }))
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      subjects: ['peer-phone'],
      lastEventId: 'native:6',
      lastSequenceId: 'native:6'
    }))
    expect(states.at(-1)?.status).toBe('streaming')
  })

  it('does not publish or resubscribe from a delayed old-scope recovery snapshot', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const recoverySnapshot = deferred<void>()

    function Probe({ peerId, scopeId }: { peerId: string; scopeId: string }) {
      useNativePeerEvents({ client, peerId, scopeId, connectionStore: store, nativeEventsSupported: true })
      return null
    }

    const root = await render(<Probe peerId="peer-a" scopeId="scope-a" />)
    store.calls.splice(0)
    transport.snapshotLastSequenceId = 'native:10'
    transport.snapshotSubjects = [{ subject: 'peer-a', status: 'connected' }]
    transport.snapshotDelay = recoverySnapshot.promise

    try {
      await act(async () => {
        transport.fail(0, new AuroraError({ code: 'transport_loss', message: 'ack lost' }))
        await flushAsyncWork(10)
      })
      expect(transport.snapshotRequests).toHaveLength(2)

      transport.snapshotDelay = null
      transport.snapshotLastSequenceId = 'native:20'
      transport.snapshotSubjects = [{ subject: 'peer-b', status: 'connected' }]
      await act(async () => {
        root.render(<Probe peerId="peer-b" scopeId="scope-b" />)
        await flushAsyncWork(10)
      })
      const newScopeCalls = [...store.calls]

      await act(async () => {
        recoverySnapshot.resolve()
        await flushAsyncWork(10)
      })

      expect(store.calls).toEqual(newScopeCalls)
      expect(transport.requests.map((request) => request.subjects)).toEqual([
        ['peer-a'],
        ['peer-b']
      ])
      expect(transport.requests.some((request) => request.subjects?.includes('peer-a') && request.lastEventId === 'native:10')).toBe(false)
    } finally {
      recoverySnapshot.resolve()
      await act(async () => { await flushAsyncWork(10) })
    }
  })

  it('does not start old-scope recovery after subscription readiness rejects late', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const readyWasRead = vi.fn()
    const delayedReady = deferred<void>()
    deferFirstSubscriptionReady(client, delayedReady.promise, readyWasRead)

    function Probe({ peerId, scopeId }: { peerId: string; scopeId: string }) {
      useNativePeerEvents({ client, peerId, scopeId, connectionStore: store, nativeEventsSupported: true })
      return null
    }

    const root = await render(<Probe peerId="peer-a" scopeId="scope-a" />)
    try {
      expect(transport.requests).toHaveLength(1)
      expect(readyWasRead).toHaveBeenCalledTimes(1)
      await act(async () => {
        root.render(<Probe peerId="peer-b" scopeId="scope-b" />)
        await flushAsyncWork(10)
      })
      expect(transport.requests.map((request) => request.subjects)).toEqual([['peer-a'], ['peer-b']])
      expect(transport.snapshotRequests).toHaveLength(2)

      await act(async () => {
        delayedReady.reject(new AuroraError({ code: 'transport_loss', message: 'old ready failed' }))
        await flushAsyncWork(10)
      })

      expect(transport.snapshotRequests).toHaveLength(2)
      expect(transport.requests.map((request) => request.subjects)).toEqual([['peer-a'], ['peer-b']])
    } finally {
      delayedReady.resolve()
      await act(async () => { await flushAsyncWork(10) })
    }
  })

  it('does not start native transport recovery after unmount during subscription readiness', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()
    const readyWasRead = vi.fn()
    const delayedReady = deferred<void>()
    deferFirstSubscriptionReady(client, delayedReady.promise, readyWasRead)

    function Probe() {
      useNativePeerEvents({ client, peerId: 'peer-a', scopeId: 'scope-a', connectionStore: store, nativeEventsSupported: true })
      return null
    }

    const root = await render(<Probe />)
    expect(transport.requests).toHaveLength(1)
    expect(readyWasRead).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
    const rootIndex = roots.indexOf(root)
    if (rootIndex >= 0) roots.splice(rootIndex, 1)

    await act(async () => {
      delayedReady.reject(new AuroraError({ code: 'transport_loss', message: 'unmounted ready failed' }))
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(1)
  })

  it('does not use snapshot recovery for a non-transport native error', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const store = createConnectionStore()

    function Probe() {
      useNativePeerEvents({ client, peerId: 'peer-phone', scopeId: 'scope-a', connectionStore: store, nativeEventsSupported: true })
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.fail(0, new AuroraError({ code: 'permission', message: 'Native peer events are not authorized' }))
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(1)
    expect(store.calls.at(-1)).toEqual([
      'reconnecting',
      expect.objectContaining({ peerConnectionScopeId: 'scope-a', error: 'Native peer events are not authorized' })
    ])
  })
})

class ControlledEventTransport implements AuroraTransport {
  readonly kind = 'mock'
  readonly requests: AuroraStreamRequest[] = []
  readonly snapshotRequests: unknown[] = []
  snapshotEvents: AuroraEvent[] = []
  snapshotSubjects: unknown[] = []
  snapshotLastSequenceId = 'native:3'
  snapshotReplayComplete = true
  snapshotDelay: Promise<void> | null = null
  nextReady: Promise<void> | null = null
  private readonly subscriptions: ControlledSubscription[] = []

  async request<TData = unknown>() {
    return { data: {} as TData }
  }

  subscribe(request: AuroraStreamRequest): AuroraEventSubscription {
    this.requests.push(request)
    const subscription: ControlledSubscription = { queue: [], waiters: [], closed: false }
    this.subscriptions.push(subscription)
    const ready = this.nextReady
    this.nextReady = null
    return createEventSubscription(this.iterate(subscription), () => {
      subscription.closed = true
      subscription.waiters.splice(0).forEach((wake) => wake())
    }, ready ?? undefined)
  }

  async snapshot(request: unknown) {
    this.snapshotRequests.push(request)
    const snapshot = {
      events: this.snapshotEvents,
      lastSequenceId: this.snapshotLastSequenceId,
      replayComplete: this.snapshotReplayComplete,
      subjects: this.snapshotSubjects
    }
    await this.snapshotDelay
    return snapshot
  }

  push(event: AuroraEvent): void {
    const subscription = this.subscriptions.at(-1)
    if (!subscription || subscription.closed) return
    subscription.queue.push(event)
    subscription.waiters.splice(0).forEach((wake) => wake())
  }

  fail(index: number, error: unknown): void {
    const subscription = this.subscriptions[index]
    if (!subscription || subscription.closed) return
    subscription.failure = error
    subscription.waiters.splice(0).forEach((wake) => wake())
  }

  private async *iterate(subscription: ControlledSubscription): AsyncIterable<AuroraEvent> {
    while (!subscription.closed) {
      if (subscription.failure !== undefined) throw subscription.failure
      const event = subscription.queue.shift()
      if (event) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => {
        subscription.waiters.push(resolve)
      })
    }
  }
}

interface ControlledSubscription {
  queue: AuroraEvent[]
  waiters: Array<() => void>
  closed: boolean
  failure?: unknown
}

function createConnectionStore(initialScopeId: string | null = null): NativePeerConnectionStorePort & {
  calls: Array<[NativePeerConnectionBadgeState, { peerConnectionScopeId?: string | null; scopeId?: string | null; lastEventId?: string | null; error?: string | null } | undefined]>
} {
  const calls: Array<[NativePeerConnectionBadgeState, { peerConnectionScopeId?: string | null; scopeId?: string | null; lastEventId?: string | null; error?: string | null } | undefined]> = []
  let scopeId = initialScopeId
  const state = {
    get peerConnectionScopeId() {
      return scopeId
    },
    setPeerState(next: NativePeerConnectionBadgeState, details?: { peerConnectionScopeId?: string | null; scopeId?: string | null; lastEventId?: string | null; error?: string | null }) {
      calls.push([next, details])
      if (details?.peerConnectionScopeId !== undefined) scopeId = details.peerConnectionScopeId
      else if (details?.scopeId !== undefined) scopeId = details.scopeId
    }
  }
  return {
    calls,
    getState: () => state
  }
}

function runtimePeer(snapshot: NativePeerRuntimeSnapshot) {
  return {
    snapshot: () => snapshot
  }
}

async function render(node: ReactNode): Promise<Root> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(node)
    await flushAsyncWork()
  })
  return root
}

async function flushAsyncWork(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function deferFirstSubscriptionReady(client: AuroraClient, ready: Promise<void>, onReadyRead: () => void): void {
  const subscribe = client.events.subscribe.bind(client.events)
  let shouldDefer = true
  vi.spyOn(client.events, 'subscribe').mockImplementation((options) => {
    const subscription = subscribe(options)
    if (!shouldDefer) return subscription
    shouldDefer = false
    const wrapped: AuroraEventSubscription = {
      get ready() {
        onReadyRead()
        return ready
      },
      get closed() { return subscription.closed },
      close(reason) { subscription.close(reason) },
      [Symbol.asyncIterator]() { return subscription[Symbol.asyncIterator]() }
    }
    return wrapped
  })
}

function nativePeerEvent(id: string, payload: { peerId: string; connected: boolean; sessions?: number }): AuroraEvent {
  return {
    ...createAuroraEvent('mesh.peer.state_changed', payload, { transport: 'native', peerId: payload.peerId }),
    id
  }
}
