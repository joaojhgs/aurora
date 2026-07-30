'use client'

import { useMemo } from 'react'
import type {
  ToolApprovalConfirmRequest,
  ToolApprovalConfirmResponse,
  ToolApprovalRequestResponse,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
  ToolingProjectionToolInfo,
} from '@aurora/client'
import {
  createLightweightToolClientAdapter,
  createOnDeviceLightweightToolPolicy,
  mergeLightweightAssistantTools,
  onDeviceAssistantPermissions,
  type LightweightToolClientDelegate,
  type LightweightToolExecutionResponse,
} from '@aurora/client/lightweight-orchestrator'
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
  const localAssistant = runtime.localAssistant
  if (
    !runtime.features.lightweightOrchestratorEnabled
    || !localData
    || !runtime.localNodeProviderStatus.localDataWritable
    || !localToolProvider
    || !localAssistant
  ) return null
  const localTools = localToolProvider.localToolRegistry.publicTools()
  const availableTools = mergeLightweightAssistantTools(localTools, localAssistant.remoteTools ?? [])
  const localPolicy = createOnDeviceLightweightToolPolicy({
    localRegistry: localToolProvider.localToolRegistry,
    providerPeerId: localToolProvider.providerPeerId,
    serviceInstanceId: localToolProvider.serviceInstanceId,
  })
  return {
    provider: localAssistant.provider,
    tools: createLightweightToolClientAdapter({
      localRegistry: localToolProvider.localToolRegistry,
      localPolicy,
      remote: remoteToolDelegate(runtime),
      availableTools,
      providerPeerId: localToolProvider.providerPeerId,
      serviceInstanceId: localToolProvider.serviceInstanceId,
      callerPeerId: localData.session.localNodeId,
      callerPrincipalId: localData.session.profileId,
      callerPermissions: onDeviceAssistantPermissions(localTools),
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

function remoteToolDelegate(runtime: AuroraBrowserRuntime): LightweightToolClientDelegate {
  return {
    prepareExecution: (payload) =>
      runtime.client.tools.prepareExecution<ToolingPrepareExecutionResponse, ToolingPrepareExecutionRequest>(payload),
    requestApproval: (payload) =>
      runtime.client.tools.requestApproval<ToolApprovalRequestResponse, ToolingPrepareExecutionRequest>(payload),
    confirmExecution: (payload) =>
      runtime.client.tools.confirmExecution<ToolApprovalConfirmResponse, ToolApprovalConfirmRequest>(payload),
    execute: (payload) =>
      runtime.client.tools.execute<LightweightToolExecutionResponse, ToolingPrepareExecutionRequest>(payload),
  }
}
