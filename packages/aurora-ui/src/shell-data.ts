import type {
  AuroraClient,
  AuroraError,
  AndroidAssistantRoleStatus,
  AndroidFallbackEntrypoint,
  AndroidNativeReleaseStatus,
  AvailabilityState,
  CapabilityExplanation,
  CapabilityGraph,
  CapabilityProviderCandidate,
  NativeCapabilityManifest,
  NativeEntrypoint,
  NativeMobileIntegration,
  NativePlatformLimitation
} from '@aurora/client'
import {
  auroraAssistantCancellationItem,
  auroraAssistantVoiceItems,
  auroraNavSections,
  navItemSnapshot,
  type AuroraNavItem,
  type AuroraNavItemSnapshot
} from './nav'

export type ShellLoadState = 'loading' | 'ready' | 'error'

export interface RouteAvailability {
  item: AuroraNavItemSnapshot
  state: AvailabilityState
  explanation: string
  providerLabel: string
  blockers: string[]
  repairActions: RepairAction[]
  candidateProviders: RouteProviderCandidate[]
  evidenceSources: string[]
  selectorRequired: boolean
  approvalRequired: boolean
  routeable: boolean
  disabled: boolean
  requiresAdminAction: boolean
}

export interface RepairAction {
  id: string
  label: string
  href: string
  disabled: boolean
  reason: string
}

export interface RouteProviderCandidate {
  id: string
  label: string
  state: AvailabilityState
  selectable: boolean
  reason: string
  requiredAction: string | null
}

export interface AuroraShellSnapshot {
  loadState: ShellLoadState
  nodeName: string
  localPeerId: string | null
  transportKind: string
  evidenceSource: string
  generatedAt: string | null
  secretsRedacted: boolean
  routeCount: number
  availableCount: number
  blockedCount: number
  nativePlatform: string
  nativeAvailable: boolean
  nativePermissions: Array<{ name: string; granted: boolean; nativeState: string | null }>
  nativeCapabilities: Array<{ name: string; enabled: boolean; nativeState: string | null }>
  nativeMobileIntegrations: NativeMobileIntegration[]
  nativePlatformLimitations: NativePlatformLimitation[]
  nativeAssistantRole: AndroidAssistantRoleStatus | null
  nativeFallbackEntrypoints: AndroidFallbackEntrypoint[]
  nativeEntrypoints: NativeEntrypoint[]
  nativeRelease: AndroidNativeReleaseStatus | null
  routes: RouteAvailability[]
  assistantCancellationRoute: RouteAvailability | null
  assistantVoiceRoutes: AssistantVoiceRoutes
  error: string | null
}

export interface AssistantVoiceRoutes {
  transcription: RouteAvailability
  wakeProcess: RouteAvailability
  wakeControl: RouteAvailability
  ttsSynthesize: RouteAvailability
  ttsStop: RouteAvailability
}

export const loadingShellSnapshot: AuroraShellSnapshot = {
  loadState: 'loading',
  nodeName: 'Loading Aurora',
  localPeerId: null,
  transportKind: 'pending',
  evidenceSource: 'pending SDK request',
  generatedAt: null,
  secretsRedacted: true,
  routeCount: 0,
  availableCount: 0,
  blockedCount: 0,
  nativePlatform: 'unknown',
  nativeAvailable: false,
  nativePermissions: [],
  nativeCapabilities: [],
  nativeMobileIntegrations: [],
  nativePlatformLimitations: [],
  nativeAssistantRole: null,
  nativeFallbackEntrypoints: [],
  nativeEntrypoints: [],
  nativeRelease: null,
  routes: [],
  assistantCancellationRoute: null,
  assistantVoiceRoutes: emptyAssistantVoiceRoutes(),
  error: null
}

export async function buildShellSnapshot(client: AuroraClient): Promise<AuroraShellSnapshot> {
  try {
    const [graph, native] = await Promise.all([
      client.capabilities.getGraph({ include_unavailable: true, include_internal: true }),
      client.native.getManifest().catch(() => null)
    ])
    return snapshotFromGraph(client.transport.kind, graph, native)
  } catch (error) {
    return errorShellSnapshot(client.transport.kind, error)
  }
}

