import { describeRegistry } from './descriptors.js'
import type {
  AndroidNativeState,
  AdminOverviewManifest,
  AdminOverviewManifestInput,
  AdminOverviewServiceSummary,
  AvailabilityState,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityExplanation,
  CapabilityGraph,
  CapabilityGraphInput,
  CapabilityGraphNode,
  CapabilityProviderCandidate,
  CapabilityProviderIdentity,
  CapabilityProviderInfo,
  CapabilitySummary,
  GetServicesResponse,
  MethodDescriptor,
  NativeCapabilityManifest,
  NativeIntegrationSupport,
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

export function buildCapabilityGraph(input: CapabilityGraphInput): CapabilityGraph {
  const candidatesByFeature = new Map<string, CapabilityProviderCandidate[]>()
  const rawActionsByFeature = new Map<string, CapabilityActionInfo[]>()
  const providersById = new Map(input.catalog.providers.map((provider) => [provider.provider_id, provider]))
  const registryMethods = input.registry ? describeRegistry(input.registry) : []
  const catalogFeatureIds = new Set<string>()

  for (const action of input.catalog.actions) {
    const featureId = featureIdForAction(action)
    catalogFeatureIds.add(featureId)
    addCandidate(candidatesByFeature, candidateFromAction(action, featureId, providersById.get(action.provider_id)))
    addRawAction(rawActionsByFeature, featureId, action)
  }

  for (const method of registryMethods) {
    const featureId = featureIdForMethod(method)
    if (catalogFeatureIds.has(featureId)) continue
    if (method.exposure === 'internal' && !transportSupportsInternalBus(input.transportKind ?? null)) {
      addCandidate(candidatesByFeature, candidateFromMethod(method, featureId, 'internal-only over this transport'))
    }
  }

  for (const candidate of candidatesFromNativeManifest(input.nativeManifest)) {
    addCandidate(candidatesByFeature, candidate)
  }

  const nodes = [...candidatesByFeature.entries()]
    .map(([featureId, candidates]) =>
      nodeFromCandidates(featureId, candidates, rawActionsByFeature.get(featureId) ?? [])
    )
    .sort((a, b) => a.featureId.localeCompare(b.featureId))
  const byFeatureId = Object.fromEntries(nodes.map((node) => [node.featureId, node]))
  const providerIndex = normalizeIndex(input.catalog.provider_index)
  const candidateProviderIndex = {
    ...providerIndex,
    ...Object.fromEntries(
      nodes.map((node) => [node.featureId, node.providers.map((provider) => provider.id)])
    )
  }

  return {
    generatedAt: input.catalog.generated_at,
    localPeerId: input.catalog.local_peer_id,
    localNodeName: input.catalog.local_node_name,
    secretsRedacted: input.catalog.secrets_redacted,
    nodes,
    byFeatureId,
    providerIndex,
    candidateProviderIndex,
    explain(featureId: string): CapabilityExplanation {
      const node = byFeatureId[featureId]
      if (!node) {
        return explainMissingFeature(featureId, input.catalog.generated_at, input.catalog.secrets_redacted)
      }
      return explainNode(node, input.catalog.generated_at, input.catalog.secrets_redacted)
    }
  }
}

export function availabilityForAction(action: CapabilityActionInfo): AvailabilityState {
  if (action.freshness.stale) return 'stale'
  if (action.bindability === 'pending') return 'pending'
  if (
    action.policy.consent_required ||
    action.policy.privacy_indicator_required ||
    action.policy.explicit_selector_required ||
    action.policy.selector_required
  ) {
    return 'privacy-blocked'
  }
  if (action.policy.denial_reasons.length > 0 || action.bindability === 'denied') return 'denied'
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
    deploymentTopology: input.deploymentTopology ?? null,
    deploymentTopologyError: input.deploymentTopologyError ?? null,
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
    evidenceSource: manifest.evidenceSource ?? 'native-manifest'
  }
}

function featureIdForAction(action: CapabilityActionInfo): string {
  if (action.tool_id) return `tool:${action.tool_id}`
  if (action.resource_id) return `resource:${action.resource_id}`
  return methodFeatureId(action.module, action.method, action.topic)
}

