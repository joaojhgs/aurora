'use client'

import { MemoryView, type RouteAvailability } from '@aurora/ui'
import { LocalDataProvider } from '@aurora/ui/local-data'
import type {
  LocalDataBackend,
  LocalDataBackendStatus,
  LocalDataSession,
} from '@aurora/client/local-data'
import { useBrowserRoute, useBrowserShellRuntime } from '../browser-shell-runtime'
import type { AuroraBrowserLocalDataContext } from '../aurora-client'

export function MemoryClientPage({ route }: { route: RouteAvailability }) {
  const activeRoute = useBrowserRoute(route)
  const runtime = useBrowserShellRuntime()
  const localData = runtime.localData
  const canUseLocalData = Boolean(
    localData
    && runtime.localNodeProviderStatus.available
    && runtime.localNodeProviderStatus.localDataWritable,
  )
  const view = <MemoryView client={runtime.client} route={activeRoute} />

  if (!canUseLocalData || !localData) return view

  return (
    <LocalDataProvider
      profileId={localData.session.profileId}
      localNodeId={localData.session.localNodeId}
      ownerAvailable={runtime.localNodeProviderStatus.localDataWritable}
      backendFactory={() => runtimeLocalDataBackend(localData)}
    >
      {view}
    </LocalDataProvider>
  )
}

function runtimeLocalDataBackend(localData: AuroraBrowserLocalDataContext): LocalDataBackend {
  return {
    kind: localData.backend.kind,
    persistent: localData.backend.persistent,
    sqlite: localData.backend.sqlite,
    async open(profileId: string, localNodeId: string): Promise<LocalDataSession> {
      if (profileId !== localData.session.profileId || localNodeId !== localData.session.localNodeId) {
        throw new Error('Local data belongs to another Aurora profile.')
      }
      return localData.session
    },
    async status(): Promise<LocalDataBackendStatus> {
      const status = await localData.backend.status()
      return {
        ...status,
        profileId: status.profileId ?? localData.session.profileId,
        schemaVersion: status.schemaVersion ?? localData.session.schemaVersion,
      }
    },
    async close(): Promise<void> {
      // The browser runtime owns the shared local-data services and closes them with the runtime.
    },
  }
}
