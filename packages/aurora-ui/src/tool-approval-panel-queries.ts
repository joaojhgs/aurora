'use client'

import { useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  normalizeToolCatalog,
  type AuroraClient,
  type NormalizedSchedulerJob,
  type ToolApprovalCardModel,
  type ToolApprovalGrantModel,
  type ToolExportDecisionModel,
  type ToolExportPolicyModel,
  type ToolExportScopeModel,
  type ToolPendingApprovalModel,
  type ToolPolicyAuditEventModel,
  type ToolSourceDetailModel,
  type ToolSourceSummaryModel,
  type ToolingPageViewModel,
  type ToolCatalogResponse,
} from '@aurora/client'
import { AURORA_QUERY_STALE_TIMES } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import { safeErrorCopy } from './product-copy'
import type { RouteAvailability } from './shell-data'
import { buildBuiltinPlugins, type BuiltinPluginModel } from './tooling'

export interface ToolApprovalPanelServerState {
  tools: ToolApprovalCardModel[]
  loading: boolean
  error: string | null
  schedulerJobs: NormalizedSchedulerJob[]
  schedulerLoading: boolean
  schedulerError: string | null
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
}

export type ToolApprovalInitialManagementState = Partial<Pick<
  ToolApprovalPanelServerState,
  | 'policySummary'
  | 'sourceSummaries'
  | 'sourceDetails'
  | 'grants'
  | 'pendingApprovals'
  | 'auditEvents'
  | 'builtinPlugins'
  | 'managementLoading'
  | 'managementError'
  | 'sharingPolicy'
  | 'sharingPeers'
  | 'sharingDecisions'
  | 'sharingLoading'
  | 'sharingError'
>> & { sharingMessage?: string | null }

interface ToolApprovalCardsData {
  tools: ToolApprovalCardModel[]
}

interface ToolApprovalSchedulerData {
  jobs: NormalizedSchedulerJob[]
}

export interface ToolApprovalManagementData extends Omit<ToolApprovalPanelServerState, 'tools' | 'loading' | 'error' | 'schedulerJobs' | 'schedulerLoading' | 'schedulerError'> {}

export interface UseToolApprovalPanelQueryGroupsInput {
  client: AuroraClient
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
  initialSchedulerJobs?: NormalizedSchedulerJob[] | undefined
  initialManagementState?: ToolApprovalInitialManagementState | undefined
  managementEnabled: boolean
  serverDataEnabled?: boolean | undefined
}

