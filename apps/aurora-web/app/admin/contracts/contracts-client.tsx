'use client'

import { useMemo } from 'react'
import { AdminContractsResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminContractsClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminContractsResource client={client} />
}
