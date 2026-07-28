'use client'

import { useMemo } from 'react'
import type { ToolApprovalCardModel } from '@aurora/client'
import { ToolApprovalPanel, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../aurora-client'
import { useBrowserRoute } from '../browser-shell-runtime'

export function ToolApprovalClientPage({
  route,
  initialTools
}: {
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
}) {
  const client = useMemo(() => createAuroraBrowserClient(), [])
  const activeRoute = useBrowserRoute(route)
  return <ToolApprovalPanel client={client} route={activeRoute} initialTools={initialTools} />
}
