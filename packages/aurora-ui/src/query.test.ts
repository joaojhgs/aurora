// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useQuery } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuroraError,
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  gatewayRegistryFixture,
  nativeCapabilityManifestFixture,
  type AuroraClient,
  type CapabilityGraph,
  type NativeCapabilityManifest
} from '@aurora/client'
import {
  AURORA_QUERY_FALLBACK_INTERVAL_MS,
  AURORA_QUERY_STALE_TIMES,
  AuroraQueryProvider,
  auroraQueryRetry,
  createAuroraQueryClient,
  getAuroraQueryClient,
  createAuroraQueryScopeId,
  isAuroraTerminalQueryData,
  isAuroraTerminalQueryError
} from './query'
import {
  auroraQueryFallbackInterval,
  auroraQueryFallbackIntervalForConnectionState,
  createAuroraQueryKeys,
  fetchAuroraShellSnapshot,
  useAuroraQueryFallbackInterval,
  useAuroraQueryKeys
} from './query-hooks'
import { useConnectionStore } from './state/connection-store'
import { useSurfaceStore } from './state/surface-store'
import { useAssistantStreamStore } from './state/assistant-stream-store'

afterEach(() => {
  vi.useRealTimers()
})

describe('Aurora query policy', () => {
  it('restores a remaining provider scope when the active peer provider unmounts', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const clientA = scopedClient({ principalId: 'user-a', peerId: 'peer-a' })
    const clientB = scopedClient({ principalId: 'user-b', peerId: 'peer-b' })
    const scopeA = createAuroraQueryScopeId(clientA)
    const scopeB = createAuroraQueryScopeId(clientB)
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const renderProviders = (includeB: boolean) => createElement('div', null,
      createElement(AuroraQueryProvider, { key: 'a', client: clientA, queryClient, children: null }),
      includeB ? createElement(AuroraQueryProvider, { key: 'b', client: clientB, queryClient, children: null }) : null)
    try {
      await act(async () => root.render(renderProviders(true)))
      useSurfaceStore.getState().setSurface({ kind: 'android', isMobile: true, isNative: true }, { scopeId: scopeA })
      useAssistantStreamStore.getState().begin('message-a', { scopeId: scopeA })
      expect(useSurfaceStore.getState().activeScopeId).toBe(scopeB)

      await act(async () => root.render(renderProviders(false)))
      expect(useSurfaceStore.getState().activeScopeId).toBe(scopeA)
      expect(useSurfaceStore.getState().kind).toBe('android')
      expect(useAssistantStreamStore.getState().activeScopeId).toBe(scopeA)
      expect(useAssistantStreamStore.getState().messageId).toBe('message-a')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
    }
  })

  it('reuses the browser query client while isolating server requests', () => {
    expect(getAuroraQueryClient()).toBe(getAuroraQueryClient())
    vi.stubGlobal('window', undefined)
    try {
      expect(getAuroraQueryClient()).not.toBe(getAuroraQueryClient())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retains shared cached data until the last provider for that scope unmounts', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const client = scopedClient({ principalId: 'shared-owner' })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const reads = vi.fn(async (owner: string) => ({ owner }))
    const containers = [document.createElement('div'), document.createElement('div')]
    const roots = containers.map((container) => createRoot(container))
    let firstUnmounted = false
    try {
      await act(async () => {
        for (const root of roots) root.render(createElement(AuroraQueryProvider, {
          client,
          queryClient,
          children: createElement(ScopedOwnerProbe, { owner: 'shared-owner', reads })
        }))
        await flushReactQueryWork()
      })
      expect(reads).toHaveBeenCalledTimes(1)
      expect(queryClient.getDefaultOptions().queries?.retry).toBe(false)
      await act(async () => roots[0]!.unmount())
      firstUnmounted = true
      const cached = queryClient.getQueryCache().findAll({ queryKey: ['aurora'] })
      expect(cached).toHaveLength(1)
      expect(cached[0]!.state.data).toEqual({ owner: 'shared-owner' })
    } finally {
      await act(async () => {
        if (!firstUnmounted) roots[0]!.unmount()
        roots[1]!.unmount()
      })
    }
    expect(queryClient.getQueryCache().findAll({ queryKey: ['aurora'] })).toHaveLength(0)
    queryClient.clear()
  })

  it('uses durable stale times and disables focus refetch on mobile', () => {
    const desktop = createAuroraQueryClient()
    const mobile = createAuroraQueryClient({}, { isMobile: true })

    expect(desktop.getDefaultOptions().queries?.staleTime).toBe(AURORA_QUERY_STALE_TIMES.lists)
    expect(desktop.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(true)
    expect(mobile.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })

  it('only retries transport-like failures', () => {
    expect(auroraQueryRetry(0, new AuroraError({ code: 'permission', message: 'denied' }))).toBe(false)
    expect(auroraQueryRetry(0, new AuroraError({ code: 'timeout', message: 'slow' }))).toBe(true)
    expect(auroraQueryRetry(1, new AuroraError({ code: 'timeout', message: 'slow' }))).toBe(true)
    expect(auroraQueryRetry(2, new AuroraError({ code: 'timeout', message: 'slow' }))).toBe(false)
  })

  it('classifies terminal query errors once for retries and interval polling', () => {
    expect(isAuroraTerminalQueryError(new AuroraError({ code: 'auth', message: 'expired' }))).toBe(true)
    expect(isAuroraTerminalQueryError(new AuroraError({ code: 'permission', message: 'denied' }))).toBe(true)
    expect(isAuroraTerminalQueryError(new AuroraError({ code: 'privacy_blocked', message: 'private' }))).toBe(true)
    expect(isAuroraTerminalQueryError(new AuroraError({ code: 'native_permission_missing', message: 'microphone' }))).toBe(true)
    expect(isAuroraTerminalQueryError(new AuroraError({ code: 'timeout', message: 'slow' }))).toBe(false)
  })

  it('classifies explicit terminal query data without discarding partial snapshots', () => {
    expect(isAuroraTerminalQueryData({ loadState: 'denied', error: 'Permission is needed' })).toBe(true)
    expect(isAuroraTerminalQueryData({ queryFailure: { code: 'permission', message: 'Permission is needed' } })).toBe(true)
    expect(isAuroraTerminalQueryData({ loadState: 'service-unavailable', error: 'Aurora unavailable' })).toBe(false)
    expect(isAuroraTerminalQueryData({ state: 'degraded', error: new AuroraError({ code: 'unavailable_service', message: 'offline' }) })).toBe(false)
    expect(isAuroraTerminalQueryData({ supportBundle: { data: null, error: 'forbidden', denied: true } })).toBe(false)
  })

  it('falls back to bounded polling until the event stream is connected', () => {
    useConnectionStore.getState().reset()
    expect(auroraQueryFallbackInterval()).toBe(AURORA_QUERY_FALLBACK_INTERVAL_MS)
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId: 'scope-test', lastEventId: 'health-1' })
    useConnectionStore.getState().setStreamState('config', 'connected', { scopeId: 'scope-test', lastEventId: 'config-1' })
    expect(auroraQueryFallbackInterval()).toBe(false)
    useConnectionStore.getState().reset()
  })

  it('keeps explicit fallback polling for resources without a typed subscription', () => {
    expect(auroraQueryFallbackIntervalForConnectionState('connected')).toBe(false)
    expect(auroraQueryFallbackIntervalForConnectionState('connected', { subscriptionAvailable: false })).toBe(
      AURORA_QUERY_FALLBACK_INTERVAL_MS
    )
  })

  it('switches a scoped query between live mode and the 15-second stream fallback', async () => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useConnectionStore.getState().reset()
    const client = scopedClient({ principalId: 'user-a', peerId: 'peer-a' })
    const queryScope = { backend: 'home-a', profileId: 'profile-a' }
    const scopeId = createAuroraQueryScopeId(client, queryScope)
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId })
    useConnectionStore.getState().setStreamState('config', 'connected', { scopeId })

    const reads = vi.fn(async () => ({ revision: reads.mock.calls.length }))
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(
          AuroraQueryProvider,
          {
            client,
            queryClient,
            queryScope,
            children: createElement(StreamFallbackProbe, { reads })
          }
        ))
        await flushReactQueryWork()
      })
      expect(reads).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AURORA_QUERY_FALLBACK_INTERVAL_MS)
      })
      expect(reads).toHaveBeenCalledTimes(1)

      await act(async () => {
        useConnectionStore.getState().setStreamState('health', 'reconnecting', { scopeId })
        await flushReactQueryWork()
        await vi.advanceTimersByTimeAsync(AURORA_QUERY_FALLBACK_INTERVAL_MS)
      })
      expect(reads).toHaveBeenCalledTimes(2)

      const queryKey = queryClient.getQueryCache().findAll()[0]?.queryKey
      expect(queryKey).toBeDefined()
      const dataDuringLoss = queryClient.getQueryData(queryKey!)
      expect(dataDuringLoss).toEqual({ revision: 2 })

      await act(async () => {
        useConnectionStore.getState().setStreamState('health', 'connected', { scopeId, lastEventId: 'health-2' })
        await flushReactQueryWork()
        await vi.advanceTimersByTimeAsync(AURORA_QUERY_FALLBACK_INTERVAL_MS)
      })
      expect(reads).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryData(queryKey!)).toEqual(dataDuringLoss)

      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKey! })
        await flushReactQueryWork()
      })
      expect(reads).toHaveBeenCalledTimes(3)
      expect(queryClient.getQueryData(queryKey!)).toEqual({ revision: 3 })
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      useConnectionStore.getState().reset()
    }
  })

  it('stops fallback polling after terminal errors', () => {
    const denied = new AuroraError({ code: 'permission', message: 'denied' })
    const blocked = new AuroraError({ code: 'privacy_blocked', message: 'private' })
    const unavailable = new AuroraError({ code: 'unavailable_service', message: 'offline' })

    expect(auroraQueryFallbackIntervalForConnectionState('disconnected', {}, denied)).toBe(false)
    expect(auroraQueryFallbackIntervalForConnectionState('connected', { subscriptionAvailable: false }, blocked)).toBe(false)
    expect(auroraQueryFallbackIntervalForConnectionState('connected', { subscriptionAvailable: false }, unavailable)).toBe(
      AURORA_QUERY_FALLBACK_INTERVAL_MS
    )
  })

  it('does not interval-refetch a mounted query after terminal denial data resolves successfully', async () => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useConnectionStore.getState().reset()
    const reads = vi.fn(async () => ({ loadState: 'denied' as const, error: 'Permission is needed' }))
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(
          AuroraQueryProvider,
          { client: scopedClient({ principalId: 'user-a' }), queryClient, children: createElement(TerminalDataPollingProbe, { reads }) }
        ))
      })
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AURORA_QUERY_FALLBACK_INTERVAL_MS * 2)
      })

      expect(reads).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      useConnectionStore.getState().reset()
    }
  })

  it('keeps interval polling when healthy query data contains a nested denied entry', async () => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useConnectionStore.getState().reset()
    const reads = vi.fn(async () => ({
      loadState: 'ready' as const,
      supportBundle: { data: null, error: 'forbidden', denied: true }
    }))
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(
          AuroraQueryProvider,
          { client: scopedClient({ principalId: 'user-a' }), queryClient, children: createElement(NestedDeniedPollingProbe, { reads }) }
        ))
      })
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AURORA_QUERY_FALLBACK_INTERVAL_MS)
      })

      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      useConnectionStore.getState().reset()
    }
  })


  it('dedupes concurrent scoped reads and serves fresh data inside the stale window', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const pending = deferred<{ owner: string }>()
    const reads = vi.fn(() => pending.promise)
    const queryClient = createAuroraQueryClient()
    const client = scopedClient({ principalId: 'user-a', peerId: 'peer-a' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(
          AuroraQueryProvider,
          {
            client,
            queryClient,
            queryScope: { backend: 'home-a', profileId: 'profile-a' },
            children: createElement(ConcurrentScopedQueryProbe, { reads })
          }
        ))
      })

      expect(reads).toHaveBeenCalledTimes(1)

      await act(async () => {
        pending.resolve({ owner: 'user-a' })
        await flushReactQueryWork()
      })

      await act(async () => {
        root.render(createElement(
          AuroraQueryProvider,
          {
            client,
            queryClient,
            queryScope: { backend: 'home-a', profileId: 'profile-a' },
            children: createElement(ConcurrentScopedQueryProbe, { reads })
          }
        ))
        await flushReactQueryWork()
      })

      expect(reads).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
    }
  })

  it('isolates mounted query data across auth and peer scopes sharing one query client', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const reads = vi.fn(async (owner: string) => ({ owner }))
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(
          'div',
          null,
          createElement(
            AuroraQueryProvider,
            {
              client: scopedClient({ principalId: 'user-a', deviceId: 'device-a', peerId: 'peer-a' }),
              queryClient,
              queryScope: { backend: 'home-shared', profileId: 'profile-a' },
              children: createElement(ScopedOwnerProbe, { owner: 'user-a', reads })
            }
          ),
          createElement(
            AuroraQueryProvider,
            {
              client: scopedClient({ principalId: 'user-b', deviceId: 'device-b', peerId: 'peer-b' }),
              queryClient,
              queryScope: { backend: 'home-shared', profileId: 'profile-a' },
              children: createElement(ScopedOwnerProbe, { owner: 'user-b', reads })
            }
          )
        ))
        await flushReactQueryWork()
      })

      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
      expect(reads).toHaveBeenCalledWith('user-a')
      expect(reads).toHaveBeenCalledWith('user-b')
      const serviceQueries = queryClient.getQueryCache().findAll({ queryKey: ['aurora'] })
        .filter((query) => query.queryKey[2] === 'services')
      expect(serviceQueries).toHaveLength(2)
      expect(new Set(serviceQueries.map((query) => query.queryKey[1]))).toHaveLength(2)
      expect(serviceQueries.map((query) => query.state.data)).toEqual(expect.arrayContaining([
        { owner: 'user-a' },
        { owner: 'user-b' }
      ]))
    } finally {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
    }
  })

  it('settles aborted shell snapshot refreshes when native manifest hangs after the graph succeeds', async () => {
    const queryClient = createAuroraQueryClient()
    const controller = new AbortController()
    const signal = controller.signal
    const addListener = vi.spyOn(signal, 'addEventListener')
    const removeListener = vi.spyOn(signal, 'removeEventListener')
    const graph = shellCapabilityGraph()
    const native = deferred<NativeCapabilityManifest>()
    const nativeManifest = vi.fn((_signal?: AbortSignal) => native.promise)
    const client = shellSnapshotClient(graph)

    const snapshot = fetchAuroraShellSnapshot({
      client,
      queryClient,
      scopeKey: ['aurora', 'abort-scope'],
      nativeManifest,
      signal
    })

    await flushReactQueryWork()
    expect(nativeManifest).toHaveBeenCalledWith(signal)
    expect(client.capabilities.getGraph).toHaveBeenCalledTimes(1)

    controller.abort()

    await expect(snapshot).rejects.toMatchObject({ name: 'AbortError' })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    native.resolve(nativeCapabilityManifestFixture)
    await flushReactQueryWork()
    const graphQueryKey = createAuroraQueryKeys(['aurora', 'abort-scope'])
      .capabilityGraph({ include_unavailable: true, include_internal: true })
    expect(queryClient.getQueryData(graphQueryKey)).toBe(graph)
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
  })

  it('bypasses a fresh capability graph cache only for explicit recovery refreshes', async () => {
    const queryClient = createAuroraQueryClient()
    const graph = shellCapabilityGraph()
    const client = shellSnapshotClient(graph)
    const base = {
      client,
      queryClient,
      scopeKey: ['aurora', 'recovery-cache'] as const,
    }
    const read = (forceRefresh = false) => fetchAuroraShellSnapshot({
      ...base,
      ...(forceRefresh ? { forceRefresh: true } : {}),
    })

    await read()
    await read()
    expect(client.capabilities.getGraph).toHaveBeenCalledTimes(1)

    await read(true)
    expect(client.capabilities.getGraph).toHaveBeenCalledTimes(2)
    await read(true)
    expect(client.capabilities.getGraph).toHaveBeenCalledTimes(3)

    queryClient.clear()
  })

  it('cleans abort listeners after native manifest settlement and preserves shell snapshot data', async () => {
    const queryClient = createAuroraQueryClient()
    const controller = new AbortController()
    const signal = controller.signal
    const removeListener = vi.spyOn(signal, 'removeEventListener')
    const graph = shellCapabilityGraph()
    const native = deferred<NativeCapabilityManifest>()
    const nativeManifest = vi.fn((_signal?: AbortSignal) => native.promise)

    const snapshot = fetchAuroraShellSnapshot({
      client: shellSnapshotClient(graph),
      queryClient,
      scopeKey: ['aurora', 'success-scope'],
      nativeManifest,
      signal
    })

    await flushReactQueryWork()
    native.resolve(nativeCapabilityManifestFixture)

    await expect(snapshot).resolves.toMatchObject({
      loadState: 'ready',
      nativeAvailable: true,
      nativePlatform: nativeCapabilityManifestFixture.platform
    })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('normalizes native AbortError results when the shell refresh signal did not abort', async () => {
    const queryClient = createAuroraQueryClient()
    const controller = new AbortController()
    const graph = shellCapabilityGraph()
    const nativeManifest = vi.fn(async () => {
      throw new DOMException('Native command aborted independently', 'AbortError')
    })

    const snapshot = await fetchAuroraShellSnapshot({
      client: shellSnapshotClient(graph),
      queryClient,
      scopeKey: ['aurora', 'native-abort-normalized'],
      nativeManifest,
      signal: controller.signal
    })

    expect(controller.signal.aborted).toBe(false)
    expect(nativeManifest).toHaveBeenCalledWith(controller.signal)
    expect(snapshot).toMatchObject({
      loadState: 'ready',
      nativeAvailable: false,
      nativePlatform: 'not available'
    })
  })

  it('attaches native promise handlers when the manifest callback aborts synchronously', async () => {
    const queryClient = createAuroraQueryClient()
    const controller = new AbortController()
    const signal = controller.signal
    const addListener = vi.spyOn(signal, 'addEventListener')
    const removeListener = vi.spyOn(signal, 'removeEventListener')
    const native = deferred<NativeCapabilityManifest>()
    const thenSpy = vi.spyOn(native.promise, 'then')
    const nativeManifest = vi.fn(() => {
      controller.abort()
      return native.promise
    })

    const snapshot = fetchAuroraShellSnapshot({
      client: shellSnapshotClient(shellCapabilityGraph()),
      queryClient,
      scopeKey: ['aurora', 'sync-native-abort'],
      nativeManifest,
      signal
    })

    await expect(snapshot).rejects.toMatchObject({ name: 'AbortError' })
    expect(thenSpy).toHaveBeenCalled()
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    native.resolve(nativeCapabilityManifestFixture)
    await flushReactQueryWork()
  })

  it('scopes query keys by backend and identity', () => {
    const clientA = scopedClient({ transport: 'http', principalId: 'user-a', deviceId: 'device-a', peerId: 'peer-a' })
    const clientB = scopedClient({ transport: 'http', principalId: 'user-b', deviceId: 'device-b', peerId: 'peer-b' })
    const scopeA = createAuroraQueryScopeId(clientA, { backend: 'https://home-a.example.test/token', profileId: 'profile-a' })
    const scopeB = createAuroraQueryScopeId(clientB, { backend: 'https://home-b.example.test/token', profileId: 'profile-b' })
    expect(scopeA).not.toBe(scopeB)
    expect(scopeA).not.toContain('home-a')
    expect(scopeA).not.toContain('profile-a')
    expect(createAuroraQueryKeys(['aurora', scopeA]).services()).toEqual(['aurora', scopeA, 'services'])
    expect(createAuroraQueryKeys(['aurora', scopeA]).capabilities({ include_internal: true })).toEqual([
      'aurora',
      scopeA,
      'capabilities',
      { include_internal: true }
    ])
  })

  it('changes scope when auth state changes for the same principal and device', () => {
    const client = scopedClient({ principalId: 'user-a', deviceId: 'device-a', state: 'user' })
    const userScope = createAuroraQueryScopeId(client, { backend: 'home-a' })
    const revokedScope = createAuroraQueryScopeId(
      client,
      { backend: 'home-a' },
      {
        state: 'revoked',
        principalId: 'user-a',
        deviceId: 'device-a',
        peerId: null,
        credentialKind: 'bearer_token',
        status: 401,
        effectivePermissions: []
      }
    )
    const expiredScope = createAuroraQueryScopeId(
      client,
      { backend: 'home-a' },
      {
        state: 'expired',
        principalId: 'user-a',
        deviceId: 'device-a',
        peerId: null,
        credentialKind: 'bearer_token',
        status: 401,
        effectivePermissions: []
      }
    )
    const permissionsChangedScope = createAuroraQueryScopeId(
      client,
      { backend: 'home-a' },
      {
        state: 'user',
        principalId: 'user-a',
        deviceId: 'device-a',
        peerId: null,
        credentialKind: 'bearer_token',
        effectivePermissions: ['tools:read']
      }
    )
    const adminScope = createAuroraQueryScopeId(
      client,
      { backend: 'home-a' },
      {
        state: 'admin',
        principalId: 'user-a',
        deviceId: 'device-a',
        peerId: null,
        credentialKind: 'bearer_token',
        isAdmin: true,
        effectivePermissions: []
      }
    )
    const peerChangedScope = createAuroraQueryScopeId(
      client,
      { backend: 'home-a' },
      {
        state: 'user',
        principalId: 'user-a',
        deviceId: 'device-a',
        peerId: 'peer-b',
        credentialKind: 'bearer_token',
        effectivePermissions: []
      }
    )
    expect(userScope).not.toBe(revokedScope)
    expect(userScope).not.toBe(expiredScope)
    expect(userScope).not.toBe(permissionsChangedScope)
    expect(userScope).not.toBe(adminScope)
    expect(userScope).not.toBe(peerChangedScope)
  })

  it('does not satisfy a new identity query from an old identity result', () => {
    const queryClient = createAuroraQueryClient()
    const scopeA = createAuroraQueryScopeId(scopedClient({ principalId: 'user-a' }), { backend: 'home-a' })
    const scopeB = createAuroraQueryScopeId(scopedClient({ principalId: 'user-b' }), { backend: 'home-a' })
    const keysA = createAuroraQueryKeys(['aurora', scopeA])
    const keysB = createAuroraQueryKeys(['aurora', scopeB])
    queryClient.setQueryData(keysA.services(), { owner: 'user-a' })
    expect(queryClient.getQueryData(keysB.services())).toBeUndefined()
    queryClient.removeQueries({ queryKey: ['aurora', scopeA] })
    expect(queryClient.getQueryData(keysA.services())).toBeUndefined()
  })
})


