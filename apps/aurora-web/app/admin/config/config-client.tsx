'use client'

import { ConfigEditorView, type RouteAvailability } from '@aurora/ui'
import { createAuroraBrowserClient } from '../../aurora-client'

export function ConfigClientPage({ route }: { route: RouteAvailability }) {
  return <ConfigEditorView client={createAuroraBrowserClient()} route={route} />
}