function featureIdForMethod(method: MethodDescriptor): string {
  return methodFeatureId(method.module, method.name, method.busTopic)
}

function methodFeatureId(module: string, method: string, busTopic: string | null): string {
  return `method:${busTopic ?? `${module}.${method}`}`
}

function candidateFromAction(
  action: CapabilityActionInfo,
  featureId: string,
  provider: CapabilityProviderInfo | undefined
): CapabilityProviderCandidate {
  const availability = availabilityForAction(action)
  const disabledReasons = sortedUnique([
    ...action.route_blockers,
    ...action.policy.denial_reasons,
    ...(provider && !provider.eligible ? [provider.reason_code || provider.reason].filter(Boolean) : [])
  ])
  const selectorRequired = action.policy.explicit_selector_required || action.policy.selector_required
  const privacyBlocked =
    selectorRequired || action.policy.consent_required || action.policy.privacy_indicator_required
  return {
    id: `${featureId}@${action.provider_id}`,
    featureId,
    providerIdentity: providerIdentityFor(action.provider_kind, action.peer_id, action.provider_id),
    providerId: action.provider_id,
    providerKind: action.provider_kind,
    peerId: action.peer_id,
    serviceInstanceId: action.service_instance_id,
    module: action.module,
    method: action.method,
    busTopic: action.topic,
    toolId: action.tool_id,
    resourceId: action.resource_id,
    availability,
    selectable: isSelectable(availability) && !privacyBlocked,
    selected: false,
    trustTier: action.policy.trust_tier,
    routeability: routeabilityForAction(action, provider),
    freshness: action.freshness,
    requiredPermissions: [...action.policy.required_permissions],
    privacyClass: privacyClassForAction(action),
    disabledReasons,
    requiredAction: requiredActionForAction(action, provider, disabledReasons),
    selector: action.selector,
    source: 'catalog',
    raw: action
  }
}

function candidateFromMethod(
  method: MethodDescriptor,
  featureId: string,
  reason: string
): CapabilityProviderCandidate {
  return {
    id: `${featureId}@unavailable:http`,
    featureId,
    providerIdentity: 'unavailable',
    providerId: 'unavailable:http',
    providerKind: 'unavailable',
    peerId: null,
    serviceInstanceId: null,
    module: method.module,
    method: method.name,
    busTopic: method.busTopic,
    toolId: null,
    resourceId: null,
    availability: 'unsupported',
    selectable: false,
    selected: false,
    trustTier: 'none',
    routeability: 'unavailable',
    freshness: emptyFreshness('registry'),
    requiredPermissions: [...method.requiredPermissions],
    privacyClass: privacyClassForMethod(method),
    disabledReasons: [reason],
    requiredAction: 'use a local/Tauri transport with bus access or expose a backend contract',
    selector: null,
    source: 'registry',
    raw: method
  }
}

