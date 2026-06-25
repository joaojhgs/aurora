'use client'

import { useMemo } from 'react'
import { AdminSchedulerView, type AdminSchedulerSnapshot, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function SchedulerClientPage({
  route,
  initialSnapshot
}: {
  route: RouteAvailability
  initialSnapshot?: AdminSchedulerSnapshot | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminSchedulerView client={client} route={route} initialSnapshot={initialSnapshot} />
}
