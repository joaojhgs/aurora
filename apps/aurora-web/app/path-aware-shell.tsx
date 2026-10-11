'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { AuroraEvent } from '@aurora/client'
import {
  AppShell,
  AURORA_QUERY_FALLBACK_INTERVAL_MS,
  OnboardingView,
  WebThinConnectionPanel,
  activeRuntimeProfile,
  loadingShellSnapshot,
  runtimeProfileToThinConnectionProfile,
  thinConnectionProfileWithManualAddress,
  retainThinShellSnapshot,
  AuroraQueryProvider,
  fetchAuroraShellSnapshot,
  getAuroraQueryClient,
  invalidateAuroraQueriesForShellEvent,
  patchShellSnapshotForEvent,
  recordHostedLiveShellTrace,
  shouldRefreshShellSnapshot,
  useAuroraLiveShellEvents,
  useAuroraQueryScopeKey,
  useAuroraStateScopeId,
  useConnectionStore,
  useSurfaceStore,
  type AuroraNodeMode,
  type AuroraQueryScopeInput,
  type ThinProfileDocument,
  type AuroraShellSnapshot,
} from '@aurora/ui'
import { BrowserShellBootScreen, BrowserShellStartError } from '@aurora/ui/shell-startup'
import {
  AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT,
  auroraBrowserRequiresOnboarding,
  auroraBrowserRuntimeProfile,
  auroraBrowserRuntimeProfileDocument,
  createAuroraBrowserRuntimeAsync,
  saveAuroraBrowserOnboardingProfile,
  type AuroraBrowserRuntime,
} from './aurora-client'
import { BrowserShellRuntimeProvider } from './browser-shell-runtime'
import { createAuroraBrowserLocalAssistantConfig } from './browser-local-assistant'
import { DebugUiPicker } from './debug-ui-host'
import { preserveAuroraDebugUiSearch } from './debug-ui-override'
import { shellRuntimeModeFromSurfaceKind } from './debug-ui-launch'

type PathAwareShellProps = {
  children: ReactNode
  snapshot: AuroraShellSnapshot
}

export function startBoundedSerialShellRefresh(
  refresh: (signal: AbortSignal) => Promise<void>,
  intervalMs = AURORA_QUERY_FALLBACK_INTERVAL_MS,
): () => void {
  const controller = new AbortController()
  let active = true
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const refreshSerially = async () => {
    if (!active || inFlight) return
    inFlight = true
    try {
      await refresh(controller.signal)
    } finally {
      inFlight = false
      if (active) {
        timer = setTimeout(() => {
          void refreshSerially()
        }, intervalMs)
      }
    }
  }

  void refreshSerially()
  return () => {
    active = false
    controller.abort()
    if (timer !== null) clearTimeout(timer)
  }
}

export function PathAwareShell({ children, snapshot }: PathAwareShellProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <DebugUiPicker>
        <BrowserShellBootScreen />
      </DebugUiPicker>
    )
  }

  return (
    <DebugUiPicker>
      <HydratedPathAwareShell snapshot={snapshot}>
        {children}
      </HydratedPathAwareShell>
    </DebugUiPicker>
  )
}

