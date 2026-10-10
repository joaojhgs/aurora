// @vitest-environment jsdom
import { useEffect, useState, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
import { usePeerRoster, type PeerRosterState } from '../src/use-peer-roster'
import type { MeshPeersSnapshot } from '../src/mesh-peers-view'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetchQueries: vi.fn(),
  cancelQueries: vi.fn(),
  queryKey: ['admin', 'mesh-peers'],
  queryKeys: null as null | { admin: (_name: string, scope: unknown) => unknown[] },
  queryKeyScope: 'auth-a',
  stateScopeId: 'state-a',
  queryClient: null as null | { refetchQueries: ReturnType<typeof vi.fn>; cancelQueries: ReturnType<typeof vi.fn> },
  buildMeshPeersSnapshot: vi.fn(),
  buildLocalMeshNodeSnapshot: vi.fn(),
  reconcileMeshPeersWithThinPeer: vi.fn(),
  thinProjection: {
    snapshot: { status: 'connected', expectedStablePeerId: 'peer-1' },
    roster: { primaryPeerId: 'peer-1', peers: [] },
    evidence: { roundTripTimeMs: 12 },
    evidenceByPeer: new Map([['peer-1', { roundTripTimeMs: 12 }]]),
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mocks.useQuery(options),
  useQueryClient: () => {
    mocks.queryClient ??= { refetchQueries: mocks.refetchQueries, cancelQueries: mocks.cancelQueries }
    return mocks.queryClient
  },
}))

vi.mock('../src/query', () => ({
  AURORA_QUERY_STALE_TIMES: { volatile: 250 },
  useAuroraQueryScopeKey: () => ['aurora', mocks.queryKeyScope] as const,
  useAuroraStateScopeId: () => mocks.stateScopeId,
}))

vi.mock('../src/query-hooks', () => ({
  useAuroraQueryFallbackInterval: () => 15_000,
  useAuroraQueryKeys: () => {
    mocks.queryKeys ??= { admin: (_name: string, scope: unknown) => [...mocks.queryKey, mocks.queryKeyScope, scope] }
    return mocks.queryKeys
  },
}))

vi.mock('../src/thin-peer-diagnostics', () => ({
  useThinPeerDiagnosticsProjection: () => mocks.thinProjection,
}))

vi.mock('../src/mesh-peers-data', () => ({
  buildMeshPeersSnapshot: (...args: unknown[]) => mocks.buildMeshPeersSnapshot(...args),
  buildLocalMeshNodeSnapshot: (...args: unknown[]) => mocks.buildLocalMeshNodeSnapshot(...args),
  reconcileMeshPeersWithThinPeer: (...args: unknown[]) => mocks.reconcileMeshPeersWithThinPeer(...args),
}))

const roots: Root[] = []

