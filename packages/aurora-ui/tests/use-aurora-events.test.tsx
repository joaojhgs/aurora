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

import { useAuroraEvents, type AuroraEventsSnapshot, type UseAuroraEventsResult } from '../src/use-aurora-events'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAuroraEvents', () => {
  it('subscribes with native subject filters and dedupes replayed events', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const handled: AuroraEvent[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'conversation-1',
          lastEventId: 'native:40',
          maxEvents: 4
        },
        (event) => { handled.push(event) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      source: 'native',
      kinds: ['assistant.delta'],
      subjects: ['conversation-1'],
      lastEventId: 'native:40'
    }))

    await act(async () => {
      transport.push(nativeEvent('native:41', 'assistant.delta', 'first'))
      transport.push(nativeEvent('native:41', 'assistant.delta', 'duplicate'))
      transport.push(nativeEvent('native:42', 'assistant.delta', 'second'))
      await flushAsyncWork()
    })

    expect(handled.map((event) => event.id)).toEqual(['native:41', 'native:42'])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'streaming',
      lastEventId: 'native:42',
      events: [
        expect.objectContaining({ id: 'native:41' }),
        expect.objectContaining({ id: 'native:42' })
      ]
    }))
  })

  it('closes the active subscription on unmount', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })

    function Probe() {
      useAuroraEvents({ client, source: 'native', kinds: ['voice.turn.started'] })
      return null
    }

    const root = await render(<Probe />)
    expect(transport.closed).toBe(false)

    await act(async () => {
      root.unmount()
    })

    expect(transport.closed).toBe(true)
  })

  it('closes the active subscription when the external signal aborts', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({ client, source: 'native', kinds: ['voice.turn.started'], signal: controller.signal })
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    expect(transport.closed).toBe(false)

    await act(async () => {
      controller.abort()
      await Promise.resolve()
    })

    expect(transport.closed).toBe(true)
    expect(snapshots.at(-1)?.status).not.toBe('streaming')
  })

  it('resets state synchronously and ignores stale events when filters change', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe({ subject }: { subject: string }) {
      const state = useAuroraEvents(
        { client, source: 'native', kinds: ['assistant.delta'], subject },
        (event) => { handled.push(String(event.payload && typeof event.payload === 'object' ? (event.payload as { text?: unknown }).text : event.id)) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    const root = await render(<Probe subject="request-1" />)
    await act(async () => {
      transport.push(nativeEvent('native:1', 'assistant.delta', 'old-before-switch'))
      await flushAsyncWork()
    })
    expect(snapshots.at(-1)?.events.map((event) => event.id)).toEqual(['native:1'])

    await act(async () => {
      root.render(<Probe subject="request-2" />)
      await flushAsyncWork()
    })
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      lastEventId: null,
      events: []
    }))

    await act(async () => {
      transport.pushTo(0, nativeEvent('native:2', 'assistant.delta', 'old-scope'))
      transport.pushTo(1, nativeEvent('native:3', 'assistant.delta', 'new-scope'))
      await flushAsyncWork()
    })

    expect(handled).toEqual(['old-before-switch', 'new-scope'])
    expect(transport.requests.map((request) => request.subjects)).toEqual([['request-1'], ['request-2']])
  })

  it('resubscribes on lifecycle scope changes without forwarding the opaque key', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe({ lifecycleScopeKey }: { lifecycleScopeKey: string }) {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'request-1',
          lifecycleScopeKey,
          bootstrapSnapshot: true
        },
        (event) => { handled.push(String(event.payload && typeof event.payload === 'object' ? (event.payload as { text?: unknown }).text : event.id)) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    const root = await render(<Probe lifecycleScopeKey="auth-scope-1" />)
    await act(async () => {
      transport.push(nativeEvent('native:1', 'assistant.delta', 'before-scope-change'))
      await flushAsyncWork()
    })
    expect(snapshots.at(-1)?.events.map((event) => event.id)).toEqual(['native:1'])

    await act(async () => {
      root.render(<Probe lifecycleScopeKey="auth-scope-2" />)
      await flushAsyncWork()
    })
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      events: []
    }))

    await act(async () => {
      transport.pushTo(0, nativeEvent('native:2', 'assistant.delta', 'stale-auth-scope'))
      transport.pushTo(1, nativeEvent('native:4', 'assistant.delta', 'current-auth-scope'))
      await flushAsyncWork()
    })

    expect(handled).toEqual(['before-scope-change', 'current-auth-scope'])
    expect(transport.requests.map((request) => request.subjects)).toEqual([['request-1'], ['request-1']])
    expect(transport.requests.some((request) => 'lifecycleScopeKey' in request)).toBe(false)
    expect(transport.snapshotRequests).toHaveLength(2)
    expect(transport.snapshotRequests.some((request) => Boolean(request && typeof request === 'object' && 'lifecycleScopeKey' in request))).toBe(false)
  })

  it('awaits async event application before advancing the cursor', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const applied = deferred<void>()
    const order: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        { client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' },
        async (event) => {
          order.push(`start:${event.id}`)
          await applied.promise
          order.push(`applied:${event.id}`)
        }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push(nativeEvent('native:1', 'assistant.delta', 'first'))
      await Promise.resolve()
    })

    expect(order).toEqual(['start:native:1'])
    expect(snapshots.at(-1)?.lastEventId).toBeNull()
    expect(snapshots.at(-1)?.events).toEqual([])

    await act(async () => {
      applied.resolve()
      await Promise.resolve()
    })

    expect(order).toEqual(['start:native:1', 'applied:native:1'])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      lastEventId: 'native:1',
      events: [expect.objectContaining({ id: 'native:1' })]
    }))
  })

  it('does not invoke a newer snapshot callback for a stale bootstrap snapshot', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const snapshotGate = deferred<void>()
    transport.snapshotDelay = snapshotGate.promise
    const callbacks: string[] = []

    function Probe({ subject, tag, bootstrapSnapshot }: { subject: string; tag: string; bootstrapSnapshot: boolean }) {
      useAuroraEvents({
        client,
        source: 'native',
        kinds: ['assistant.delta'],
        subject,
        bootstrapSnapshot,
        onSnapshot: async () => {
          callbacks.push(tag)
          return { recovered: true, replayEvents: false }
        }
      })
      return null
    }

    const root = await render(<Probe subject="request-1" tag="old" bootstrapSnapshot={true} />)
    await act(async () => {
      root.render(<Probe subject="request-2" tag="new" bootstrapSnapshot={false} />)
      await flushAsyncWork()
    })
    await act(async () => {
      snapshotGate.resolve()
      await flushAsyncWork()
    })

    expect(callbacks).toEqual([])
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      subjects: ['request-2']
    }))
  })

  it('does not invoke a stale bootstrap callback after the hook is disabled before cleanup runs', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const snapshotGate = deferred<void>()
    transport.snapshotDelay = snapshotGate.promise
    const callbacks: string[] = []

    function Probe({ enabled }: { enabled: boolean }) {
      useAuroraEvents({
        client,
        enabled,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'request-1',
        bootstrapSnapshot: true,
        onSnapshot: async () => {
          callbacks.push('snapshot')
          return { recovered: true, replayEvents: false }
        }
      })
      return null
    }

    const root = await render(<Probe enabled={true} />)
    await act(async () => {
      root.render(<Probe enabled={false} />)
      await flushAsyncWork()
    })
    await act(async () => {
      snapshotGate.resolve()
      await flushAsyncWork()
    })

    expect(callbacks).toEqual([])
  })

  it('does not invoke a stale bootstrap callback after the external signal is aborted before cleanup runs', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const snapshotGate = deferred<void>()
    const controller = new AbortController()
    transport.snapshotDelay = snapshotGate.promise
    const callbacks: string[] = []

    function Probe() {
      useAuroraEvents({
        client,
        signal: controller.signal,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'request-1',
        bootstrapSnapshot: true,
        onSnapshot: async () => {
          callbacks.push('snapshot')
          return { recovered: true, replayEvents: false }
        }
      })
      return null
    }

    await render(<Probe />)
    await act(async () => {
      controller.abort()
      snapshotGate.resolve()
      await flushAsyncWork()
    })

    expect(callbacks).toEqual([])
  })

  it('bootstraps native snapshots before subscribing and resumes from the snapshot cursor', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotReplayComplete = false
    transport.snapshotLastSequenceId = 'native:8'
    transport.snapshotSubjects = [{ subject: 'request-1', status: 'running', accumulatedText: 'hello' }]
    transport.snapshotEvents = [nativeEvent('native:7', 'assistant.delta', 'stale')]
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'request-1',
          bootstrapSnapshot: true,
          onSnapshot: async (snapshot, context) => {
            handled.push(`snapshot:${context.reason}:${context.gap === null}:${snapshot.lastSequenceId}`)
            return { recovered: true, replayEvents: false }
          }
        },
        (event) => { handled.push(event.id ?? event.kind) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)

    expect(handled).toEqual(['snapshot:bootstrap:true:native:8'])
    expect(transport.snapshotRequests[0]).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['request-1']
    }))
    expect(transport.snapshotRequests[0]).toEqual(expect.objectContaining({ afterSequence: null }))
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      lastEventId: 'native:8',
      lastSequenceId: 'native:8'
    }))
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'streaming',
      lastEventId: 'native:8',
      events: [],
      recovery: expect.objectContaining({
        status: 'recovered',
        firstMissingSequence: null,
        lastSequenceId: 'native:8',
        replayComplete: false,
        subjects: [{ subject: 'request-1', status: 'running', accumulatedText: 'hello' }]
      })
    }))
  })

  it('recovers native subscriptions from app resume while the old iterator remains pending', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotLastSequenceId = 'native:4'
    const client = new AuroraClient({ transport })
    const resumeSource = new ControlledNativeResumeSource()
    Object.assign(client.events, { subscribeNativeResume: resumeSource.subscribe })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'request-1',
          bootstrapSnapshot: true,
          onSnapshot: async (snapshot, context) => {
            handled.push(`snapshot:${context.reason}:${snapshot.lastSequenceId}`)
            return { recovered: true, replayEvents: false }
          }
        },
        (event) => { handled.push(event.id ?? event.kind) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    expect(resumeSource.listenerCount()).toBe(1)
    expect(transport.requests).toHaveLength(1)
    expect(transport.snapshotRequests).toHaveLength(1)
    transport.ignoreCloseFor(0)

    await act(async () => {
      transport.snapshotLastSequenceId = 'native:9'
      resumeSource.fire()
      transport.pushTo(0, nativeEvent('native:10', 'assistant.completed', 'stale-immediate-terminal'))
      await flushAsyncWork()
    })

    expect(transport.closeCount(0)).toBe(1)
    expect(transport.isClosed(0)).toBe(false)
    expect(transport.snapshotRequests).toHaveLength(2)
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['request-1'],
      lastEventId: 'native:9',
      lastSequenceId: 'native:9'
    }))

    await act(async () => {
      transport.pushTo(0, nativeEvent('native:12', 'tts.audio_chunk', 'stale-after-resume'))
      transport.pushTo(1, nativeEvent('native:11', 'assistant.delta', 'current-after-resume'))
      await flushAsyncWork()
    })

    expect(handled).toEqual([
      'snapshot:bootstrap:native:4',
      'snapshot:bootstrap:native:9',
      'native:11'
    ])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'streaming',
      lastEventId: 'native:11',
      events: [expect.objectContaining({ id: 'native:11' })]
    }))
  })

  it('does not restart non-native subscriptions on app resume', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const resumeSource = new ControlledNativeResumeSource()
    Object.assign(client.events, { subscribeNativeResume: resumeSource.subscribe })
    const handled: string[] = []

    function Probe() {
      useAuroraEvents(
        {
          client,
          source: 'gateway',
          kinds: ['assistant.delta'],
          subject: 'request-1'
        },
        (event) => { handled.push(event.id ?? event.kind) }
      )
      return null
    }

    await render(<Probe />)
    expect(resumeSource.listenerCount()).toBe(0)
    await act(async () => {
      resumeSource.fire()
      await flushAsyncWork()
    })

    expect(transport.requests).toHaveLength(1)
    expect(transport.isClosed(0)).toBe(false)

    await act(async () => {
      transport.pushTo(0, nativeEvent('native:1', 'assistant.delta', 'still-current'))
      await flushAsyncWork()
    })

    expect(handled).toEqual(['native:1'])
  })

  it('surfaces synchronous native resume registration failure', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    Object.assign(client.events, {
      subscribeNativeResume: () => {
        throw new Error('listener unavailable')
      }
    })
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({ client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' })
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      await flushAsyncWork()
    })

    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ message: expect.stringContaining('listener unavailable') }),
      recovery: expect.objectContaining({ status: 'unrecoverable' })
    }))
  })

  it('surfaces asynchronous native resume registration failure', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    Object.assign(client.events, {
      subscribeNativeResume: async () => {
        throw new Error('async listener unavailable')
      }
    })
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({ client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' })
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      await flushAsyncWork()
    })

    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ message: expect.stringContaining('async listener unavailable') }),
      recovery: expect.objectContaining({ status: 'unrecoverable' })
    }))
  })

  it('contains asynchronous native resume cleanup failures', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup rejected')
    })
    Object.assign(client.events, {
      subscribeNativeResume: () => cleanup
    })

    function Probe() {
      useAuroraEvents({ client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' })
      return null
    }

    const root = await render(<Probe />)
    await act(async () => {
      root.unmount()
      await flushAsyncWork()
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('contains synchronous native resume cleanup failures', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const cleanup = vi.fn(() => {
      throw new Error('cleanup threw')
    })
    Object.assign(client.events, {
      subscribeNativeResume: () => cleanup
    })

    function Probe() {
      useAuroraEvents({ client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' })
      return null
    }

    const root = await render(<Probe />)
    await act(async () => {
      root.unmount()
      await flushAsyncWork()
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('runs async native resume cleanup when registration resolves after unmount', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const cleanup = vi.fn()
    const registration = deferred<() => void>()
    Object.assign(client.events, {
      subscribeNativeResume: () => registration.promise
    })

    function Probe() {
      useAuroraEvents({ client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1' })
      return null
    }

    const root = await render(<Probe />)
    await act(async () => {
      root.unmount()
      registration.resolve(cleanup)
      await flushAsyncWork()
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not revive an externally aborted native subscription on app resume', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const resumeSource = new ControlledNativeResumeSource()
    Object.assign(client.events, { subscribeNativeResume: resumeSource.subscribe })
    const controller = new AbortController()
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({
        client,
        signal: controller.signal,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'request-1',
        bootstrapSnapshot: true
      })
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    expect(resumeSource.listenerCount()).toBe(1)
    expect(transport.requests).toHaveLength(1)

    await act(async () => {
      controller.abort()
      await flushAsyncWork()
    })
    expect(transport.isClosed(0)).toBe(true)

    await act(async () => {
      resumeSource.fire()
      await flushAsyncWork()
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(1)
    expect(transport.closeCount(0)).toBe(1)
    expect(snapshots.at(-1)?.status).toBe('closed')
  })

  it('ignores a native resume snapshot that resolves after the subject changes', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const resumeSource = new ControlledNativeResumeSource()
    Object.assign(client.events, { subscribeNativeResume: resumeSource.subscribe })
    const resumeSnapshotGate = deferred<void>()
    const callbacks: string[] = []

    function Probe({ subject }: { subject: string }) {
      useAuroraEvents({
        client,
        source: 'native',
        kinds: ['assistant.delta'],
        subject,
        bootstrapSnapshot: true,
        onSnapshot: async (snapshot) => {
          callbacks.push(`${subject}:${snapshot.lastSequenceId}`)
          return { recovered: true, replayEvents: false }
        }
      })
      return null
    }

    const root = await render(<Probe subject="request-1" />)
    expect(callbacks).toEqual(['request-1:native:3'])

    await act(async () => {
      transport.snapshotLastSequenceId = 'native:8'
      transport.snapshotDelay = resumeSnapshotGate.promise
      resumeSource.fire()
      await flushAsyncWork()
    })
    expect(transport.snapshotRequests).toHaveLength(2)

    await act(async () => {
      transport.snapshotDelay = null
      transport.snapshotLastSequenceId = 'native:12'
      root.render(<Probe subject="request-2" />)
      await flushAsyncWork()
    })
    await act(async () => {
      resumeSnapshotGate.resolve()
      await flushAsyncWork()
    })

    expect(callbacks).toEqual(['request-1:native:3', 'request-2:native:12'])
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({
      subjects: ['request-2'],
      lastEventId: 'native:12',
      lastSequenceId: 'native:12'
    }))
  })

  it('bounds dedupe memory, waits for snapshot reconciliation, and resubscribes after native gaps', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotEvents = [nativeEvent('native:3', 'assistant.delta', 'recovered')]
    transport.snapshotSubjects = [{ id: 'request-1', active: true }]
    const client = new AuroraClient({ transport })
    const order: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'request-1',
          maxEvents: 1,
          onSnapshot: async (snapshot, context) => {
            order.push(`snapshot:${context.firstMissingSequence}:${snapshot.lastSequenceId}`)
          }
        },
        (event) => { order.push(`event:${event.id ?? event.kind}`) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push(nativeEvent('native:1', 'assistant.delta', 'first'))
      transport.push({
        ...nativeEvent('native:gap:2', 'native.events.gap', 'gap'),
        payload: { firstMissingSequence: 2 }
      })
      await flushAsyncWork()
    })

    expect(order).toEqual(['event:native:1', 'event:native:gap:2', 'snapshot:2:native:3', 'event:native:3'])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      lastEventId: 'native:3',
      events: [expect.objectContaining({ id: 'native:3' })],
      recovery: expect.objectContaining({
        status: 'recovered',
        firstMissingSequence: 2,
        lastSequenceId: 'native:3',
        replayComplete: true,
        subjects: [{ id: 'request-1', active: true }]
      })
    }))
    expect(transport.snapshotRequests[0]).toEqual(expect.objectContaining({
      source: 'native',
      subjects: ['request-1'],
      afterSequence: 1
    }))
    expect(transport.requests[1]).toEqual(expect.objectContaining({
      lastEventId: 'native:3',
      lastSequenceId: 'native:3'
    }))
  })

  it('keeps a transport-loss error from an event callback terminal', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const states: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        { client, source: 'native', kinds: ['assistant.delta'], subject: 'conversation-1' },
        (event) => {
          handled.push(event.id ?? '')
          throw new AuroraError({ code: 'transport_loss', message: 'Callback processing failed' })
        }
      )
      useEffect(() => { states.push(state) }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push(nativeEvent('native:1', 'assistant.delta', 'callback-fails'))
      await flushAsyncWork(10)
    })

    expect(handled).toEqual(['native:1'])
    expect(transport.snapshotRequests).toHaveLength(0)
    expect(transport.requests).toHaveLength(1)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.any(AuroraError),
      recovery: expect.objectContaining({ status: 'unrecoverable' })
    }))
  })

  it('requests native recovery after the latest processed event sequence', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotLastSequenceId = 'native:1'
    const client = new AuroraClient({ transport })
    const thirdEventEntered = deferred<void>()
    const releaseThirdEvent = deferred<void>()

    function Probe() {
      useAuroraEvents({
        client,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'conversation-1',
        maxEvents: 1,
        bootstrapSnapshot: true
      }, async (event) => {
        if (event.id !== 'native:3') return
        thirdEventEntered.resolve()
        await releaseThirdEvent.promise
      })
      return null
    }

    await render(<Probe />)
    expect(transport.requests).toHaveLength(1)
    try {
      await act(async () => {
        transport.push(nativeEvent('native:2', 'assistant.delta', 'second'))
        await flushAsyncWork()
        transport.push(nativeEvent('native:3', 'assistant.delta', 'third'))
        await thirdEventEntered.promise
        releaseThirdEvent.resolve()
        await flushAsyncWork(10)
        transport.snapshotLastSequenceId = 'native:4'
        transport.fail(0, new AuroraError({ code: 'transport_loss', message: 'Native ack lost' }))
        await flushAsyncWork(10)
      })
    } finally {
      releaseThirdEvent.resolve()
    }

    expect(transport.snapshotRequests.at(-1)).toEqual(expect.objectContaining({ afterSequence: 3 }))
    expect(transport.requests.at(-1)).toEqual(expect.objectContaining({ lastSequenceId: 'native:4' }))
  })

  it('shares the default finite recovery budget between transport loss and native gaps', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const states: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({
        client,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'request-1'
      })
      useEffect(() => { states.push(state) }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.fail(0, new AuroraError({ code: 'transport_loss', message: 'ack lost' }))
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(2)
    await act(async () => {
      transport.push({
        ...nativeEvent('native:gap:5', 'native.events.gap', 'second recovery'),
        payload: { firstMissingSequence: 5 }
      })
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(2)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ message: 'Native event gap recovery retry limit reached' })
    }))
  })

  it('keeps a typed transport error from a gap snapshot callback terminal', async () => {
    const transport = new ControlledEventTransport()
    const client = new AuroraClient({ transport })
    const states: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents({
        client,
        source: 'native',
        kinds: ['assistant.delta'],
        subject: 'request-1',
        maxGapRecoveries: 2,
        onSnapshot: async () => {
          throw new AuroraError({ code: 'transport_loss', message: 'Snapshot reconciliation failed' })
        }
      })
      useEffect(() => { states.push(state) }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push({
        ...nativeEvent('native:gap:2', 'native.events.gap', 'snapshot callback fails'),
        payload: { firstMissingSequence: 2 }
      })
      await flushAsyncWork(10)
    })

    expect(transport.snapshotRequests).toHaveLength(1)
    expect(transport.requests).toHaveLength(1)
    expect(states.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ message: 'Snapshot reconciliation failed' })
    }))
  })

  it('resumes from authoritative subject state when native history is incomplete', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotEvents = [{
      ...nativeEvent('native:gap:2', 'native.events.gap', 'expired-history'),
      payload: { firstMissingSequence: 2 }
    }]
    transport.snapshotReplayComplete = false
    transport.snapshotSubjects = [{ subject: 'request-1', status: 'completed', accumulatedText: 'done', terminal: true }]
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        {
          client,
          source: 'native',
          kinds: ['assistant.delta'],
          subject: 'request-1',
          onSnapshot: async (snapshot) => {
            handled.push(`subjects:${snapshot.subjects?.length ?? 0}`)
            return { recovered: true, replayEvents: false }
          }
        },
        (event) => { handled.push(event.id ?? event.kind) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push({
        ...nativeEvent('native:gap:2', 'native.events.gap', 'gap'),
        payload: { firstMissingSequence: 2 }
      })
      await flushAsyncWork()
    })

    expect(handled).toEqual(['native:gap:2', 'subjects:1'])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'streaming',
      lastEventId: 'native:3',
      recovery: expect.objectContaining({
        status: 'recovered',
        lastSequenceId: 'native:3',
        replayComplete: false,
        subjects: [{ subject: 'request-1', status: 'completed', accumulatedText: 'done', terminal: true }]
      })
    }))
    expect(transport.requests[1]).toEqual(expect.objectContaining({
      lastEventId: 'native:3',
      lastSequenceId: 'native:3'
    }))
  })

  it('marks native gap recovery unrecoverable without recursively consuming snapshot gaps', async () => {
    const transport = new ControlledEventTransport()
    transport.snapshotEvents = [{
      ...nativeEvent('native:gap:3', 'native.events.gap', 'nested-gap'),
      payload: { firstMissingSequence: 3 }
    }]
    const client = new AuroraClient({ transport })
    const handled: string[] = []
    const snapshots: UseAuroraEventsResult[] = []

    function Probe() {
      const state = useAuroraEvents(
        { client, source: 'native', kinds: ['assistant.delta'], subject: 'request-1', maxGapRecoveries: 1 },
        (event) => { handled.push(event.id ?? event.kind) }
      )
      useEffect(() => {
        snapshots.push(state)
      }, [state])
      return null
    }

    await render(<Probe />)
    await act(async () => {
      transport.push({
        ...nativeEvent('native:gap:2', 'native.events.gap', 'gap'),
        payload: { firstMissingSequence: 2 }
      })
      await flushAsyncWork()
    })

    expect(handled).toEqual(['native:gap:2'])
    expect(snapshots.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      lastEventId: null,
      recovery: expect.objectContaining({
        status: 'unrecoverable',
        firstMissingSequence: 2
      })
    }))
    expect(transport.requests).toHaveLength(1)
  })
})

