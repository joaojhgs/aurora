'use client'

import { useMemo } from 'react'
import { TokensView, type RouteAvailability, type TokenViewModel } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function TokensClientPage({
  route,
  initialModel
}: {
  route: RouteAvailability
  initialModel?: TokenViewModel | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <TokensView client={client} route={route} initialModel={initialModel} />
}
