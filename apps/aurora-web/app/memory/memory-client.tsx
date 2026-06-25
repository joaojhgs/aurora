'use client'

import { MemoryView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function MemoryClientPage({ route }: { route: RouteAvailability }) {
  return <MemoryView client={createAuroraBrowserClient()} route={route} />
}
