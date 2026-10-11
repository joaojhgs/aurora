import type { AssistantRoutePolicy } from '@aurora/client'

import type { RouteAvailability } from './shell-data'
import type { AssistantExecutionOption } from './assistant-view'

export function routePolicyFromRoute(
  route: RouteAvailability,
  provider = selectedRoutePolicyProvider(route)
): AssistantRoutePolicy {
  const providerId = provider?.providerId ?? provider?.id ?? null
  const remoteProvider = provider && isRemoteRouteCandidate(provider) ? provider : null
  return {
    providerId,
    peerId: remoteProvider ? remoteProvider.peerId ?? (providerId ? peerIdFromProviderIdentity(providerId) : null) : null,
    serviceInstanceId: remoteProvider ? remoteProvider.serviceInstanceId ?? (providerId ? serviceInstanceFromProviderIdentity(providerId) : null) : null,
    routeState: route.state,
    fallbackBehavior: route.state === 'degraded' ? 'backend-reported degraded route' : null,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired
  }
}

function selectedRoutePolicyProvider(route: RouteAvailability): RouteAvailability['candidateProviders'][number] | undefined {
  if (route.selectorRequired) return undefined
  const local = route.candidateProviders.find((candidate) => candidate.selectable && !isRemoteRouteCandidate(candidate))
    ?? route.candidateProviders.find((candidate) => !isRemoteRouteCandidate(candidate))
  if (local && route.state !== 'available-remote') return local
  const remote = route.candidateProviders.find((candidate) => candidate.selectable && isRemoteRouteCandidate(candidate))
    ?? route.candidateProviders.find(isRemoteRouteCandidate)
  return remote ?? local ?? route.candidateProviders.find((candidate) => candidate.selectable) ?? route.candidateProviders[0]
}

export interface AssistantExecutionContext {
  executionHost?: 'this-device' | 'connected-device'
  localExecutionAvailable?: boolean
}

export function assistantExecutionOptions(
  route: RouteAvailability,
  context: AssistantExecutionContext = {}
): AssistantExecutionOption[] {
  const executionHost = context.executionHost ?? 'this-device'
  const options: AssistantExecutionOption[] = []
  if (executionHost === 'this-device' || context.localExecutionAvailable === true) {
    options.push({
      id: 'local',
      mode: 'local',
      runner: context.localExecutionAvailable === true ? 'lightweight-local' : 'aurora-route',
      label: 'Local',
      description: 'Run the assistant on this device. The model may run here, use a cloud service, or be shared by another device.',
      routePolicy: context.localExecutionAvailable === true
        ? { ...routePolicyFromRoute(route), providerId: null, peerId: null, serviceInstanceId: null }
        : routePolicyFromRoute(route),
      executionPeerId: null,
      transportHost: false,
      modelCatalogHost: executionHost === 'connected-device' ? 'connected-device' : 'mixed'
    })
  }
  const seen = new Set<string>()
  for (const candidate of route.candidateProviders) {
    if (!candidate.selectable) continue
    const remoteCandidate = isRemoteRouteCandidate(candidate)
    if (executionHost !== 'connected-device' && !remoteCandidate) continue
    const peerId = candidate.peerId ?? peerIdFromProviderIdentity(candidate.providerId ?? candidate.id)
    const serviceInstanceId = candidate.serviceInstanceId ?? serviceInstanceFromProviderIdentity(candidate.providerId ?? candidate.id)
    const providerId = candidate.providerId ?? candidate.id
    const identity = peerId ?? serviceInstanceId ?? providerId
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    const peerLabel = executionPeerLabel(candidate.nodeName ?? candidate.label, peerId)
    const transportHost = executionHost === 'connected-device' && !remoteCandidate
    options.push({
      id: `dispatch:${transportHost ? 'connected:' : ''}${identity}`,
      mode: 'dispatch',
      runner: 'aurora-route',
      label: peerLabel,
      description: `Send this turn to ${peerLabel}; that device handles the request.`,
      routePolicy: transportHost
        ? routePolicyFromRoute(route, candidate)
        : {
            providerId,
            peerId,
            serviceInstanceId,
            routeState: candidate.state,
            fallbackBehavior: candidate.state === 'degraded' ? candidate.reason : null,
            privacyClass: route.item.privacyClass,
            selectorRequired: route.selectorRequired,
            approvalRequired: route.approvalRequired
          },
      executionPeerId: peerId,
      transportHost,
      modelCatalogHost: 'connected-device'
    })
  }
  if (executionHost === 'connected-device' && !options.some((option) => option.mode === 'dispatch')) {
    options.push({
      id: 'dispatch:connected',
      mode: 'dispatch',
      runner: 'aurora-route',
      label: 'Connected Aurora device',
      description: 'Dispatch the assistant turn to the connected Aurora device.',
      routePolicy: routePolicyFromRoute(route),
      executionPeerId: null,
      transportHost: true,
      modelCatalogHost: 'connected-device'
    })
  }
  return options
}

export function peerIdFromProviderIdentity(providerId: string): string | null {
  const match = /^(?:remote|mesh):([^:]+):/i.exec(providerId)
  return match?.[1] ?? null
}

export function serviceInstanceFromProviderIdentity(providerId: string): string | null {
  const match = /^(?:remote|mesh):([^:]+):([^:]+)/i.exec(providerId)
  return match ? `${match[0].startsWith('mesh:') ? 'mesh' : 'remote'}:${match[1]}:${match[2]}` : null
}

export function executionPeerLabel(label: string, peerId: string | null): string {
  const providerLabel = label.split(' / ')[0]?.trim() ?? ''
  const readable = providerLabel.replace(/^(?:remote|mesh):/i, '').replace(/[:/_-]+Orchestrator.*$/i, '')
  if (/^(?:local|local-peer)$/i.test(readable)) return 'This device'
  return readable || peerId || 'Connected device'
}

export function isRemoteRouteCandidate(candidate: RouteAvailability['candidateProviders'][number]): boolean {
  return /mesh|remote/i.test(`${candidate.providerKind ?? ''} ${candidate.providerId ?? ''} ${candidate.id} ${candidate.serviceInstanceId ?? ''} ${candidate.label}`)
}
