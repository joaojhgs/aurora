'use client'

import { PairingQueueView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'
import { useBrowserRoute } from '../browser-shell-runtime'

export function PairingQueueClientPage({ route }: { route: RouteAvailability }) {
  const activeRoute = useBrowserRoute(route)
  return <PairingQueueView client={createAuroraBrowserClient()} route={activeRoute} />
}
