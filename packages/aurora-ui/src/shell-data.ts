import type {
  AuroraClient,
  AndroidAssistantRoleStatus,
  AndroidFallbackEntrypoint,
  AndroidNativeReleaseStatus,
  AvailabilityState,
  CapabilityExplanation,
  CapabilityGraph,
  CapabilityProviderCandidate,
  NativeCapabilityManifest,
  NativeEntrypoint,
  NativeDeviceMatrixRow,
  NativeMobileIntegration,
  NativePlatformIntegration,
  NativePlatformLimitation,
  NativeReleaseGate
} from '@aurora/client'
import {
  auroraAssistantCancellationItem,
  auroraAssistantVoiceItems,
  auroraEmbeddedNavItems,
  auroraNavSections,
  navItemSnapshot,
  type AuroraNavItem,
  type AuroraNavItemSnapshot
} from './nav'
import {
  isBrowserWebRtcConfigured,
  isBrowserWebRtcConnected,
  type BrowserWebRtcSnapshot,
} from './web-thin-runtime'
import { safeErrorCopy } from './product-copy'
import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'

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
  providerId?: string
  providerKind?: string
  peerId?: string | null
  nodeName?: string | null
  serviceInstanceId?: string | null
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
  nativePlatformIntegrations: NativePlatformIntegration[]
  nativeReleaseGates: NativeReleaseGate[]
  nativeDeviceMatrix: NativeDeviceMatrixRow[]
  nativePolicyNotes: string[]
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
  nativePlatformIntegrations: [],
  nativeReleaseGates: [],
  nativeDeviceMatrix: [],
  nativePolicyNotes: [],
  routes: [],
  assistantCancellationRoute: null,
  assistantVoiceRoutes: emptyAssistantVoiceRoutes(),
  error: null
}

