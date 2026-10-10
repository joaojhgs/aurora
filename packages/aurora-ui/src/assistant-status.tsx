'use client'

import type { AssistantRuntimeHealth } from './assistant-view'
import type { RouteAvailability } from './shell-data'
import { productConnectionCopy, safeAssistantRuntimeValue } from './assistant-message'

export function AssistantRuntimeStrip({ health }: { health: AssistantRuntimeHealth }) {
  return (
    <section className="sr-only" aria-label="Assistant status">
      <p>
        Connection and model status for this conversation.
      </p>
      <dl>
        <div><dt>Selected model</dt><dd>{health.selectedModel ?? 'model pending'}</dd></div>
        <div><dt>Model state</dt><dd>{health.selectedModel ? 'configured' : 'model status pending'}</dd></div>
        <div><dt>Answers from</dt><dd>{health.routeLabel}</dd></div>
        <div><dt>On this device</dt><dd>{health.sidecarHealth}</dd></div>
        <div><dt>Connection</dt><dd>{health.gatewayHealth}</dd></div>
      </dl>
    </section>
  )
}

export function buildAssistantRuntimeStrip(
  runtimeHealth: AssistantRuntimeHealth | undefined,
  modelLabel: string | null,
  route: RouteAvailability,
  transportKind: string
): AssistantRuntimeHealth {
  const routeLabel = safeAssistantRuntimeValue(
    runtimeHealth?.routeLabel,
    route.state === 'available-remote' ? 'Connected Aurora device' : 'This device'
  ) ?? 'This device'
  return {
    selectedModel: safeAssistantRuntimeValue(runtimeHealth?.selectedModel ?? modelLabel, null),
    routeLabel: /^local$/i.test(routeLabel) ? 'This device' : routeLabel,
    sidecarHealth: safeAssistantRuntimeValue(runtimeHealth?.sidecarHealth, transportKind === 'mock' ? 'Preview ready' : 'Status pending') ?? 'Status pending',
    gatewayHealth: safeAssistantRuntimeValue(runtimeHealth?.gatewayHealth, productConnectionCopy(transportKind)) ?? 'Connection status ready'
  }
}
