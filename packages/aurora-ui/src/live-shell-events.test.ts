// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { AuroraError, type AuroraClient, type AuroraEvent } from '@aurora/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateAuroraQueriesForShellEvent, liveShellCursorsForScopeChange, patchShellSnapshotForEvent, shellEventQueryKeys, shouldRefreshShellSnapshot, useAuroraLiveShellEvents } from './live-shell-events'
import { useAuroraEvents, type AuroraEventsSnapshot } from './use-aurora-events'
import { useNativePeerEvents, type NativePeerConnectionBadgeState, type NativePeerConnectionStateDetails, type NativePeerConnectionStoreState, type NativePeerStatePayload } from './use-native-peer-events'
import { loadingShellSnapshot } from './shell-data'
import { useConnectionStore } from './state/connection-store'
import { useAssistantStreamStore } from './state/assistant-stream-store'

describe('live shell event patches', () => {
  it('marks capabilities stale while retaining the last route graph on config changes', () => {
    const current = { ...loadingShellSnapshot, loadState: 'ready' as const, capabilityFreshness: 'fresh' as const }
    const result = patchShellSnapshotForEvent(current, {
      kind: 'config.updated',
      payload: { key: 'system.voice_language' },
      receivedAt: new Date().toISOString()
    })
    expect(result.snapshot.loadState).toBe('ready')
    expect(result.snapshot.capabilityFreshness).toBe('stale')
    expect(result.shouldRefreshSnapshot).toBe(true)
  })

  it('invalidates server query families for shell refresh events only', () => {
    expect(shouldRefreshShellSnapshot({ kind: 'config.reload' })).toBe(true)
    expect(shouldRefreshShellSnapshot({ kind: 'health.stale' })).toBe(true)
    expect(shouldRefreshShellSnapshot({ kind: 'health.updated' })).toBe(false)
    expect(shellEventQueryKeys({ kind: 'service.announced' })).toEqual([['aurora']])
    expect(shellEventQueryKeys({ kind: 'health.stale' }, ['aurora', 'scope-a'])).toEqual([['aurora', 'scope-a']])
    expect(shellEventQueryKeys({ kind: 'health.updated' }, ['aurora', 'scope-a'])).toEqual([])
  })

  it('marks the shell stale and refreshable when health goes stale', () => {
    const current = { ...loadingShellSnapshot, loadState: 'ready' as const, connectionState: 'connected' as const, capabilityFreshness: 'fresh' as const }
    const result = patchShellSnapshotForEvent(current, {
      kind: 'health.stale',
      payload: {},
      receivedAt: new Date().toISOString()
    })
    expect(result.snapshot.connectionState).toBe('offline')
    expect(result.snapshot.capabilityFreshness).toBe('stale')
    expect(result.shouldRefreshSnapshot).toBe(true)
  })


  it('invalidates scoped server data without resetting in-flight assistant stream state', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    useAssistantStreamStore.getState().reset()
    useAssistantStreamStore.getState().activateScope('scope-a')
    useAssistantStreamStore.getState().begin('assistant-pending', { scopeId: 'scope-a' })
    useAssistantStreamStore.getState().append('partial answer', { scopeId: 'scope-a' })

    const current = { ...loadingShellSnapshot, loadState: 'ready' as const, capabilityFreshness: 'fresh' as const }
    const event = shellEvent('config-99', 'config.updated')
    const patched = patchShellSnapshotForEvent(current, event)
    invalidateAuroraQueriesForShellEvent(queryClient, event, ['aurora', 'scope-a'])

    expect(patched.snapshot.capabilityFreshness).toBe('stale')
    expect(patched.shouldRefreshSnapshot).toBe(true)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aurora', 'scope-a'] })
    expect(useAssistantStreamStore.getState()).toEqual(expect.objectContaining({
      activeScopeId: 'scope-a',
      state: 'requested',
      messageId: 'assistant-pending',
      text: 'partial answer'
    }))

    queryClient.clear()
    useAssistantStreamStore.getState().reset()
  })

  it('resets independent stream cursors when the live shell scope changes', () => {
    expect(liveShellCursorsForScopeChange({ health: 'h1', config: 'c1' }, 'scope-a', 'scope-a')).toEqual({
      scopeId: 'scope-a',
      cursors: { health: 'h1', config: 'c1' }
    })
    expect(liveShellCursorsForScopeChange({ health: 'h1', config: 'c1' }, 'scope-a', 'scope-b')).toEqual({
      scopeId: 'scope-b',
      cursors: { health: null, config: null }
    })
  })

  it('only changes connection state for explicit health evidence', () => {
    const current = { ...loadingShellSnapshot, connectionState: 'connected' as const }
    const offline = patchShellSnapshotForEvent(current, {
      kind: 'health.updated',
      payload: { status: 'offline' },
      receivedAt: new Date().toISOString()
    })
    const unrelated = patchShellSnapshotForEvent(current, {
      kind: 'health.updated',
      payload: { status: 'warming_up' },
      receivedAt: new Date().toISOString()
    })
    expect(offline.snapshot.connectionState).toBe('offline')
    expect(unrelated.snapshot.connectionState).toBe('connected')
  })
})



