'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { AuroraRuntimeProfileV2, AuroraShellSnapshot, RouteAvailability } from '@aurora/ui'
import type { AuroraBrowserRuntime } from './aurora-client'

const BrowserShellSnapshotContext = createContext<AuroraShellSnapshot | null>(null)
const BrowserRuntimeProfileContext = createContext<AuroraRuntimeProfileV2 | null>(null)
const BrowserRuntimeContext = createContext<AuroraBrowserRuntime | null>(null)

export function BrowserShellRuntimeProvider({
  runtime,
  snapshot,
  runtimeProfile = null,
  children,
}: {
  runtime: AuroraBrowserRuntime
  snapshot: AuroraShellSnapshot
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  children: ReactNode
}) {
  return (
    <BrowserRuntimeContext.Provider value={runtime}>
      <BrowserShellSnapshotContext.Provider value={snapshot}>
        <BrowserRuntimeProfileContext.Provider value={runtimeProfile}>
          {children}
        </BrowserRuntimeProfileContext.Provider>
      </BrowserShellSnapshotContext.Provider>
    </BrowserRuntimeContext.Provider>
  )
}

export function useBrowserShellRuntime(): AuroraBrowserRuntime {
  const runtime = useContext(BrowserRuntimeContext)
  if (!runtime) throw new Error('Aurora browser runtime is unavailable')
  return runtime
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
