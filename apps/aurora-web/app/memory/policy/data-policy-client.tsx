'use client'

import { useMemo } from 'react'
import { DataPolicyResource, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function DataPolicyClientPage({ route }: { route: RouteAvailability }) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <DataPolicyResource client={client} route={route} />
}
