'use client'

import { useMemo } from 'react'
import { AdminTokensResource } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function AdminTokensClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminTokensResource client={client} />
}
