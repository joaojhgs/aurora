import { AuroraRoutePage } from '../page-content'
import { getShellSnapshot } from '../shell-state'
import { MeshPeersClientPage } from './mesh-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'mesh')
  if (route) return <MeshPeersClientPage route={route} />
  return (
    <AuroraRoutePage
      routeId="mesh"
      title="Mesh"
      description="Trusted device actions appear when Aurora confirms the device is reachable and allowed."
    />
  )
}
