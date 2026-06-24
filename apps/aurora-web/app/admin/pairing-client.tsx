'use client'

import { PairingQueueView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function PairingQueueClientPage({ route }: { route: RouteAvailability }) {
  return <PairingQueueView client={createAuroraBrowserClient()} route={route} />
}
