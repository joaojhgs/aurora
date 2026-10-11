'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AuroraClient,
  JsonValue,
  NormalizedSchedulerJob,
  ToolApprovalCardModel,
  ToolApprovalDecisionResult,
  ToolApprovalGrantModel,
  ToolApprovalScope,
  ToolPolicyAuditEventModel,
  ToolPendingApprovalModel,
  ToolOnboardingValidationResult,
  ToolSourceDetailModel,
  McpSourceWizardDraft,
  PluginSourceWizardDraft,
  ToolSourceSummaryModel,
  ToolExportDecisionModel,
  ToolExportPolicyModel,
  ToolExportScopeModel,
  ToolingPageViewModel
} from '@aurora/client'
import {
  TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
  normalizeToolCatalog,
  type ToolCatalogEntry,
  type ToolingProjectionToolInfo,
} from '@aurora/client'
import { mergeLightweightAssistantTools } from '@aurora/client/lightweight-orchestrator'
import type {
  LocalFeatureSharingPort,
  LocalFeatureSharingSnapshot,
  LocalToolApprovalPolicyPort,
  LocalToolApprovalPolicySnapshot,
  LocalToolApprovalTrustTier,
} from './local-feature-sharing'
import type { RouteAvailability } from './shell-data'
import { safeErrorCopy } from './product-copy'
import { AuroraQueryProvider, useAuroraQueryScope } from './query'
import { ToolingConsole, type BuiltinPluginModel, type ToolSharingMutation } from './tooling'
import {
  exportableToolApprovalLocalTools,
  mergeToolApprovalSharingScopes,
  useToolApprovalPanelQueryGroups,
} from './tool-approval-panel-queries'

export interface ToolApprovalPanelManagementState {
  policySummary?: ToolingPageViewModel['policy'] | null
  sourceSummaries?: ToolSourceSummaryModel[]
  sourceDetails?: Record<string, ToolSourceDetailModel | null>
  grants?: ToolApprovalGrantModel[]
  pendingApprovals?: ToolPendingApprovalModel[]
  auditEvents?: ToolPolicyAuditEventModel[]
  builtinPlugins?: BuiltinPluginModel[]
  managementLoading?: boolean
  managementError?: string | null
  sharingPolicy?: ToolExportPolicyModel | null
  sharingPeers?: ToolExportScopeModel[]
  sharingDecisions?: Record<string, ToolExportDecisionModel | null>
  sharingLoading?: boolean
  sharingError?: string | null
  sharingMessage?: string | null
}

export interface ToolApprovalPanelProps {
  client: AuroraClient
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
  initialSchedulerJobs?: NormalizedSchedulerJob[] | undefined
  nativePlatform?: string | undefined
  initialManagementState?: ToolApprovalPanelManagementState | undefined
  localFeatureSharing?: LocalFeatureSharingPort | undefined
  localToolApprovalPolicy?: LocalToolApprovalPolicyPort | undefined
  sourceManagementEnabled?: boolean | undefined
}

export interface LightweightToolApprovalPanelProps {
  client: AuroraClient
  route: RouteAvailability
  localTools: readonly ToolingProjectionToolInfo[]
  remoteTools?: readonly ToolingProjectionToolInfo[] | undefined
  featureSharing?: LocalFeatureSharingPort | undefined
  nativePlatform?: string | undefined
}

export interface ToolApprovalPanelState {
  tools: ToolApprovalCardModel[]
  loading: boolean
  error: string | null
  schedulerJobs: NormalizedSchedulerJob[]
  schedulerLoading: boolean
  schedulerError: string | null
  selectedProviders: Record<string, string>
  decisionMessages: Record<string, string>
  policySummary: ToolingPageViewModel['policy'] | null
  sourceSummaries: ToolSourceSummaryModel[]
  sourceDetails: Record<string, ToolSourceDetailModel | null>
  grants: ToolApprovalGrantModel[]
  pendingApprovals: ToolPendingApprovalModel[]
  auditEvents: ToolPolicyAuditEventModel[]
  builtinPlugins: BuiltinPluginModel[]
  managementLoading: boolean
  managementError: string | null
  sharingPolicy: ToolExportPolicyModel | null
  sharingPeers: ToolExportScopeModel[]
  sharingDecisions: Record<string, ToolExportDecisionModel | null>
  sharingLoading: boolean
  sharingError: string | null
  sharingMessage: string | null
  sharingPendingKey: string | null
}

export interface ToolDenialActionInput {
  client: AuroraClient
  tool: ToolApprovalCardModel
  selectedProviderId?: string | undefined
  reason?: string
  signal?: AbortSignal | undefined
}

interface ScopeMutationGuard {
  scopeKey: string
  generation: number
  signal: AbortSignal
}

export function LightweightToolApprovalPanel({
  client,
  route,
  localTools,
  remoteTools = [],
  featureSharing,
  nativePlatform,
}: LightweightToolApprovalPanelProps) {
  const tools = useMemo(() => normalizeToolCatalog({
    tools: mergeLightweightAssistantTools(localTools, remoteTools) as unknown as readonly ToolCatalogEntry[],
    secrets_redacted: true,
  }, { transportKind: client.transport.kind }), [client.transport.kind, localTools, remoteTools])
  const activeRoute = useMemo<RouteAvailability>(() => ({
    ...route,
    state: 'available-local',
    explanation: 'Tools are available from this device and its approved devices.',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    routeable: true,
    disabled: false,
  }), [route])
  return (
    <ToolApprovalPanel
      client={client}
      route={activeRoute}
      initialTools={tools}
      initialSchedulerJobs={[]}
      nativePlatform={nativePlatform}
      sourceManagementEnabled={false}
      {...(featureSharing ? { localFeatureSharing: featureSharing } : {})}
      {...(featureSharing?.toolApprovalPolicy
        ? { localToolApprovalPolicy: featureSharing.toolApprovalPolicy }
        : {})}
    />
  )
}

export function ToolApprovalPanel(props: ToolApprovalPanelProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <ToolApprovalPanelQuery {...props} />
  return (
    <AuroraQueryProvider client={props.client}>
      <ToolApprovalPanelQuery {...props} />
    </AuroraQueryProvider>
  )
}