function shellCapabilityGraph(): CapabilityGraph {
  return buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    transportKind: 'mock',
    nativeManifest: nativeCapabilityManifestFixture
  })
}

function shellSnapshotClient(graph: CapabilityGraph): AuroraClient {
  return {
    transport: { kind: 'mock' },
    capabilities: {
      getGraph: vi.fn(async () => graph)
    },
    native: {
      getManifest: vi.fn(async () => nativeCapabilityManifestFixture)
    }
  } as unknown as AuroraClient
}

function ConcurrentScopedQueryProbe({ reads }: { reads: () => Promise<{ owner: string }> }) {
  return createElement(
    'div',
    null,
    createElement(ScopedQueryReader, { reads }),
    createElement(ScopedQueryReader, { reads })
  )
}

function ScopedQueryReader({ reads }: { reads: () => Promise<{ owner: string }> }) {
  const queryKeys = useAuroraQueryKeys()
  useQuery({
    queryKey: queryKeys.services(),
    queryFn: reads,
    staleTime: AURORA_QUERY_STALE_TIMES.lists
  })
  return null
}

function ScopedOwnerProbe({ owner, reads }: { owner: string; reads: (owner: string) => Promise<{ owner: string }> }) {
  const queryKeys = useAuroraQueryKeys()
  useQuery({
    queryKey: queryKeys.services(),
    queryFn: () => reads(owner),
    staleTime: AURORA_QUERY_STALE_TIMES.lists
  })
  return null
}