function candidatesFromNativeManifest(
  manifest: NativeCapabilityManifest | null | undefined
): CapabilityProviderCandidate[] {
  if (!manifest) return []
  return [
    ...Object.entries(manifest.capabilities).map(([capability, enabled]) => {
      const featureId = `native:${manifest.platform}:${capability}`
      const nativeState = manifest.capabilityStates?.[capability]
      const missingPermissions = nativeRequiredPermissions(capability, manifest.permissions)
        .filter((permission) => manifest.permissions[permission] === false)
      const availability = availabilityForNativeState(nativeState, enabled, missingPermissions)
      const disabledReasons = disabledReasonsForNativeState(nativeState, enabled, missingPermissions)
      return {
        id: `${featureId}@native:${manifest.platform}`,
        featureId,
        providerIdentity: `native:${manifest.platform}`,
        providerId: `native:${manifest.platform}`,
        providerKind: 'native',
        peerId: null,
        serviceInstanceId: null,
        module: 'Native',
        method: capability,
        busTopic: null,
        toolId: null,
        resourceId: null,
        availability,
        selectable: availability === 'available-local',
        selected: false,
        trustTier: 'device',
        routeability: nativeState ?? (enabled ? 'native-manifest' : 'disabled'),
        freshness: emptyFreshness(manifest.evidenceSource ?? 'native-manifest'),
        requiredPermissions: missingPermissions,
        privacyClass: nativePrivacyClass(capability),
        disabledReasons,
        requiredAction: requiredActionForNativeState(nativeState, availability),
        selector: { platform: manifest.platform, capability },
        source: 'native-manifest',
        raw: null
      } satisfies CapabilityProviderCandidate
    }),
    ...(manifest.mobileIntegrations ?? []).map((integration) => {
      const featureId = `native:${integration.platform}:${integration.id}`
      const availability = availabilityForNativeIntegration(integration.support)
      const disabledReasons =
        availability === 'available-local'
          ? []
          : [`${integration.label}: ${integration.userCopy}`]
      return {
        id: `${featureId}@native:${integration.platform}`,
        featureId,
        providerIdentity: `native:${integration.platform}`,
        providerId: `native:${integration.platform}`,
        providerKind: 'native',
        peerId: null,
        serviceInstanceId: null,
        module: 'Native',
        method: integration.capability,
        busTopic: null,
        toolId: null,
        resourceId: null,
        availability,
        selectable: availability === 'available-local',
        selected: false,
        trustTier: 'device',
        routeability: integration.support,
        freshness: emptyFreshness(integration.evidenceSource),
        requiredPermissions: integration.permission ? [integration.permission] : [],
        privacyClass: integration.privacyClass,
        disabledReasons,
        requiredAction: requiredActionForNativeIntegration(integration.support),
        selector: { platform: integration.platform, capability: integration.capability },
        source: 'native-manifest',
        raw: null
      } satisfies CapabilityProviderCandidate
    })
  ]
    .sort((a, b) => a.featureId.localeCompare(b.featureId))
}

function availabilityForNativeState(
  state: AndroidNativeState | undefined,
  enabled: boolean,
  missingPermissions: string[]
): AvailabilityState {
  if (state === 'available') return missingPermissions.length > 0 ? 'privacy-blocked' : 'available-local'
  if (state === 'needs_native_permission') return 'privacy-blocked'
  if (state === 'degraded' || state === 'fallback') return 'degraded'
  if (state === 'unsupported_platform') return 'unsupported'
  return enabled
    ? missingPermissions.length > 0
      ? 'privacy-blocked'
      : 'available-local'
    : 'unsupported'
}

function disabledReasonsForNativeState(
  state: AndroidNativeState | undefined,
  enabled: boolean,
  missingPermissions: string[]
): string[] {
  if (state === 'needs_native_permission') {
    return missingPermissions.length > 0
      ? missingPermissions.map((permission) => `native permission missing: ${permission}`)
      : ['native permission missing']
  }
  if (state === 'degraded') return ['native capability degraded']
  if (state === 'fallback') return ['native fallback path only']
  if (state === 'unsupported_platform') return ['native platform unsupported']
  return enabled
    ? missingPermissions.map((permission) => `native permission missing: ${permission}`)
    : ['native capability disabled']
}

function requiredActionForNativeState(
  state: AndroidNativeState | undefined,
  availability: AvailabilityState
): string | null {
  if (state === 'needs_native_permission' || availability === 'privacy-blocked') {
    return 'grant required native permission'
  }
  if (state === 'degraded') return 'use the supported subset or complete native integration'
  if (state === 'fallback') return 'use fallback entrypoint until primary native role is available'
  if (state === 'unsupported_platform' || availability === 'unsupported') {
    return 'do not claim this platform capability'
  }
  return null
}

function availabilityForNativeIntegration(support: NativeIntegrationSupport): AvailabilityState {
  if (support === 'supported') return 'available-local'
  if (support === 'supported-path') return 'degraded'
  if (support === 'planned') return 'pending'
  if (support === 'blocked') return 'privacy-blocked'
  return 'unsupported'
}

function requiredActionForNativeIntegration(support: NativeIntegrationSupport): string | null {
  if (support === 'supported') return null
  if (support === 'supported-path') return 'verify platform path in macOS/Xcode simulator or device'
  if (support === 'planned') return 'implement scoped iOS plugin, App Intent, or extension task'
  if (support === 'blocked') return 'satisfy platform entitlement, consent, or permission requirement'
  return 'do not claim this platform capability'
}