type PeerRosterOptions = Parameters<typeof usePeerRoster>[0]
type PeerRosterProbeOptions = PeerRosterOptions & { onRoster?: (state: PeerRosterState) => void }

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.queryKeys = null
  mocks.queryKeyScope = 'auth-a'
  mocks.stateScopeId = 'state-a'
  mocks.queryClient = null
  mocks.useQuery.mockReturnValue({ isPending: true, isError: false, data: null })
  mocks.buildMeshPeersSnapshot.mockResolvedValue(snapshot('ready'))
  mocks.buildLocalMeshNodeSnapshot.mockImplementation((input) => snapshot('ready', input))
  mocks.cancelQueries.mockResolvedValue(undefined)
  mocks.reconcileMeshPeersWithThinPeer.mockImplementation((next) => next)
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('usePeerRoster', () => {
  it('configures the scoped home-server query and forwards the abort signal to the snapshot builder', async () => {
    render(<PeerRosterProbe options={baseOptions()} />)
    await flushReactWork()

    const queryOptions = firstUseQueryOptions()
    expect(queryOptions.queryKey).toEqual([
      ...mocks.queryKey,
      'auth-a',
      { routeId: 'mesh', routeState: 'available-local', routeDisabled: false, canManageLocalServiceConfiguration: true },
    ])
    expect(queryOptions.enabled).toBe(true)
    expect(queryOptions.staleTime).toBe(250)
    expect(queryOptions.refetchInterval).toBe(15_000)

    const signal = new AbortController().signal
    await queryOptions.queryFn({ signal })
    expect(mocks.buildMeshPeersSnapshot).toHaveBeenCalledWith(
      baseOptions().client,
      baseOptions().route,
      { canManageLocalServiceConfiguration: true, signal },
    )
  })

  it('replaces ready roster data with an empty denied snapshot when route access is revoked', async () => {
    const readySnapshot = snapshot('ready', { phase: 'ready' })
    readySnapshot.localNodeName = 'Home node'
    readySnapshot.peers = [{ peerId: 'peer-stale' } as never]
    readySnapshot.approvedCount = 1
    readySnapshot.runtimePeerCount = 1
    const states: PeerRosterState[] = []
    const readyOptions = baseOptions({ onRoster: (state) => states.push(state) })
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(readyOptions, readySnapshot) })
    const { root } = render(<PeerRosterProbe options={readyOptions} />)
    await flushReactWork()

    const deniedRoute = {
      ...baseOptions().route,
      state: 'denied' as const,
      disabled: true,
      explanation: 'Permission is needed before connected devices can be shown.',
      blockers: ['Sign in with an administrator account.'],
    }
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(readyOptions, readySnapshot) })

    await act(async () => {
      root.render(<PeerRosterProbe options={{ ...baseOptions({ onRoster: (state) => states.push(state) }), route: deniedRoute }} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const latest = states.at(-1)?.snapshot
    expect(latest?.loadState).toBe('denied')
    expect(latest?.peers).toEqual([])
    expect(latest?.approvedCount).toBe(0)
    expect(latest?.runtimePeerCount).toBe(0)
    expect(latest?.localNodeName).toBe('Unavailable')
    expect(latest?.error).toBe('Permission is needed before connected devices can be shown.')
    expect(mocks.reconcileMeshPeersWithThinPeer).toHaveBeenCalledTimes(1)
    expect(mocks.cancelQueries).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: [
        ...mocks.queryKey,
        'auth-a',
        { routeId: 'mesh', routeState: 'denied', routeDisabled: true, canManageLocalServiceConfiguration: true },
      ],
    }))
  })

  it('does not render previous-scope rows while a new allowed route scope is loading', async () => {
    const states: PeerRosterState[] = []
    const readySnapshot = snapshot('ready', { phase: 'ready' })
    readySnapshot.peers = [{ peerId: 'peer-old-scope' } as never]
    readySnapshot.approvedCount = 1
    const firstOptions = baseOptions({ onRoster: (state) => states.push(state) })
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(firstOptions, readySnapshot) })
    const { root } = render(<PeerRosterProbe options={firstOptions} />)
    await flushReactWork()
    expect(states.at(-1)?.snapshot.peers).toHaveLength(1)
    const reconcileCallsBeforeScopeChange = mocks.reconcileMeshPeersWithThinPeer.mock.calls.length

    const nextOptions = {
      ...baseOptions({ onRoster: (state) => states.push(state) }),
      route: {
        ...firstOptions.route,
        item: { ...firstOptions.route.item, id: 'mesh-next' },
      },
    }
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(firstOptions, readySnapshot) })

    await act(async () => {
      root.render(<PeerRosterProbe options={nextOptions} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const latest = states.at(-1)?.snapshot
    expect(latest?.loadState).toBe('loading')
    expect(latest?.peers).toEqual([])
    expect(latest?.approvedCount).toBe(0)
    expect(mocks.reconcileMeshPeersWithThinPeer).toHaveBeenCalledTimes(reconcileCallsBeforeScopeChange)
  })

  it('does not restore previous user rows when the query-key scope changes on the same route', async () => {
    const states: PeerRosterState[] = []
    const readySnapshot = snapshot('ready', { phase: 'ready' })
    readySnapshot.peers = [{ peerId: 'peer-from-old-user' } as never]
    readySnapshot.approvedCount = 1
    const options = baseOptions({ onRoster: (state) => states.push(state) })
    mocks.queryKeyScope = 'auth-a'
    mocks.stateScopeId = 'state-a'
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(options, readySnapshot) })
    const { root } = render(<PeerRosterProbe options={options} />)
    await flushReactWork()
    expect(states.at(-1)?.snapshot.peers).toHaveLength(1)

    mocks.queryKeyScope = 'auth-b'
    mocks.queryKeys = { admin: (_name: string, scope: unknown) => [...mocks.queryKey, mocks.queryKeyScope, scope] }
    mocks.useQuery.mockReturnValue({ isPending: false, isError: true, data: null })

    await act(async () => {
      root.render(<PeerRosterProbe options={{ ...options, onRoster: (state) => states.push(state) }} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const latest = states.at(-1)?.snapshot
    expect(latest?.loadState).toBe('error')
    expect(latest?.peers).toEqual([])
    expect(latest?.approvedCount).toBe(0)
    expect(mocks.reconcileMeshPeersWithThinPeer).toHaveBeenLastCalledWith(
      expect.objectContaining({ loadState: 'error', peers: [] }),
      expect.anything(),
      null,
      mocks.thinProjection.evidence,
    )
  })

  it('does not resubmit disabled snapshots when callers recreate an equivalent route object', async () => {
    const states: PeerRosterState[] = []
    const onRoster = (state: PeerRosterState) => states.push(state)
    const deniedRoute = () => ({
      ...baseOptions().route,
      state: 'denied' as const,
      disabled: true,
      explanation: 'Permission is needed before connected devices can be shown.',
      blockers: ['Sign in with an administrator account.'],
    })

    function FreshDeniedRouteProbe() {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        if (tick === 0) setTick(1)
      }, [tick])
      return <PeerRosterProbe options={{ ...baseOptions({ onRoster }), route: deniedRoute() }} />
    }

    render(<FreshDeniedRouteProbe />)
    await flushReactWork()

    expect(states.at(-1)?.snapshot.loadState).toBe('denied')
    expect(states.at(-1)?.snapshot.peers).toEqual([])
    expect(mocks.cancelQueries).toHaveBeenCalledTimes(1)
  })

  it('reconciles home-server query data with the current thin-peer projection', async () => {
    const queriedSnapshot = snapshot('ready')
    const options = baseOptions()
    const liveThinSnapshot = { status: 'connected', expectedStablePeerId: 'peer-live' }
    const thinPeer = {
      snapshot: vi.fn(() => liveThinSnapshot),
    }
    mocks.useQuery.mockReturnValue({ isPending: false, isError: false, data: scopedData(options, queriedSnapshot) })

    render(<PeerRosterProbe options={{ ...options, thinPeer: thinPeer as never }} />)
    await flushReactWork()

    expect(thinPeer.snapshot).toHaveBeenCalled()
    expect(mocks.reconcileMeshPeersWithThinPeer).toHaveBeenCalledWith(
      queriedSnapshot,
      liveThinSnapshot,
      expect.any(Object),
      mocks.thinProjection.evidence,
    )
  })

  it('does not surface stale local sharing from a previous provider while the next provider is loading', async () => {
    const states: PeerRosterState[] = []
    const providerALoad = deferred<LocalSharingSnapshotFixture>()
    const providerBLoad = deferred<LocalSharingSnapshotFixture>()
    const providerA = localSharingProvider(() => providerALoad.promise)
    const providerB = localSharingProvider(() => providerBLoad.promise)
    const localNode = { peerId: 'local-peer', nodeName: 'This device' }
    const firstOptions = {
      ...baseOptions({ onRoster: (state) => states.push(state) }),
      ownsLocalNodeState: true,
      localNode,
      localFeatureSharing: providerA,
    }
    const { root } = render(<PeerRosterProbe options={firstOptions} />)
    await flushReactWork()

    mocks.queryKeyScope = 'auth-b'
    mocks.stateScopeId = 'state-b'
    await act(async () => {
      root.render(
        <PeerRosterProbe
          options={{
            ...baseOptions({ onRoster: (state) => states.push(state) }),
            ownsLocalNodeState: true,
            localNode,
            localFeatureSharing: providerB,
          }}
        />,
      )
      await Promise.resolve()
    })

    providerALoad.resolve(localSharingSnapshot('approved-from-a'))
    await flushReactWork()

    expect(['loading', 'ready']).toContain(states.at(-1)?.snapshot.loadState)
    expect(states.at(-1)?.localSharingSnapshot).toBeNull()
    expect(mocks.buildLocalMeshNodeSnapshot).not.toHaveBeenCalledWith(expect.objectContaining({
      featureSharing: expect.objectContaining({ approvedDevices: [expect.objectContaining({ peerId: 'approved-from-a' })] }),
    }))

    providerBLoad.resolve(localSharingSnapshot('approved-from-b'))
    await flushReactWork()

    expect(states.at(-1)?.localSharingSnapshot?.approvedDevices[0]?.peerId).toBe('approved-from-b')
    expect(mocks.buildLocalMeshNodeSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      featureSharing: expect.objectContaining({ approvedDevices: [expect.objectContaining({ peerId: 'approved-from-b' })] }),
    }))
  })

  it('keeps same-scope local sharing visible while a refresh is pending', async () => {
    const states: PeerRosterState[] = []
    const refreshLoad = deferred<LocalSharingSnapshotFixture>()
    const load = vi.fn()
      .mockResolvedValueOnce(localSharingSnapshot('approved-current'))
      .mockImplementationOnce(() => refreshLoad.promise)
    const provider = localSharingProvider(load)
    render(
      <PeerRosterProbe
        options={{
          ...baseOptions({ onRoster: (state) => states.push(state) }),
          ownsLocalNodeState: true,
          localNode: { peerId: 'local-peer', nodeName: 'This device' },
          localFeatureSharing: provider,
        }}
      />,
    )
    await flushReactWork()

    expect(states.at(-1)?.localSharingSnapshot?.approvedDevices[0]?.peerId).toBe('approved-current')

    await act(async () => {
      void states.at(-1)?.loadPeers()
      await Promise.resolve()
    })

    expect(states.at(-1)?.localSharingSnapshot?.approvedDevices[0]?.peerId).toBe('approved-current')

    refreshLoad.resolve(localSharingSnapshot('approved-refreshed'))
    await flushReactWork()

    expect(states.at(-1)?.localSharingSnapshot?.approvedDevices[0]?.peerId).toBe('approved-refreshed')
  })

  it('uses local sharing subscriptions for local-node roster snapshots', async () => {
    const sharingSnapshot = { approvedDevices: [], pendingPairings: [] }
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((listener: (snapshot: typeof sharingSnapshot) => void) => {
      listener(sharingSnapshot)
      return unsubscribe
    })
    render(
      <PeerRosterProbe
        options={{
          ...baseOptions(),
          ownsLocalNodeState: true,
          localNode: { peerId: 'local-peer', nodeName: 'This device' },
          localFeatureSharing: {
            load: vi.fn(async () => sharingSnapshot),
            subscribe,
          } as never,
        }}
      />,
    )
    await flushReactWork()

    expect(firstUseQueryOptions().enabled).toBe(false)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.buildLocalMeshNodeSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      localNode: { peerId: 'local-peer', nodeName: 'This device' },
      thinPeer: mocks.thinProjection.snapshot,
      peerRoster: mocks.thinProjection.roster,
      connectionEvidence: mocks.thinProjection.evidence,
      connectionEvidenceByPeer: mocks.thinProjection.evidenceByPeer,
      featureSharing: sharingSnapshot,
      sharingAvailable: true,
    }))
  })
})