describe('useAuroraEvents native snapshots', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('aborts a stale delayed snapshot and prevents its result from applying after the lifecycle scope changes', async () => {
    const client = new NativeEventsClientDouble()
    const onEvent = vi.fn()
    const onSnapshot = vi.fn(() => ({ recovered: true as const }))

    await act(async () => {
      root.render(renderAuroraEventsHarness({ client, lifecycleScopeKey: 'scope-a', onEvent, onSnapshot }))
      await flushLiveShellEffects()
    })

    expect(client.snapshotOptions).toHaveLength(1)
    expect(client.snapshotOptions[0]).toMatchObject({ source: 'native', signal: expect.any(AbortSignal) })

    await act(async () => {
      root.render(renderAuroraEventsHarness({ client, lifecycleScopeKey: 'scope-b', onEvent, onSnapshot }))
      await flushLiveShellEffects()
    })

    expect(client.snapshotOptions[0]!.signal?.aborted).toBe(true)
    expect(client.snapshotOptions).toHaveLength(2)
    expect(client.snapshotOptions[1]).toMatchObject({ source: 'native', signal: expect.any(AbortSignal) })
    expect(client.snapshotOptions[1]!.signal?.aborted).toBe(false)

    await act(async () => {
      client.resolveSnapshot(0, nativeEventsSnapshot([nativePeerEvent('old-scope-event', 'peer-a', 'connected')], 'native:1'))
      await flushLiveShellEffects()
    })

    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()

    await act(async () => {
      client.resolveSnapshot(1, nativeEventsSnapshot([nativePeerEvent('new-scope-event', 'peer-a', 'connected')], 'native:2'))
      await flushLiveShellEffects()
    })

    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ lastSequenceId: 'native:2' }), expect.objectContaining({ reason: 'bootstrap' }))
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-scope-event' }))
  })
})