class ControlledNativeResumeSource {
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

class ControlledEventTransport implements AuroraTransport {
  readonly kind = 'mock'
  readonly requests: AuroraStreamRequest[] = []
  readonly snapshotRequests: unknown[] = []
  snapshotEvents: AuroraEvent[] = []
  snapshotSubjects: unknown[] = []
  snapshotLastSequenceId = 'native:3'
  snapshotReplayComplete = true
  snapshotDelay: Promise<void> | null = null
  closed = false
  private readonly subscriptions: ControlledSubscription[] = []

  async request<TData = unknown>() {
    return { data: {} as TData }
  }

  subscribe(request: AuroraStreamRequest): AuroraEventSubscription {
    this.requests.push(request)
    const subscription: ControlledSubscription = { queue: [], waiters: [], closed: false, ignoreClose: false, closeCount: 0 }
    this.subscriptions.push(subscription)
    const source = this.iterate(subscription)
    return createEventSubscription(source, () => {
      subscription.closeCount += 1
      if (subscription.ignoreClose) return
      subscription.closed = true
      this.closed = true
      subscription.waiters.splice(0).forEach((wake) => wake())
    })
  }

  async snapshot(request: unknown): Promise<AuroraEventsSnapshot> {
    this.snapshotRequests.push(request)
    await this.snapshotDelay
    return {
      events: this.snapshotEvents,
      lastSequenceId: this.snapshotLastSequenceId,
      replayComplete: this.snapshotReplayComplete,
      subjects: this.snapshotSubjects
    }
  }

