'use client'

import { useMemo } from 'react'
import { AdminAuditResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminAuditClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminAuditResource client={client} />
}
