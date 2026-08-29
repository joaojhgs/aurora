import { AuroraRoutePage } from '../../page-content'
import { getShellSnapshot } from '../../shell-state'
import { BackupClientPage } from '../../backup-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'backups')
  if (route) {
    return (
      <BackupClientPage
        route={route}
        initialList={null}
        initialError={null}
      />
    )
  }
  return (
    <AuroraRoutePage
      routeId="backups"
      title="Backups"
      description="Backup and restore controls appear when Aurora confirms this device can manage saved copies."
    />
  )
}
