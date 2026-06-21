import { AuroraRoutePage } from '../page-content'
import { createAuroraWebClient } from '../aurora-client'
import { getShellSnapshot } from '../shell-state'
import { ToolApprovalClientPage } from './tool-approval-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'tools')
  const client = createAuroraWebClient()
  const cards = await client.tools.loadApprovalCards()
  const initialTools = cards.ok ? cards.data : undefined

  return (
    <>
      {route ? <ToolApprovalClientPage route={route} initialTools={initialTools} /> : null}
      {!route ? (
        <AuroraRoutePage
          routeId="tools"
          title="Tools"
          description="Tool catalog and approval cards must use Tooling catalog, prepare, request, confirm, and execute SDK calls before any execution is enabled."
        />
      ) : null}
    </>
  )
}
