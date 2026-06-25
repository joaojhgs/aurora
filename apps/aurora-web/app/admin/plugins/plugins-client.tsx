'use client'

import { useMemo } from 'react'
import { AdminPluginsView, type AdminPluginsSnapshot, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function PluginsClientPage({
  route,
  initialSnapshot
}: {
  route: RouteAvailability
  initialSnapshot?: AdminPluginsSnapshot | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminPluginsView client={client} route={route} initialSnapshot={initialSnapshot} />
}
