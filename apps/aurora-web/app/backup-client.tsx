'use client'

import { BackupRestoreView, type RouteAvailability } from '@aurora/ui'
import type { BackupListResponse } from '@aurora/client'
import { createAuroraBrowserClient } from './aurora-client'

export function BackupClientPage({
  route,
  initialList,
  initialError
}: {
  route: RouteAvailability
  initialList?: BackupListResponse | null
  initialError?: string | null
}) {
  return (
    <BackupRestoreView
      client={createAuroraBrowserClient()}
      route={route}
      initialList={initialList}
      initialError={initialError}
    />
  )
}
