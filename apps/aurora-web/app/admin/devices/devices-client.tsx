'use client'

import { useMemo } from 'react'
import { AdminDevicesResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminDevicesClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminDevicesResource client={client} />
}