export function snapshotFromGraph(
  transportKind: string,
  graph: CapabilityGraph,
  native: NativeCapabilityManifest | null
): AuroraShellSnapshot {
  const routes = auroraNavSections.flatMap((section) =>
    section.items.map((item) => routeAvailability(item, graph.explain(featureIdForNavItem(item)), native))
  )
  const assistantCancellationRoute = routeAvailability(
    auroraAssistantCancellationItem,
    graph.explain(featureIdForNavItem(auroraAssistantCancellationItem)),
    native
  )
  const assistantVoiceRoutes = assistantVoiceRoutesFromGraph(graph, native)
  return {
    loadState: 'ready',
    nodeName: graph.localNodeName || 'Aurora node',
    localPeerId: graph.localPeerId,
    transportKind,
    evidenceSource: transportKind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response',
    generatedAt: graph.generatedAt,
    secretsRedacted: graph.secretsRedacted,
    routeCount: routes.length,
    availableCount: routes.filter((route) => !route.disabled).length,
    blockedCount: routes.filter((route) => route.disabled).length,
    nativePlatform: native?.platform ?? 'not available',
    nativeAvailable: native !== null,
    nativePermissions: nativePermissionEntries(native?.permissions, native?.permissionStates),
    nativeCapabilities: nativeCapabilityEntries(native?.capabilities, native?.capabilityStates),
    nativeMobileIntegrations: native?.mobileIntegrations ?? [],
    nativePlatformLimitations: native?.platformLimitations ?? [],
    nativeAssistantRole: native?.assistantRole ?? null,
    nativeFallbackEntrypoints: native?.fallbackEntrypoints ?? [],
    nativeEntrypoints: native?.entrypoints ?? [],
    nativeRelease: native?.release ?? null,
    routes,
    assistantCancellationRoute,
    assistantVoiceRoutes,
    error: null
  }
}

