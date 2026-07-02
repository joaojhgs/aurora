'use client'

import { useMemo } from 'react'
import { AdminServicesResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminServicesClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminServicesResource client={client} />
}
