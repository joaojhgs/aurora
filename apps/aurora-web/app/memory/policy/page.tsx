import type { RouteAvailability } from '@aurora/ui'
import { AuroraRoutePage } from '../../page-content'
import { getShellSnapshot } from '../../shell-state'
import { DataPolicyClientPage } from './data-policy-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'data')
  if (!route) return <AuroraRoutePage routeId="data" />
  return <DataPolicyClientPage route={route as RouteAvailability} />
}
