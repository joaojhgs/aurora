'use client'

import { useMemo } from 'react'
import { AdminOverviewView } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function AdminOverviewClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <AdminOverviewView client={client} />
}
