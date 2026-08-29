'use client'

import { SettingsView, type AuroraShellSnapshot, type RouteAvailability } from '@aurora/ui'
import { saveAuroraBrowserLocalSpeechSelection } from '../aurora-client'
import { useBrowserRoute, useBrowserRuntimeProfile, useBrowserShellRuntime } from '../browser-shell-runtime'

export function SettingsClientPage({
  snapshot,
  configRoute,
  dataRoute
}: {
  snapshot: AuroraShellSnapshot
  configRoute: RouteAvailability
  dataRoute: RouteAvailability
}) {
  const runtime = useBrowserShellRuntime()
  const activeConfigRoute = useBrowserRoute(configRoute)
  const activeDataRoute = useBrowserRoute(dataRoute)
  const runtimeProfile = useBrowserRuntimeProfile()

  return (
    <SettingsView
      client={runtime.client}
      snapshot={snapshot}
      configRoute={activeConfigRoute}
      dataRoute={activeDataRoute}
      runtimeProfile={runtimeProfile}
      surfaceProfile={runtime.surface}
      localSpeechCatalog={runtime.localSpeechCatalog}
      onLocalSpeechSelectionConfirmed={saveAuroraBrowserLocalSpeechSelection}
    />
  )
}
