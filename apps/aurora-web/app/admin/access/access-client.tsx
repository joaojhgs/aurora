'use client'

import { useMemo } from 'react'
import { AdminRbacResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminAccessClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminRbacResource client={client} />
}