function HydratedPathAwareShell({ children, snapshot }: PathAwareShellProps) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [runtime, setRuntime] = useState<AuroraBrowserRuntime | null>(null)
  const [startFailed, setStartFailed] = useState(false)
  const runtimeRef = useRef<AuroraBrowserRuntime | null>(null)

  useEffect(() => {
    let active = true
    runtimeRef.current = null
    setRuntime(null)
    setStartFailed(false)
    void createAuroraBrowserRuntimeAsync().then(
      async (nextRuntime) => {
        if (!active) return
        const localAssistant = await createAuroraBrowserLocalAssistantConfig(nextRuntime)
        if (!active) return
        const readyRuntime = localAssistant ? runtimeWithLocalAssistant(nextRuntime, localAssistant) : nextRuntime
        runtimeRef.current = readyRuntime
        setRuntime(readyRuntime)
      },
      () => {
        if (active) setStartFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [refreshKey])

  useEffect(() => {
    const refreshLocalAssistant = () => {
      const currentRuntime = runtimeRef.current
      if (!currentRuntime) return
      void createAuroraBrowserLocalAssistantConfig(currentRuntime).then((localAssistant) => {
        if (runtimeRef.current !== currentRuntime) return
        const nextRuntime = localAssistant
          ? runtimeWithLocalAssistant(currentRuntime, localAssistant)
          : currentRuntime
        runtimeRef.current = nextRuntime
        setRuntime(nextRuntime)
      })
    }
    // Voice-pack changes only replace the local assistant adapter. The live
    // runtime/peer and mounted shell remain intact so an in-flight turn stays
    // mounted. Debug UI overrides are handled by DebugUiPicker itself.
    window.addEventListener(AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT, refreshLocalAssistant)
    return () => {
      window.removeEventListener(AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT, refreshLocalAssistant)
    }
  }, [])

  const refreshRuntime = () => setRefreshKey((value) => value + 1)

  if (startFailed) {
    return <BrowserShellStartError onRetry={refreshRuntime} />
  }
  if (!runtime) {
    return <BrowserShellBootScreen />
  }
  return (
    <ReadyPathAwareShell
      runtime={runtime}
      snapshot={snapshot}
      onRefreshRuntime={refreshRuntime}
    >
      {children}
    </ReadyPathAwareShell>
  )
}

function runtimeWithLocalAssistant(
  runtime: AuroraBrowserRuntime,
  localAssistant: NonNullable<AuroraBrowserRuntime['localAssistant']>,
): AuroraBrowserRuntime {
  return Object.create(Object.getPrototypeOf(runtime), {
    ...Object.getOwnPropertyDescriptors(runtime),
    localAssistant: {
      value: localAssistant,
      enumerable: true,
      configurable: true,
      writable: false,
    },
  }) as AuroraBrowserRuntime
}

function ReadyPathAwareShell({
  children,
  runtime,
  snapshot,
  onRefreshRuntime,
}: PathAwareShellProps & {
  runtime: AuroraBrowserRuntime
  onRefreshRuntime: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [thinPeerReadyRevision, setThinPeerReadyRevision] = useState(0)
  const [initialInvite] = useState(() => initialInviteFromHash())
  const requiresOnboarding = auroraBrowserRequiresOnboarding()
  const configuredRuntimeProfile = requiresOnboarding ? undefined : auroraBrowserRuntimeProfile()
  const initialRuntimeProfile = requiresOnboarding
    ? activeRuntimeProfile(auroraBrowserRuntimeProfileDocument())
    : undefined
  const [runtimeNodeMode, setRuntimeNodeMode] = useState<AuroraNodeMode>(() => initialRuntimeProfile?.nodeMode ?? 'remote-console')
  const modePreferenceStore = useMemo(
    () => runtimeNodeModePreference(runtimeNodeMode, setRuntimeNodeMode),
    [runtimeNodeMode],
  )
  const [activeSnapshot, setActiveSnapshot] = useState<AuroraShellSnapshot>(
    () => browserLoadingSnapshot(runtime.client.transport.kind),
  )
  const [peerScope, setPeerScope] = useState(() => browserRuntimePeerScope(runtime))
  const queryScope = useMemo(
    () => ({
      backend: runtime.client.transport.kind,
      peerId: peerScope,
      profileId: configuredRuntimeProfile?.id ?? 'browser-default',
    }),
    [configuredRuntimeProfile?.id, peerScope, runtime.client.transport.kind],
  )
  const queryClient = useMemo(
    () => getAuroraQueryClient({ isMobile: runtime.surface.isMobile }),
    [queryScope, runtime.client, runtime.surface.isMobile],
  )

  useEffect(() => {
    let previousReady = false
    let previousPeerScope = browserRuntimePeerScope(runtime)
    setPeerScope(previousPeerScope)
    return runtime.peer.subscribe((peerSnapshot) => {
      const nextReady =
        peerSnapshot.status === 'authorized'
        || peerSnapshot.status === 'fallback-http'
      const nextPeerScope = browserRuntimePeerScopeFromSnapshot(
        peerSnapshot,
        runtime.client.auth.snapshot().peerId,
      )
      if ((nextReady && !previousReady) || nextPeerScope !== previousPeerScope) {
        setThinPeerReadyRevision((revision) => revision + 1)
      }
      if (nextPeerScope !== previousPeerScope) {
        previousPeerScope = nextPeerScope
        setPeerScope(nextPeerScope)
      }
      previousReady = nextReady
    })
  }, [runtime])

  if (requiresOnboarding) {
    const runtimeDocument = auroraBrowserRuntimeProfileDocument()
    const document = thinDocumentFromRuntimeDocument(runtimeDocument)
    const profile = document.profiles.find((candidate) => candidate.id === document.activeProfileId)
    return (
      <OnboardingView
        client={runtime.client}
        snapshot={{
          ...snapshot,
          loadState: 'ready',
          transportKind: runtime.client.transport.kind,
          evidenceSource: 'finish device setup before Aurora connects',
        }}
        setupRequired
        modePreferenceStore={modePreferenceStore}
        onUseManualAddress={async (address) => {
          await saveAuroraBrowserOnboardingProfile(
            thinConnectionProfileWithManualAddress(profile, address),
            'remote-console',
          )
          setActiveSnapshot(browserLoadingSnapshot(runtime.client.transport.kind))
          onRefreshRuntime()
          router.replace('/mesh')
        }}
        thinConnectionPanel={
          <WebThinConnectionPanel
            peer={runtime.peer}
            mode={runtime.mode}
            transportKind={runtime.client.transport.kind}
            initialInviteText={initialInvite}
            profile={profile}
            profiles={document.profiles}
            profileStoreEvidence="Connection settings stay in this browser. Room keys are protected when secure storage is available."
            localFeatureSharing={runtime.localFeatureSharing}
            configureOnly
            onSaveProfile={async (nextProfile, roomSecret) => {
              await saveAuroraBrowserOnboardingProfile(nextProfile, runtimeNodeMode, roomSecret)
              setActiveSnapshot(browserLoadingSnapshot(runtime.client.transport.kind))
              onRefreshRuntime()
              router.replace('/mesh')
            }}
          />
        }
      />
    )
  }
  return (
    <AuroraQueryProvider client={runtime.client} surfaceProfile={runtime.surface} queryClient={queryClient} queryScope={queryScope}>
      <BrowserRuntimeStateBridge
        runtime={runtime}
        queryClient={queryClient}
        queryScope={queryScope}
        setActiveSnapshot={setActiveSnapshot}
        thinPeerReadyRevision={thinPeerReadyRevision}
      />
      <BrowserShellRuntimeProvider
        runtime={runtime}
        snapshot={activeSnapshot}
        runtimeProfile={configuredRuntimeProfile}
      >
        <AppShell
          snapshot={activeSnapshot}
          currentPath={pathname ?? '/'}
          onNavigate={(href) => router.push(preserveAuroraDebugUiSearch(href))}
          sessionIsAdmin={runtime.client.auth.snapshot().isAdmin}
          runtimeMode={shellRuntimeModeFromSurfaceKind(runtime.surface.kind)}
          nodeMode={configuredRuntimeProfile?.nodeMode ?? runtime.surface.nodeMode ?? runtimeNodeMode}
          localNodeAvailable={runtime.localNodeProviderStatus?.available}
        >
          {children}
        </AppShell>
      </BrowserShellRuntimeProvider>
    </AuroraQueryProvider>
  )
}

export type BrowserRuntimePeerScopeSnapshot = {
  connectedStablePeerId?: string | null
  expectedStablePeerId?: string | null
}

export function browserRuntimePeerScopeFromSnapshot(
  peerSnapshot: BrowserRuntimePeerScopeSnapshot,
  authPeerId: string | null | undefined,
): string | null {
  return peerSnapshot.connectedStablePeerId
    ?? peerSnapshot.expectedStablePeerId
    ?? authPeerId
    ?? null
}

function browserRuntimePeerScope(runtime: AuroraBrowserRuntime): string | null {
  return browserRuntimePeerScopeFromSnapshot(
    runtime.peer.snapshot(),
    runtime.client.auth.snapshot().peerId,
  )
}

function BrowserRuntimeStateBridge({
  runtime,
  queryClient,
  queryScope,
  setActiveSnapshot,
  thinPeerReadyRevision,
}: {
  runtime: AuroraBrowserRuntime
  queryClient: ReturnType<typeof getAuroraQueryClient>
  queryScope: AuroraQueryScopeInput
  setActiveSnapshot: Dispatch<SetStateAction<AuroraShellSnapshot>>
  thinPeerReadyRevision: number
}) {
  const scopeKey = useAuroraQueryScopeKey()
  const stateScopeId = useAuroraStateScopeId()
  const refreshGenerationRef = useRef(0)
  const authoritativeEventGenerationRef = useRef(0)
  const activeRefreshScopeRef = useRef(scopeKey[1])
  const previousRefreshScopeRef = useRef(scopeKey[1])
  const refreshShellSnapshotRef = useRef<((signal?: AbortSignal) => Promise<void>) | null>(null)
  const refreshControllerRef = useRef<{
    controller: AbortController
    generation: number
    scopeId: string
    promise: Promise<void>
    requestedByEvent: boolean
  } | null>(null)

  useEffect(() => {
    activeRefreshScopeRef.current = scopeKey[1]
    return () => {
      const activeRefresh = refreshControllerRef.current
      if (activeRefresh?.scopeId === scopeKey[1]) {
        activeRefresh.controller.abort()
        refreshControllerRef.current = null
      }
    }
  }, [scopeKey])

  useEffect(() => {
    useSurfaceStore.getState().setSurface({
      kind: runtime.surface.physicalKind,
      isMobile: runtime.surface.isMobile,
      isNative: runtime.surface.usesNativeShell,
    }, { scopeId: stateScopeId })
  }, [runtime.surface.isMobile, runtime.surface.physicalKind, runtime.surface.usesNativeShell, stateScopeId])

  const refreshShellSnapshot = useCallback((signal?: AbortSignal, forceRefresh = false) => {
    const refreshScopeId = scopeKey[1]
    const existingRefresh = refreshControllerRef.current
    if (
      existingRefresh?.scopeId === refreshScopeId
    ) {
      return existingRefresh.promise
    }

    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    const authoritativeEventGeneration = authoritativeEventGenerationRef.current
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (signal?.aborted) controller.abort()
    const refreshPromise = (async () => {
      try {
        const nextSnapshot = await fetchAuroraShellSnapshot({
          client: runtime.client,
          queryClient,
          scopeKey,
          ...(forceRefresh ? { forceRefresh: true } : {}),
          signal: controller.signal,
        })
        const activeRefresh = refreshControllerRef.current
        if (
          controller.signal.aborted
          || signal?.aborted
          || refreshGenerationRef.current !== generation
          || authoritativeEventGenerationRef.current !== authoritativeEventGeneration
          || activeRefresh?.generation !== generation
          || activeRefresh.scopeId !== refreshScopeId
          || activeRefreshScopeRef.current !== refreshScopeId
        ) {
          recordHostedLiveShellTrace({ stage: 'snapshot.discarded' })
          return
        }
        recordHostedLiveShellTrace({ stage: 'snapshot.completed' })
        setActiveSnapshot((current) =>
          retainThinShellSnapshot(current, nextSnapshot, runtime.peer.snapshot()),
        )
      } catch (error) {
        recordHostedLiveShellTrace({ stage: 'snapshot.failed' })
        throw error
      } finally {
        signal?.removeEventListener('abort', abortFromCaller)
      }
    })()
    const refreshRecord = {
      controller,
      generation,
      scopeId: refreshScopeId,
      promise: refreshPromise,
      requestedByEvent: false,
    }
    refreshControllerRef.current = refreshRecord
    const finishRefresh = () => {
      if (refreshControllerRef.current?.generation !== generation) return
      const refreshAgain = refreshControllerRef.current.requestedByEvent
      refreshControllerRef.current = null
      if (refreshAgain && activeRefreshScopeRef.current === refreshScopeId) {
        const refreshLatest = refreshShellSnapshotRef.current
        if (refreshLatest) void refreshLatest().catch(() => undefined)
      }
    }
    void refreshPromise.then(
      finishRefresh,
      finishRefresh,
    )
    return refreshPromise
  }, [queryClient, runtime, scopeKey, setActiveSnapshot])
  refreshShellSnapshotRef.current = refreshShellSnapshot

  useEffect(() => {
    const previousScope = previousRefreshScopeRef.current
    previousRefreshScopeRef.current = scopeKey[1]
    if (previousScope === scopeKey[1]) return
    void refreshShellSnapshot().catch(() => undefined)
  }, [refreshShellSnapshot, scopeKey])

  const shellStreamRecoveryNeeded = useConnectionStore((connection) => (
    connection.streams.health.state === 'disconnected'
    || connection.streams.health.state === 'reconnecting'
    || connection.streams.health.state === 'error'
    || connection.streams.config.state === 'disconnected'
    || connection.streams.config.state === 'reconnecting'
    || connection.streams.config.state === 'error'
  ))

  useEffect(() => {
    if (!shellStreamRecoveryNeeded) return

    const stopRecoveryRefresh = startBoundedSerialShellRefresh(async (signal) => {
      try {
        await refreshShellSnapshot(signal, true)
      } catch {
        // The next bounded refresh covers a transient transport failure.
      }
    })
    return () => {
      stopRecoveryRefresh()
    }
  }, [refreshShellSnapshot, shellStreamRecoveryNeeded])

  const handleLiveShellEvent = useCallback((event: Pick<AuroraEvent, 'id' | 'kind' | 'payload' | 'receivedAt'>) => {
    if (shouldRefreshShellSnapshot(event)) {
      // Invalidate refreshes already in flight before applying the event patch.
      // The event refresh is coalesced onto the active read and starts once it
      // settles, so exactly one current snapshot follows a burst of events.
      authoritativeEventGenerationRef.current += 1
    }
    setActiveSnapshot((current) => {
      const before = current.capabilityFreshness
      recordHostedLiveShellTrace({ stage: 'handler.before', kind: event.kind, id: event.id, freshness: before })
      const next = patchShellSnapshotForEvent(current, event).snapshot
      recordHostedLiveShellTrace({ stage: 'handler.after', kind: event.kind, id: event.id, freshness: next.capabilityFreshness })
      return next
    })
    invalidateAuroraQueriesForShellEvent(queryClient, event, scopeKey)
    if (shouldRefreshShellSnapshot(event)) {
      const activeRefresh = refreshControllerRef.current
      if (activeRefresh?.scopeId === scopeKey[1]) {
        activeRefresh.requestedByEvent = true
      }
      void refreshShellSnapshot().catch(() => undefined)
    }
  }, [queryClient, refreshShellSnapshot, scopeKey, setActiveSnapshot])

  useAuroraLiveShellEvents({
    client: runtime.client,
    scopeId: scopeKey[1],
    queryScope,
    onEvent: handleLiveShellEvent,
  })

  useEffect(() => {
    const controller = new AbortController()
    setActiveSnapshot((current) => ({
      ...current,
      loadState: 'loading',
      transportKind: runtime.client.transport.kind,
      evidenceSource: 'preparing Aurora for this browser',
    }))
    void runtime.client.authApi.whoAmI().catch(() => null).then(() => refreshShellSnapshot(controller.signal)).catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [refreshShellSnapshot, runtime.client.authApi, runtime.client.transport.kind, setActiveSnapshot, thinPeerReadyRevision])

  return null
}

function thinDocumentFromRuntimeDocument(
  runtimeDocument: ReturnType<typeof auroraBrowserRuntimeProfileDocument>,
): ThinProfileDocument {
  const profiles = runtimeDocument.profiles.flatMap((profile) => {
    try {
      return profile.homeConnection ? [runtimeProfileToThinConnectionProfile(profile)] : []
    } catch {
      return []
    }
  })
  const activeProfileId = profiles.some((profile) => profile.id === runtimeDocument.activeProfileId)
    ? runtimeDocument.activeProfileId
    : null
  return { version: 1, activeProfileId, profiles }
}

function runtimeNodeModePreference(
  nodeMode: AuroraNodeMode,
  setNodeMode: (nodeMode: AuroraNodeMode) => void,
) {
  return {
    evidence: 'browser setup mode selection',
    readSelectedMode: async () => productModeIdFromNodeMode(nodeMode),
    writeSelectedMode: async (modeId: string) => {
      setNodeMode(nodeModeFromProductModeId(modeId))
      return true
    },
  }
}

function nodeModeFromProductModeId(modeId: string): AuroraNodeMode {
  if (modeId === 'mesh-node' || modeId === 'make-this-device-available') return 'mesh-node'
  return 'remote-console'
}

function productModeIdFromNodeMode(nodeMode: AuroraNodeMode): string {
  return nodeMode === 'mesh-node' ? 'make-this-device-available' : 'connect-to-aurora'
}

function browserLoadingSnapshot(transportKind: string): AuroraShellSnapshot {
  return {
    ...loadingShellSnapshot,
    transportKind,
    evidenceSource: 'preparing Aurora for this browser',
  }
}

function initialInviteFromHash(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  const invite = params.get('invite')
  if (!invite) return null
  params.delete('invite')
  const nextHash = params.toString()
  window.history.replaceState(null, '', `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ''}`)
  return invite
}
