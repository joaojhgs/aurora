import { privacyClassForAction } from './capabilities.js'
import type {
  ApprovalScope,
  AvailabilityState,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  CapabilityPolicyDecisionInfo,
  PrivacyClass,
  RouteBlockerInfo,
  RouteCandidateDecision,
  RouteExplainResponse,
  RoutePolicyEvaluation,
  RoutePolicyInput,
  RoutePreview
} from './types.js'

const HIGH_PRIVACY_CLASSES: PrivacyClass[] = ['sensitive', 'secret', 'raw-audio', 'credential', 'admin-critical']
const DEFAULT_SECRET_KEYS = [
  'api_key',
  'apikey',
  'authorization',
  'confirmation_token',
  'credential',
  'password',
  'secret',
  'token'
]

export function evaluateRoutePolicy(input: RoutePolicyInput): RoutePolicyEvaluation {
  const catalogAction = findCatalogAction(input)
  const policy = catalogAction?.policy
  const provider = findSelectedCandidate(input.route)
  const privacyClass = input.privacyClass ?? classifyPayloadPrivacy(input.payload, policy, catalogAction)
  const dataClasses = unique([privacyClass, ...(input.dataClasses ?? [])])
  const securityBlockers = [
    ...input.route.security_privacy_blockers,
    ...input.route.blockers.filter((blocker) => blocker.security_privacy)
  ]
  const policyBlockers = collectPolicyBlockers(input, policy, catalogAction, privacyClass)
  const blockers = uniqueBlockers([
    ...input.route.blockers,
    ...securityBlockers,
    ...policyBlockers
  ])
  const selectedTarget = input.route.selected_target || (provider ? provider.provider_kind : 'none')
  const fallbackBlocked = isFallbackBlocked(input.route, input.allowCloudFallback ?? false)
  const missingSelector = !input.route.selector_valid || blockers.some((blocker) => isSelectorBlocker(blocker.code))
  const explicitSelectorRequired = Boolean(policy?.explicit_selector_required || policy?.selector_required || missingSelector)
  const approval = evaluateApproval(input, policy, catalogAction)
  const allowed =
    blockers.length === 0 &&
    input.route.selector_valid &&
    !fallbackBlocked &&
    approval.status !== 'required' &&
    approval.status !== 'expired' &&
    approval.status !== 'rejected'
  const decision = allowed
    ? 'allowed'
    : blockers.some((blocker) => blocker.security_privacy) || HIGH_PRIVACY_CLASSES.includes(privacyClass) || fallbackBlocked
      ? 'privacy-blocked'
      : 'blocked'

  return {
    decision,
    allowed,
    availability: availabilityForPolicy(decision, input.route, catalogAction),
    reasonCode: reasonCodeFor(decision, input.route, blockers, approval.status),
    repairPath: repairPathFor({ blockers, approvalStatus: approval.status, explicitSelectorRequired, fallbackBlocked }),
    privacyClass,
    dataClasses,
    explicitSelectorRequired,
    approval,
    route: input.route,
    selectedCandidate: provider,
    blockers,
    preview: buildRoutePreview(input, {
      provider,
      privacyClass,
      dataClasses,
      blockers,
      selectedTarget,
      catalogAction
    })
  }
}

export function classifyPayloadPrivacy(
  payload: unknown,
  policy: CapabilityPolicyDecisionInfo | null | undefined = null,
  action: CapabilityActionInfo | null | undefined = null
): PrivacyClass {
  if (policy?.resource_scope === 'credential') return 'credential'
  if (policy?.resource_scope === 'raw-audio') return 'raw-audio'
  if (policy?.operation_class === 'admin' || policy?.safety_class === 'admin') return 'admin-critical'
  if (policy?.safety_class === 'secret') return 'secret'
  if (policy?.safety_class === 'sensitive' || policy?.consent_required || policy?.privacy_indicator_required) {
    return 'sensitive'
  }
  if (action) return privacyClassForAction(action)
  if (containsSecretLikeKey(payload)) return 'secret'
  if (containsPersonalPayload(payload)) return 'personal'
  return 'public'
}