function ToolApprovalPanelQuery({ client, route, initialTools, initialSchedulerJobs, nativePlatform, initialManagementState, localFeatureSharing, localToolApprovalPolicy, sourceManagementEnabled = true }: ToolApprovalPanelProps) {
  const sharingRequestGeneration = useRef(0)
  const mutationScopeKey = useRef<string | null>(null)
  const mutationScopeGeneration = useRef(0)
  const mutationAbortController = useRef(new AbortController())
  const managementEnabled = sourceManagementEnabled && !localFeatureSharing
  const serverQueries = useToolApprovalPanelQueryGroups({
    client,
    route,
    initialTools,
    initialSchedulerJobs,
    initialManagementState,
    managementEnabled,
    serverDataEnabled: sourceManagementEnabled && !localFeatureSharing,
  })
  mutationScopeKey.current = serverQueries.scopeKey
  const [localApprovalPolicies, setLocalApprovalPolicies] = useState<LocalToolApprovalPolicySnapshot | null>(null)
  const [localApprovalLoading, setLocalApprovalLoading] = useState(Boolean(localToolApprovalPolicy))
  const [localApprovalError, setLocalApprovalError] = useState<string | null>(null)
  const [state, setState] = useState<ToolApprovalPanelState>(() => ({
    tools: initialTools ?? [],
    loading: !initialTools,
    error: null,
    schedulerJobs: initialSchedulerJobs ?? [],
    schedulerLoading: !initialSchedulerJobs,
    schedulerError: null,
    selectedProviders: {},
    decisionMessages: {},
    policySummary: initialManagementState?.policySummary ?? null,
    sourceSummaries: initialManagementState?.sourceSummaries ?? [],
    sourceDetails: initialManagementState?.sourceDetails ?? {},
    grants: initialManagementState?.grants ?? [],
    pendingApprovals: initialManagementState?.pendingApprovals ?? [],
    auditEvents: initialManagementState?.auditEvents ?? [],
    builtinPlugins: initialManagementState?.builtinPlugins ?? [],
    managementLoading: initialManagementState?.managementLoading ?? (!initialManagementState && managementEnabled),
    managementError: initialManagementState?.managementError ?? null,
    sharingPolicy: initialManagementState?.sharingPolicy ?? null,
    sharingPeers: mergeToolApprovalSharingScopes(initialManagementState?.sharingPeers ?? [], initialManagementState?.sharingPolicy ?? null),
    sharingDecisions: initialManagementState?.sharingDecisions ?? {},
    sharingLoading: initialManagementState?.sharingLoading ?? (!initialManagementState && managementEnabled),
    sharingError: initialManagementState?.sharingError ?? null,
    sharingMessage: initialManagementState?.sharingMessage ?? null,
    sharingPendingKey: null
  }))
  const [localStateScopeKey, setLocalStateScopeKey] = useState(serverQueries.scopeKey)

  function currentScopeGuard(): ScopeMutationGuard {
    return { scopeKey: serverQueries.scopeKey, generation: mutationScopeGeneration.current, signal: mutationAbortController.current.signal }
  }

  function scopeMutationIsCurrent(guard: ScopeMutationGuard): boolean {
    return !guard.signal.aborted && (mutationScopeKey.current === null || mutationScopeKey.current === guard.scopeKey) && mutationScopeGeneration.current === guard.generation
  }

  function mutationOptions(guard: ScopeMutationGuard) {
    return { signal: guard.signal }
  }

  function markLocalStateForCurrentScope() {
    setLocalStateScopeKey(serverQueries.scopeKey)
  }

  function invalidateIfCurrent(guard: ScopeMutationGuard, invalidate: () => Promise<unknown> | unknown) {
    if (!scopeMutationIsCurrent(guard)) return
    void invalidate()
  }

  function setStateIfCurrent(guard: ScopeMutationGuard, update: (current: ToolApprovalPanelState) => ToolApprovalPanelState) {
    if (!scopeMutationIsCurrent(guard)) return
    setState(update)
  }

  useEffect(() => {
    if (!initialTools) return
    setState((current) => ({
      ...current,
      tools: initialTools,
      loading: false,
      error: null,
    }))
  }, [initialTools])

  useEffect(() => {
    if (!localFeatureSharing) return
    let active = true
    const apply = (snapshot: LocalFeatureSharingSnapshot) => {
      if (!active) return
      const management = buildLocalToolSharingManagement(snapshot, initialTools ?? [])
      setState((current) => ({
        ...current,
        ...management,
        managementLoading: false,
        managementError: null,
        sharingLoading: false,
        sharingError: null,
      }))
    }
    const unsubscribe = localFeatureSharing.subscribe?.(apply)
    void localFeatureSharing.load().then(apply, () => {
      if (!active) return
      setState((current) => ({
        ...current,
        managementLoading: false,
        sharingLoading: false,
        sharingError: 'Tool sharing is unavailable right now. Try again.',
      }))
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [initialTools, localFeatureSharing])

  useEffect(() => {
    if (!localToolApprovalPolicy) {
      setLocalApprovalPolicies(null)
      setLocalApprovalLoading(false)
      setLocalApprovalError(null)
      return
    }
    let active = true
    const apply = (snapshot: LocalToolApprovalPolicySnapshot) => {
      if (!active) return
      setLocalApprovalPolicies(snapshot)
      setLocalApprovalLoading(false)
      setLocalApprovalError(snapshot.unavailable
        ? 'Tool approval settings are unavailable right now. Try again.'
        : null)
    }
    setLocalApprovalLoading(true)
    setLocalApprovalError(null)
    const unsubscribe = localToolApprovalPolicy.subscribeApprovalPolicies?.(apply)
    void localToolApprovalPolicy.loadApprovalPolicies().then(apply, () => {
      if (!active) return
      setLocalApprovalLoading(false)
      setLocalApprovalError('Tool approval settings are unavailable right now. Try again.')
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [localToolApprovalPolicy, serverQueries.scopeKey])

  useEffect(() => {
    mutationAbortController.current.abort()
    mutationAbortController.current = new AbortController()
    mutationScopeKey.current = serverQueries.scopeKey
    mutationScopeGeneration.current += 1
    sharingRequestGeneration.current += 1
    setLocalStateScopeKey(serverQueries.scopeKey)
    setState((current) => ({
      ...current,
      selectedProviders: {},
      decisionMessages: {},
      sharingPolicy: null,
      sharingDecisions: {},
      sharingPendingKey: null,
      sharingError: null,
      sharingMessage: null,
    }))
    return () => {
      mutationAbortController.current.abort()
      mutationScopeGeneration.current += 1
      sharingRequestGeneration.current += 1
      if (mutationScopeKey.current === serverQueries.scopeKey) mutationScopeKey.current = null
    }
  }, [serverQueries.scopeKey])

  const viewState = useMemo<ToolApprovalPanelState>(() => {
    const localStateInCurrentScope = localStateScopeKey === serverQueries.scopeKey
    const scopedLocalState: ToolApprovalPanelState = localStateInCurrentScope
      ? state
      : {
          ...state,
          selectedProviders: {},
          decisionMessages: {},
          sharingPolicy: null,
          sharingDecisions: {},
          sharingPendingKey: null,
          sharingError: null,
          sharingMessage: null,
        }
    if (localFeatureSharing || !sourceManagementEnabled) return scopedLocalState
    const sharingOverrideActive = scopedLocalState.sharingPendingKey !== null || scopedLocalState.sharingPolicy !== null
    return {
      ...scopedLocalState,
      ...serverQueries.state,
      selectedProviders: scopedLocalState.selectedProviders,
      decisionMessages: scopedLocalState.decisionMessages,
      sharingPolicy: sharingOverrideActive
        ? scopedLocalState.sharingPolicy ?? serverQueries.state.sharingPolicy
        : serverQueries.state.sharingPolicy,
      sharingDecisions: sharingOverrideActive
        ? { ...serverQueries.state.sharingDecisions, ...scopedLocalState.sharingDecisions }
        : serverQueries.state.sharingDecisions,
      sharingError: scopedLocalState.sharingError ?? serverQueries.state.sharingError,
      sharingMessage: scopedLocalState.sharingMessage,
      sharingPendingKey: scopedLocalState.sharingPendingKey,
    }
  }, [localFeatureSharing, localStateScopeKey, serverQueries.scopeKey, serverQueries.state, sourceManagementEnabled, state])

  async function refreshSharing(guard = currentScopeGuard()) {
    const generation = ++sharingRequestGeneration.current
    if (!scopeMutationIsCurrent(guard)) return
    markLocalStateForCurrentScope()
    setStateIfCurrent(guard, (current) => ({ ...current, sharingLoading: true, sharingError: null }))
    try {
      if (localFeatureSharing) {
        const snapshot = await localFeatureSharing.load()
        if (generation !== sharingRequestGeneration.current || !scopeMutationIsCurrent(guard)) return
        setState((current) => ({
          ...current,
          ...buildLocalToolSharingManagement(snapshot, current.tools),
          sharingLoading: false,
          sharingError: null,
        }))
        return
      }
      await serverQueries.refetchManagement()
      if (generation !== sharingRequestGeneration.current || !scopeMutationIsCurrent(guard)) return
      setState((current) => ({
        ...current,
        sharingPolicy: null,
        sharingDecisions: {},
        sharingLoading: false,
        sharingError: null,
      }))
    } catch (error) {
      if (generation !== sharingRequestGeneration.current || !scopeMutationIsCurrent(guard)) return
      setState((current) => ({ ...current, sharingLoading: false, sharingError: productToolErrorCopy(error) }))
    }
  }

  async function mutateSharing(mutation: ToolSharingMutation) {
    const guard = currentScopeGuard()
    if (!scopeMutationIsCurrent(guard)) return
    markLocalStateForCurrentScope()
    if (localFeatureSharing) {
      const pendingKey = `${mutation.scopeType}:${mutation.scopeId}`
      setStateIfCurrent(guard, (current) => ({
        ...current,
        sharingPendingKey: pendingKey,
        sharingError: null,
        sharingMessage: 'Saving tool sharing…',
      }))
      try {
        const snapshot = await localFeatureSharing.load()
        if (!scopeMutationIsCurrent(guard)) return
        await applyLocalToolSharingMutation(
          localFeatureSharing,
          snapshot,
          viewState.tools,
          mutation,
        )
        if (!scopeMutationIsCurrent(guard)) return
        const next = await localFeatureSharing.load()
        if (!scopeMutationIsCurrent(guard)) return
        setState((current) => ({
          ...current,
          ...buildLocalToolSharingManagement(next, current.tools),
          sharingPendingKey: null,
          sharingMessage: mutation.mode === 'shared'
            ? 'Tool sharing updated.'
            : 'Tool is not shared with approved devices.',
        }))
      } catch (error) {
        setStateIfCurrent(guard, (current) => ({
          ...current,
          sharingPendingKey: null,
          sharingError: productToolErrorCopy(error),
          sharingMessage: null,
        }))
      }
      return
    }
    const currentPolicy = viewState.sharingPolicy
    if (!currentPolicy) {
      setStateIfCurrent(guard, (current) => ({ ...current, sharingError: 'Sharing policy revision is unavailable; refresh before changing policy.' }))
      return
    }
    const pendingKey = `${mutation.scopeType}:${mutation.scopeId}`
    const actor = client.auth.snapshot().principalId ?? 'current-principal'
    const targetPeerIds = mutation.peerIds.includes(null) ? [null] : mutation.peerIds
    const reason = sharingMutationReason(mutation, viewState.sharingPeers)
    const optimisticPolicy = applyOptimisticSharingMutation(currentPolicy, mutation, actor, reason)
    setStateIfCurrent(guard, (current) => ({
      ...current,
      sharingPolicy: optimisticPolicy,
      sharingPendingKey: pendingKey,
      sharingError: null,
      sharingMessage: 'Saving sharing policy…'
    }))
    try {
      let revision = currentPolicy.revision
      const currentRules = currentPolicy.rules.filter((rule) => rule.scopeType === mutation.scopeType && rule.scopeId === mutation.scopeId)
      const desiredRules = desiredSharingRules(mutation)
      const peerKeys = new Set<string | null>([
        ...currentRules.map((rule) => rule.peerId),
        ...desiredRules.map((rule) => rule.peerId)
      ])
      for (const peerId of peerKeys) {
        const desired = desiredRules.find((rule) => rule.peerId === peerId)
        const existing = currentRules.find((rule) => rule.peerId === peerId)
        if (desired && existing?.state === desired.state) continue
        if (!scopeMutationIsCurrent(guard)) return
        const common = {
          expected_revision: revision,
          actor_principal_id: actor,
          reason,
          confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT
        }
        const response = desired
          ? mutation.scopeType === 'group'
            ? await client.tools.upsertToolGroupExportPolicy({ ...common, state: desired.state, share_group_id: mutation.scopeId, peer_id: peerId }, mutationOptions(guard))
            : await client.tools.upsertToolExportOverride({ ...common, state: desired.state, global_tool_id: mutation.scopeId, peer_id: peerId }, mutationOptions(guard))
          : await client.tools.clearToolExportOverride({ ...common, scope_type: mutation.scopeType, scope_id: mutation.scopeId, peer_id: peerId }, mutationOptions(guard))
        if (!response.ok) throw new Error(response.error ?? 'Sharing policy mutation was rejected.')
        if (!scopeMutationIsCurrent(guard)) return
        revision = response.revision
      }
      await refreshSharing(guard)
      setStateIfCurrent(guard, (current) => ({
        ...current,
        sharingPendingKey: null,
        sharingMessage: mutation.mode === 'inherit'
          ? 'Sharing now inherits from the next policy level.'
          : mutation.mode === 'shared'
            ? `Shared with ${targetPeerIds.includes(null) ? 'all peers' : `${targetPeerIds.length} selected peer${targetPeerIds.length === 1 ? '' : 's'}`}.`
            : 'Not shared with mesh peers.'
      }))
    } catch (error) {
      const message = productToolErrorCopy(error)
      await refreshSharing(guard)
      setStateIfCurrent(guard, (current) => ({ ...current, sharingPendingKey: null, sharingError: message, sharingMessage: 'Previous effective sharing policy remains in effect.' }))
    }
  }

  async function approve(tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun = false) {
    const guard = currentScopeGuard()
    const selectedProviderId = viewState.selectedProviders[tool.id]
    setDecisionMessage(tool.id, dryRun ? 'Submitting dry-run approval...' : `Submitting ${scope} approval...`, guard)
    try {
      const request = {
        tool,
        scope,
        approverPrincipalId: client.auth.snapshot().principalId ?? 'current-principal',
        reason: dryRun ? `Requested dry run for ${tool.name} from Aurora UI` : `Approved ${tool.name} from Aurora UI`,
        dryRun
      }
      if (!scopeMutationIsCurrent(guard)) return
      const result = await client.tools.submitApprovalDecision(selectedProviderId ? { ...request, selectedProviderId } : request, mutationOptions(guard))
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      setDecisionMessage(tool.id, `Approved with correlation ${result.correlationId ?? 'pending'}`, guard)
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error), guard)
    }
  }

  async function deny(tool: ToolApprovalCardModel) {
    const guard = currentScopeGuard()
    const selectedProviderId = viewState.selectedProviders[tool.id]
    setDecisionMessage(tool.id, 'Sending denial...', guard)
    try {
      const result = await submitToolDenialAction({
        client,
        tool,
        selectedProviderId,
        reason: `Denied ${tool.name} from Aurora UI`,
        signal: guard.signal
      })
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      setDecisionMessage(tool.id, denialResultMessage(result), guard)
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error), guard)
    }
  }

  async function executeSafe(tool: ToolApprovalCardModel) {
    const guard = currentScopeGuard()
    setDecisionMessage(tool.id, 'Running local tool...', guard)
    try {
      await client.tools.execute({
        tool_name: tool.id,
        arguments: {},
        mesh_selector: tool.meshSelector ?? null,
        resource_selector: tool.resourceSelector ?? null,
        confirmed: true,
        correlation_id: tool.correlationId ?? null
      }, mutationOptions(guard))
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      setDecisionMessage(tool.id, 'Local tool finished.', guard)
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error), guard)
    }
  }

  function setDecisionMessage(toolId: string, message: string, guard = currentScopeGuard()) {
    if (!scopeMutationIsCurrent(guard)) return
    markLocalStateForCurrentScope()
    setState((current) => ({
      ...current,
      decisionMessages: { ...current.decisionMessages, [toolId]: message }
    }))
  }

  function selectProvider(tool: ToolApprovalCardModel, providerId: string) {
    const guard = currentScopeGuard()
    if (!scopeMutationIsCurrent(guard)) return
    markLocalStateForCurrentScope()
    setState((current) => ({
      ...current,
      selectedProviders: { ...current.selectedProviders, [tool.id]: providerId }
    }))
  }

  async function refreshLocalApprovalPolicies(guard = currentScopeGuard()) {
    if (!localToolApprovalPolicy) return
    const snapshot = await localToolApprovalPolicy.loadApprovalPolicies()
    if (!scopeMutationIsCurrent(guard)) return
    setLocalApprovalPolicies(snapshot)
    setLocalApprovalError(snapshot.unavailable
      ? 'Tool approval settings are unavailable right now. Try again.'
      : null)
  }

  async function setPolicyMode(policyMode: string) {
    const guard = currentScopeGuard()
    if (!scopeMutationIsCurrent(guard)) return
    markLocalStateForCurrentScope()
    const requiredConfirmation = policyConfirmationText(policyMode)
    let confirmationText: string | null = null
    if (requiredConfirmation && typeof window !== 'undefined') {
      confirmationText = window.prompt(`Type ${requiredConfirmation} to set Tooling policy mode to ${policyMode}`)
    }
    if (requiredConfirmation && confirmationText !== requiredConfirmation) {
      setStateIfCurrent(guard, (current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: `Policy mode ${policyMode} was not changed: confirmation text did not match.` } }))
      return
    }
    try {
      if (!scopeMutationIsCurrent(guard)) return
      await client.tools.setPolicyMode({ policyMode, confirmationText, reason: `Set ${policyMode} from /tools`, signal: guard.signal })
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      setStateIfCurrent(guard, (current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: `Policy set to ${policyMode}` } }))
    } catch (error) {
      setStateIfCurrent(guard, (current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: productToolErrorCopy(error) } }))
    }
  }

  async function upsertSourcePolicy(source: { id: string; peerId: string | null; serviceInstanceId: string | null }, trustTier: string, includeFutureTools = false) {
    const guard = currentScopeGuard()
    setDecisionMessage('__policy__', `Updating source policy for ${source.id}...`, guard)
    try {
      if (localToolApprovalPolicy) {
        if (trustTier === 'inherit') {
          await localToolApprovalPolicy.clearSourceApprovalPolicy(source.id)
        } else {
          await localToolApprovalPolicy.setSourceApprovalPolicy(
            source.id,
            localApprovalTrustTier(trustTier),
            includeFutureTools,
          )
        }
        await refreshLocalApprovalPolicies(guard)
        setDecisionMessage('__policy__', `Default approval updated for ${source.id}.`, guard)
        return
      }
      if (trustTier === 'inherit') {
        await client.tools.clearSourcePolicy({
          sourceId: source.id,
          reason: `Clear source ${source.id} policy to inherit from /tools`,
          signal: guard.signal
        })
      } else {
        await client.tools.upsertSourcePolicy({
          sourceId: source.id,
          providerPeerId: source.peerId,
          providerServiceInstanceId: source.serviceInstanceId,
          trustTier,
          includeFutureTools,
          reason: `Set source ${source.id} to ${trustTier} from /tools`,
          signal: guard.signal
        })
      }
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      setStateIfCurrent(guard, (current) => ({
        ...current,
        decisionMessages: { ...current.decisionMessages, __policy__: `Source ${source.id} set to ${trustTier}` }
      }))
    } catch (error) {
      setDecisionMessage('__policy__', productToolErrorCopy(error), guard)
    }
  }

  async function upsertToolOverride(tool: ToolApprovalCardModel, approvalMode: string) {
    const guard = currentScopeGuard()
    setDecisionMessage(tool.id, `Updating policy override for ${tool.name}...`, guard)
    try {
      if (localToolApprovalPolicy) {
        const toolId = tool.toolContractId?.trim()
        if (!toolId || tool.sourceType === 'mesh_peer' || /mesh|remote/i.test(tool.providerKind)) {
          throw new Error('Approval settings for this tool are managed by the device that shares it.')
        }
        if (approvalMode === 'inherit') {
          await localToolApprovalPolicy.clearToolApprovalOverride(toolId)
        } else if (
          approvalMode === 'approve_all_for_peer'
          || approvalMode === 'ask_each_time'
          || approvalMode === 'deny_all'
        ) {
          await localToolApprovalPolicy.setToolApprovalOverride(toolId, approvalMode)
        } else {
          throw new Error('This approval choice is unavailable.')
        }
        await refreshLocalApprovalPolicies(guard)
        setDecisionMessage(tool.id, `Approval updated for ${tool.name}.`, guard)
        return
      }
      if (approvalMode === 'inherit') {
        await client.tools.clearToolOverride({
          toolId: tool.id,
          localToolName: tool.localToolName ?? tool.name,
          reason: `Clear ${tool.name} override to inherit from /tools`,
          signal: guard.signal
        })
      } else {
        await client.tools.upsertToolOverride({
          toolId: tool.id,
          localToolName: tool.localToolName ?? tool.name,
          approvalMode,
          providerPeerId: tool.providerPeerId,
          providerServiceInstanceId: tool.serviceInstanceId,
          reason: `Set ${tool.name} override to ${approvalMode} from /tools`,
          signal: guard.signal
        })
      }
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      setStateIfCurrent(guard, (current) => ({
        ...current,
        decisionMessages: { ...current.decisionMessages, [tool.id]: `Policy override updated to ${approvalMode}.` }
      }))
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error), guard)
    }
  }

  async function revokeGrant(grant: { id: string }) {
    const guard = currentScopeGuard()
    setDecisionMessage('__policy__', `Revoking grant ${grant.id}...`, guard)
    try {
      if (!scopeMutationIsCurrent(guard)) return
      await client.tools.revokeGrant({ grant_id: grant.id, revoked_by: client.auth.snapshot().principalId ?? 'current-principal', reason: `Revoked ${grant.id} from /tools` }, mutationOptions(guard))
      if (!scopeMutationIsCurrent(guard)) return
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      setStateIfCurrent(guard, (current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: `Grant ${grant.id} revoked` } }))
    } catch (error) {
      setDecisionMessage('__policy__', productToolErrorCopy(error), guard)
    }
  }

  async function applyPluginConfigChanges(changes: { key_path: string; value: JsonValue }[], successMessage: string, guard = currentScopeGuard()) {
    const diff = await client.config.previewDiff({ changes })
    if (!scopeMutationIsCurrent(guard)) return
    if (!diff.ok || !diff.data?.valid) {
      throw new Error(diff.ok ? diff.data?.errors.join('; ') || 'Plugin config change was not valid.' : diff.error.message)
    }
    await client.config.previewReloadImpact({ changes })
    if (!scopeMutationIsCurrent(guard)) return
    for (const change of changes) {
      await client.config.applyChange({
        change,
        reason: 'Update plugin settings from Aurora UI',
        reauthConfirmed: true
      })
      if (!scopeMutationIsCurrent(guard)) return
    }
    invalidateIfCurrent(guard, serverQueries.invalidateManagement)
    invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
    setStateIfCurrent(guard, (current) => ({
      ...current,
      decisionMessages: { ...current.decisionMessages, __plugins__: successMessage }
    }))
  }

  async function togglePlugin(plugin: BuiltinPluginModel, active: boolean) {
    const guard = currentScopeGuard()
    setDecisionMessage('__plugins__', `${active ? 'Activating' : 'Deactivating'} ${plugin.label}...`, guard)
    try {
      await applyPluginConfigChanges(
        [{ key_path: plugin.activateKeyPath, value: active }],
        active ? `${plugin.label} is active. Review its tools before use.` : `${plugin.label} is inactive.`,
        guard,
      )
    } catch (error) {
      setDecisionMessage('__plugins__', productToolErrorCopy(error), guard)
    }
  }

  async function savePluginConfig(plugin: BuiltinPluginModel, values: Record<string, JsonValue>) {
    const guard = currentScopeGuard()
    const changes = Object.entries(values).map(([key_path, value]) => ({ key_path, value }))
    if (changes.length === 0) {
      setDecisionMessage('__plugins__', `No ${plugin.label} config changes to save.`, guard)
      return
    }
    setDecisionMessage('__plugins__', `Saving ${plugin.label} configuration...`, guard)
    try {
      await applyPluginConfigChanges(changes, `${plugin.label} settings saved.`, guard)
    } catch (error) {
      const message = productToolErrorCopy(error)
      setDecisionMessage('__plugins__', message, guard)
      throw error
    }
  }

  async function testSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const guard = currentScopeGuard()
    setDecisionMessage('__policy__', `Checking ${kind.toUpperCase()} source...`, guard)
    try {
      const result = kind === 'mcp'
        ? await client.tools.testMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.testPluginSource(draft as PluginSourceWizardDraft)
      setDecisionMessage('__policy__', sourceResultMessage(kind, result), guard)
      return result
    } catch (error) {
      const message = productToolErrorCopy(error)
      setDecisionMessage('__policy__', message, guard)
      throw error
    }
  }

  async function createSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const guard = currentScopeGuard()
    setDecisionMessage('__policy__', `Saving ${kind.toUpperCase()} source...`, guard)
    try {
      const result = kind === 'mcp'
        ? await client.tools.createMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.createPluginSource(draft as PluginSourceWizardDraft)
      invalidateIfCurrent(guard, serverQueries.invalidateManagement)
      invalidateIfCurrent(guard, serverQueries.invalidateApprovalCards)
      setDecisionMessage('__policy__', sourceResultMessage(kind, result), guard)
      return result
    } catch (error) {
      const message = productToolErrorCopy(error)
      setDecisionMessage('__policy__', message, guard)
      throw error
    }
  }

  const localApprovalStateInCurrentScope = localStateScopeKey === serverQueries.scopeKey
  const scopedLocalApprovalPolicies = localApprovalStateInCurrentScope ? localApprovalPolicies : null
  const scopedLocalApprovalError = localApprovalStateInCurrentScope ? localApprovalError : null
  const scopedLocalApprovalLoading = localApprovalStateInCurrentScope && localApprovalLoading
  const toolsForConsole = useMemo(
    () => applyLocalToolApprovalPolicies(viewState.tools, scopedLocalApprovalPolicies),
    [scopedLocalApprovalPolicies, viewState.tools],
  )
  const sourceConfiguredTrustTiers = useMemo(
    () => Object.fromEntries(
      (scopedLocalApprovalPolicies?.sourcePolicies ?? []).map((policy) => [policy.sourceId, policy.trustTier]),
    ),
    [scopedLocalApprovalPolicies],
  )
  const localApprovalMutable = Boolean(
    localToolApprovalPolicy
    && scopedLocalApprovalPolicies
    && !scopedLocalApprovalPolicies.unavailable
    && !scopedLocalApprovalLoading,
  )
  const approvalPolicyMutable = managementEnabled || localApprovalMutable

  return (
    <ToolingConsole
      client={client}
      route={route}
      tools={toolsForConsole}
      loading={viewState.loading}
      error={viewState.error}
      schedulerJobs={viewState.schedulerJobs}
      schedulerLoading={viewState.schedulerLoading}
      schedulerError={viewState.schedulerError}
      selectedProviders={viewState.selectedProviders}
      decisionMessages={viewState.decisionMessages}
      nativePlatform={nativePlatform}
      policySummary={viewState.policySummary}
      sourceSummaries={viewState.sourceSummaries}
      sourceDetails={viewState.sourceDetails}
      grants={viewState.grants}
      pendingApprovals={viewState.pendingApprovals}
      auditEvents={viewState.auditEvents}
      builtinPlugins={viewState.builtinPlugins}
      managementLoading={viewState.managementLoading || scopedLocalApprovalLoading}
      managementError={scopedLocalApprovalError ?? viewState.managementError}
      sharingPolicy={viewState.sharingPolicy}
      sharingPeers={viewState.sharingPeers}
      sharingDecisions={viewState.sharingDecisions}
      sharingLoading={viewState.sharingLoading}
      sharingError={viewState.sharingError}
      sharingMessage={viewState.sharingMessage}
      sharingPendingKey={viewState.sharingPendingKey}
      {...(localFeatureSharing || managementEnabled
        ? { onMutateSharing: (mutation: ToolSharingMutation) => { void mutateSharing(mutation) } }
        : {})}
      sourceManagementEnabled={managementEnabled}
      sourceConfiguredTrustTiers={sourceConfiguredTrustTiers}
      localApprovalPolicyOnly={Boolean(localToolApprovalPolicy)}
      {...(approvalPolicyMutable ? {
        onUpsertSourcePolicy: upsertSourcePolicy,
        onUpsertToolOverride: upsertToolOverride,
      } : {})}
      {...(managementEnabled ? {
        onTogglePlugin: togglePlugin,
        onSavePluginConfig: savePluginConfig,
        onSetPolicyMode: setPolicyMode,
        onRevokeGrant: revokeGrant,
        onTestSource: testSource,
        onCreateSource: createSource,
      } : {})}
      onSelectProvider={selectProvider}
      onApprove={approve}
      onDeny={deny}
      onExecuteSafe={executeSafe}
    />
  )
}

