'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { AuroraRuntimeProfileV2, AuroraShellSnapshot, RouteAvailability } from '@aurora/ui'

const BrowserShellSnapshotContext = createContext<AuroraShellSnapshot | null>(null)
const BrowserRuntimeProfileContext = createContext<AuroraRuntimeProfileV2 | null>(null)

export function BrowserShellRuntimeProvider({
  snapshot,
  runtimeProfile = null,
  children,
}: {
  snapshot: AuroraShellSnapshot
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  children: ReactNode
}) {
  return (
    <BrowserShellSnapshotContext.Provider value={snapshot}>
      <BrowserRuntimeProfileContext.Provider value={runtimeProfile}>
        {children}
      </BrowserRuntimeProfileContext.Provider>
    </BrowserShellSnapshotContext.Provider>
  )
}

export function useBrowserRuntimeProfile(): AuroraRuntimeProfileV2 | null {
  return useContext(BrowserRuntimeProfileContext)
}

export function useBrowserRoute(
  fallback: RouteAvailability,
): RouteAvailability {
  const snapshot = useContext(BrowserShellSnapshotContext)
  return snapshot?.routes.find(
    (candidate) => candidate.item.id === fallback.item.id,
  ) ?? fallback
}

export function useBrowserCancellationRoute(
  fallback: RouteAvailability | undefined,
): RouteAvailability | undefined {
  const snapshot = useContext(BrowserShellSnapshotContext)
  return snapshot?.assistantCancellationRoute ?? fallback
}