function nativeRequiredPermissions(capability: string, permissions: Record<string, boolean>): string[] {
  const normalized = capability.toLowerCase()
  const requestedTokens: string[] = []
  if (normalized.includes('assistantrole.status')) requestedTokens.push('assistantrolestatus')
  if (normalized.includes('assistantrole.request')) requestedTokens.push('assistantrolerequest')
  if (normalized.includes('microphone') || normalized.includes('audiocapture')) requestedTokens.push('microphone', 'audiocapture')
  if (normalized.includes('notification')) requestedTokens.push('notification')
  if (normalized.includes('foregroundservice')) requestedTokens.push('foregroundservice')
  if (normalized.includes('shareintent')) requestedTokens.push('shareintent')
  if (normalized.includes('deeplink')) requestedTokens.push('deeplink')
  if (normalized.includes('appwidget')) requestedTokens.push('appwidget', 'widget')
  if (normalized.includes('appshortcut')) requestedTokens.push('appshortcut', 'shortcut')
  if (normalized.includes('quicktile')) requestedTokens.push('quicktile', 'tile')
  if (normalized.includes('entrypointpayload')) requestedTokens.push('entrypointpayload')
  if (normalized.includes('biometric')) requestedTokens.push('biometric')
  if (normalized.includes('adminunlock')) requestedTokens.push('adminunlock', 'biometric')
  if (normalized.includes('localnetwork')) requestedTokens.push('localnetwork')
  if (normalized.includes('securecredentialstorage')) requestedTokens.push('securestorage', 'credentialstorage')
  if (normalized.includes('securefilehandles')) requestedTokens.push('securefile')
  if (normalized.includes('filepick')) requestedTokens.push('filepick', 'securefile')
  if (normalized.includes('localfileread')) requestedTokens.push('localfileread')
  if (normalized.includes('localfilewrite')) requestedTokens.push('localfilewrite')
  if (normalized.includes('dialog')) requestedTokens.push('dialog')
  if (normalized.includes('tray')) requestedTokens.push('tray')
  if (normalized.includes('logtail')) requestedTokens.push('logtail')
  if (normalized.includes('sidecar')) requestedTokens.push('sidecar')
  if (normalized.includes('fallbackentrypoints')) requestedTokens.push('fallback', 'shareintent', 'deeplink')

  const matches = Object.keys(permissions).filter((permission) => {
    const permissionKey = permission.toLowerCase().replace(/[^a-z0-9]/g, '')
    return requestedTokens.some((token) => permissionKey.includes(token))
  })
  return sortedUnique(matches)
}

function nativePrivacyClass(capability: string): PrivacyClass {
  const normalized = capability.toLowerCase()
  if (normalized.includes('microphone') || normalized.includes('audio')) return 'raw-audio'
  if (normalized.includes('adminunlock')) return 'admin-critical'
  if (normalized.includes('credential') || normalized.includes('storage')) return 'credential'
  return 'personal'
}

function nodeFromCandidates(
  featureId: string,
  candidates: CapabilityProviderCandidate[],
  rawActions: CapabilityActionInfo[]
): CapabilityGraphNode {
  const sortedCandidates = candidates
    .map((candidate) => ({ ...candidate, selected: false }))
    .sort(compareCandidates)
  const selectedIndex = sortedCandidates.findIndex((candidate) => candidate.selectable)
  const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0
  const providers = sortedCandidates.map((candidate, index) => ({
    ...candidate,
    selected: index === fallbackIndex && candidate.selectable
  }))
  const selectedProvider = providers.find((candidate) => candidate.selected) ?? null
  const primary = selectedProvider ?? providers[0] ?? null
  const availability = availabilityForNode(providers, primary)
  const requiredPermissions = sortedUnique(providers.flatMap((provider) => provider.requiredPermissions))
  const disabledReason =
    primary && !isSelectable(availability)
      ? primary.disabledReasons[0] ?? primary.requiredAction ?? availability
      : null
  const selectorRequired = providers.some((provider) =>
    provider.raw && 'policy' in provider.raw
      ? provider.raw.policy.explicit_selector_required || provider.raw.policy.selector_required
      : false
  )
  const approvalRequired = providers.some((provider) =>
    provider.raw && 'policy' in provider.raw ? provider.raw.policy.approval_required : false
  )
  return {
    featureId,
    module: primary?.module ?? '',
    method: primary?.method ?? '',
    busTopic: primary?.busTopic ?? null,
    kind: kindForFeature(featureId),
    availability,
    privacyClass: highestPrivacyClass(providers.map((provider) => provider.privacyClass)),
    providerIdentity: selectedProvider?.providerIdentity ?? primary?.providerIdentity ?? 'unavailable',
    selectedProvider,
    providers,
    alternateProviders: providers.filter((provider) => provider.id !== selectedProvider?.id),
    requiredPermissions,
    disabledReason,
    requiredAction: primary?.requiredAction ?? null,
    freshness: primary?.freshness ?? null,
    selectorRequired,
    approvalRequired,
    routeable: providers.some((provider) => provider.selectable),
    trustTier: primary?.trustTier ?? null,
    rawActions
  }
}