type LocalToolSharingManagement = Pick<
  ToolApprovalPanelManagementState,
  'sharingPolicy' | 'sharingPeers' | 'sharingDecisions'
>

function localApprovalTrustTier(value: string): LocalToolApprovalTrustTier {
  if (value === 'trusted' || value === 'untrusted' || value === 'blocked') return value
  throw new Error('This approval choice is unavailable.')
}

function applyLocalToolApprovalPolicies(
  tools: readonly ToolApprovalCardModel[],
  snapshot: LocalToolApprovalPolicySnapshot | null,
): ToolApprovalCardModel[] {
  if (!snapshot) return [...tools]
  const sourcePolicies = new Map(
    snapshot.sourcePolicies.map((policy) => [policy.sourceId, policy] as const),
  )
  const toolPolicies = new Map<string, LocalToolApprovalTrustTier>()
  for (const policy of snapshot.toolPolicies) {
    toolPolicies.set(policy.toolContractId, policy.trustTier)
    toolPolicies.set(policy.globalToolId, policy.trustTier)
    toolPolicies.set(policy.localToolName, policy.trustTier)
  }
  return tools.map((tool) => {
    if (isRemoteApprovalTool(tool)) return tool
    const configuredTrustTier = [tool.toolContractId, tool.id, tool.localToolName]
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => toolPolicies.get(candidate))
      .find((candidate): candidate is LocalToolApprovalTrustTier => Boolean(candidate)) ?? null
    const sourcePolicy = sourcePolicies.get(localApprovalSourceId(tool))
    const sourcePolicyApplies = sourcePolicy
      ? sourcePolicy.includeFutureTools
        || Boolean(
          tool.toolContractId
          && sourcePolicy.knownToolContractIds?.includes(tool.toolContractId),
        )
      : false
    const sourceTrustTier = sourcePolicy
      ? sourcePolicyApplies
        ? sourcePolicy.trustTier
        : 'untrusted'
      : null
    const trustTier = configuredTrustTier ?? sourceTrustTier ?? tool.trustTier
    return {
      ...tool,
      configuredTrustTier,
      trustTier,
      approvalRequired: trustTier === 'untrusted'
        ? true
        : trustTier === 'trusted'
          ? mandatoryLocalToolApproval(tool)
          : tool.approvalRequired,
    }
  })
}

