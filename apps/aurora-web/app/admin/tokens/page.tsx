import { StateSurface, type RouteAvailability } from '@aurora/ui'
import { getShellSnapshot } from '../../shell-state'
import { TokensClientPage } from './tokens-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'tokens')
  if (!route) {
    return (
      <StateSurface
        title="Tokens"
        state="unsupported"
        description="Token route availability could not be resolved from the AuroraClient capability graph."
        evidence={snapshot.evidenceSource}
      />
    )
  }
  return <TokensClientPage route={route as RouteAvailability} />
}