function explainNode(
  node: CapabilityGraphNode,
  generatedAt: string,
  secretsRedacted: boolean
): CapabilityExplanation {
  const nextRepairAction = node.requiredAction ?? repairActionForState(node.availability)
  return {
    featureId: node.featureId,
    state: node.availability,
    summary: `${node.featureId} is ${node.availability}`,
    selectedProvider: node.selectedProvider,
    providerCandidates: node.providers,
    alternateProviders: node.alternateProviders,
    disabledReason: node.disabledReason,
    nextRepairAction,
    selectorRequired: node.selectorRequired,
    approvalRequired: node.approvalRequired,
    routeable: node.routeable,
    requiredPermissions: node.requiredPermissions,
    privacyClass: node.privacyClass,
    evidence: {
      generatedAt,
      secretsRedacted,
      sources: sortedUnique(node.providers.map((provider) => provider.source))
    }
  }
}

function explainMissingFeature(
  featureId: string,
  generatedAt: string,
  secretsRedacted: boolean
): CapabilityExplanation {
  return {
    featureId,
    state: 'unsupported',
    summary: `${featureId} is unsupported`,
    selectedProvider: null,
    providerCandidates: [],
    alternateProviders: [],
    disabledReason: 'No backend, native, or registry evidence exists for this feature',
    nextRepairAction: 'refresh the capability catalog or install/enable a provider',
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    requiredPermissions: [],
    privacyClass: 'public',
    evidence: {
      generatedAt,
      secretsRedacted,
      sources: []
    }
  }
}

function providerIdentityFor(
  providerKind: string,
  peerId: string | null,
  providerId: string
): CapabilityProviderIdentity {
  if (providerKind === 'local') return 'local'
  if (providerKind === 'remote' && peerId) return `remote:${peerId}`
  if (providerKind === 'native') return `native:${providerId.replace(/^native:/, '')}`
  if (providerKind === 'cloud') return 'cloud'
  return providerKind || 'unavailable'
}

function routeabilityForAction(
  action: CapabilityActionInfo,
  provider: CapabilityProviderInfo | undefined
): string {
  if (action.route_blockers.length > 0) return 'blocked'
  if (action.freshness.stale) return 'stale'
  if (provider && !provider.eligible) return provider.reason_code || 'ineligible'
  return action.bindability
}

function requiredActionForAction(
  action: CapabilityActionInfo,
  provider: CapabilityProviderInfo | undefined,
  disabledReasons: string[]
): string | null {
  if (action.freshness.stale) return 'refresh peer manifest or reconnect provider'
  if (action.policy.explicit_selector_required || action.policy.selector_required) return 'choose a peer/provider'
  if (action.policy.approval_required) return 'request approval before execution'
  if (action.policy.consent_required) return 'collect user consent'
  if (action.policy.privacy_indicator_required) return 'show required privacy indicator'
  if (action.policy.denial_reasons.length > 0) return 'change policy, permission, or selected provider'
  if (provider && !provider.eligible) return 'select an eligible provider'
  if (disabledReasons.length > 0) return 'inspect capability blockers'
  return null
}