function localApprovalSourceId(tool: ToolApprovalCardModel): string {
  return tool.shareGroupId?.trim()
    || tool.sourceId?.trim()
    || tool.sourceType?.trim()
    || 'local'
}

function isRemoteApprovalTool(tool: ToolApprovalCardModel): boolean {
  return tool.sourceType === 'mesh' || tool.sourceType === 'mesh_peer'
    || /mesh|remote/i.test(tool.providerKind)
}

function mandatoryLocalToolApproval(tool: ToolApprovalCardModel): boolean {
  const risk = tool.riskClass.toLowerCase()
  return tool.requiresAdminAction
    || tool.mutating
    || tool.dataEgress
    || ['dangerous', 'sensitive', 'admin', 'admin-critical', 'mutating', 'external'].includes(risk)
    || (tool.approvalRequired && tool.trustTier === 'trusted')
}

export function buildLocalToolSharingManagement(
  snapshot: LocalFeatureSharingSnapshot,
  tools: readonly ToolApprovalCardModel[],
): LocalToolSharingManagement {
  const localTools = exportableToolApprovalLocalTools([...tools])
  const features = new Map(snapshot.features.map((feature) => [feature.id, feature]))
  const peers: ToolExportScopeModel[] = snapshot.approvedDevices.map((peer) => ({
    peerId: peer.peerId,
    label: peer.peerLabel,
    stale: false,
  }))
  const rules: ToolExportPolicyModel['rules'] = []
  const decisions: Record<string, ToolExportDecisionModel | null> = {}
  const toolRules = new Map<string, ToolExportPolicyModel['rules']>()
  const groupTools = new Map<string, ToolApprovalCardModel[]>()
  const now = Date.now() / 1000

  for (const tool of localTools) {
    const featureId = localToolFeatureId(tool)
    const feature = featureId ? features.get(featureId) : undefined
    const enabled = feature?.available === true && feature.enabled
    const sharedPeerIds = enabled && featureId
      ? snapshot.approvedDevices
          .filter((peer) => peer.featureIds.includes(featureId))
          .map((peer) => peer.peerId)
      : []
    const allApproved = enabled && (
      snapshot.approvedDevices.length === 0
      || sharedPeerIds.length === snapshot.approvedDevices.length
    )
    const scopedRules: ToolExportPolicyModel['rules'] = allApproved
      ? [localSharingRule('tool', tool.id, null, 'shared', now)]
      : [
          localSharingRule('tool', tool.id, null, 'unshared', now),
          ...sharedPeerIds.map((peerId) => localSharingRule('tool', tool.id, peerId, 'shared', now)),
        ]
    toolRules.set(tool.id, scopedRules)
    rules.push(...scopedRules)
    decisions[tool.id] = {
      effectiveState: enabled ? 'shared' : 'unshared',
      inheritedFrom: 'global_tool',
      inheritedFromLabel: 'Tool setting',
      matchedRuleId: scopedRules[0]?.id ?? null,
      peerId: null,
      globalToolId: tool.id,
      shareGroupId: tool.shareGroupId ?? '',
      exportable: true,
      staleToolId: false,
      staleGroupId: false,
      prerequisites: [],
      policyRevision: localToolSharingRevision(snapshot),
      reasonCode: enabled ? 'shared' : 'unshared',
    }
    if (tool.shareGroupId) {
      const grouped = groupTools.get(tool.shareGroupId) ?? []
      grouped.push(tool)
      groupTools.set(tool.shareGroupId, grouped)
    }
  }

  for (const [groupId, grouped] of groupTools) {
    const signatures = grouped.map((tool) => JSON.stringify(
      (toolRules.get(tool.id) ?? []).map((rule) => [rule.peerId, rule.state]),
    ))
    if (new Set(signatures).size !== 1) continue
    const template = toolRules.get(grouped[0]!.id) ?? []
    rules.push(...template.map((rule) => localSharingRule(
      'group',
      groupId,
      rule.peerId,
      rule.state,
      now,
    )))
  }

  const revision = localToolSharingRevision(snapshot)
  const allPeers: ToolExportScopeModel = { peerId: null, label: 'All peers', stale: false }
  return {
    sharingPolicy: {
      scope: allPeers,
      scopes: [allPeers, ...peers],
      defaultState: 'unshared',
      revision,
      initialized: true,
      migratedFromLegacy: false,
      updatedAt: now,
      rules,
      staleToolIds: [],
      staleGroupIds: [],
      protocolTier: 'projection_v1',
      providerEnabled: true,
      consumerEnabled: true,
      enforcementActive: true,
      switchRevision: revision,
      secretsRedacted: true,
    },
    sharingPeers: peers,
    sharingDecisions: decisions,
  }
}

