'use client'

import { useMemo } from 'react'
import { AdminSchedulerView, type AdminSchedulerSnapshot, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'
import { useBrowserRoute } from '../../browser-shell-runtime'

export function SchedulerClientPage({
  route,
  initialSnapshot
}: {
  route: RouteAvailability
  initialSnapshot?: AdminSchedulerSnapshot | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  const activeRoute = useBrowserRoute(route)
  return <AdminSchedulerView client={client} route={activeRoute} initialSnapshot={initialSnapshot} />
}