export function useToolApprovalPanelQueryGroups({
  client,
  route,
  initialTools,
  initialSchedulerJobs,
  initialManagementState,
  managementEnabled,
  serverDataEnabled = true,
}: UseToolApprovalPanelQueryGroupsInput) {
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const rootScopeKey = JSON.stringify(queryKeys.root())
  const initialRootScopeKey = useRef(rootScopeKey)
  const initialDataAllowed = rootScopeKey === initialRootScopeKey.current
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const routeScope = useMemo(() => ({
    routeId: route.item.id,
    routeState: route.state,
    routeDisabled: route.disabled,
    managementEnabled,
    serverDataEnabled,
  }), [managementEnabled, route.disabled, route.item.id, route.state, serverDataEnabled])
  const approvalCardsQueryKey = useMemo(() => queryKeys.admin('tool-approval-cards', routeScope), [queryKeys, routeScope])
  const schedulerQueryKey = useMemo(() => queryKeys.admin('tool-approval-scheduler-preview', routeScope), [queryKeys, routeScope])
  const managementQueryKey = useMemo(() => queryKeys.admin('tool-approval-management', routeScope), [queryKeys, routeScope])
  const initialManagementDataAllowed = initialDataAllowed
    && initialManagementState !== undefined
    && initialManagementState.managementLoading !== true
    && initialManagementState.sharingLoading !== true
  const initialManagementData = useMemo(
    () => initialManagementStateToQueryData(initialManagementState, managementEnabled),
    [initialManagementState, managementEnabled],
  )

  const approvalCardsQuery = useQuery<ToolApprovalCardsData, unknown>({
    queryKey: approvalCardsQueryKey,
    enabled: serverDataEnabled && !route.disabled,
    ...(initialDataAllowed && initialTools ? { initialData: { tools: initialTools } } : {}),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    queryFn: async ({ signal }) => ({ tools: await fetchToolApprovalCards(client, signal) }),
  })

  const schedulerQuery = useQuery<ToolApprovalSchedulerData, unknown>({
    queryKey: schedulerQueryKey,
    enabled: serverDataEnabled && !route.disabled,
    ...(initialDataAllowed && initialSchedulerJobs ? { initialData: { jobs: initialSchedulerJobs } } : {}),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    queryFn: async ({ signal }) => ({ jobs: await fetchToolApprovalSchedulerPreview(client, signal) }),
  })

  const managementQuery = useQuery<ToolApprovalManagementData, unknown>({
    queryKey: managementQueryKey,
    enabled: serverDataEnabled && !route.disabled && managementEnabled,
    ...(initialManagementDataAllowed ? { initialData: initialManagementData } : {}),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
    queryFn: ({ signal }) => fetchToolApprovalManagement(client, signal),
  })

  const state = useMemo<ToolApprovalPanelServerState>(() => {
    const emptyManagement = initialManagementStateToQueryData(undefined, false)
    if (route.disabled || !serverDataEnabled) {
      return {
        tools: [],
        loading: false,
        error: null,
        schedulerJobs: [],
        schedulerLoading: false,
        schedulerError: null,
        ...emptyManagement,
      }
    }
    const cards = approvalCardsQuery.data?.tools ?? (initialDataAllowed ? initialTools ?? [] : [])
    const schedulerJobs = schedulerQuery.data?.jobs ?? (initialDataAllowed ? initialSchedulerJobs ?? [] : [])
    const management = managementQuery.data ?? (initialDataAllowed ? initialManagementData : emptyManagement)
    return {
      tools: cards,
      loading: approvalCardsQuery.isPending,
      error: approvalCardsQuery.error ? productToolQueryErrorCopy(approvalCardsQuery.error) : null,
      schedulerJobs,
      schedulerLoading: schedulerQuery.isPending,
      schedulerError: schedulerQuery.error ? productToolQueryErrorCopy(schedulerQuery.error) : null,
      policySummary: management.policySummary,
      sourceSummaries: management.sourceSummaries,
      sourceDetails: management.sourceDetails,
      grants: management.grants,
      pendingApprovals: management.pendingApprovals,
      auditEvents: management.auditEvents,
      builtinPlugins: management.builtinPlugins,
      managementLoading: managementEnabled && managementQuery.isPending,
      managementError: managementQuery.error ? productToolQueryErrorCopy(managementQuery.error) : management.managementError,
      sharingPolicy: management.sharingPolicy,
      sharingPeers: management.sharingPeers,
      sharingDecisions: management.sharingDecisions,
      sharingLoading: managementEnabled && managementQuery.isPending,
      sharingError: managementQuery.error ? productToolQueryErrorCopy(managementQuery.error) : management.sharingError,
    }
  }, [approvalCardsQuery.data, approvalCardsQuery.error, approvalCardsQuery.isPending, initialDataAllowed, initialManagementData, initialManagementDataAllowed, initialSchedulerJobs, initialTools, managementEnabled, managementQuery.data, managementQuery.error, managementQuery.isPending, route.disabled, schedulerQuery.data, schedulerQuery.error, schedulerQuery.isPending, serverDataEnabled])

  return {
    state,
    scopeKey: rootScopeKey,
    approvalCardsQueryKey,
    schedulerQueryKey,
    managementQueryKey,
    invalidateApprovalCards: () => queryClient.invalidateQueries({ queryKey: approvalCardsQueryKey }),
    invalidateSchedulerPreview: () => queryClient.invalidateQueries({ queryKey: schedulerQueryKey }),
    invalidateManagement: () => queryClient.invalidateQueries({ queryKey: managementQueryKey }),
    refetchManagement: () => queryClient.refetchQueries({ queryKey: managementQueryKey, type: 'active' }),
  }
}

export async function fetchToolApprovalCards(client: AuroraClient, signal?: AbortSignal): Promise<ToolApprovalCardModel[]> {
  throwToolApprovalAbortIfRequested(signal)
  const catalog = await client.tools.listCatalog<ToolCatalogResponse>({}, signal ? { signal } : {})
  throwToolApprovalAbortIfRequested(signal)
  return normalizeToolCatalog(catalog, { transportKind: client.transport.kind })
}

export async function fetchToolApprovalSchedulerPreview(client: AuroraClient, signal?: AbortSignal): Promise<NormalizedSchedulerJob[]> {
  throwToolApprovalAbortIfRequested(signal)
  const jobs = await client.scheduler.listNormalizedJobs({ limit: 5 }, signal ? { signal } : {})
  throwToolApprovalAbortIfRequested(signal)
  return jobs
}

