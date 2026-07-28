'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import {
  AppShell,
  OnboardingView,
  WebThinConnectionPanel,
  buildShellSnapshot,
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
  const pathname = usePathname()
  const [refreshKey, setRefreshKey] = useState(0)
  const [initialInvite] = useState(() => initialInviteFromHash())
  const runtime = useMemo(() => createAuroraBrowserRuntime(), [refreshKey])
  const requiresOnboarding = auroraBrowserRequiresOnboarding()
  const [activeSnapshot, setActiveSnapshot] = useState(snapshot)

  useEffect(() => {
    if (requiresOnboarding) return
    let cancelled = false
    setActiveSnapshot((current) => ({
      ...current,
      loadState: 'loading',
      transportKind: runtime.client.transport.kind,
      evidenceSource: 'loading capability graph from the configured browser runtime',
    }))
    void buildShellSnapshot(runtime.client).then((nextSnapshot) => {
      if (!cancelled) setActiveSnapshot(nextSnapshot)
    })
    return () => {
      cancelled = true
    }
  }, [requiresOnboarding, runtime])

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
              setRefreshKey((value) => value + 1)
            }}
          />
        }
      />
    )
  }
  return (
    <BrowserShellRuntimeProvider snapshot={activeSnapshot}>
      <AppShell snapshot={activeSnapshot} currentPath={pathname ?? '/'}>
        {children}
      </AppShell>
    </BrowserShellRuntimeProvider>
  )
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
