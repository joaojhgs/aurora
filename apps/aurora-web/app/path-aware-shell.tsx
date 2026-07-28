'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  AppShell,
  OnboardingView,
  WebThinConnectionPanel,
  buildShellSnapshot,
  loadingShellSnapshot,
  type AuroraShellSnapshot,
} from '@aurora/ui'
import {
  auroraBrowserRequiresOnboarding,
  auroraBrowserThinProfile,
  auroraBrowserThinProfileDocument,
  createAuroraBrowserRuntime,
  saveAuroraBrowserThinProfile,
} from './aurora-client'
import { BrowserShellRuntimeProvider } from './browser-shell-runtime'

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
  const pathname = usePathname()
  const router = useRouter()
  const [refreshKey, setRefreshKey] = useState(0)
  const [thinPeerReadyRevision, setThinPeerReadyRevision] = useState(0)
  const [initialInvite] = useState(() => initialInviteFromHash())
  const runtime = useMemo(() => createAuroraBrowserRuntime(), [refreshKey])
  const requiresOnboarding = auroraBrowserRequiresOnboarding()
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
      evidenceSource: 'loading capability graph from the configured browser runtime',
    }))
    void buildShellSnapshot(runtime.client).then(async (nextSnapshot) => {
      await runtime.client.authApi.whoAmI().catch(() => null)
      if (!cancelled) setActiveSnapshot(nextSnapshot)
    })
    return () => {
      cancelled = true
    }
  }, [requiresOnboarding, runtime, thinPeerReadyRevision])

  if (requiresOnboarding) {
    const document = auroraBrowserThinProfileDocument()
    const profile = auroraBrowserThinProfile()
    return (
      <OnboardingView
        client={runtime.client}
        snapshot={{
          ...snapshot,
          loadState: 'ready',
          transportKind: runtime.client.transport.kind,
          evidenceSource: 'browser runtime profile required before network requests are enabled',
        }}
        setupRequired
        thinConnectionPanel={
          <WebThinConnectionPanel
            key={refreshKey}
            peer={runtime.peer}
            mode={runtime.mode}
            transportKind={runtime.client.transport.kind}
            initialInviteText={initialInvite}
            profile={profile}
            profiles={document.profiles}
            profileStoreEvidence="Hosted web thin profile metadata is stored in browser storage; WebRTC room secrets are encrypted in IndexedDB when WebCrypto is available."
            configureOnly
            onSaveProfile={async (nextProfile, roomSecret) => {
              await saveAuroraBrowserThinProfile(nextProfile, roomSecret)
              setActiveSnapshot(browserLoadingSnapshot(runtime.client.transport.kind))
              setRefreshKey((value) => value + 1)
              router.replace('/mesh')
            }}
          />
        }
      />
    )
  }
  return (
    <BrowserShellRuntimeProvider snapshot={activeSnapshot}>
      <AppShell
        snapshot={activeSnapshot}
        currentPath={pathname ?? '/'}
        onNavigate={(href) => router.push(href)}
        sessionIsAdmin={runtime.client.auth.snapshot().isAdmin}
        runtimeMode="web-thin"
      >
        {children}
      </AppShell>
    </BrowserShellRuntimeProvider>
  )
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

function browserLoadingSnapshot(transportKind: string): AuroraShellSnapshot {
  return {
    ...loadingShellSnapshot,
    transportKind,
    evidenceSource: 'loading capability graph from the configured browser runtime',
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