describe('useNativePeerEvents', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('restarts the same peer stream for a new lifecycle scope and ignores events from the old scope', async () => {
    const client = new NativeEventsClientDouble()
    const store = new NativePeerConnectionStoreDouble()
    client.queueSnapshot(nativeEventsSnapshot([], 'native:scope-a', [{ peerId: 'peer-a', status: 'connected' }]))
    client.queueSnapshot(nativeEventsSnapshot([], 'native:scope-b', [{ peerId: 'peer-a', status: 'reconnecting' }]))

    await act(async () => {
      root.render(renderNativePeerEventsHarness({ client, store, peerId: 'peer-a', scopeId: 'scope-a' }))
      await flushLiveShellEffects()
    })

    expect(client.snapshotOptions).toHaveLength(1)
    expect(client.snapshotOptions[0]).toMatchObject({ subject: 'peer-a', signal: expect.any(AbortSignal) })
    expect(client.subscribeOptions).toHaveLength(1)
    expect(store.state).toMatchObject({ peerConnectionScopeId: 'scope-a', badge: 'connected', lastEventId: 'native:scope-a' })

    await act(async () => {
      root.render(renderNativePeerEventsHarness({ client, store, peerId: 'peer-a', scopeId: 'scope-b' }))
      await flushLiveShellEffects()
    })

    expect(client.subscriptions[0]!.closeReasons).toContain('component-unmounted')
    expect(client.snapshotOptions[0]!.signal?.aborted).toBe(true)
    expect(client.snapshotOptions).toHaveLength(2)
    expect(client.snapshotOptions[1]).toMatchObject({ subject: 'peer-a', signal: expect.any(AbortSignal) })
    expect(client.subscribeOptions).toHaveLength(2)
    expect(store.state).toMatchObject({ peerConnectionScopeId: 'scope-b', badge: 'reconnecting', lastEventId: 'native:scope-b' })

    await act(async () => {
      client.subscriptions[0]!.push(nativePeerEvent('late-old-scope', 'peer-a', 'connected'))
      await flushLiveShellEffects()
    })

    expect(store.state).toMatchObject({ peerConnectionScopeId: 'scope-b', badge: 'reconnecting', lastEventId: 'native:scope-b' })
  })
})