function availabilityForNode(
  providers: CapabilityProviderCandidate[],
  primary: CapabilityProviderCandidate | null
): AvailabilityState {
  if (providers.some((provider) => provider.availability === 'available-local')) return 'available-local'
  if (providers.some((provider) => provider.availability === 'available-remote')) return 'available-remote'
  if (providers.some((provider) => provider.availability === 'privacy-blocked')) return 'privacy-blocked'
  if (providers.some((provider) => provider.availability === 'pending')) return 'pending'
  if (providers.some((provider) => provider.availability === 'degraded')) return 'degraded'
  if (providers.some((provider) => provider.availability === 'stale')) return 'stale'
  if (providers.some((provider) => provider.availability === 'denied')) return 'denied'
  return primary?.availability ?? 'unsupported'
}

function isSelectable(availability: AvailabilityState): boolean {
  return availability === 'available-local' || availability === 'available-remote' || availability === 'degraded'
}

function compareCandidates(a: CapabilityProviderCandidate, b: CapabilityProviderCandidate): number {
  return (
    availabilityRank(a.availability) - availabilityRank(b.availability) ||
    providerRank(a.providerIdentity) - providerRank(b.providerIdentity) ||
    a.providerId.localeCompare(b.providerId)
  )
}

function availabilityRank(availability: AvailabilityState): number {
  switch (availability) {
    case 'available-local':
      return 0
    case 'available-remote':
      return 1
    case 'degraded':
      return 2
    case 'privacy-blocked':
      return 3
    case 'pending':
      return 4
    case 'stale':
      return 5
    case 'denied':
      return 6
    case 'unsupported':
      return 7
  }
}

function providerRank(identity: CapabilityProviderIdentity): number {
  if (identity === 'local') return 0
  if (identity.startsWith('remote:')) return 1
  if (identity.startsWith('native:')) return 2
  if (identity === 'cloud') return 3
  if (identity === 'blocked') return 4
  return 5
}

function kindForFeature(featureId: string): CapabilityGraphNode['kind'] {
  if (featureId.startsWith('tool:')) return 'tool'
  if (featureId.startsWith('resource:')) return 'resource'
  if (featureId.startsWith('native:')) return 'native'
  return 'method'
}

function highestPrivacyClass(classes: PrivacyClass[]): PrivacyClass {
  const rank: Record<PrivacyClass, number> = {
    public: 0,
    personal: 1,
    sensitive: 2,
    secret: 3,
    'raw-audio': 4,
    credential: 5,
    'admin-critical': 6
  }
  return classes.reduce<PrivacyClass>(
    (highest, privacyClass) => (rank[privacyClass] > rank[highest] ? privacyClass : highest),
    'public'
  )
}

function privacyClassForMethod(method: MethodDescriptor): PrivacyClass {
  return method.methodType === 'manage' ? 'admin-critical' : 'public'
}

function transportSupportsInternalBus(transportKind: string | null): boolean {
  return transportKind === 'tauri-local' || transportKind === 'mock'
}

function repairActionForState(availability: AvailabilityState): string | null {
  switch (availability) {
    case 'privacy-blocked':
      return 'complete selector, consent, approval, or privacy requirements'
    case 'denied':
      return 'adjust permissions or policy'
    case 'stale':
      return 'refresh provider state'
    case 'pending':
      return 'wait for backend approval or completion'
    case 'degraded':
      return 'inspect fallback and capacity warnings'
    case 'unsupported':
      return 'install, enable, or expose a provider'
    default:
      return null
  }
}

function emptyFreshness(source: string) {
  return {
    source,
    manifest_time: null,
    last_probe_age_s: null,
    ttl_s: null,
    stale: false,
    registry_digest: ''
  }
}

function normalizeIndex(index: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(index).map(([key, value]) => [key, [...value].sort()]))
}

function addCandidate(
  map: Map<string, CapabilityProviderCandidate[]>,
  candidate: CapabilityProviderCandidate
): void {
  const existing = map.get(candidate.featureId) ?? []
  existing.push(candidate)
  map.set(candidate.featureId, existing)
}

function addRawAction(
  map: Map<string, CapabilityActionInfo[]>,
  featureId: string,
  action: CapabilityActionInfo
): void {
  const existing = map.get(featureId) ?? []
  existing.push(action)
  map.set(featureId, existing)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}