export function buildRoutePreview(
  input: RoutePolicyInput,
  context: {
    provider: RouteCandidateDecision | null
    privacyClass: PrivacyClass
    dataClasses: PrivacyClass[]
    blockers: RouteBlockerInfo[]
    selectedTarget: string
    catalogAction: CapabilityActionInfo | null
  }
): RoutePreview {
  const action = context.catalogAction
  const selector = readSelector(input.route, input.selector)
  return {
    topic: input.route.topic,
    module: input.route.module,
    method: input.method ?? action?.method ?? null,
    providerId: input.route.selected_provider_id ?? context.provider?.provider_id ?? action?.provider_id ?? null,
    peerId: input.route.selected_peer_id ?? context.provider?.peer_id ?? action?.peer_id ?? null,
    serviceInstanceId:
      input.route.selected_service_instance_id ?? context.provider?.service_instance_id ?? action?.service_instance_id ?? null,
    providerKind: context.provider?.provider_kind ?? action?.provider_kind ?? context.selectedTarget,
    trustTier: action?.policy.trust_tier ?? 'unknown',
    transport: input.transportKind ?? null,
    fallbackBehavior: input.route.fallback_behavior,
    egressDestination: egressDestinationFor(context.selectedTarget, context.provider, action),
    expectedPersistence: expectedPersistenceFor(action?.policy),
    auditReceiptTarget: input.auditReceiptTarget ?? auditTargetFor(context.provider, action),
    dataClasses: context.dataClasses,
    privacyClass: context.privacyClass,
    selector,
    payloadPreview: redactPayload(input.payload),
    secretsRedacted: input.route.secrets_redacted,
    blockers: context.blockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      securityPrivacy: blocker.security_privacy
    }))
  }
}

function findCatalogAction(input: RoutePolicyInput): CapabilityActionInfo | null {
  if (!input.catalog) return null
  const topic = input.route.topic || input.topic
  const actionId = input.actionId
  const toolId = input.toolId
  const resourceId = input.resourceId
  return (
    input.catalog.actions.find((action) => actionId && action.action_id === actionId) ??
    input.catalog.actions.find((action) => toolId && action.tool_id === toolId) ??
    input.catalog.actions.find((action) => resourceId && action.resource_id === resourceId) ??
    input.catalog.actions.find((action) => action.topic === topic && matchesSelectedProvider(action, input.route)) ??
    input.catalog.actions.find((action) => action.topic === topic) ??
    null
  )
}

function matchesSelectedProvider(action: CapabilityActionInfo, route: RouteExplainResponse): boolean {
  if (route.selected_provider_id) return action.provider_id === route.selected_provider_id
  if (route.selected_peer_id) return action.peer_id === route.selected_peer_id
  return true
}

function findSelectedCandidate(route: RouteExplainResponse): RouteCandidateDecision | null {
  return (
    route.candidates.find((candidate) => candidate.selected) ??
    route.candidates.find((candidate) => candidate.provider_id === route.selected_provider_id) ??
    route.candidates.find((candidate) => candidate.included) ??
    null
  )
}

function collectPolicyBlockers(
  input: RoutePolicyInput,
  policy: CapabilityPolicyDecisionInfo | null | undefined,
  action: CapabilityActionInfo | null,
  privacyClass: PrivacyClass
): RouteBlockerInfo[] {
  const providerId = input.route.selected_provider_id ?? action?.provider_id ?? null
  const peerId = input.route.selected_peer_id ?? action?.peer_id ?? null
  const blockers: RouteBlockerInfo[] = []
  for (const reason of policy?.denial_reasons ?? []) {
    blockers.push(blocker(reason, `Policy denied this route: ${reason}.`, providerId, peerId, true))
  }
  if (policy?.local_only && isRemoteTarget(input.route, action)) {
    blockers.push(blocker('local_only', 'Policy allows this capability only on the local node.', providerId, peerId, true))
  }
  if ((policy?.explicit_selector_required || policy?.selector_required) && !hasSelector(input)) {
    blockers.push(blocker('explicit_selector_required', 'Select the target peer/resource before execution.', providerId, peerId, true))
  }
  if (policy?.consent_required && !input.consentGranted) {
    blockers.push(blocker('consent_required', 'Consent is required before this payload can leave the local node.', providerId, peerId, true))
  }
  if (policy?.privacy_indicator_required && !input.privacyIndicatorShown) {
    blockers.push(blocker('privacy_indicator_required', 'Show the privacy indicator before execution.', providerId, peerId, true))
  }
  if (HIGH_PRIVACY_CLASSES.includes(privacyClass) && isCloudTarget(input.route) && !input.allowCloudFallback) {
    blockers.push(blocker('cloud_fallback_blocked', 'Cloud fallback is blocked for this privacy class.', providerId, peerId, true))
  }
  return blockers
}

