'use client'

import { useMemo } from 'react'
import { AdminPluginsView, type AdminPluginsSnapshot, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'
import { useBrowserRoute } from '../../browser-shell-runtime'

export function PluginsClientPage({
  route,
  initialSnapshot
}: {
  route: RouteAvailability
  initialSnapshot?: AdminPluginsSnapshot | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  const activeRoute = useBrowserRoute(route)
  return <AdminPluginsView client={client} route={activeRoute} initialSnapshot={initialSnapshot} />
}
