'use client'

import { AssistantView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from './aurora-client'
import {
  useBrowserCancellationRoute,
  useBrowserRoute,
} from './browser-shell-runtime'

export function AssistantClientPage({
  route,
  cancellationRoute
}: {
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
}) {
  const activeRoute = useBrowserRoute(route)
  const activeCancellationRoute = useBrowserCancellationRoute(cancellationRoute)
  return <AssistantView client={createAuroraBrowserClient()} route={activeRoute} cancellationRoute={activeCancellationRoute} />
}
