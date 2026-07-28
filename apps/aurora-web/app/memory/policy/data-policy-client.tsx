'use client'

import { useMemo } from 'react'
import { DataPolicyResource, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'
import { useBrowserRoute } from '../../browser-shell-runtime'

export function DataPolicyClientPage({ route }: { route: RouteAvailability }) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  const activeRoute = useBrowserRoute(route)
  return <DataPolicyResource client={client} route={activeRoute} />
}
