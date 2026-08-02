'use client'

import { useEffect, useState } from 'react'
import type { ToolApprovalCardModel } from '@aurora/client'
import { loadLightweightRemoteProjectionCatalog } from '@aurora/client/lightweight-orchestrator'
import {
  LightweightToolApprovalPanel,
  ToolApprovalPanel,
  type RouteAvailability,
} from '@aurora/ui'
import {
  useBrowserRoute,
  useBrowserShellRuntime,
} from '../browser-shell-runtime'

export function ToolApprovalClientPage({
  route,
  initialTools
}: {
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
}) {
  const runtime = useBrowserShellRuntime()
  const client = runtime.client
  const activeRoute = useBrowserRoute(route)
  const [remoteTools, setRemoteTools] = useState(
    () => runtime.localAssistant?.remoteTools ?? [],
  )

  useEffect(() => {
    if (!runtime.surface.ownsLocalNodeState || !runtime.localToolProvider) return
    let active = true
    let generation = 0
    const refresh = async () => {
      const current = ++generation
      try {
        const snapshot = await loadLightweightRemoteProjectionCatalog(
          runtime.client.tools,
          { pageSize: 100, maxPages: 16 },
        )
        if (active && current === generation) setRemoteTools(snapshot.tools)
      } catch {
        if (active && current === generation) setRemoteTools([])
      }
    }
    const onPeer = (snapshot: ReturnType<typeof runtime.peer.snapshot>) => {
      if (snapshot.status === 'authorized' || snapshot.status === 'fallback-http') {
        void refresh()
      } else {
        generation += 1
        setRemoteTools([])
      }
    }
    const unsubscribe = runtime.peer.subscribe(onPeer)
    onPeer(runtime.peer.snapshot())
    return () => {
      active = false
      generation += 1
      unsubscribe()
    }
  }, [runtime])

  if (
    runtime.surface.ownsLocalNodeState
    && runtime.localToolProvider
    && runtime.localFeatureSharing
  ) {
    return (
      <LightweightToolApprovalPanel
        client={client}
        route={activeRoute}
        localTools={runtime.localToolProvider.localToolRegistry.publicTools()}
        remoteTools={remoteTools}
        featureSharing={runtime.localFeatureSharing}
      />
    )
  }
  return <ToolApprovalPanel client={client} route={activeRoute} initialTools={initialTools} />
}