export async function buildShellSnapshot(
  client: AuroraClient,
  options: {
    nativeManifest?: (() => Promise<NativeCapabilityManifest>) | undefined
  } = {}
): Promise<AuroraShellSnapshot> {
  try {
    const [graph, native] = await Promise.all([
      client.capabilities.getGraph({ include_unavailable: true, include_internal: true }),
      (options.nativeManifest?.() ?? client.native.getManifest()).catch(() => null)
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
  const routes = allShellRouteItems().map((item) => routeAvailability(item, graph.explain(featureIdForNavItem(item)), native))
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
    evidenceSource: transportKind === 'mock' ? 'Local transport' : 'Aurora service response',
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
    nativePlatformIntegrations: [...(native?.platformIntegrations ?? [])],
    nativeReleaseGates: [...(native?.releaseGates ?? [])],
    nativeDeviceMatrix: [...(native?.deviceMatrix ?? [])],
    nativePolicyNotes: [...(native?.policyNotes ?? [])],
    routes,
    assistantCancellationRoute,
    assistantVoiceRoutes,
    error: null
  }
}


function allShellRouteItems(): AuroraNavItem[] {
  return [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems]
}

export function errorShellSnapshot(transportKind: string, error: unknown): AuroraShellSnapshot {
  const routes = allShellRouteItems().map((item) => ({
    item: navItemSnapshot(item),
    state: 'unsupported' as const,
    explanation: 'Capability state could not be loaded from Aurora.',
    providerLabel: 'Select runtime',
    blockers: ['sdk_error'],
    repairActions: [repairAction('retry', 'Retry connection', '/', true, 'The shell needs a fresh Aurora response.')],
    candidateProviders: [],
    evidenceSources: ['Aurora service error'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: item.methodType === 'manage'
  }))
  const assistantCancellationRoute: RouteAvailability = {
    item: navItemSnapshot(auroraAssistantCancellationItem),
    state: 'unsupported',
    explanation: 'Capability state could not be loaded from Aurora.',
    providerLabel: 'Select runtime',
    blockers: ['sdk_error'],
    repairActions: [repairAction('retry', 'Retry connection', '/', true, 'The shell needs a fresh Aurora response.')],
    candidateProviders: [],
    evidenceSources: ['Aurora service error'],
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
    evidenceSource: 'Aurora service error',
    routeCount: routes.length,
    blockedCount: routes.length,
    error: shellErrorMessage(error),
    routes,
    assistantCancellationRoute,
    assistantVoiceRoutes
  }
}

/**
 * Keep the last redacted capability graph visible while a configured thin peer
 * is offline. Routes are deliberately made stale/non-callable, but provider
 * identities remain visible so an outage is not misrepresented as an empty
 * deployment or disabled WebRTC runtime.
 */
export function retainThinShellSnapshot(
  current: AuroraShellSnapshot,
  next: AuroraShellSnapshot,
  peer: BrowserWebRtcSnapshot | null | undefined,
): AuroraShellSnapshot {
  if (next.loadState !== 'error' || !isBrowserWebRtcConfigured(peer)) return next
  if (isBrowserWebRtcConnected(peer)) return next

  const hasLastKnownGraph =
    current.routes.length > 0
    && (
      current.loadState === 'ready'
      || current.routes.some((route) => route.candidateProviders.length > 0)
    )
  const base = hasLastKnownGraph ? current : next
  const peerLabel = peer.nodeName?.trim() || peer.expectedStablePeerId || 'Invited Aurora peer'
  const retainRoute = (route: RouteAvailability): RouteAvailability => ({
    ...route,
    state: 'stale',
    explanation: hasLastKnownGraph
      ? `Last-known capability data is retained while ${peerLabel} is offline.`
      : `${peerLabel} is offline. Capability providers will appear when this peer or another trusted mesh route reconnects.`,
    blockers: sortedUnique([...route.blockers, 'thin_peer_offline']),
    candidateProviders: route.candidateProviders.map((candidate) => ({
      ...candidate,
      state: 'stale' as const,
      selectable: false,
      reason: `Last-known provider; ${peerLabel} is offline.`,
    })),
    routeable: false,
    disabled: true,
  })
  const routes = base.routes.map(retainRoute)
  const assistantCancellationRoute = base.assistantCancellationRoute
    ? retainRoute(base.assistantCancellationRoute)
    : null
  const assistantVoiceRoutes: AssistantVoiceRoutes = {
    transcription: retainRoute(base.assistantVoiceRoutes.transcription),
    wakeProcess: retainRoute(base.assistantVoiceRoutes.wakeProcess),
    wakeControl: retainRoute(base.assistantVoiceRoutes.wakeControl),
    ttsSynthesize: retainRoute(base.assistantVoiceRoutes.ttsSynthesize),
    ttsStop: retainRoute(base.assistantVoiceRoutes.ttsStop),
  }

  return {
    ...base,
    loadState: 'error',
    nodeName: peerLabel,
    transportKind: 'mesh',
    evidenceSource: hasLastKnownGraph
      ? 'Last saved device state'
      : 'Saved device connection',
    secretsRedacted: true,
    routeCount: routes.length,
    availableCount: 0,
    blockedCount: routes.length,
    routes,
    assistantCancellationRoute,
    assistantVoiceRoutes,
    error: null,
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
  return unsupportedAssistantVoiceRoutes('Aurora service error')
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
    explanation: 'Voice setup could not be loaded.',
    providerLabel: pendingFeatureLabel(item),
    blockers: ['sdk_error'],
    repairActions: [repairAction('retry', 'Try again', '/', true, 'Aurora needs a fresh response.')],
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
  const state = graphStateForExplanation(explanation, item.fallbackState)
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
    return 'This feature is not available yet. Review setup to finish it.'
  }
  if (state === 'available-local') return 'This device can handle this.'
  if (state === 'available-remote') return 'An approved Aurora device can handle this.'
  if (state === 'degraded') return 'This is available with limited behavior.'
  if (state === 'pending') return 'Waiting for approval or setup to finish.'
  if (state === 'denied') return 'Access is needed before this can be used.'
  if (state === 'stale') return 'Device information is out of date. Reconnect and try again.'
  if (state === 'privacy-blocked') return 'Review access before using this.'
  return 'This feature is not available here yet.'
}

function providerLabel(explanation: CapabilityExplanation, item: AuroraNavItem): string {
  const provider = explanation.selectedProvider ?? explanation.providerCandidates[0]
  if (!provider) return pendingFeatureLabel(item)
  return safeDisplayCopy(providerSourceLabel(provider), providerFallbackLabel(provider))
}

function graphStateForExplanation(
  explanation: CapabilityExplanation,
  fallbackState: AvailabilityState
): AvailabilityState {
  if (explanation.providerCandidates.length > 0) return explanation.state
  return nonAvailableStateForMissingEvidence(explanation.state, fallbackState)
}

function nonAvailableStateForMissingEvidence(
  state: AvailabilityState,
  fallbackState: AvailabilityState
): AvailabilityState {
  if (isAvailableRouteState(state)) return 'unsupported'
  if (state === 'unsupported' && fallbackState === 'privacy-blocked') return 'privacy-blocked'
  return state
}

function isAvailableRouteState(state: AvailabilityState): boolean {
  return ['available-local', 'available-remote', 'degraded'].includes(state)
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
    nextRepairAction: state === 'privacy-blocked' ? 'grant required device access' : 'enable device feature',
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
      ? 'Device features and access are available from this app.'
      : 'Device features are not available here yet.',
    providerLabel: native ? 'This device' : pendingFeatureLabel(item),
    blockers,
    repairActions: repairActionsFor(item, base, blockers),
    candidateProviders: enabledCapabilities.map((capability) => ({
      id: `native:${native?.platform}:${capability}`,
      label: safeDisplayCopy(capability, 'This device'),
      state,
      selectable: state === 'available-local',
      reason: safeRouteReason(missingPermissions.join(', '), 'Review device access before using this.'),
      requiredAction: state === 'available-local' ? null : 'Review device access'
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
    providerId: candidate.providerId,
    providerKind: candidate.providerKind,
    peerId: candidate.peerId,
    nodeName: candidate.nodeName ?? null,
    serviceInstanceId: candidate.serviceInstanceId,
    label: safeDisplayCopy(providerSourceLabel(candidate), providerFallbackLabel(candidate)),
    state: candidate.availability,
    selectable: candidate.selectable,
    reason: safeRouteReason(candidate.disabledReasons.join(', ') || candidate.routeability),
    requiredAction: candidate.requiredAction ? safeRouteReason(candidate.requiredAction, 'Review setup') : null
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
    add(repairAction('authenticate', 'Sign in', '/onboarding', Boolean(item.adminGated), 'Sign in or review access for this feature.'))
    add(repairAction('grant-permission', 'Review access', '/admin/access', !Boolean(item.adminGated), 'An administrator can update access for this feature.'))
  }
  if (blockerText.includes('peer') || blockerText.includes('pair') || blockerText.includes('stale')) {
    add(repairAction('pair', 'Reconnect device', '/admin/pairing', false, 'Reconnect an approved Aurora device before using this.'))
  }
  if (blockerText.includes('service') || blockerText.includes('provider') || blockerText.includes('capability_not_advertised')) {
    add(repairAction('start-service', 'Turn on feature', '/admin/services', Boolean(item.adminGated), 'Turn on the needed Aurora feature before continuing.'))
  }
  if (explanation.selectorRequired || repairText.includes('selector') || repairText.includes('route')) {
    add(repairAction('configure-route', 'Choose device', '/mesh', false, 'Choose which approved device should handle this.'))
  }
  if (blockerText.includes('native') || item.capabilityModule === 'Native') {
    add(repairAction('grant-native', 'Review device access', '/settings/native', false, 'Review device access before using this.'))
  }
  if (item.id === 'plugins' || item.id === 'tools' || blockerText.includes('plugin')) {
    add(repairAction('install-plugin', 'Add tool', '/admin/plugins', Boolean(item.adminGated), 'Add or turn on the tool before using this.'))
  }
  if (actions.length === 0 && explanation.nextRepairAction) {
    add(repairAction('inspect', 'Review setup', item.href, true, safeRouteReason(explanation.nextRepairAction)))
  }
  if (actions.length === 0) {
    add(repairAction('wait', 'Review setup', item.href, true, `${item.label} needs more setup before it can be used.`))
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

function shellErrorMessage(error: unknown): string {
  return safeErrorCopy(error).title
}

function pendingFeatureLabel(item: AuroraNavItem): string {
  return `${item.label} needs setup`
}

function providerSourceLabel(provider: Pick<CapabilityProviderCandidate, 'providerIdentity' | 'module' | 'method'>): string {
  return `${provider.providerIdentity} / ${provider.module}.${provider.method}`
}

function providerFallbackLabel(provider: Pick<CapabilityProviderCandidate, 'providerKind' | 'nodeName' | 'peerId' | 'providerIdentity'>): string {
  if (provider.providerKind === 'local') return 'This device'
  if (provider.nodeName?.trim()) return compactDisplayText(provider.nodeName)
  if (provider.peerId) return 'Connected Aurora device'
  return safeDisplayCopy(provider.providerIdentity, 'Aurora source')
}

function safeDisplayCopy(value: string | null | undefined, fallback: string): string {
  const compact = compactDisplayText(value)
  if (!compact) return fallback
  return findForbiddenProductionCopyTerms(compact).length > 0 ? fallback : compact
}

function safeRouteReason(value: string | null | undefined, fallback = 'Review setup before continuing.'): string {
  const compact = compactDisplayText(value)
  if (!compact) return fallback
  if (findForbiddenProductionCopyTerms(compact).length === 0) return compact
  const normalized = compact.toLowerCase()
  if (/\b(auth|permission|denied|forbidden|unauthorized)\b/u.test(normalized)) {
    return 'Review access before using this.'
  }
  if (/\b(peer|pair|stale|offline|freshness)\b/u.test(normalized)) {
    return 'Reconnect an approved Aurora device before using this.'
  }
  if (/\b(selector|route)\b/u.test(normalized)) {
    return 'Choose which approved device should handle this.'
  }
  if (/\b(native|microphone|camera|notification|biometric)\b/u.test(normalized)) {
    return 'Review device access before using this.'
  }
  if (/\b(service|provider|capability|catalog|contract)\b/u.test(normalized)) {
    return 'Turn on the needed Aurora feature before continuing.'
  }
  return fallback
}

function compactDisplayText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/gu, ' ') ?? ''
}
