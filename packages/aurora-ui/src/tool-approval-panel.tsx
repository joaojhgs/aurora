'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AuroraClient,
  AuroraResponse,
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
import { buildBuiltinPlugins, ToolingConsole, type BuiltinPluginModel, type ToolSharingMutation } from './tooling'

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

export function ToolApprovalPanel({ client, route, initialTools, initialSchedulerJobs, nativePlatform, initialManagementState, localFeatureSharing, localToolApprovalPolicy, sourceManagementEnabled = true }: ToolApprovalPanelProps) {
  const sharingRequestGeneration = useRef(0)
  const managementEnabled = sourceManagementEnabled && !localFeatureSharing
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
    sharingPeers: mergeSharingScopes(initialManagementState?.sharingPeers ?? [], initialManagementState?.sharingPolicy ?? null),
    sharingDecisions: initialManagementState?.sharingDecisions ?? {},
    sharingLoading: initialManagementState?.sharingLoading ?? (!initialManagementState && managementEnabled),
    sharingError: initialManagementState?.sharingError ?? null,
    sharingMessage: initialManagementState?.sharingMessage ?? null,
    sharingPendingKey: null
  }))

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
    if (initialTools) return
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: null }))
    client.tools.loadApprovalCards().then((result) => {
      if (cancelled) return
      setState((current) => ({
        ...current,
        loading: false,
        tools: result.ok ? result.data : [],
        error: result.ok ? null : productToolResponseCopy(result)
      }))
    })
    return () => {
      cancelled = true
    }
  }, [client, initialTools])

  useEffect(() => {
    if (initialSchedulerJobs) return
    let cancelled = false
    setState((current) => ({ ...current, schedulerLoading: true, schedulerError: null }))
    client.scheduler.listNormalizedJobs({ limit: 5 }).then((jobs) => {
      if (cancelled) return
      setState((current) => ({ ...current, schedulerLoading: false, schedulerJobs: jobs, schedulerError: null }))
    }).catch((error) => {
      if (cancelled) return
      setState((current) => ({ ...current, schedulerLoading: false, schedulerJobs: [], schedulerError: productToolErrorCopy(error) }))
    })
    return () => {
      cancelled = true
    }
  }, [client, initialSchedulerJobs])

  useEffect(() => {
    if (initialManagementState || !managementEnabled) return
    let cancelled = false
    setState((current) => ({ ...current, managementLoading: true, managementError: null }))
    async function loadManagementState() {
      try {
        const [policySummary, sourceSummaries, grants, pendingApprovals, auditEvents, pluginMetadata, sharingResult, peerResponse] = await Promise.all([
          client.tools.getPolicySummary(),
          client.tools.listSources(),
          client.tools.listNormalizedGrants({ include_revoked: true }),
          client.tools.listPendingApprovals({ status: 'pending' }),
          client.tools.listPolicyAuditEvents({ limit: 100 }),
          client.config.getSchemaMetadata({ include_values: true }).catch(() => null),
          client.tools.getToolExportPolicyModel({}, { label: 'All peers' })
            .then((policy) => ({ policy, error: null as string | null }))
            .catch((error) => ({ policy: null, error: productToolErrorCopy(error) })),
          client.mesh.listPeers({ include_disconnected: true }).catch(() => null)
        ])
        const detailResults = await Promise.all(sourceSummaries.map(async (source) => {
          try {
            return { sourceId: source.id, detail: await client.tools.getSourceDetail(source.id), error: null as string | null }
          } catch (error) {
            return { sourceId: source.id, detail: null, error: productToolErrorCopy(error) }
          }
        }))
        const detailErrors = detailResults.filter((result) => result.error)
        const liveSharingPeers = peerResponse?.ok
          ? peerResponse.data.peers.map((peer) => ({ peerId: peer.peer_id, label: peer.node_name || 'Name unavailable', stale: false }))
          : []
        const sharingPeers = mergeSharingScopes(liveSharingPeers, sharingResult.policy)
        const exportTools = exportableLocalTools(detailResults.flatMap((result) => result.detail?.tools ?? []))
        const decisionEntries = await Promise.all(exportTools.map(async (tool) => {
          try {
            const decision = await client.tools.previewToolExportDecisionModel({
              global_tool_id: tool.id,
              share_group_id: tool.shareGroupId ?? null,
              peer_id: null
            })
            return [tool.id, decision] as const
          } catch {
            return [tool.id, null] as const
          }
        }))
        if (cancelled) return
        setState((current) => ({
          ...current,
          managementLoading: false,
          managementError: detailErrors.length > 0
            ? 'Some tool sources could not be loaded. Try again.'
            : null,
          policySummary,
          sourceSummaries,
          sourceDetails: Object.fromEntries(detailResults.map((result) => [result.sourceId, result.detail])),
          grants,
          pendingApprovals,
          auditEvents,
          builtinPlugins: pluginMetadata?.ok ? buildBuiltinPlugins(pluginMetadata.data?.fields ?? []) : [],
          sharingPolicy: sharingResult.policy,
          sharingPeers,
          sharingDecisions: Object.fromEntries(decisionEntries),
          sharingLoading: false,
          sharingError: sharingResult.error ?? (peerResponse && !peerResponse.ok ? peerResponse.error.message : null)
        }))
      } catch (error) {
        if (cancelled) return
        setState((current) => ({ ...current, managementLoading: false, managementError: productToolErrorCopy(error), sharingLoading: false, sharingError: productToolErrorCopy(error) }))
      }
    }
    void loadManagementState()
    return () => {
      cancelled = true
    }
  }, [client, initialManagementState, managementEnabled])

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
  }, [localToolApprovalPolicy])

  async function refreshSharing() {
    const generation = ++sharingRequestGeneration.current
    setState((current) => ({ ...current, sharingLoading: true, sharingError: null }))
    try {
      if (localFeatureSharing) {
        const snapshot = await localFeatureSharing.load()
        if (generation !== sharingRequestGeneration.current) return
        setState((current) => ({
          ...current,
          ...buildLocalToolSharingManagement(snapshot, current.tools),
          sharingLoading: false,
          sharingError: null,
        }))
        return
      }
      const policy = await client.tools.getToolExportPolicyModel(
        { peer_id: null, include_rules: true, include_stale: true },
        { label: 'All peers', stale: false }
      )
      const detailedTools = Object.values(state.sourceDetails).flatMap((detail) => detail?.tools ?? [])
      const tools = exportableLocalTools(detailedTools.length > 0 ? detailedTools : state.tools)
      const entries = await Promise.all(tools.map(async (tool) => {
        try {
          return [tool.id, await client.tools.previewToolExportDecisionModel({ global_tool_id: tool.id, share_group_id: tool.shareGroupId ?? null, peer_id: null })] as const
        } catch {
          return [tool.id, null] as const
        }
      }))
      if (generation !== sharingRequestGeneration.current) return
      setState((current) => ({
        ...current,
        sharingPolicy: policy,
        sharingPeers: mergeSharingScopes(current.sharingPeers, policy),
        sharingDecisions: Object.fromEntries(entries),
        sharingLoading: false
      }))
    } catch (error) {
      if (generation !== sharingRequestGeneration.current) return
      setState((current) => ({ ...current, sharingLoading: false, sharingError: productToolErrorCopy(error) }))
    }
  }

  async function mutateSharing(mutation: ToolSharingMutation) {
    if (localFeatureSharing) {
      const pendingKey = `${mutation.scopeType}:${mutation.scopeId}`
      setState((current) => ({
        ...current,
        sharingPendingKey: pendingKey,
        sharingError: null,
        sharingMessage: 'Saving tool sharing…',
      }))
      try {
        const snapshot = await localFeatureSharing.load()
        await applyLocalToolSharingMutation(
          localFeatureSharing,
          snapshot,
          state.tools,
          mutation,
        )
        const next = await localFeatureSharing.load()
        setState((current) => ({
          ...current,
          ...buildLocalToolSharingManagement(next, current.tools),
          sharingPendingKey: null,
          sharingMessage: mutation.mode === 'shared'
            ? 'Tool sharing updated.'
            : 'Tool is not shared with approved devices.',
        }))
      } catch (error) {
        setState((current) => ({
          ...current,
          sharingPendingKey: null,
          sharingError: productToolErrorCopy(error),
          sharingMessage: null,
        }))
      }
      return
    }
    const currentPolicy = state.sharingPolicy
    if (!currentPolicy) {
      setState((current) => ({ ...current, sharingError: 'Sharing policy revision is unavailable; refresh before changing policy.' }))
      return
    }
    const pendingKey = `${mutation.scopeType}:${mutation.scopeId}`
    const actor = client.auth.snapshot().principalId ?? 'current-principal'
    const targetPeerIds = mutation.peerIds.includes(null) ? [null] : mutation.peerIds
    const reason = sharingMutationReason(mutation, state.sharingPeers)
    const optimisticPolicy = applyOptimisticSharingMutation(currentPolicy, mutation, actor, reason)
    setState((current) => ({
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
        const common = {
          expected_revision: revision,
          actor_principal_id: actor,
          reason,
          confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT
        }
        const response = desired
          ? mutation.scopeType === 'group'
            ? await client.tools.upsertToolGroupExportPolicy({ ...common, state: desired.state, share_group_id: mutation.scopeId, peer_id: peerId })
            : await client.tools.upsertToolExportOverride({ ...common, state: desired.state, global_tool_id: mutation.scopeId, peer_id: peerId })
          : await client.tools.clearToolExportOverride({ ...common, scope_type: mutation.scopeType, scope_id: mutation.scopeId, peer_id: peerId })
        if (!response.ok) throw new Error(response.error ?? 'Sharing policy mutation was rejected.')
        revision = response.revision
      }
      const knownTools = [
        ...Object.values(state.sourceDetails).flatMap((detail) => detail?.tools ?? []),
        ...state.tools
      ]
      const affectedTools = mutation.scopeType === 'tool'
        ? [{
            id: mutation.scopeId,
            shareGroupId: state.sharingDecisions[mutation.scopeId]?.shareGroupId
              ?? knownTools.find((tool) => tool.id === mutation.scopeId)?.shareGroupId
              ?? null
          }]
        : knownTools
            .filter((tool) => tool.shareGroupId === mutation.scopeId)
            .map((tool) => ({ id: tool.id, shareGroupId: tool.shareGroupId ?? null }))
      const uniqueAffectedTools = [...new Map(affectedTools.map((tool) => [tool.id, tool])).values()]
      const refreshedDecisionEntries = await Promise.all(uniqueAffectedTools.map(async (tool) => {
        try {
          const decision = await client.tools.previewToolExportDecisionModel({
            global_tool_id: tool.id,
            share_group_id: tool.shareGroupId,
            peer_id: null
          })
          return [tool.id, decision] as const
        } catch {
          return [tool.id, null] as const
        }
      }))
      const refreshedDecisions = Object.fromEntries(
        refreshedDecisionEntries.filter((entry): entry is readonly [string, ToolExportDecisionModel] => entry[1] !== null)
      )
      setState((current) => ({
        ...current,
        sharingPolicy: current.sharingPolicy
          ? { ...current.sharingPolicy, revision }
          : current.sharingPolicy,
        sharingDecisions: {
          ...current.sharingDecisions,
          ...refreshedDecisions
        },
        sharingPendingKey: null,
        sharingMessage: mutation.mode === 'inherit'
          ? 'Sharing now inherits from the next policy level.'
          : mutation.mode === 'shared'
            ? `Shared with ${targetPeerIds.includes(null) ? 'all peers' : `${targetPeerIds.length} selected peer${targetPeerIds.length === 1 ? '' : 's'}`}.`
            : 'Not shared with mesh peers.'
      }))
    } catch (error) {
      const message = productToolErrorCopy(error)
      await refreshSharing()
      setState((current) => ({ ...current, sharingPendingKey: null, sharingError: message, sharingMessage: 'Previous effective sharing policy remains in effect.' }))
    }
  }

  async function approve(tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun = false) {
    const selectedProviderId = state.selectedProviders[tool.id]
    setDecisionMessage(tool.id, dryRun ? 'Submitting dry-run approval...' : `Submitting ${scope} approval...`)
    try {
      const request = {
        tool,
        scope,
        approverPrincipalId: client.auth.snapshot().principalId ?? 'current-principal',
        reason: dryRun ? `Requested dry run for ${tool.name} from Aurora UI` : `Approved ${tool.name} from Aurora UI`,
        dryRun
      }
      const result = await client.tools.submitApprovalDecision(selectedProviderId ? { ...request, selectedProviderId } : request)
      setDecisionMessage(tool.id, `Approved with correlation ${result.correlationId ?? 'pending'}`)
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error))
    }
  }

  async function deny(tool: ToolApprovalCardModel) {
    const selectedProviderId = state.selectedProviders[tool.id]
    setDecisionMessage(tool.id, 'Sending denial...')
    try {
      const result = await submitToolDenialAction({
        client,
        tool,
        selectedProviderId,
        reason: `Denied ${tool.name} from Aurora UI`
      })
      setDecisionMessage(tool.id, denialResultMessage(result))
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error))
    }
  }

  async function executeSafe(tool: ToolApprovalCardModel) {
    setDecisionMessage(tool.id, 'Running local tool...')
    try {
      await client.tools.execute({
        tool_name: tool.id,
        arguments: {},
        mesh_selector: tool.meshSelector ?? null,
        resource_selector: tool.resourceSelector ?? null,
        confirmed: true,
        correlation_id: tool.correlationId ?? null
      })
      setDecisionMessage(tool.id, 'Local tool finished.')
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error))
    }
  }

  function setDecisionMessage(toolId: string, message: string) {
    setState((current) => ({
      ...current,
      decisionMessages: { ...current.decisionMessages, [toolId]: message }
    }))
  }

  function selectProvider(tool: ToolApprovalCardModel, providerId: string) {
    setState((current) => ({
      ...current,
      selectedProviders: { ...current.selectedProviders, [tool.id]: providerId }
    }))
  }

  async function refreshLocalApprovalPolicies() {
    if (!localToolApprovalPolicy) return
    const snapshot = await localToolApprovalPolicy.loadApprovalPolicies()
    setLocalApprovalPolicies(snapshot)
    setLocalApprovalError(snapshot.unavailable
      ? 'Tool approval settings are unavailable right now. Try again.'
      : null)
  }

  async function setPolicyMode(policyMode: string) {
    const requiredConfirmation = policyConfirmationText(policyMode)
    let confirmationText: string | null = null
    if (requiredConfirmation && typeof window !== 'undefined') {
      confirmationText = window.prompt(`Type ${requiredConfirmation} to set Tooling policy mode to ${policyMode}`)
    }
    if (requiredConfirmation && confirmationText !== requiredConfirmation) {
      setState((current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: `Policy mode ${policyMode} was not changed: confirmation text did not match.` } }))
      return
    }
    try {
      await client.tools.setPolicyMode({ policyMode, confirmationText, reason: `Set ${policyMode} from /tools` })
      const policySummary = await client.tools.getPolicySummary()
      setState((current) => ({ ...current, policySummary, decisionMessages: { ...current.decisionMessages, __policy__: `Policy set to ${policyMode}` } }))
    } catch (error) {
      setState((current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: productToolErrorCopy(error) } }))
    }
  }

  async function upsertSourcePolicy(source: { id: string; peerId: string | null; serviceInstanceId: string | null }, trustTier: string, includeFutureTools = false) {
    setDecisionMessage('__policy__', `Updating source policy for ${source.id}...`)
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
        await refreshLocalApprovalPolicies()
        setDecisionMessage('__policy__', `Default approval updated for ${source.id}.`)
        return
      }
      if (trustTier === 'inherit') {
        await client.tools.clearSourcePolicy({
          sourceId: source.id,
          reason: `Clear source ${source.id} policy to inherit from /tools`
        })
      } else {
        await client.tools.upsertSourcePolicy({
          sourceId: source.id,
          providerPeerId: source.peerId,
          providerServiceInstanceId: source.serviceInstanceId,
          trustTier,
          includeFutureTools,
          reason: `Set source ${source.id} to ${trustTier} from /tools`
        })
      }
      const [policySummary, sourceSummaries, cards, sourceDetail] = await Promise.all([
        client.tools.getPolicySummary(),
        client.tools.listSources(),
        client.tools.loadApprovalCards(),
        client.tools.getSourceDetail(source.id).catch(() => null)
      ])
      setState((current) => ({
        ...current,
        policySummary,
        sourceSummaries,
        tools: cards.ok ? cards.data : current.tools,
        sourceDetails: sourceDetail
          ? { ...current.sourceDetails, [source.id]: sourceDetail }
          : current.sourceDetails,
        decisionMessages: { ...current.decisionMessages, __policy__: `Source ${source.id} set to ${trustTier}` }
      }))
    } catch (error) {
      setDecisionMessage('__policy__', productToolErrorCopy(error))
    }
  }

  async function upsertToolOverride(tool: ToolApprovalCardModel, approvalMode: string) {
    setDecisionMessage(tool.id, `Updating policy override for ${tool.name}...`)
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
        await refreshLocalApprovalPolicies()
        setDecisionMessage(tool.id, `Approval updated for ${tool.name}.`)
        return
      }
      if (approvalMode === 'inherit') {
        await client.tools.clearToolOverride({
          toolId: tool.id,
          localToolName: tool.localToolName ?? tool.name,
          reason: `Clear ${tool.name} override to inherit from /tools`
        })
      } else {
        await client.tools.upsertToolOverride({
          toolId: tool.id,
          localToolName: tool.localToolName ?? tool.name,
          approvalMode,
          providerPeerId: tool.providerPeerId,
          providerServiceInstanceId: tool.serviceInstanceId,
          reason: `Set ${tool.name} override to ${approvalMode} from /tools`
        })
      }
      const sourceId = tool.sourceId ?? Object.entries(state.sourceDetails)
        .find(([, detail]) => detail?.tools.some((candidate) => candidate.id === tool.id))?.[0] ?? null
      const [cards, sourceSummaries, sourceDetail] = await Promise.all([
        client.tools.loadApprovalCards(),
        client.tools.listSources(),
        sourceId ? client.tools.getSourceDetail(sourceId).catch(() => null) : Promise.resolve(null)
      ])
      setState((current) => ({
        ...current,
        tools: cards.ok ? cards.data : current.tools,
        sourceSummaries,
        sourceDetails: sourceId && sourceDetail
          ? { ...current.sourceDetails, [sourceId]: sourceDetail }
          : current.sourceDetails,
        decisionMessages: { ...current.decisionMessages, [tool.id]: `Policy override updated to ${approvalMode}.` }
      }))
    } catch (error) {
      setDecisionMessage(tool.id, productToolErrorCopy(error))
    }
  }

  async function revokeGrant(grant: { id: string }) {
    setDecisionMessage('__policy__', `Revoking grant ${grant.id}...`)
    try {
      await client.tools.revokeGrant({ grant_id: grant.id, revoked_by: client.auth.snapshot().principalId ?? 'current-principal', reason: `Revoked ${grant.id} from /tools` })
      const grants = await client.tools.listNormalizedGrants({ include_revoked: true })
      setState((current) => ({ ...current, grants, decisionMessages: { ...current.decisionMessages, __policy__: `Grant ${grant.id} revoked` } }))
    } catch (error) {
      setDecisionMessage('__policy__', productToolErrorCopy(error))
    }
  }

  async function applyPluginConfigChanges(changes: { key_path: string; value: JsonValue }[], successMessage: string) {
    const diff = await client.config.previewDiff({ changes })
    if (!diff.ok || !diff.data?.valid) {
      throw new Error(diff.ok ? diff.data?.errors.join('; ') || 'Plugin config change was not valid.' : diff.error.message)
    }
    await client.config.previewReloadImpact({ changes })
    for (const change of changes) {
      await client.config.applyChange({
        change,
        reason: 'Update plugin settings from Aurora UI',
        reauthConfirmed: true
      })
    }
    const pluginMetadata = await client.config.getSchemaMetadata({ include_values: true }).catch(() => null)
    setState((current) => ({
      ...current,
      builtinPlugins: pluginMetadata?.ok ? buildBuiltinPlugins(pluginMetadata.data?.fields ?? []) : current.builtinPlugins,
      decisionMessages: { ...current.decisionMessages, __plugins__: successMessage }
    }))
  }

  async function togglePlugin(plugin: BuiltinPluginModel, active: boolean) {
    setDecisionMessage('__plugins__', `${active ? 'Activating' : 'Deactivating'} ${plugin.label}...`)
    try {
      await applyPluginConfigChanges(
        [{ key_path: plugin.activateKeyPath, value: active }],
        active ? `${plugin.label} is active. Review its tools before use.` : `${plugin.label} is inactive.`
      )
    } catch (error) {
      setDecisionMessage('__plugins__', productToolErrorCopy(error))
    }
  }

  async function savePluginConfig(plugin: BuiltinPluginModel, values: Record<string, JsonValue>) {
    const changes = Object.entries(values).map(([key_path, value]) => ({ key_path, value }))
    if (changes.length === 0) {
      setDecisionMessage('__plugins__', `No ${plugin.label} config changes to save.`)
      return
    }
    setDecisionMessage('__plugins__', `Saving ${plugin.label} configuration...`)
    try {
      await applyPluginConfigChanges(changes, `${plugin.label} settings saved.`)
    } catch (error) {
      setDecisionMessage('__plugins__', productToolErrorCopy(error))
    }
  }

  async function testSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    setDecisionMessage('__policy__', `Checking ${kind.toUpperCase()} source...`)
    try {
      const result = kind === 'mcp'
        ? await client.tools.testMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.testPluginSource(draft as PluginSourceWizardDraft)
      setDecisionMessage('__policy__', sourceResultMessage(kind, result))
      return result
    } catch (error) {
      const message = productToolErrorCopy(error)
      setDecisionMessage('__policy__', message)
      throw error
    }
  }

  async function createSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    setDecisionMessage('__policy__', `Saving ${kind.toUpperCase()} source...`)
    try {
      const result = kind === 'mcp'
        ? await client.tools.createMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.createPluginSource(draft as PluginSourceWizardDraft)
      setDecisionMessage('__policy__', sourceResultMessage(kind, result))
      return result
    } catch (error) {
      const message = productToolErrorCopy(error)
      setDecisionMessage('__policy__', message)
      throw error
    }
  }

  const toolsForConsole = useMemo(
    () => applyLocalToolApprovalPolicies(state.tools, localApprovalPolicies),
    [localApprovalPolicies, state.tools],
  )
  const sourceConfiguredTrustTiers = useMemo(
    () => Object.fromEntries(
      (localApprovalPolicies?.sourcePolicies ?? []).map((policy) => [policy.sourceId, policy.trustTier]),
    ),
    [localApprovalPolicies],
  )
  const localApprovalMutable = Boolean(
    localToolApprovalPolicy
    && localApprovalPolicies
    && !localApprovalPolicies.unavailable
    && !localApprovalLoading,
  )
  const approvalPolicyMutable = managementEnabled || localApprovalMutable

  return (
    <ToolingConsole
      client={client}
      route={route}
      tools={toolsForConsole}
      loading={state.loading}
      error={state.error}
      schedulerJobs={state.schedulerJobs}
      schedulerLoading={state.schedulerLoading}
      schedulerError={state.schedulerError}
      selectedProviders={state.selectedProviders}
      decisionMessages={state.decisionMessages}
      nativePlatform={nativePlatform}
      policySummary={state.policySummary}
      sourceSummaries={state.sourceSummaries}
      sourceDetails={state.sourceDetails}
      grants={state.grants}
      pendingApprovals={state.pendingApprovals}
      auditEvents={state.auditEvents}
      builtinPlugins={state.builtinPlugins}
      managementLoading={state.managementLoading || localApprovalLoading}
      managementError={localApprovalError ?? state.managementError}
      sharingPolicy={state.sharingPolicy}
      sharingPeers={state.sharingPeers}
      sharingDecisions={state.sharingDecisions}
      sharingLoading={state.sharingLoading}
      sharingError={state.sharingError}
      sharingMessage={state.sharingMessage}
      sharingPendingKey={state.sharingPendingKey}
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
  const localTools = exportableLocalTools([...tools])
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
  const localTools = exportableLocalTools([...tools])
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
  reason = `Denied ${tool.name} from Aurora UI`
}: ToolDenialActionInput): Promise<ToolApprovalDecisionResult> {
  const request = {
    tool,
    approverPrincipalId: client.auth.snapshot().principalId ?? 'current-principal',
    reason
  }
  return client.tools.submitDenialDecision(selectedProviderId ? { ...request, selectedProviderId } : request)
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

function exportableLocalTools(tools: ToolApprovalCardModel[]): ToolApprovalCardModel[] {
  return [...new Map(tools
    .filter((tool) => tool.exportable === true && tool.sourceType !== 'mesh_peer' && !/mesh|remote/i.test(tool.providerKind))
    .map((tool) => [tool.id, tool] as const)).values()]
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

function mergeSharingScopes(liveScopes: ToolExportScopeModel[], policy: ToolExportPolicyModel | null): ToolExportScopeModel[] {
  const merged = new Map<string, ToolExportScopeModel>()
  for (const scope of liveScopes) {
    if (scope.peerId) merged.set(scope.peerId, scope)
  }
  const durableScopes = policy?.scopes ?? []
  for (const scope of durableScopes) {
    if (!scope.peerId || merged.has(scope.peerId)) continue
    merged.set(scope.peerId, { ...scope, stale: true })
  }
  for (const rule of policy?.rules ?? []) {
    if (!rule.peerId || merged.has(rule.peerId)) continue
    merged.set(rule.peerId, { peerId: rule.peerId, label: 'Previously configured peer', stale: true })
  }
  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label) || (left.peerId ?? '').localeCompare(right.peerId ?? ''))
}

function productToolResponseCopy(result: AuroraResponse<unknown>): string {
  if (result.ok) return ''
  return safeErrorCopy(result.error).title
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
