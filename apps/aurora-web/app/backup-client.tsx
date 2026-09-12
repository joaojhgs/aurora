'use client'

import { BackupRestoreView, type RouteAvailability } from '@aurora/ui'
import type { BackupListResponse } from '@aurora/client'
import { createAuroraBrowserClient } from './aurora-client'
import { useBrowserRoute } from './browser-shell-runtime'

export function BackupClientPage({
  route,
  initialList,
  initialError
}: {
  route: RouteAvailability
  initialList?: BackupListResponse | null
  initialError?: string | null
}) {
  const activeRoute = useBrowserRoute(route)
  return (
    <BackupRestoreView
      client={createAuroraBrowserClient()}
      route={activeRoute}
      initialList={initialList}
      initialError={initialError}
    />
  )
}
