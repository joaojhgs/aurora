'use client'

import { useMemo } from 'react'
import type { ToolApprovalCardModel } from '@aurora/client'
import { ToolApprovalPanel, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'

export function ToolApprovalClientPage({
  route,
  initialTools
}: {
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  return <ToolApprovalPanel client={client} route={route} initialTools={initialTools} />
}