type LocalSharingSnapshotFixture = {
  approvedDevices: { peerId: string; peerLabel: string; featureIds: string[]; expiresAtMs: null }[]
  features: never[]
}

function localSharingSnapshot(peerId: string): LocalSharingSnapshotFixture {
  return {
    features: [],
    approvedDevices: [{ peerId, peerLabel: peerId, featureIds: [], expiresAtMs: null }],
  }
}

function localSharingProvider(load: () => Promise<LocalSharingSnapshotFixture>) {
  return { load } as never
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type PeerRosterQueryOptions = {
  queryKey: unknown
  enabled: boolean
  staleTime: unknown
  refetchInterval: unknown
  queryFn: (input: { signal: AbortSignal }) => Promise<unknown>
}

function firstUseQueryOptions(): PeerRosterQueryOptions {
  const firstCall = mocks.useQuery.mock.calls[0]
  if (!firstCall) {
    throw new Error('Expected usePeerRoster to configure the mesh peers query.')
  }
  const options = firstCall[0]
  if (!isPeerRosterQueryOptions(options)) {
    throw new Error('Expected usePeerRoster to pass complete query options.')
  }
  return options
}

function isPeerRosterQueryOptions(value: unknown): value is PeerRosterQueryOptions {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PeerRosterQueryOptions>
  return (
    'queryKey' in candidate
    && typeof candidate.enabled === 'boolean'
    && 'staleTime' in candidate
    && 'refetchInterval' in candidate
    && typeof candidate.queryFn === 'function'
  )
}

function PeerRosterProbe({ options }: { options: PeerRosterProbeOptions }) {
  const roster = usePeerRoster(options)
  const onRoster = (options as { onRoster?: (state: PeerRosterState) => void }).onRoster
  useEffect(() => {
    onRoster?.(roster)
  }, [onRoster, roster])
  return null
}

function render(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return { container, root }
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function baseOptions(extra: Partial<PeerRosterProbeOptions> = {}): PeerRosterProbeOptions {
  return {
    client: partialRosterClient(),
    route: {
      item: {
        id: 'mesh',
        label: 'Connected devices',
        href: '/mesh',
        capabilityModule: 'gateway',
        methodType: 'use',
        privacyClass: 'public',
        fallbackState: 'available-local',
        expectedTask: 'Review connected devices',
      },
      state: 'available-local',
      explanation: 'Ready',
      providerLabel: 'Aurora',
      blockers: [],
      repairActions: [],
      candidateProviders: [],
      evidenceSources: [],
      selectorRequired: false,
      approvalRequired: false,
      routeable: true,
      disabled: false,
      requiresAdminAction: false,
    },
    thinPeer: undefined,
    localFeatureSharing: undefined,
    localNode: undefined,
    ownsLocalNodeState: false,
    canManageLocalServiceConfiguration: true,
    ...extra,
  }
}

function partialRosterClient(): AuroraClient {
  // Partial SDK test double: usePeerRoster only forwards this object to the mocked snapshot builder.
  return { transport: { kind: 'mock' } } as unknown as AuroraClient
}

function scopedData(options: PeerRosterOptions, nextSnapshot: MeshPeersSnapshot) {
  return {
    scopeKey: JSON.stringify([
      ...mocks.queryKey,
      mocks.queryKeyScope,
      {
        routeId: options.route.item.id,
        routeState: options.route.state,
        routeDisabled: options.route.disabled,
        canManageLocalServiceConfiguration: options.canManageLocalServiceConfiguration,
      },
    ]),
    snapshot: nextSnapshot,
  }
}

function snapshot(loadState: MeshPeersSnapshot['loadState'], extra: unknown = null): MeshPeersSnapshot {
  return {
    loadState,
    generatedAt: null,
    localPeerId: null,
    localNodeName: 'Node',
    meshEnabled: true,
    meshStarted: true,
    webrtcStarted: true,
    inviteConfig: null,
    secretsRedacted: true,
    peers: [],
    pendingRequests: [],
    liveSessions: [],
    devices: [],
    pendingCount: 0,
    approvedCount: 0,
    deniedCount: 0,
    removedCount: 0,
    runtimePeerCount: 0,
    liveSessionCount: 0,
    deviceCount: 0,
    routeCount: 0,
    compatibilityFailures: [],
    listState: 'available-local',
    listReason: 'Ready',
    statusState: 'available-local',
    statusReason: 'Ready',
    mutationState: 'available-local',
    mutationReason: 'Ready',
    config: {
      fields: [],
      state: 'available-local',
      reason: 'Ready',
      secretsRedacted: true,
      editable: true,
      warnings: [],
    },
    warnings: extra ? [JSON.stringify(extra)] : [],
    error: null,
    evidenceSource: 'test',
    transportKind: 'mock',
    fixtureOnly: false,
  }
}
