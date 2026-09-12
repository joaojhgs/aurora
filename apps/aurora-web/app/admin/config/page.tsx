import { getShellSnapshot } from '../../shell-state'
import { ConfigClientPage } from './config-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'config')
  if (!route) throw new Error('Config route is not registered in the Aurora shell')
  return <ConfigClientPage route={route} />
}