export function errorShellSnapshot(transportKind: string, error: unknown): AuroraShellSnapshot {
  const routes = auroraNavSections.flatMap((section) =>
    section.items.map((item) => ({
      item: navItemSnapshot(item),
      state: 'unsupported' as const,
      explanation: 'Capability state could not be loaded from AuroraClient.',
      providerLabel: 'No backend evidence',
        blockers: ['sdk_error'],
        repairActions: [repairAction('retry', 'Retry SDK request', '/', true, 'The shell needs a fresh AuroraClient response.')],
        candidateProviders: [],
        evidenceSources: ['AuroraClient error'],
        selectorRequired: false,
        approvalRequired: false,
        routeable: false,
        disabled: true,
        requiresAdminAction: item.methodType === 'manage'
      }))
  )
  const assistantCancellationRoute: RouteAvailability = {
    item: navItemSnapshot(auroraAssistantCancellationItem),
    state: 'unsupported',
    explanation: 'Capability state could not be loaded from AuroraClient.',
    providerLabel: 'No backend evidence',
    blockers: ['sdk_error'],
    repairActions: [repairAction('retry', 'Retry SDK request', '/', true, 'The shell needs a fresh AuroraClient response.')],
    candidateProviders: [],
    evidenceSources: ['AuroraClient error'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: false
  }
  const assistantVoiceRoutes = errorAssistantVoiceRoutes()
  return {
    ...loadingShellSnapshot,
    loadState: 'error',
    nodeName: 'Aurora unavailable',
    transportKind,
    evidenceSource: 'AuroraClient error',
    routeCount: routes.length,
    blockedCount: routes.length,
    error: errorMessage(error),
    routes,
    assistantCancellationRoute,
    assistantVoiceRoutes
  }
}

function assistantVoiceRoutesFromGraph(
  graph: CapabilityGraph,
  native: NativeCapabilityManifest | null
): AssistantVoiceRoutes {
  return {
    transcription: routeAvailability(
      auroraAssistantVoiceItems.transcription,
      graph.explain(featureIdForNavItem(auroraAssistantVoiceItems.transcription)),
      native
    ),
    wakeProcess: routeAvailability(
      auroraAssistantVoiceItems.wakeProcess,
      graph.explain(featureIdForNavItem(auroraAssistantVoiceItems.wakeProcess)),
      native
    ),
    wakeControl: routeAvailability(
      auroraAssistantVoiceItems.wakeControl,
      graph.explain(featureIdForNavItem(auroraAssistantVoiceItems.wakeControl)),
      native
    ),
    ttsSynthesize: routeAvailability(
      auroraAssistantVoiceItems.ttsSynthesize,
      graph.explain(featureIdForNavItem(auroraAssistantVoiceItems.ttsSynthesize)),
      native
    ),
    ttsStop: routeAvailability(
      auroraAssistantVoiceItems.ttsStop,
      graph.explain(featureIdForNavItem(auroraAssistantVoiceItems.ttsStop)),
      native
    )
  }
}

function emptyAssistantVoiceRoutes(): AssistantVoiceRoutes {
  return unsupportedAssistantVoiceRoutes('pending SDK request')
}

function errorAssistantVoiceRoutes(): AssistantVoiceRoutes {
  return unsupportedAssistantVoiceRoutes('AuroraClient error')
}

function unsupportedAssistantVoiceRoutes(evidence: string): AssistantVoiceRoutes {
  return {
    transcription: unsupportedVoiceRoute(auroraAssistantVoiceItems.transcription, evidence),
    wakeProcess: unsupportedVoiceRoute(auroraAssistantVoiceItems.wakeProcess, evidence),
    wakeControl: unsupportedVoiceRoute(auroraAssistantVoiceItems.wakeControl, evidence),
    ttsSynthesize: unsupportedVoiceRoute(auroraAssistantVoiceItems.ttsSynthesize, evidence),
    ttsStop: unsupportedVoiceRoute(auroraAssistantVoiceItems.ttsStop, evidence)
  }
}

function unsupportedVoiceRoute(item: AuroraNavItem, evidence: string): RouteAvailability {
  return {
    item: navItemSnapshot(item),
    state: item.fallbackState,
    explanation: 'Voice capability state could not be loaded from AuroraClient.',
    providerLabel: `${item.expectedTask} pending`,
    blockers: ['sdk_error'],
    repairActions: [repairAction('retry', 'Retry SDK request', '/', true, 'The shell needs a fresh AuroraClient response.')],
    candidateProviders: [],
    evidenceSources: [evidence],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: item.methodType === 'manage'
  }
}

function routeAvailability(
  item: AuroraNavItem,
  explanation: CapabilityExplanation,
  native: NativeCapabilityManifest | null
): RouteAvailability {
  if (item.capabilityModule === 'Native') return nativeRouteAvailability(item, native)
  const state = graphStateForItem(item, explanation)
  const blockers = sortedUnique([
    explanation.disabledReason,
    ...explanation.providerCandidates.flatMap((provider) => provider.disabledReasons),
    ...(!explanation.routeable && explanation.providerCandidates.length === 0 ? ['capability_not_advertised'] : [])
  ])
  const repairActions = repairActionsFor(item, explanation, blockers)
  const disabled = !['available-local', 'available-remote', 'degraded'].includes(state)
  return {
    item: navItemSnapshot(item),
    state,
    explanation: routeExplanation(state, explanation),
    providerLabel: providerLabel(explanation, item),
    blockers,
    repairActions,
    candidateProviders: explanation.providerCandidates.map(candidateForRoute),
    evidenceSources: explanation.evidence.sources,
    selectorRequired: explanation.selectorRequired,
    approvalRequired: explanation.approvalRequired,
    routeable: explanation.routeable,
    disabled,
    requiresAdminAction: item.methodType === 'manage'
  }
}

function routeExplanation(state: AvailabilityState, explanation: CapabilityExplanation): string {
  if (explanation.providerCandidates.length === 0) {
    return 'No executable capability catalog entry exists yet; the route stays visible with a repair task.'
  }
  if (state === 'available-local') return 'Backend catalog reports a local provider that can serve this route.'
  if (state === 'available-remote') return 'Backend catalog reports a remote provider; target identity must remain visible.'
  if (state === 'degraded') return 'The route is partially usable with backend-reported limitations.'
  if (state === 'pending') return 'The route is waiting on pairing, approval, consent, or an in-flight backend correlation.'
  if (state === 'denied') return 'Backend policy denied this route for the current principal or peer.'
  if (state === 'stale') return 'Provider evidence is stale and cannot be used for execution.'
  if (state === 'privacy-blocked') return 'A selector, consent, privacy indicator, or approval is required before use.'
  return 'The route is unsupported in this backend or deployment mode.'
}

function providerLabel(explanation: CapabilityExplanation, item: AuroraNavItem): string {
  const provider = explanation.selectedProvider ?? explanation.providerCandidates[0]
  if (!provider) return `${item.expectedTask} pending`
  return `${provider.providerIdentity} / ${provider.module}.${provider.method}`
}

function graphStateForItem(item: AuroraNavItem, explanation: CapabilityExplanation): AvailabilityState {
  if (explanation.providerCandidates.length === 0) return item.fallbackState
  return explanation.state
}

function featureIdForNavItem(item: AuroraNavItem): string {
  return `method:${item.capabilityModule}.${item.capabilityMethod}`
}

function nativeRouteAvailability(
  item: AuroraNavItem,
  native: NativeCapabilityManifest | null
): RouteAvailability {
  const missingPermissions = Object.entries(native?.permissions ?? {})
    .filter(([, granted]) => !granted)
    .map(([permission]) => permission)
  const enabledCapabilities = Object.entries(native?.capabilities ?? {})
    .filter(([, enabled]) => enabled)
    .map(([capability]) => capability)
  const state: AvailabilityState = !native
    ? 'unsupported'
    : missingPermissions.length > 0
      ? 'privacy-blocked'
      : enabledCapabilities.length > 0
        ? 'available-local'
        : 'unsupported'
  const blockers = native
    ? missingPermissions.map((permission) => `native permission missing: ${permission}`)
    : ['native_manifest_missing']
  const base: CapabilityExplanation = {
    featureId: `native:${native?.platform ?? 'unknown'}`,
    state,
    summary: `native manifest is ${state}`,
    selectedProvider: null,
    providerCandidates: [],
    alternateProviders: [],
    disabledReason: blockers[0] ?? null,
    nextRepairAction: state === 'privacy-blocked' ? 'grant required native permission' : 'enable native capability in manifest',
    selectorRequired: false,
    approvalRequired: false,
    routeable: state === 'available-local',
    requiredPermissions: missingPermissions,
    privacyClass: item.privacyClass,
    evidence: {
      generatedAt: nullToPending(native ? new Date(0).toISOString() : null),
      secretsRedacted: true,
      sources: native ? ['native-manifest'] : []
    }
  }
  return {
    item: navItemSnapshot(item),
    state,
    explanation: native
      ? 'SDK native manifest reports platform capabilities and permission gates.'
      : 'No native manifest was reported by the SDK for this deployment mode.',
    providerLabel: native ? `native:${native.platform}` : `${item.expectedTask} pending`,
    blockers,
    repairActions: repairActionsFor(item, base, blockers),
    candidateProviders: enabledCapabilities.map((capability) => ({
      id: `native:${native?.platform}:${capability}`,
      label: `native:${native?.platform} / ${capability}`,
      state,
      selectable: state === 'available-local',
      reason: missingPermissions.join(', ') || 'native-manifest',
      requiredAction: state === 'available-local' ? null : 'grant required native permission'
    })),
    evidenceSources: native ? ['native-manifest'] : [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: state === 'available-local',
    disabled: !['available-local', 'available-remote', 'degraded'].includes(state),
    requiresAdminAction: item.methodType === 'manage'
  }
}

function candidateForRoute(candidate: CapabilityProviderCandidate): RouteProviderCandidate {
  return {
    id: candidate.id,
    label: `${candidate.providerIdentity} / ${candidate.module}.${candidate.method}`,
    state: candidate.availability,
    selectable: candidate.selectable,
    reason: candidate.disabledReasons.join(', ') || candidate.routeability,
    requiredAction: candidate.requiredAction
  }
}

function repairActionsFor(
  item: AuroraNavItem,
  explanation: CapabilityExplanation,
  blockers: string[]
): RepairAction[] {
  const actionIds = new Set<string>()
  const actions: RepairAction[] = []
  const add = (action: RepairAction) => {
    if (actionIds.has(action.id)) return
    actionIds.add(action.id)
    actions.push(action)
  }

  const blockerText = blockers.join(' ').toLowerCase()
  const repairText = (explanation.nextRepairAction ?? '').toLowerCase()

  if (blockerText.includes('auth') || blockerText.includes('permission') || explanation.requiredPermissions.length > 0) {
    add(repairAction('authenticate', 'Authenticate', '/onboarding', Boolean(item.adminGated), 'Current principal or session lacks required backend permission evidence.'))
    add(repairAction('grant-permission', 'Grant permission', '/admin/access', !Boolean(item.adminGated), 'Required permissions must be granted through admin access controls.'))
  }
  if (blockerText.includes('peer') || blockerText.includes('pair') || blockerText.includes('stale')) {
    add(repairAction('pair', 'Pair or reconnect peer', '/admin/pairing', false, 'Peer trust or freshness must be restored before this feature can run.'))
  }
  if (blockerText.includes('service') || blockerText.includes('provider') || blockerText.includes('capability_not_advertised')) {
    add(repairAction('start-service', 'Start service', '/admin/services', Boolean(item.adminGated), 'The required service/provider is not currently advertised as executable.'))
  }
  if (explanation.selectorRequired || repairText.includes('selector') || repairText.includes('route')) {
    add(repairAction('configure-route', 'Configure route', '/mesh', false, 'A backend-accepted selector or route policy is required.'))
  }
  if (blockerText.includes('native') || item.capabilityModule === 'Native') {
    add(repairAction('grant-native', 'Grant native permission', '/settings/native', false, 'Native manifest or platform permission evidence is missing.'))
  }
  if (item.id === 'plugins' || item.id === 'tools' || blockerText.includes('plugin')) {
    add(repairAction('install-plugin', 'Install plugin', '/admin/plugins', Boolean(item.adminGated), 'Plugin/tool catalog support must be installed and enabled.'))
  }
  if (actions.length === 0 && explanation.nextRepairAction) {
    add(repairAction('inspect', 'Inspect blocker', item.href, true, explanation.nextRepairAction))
  }
  if (actions.length === 0) {
    add(repairAction('wait', 'Await backend contract', item.href, true, `${item.expectedTask} owns this production wiring.`))
  }
  return actions
}

function repairAction(
  id: string,
  label: string,
  href: string,
  disabled: boolean,
  reason: string
): RepairAction {
  return { id, label, href, disabled, reason }
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
}

function nativePermissionEntries(
  values: Record<string, boolean> | undefined,
  states: Record<string, string> | undefined
): Array<{ name: string; granted: boolean; nativeState: string | null }> {
  return Object.entries(values ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, granted]) => ({ name, granted, nativeState: states?.[name] ?? null }))
}

function nativeCapabilityEntries(
  values: Record<string, boolean> | undefined,
  states: Record<string, string> | undefined
): Array<{ name: string; enabled: boolean; nativeState: string | null }> {
  return Object.entries(values ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, enabled]) => ({ name, enabled, nativeState: states?.[name] ?? null }))
}

function nullToPending(value: string | null): string {
  return value ?? 'pending'
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
}
