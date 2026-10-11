'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuroraClient, AuroraError } from '@aurora/client'
import type { SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import type {
  LocalFeatureSharingPort,
  LocalFeatureSharingSnapshot,
} from './local-feature-sharing'
import type { RouteAvailability } from './shell-data'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from './web-thin-runtime'
import { AURORA_QUERY_STALE_TIMES, useAuroraQueryScopeKey, useAuroraStateScopeId } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import { useThinPeerDiagnosticsProjection } from './thin-peer-diagnostics'
import {
  buildLocalMeshNodeSnapshot,
  buildMeshPeersSnapshot,
  reconcileMeshPeersWithThinPeer,
} from './mesh-peers-data'
import type {
  LocalMeshNodeIdentity,
  MeshPeersSnapshot,
} from './mesh-peers-view'

export const loadingMeshPeersSnapshot: MeshPeersSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  localPeerId: null,
  localNodeName: 'Checking connection',
  meshEnabled: false,
  meshStarted: false,
  webrtcStarted: false,
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
  listState: 'pending',
  listReason: 'Loading devices and pending requests through Aurora.',
  statusState: 'pending',
  statusReason: 'Loading mesh status through Aurora.',
  mutationState: 'pending',
  mutationReason: 'Loading device management capabilities.',
  config: {
    fields: [],
    state: 'pending',
    reason: 'Loading mesh settings.',
    secretsRedacted: true,
    editable: false,
    warnings: [],
  },
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls',
  transportKind: 'pending',
  fixtureOnly: false,
}

export interface PeerRosterState {
  snapshot: MeshPeersSnapshot
  loadPeers: () => Promise<void>
  thinPeerSnapshot: BrowserWebRtcSnapshot | null
  thinPeerEvidence: SelectedCandidatePairEvidence | null
  localSharingSnapshot: LocalFeatureSharingSnapshot | null
}

interface ScopedMeshPeersSnapshot {
  scopeKey: string
  snapshot: MeshPeersSnapshot
}

interface ScopedLocalMeshPeersSnapshot {
  scopeKey: string
  snapshot: MeshPeersSnapshot
}

interface ScopedLocalSharingSnapshot {
  scopeKey: string
  snapshot: LocalFeatureSharingSnapshot | null
}

const localFeatureSharingProviderIds = new WeakMap<LocalFeatureSharingPort, number>()
let nextLocalFeatureSharingProviderId = 0

function localFeatureSharingProviderScopeKey(provider: LocalFeatureSharingPort | undefined): string {
  if (!provider) return 'local-sharing:none'
  let providerId = localFeatureSharingProviderIds.get(provider)
  if (providerId === undefined) {
    nextLocalFeatureSharingProviderId += 1
    providerId = nextLocalFeatureSharingProviderId
    localFeatureSharingProviderIds.set(provider, providerId)
  }
  return `local-sharing:${providerId}`
}

function unavailableMeshPeersSnapshot(routeState: RouteAvailability['state'], explanation: string, blockerReason: string): MeshPeersSnapshot {
  const state = routeState === 'denied' ? 'denied' : routeState === 'pending' ? 'pending' : 'unsupported'
  const reason = explanation || blockerReason || 'Connected devices are unavailable right now.'
  return {
    ...loadingMeshPeersSnapshot,
    loadState: routeState === 'denied' ? 'denied' : 'empty',
    localNodeName: 'Unavailable',
    listState: state,
    listReason: reason,
    statusState: state,
    statusReason: reason,
    mutationState: state,
    mutationReason: reason,
    config: {
      ...loadingMeshPeersSnapshot.config,
      state,
      reason,
    },
    evidenceSource: reason,
    transportKind: 'unavailable',
    error: routeState === 'denied' ? reason : null,
  }
}

export interface UsePeerRosterOptions {
  client: AuroraClient
  route: RouteAvailability
  thinPeer: BrowserWebRtcPeerController | undefined
  localFeatureSharing: LocalFeatureSharingPort | undefined
  localNode: LocalMeshNodeIdentity | undefined
  ownsLocalNodeState: boolean
  canManageLocalServiceConfiguration: boolean
}

