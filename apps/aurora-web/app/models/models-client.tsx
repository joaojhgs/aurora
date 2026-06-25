'use client'

import { useMemo } from 'react'
import { ModelsView } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function ModelsClientPage() {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <ModelsView client={client} />
}