export async function applyLocalToolSharingMutation(
  port: LocalFeatureSharingPort,
  snapshot: LocalFeatureSharingSnapshot,
  tools: readonly ToolApprovalCardModel[],
  mutation: ToolSharingMutation,
): Promise<void> {
  const localTools = exportableToolApprovalLocalTools([...tools])
  const selectedTools = mutation.scopeType === 'tool'
    ? localTools.filter((tool) => tool.id === mutation.scopeId)
    : localTools.filter((tool) => tool.shareGroupId === mutation.scopeId)
  const availableFeatureIds = new Set(
    snapshot.features
      .filter((feature) => feature.available)
      .map((feature) => feature.id),
  )
  const featureIds = [...new Set(selectedTools
    .map(localToolFeatureId)
    .filter((featureId): featureId is string => Boolean(featureId) && availableFeatureIds.has(featureId!)))]
  if (featureIds.length === 0) throw new Error('This tool is unavailable on this device.')

  const share = mutation.mode === 'shared'
  for (const featureId of featureIds) {
    const current = snapshot.features.find((feature) => feature.id === featureId)
    if (current?.enabled !== share) await port.setFeatureEnabled(featureId, share)
  }

  const selectedPeers = new Set(mutation.peerIds.filter((peerId): peerId is string => peerId !== null))
  const allPeers = mutation.peerIds.includes(null)
  for (const peer of snapshot.approvedDevices) {
    const next = new Set(peer.featureIds)
    const include = share && (allPeers || selectedPeers.has(peer.peerId))
    for (const featureId of featureIds) {
      if (include) next.add(featureId)
      else next.delete(featureId)
    }
    const nextFeatureIds = [...next].sort()
    if (sameStringList(nextFeatureIds, [...peer.featureIds].sort())) continue
    await port.replacePeerSharing(peer.peerId, nextFeatureIds, peer.expiresAtMs)
  }
}

