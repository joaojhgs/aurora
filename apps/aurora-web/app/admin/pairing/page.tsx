import { AuroraRoutePage } from '../../page-content'
import { getShellSnapshot } from '../../shell-state'
import { PairingQueueClientPage } from '../pairing-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'pairing')
  if (route) return <PairingQueueClientPage route={route} />
  return (
    <AuroraRoutePage
      routeId="pairing"
    />
  )
}
