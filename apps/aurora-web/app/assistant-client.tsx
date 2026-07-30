'use client'

import { useMemo } from 'react'
import { createLightweightToolClientAdapter } from '@aurora/client/lightweight-orchestrator'
import { AssistantView, type RouteAvailability } from '@aurora/ui'
import { AssistantSurfaceSelector, type LightweightAssistantProps } from '@aurora/ui/local-assistant'
import {
  useBrowserCancellationRoute,
  useBrowserRoute,
  useBrowserShellRuntime,
} from './browser-shell-runtime'
import type { AuroraBrowserRuntime } from './aurora-client'

export function AssistantClientPage({
  route,
  cancellationRoute
}: {
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
}) {
  const runtime = useBrowserShellRuntime()
  const activeRoute = useBrowserRoute(route)
  const activeCancellationRoute = useBrowserCancellationRoute(cancellationRoute)
  const localAssistant = useMemo(() => browserLocalAssistant(runtime), [runtime])
  return (
    <AssistantSurfaceSelector
      connectedAssistant={
        <AssistantView
          client={runtime.client}
          route={activeRoute}
          cancellationRoute={activeCancellationRoute}
        />
      }
      localAssistant={localAssistant}
    />
  )
}

function browserLocalAssistant(runtime: AuroraBrowserRuntime): LightweightAssistantProps | null {
  const localData = runtime.localData
  const localToolProvider = runtime.localToolProvider
  if (!localData || !runtime.localNodeProviderStatus.localDataWritable || !localToolProvider) return null
  const availableTools = localToolProvider.localToolRegistry.publicTools()
  return {
    tools: createLightweightToolClientAdapter({
      localRegistry: localToolProvider.localToolRegistry,
      localPolicy: localToolProvider.policy,
      availableTools,
      providerPeerId: localToolProvider.providerPeerId,
      serviceInstanceId: localToolProvider.serviceInstanceId,
      callerPeerId: localData.session.localNodeId,
      callerPrincipalId: localData.session.profileId,
      callerPermissions: ['Tooling.ExecuteTool'],
    }),
    localData: localData.session,
    envelopeCrypto: localData.crypto,
    scope: {
      profileId: localData.session.profileId,
      localNodeId: localData.session.localNodeId,
    },
    availableTools,
  }
}
