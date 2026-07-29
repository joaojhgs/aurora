import { AuroraRoutePage } from '../../page-content'
import { createAuroraWebClient } from '../../aurora-client'
import { getShellSnapshot } from '../../shell-state'
import { BackupClientPage } from '../../backup-client'
import { productBackupErrorText } from '../../product-copy'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  const route = snapshot.routes.find((candidate) => candidate.item.id === 'backups')
  const client = createAuroraWebClient()
  const initialList = route && !route.disabled ? await client.backups.list({ limit: 50, include_failed: true }) : null
  if (route) {
    return (
      <BackupClientPage
        route={route}
        initialList={initialList?.ok ? initialList.data : null}
        initialError={initialList && !initialList.ok ? productBackupErrorText(initialList.error) : null}
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