function evaluateApproval(
  input: RoutePolicyInput,
  policy: CapabilityPolicyDecisionInfo | null | undefined,
  action: CapabilityActionInfo | null
): RoutePolicyEvaluation['approval'] {
  if (!policy?.approval_required) return { required: false, status: 'not-required', scopes: [] }
  const now = Date.parse(input.now ?? new Date().toISOString())
  const scopes = input.approvalScopes ?? []
  const matchingScope = scopes.find((scope) => scopeMatches(scope, input, action, now)) ?? null
  if (!matchingScope) {
    const hasExpiredScope = scopes.some((scope) => scope.decision === 'approve' && isExpired(scope, now))
    return { required: true, status: hasExpiredScope ? 'expired' : 'required', scopes }
  }
  if (matchingScope.decision === 'deny' || matchingScope.decision === 'deny-all') {
    return { required: true, status: 'rejected', scopes, matchedScope: matchingScope }
  }
  return { required: true, status: 'approved', scopes, matchedScope: matchingScope }
}

function scopeMatches(scope: ApprovalScope, input: RoutePolicyInput, action: CapabilityActionInfo | null, now: number): boolean {
  if (isExpired(scope, now)) return false
  if (scope.decision === 'deny-all') return true
  if (scope.decision !== 'approve') return false
  if (!scope.scope) return false
  const peerId = input.route.selected_peer_id ?? action?.peer_id ?? null
  const providerId = input.route.selected_provider_id ?? action?.provider_id ?? null
  const toolId = input.toolId ?? action?.tool_id ?? null
  const resourceId = input.resourceId ?? action?.resource_id ?? null

  switch (scope.scope) {
    case 'single':
      return Boolean(
        scope.approvalId &&
        scope.argsHash &&
        input.argsHash &&
        scope.argsHash === input.argsHash &&
        targetMatches(scope, peerId, providerId) &&
        actionIdentityMatches(scope, toolId, resourceId)
      )
    case 'tool-args':
      return Boolean(
        scope.toolId &&
        toolId &&
        scope.toolId === toolId &&
        scope.argsHash &&
        input.argsHash &&
        scope.argsHash === input.argsHash &&
        targetMatches(scope, peerId, providerId)
      )
    case 'peer-provider':
      return Boolean(scope.peerId && scope.providerId && scope.peerId === peerId && scope.providerId === providerId)
    case 'session':
      return Boolean(
        scope.sessionId &&
        input.sessionId &&
        scope.sessionId === input.sessionId &&
        targetMatches(scope, peerId, providerId)
      )
    case 'local-safe-tools':
      return localSafeToolScopeMatches(scope, input, action, toolId, providerId)
    default:
      return false
  }
}

function isExpired(scope: ApprovalScope, now: number): boolean {
  return Boolean(scope.expiresAt && Date.parse(scope.expiresAt) <= now)
}

function targetMatches(scope: ApprovalScope, peerId: string | null, providerId: string | null): boolean {
  const peerMatches = Boolean(scope.peerId && peerId && scope.peerId === peerId)
  const providerMatches = Boolean(scope.providerId && providerId && scope.providerId === providerId)
  return peerMatches || providerMatches
}

function actionIdentityMatches(scope: ApprovalScope, toolId: string | null, resourceId: string | null): boolean {
  if (scope.toolId) return Boolean(toolId && scope.toolId === toolId)
  if (scope.resourceId) return Boolean(resourceId && scope.resourceId === resourceId)
  return true
}

function localSafeToolScopeMatches(
  scope: ApprovalScope,
  input: RoutePolicyInput,
  action: CapabilityActionInfo | null,
  toolId: string | null,
  providerId: string | null
): boolean {
  if (!action || !toolId) return false
  if (scope.toolId && scope.toolId !== toolId) return false
  if (scope.providerId && scope.providerId !== providerId) return false
  if (scope.sessionId && scope.sessionId !== input.sessionId) return false
  const localTarget = input.route.selected_target === 'local' || action.provider_kind === 'local'
  const safeClass = action.policy.safety_class === 'standard' && action.policy.operation_class !== 'admin'
  const lowPrivacy = !HIGH_PRIVACY_CLASSES.includes(classifyPayloadPrivacy(input.payload, action.policy, action))
  return localTarget && safeClass && lowPrivacy
}

function availabilityForPolicy(
  decision: RoutePolicyEvaluation['decision'],
  route: RouteExplainResponse,
  action: CapabilityActionInfo | null
): AvailabilityState {
  if (decision === 'privacy-blocked') return 'privacy-blocked'
  if (decision === 'blocked') return 'denied'
  if (route.fallback_behavior === 'fallback-used') return 'degraded'
  if (action?.freshness.stale) return 'stale'
  if ((route.selected_target || action?.provider_kind) === 'local') return 'available-local'
  return 'available-remote'
}

function reasonCodeFor(
  decision: RoutePolicyEvaluation['decision'],
  route: RouteExplainResponse,
  blockers: RouteBlockerInfo[],
  approvalStatus: RoutePolicyEvaluation['approval']['status']
): string {
  if (approvalStatus === 'required' || approvalStatus === 'expired') return 'approval_required'
  if (approvalStatus === 'rejected') return 'approval_denied'
  if (blockers[0]?.code) return blockers[0].code
  if (!route.selector_valid) return route.selector_validation_code || 'selector_invalid'
  return decision
}

