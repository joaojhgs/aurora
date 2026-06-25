'use client'

import { MeshPeersResource, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function MeshPeersClientPage({ route }: { route: RouteAvailability }) {
  return <MeshPeersResource client={createAuroraBrowserClient()} route={route} />
}