export function usePeerRoster({
  client,
  route,
  thinPeer,
  localFeatureSharing,
  localNode,
  ownsLocalNodeState,
  canManageLocalServiceConfiguration,
}: UsePeerRosterOptions): PeerRosterState {
  const queryScopeKey = useAuroraQueryScopeKey()
  const queryScopeId = queryScopeKey[1]
  const stateScopeId = useAuroraStateScopeId()
  const localFeatureSharingProviderKey = localFeatureSharingProviderScopeKey(localFeatureSharing)
  const localScopeKey = useMemo(
    () => JSON.stringify({
      queryScopeId,
      stateScopeId,
      localFeatureSharingProviderKey,
      localPeerId: localNode?.peerId ?? null,
      ownsLocalNodeState,
    }),
    [localFeatureSharingProviderKey, localNode?.peerId, ownsLocalNodeState, queryScopeId, stateScopeId],
  )
  const localScopeKeyRef = useRef(localScopeKey)
  const localLoadGenerationRef = useRef(0)
  localScopeKeyRef.current = localScopeKey
  const [snapshot, setSnapshot] = useState<ScopedLocalMeshPeersSnapshot>({
    scopeKey: localScopeKey,
    snapshot: loadingMeshPeersSnapshot,
  })
  const thinPeerProjection = useThinPeerDiagnosticsProjection(thinPeer)
  const thinPeerSnapshot = thinPeerProjection.snapshot
  const thinPeerEvidence = thinPeerProjection.evidence
  const localSharingSnapshot = useRef<ScopedLocalSharingSnapshot | null>(null)
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const meshPeersQueryKey = useMemo(
    () => queryKeys.admin('mesh-peers', { routeId: route.item.id, routeState: route.state, routeDisabled: route.disabled, canManageLocalServiceConfiguration }),
    [canManageLocalServiceConfiguration, queryKeys, route.disabled, route.item.id, route.state],
  )
  const remoteScopeKey = useMemo(() => JSON.stringify(meshPeersQueryKey), [meshPeersQueryKey])
  const routeBlockerReason = route.blockers[0] ?? ''
  const disabledSnapshot = useMemo(
    () => unavailableMeshPeersSnapshot(route.state, route.explanation, routeBlockerReason),
    [route.explanation, route.state, routeBlockerReason],
  )
  const lastRemoteSnapshotRef = useRef<{ scopeKey: string; snapshot: MeshPeersSnapshot } | null>(null)
  const meshPeersQuery = useQuery<ScopedMeshPeersSnapshot, AuroraError>({
    queryKey: meshPeersQueryKey,
    enabled: !ownsLocalNodeState && !route.disabled,
    staleTime: AURORA_QUERY_STALE_TIMES.volatile,
    // Mesh roster events are not a confirmed typed topic yet; this is the
    // explicit degradation path until the SDK exposes one.
    refetchInterval: fallbackInterval,
    queryFn: async ({ signal }) => ({
      scopeKey: remoteScopeKey,
      snapshot: await buildMeshPeersSnapshot(client, route, {
        canManageLocalServiceConfiguration,
        signal,
      }),
    }),
  })

  const buildScopedLocalSnapshot = useCallback((featureSharing: LocalFeatureSharingSnapshot | null): MeshPeersSnapshot => buildLocalMeshNodeSnapshot({
    localNode,
    thinPeer: thinPeerProjection.snapshot,
    peerRoster: thinPeerProjection.roster,
    connectionEvidence: thinPeerProjection.evidence,
    connectionEvidenceByPeer: thinPeerProjection.evidenceByPeer,
    featureSharing,
    sharingAvailable: Boolean(localFeatureSharing),
  }), [localFeatureSharing, localNode, thinPeerProjection.evidence, thinPeerProjection.evidenceByPeer, thinPeerProjection.roster, thinPeerProjection.snapshot])

  useEffect(() => {
    if (!ownsLocalNodeState) {
      localSharingSnapshot.current = null
      return
    }
    localSharingSnapshot.current = { scopeKey: localScopeKey, snapshot: null }
    setSnapshot({ scopeKey: localScopeKey, snapshot: loadingMeshPeersSnapshot })
  }, [localScopeKey, ownsLocalNodeState])

  useEffect(() => {
    if (!ownsLocalNodeState) return
    const featureSharing = localSharingSnapshot.current?.scopeKey === localScopeKey
      ? localSharingSnapshot.current.snapshot
      : null
    setSnapshot({
      scopeKey: localScopeKey,
      snapshot: buildScopedLocalSnapshot(featureSharing),
    })
  }, [buildScopedLocalSnapshot, localScopeKey, ownsLocalNodeState])

  useEffect(() => {
    if (!ownsLocalNodeState || !localFeatureSharing?.subscribe) return
    const subscriptionScopeKey = localScopeKey
    return localFeatureSharing.subscribe((nextSharing) => {
      if (localScopeKeyRef.current !== subscriptionScopeKey) return
      localSharingSnapshot.current = { scopeKey: subscriptionScopeKey, snapshot: nextSharing }
      setSnapshot({
        scopeKey: subscriptionScopeKey,
        snapshot: buildScopedLocalSnapshot(nextSharing),
      })
    })
  }, [buildScopedLocalSnapshot, localFeatureSharing, localScopeKey, ownsLocalNodeState])

  const loadPeers = useCallback(async () => {
    if (ownsLocalNodeState) {
      const loadScopeKey = localScopeKey
      const loadGeneration = localLoadGenerationRef.current + 1
      localLoadGenerationRef.current = loadGeneration
      if (localSharingSnapshot.current?.scopeKey !== loadScopeKey) {
        localSharingSnapshot.current = { scopeKey: loadScopeKey, snapshot: null }
      }
      setSnapshot((current) => current.scopeKey === loadScopeKey
        ? current
        : { scopeKey: loadScopeKey, snapshot: loadingMeshPeersSnapshot })
      let featureSharing: LocalFeatureSharingSnapshot | null = null
      if (localFeatureSharing) {
        try {
          featureSharing = await localFeatureSharing.load()
        } catch {
          featureSharing = null
        }
      }
      if (localScopeKeyRef.current !== loadScopeKey || localLoadGenerationRef.current !== loadGeneration) return
      localSharingSnapshot.current = { scopeKey: loadScopeKey, snapshot: featureSharing }
      setSnapshot({
        scopeKey: loadScopeKey,
        snapshot: buildScopedLocalSnapshot(featureSharing),
      })
      return
    }
    if (route.disabled) {
      await queryClient.cancelQueries({ queryKey: meshPeersQueryKey })
      return
    }
    await queryClient.refetchQueries({ queryKey: meshPeersQueryKey, type: 'active' })
  }, [buildScopedLocalSnapshot, localFeatureSharing, localScopeKey, ownsLocalNodeState, queryClient, meshPeersQueryKey, route.disabled])

  useEffect(() => {
    if (!ownsLocalNodeState) return
    let cancelled = false
    const loadScopeKey = localScopeKey
    setSnapshot((current) => current.scopeKey === loadScopeKey
      ? current
      : { scopeKey: loadScopeKey, snapshot: loadingMeshPeersSnapshot })
    void loadPeers().catch(() => {
      if (!cancelled && localScopeKeyRef.current === loadScopeKey) {
        setSnapshot((current) => ({
          scopeKey: loadScopeKey,
          snapshot: { ...current.snapshot, loadState: 'error', error: 'Aurora could not load connected devices.' },
        }))
      }
    })
    return () => {
      cancelled = true
      localLoadGenerationRef.current += 1
    }
  }, [loadPeers, localScopeKey, ownsLocalNodeState])

  useEffect(() => {
    if (ownsLocalNodeState || !route.disabled) return
    void queryClient.cancelQueries({ queryKey: meshPeersQueryKey })
  }, [meshPeersQueryKey, ownsLocalNodeState, queryClient, route.disabled])

  const remoteSnapshot = useMemo(() => {
    if (route.disabled) return disabledSnapshot

    const sameScopePrevious = lastRemoteSnapshotRef.current?.scopeKey === remoteScopeKey
      ? lastRemoteSnapshotRef.current.snapshot
      : null
    const currentThinSnapshot = thinPeer?.snapshot() ?? thinPeerSnapshot

    if (meshPeersQuery.isPending) return loadingMeshPeersSnapshot
    if (meshPeersQuery.isError) {
      return reconcileMeshPeersWithThinPeer(
        {
          ...loadingMeshPeersSnapshot,
          loadState: 'error',
          error: 'Aurora could not load connected devices.',
        },
        currentThinSnapshot,
        sameScopePrevious,
        thinPeerProjection.evidence,
      )
    }

    const scopedData = meshPeersQuery.data
    if (!scopedData || scopedData.scopeKey !== remoteScopeKey) return loadingMeshPeersSnapshot
    return reconcileMeshPeersWithThinPeer(
      scopedData.snapshot,
      currentThinSnapshot,
      sameScopePrevious,
      thinPeerProjection.evidence,
    )
  }, [disabledSnapshot, meshPeersQuery.data, meshPeersQuery.isError, meshPeersQuery.isPending, remoteScopeKey, route.disabled, thinPeer, thinPeerProjection.evidence, thinPeerSnapshot])

  useEffect(() => {
    if (ownsLocalNodeState || route.disabled) {
      lastRemoteSnapshotRef.current = null
      return
    }
    if (remoteSnapshot.loadState === 'loading' || remoteSnapshot.loadState === 'error' || remoteSnapshot.loadState === 'denied' || remoteSnapshot.loadState === 'service-unavailable') {
      return
    }
    lastRemoteSnapshotRef.current = { scopeKey: remoteScopeKey, snapshot: remoteSnapshot }
  }, [ownsLocalNodeState, remoteScopeKey, remoteSnapshot, route.disabled])

  const currentLocalSharingSnapshot = localSharingSnapshot.current?.scopeKey === localScopeKey
    ? localSharingSnapshot.current.snapshot
    : null
  const returnedSnapshot = ownsLocalNodeState
    ? snapshot.scopeKey === localScopeKey ? snapshot.snapshot : loadingMeshPeersSnapshot
    : remoteSnapshot

  return {
    snapshot: returnedSnapshot,
    loadPeers,
    thinPeerSnapshot,
    thinPeerEvidence,
    localSharingSnapshot: ownsLocalNodeState ? currentLocalSharingSnapshot : null,
  }
}
