'use client'

import { ConfigEditorView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'
import { useBrowserRoute } from '../../browser-shell-runtime'

export function ConfigClientPage({ route }: { route: RouteAvailability }) {
  const activeRoute = useBrowserRoute(route)
  return <ConfigEditorView client={createAuroraBrowserClient()} route={activeRoute} />
}
