import { AuroraRoutePage } from './page-content'
import { getShellSnapshot } from './shell-state'
import { AssistantClientPage } from './assistant-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'assistant')
  return (
    <>
      {route ? <AssistantClientPage route={route} /> : null}
      {!route ? (
        <AuroraRoutePage
          routeId="assistant"
          title="Assistant"
          description="Assistant route evidence is unavailable from the SDK shell snapshot."
        />
      ) : null}
    </>
  )
}