  push(event: AuroraEvent): void {
    this.pushTo(this.subscriptions.length - 1, event)
  }

  pushTo(index: number, event: AuroraEvent): void {
    const subscription = this.subscriptions[index]
    if (!subscription || subscription.closed) return
    subscription.queue.push(event)
    subscription.waiters.splice(0).forEach((wake) => wake())
  }

  fail(index: number, error: unknown): void {
    const subscription = this.subscriptions[index]
    if (!subscription || subscription.closed) return
    subscription.error = error
    subscription.waiters.splice(0).forEach((wake) => wake())
  }

  isClosed(index: number): boolean {
    return this.subscriptions[index]?.closed === true
  }

  ignoreCloseFor(index: number): void {
    const subscription = this.subscriptions[index]
    if (subscription) subscription.ignoreClose = true
  }

  closeCount(index: number): number {
    return this.subscriptions[index]?.closeCount ?? 0
  }

  private async *iterate(subscription: ControlledSubscription): AsyncIterable<AuroraEvent> {
    while (!subscription.closed) {
      if (subscription.error !== undefined) throw subscription.error
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
  ignoreClose: boolean
  closeCount: number
  error?: unknown
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

function nativeEvent(id: string, kind: string, text: string): AuroraEvent {
  return {
    ...createAuroraEvent(kind, { text }, { transport: 'native' }),
    id
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