function localSharingRule(
  scopeType: 'group' | 'tool',
  scopeId: string,
  peerId: string | null,
  state: 'shared' | 'unshared',
  timestamp: number,
): ToolExportPolicyModel['rules'][number] {
  return {
    id: `local:${scopeType}:${scopeId}:${peerId ?? 'all'}`,
    peerId,
    scopeType,
    scopeId,
    state,
    actorPrincipalId: 'this-device',
    reason: 'Saved on this device',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function localToolFeatureId(tool: ToolApprovalCardModel): string | null {
  return tool.toolContractId?.trim() || null
}

function localToolSharingRevision(snapshot: LocalFeatureSharingSnapshot): number {
  let revision = snapshot.features.length + snapshot.approvedDevices.length
  snapshot.features.forEach((feature, index) => {
    if (feature.available) revision += index + 1
    if (feature.enabled) revision += (index + 1) * 17
  })
  snapshot.approvedDevices.forEach((peer, index) => {
    revision += (index + 1) * (peer.featureIds.length + 1)
  })
  return revision
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function policyConfirmationText(policyMode: string): string | null {
  if (policyMode === 'unrestricted_except_blocked') return 'ALLOW NON-BLOCKED TOOLS'
  if (policyMode === 'deny_all') return 'DENY ALL TOOLS'
  if (policyMode === 'dry_run_only') return 'DRY RUN ONLY'
  return null
}

export function submitToolDenialAction({
  client,
  tool,
  selectedProviderId,
  reason = `Denied ${tool.name} from Aurora UI`,
  signal
}: ToolDenialActionInput): Promise<ToolApprovalDecisionResult> {
  const request = {
    tool,
    approverPrincipalId: client.auth.snapshot().principalId ?? 'current-principal',
    reason
  }
  return client.tools.submitDenialDecision(selectedProviderId ? { ...request, selectedProviderId } : request, signal ? { signal } : {})
}

export function buildToolCategories(tools: ToolApprovalCardModel[]) {
  return [
    { id: 'all', label: 'All', count: tools.length },
    { id: 'read', label: 'Read-only', count: tools.filter((tool) => toolCategory(tool) === 'read').length },
    { id: 'mutating', label: 'Mutating', count: tools.filter((tool) => toolCategory(tool) === 'mutating').length },
    { id: 'external', label: 'External', count: tools.filter((tool) => toolCategory(tool) === 'external').length },
    { id: 'admin', label: 'Admin', count: tools.filter((tool) => toolCategory(tool) === 'admin').length }
  ]
}

export function filterTools(tools: ToolApprovalCardModel[], category: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  return tools.filter((tool) => {
    const categoryMatch = category === 'all' || toolCategory(tool) === category
    if (!categoryMatch) return false
    if (!normalizedQuery) return true
    return toolSearchHaystack(tool).includes(normalizedQuery)
  })
}

function toolCategory(tool: ToolApprovalCardModel) {
  if (tool.riskClass === 'external' || tool.providerKind === 'cloud' || tool.transport === 'mcp') return 'external'
  if (tool.requiresAdminAction || tool.riskClass.includes('admin')) return 'admin'
  if (tool.dataEgress) return 'external'
  if (tool.mutating || tool.riskClass === 'mutating') return 'mutating'
  return 'read'
}

function toolSearchHaystack(tool: ToolApprovalCardModel) {
  return [
    tool.name,
    tool.description,
    tool.providerLabel,
    tool.providerKind,
    tool.riskClass,
    tool.state,
    tool.routePath.join(' '),
    tool.requiredPermissions.join(' '),
    tool.providers.map((provider) => `${provider.label} ${provider.providerKind} ${provider.transport ?? ''}`).join(' ')
  ].join(' ').toLowerCase()
}

function desiredSharingRules(mutation: ToolSharingMutation): Array<{ peerId: string | null; state: 'shared' | 'unshared' }> {
  if (mutation.mode === 'inherit') return []
  if (mutation.mode === 'unshared') return [{ peerId: null, state: 'unshared' }]
  if (mutation.peerIds.includes(null)) return [{ peerId: null, state: 'shared' }]
  return [
    { peerId: null, state: 'unshared' },
    ...mutation.peerIds
      .filter((peerId): peerId is string => peerId !== null)
      .map((peerId) => ({ peerId, state: 'shared' as const }))
  ]
}

function applyOptimisticSharingMutation(
  policy: ToolExportPolicyModel,
  mutation: ToolSharingMutation,
  actorPrincipalId: string,
  reason: string
): ToolExportPolicyModel {
  const retainedRules = policy.rules.filter((rule) => (
    rule.scopeType !== mutation.scopeType || rule.scopeId !== mutation.scopeId
  ))
  const now = Date.now() / 1000
  const rules = desiredSharingRules(mutation).map(({ peerId, state }) => ({
    id: `optimistic:${mutation.scopeType}:${mutation.scopeId}:${peerId ?? 'all'}`,
    peerId,
    scopeType: mutation.scopeType,
    scopeId: mutation.scopeId,
    state,
    actorPrincipalId,
    reason,
    createdAt: now,
    updatedAt: now
  }))
  return {
    ...policy,
    rules: [...retainedRules, ...rules],
    updatedAt: now
  }
}

function sharingMutationReason(mutation: ToolSharingMutation, peers: ToolExportScopeModel[]): string {
  if (mutation.mode === 'inherit') return `Inherit ${mutation.scopeType} ${mutation.scopeId} sharing from Aurora UI`
  if (mutation.mode === 'unshared') return `Do not share ${mutation.scopeType} ${mutation.scopeId} with mesh peers from Aurora UI`
  if (mutation.peerIds.includes(null)) return `Share ${mutation.scopeType} ${mutation.scopeId} with all otherwise-authorized peers from Aurora UI`
  const labels = mutation.peerIds
    .filter((peerId): peerId is string => peerId !== null)
    .map((peerId) => peers.find((peer) => peer.peerId === peerId)?.label ?? peerId)
  return `Share ${mutation.scopeType} ${mutation.scopeId} with ${labels.join(', ')} from Aurora UI`
}

function productToolErrorCopy(error: unknown): string {
  return safeErrorCopy(error).title
}

function denialResultMessage(result: ToolApprovalDecisionResult): string {
  const correlation = result.correlationId ?? 'pending'
  const policy = result.policyDecisionId ? `, policy ${result.policyDecisionId}` : ''
  return `Denied with correlation ${correlation}${policy}`
}

function sourceResultMessage(kind: 'mcp' | 'plugin', result: ToolOnboardingValidationResult): string {
  const label = kind === 'mcp' ? 'MCP source' : 'Plugin source'
  if (result.status === 'unsupported') return `${label} is not available in this Aurora version yet.`
  if (result.ok) return `${label} is ready to review.`
  return `${label} needs attention. Check the details and try again.`
}
