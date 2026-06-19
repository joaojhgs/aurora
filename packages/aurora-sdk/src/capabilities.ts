import type { AvailabilityState, CapabilityActionInfo, CapabilityCatalogResponse, CapabilitySummary, PrivacyClass } from './types.js'

export function summarizeCapabilities(catalog: CapabilityCatalogResponse): CapabilitySummary[] {
  return catalog.actions.map((action) => ({
    id: action.action_id,
    module: action.module,
    method: action.method,
    busTopic: action.topic,
    providerId: action.provider_id,
    peerId: action.peer_id,
    serviceInstanceId: action.service_instance_id,
    availability: availabilityForAction(action),
    privacyClass: privacyClassForAction(action),
    requiredPermissions: [...action.policy.required_permissions],
    routeBlockers: [...action.route_blockers, ...action.policy.denial_reasons],
    selector: action.selector,
    raw: action
  }))
}

export function availabilityForAction(action: CapabilityActionInfo): AvailabilityState {
  if (action.freshness.stale) return 'stale'
  if (action.policy.denial_reasons.length > 0 || action.bindability === 'denied') return 'denied'
  if (
    action.policy.consent_required ||
    action.policy.privacy_indicator_required ||
    action.policy.explicit_selector_required ||
    action.policy.selector_required
  ) {
    return 'privacy-blocked'
  }
  if (action.route_blockers.length > 0 || action.bindability === 'unavailable') return 'unsupported'
  if (action.bindability === 'degraded') return 'degraded'
  if (action.provider_kind === 'local') return 'available-local'
  return 'available-remote'
}

export function privacyClassForAction(action: CapabilityActionInfo): PrivacyClass {
  if (action.policy.safety_class === 'admin' || action.policy.operation_class === 'admin') {
    return 'admin-critical'
  }
  if (action.policy.resource_scope === 'credential') return 'credential'
  if (action.policy.resource_scope === 'raw-audio') return 'raw-audio'
  if (action.policy.consent_required || action.policy.privacy_indicator_required) return 'sensitive'
  if (action.policy.safety_class === 'secret') return 'secret'
  if (action.policy.safety_class === 'sensitive') return 'sensitive'
  return 'public'
}
