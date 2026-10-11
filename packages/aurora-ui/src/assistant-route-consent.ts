import type { RouteAvailability } from './shell-data'
import { isRemoteRouteCandidate } from './use-assistant-execution'

export function remoteAudioConsentRouteKey(route: RouteAvailability): string {
  const candidateKey = route.candidateProviders
    .filter((candidate) => candidate.selectable || isRemoteRouteCandidate(candidate))
    .map((candidate) => [
      candidate.id,
      candidate.providerId ?? '',
      candidate.peerId ?? '',
      candidate.serviceInstanceId ?? '',
      candidate.state,
      candidate.selectable ? 'selectable' : 'fixed'
    ].join(':'))
    .sort()
    .join('|')
  return [
    route.item.id,
    route.item.capabilityMethod ?? '',
    route.state,
    route.selectorRequired ? 'selector' : 'direct',
    route.providerLabel,
    candidateKey
  ].join('::')
}
