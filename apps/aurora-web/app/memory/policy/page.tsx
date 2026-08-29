import { StateSurface, type RouteAvailability } from '@aurora/ui'
import { getShellSnapshot } from '../../shell-state'
import { DataPolicyClientPage } from './data-policy-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'data')
  if (!route) {
    return (
      <StateSurface
        title="Data Policy"
        state="unsupported"
        description="Data settings are not available from this connection yet. Check the affected device, then try again."
        evidence={snapshot.evidenceSource}
      />
    )
  }
  return <DataPolicyClientPage route={route as RouteAvailability} />
}
