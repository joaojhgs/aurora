import { describeRegistry } from './descriptors.js'
import type {
  AdminOverviewManifest,
  AdminOverviewManifestInput,
  AdminOverviewServiceSummary,
  AvailabilityState,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilitySummary,
  GetServicesResponse,
  NativeCapabilityManifest,
  NativeCapabilityState,
  PrivacyClass,
  ServiceInfo
} from './types.js'

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

export function buildAdminOverviewManifest(input: AdminOverviewManifestInput): AdminOverviewManifest {
  const methods = describeRegistry(input.registry)
  const servicesInput = normalizeServices(input.services)
  const serviceByModule = new Map(servicesInput.services.map((service) => [service.module, service]))
  const serviceSummaries = input.registry.modules.map<AdminOverviewServiceSummary>((moduleInfo) => {
    const service = serviceByModule.get(moduleInfo.module)
    const moduleMethods = methods.filter((method) => method.module === moduleInfo.module)
    return {
      module: moduleInfo.module,
      version: service?.version ?? moduleInfo.version,
      status: service?.status ?? 'unknown',
      methodCount: service?.method_count ?? moduleMethods.length,
      externalMethodCount: moduleMethods.filter((method) => method.availableOverHttp).length,
      internalMethodCount: moduleMethods.filter((method) => !method.availableOverHttp).length,
      requiredPermissions: sortedUnique(moduleMethods.flatMap((method) => method.requiredPermissions)),
      lastSeen: service?.last_seen ?? ''
    }
  })

  const capabilities = input.capabilityCatalog ? summarizeCapabilities(input.capabilityCatalog) : []
  const unavailable = capabilities.filter((capability) =>
    ['unsupported', 'denied', 'privacy-blocked', 'stale'].includes(capability.availability)
  )
  const internalOnly = methods.filter((method) => method.exposure === 'internal')
  const permissionCatalog = sortedUnique([
    ...methods.flatMap((method) => method.requiredPermissions),
    ...capabilities.flatMap((capability) => capability.requiredPermissions),
    ...(input.gatewayBuiltins ?? []).flatMap((route) => route.requiredPermissions)
  ])
  const externalMethods = methods.filter((method) => method.availableOverHttp).length
  const native = nativeCapabilityState(input.nativeManifest)

  return {
    generatedAt: input.generatedAt ?? input.capabilityCatalog?.generated_at ?? new Date().toISOString(),
    registryDigest: input.registry.digest,
    serviceMode: servicesInput.mode,
    services: serviceSummaries.sort((a, b) => a.module.localeCompare(b.module)),
    methods,
    gatewayBuiltins: [...(input.gatewayBuiltins ?? [])].sort((a, b) => a.routePath.localeCompare(b.routePath)),
    capabilities,
    native,
    peers: [...(input.peers ?? [])].sort((a, b) => a.peerId.localeCompare(b.peerId)),
    unavailable,
    internalOnly,
    permissionCatalog,
    totals: {
      services: serviceSummaries.length,
      methods: methods.length,
      externalMethods,
      internalMethods: methods.length - externalMethods,
      gatewayBuiltins: input.gatewayBuiltins?.length ?? 0,
      capabilityActions: capabilities.length,
      peers: input.peers?.length ?? 0
    },
    privacy: {
      secretsRedacted: input.capabilityCatalog?.secrets_redacted ?? true,
      nativeStateInvented: false,
      peerStateInvented: false
    }
  }
}

function normalizeServices(
  services: AdminOverviewManifestInput['services']
): { services: ServiceInfo[]; mode: string } {
  if (!services) return { services: [], mode: 'unknown' }
  if (Array.isArray(services)) return { services, mode: 'unknown' }
  return services as GetServicesResponse
}

function nativeCapabilityState(manifest: NativeCapabilityManifest | null | undefined): NativeCapabilityState {
  if (!manifest) {
    return {
      platform: 'none',
      availability: 'unsupported',
      permissions: {},
      capabilityKeys: [],
      evidenceSource: 'not-provided'
    }
  }
  return {
    platform: manifest.platform,
    availability: 'available-local',
    permissions: { ...manifest.permissions },
    capabilityKeys: Object.keys(manifest.capabilities).sort(),
    evidenceSource: 'native-manifest'
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}
