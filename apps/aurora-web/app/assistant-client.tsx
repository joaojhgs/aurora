'use client'

import { AssistantView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from './aurora-client'

export function AssistantClientPage({
  route,
  cancellationRoute
}: {
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
}) {
  return <AssistantView client={createAuroraBrowserClient()} route={route} cancellationRoute={cancellationRoute} />
}