function repairPathFor(input: {
  blockers: RouteBlockerInfo[]
  approvalStatus: RoutePolicyEvaluation['approval']['status']
  explicitSelectorRequired: boolean
  fallbackBlocked: boolean
}): string | null {
  if (input.approvalStatus === 'required' || input.approvalStatus === 'expired') return 'request user approval'
  if (input.approvalStatus === 'rejected') return 'choose a different approval scope or target'
  if (input.explicitSelectorRequired) return 'choose an explicit peer/provider/resource selector'
  if (input.fallbackBlocked) return 'choose an eligible non-cloud provider'
  const first = input.blockers[0]
  if (!first) return null
  if (first.security_privacy) return 'satisfy the route privacy policy before execution'
  return first.message || first.code
}

function isFallbackBlocked(route: RouteExplainResponse, allowCloudFallback: boolean): boolean {
  return !allowCloudFallback && ['cloud', 'cloud-fallback', 'fallback-cloud'].includes(route.fallback_behavior)
}

function isRemoteTarget(route: RouteExplainResponse, action: CapabilityActionInfo | null): boolean {
  const target = route.selected_target || action?.provider_kind
  return Boolean(target && !['local', 'none'].includes(target))
}

function isCloudTarget(route: RouteExplainResponse): boolean {
  return route.selected_target === 'cloud' || route.fallback_behavior.includes('cloud')
}

function hasSelector(input: RoutePolicyInput): boolean {
  return Boolean(input.selector ?? input.route.selected_peer_id ?? input.route.selected_provider_id ?? readSelector(input.route, null))
}

function readSelector(route: RouteExplainResponse, explicit: unknown): unknown {
  if (explicit !== undefined) return explicit
  return route.selected_peer_id || route.selected_provider_id
    ? {
        peer_id: route.selected_peer_id,
        provider_id: route.selected_provider_id,
        service_instance_id: route.selected_service_instance_id
      }
    : null
}

function blocker(
  code: string,
  message: string,
  providerId: string | null,
  peerId: string | null,
  securityPrivacy: boolean
): RouteBlockerInfo {
  return {
    code,
    message,
    severity: 'error',
    provider_id: providerId,
    peer_id: peerId,
    security_privacy: securityPrivacy
  }
}

function uniqueBlockers(blockers: RouteBlockerInfo[]): RouteBlockerInfo[] {
  const seen = new Set<string>()
  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.provider_id ?? ''}:${blocker.peer_id ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function unique<T extends string>(items: T[]): T[] {
  return [...new Set(items)]
}

function isSelectorBlocker(code: string): boolean {
  return code.includes('selector') || code.includes('target')
}

function egressDestinationFor(
  selectedTarget: string,
  provider: RouteCandidateDecision | null,
  action: CapabilityActionInfo | null
): RoutePreview['egressDestination'] {
  if (selectedTarget === 'local' || action?.provider_kind === 'local') return 'local'
  if (selectedTarget.includes('cloud') || action?.provider_kind === 'cloud') return 'cloud'
  if (provider?.peer_id || action?.peer_id) return 'peer'
  return 'none'
}

function expectedPersistenceFor(policy: CapabilityPolicyDecisionInfo | undefined): string {
  if (policy?.operation_class === 'audio') return 'transient unless backend retention policy says otherwise'
  if (policy?.operation_class === 'admin') return 'audit log'
  if (policy?.resource_scope === 'credential') return 'secure storage or audit reference only'
  return 'backend-defined'
}

function auditTargetFor(provider: RouteCandidateDecision | null, action: CapabilityActionInfo | null): string | null {
  return provider?.provider_id ?? action?.provider_id ?? null
}

function redactPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null
  if (Array.isArray(payload)) return payload.map(redactPayload)
  if (typeof payload !== 'object') return payload
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key,
      isSecretKey(key) ? '[redacted]' : redactPayload(value)
    ])
  )
}

function containsSecretLikeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => isSecretKey(key) || containsSecretLikeKey(nested))
}

function containsPersonalPayload(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 80
  if (Array.isArray(value)) return value.some(containsPersonalPayload)
  if (typeof value !== 'object' || value === null) return false
  return Object.keys(value as Record<string, unknown>).some((key) =>
    ['text', 'prompt', 'message', 'query', 'document', 'device_name'].includes(key.toLowerCase())
  )
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_')
  return DEFAULT_SECRET_KEYS.some((secretKey) => normalized.includes(secretKey))
}