describe('useAuroraLiveShellEvents', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    useConnectionStore.getState().reset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useConnectionStore.getState().reset()
    vi.useRealTimers()
  })

  it('restores fallback during an underlying stream close, then marks live again after the hook reconnects', async () => {
    const client = new LiveShellClientDouble()
    const onEvent = vi.fn()
    const onError = vi.fn()

    await act(async () => {
      root.render(renderLiveShellHarness({ client, scopeId: 'scope-a', onEvent, onError }))
      await flushLiveShellEffects()
    })

    expect(useConnectionStore.getState().state).toBe('connected')
    expect(client.healthOptions[0]).toMatchObject({ reconnect: false, lastEventId: null, replayFrom: null })
    expect(client.configOptions[0]).toMatchObject({ reconnect: false, lastEventId: null, replayFrom: null })

    await act(async () => {
      client.healthSubs[0]!.push(shellEvent('health-1', 'health.updated'))
      await flushLiveShellEffects()
    })

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'health-1' }))
    expect(useConnectionStore.getState().streams.health.lastEventId).toBe('health-1')

    await act(async () => {
      client.healthSubs[0]!.end()
      await flushLiveShellEffects()
    })

    expect(useConnectionStore.getState().streams.health.state).toBe('reconnecting')
    expect(useConnectionStore.getState().state).toBe('reconnecting')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Event subscription closed before all listeners released.') }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushLiveShellEffects()
    })

    expect(client.healthOptions).toHaveLength(2)
    expect(client.healthOptions[1]).toMatchObject({ reconnect: false, lastEventId: 'health-1', replayFrom: 'health-1' })
    expect(useConnectionStore.getState().streams.health.state).toBe('connected')
    expect(useConnectionStore.getState().state).toBe('connected')

    await act(async () => {
      client.healthSubs[1]!.fail(new TypeError('network down'))
      await flushLiveShellEffects()
    })

    expect(useConnectionStore.getState().streams.health.state).toBe('reconnecting')
    expect(useConnectionStore.getState().state).toBe('reconnecting')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'transport_loss', message: 'network down' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await flushLiveShellEffects()
    })

    expect(client.healthOptions).toHaveLength(3)
    expect(client.healthOptions[2]).toMatchObject({ reconnect: false, lastEventId: 'health-1', replayFrom: 'health-1' })
    expect(useConnectionStore.getState().streams.health.state).toBe('connected')
    expect(useConnectionStore.getState().state).toBe('connected')
  })

  it('cancels mounted subscriptions and resets independent cursors when the live scope changes', async () => {
    const client = new LiveShellClientDouble()
    const onEvent = vi.fn()

    await act(async () => {
      root.render(renderLiveShellHarness({ client, scopeId: 'scope-a', onEvent }))
      await flushLiveShellEffects()
    })

    await act(async () => {
      client.healthSubs[0]!.push(shellEvent('health-a', 'health.updated'))
      client.configSubs[0]!.push(shellEvent('config-a', 'config.updated'))
      await flushLiveShellEffects()
    })

    expect(useConnectionStore.getState().streams.health.lastEventId).toBe('health-a')
    expect(useConnectionStore.getState().streams.config.lastEventId).toBe('config-a')

    await act(async () => {
      root.render(renderLiveShellHarness({ client, scopeId: 'scope-b', onEvent }))
      await flushLiveShellEffects()
    })

    expect(client.healthSubs[0]!.closeReasons).toContain('last listener released')
    expect(client.configSubs[0]!.closeReasons).toContain('last listener released')
    expect(client.healthOptions[1]).toMatchObject({ lastEventId: null, replayFrom: null, reconnect: false })
    expect(client.configOptions[1]).toMatchObject({ lastEventId: null, replayFrom: null, reconnect: false })
    expect(useConnectionStore.getState().scopeId).toBe('scope-b')
    expect(useConnectionStore.getState().streams.health.lastEventId).toBe(null)
    expect(useConnectionStore.getState().streams.config.lastEventId).toBe(null)

    await act(async () => {
      client.healthSubs[0]!.push(shellEvent('late-health-a', 'health.updated'))
      await flushLiveShellEffects()
    })

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'late-health-a' }))
  })

  it('shares one underlying health and config subscription across shell consumers in the same scope', async () => {
    const client = new LiveShellClientDouble()
    const onEventA = vi.fn()
    const onEventB = vi.fn()

    await act(async () => {
      root.render(createElement('div', null,
        renderLiveShellHarness({ client, scopeId: 'scope-shared', onEvent: onEventA }),
        renderLiveShellHarness({ client, scopeId: 'scope-shared', onEvent: onEventB }),
      ))
      await flushLiveShellEffects()
    })

    expect(client.healthOptions).toHaveLength(1)
    expect(client.configOptions).toHaveLength(1)
    expect(client.healthOptions[0]).toMatchObject({
      topics: ['Gateway.StatusChanged'],
      reconnect: false,
    })
    expect(client.configOptions[0]).toMatchObject({
      topics: ['Gateway.StatusChanged'],
      reconnect: false,
    })

    await act(async () => {
      client.healthSubs[0]!.push(shellEvent('health-shared', 'health.updated'))
      await flushLiveShellEffects()
    })

    expect(onEventA).toHaveBeenCalledWith(expect.objectContaining({ id: 'health-shared' }))
    expect(onEventB).toHaveBeenCalledWith(expect.objectContaining({ id: 'health-shared' }))
  })

  it('routes both live shell streams to the exact peer in the query scope', async () => {
    const client = new LiveShellClientDouble()

    await act(async () => {
      root.render(renderLiveShellHarness({ client, scopeId: 'scope-peer', peerId: 'peer-python' }))
      await flushLiveShellEffects()
    })

    expect(client.healthOptions[0]).toMatchObject({
      payload: { selector: { peer_id: 'peer-python' } },
    })
    expect(client.configOptions[0]).toMatchObject({
      payload: { selector: { peer_id: 'peer-python' } },
    })
  })

  it('does not busy-retry terminal stream errors', async () => {
    const client = new LiveShellClientDouble({ healthError: new AuroraError({ code: 'unsupported_feature', message: 'Health stream unavailable' }) })
    const onError = vi.fn()

    await act(async () => {
      root.render(renderLiveShellHarness({ client, scopeId: 'scope-terminal', onError }))
      await flushLiveShellEffects()
    })

    expect(useConnectionStore.getState().streams.health.state).toBe('error')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported_feature' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      await flushLiveShellEffects()
    })

    expect(client.healthOptions).toHaveLength(1)
  })
})

