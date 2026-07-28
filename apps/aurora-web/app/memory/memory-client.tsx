'use client'

import { MemoryView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'
import { useBrowserRoute } from '../browser-shell-runtime'

export function MemoryClientPage({ route }: { route: RouteAvailability }) {
  const activeRoute = useBrowserRoute(route)
  return <MemoryView client={createAuroraBrowserClient()} route={activeRoute} />
}
