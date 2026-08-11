'use client'

import { SettingsView, type AuroraShellSnapshot, type RouteAvailability } from '@aurora/ui'
import { useBrowserRoute, useBrowserShellRuntime } from '../browser-shell-runtime'

export function SettingsClientPage({
  snapshot,
  settingsRoute,
  configRoute,
  dataRoute
}: {
  snapshot: AuroraShellSnapshot
  settingsRoute: RouteAvailability
  configRoute: RouteAvailability
  dataRoute: RouteAvailability
}) {
  const runtime = useBrowserShellRuntime()
  const activeSettingsRoute = useBrowserRoute(settingsRoute)
  const activeConfigRoute = useBrowserRoute(configRoute)
  const activeDataRoute = useBrowserRoute(dataRoute)

  return (
    <SettingsView
      client={runtime.client}
      snapshot={snapshot}
      configRoute={activeConfigRoute}
      dataRoute={activeDataRoute}
      initialTab={activeSettingsRoute.disabled ? 'advanced' : 'general'}
    />
  )
}
