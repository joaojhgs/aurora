import { AuroraRoutePage } from '../../page-content'
import { getShellSnapshot } from '../../shell-state'
import { SchedulerClientPage } from './scheduler-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'scheduler')

  return (
    <>
      {route ? <SchedulerClientPage route={route} /> : null}
      {!route ? (
        <AuroraRoutePage
          routeId="scheduler"
          title="Scheduler"
          description="Scheduled jobs and automation controls appear when Aurora confirms they are available for this device."
        />
      ) : null}
    </>
  )
}
