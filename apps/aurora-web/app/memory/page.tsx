import { StateSurface, type RouteAvailability } from '@aurora/ui'
import { getShellSnapshot } from '../shell-state'
import { MemoryClientPage } from './memory-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'memory')
  if (!route) {
    return (
      <StateSurface
        title="Memory"
        state="unsupported"
        description="Memory is not available from this connection yet. Check the affected device, then try again."
        evidence={snapshot.evidenceSource}
      />
    )
  }
  return <MemoryClientPage route={route as RouteAvailability} />
}