interface LiveShellHarnessProps {
  client: AuroraClient | LiveShellClientDouble
  scopeId: string
  peerId?: string
  onEvent?: (event: AuroraEvent) => void
  onError?: (error: AuroraError) => void
}

function renderLiveShellHarness({ client, scopeId, peerId, onEvent = () => undefined, onError }: LiveShellHarnessProps) {
  return createElement(LiveShellHarness, { client, scopeId, ...(peerId ? { peerId } : {}), onEvent, ...(onError ? { onError } : {}) })
}

function LiveShellHarness({ client, scopeId, peerId, onEvent, onError }: LiveShellHarnessProps) {
  useAuroraLiveShellEvents({ client: client as AuroraClient, scopeId, queryScope: peerId ? { peerId } : undefined, onEvent: onEvent ?? (() => undefined), ...(onError ? { onError } : {}) })
  return null
}

class LiveShellClientDouble {
  readonly healthSubs: ControlledSubscription[] = []
  readonly configSubs: ControlledSubscription[] = []
  readonly healthOptions: unknown[] = []
  readonly configOptions: unknown[] = []
  readonly events = {
    watchHealth: vi.fn((options: unknown) => {
      this.healthOptions.push(options)
      if (this.healthError) throw this.healthError
      const subscription = new ControlledSubscription()
      this.healthSubs.push(subscription)
      return subscription
    }),
    watchConfig: vi.fn((options: unknown) => {
      this.configOptions.push(options)
      if (this.configError) throw this.configError
      const subscription = new ControlledSubscription()
      this.configSubs.push(subscription)
      return subscription
    })
  }

  readonly transport = { kind: 'mock', request: vi.fn() }

  constructor(private readonly options: { healthError?: Error; configError?: Error } = {}) {}

  private get healthError() {
    return this.options.healthError
  }

  private get configError() {
    return this.options.configError
  }
}

class ControlledSubscription implements AsyncIterable<AuroraEvent>, AsyncIterator<AuroraEvent> {
  readonly ready = Promise.resolve()
  readonly closed: Promise<void>
  readonly closeReasons: unknown[] = []
  private readonly queued: AuroraEvent[] = []
  private pending: { resolve: (result: IteratorResult<AuroraEvent>) => void; reject: (error: unknown) => void } | null = null
  private ended = false
  private failure: unknown = null
  private resolveClosed: () => void = () => undefined