async function flushReactQueryWork(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) await Promise.resolve()
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

function TerminalDataPollingProbe({ reads }: { reads: () => Promise<{ loadState: 'denied'; error: string }> }) {
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  useQuery({
    queryKey: ['terminal-data-polling-probe'],
    queryFn: reads,
    staleTime: 0,
    refetchInterval: fallbackInterval
  })
  return null
}

function NestedDeniedPollingProbe({
  reads
}: {
  reads: () => Promise<{ loadState: 'ready'; supportBundle: { data: null; error: string; denied: boolean } }>
}) {
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  useQuery({
    queryKey: ['nested-denied-polling-probe'],
    queryFn: reads,
    staleTime: 0,
    refetchInterval: fallbackInterval
  })
  return null
}

function StreamFallbackProbe({ reads }: { reads: () => Promise<{ revision: number }> }) {
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval()
  useQuery({
    queryKey: [...queryKeys.root(), 'fallback-regression'],
    queryFn: reads,
    staleTime: 0,
    refetchInterval: fallbackInterval
  })
  return null
}

function scopedClient(input: {
  transport?: string
  principalId?: string
  deviceId?: string
  peerId?: string
  state?: string
  isAdmin?: boolean
  effectivePermissions?: string[]
} = {}) {
  return {
    transport: { kind: input.transport ?? 'mock' },
    auth: {
      subscribe: () => () => undefined,
      snapshot: () => ({
        state: input.state ?? (input.principalId ? 'user' : 'anonymous'),
        principalId: input.principalId ?? null,
        deviceId: input.deviceId ?? null,
        peerId: input.peerId ?? null,
        credentialKind: input.principalId ? 'bearer_token' : 'none',
        isAdmin: input.isAdmin ?? false,
        effectivePermissions: input.effectivePermissions ?? []
      })
    }
  } as unknown as AuroraClient
}
