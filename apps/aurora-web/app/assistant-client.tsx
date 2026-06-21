'use client'

import { AssistantView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from './aurora-client'

export function AssistantClientPage({ route }: { route: RouteAvailability }) {
  return <AssistantView client={createAuroraBrowserClient()} route={route} />
}
