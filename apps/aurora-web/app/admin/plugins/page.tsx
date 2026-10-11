import { AuroraRoutePage } from '../../page-content'
import { getShellSnapshot } from '../../shell-state'
import { PluginsClientPage } from './plugins-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'plugins')

  return (
    <>
      {route ? <PluginsClientPage route={route} /> : null}
      {!route ? (
        <AuroraRoutePage
          routeId="plugins"
        />
      ) : null}
    </>
  )
}
