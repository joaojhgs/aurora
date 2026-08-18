import { getShellSnapshot } from '../../shell-state'
import { SettingsClientPage } from '../settings-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const settingsRoute = routeFor(snapshot, 'settings')
  if (!settingsRoute) return null
  const configRoute = routeFor(snapshot, 'config') ?? settingsRoute
  const dataRoute = routeFor(snapshot, 'data') ?? settingsRoute
  return (
    <SettingsClientPage
      snapshot={snapshot}
      configRoute={configRoute}
      dataRoute={dataRoute}
    />
  )
}

function routeFor(snapshot: Awaited<ReturnType<typeof getShellSnapshot>>, id: string) {
  return snapshot.routes.find((route) => route.item.id === id)
}
