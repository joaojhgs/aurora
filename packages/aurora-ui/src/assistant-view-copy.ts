import type { AuroraError } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { isRemoteRouteCandidate } from './use-assistant-execution'

export function assistantPrivacyClassCopy(privacy: string | null | undefined): string {
  switch (privacy) {
    case 'public':
      return 'Public'
    case 'personal':
      return 'Personal'
    case 'sensitive':
      return 'Sensitive'
    case 'secret':
      return 'Private'
    case 'raw-audio':
      return 'Microphone audio'
    case 'credential':
      return 'Credential'
    case 'admin-critical':
      return 'Protected'
    default:
      return 'Sensitive'
  }
}

export function assistantRemotePrivacyWarning(route: RouteAvailability): string | null {
  const privacyClass = route.item.privacyClass
  if (privacyClass === 'public') return null
  const remoteOrMeshEvidence = [
    route.providerLabel,
    route.explanation,
    ...route.candidateProviders.flatMap((candidate) => [candidate.id, candidate.label, candidate.reason])
  ].join(' ')
  const remoteOrMeshFallback =
    route.state === 'available-remote' ||
    route.state === 'degraded' ||
    route.selectorRequired ||
    /remote|mesh|peer|cloud|http|fallback/i.test(remoteOrMeshEvidence)
  if (!remoteOrMeshFallback) return null
  const label = assistantPrivacyClassCopy(privacyClass)
  return `${label} data needs privacy review before another device can help; nothing leaves until consent, privacy indicator, and policy allow it.`
}

export function productAssistantErrorCopy(error: AuroraError | Error): string {
  if ('code' in error && error.code === 'timeout') return 'Aurora timed out before returning a final assistant response.'
  if ('code' in error && (error.code === 'auth' || error.code === 'permission')) return 'Assistant request denied. Review access and try again.'
  if ('code' in error && (error.code === 'unavailable_service' || error.code === 'unsupported_feature')) return 'Assistant service is unavailable for this Aurora setup.'
  if ('code' in error && error.code === 'privacy_blocked') return 'Assistant request is blocked until the required privacy choice is made.'
  if ('code' in error && error.code === 'transport_loss') return 'Assistant response was interrupted before Aurora finished.'
  return 'Assistant request failed. Try again.'
}

export const assistantErrorMessage = productAssistantErrorCopy