export async function fetchToolApprovalManagement(client: AuroraClient, signal?: AbortSignal): Promise<ToolApprovalManagementData> {
  throwToolApprovalAbortIfRequested(signal)
  const signalOptions = signal ? { signal } : {}
  const [policySummary, sourceSummaries, grants, pendingApprovals, auditEvents, pluginMetadata, sharingResult, peerResponse] = await Promise.all([
    client.tools.getPolicySummary(signalOptions),
    client.tools.listSources(signalOptions),
    client.tools.listNormalizedGrants({ include_revoked: true }, signalOptions),
    client.tools.listPendingApprovals({ status: 'pending' }, signalOptions),
    client.tools.listPolicyAuditEvents({ limit: 100 }, signalOptions),
    client.config.getSchemaMetadata({ include_values: true }, signalOptions).catch(() => null),
    client.tools.getToolExportPolicyModel({}, { label: 'All peers' }, signalOptions)
      .then((policy) => ({ policy, error: null as string | null }))
      .catch((error) => ({ policy: null, error: productToolQueryErrorCopy(error) })),
    client.mesh.listPeers({ include_disconnected: true }, signalOptions).catch(() => null),
  ])
  throwToolApprovalAbortIfRequested(signal)
  const detailResults = await Promise.all(sourceSummaries.map(async (source) => {
    try {
      return { sourceId: source.id, detail: await client.tools.getSourceDetail(source.id, signalOptions), error: null as string | null }
    } catch (error) {
      return { sourceId: source.id, detail: null, error: productToolQueryErrorCopy(error) }
    }
  }))
  throwToolApprovalAbortIfRequested(signal)
  const detailErrors = detailResults.filter((result) => result.error)
  const liveSharingPeers = peerResponse?.ok
    ? peerResponse.data.peers.map((peer) => ({ peerId: peer.peer_id, label: peer.node_name || 'Name unavailable', stale: false }))
    : []
  const sharingPeers = mergeToolApprovalSharingScopes(liveSharingPeers, sharingResult.policy)
  const exportTools = exportableToolApprovalLocalTools(detailResults.flatMap((result) => result.detail?.tools ?? []))
  const decisionEntries = await Promise.all(exportTools.map(async (tool) => {
    try {
      const decision = await client.tools.previewToolExportDecisionModel({
        global_tool_id: tool.id,
        share_group_id: tool.shareGroupId ?? null,
        peer_id: null,
      }, signalOptions)
      return [tool.id, decision] as const
    } catch {
      return [tool.id, null] as const
    }
  }))
  throwToolApprovalAbortIfRequested(signal)

  return {
    policySummary,
    sourceSummaries,
    sourceDetails: Object.fromEntries(detailResults.map((result) => [result.sourceId, result.detail])),
    grants,
    pendingApprovals,
    auditEvents,
    builtinPlugins: pluginMetadata?.ok ? buildBuiltinPlugins(pluginMetadata.data?.fields ?? []) : [],
    managementLoading: false,
    managementError: detailErrors.length > 0 ? 'Some tool sources could not be loaded. Try again.' : null,
    sharingPolicy: sharingResult.policy,
    sharingPeers,
    sharingDecisions: Object.fromEntries(decisionEntries),
    sharingLoading: false,
    sharingError: sharingResult.error ?? (peerResponse && !peerResponse.ok ? peerResponse.error.message : null),
  }
}

export function exportableToolApprovalLocalTools(tools: readonly ToolApprovalCardModel[]): ToolApprovalCardModel[] {
  return [...new Map(tools
    .filter((tool) => tool.exportable === true && tool.sourceType !== 'mesh_peer' && !/mesh|remote/i.test(tool.providerKind))
    .map((tool) => [tool.id, tool] as const)).values()]
}

export function mergeToolApprovalSharingScopes(liveScopes: ToolExportScopeModel[], policy: ToolExportPolicyModel | null): ToolExportScopeModel[] {
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

function initialManagementStateToQueryData(initial: ToolApprovalInitialManagementState | undefined, managementEnabled: boolean): ToolApprovalManagementData {
  return {
    policySummary: initial?.policySummary ?? null,
    sourceSummaries: initial?.sourceSummaries ?? [],
    sourceDetails: initial?.sourceDetails ?? {},
    grants: initial?.grants ?? [],
    pendingApprovals: initial?.pendingApprovals ?? [],
    auditEvents: initial?.auditEvents ?? [],
    builtinPlugins: initial?.builtinPlugins ?? [],
    managementLoading: initial?.managementLoading ?? (!initial && managementEnabled),
    managementError: initial?.managementError ?? null,
    sharingPolicy: initial?.sharingPolicy ?? null,
    sharingPeers: mergeToolApprovalSharingScopes(initial?.sharingPeers ?? [], initial?.sharingPolicy ?? null),
    sharingDecisions: initial?.sharingDecisions ?? {},
    sharingLoading: initial?.sharingLoading ?? (!initial && managementEnabled),
    sharingError: initial?.sharingError ?? null,
  }
}

function productToolQueryErrorCopy(error: unknown): string {
  return safeErrorCopy(error).title
}

function throwToolApprovalAbortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Tool approval request was cancelled', 'AbortError')
}
