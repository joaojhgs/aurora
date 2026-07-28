'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { AuroraShellSnapshot, RouteAvailability } from '@aurora/ui'

const BrowserShellSnapshotContext = createContext<AuroraShellSnapshot | null>(null)

export function BrowserShellRuntimeProvider({
  snapshot,
  children,
}: {
  snapshot: AuroraShellSnapshot
  children: ReactNode
}) {
  return (
    <BrowserShellSnapshotContext.Provider value={snapshot}>
      {children}
    </BrowserShellSnapshotContext.Provider>
  )
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