  constructor() {
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

async function flushLiveShellEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

interface AuroraEventsHarnessProps {
  client: NativeEventsClientDouble
  lifecycleScopeKey: string
  onEvent: (event: AuroraEvent<NativePeerStatePayload>) => void
  onSnapshot: (snapshot: AuroraEventsSnapshot<NativePeerStatePayload>, context: unknown) => { recovered: true }
}

function renderAuroraEventsHarness(props: AuroraEventsHarnessProps) {
  return createElement(AuroraEventsHarness, props)
}

function AuroraEventsHarness({ client, lifecycleScopeKey, onEvent, onSnapshot }: AuroraEventsHarnessProps) {
  useAuroraEvents<NativePeerStatePayload>({
    client: client as unknown as Pick<AuroraClient, 'events'>,
    enabled: true,
    source: 'native',
    kinds: ['mesh.peer.state_changed'],
    subject: 'peer-a',
    bootstrapSnapshot: true,
    lifecycleScopeKey,
    onSnapshot
  }, onEvent)
  return null
}

interface NativePeerEventsHarnessProps {
  client: NativeEventsClientDouble
  store: NativePeerConnectionStoreDouble
  peerId: string
  scopeId: string
}

function renderNativePeerEventsHarness(props: NativePeerEventsHarnessProps) {
  return createElement(NativePeerEventsHarness, props)
}

function NativePeerEventsHarness({ client, store, peerId, scopeId }: NativePeerEventsHarnessProps) {
  useNativePeerEvents({
    client: client as unknown as Pick<AuroraClient, 'events'>,
    peerId,
    scopeId,
    connectionStore: store,
    enabled: true,
    nativeEventsSupported: true
  })
  return null
}

class NativeEventsClientDouble {
  readonly snapshotOptions: Array<Record<string, unknown> & { signal?: AbortSignal }> = []
  readonly subscribeOptions: Array<Record<string, unknown> & { signal?: AbortSignal }> = []
  readonly subscriptions: ControlledSubscription[] = []
  private readonly queuedSnapshots: Array<AuroraEventsSnapshot<NativePeerStatePayload>> = []
  private readonly pendingSnapshots: Array<{
    resolve: (snapshot: AuroraEventsSnapshot<NativePeerStatePayload>) => void
    reject: (error: unknown) => void
  }> = []

  readonly events = {
    snapshot: vi.fn(<TPayload,>(options: Record<string, unknown> & { signal?: AbortSignal }) => {
      this.snapshotOptions.push(options)
      const queued = this.queuedSnapshots.shift()
      if (queued) return Promise.resolve(queued as AuroraEventsSnapshot<TPayload>)
      return new Promise<AuroraEventsSnapshot<TPayload>>((resolve, reject) => {
        this.pendingSnapshots.push({
          resolve: (snapshot) => resolve(snapshot as AuroraEventsSnapshot<TPayload>),
          reject
        })
      })
    }),
    subscribe: vi.fn((options: Record<string, unknown> & { signal?: AbortSignal }) => {
      this.subscribeOptions.push(options)
      const subscription = new ControlledSubscription()
      this.subscriptions.push(subscription)
      return subscription
    })
  }

  queueSnapshot(snapshot: AuroraEventsSnapshot<NativePeerStatePayload>): void {
    this.queuedSnapshots.push(snapshot)
  }

  resolveSnapshot(index: number, snapshot: AuroraEventsSnapshot<NativePeerStatePayload>): void {
    const pending = this.pendingSnapshots[index]
    if (!pending) throw new Error(`Missing pending snapshot ${index}`)
    pending.resolve(snapshot)
  }
}

class NativePeerConnectionStoreDouble implements NativePeerConnectionStoreState {
  peerConnectionScopeId: string | null = null
  badge: NativePeerConnectionBadgeState = 'disconnected'
  lastEventId: string | null = null
  error: string | null = null

  get state() {
    return {
      peerConnectionScopeId: this.peerConnectionScopeId,
      badge: this.badge,
      lastEventId: this.lastEventId,
      error: this.error
    }
  }

  getState(): NativePeerConnectionStoreState {
    return this
  }

  setPeerState = (state: NativePeerConnectionBadgeState, details: NativePeerConnectionStateDetails = {}): void => {
    const record = details
    this.badge = state
    this.peerConnectionScopeId = record.peerConnectionScopeId ?? null
    this.lastEventId = record.lastEventId ?? null
    this.error = record.error ?? null
  }
}

function nativeEventsSnapshot(
  events: Array<AuroraEvent<NativePeerStatePayload>>,
  lastSequenceId: string,
  subjects: unknown[] = []
): AuroraEventsSnapshot<NativePeerStatePayload> {
  return {
    events,
    lastSequenceId,
    replayComplete: true,
    subjects
  }
}

function nativePeerEvent(id: string, peerId: string, status: string): AuroraEvent<NativePeerStatePayload> {
  const event = shellEvent(id, 'mesh.peer.state_changed')
  return {
    ...event,
    payload: { peerId, status },
    audit: {
      ...event.audit,
      peerId
    }
  }
}
