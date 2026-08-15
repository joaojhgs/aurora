'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  AppShell,
  OnboardingView,
  WebThinConnectionPanel,
  activeRuntimeProfile,
  buildShellSnapshot,
  loadingShellSnapshot,
  runtimeProfileToThinConnectionProfile,
  thinConnectionProfileWithManualAddress,
  retainThinShellSnapshot,
  type AuroraNodeMode,
  type ThinProfileDocument,
  type AuroraShellSnapshot,
} from '@aurora/ui'
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

type PathAwareShellProps = {
  children: ReactNode
  snapshot: AuroraShellSnapshot
}

export function PathAwareShell({ children, snapshot }: PathAwareShellProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <BrowserShellBootScreen />
  }

  return (
    <HydratedPathAwareShell snapshot={snapshot}>
      {children}
    </HydratedPathAwareShell>
  )
}

function HydratedPathAwareShell({ children, snapshot }: PathAwareShellProps) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [runtime, setRuntime] = useState<AuroraBrowserRuntime | null>(null)
  const [startFailed, setStartFailed] = useState(false)

  useEffect(() => {
    let active = true
    setRuntime(null)
    setStartFailed(false)
    void createAuroraBrowserRuntimeAsync().then(
      async (nextRuntime) => {
        if (!active) return
        const localAssistant = await createAuroraBrowserLocalAssistantConfig(nextRuntime)
        if (!active) return
        setRuntime(localAssistant ? runtimeWithLocalAssistant(nextRuntime, localAssistant) : nextRuntime)
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
    const refreshRuntime = () => setRefreshKey((value) => value + 1)
    window.addEventListener(AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT, refreshRuntime)
    return () => window.removeEventListener(AURORA_BROWSER_VOICE_PACKS_CHANGED_EVENT, refreshRuntime)
  }, [])

  if (startFailed) {
    return (
      <BrowserShellStartError
        onRetry={() => setRefreshKey((value) => value + 1)}
      />
    )
  }
  if (!runtime) return <BrowserShellBootScreen />

  return (
    <ReadyPathAwareShell
      key={refreshKey}
      runtime={runtime}
      snapshot={snapshot}
      onRefreshRuntime={() => setRefreshKey((value) => value + 1)}
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

  useEffect(() => {
    let ready = false
    return runtime.peer.subscribe((peerSnapshot) => {
      const nextReady =
        peerSnapshot.status === 'authorized'
        || peerSnapshot.status === 'fallback-http'
      if (nextReady && !ready) {
        setThinPeerReadyRevision((revision) => revision + 1)
      }
      ready = nextReady
    })
  }, [runtime])

  useEffect(() => {
    if (requiresOnboarding) return
    let cancelled = false
    setActiveSnapshot((current) => ({
      ...current,
      loadState: 'loading',
      transportKind: runtime.client.transport.kind,
      evidenceSource: 'preparing Aurora for this browser',
    }))
    void buildShellSnapshot(runtime.client).then(async (nextSnapshot) => {
      await runtime.client.authApi.whoAmI().catch(() => null)
      if (!cancelled) {
        setActiveSnapshot((current) =>
          retainThinShellSnapshot(current, nextSnapshot, runtime.peer.snapshot()),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [requiresOnboarding, runtime, thinPeerReadyRevision])

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
    <BrowserShellRuntimeProvider
      runtime={runtime}
      snapshot={activeSnapshot}
      runtimeProfile={configuredRuntimeProfile}
    >
      <AppShell
        snapshot={activeSnapshot}
        currentPath={pathname ?? '/'}
        onNavigate={(href) => router.push(href)}
        sessionIsAdmin={runtime.client.auth.snapshot().isAdmin}
        runtimeMode="web-thin"
        nodeMode={configuredRuntimeProfile?.nodeMode ?? runtimeNodeMode}
        localNodeAvailable={runtime.localNodeProviderStatus?.available}
      >
        {children}
      </AppShell>
    </BrowserShellRuntimeProvider>
  )
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

function BrowserShellBootScreen() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading Aurora"
      className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
      data-browser-shell-boot="true"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden
          className="size-8 animate-pulse rounded-xl bg-primary/20"
        />
        <p className="text-sm font-medium">Loading Aurora…</p>
      </div>
    </main>
  )
}

function BrowserShellStartError({ onRetry }: { onRetry: () => void }) {
  return (
    <main
      className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
      data-browser-shell-start="failed"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium">Aurora could not start on this device.</p>
        <p className="text-xs text-muted-foreground">
          Your saved connection is safe. Try opening Aurora again.
        </p>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </main>
  )
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
