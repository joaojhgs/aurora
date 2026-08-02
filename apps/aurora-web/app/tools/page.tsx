import { AuroraRoutePage } from '../page-content'
import { getShellSnapshot } from '../shell-state'
import { ToolApprovalClientPage } from './tool-approval-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'tools')

  return (
    <>
      {route ? <ToolApprovalClientPage route={route} /> : null}
      {!route ? (
        <AuroraRoutePage
          routeId="tools"
          title="Tools"
          description="Tool approvals appear when Aurora confirms available tools and required approvals."
        />
      ) : null}
    </>
  )
}
