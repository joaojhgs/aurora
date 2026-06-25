'use client'

import { MeshPeersResource, RoutePolicyResource, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function MeshPeersClientPage({ route }: { route: RouteAvailability }) {
  const client = createAuroraBrowserClient()
  return (
    <>
      <MeshPeersResource client={client} route={route} />
      <RoutePolicyResource client={client} route={route} />
    </>
  )
}
