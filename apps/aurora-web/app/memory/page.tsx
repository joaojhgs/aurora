import type { RouteAvailability } from '@aurora/ui'
import { AuroraRoutePage } from '../page-content'
import { getShellSnapshot } from '../shell-state'
import { MemoryClientPage } from './memory-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'memory')
  if (!route) return <AuroraRoutePage routeId="memory" />
  return <MemoryClientPage route={route as RouteAvailability} />
}
