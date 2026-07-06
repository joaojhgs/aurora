'use client'

import { useEffect, useState } from 'react'
import type {
  AuroraClient,
  AuroraResponse,
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
  ToolingPageViewModel
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { ToolingConsole } from './tooling'

export interface ToolApprovalPanelManagementState {
  policySummary?: ToolingPageViewModel['policy'] | null
  sourceSummaries?: ToolSourceSummaryModel[]
  sourceDetails?: Record<string, ToolSourceDetailModel | null>
  grants?: ToolApprovalGrantModel[]
  pendingApprovals?: ToolPendingApprovalModel[]
  auditEvents?: ToolPolicyAuditEventModel[]
  managementLoading?: boolean
  managementError?: string | null
}

export interface ToolApprovalPanelProps {
  client: AuroraClient
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
  initialSchedulerJobs?: NormalizedSchedulerJob[] | undefined
  nativePlatform?: string | undefined
  initialManagementState?: ToolApprovalPanelManagementState | undefined
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
  managementLoading: boolean
  managementError: string | null
}

export interface ToolDenialActionInput {
  client: AuroraClient
  tool: ToolApprovalCardModel
  selectedProviderId?: string | undefined
  reason?: string
}

export function ToolApprovalPanel({ client, route, initialTools, initialSchedulerJobs, nativePlatform, initialManagementState }: ToolApprovalPanelProps) {
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
    managementLoading: initialManagementState?.managementLoading ?? !initialManagementState,
    managementError: initialManagementState?.managementError ?? null
  }))

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
        error: result.ok ? null : toolErrorMessage(result)
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
      setState((current) => ({ ...current, schedulerLoading: false, schedulerJobs: [], schedulerError: errorMessage(error) }))
    })
    return () => {
      cancelled = true
    }
  }, [client, initialSchedulerJobs])

  useEffect(() => {
    if (initialManagementState) return
    let cancelled = false
    setState((current) => ({ ...current, managementLoading: true, managementError: null }))
    async function loadManagementState() {
      try {
        const [policySummary, sourceSummaries, grants, pendingApprovals, auditEvents] = await Promise.all([
          client.tools.getPolicySummary(),
          client.tools.listSources(),
          client.tools.listNormalizedGrants({ include_revoked: true }),
          client.tools.listPendingApprovals({ status: 'pending' }),
          client.tools.listPolicyAuditEvents({ limit: 100 })
        ])
        const detailResults = await Promise.all(sourceSummaries.map(async (source) => {
          try {
            return { sourceId: source.id, detail: await client.tools.getSourceDetail(source.id), error: null as string | null }
          } catch (error) {
            return { sourceId: source.id, detail: null, error: errorMessage(error) }
          }
        }))
        const detailErrors = detailResults.filter((result) => result.error)
        if (cancelled) return
        setState((current) => ({
          ...current,
          managementLoading: false,
          managementError: detailErrors.length > 0
            ? `Tooling.GetToolSourceDetail failed for ${detailErrors.map((result) => `${result.sourceId}: ${result.error}`).join('; ')}`
            : null,
          policySummary,
          sourceSummaries,
          sourceDetails: Object.fromEntries(detailResults.map((result) => [result.sourceId, result.detail])),
          grants,
          pendingApprovals,
          auditEvents
        }))
      } catch (error) {
        if (cancelled) return
        setState((current) => ({ ...current, managementLoading: false, managementError: errorMessage(error) }))
      }
    }
    void loadManagementState()
    return () => {
      cancelled = true
    }
  }, [client, initialManagementState])

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
      setDecisionMessage(tool.id, errorMessage(error))
    }
  }

  async function deny(tool: ToolApprovalCardModel) {
    const selectedProviderId = state.selectedProviders[tool.id]
    setDecisionMessage(tool.id, 'Submitting backend denial...')
    try {
      const result = await submitToolDenialAction({
        client,
        tool,
        selectedProviderId,
        reason: `Denied ${tool.name} from Aurora UI`
      })
      setDecisionMessage(tool.id, denialResultMessage(result))
    } catch (error) {
      setDecisionMessage(tool.id, errorMessage(error))
    }
  }

  async function executeSafe(tool: ToolApprovalCardModel) {
    setDecisionMessage(tool.id, 'Executing safe local tool through Tooling.ExecuteTool...')
    try {
      await client.tools.execute({
        tool_name: tool.id,
        arguments: {},
        mesh_selector: tool.meshSelector ?? null,
        resource_selector: tool.resourceSelector ?? null,
        confirmed: true,
        correlation_id: tool.correlationId ?? null
      })
      setDecisionMessage(tool.id, 'Executed safe local tool through Tooling.ExecuteTool.')
    } catch (error) {
      setDecisionMessage(tool.id, errorMessage(error))
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
      setState((current) => ({ ...current, decisionMessages: { ...current.decisionMessages, __policy__: errorMessage(error) } }))
    }
  }

  async function upsertSourcePolicy(source: { id: string; peerId: string | null; serviceInstanceId: string | null }, trustTier: string, includeFutureTools = false) {
    setDecisionMessage('__policy__', `Updating source policy for ${source.id}...`)
    try {
      await client.tools.upsertSourcePolicy({
        sourceId: source.id,
        providerPeerId: source.peerId,
        providerServiceInstanceId: source.serviceInstanceId,
        trustTier,
        includeFutureTools,
        reason: `Set source ${source.id} to ${trustTier} from /tools`
      })
      const [policySummary, sourceSummaries] = await Promise.all([client.tools.getPolicySummary(), client.tools.listSources()])
      setState((current) => ({ ...current, policySummary, sourceSummaries, decisionMessages: { ...current.decisionMessages, __policy__: `Source ${source.id} set to ${trustTier}` } }))
    } catch (error) {
      setDecisionMessage('__policy__', errorMessage(error))
    }
  }

  async function upsertToolOverride(tool: ToolApprovalCardModel, approvalMode: string) {
    setDecisionMessage(tool.id, `Updating policy override for ${tool.name}...`)
    try {
      await client.tools.upsertToolOverride({
        toolId: tool.id,
        approvalMode,
        providerPeerId: tool.providerPeerId,
        providerServiceInstanceId: tool.serviceInstanceId,
        reason: `Set ${tool.name} override to ${approvalMode} from /tools`
      })
      setDecisionMessage(tool.id, `Policy override updated to ${approvalMode}.`)
    } catch (error) {
      setDecisionMessage(tool.id, errorMessage(error))
    }
  }

  async function revokeGrant(grant: { id: string }) {
    setDecisionMessage('__policy__', `Revoking grant ${grant.id}...`)
    try {
      await client.tools.revokeGrant({ grant_id: grant.id, revoked_by: client.auth.snapshot().principalId ?? 'current-principal', reason: `Revoked ${grant.id} from /tools` })
      const grants = await client.tools.listNormalizedGrants({ include_revoked: true })
      setState((current) => ({ ...current, grants, decisionMessages: { ...current.decisionMessages, __policy__: `Grant ${grant.id} revoked` } }))
    } catch (error) {
      setDecisionMessage('__policy__', errorMessage(error))
    }
  }

  async function testSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    setDecisionMessage('__policy__', `Testing ${kind.toUpperCase()} source through ${sourceActionContractName(kind, 'test')}...`)
    try {
      const result = kind === 'mcp'
        ? await client.tools.testMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.testPluginSource(draft as PluginSourceWizardDraft)
      setDecisionMessage('__policy__', `${kind.toUpperCase()} test ${result.status}: ${result.errors.join(', ') || 'secrets redacted'}`)
      return result
    } catch (error) {
      const message = errorMessage(error)
      setDecisionMessage('__policy__', `${kind.toUpperCase()} test failed: ${message}`)
      throw error
    }
  }

  async function createSource(kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    setDecisionMessage('__policy__', `Creating ${kind.toUpperCase()} source through ${sourceActionContractName(kind, 'create')}...`)
    try {
      const result = kind === 'mcp'
        ? await client.tools.createMcpSource(draft as McpSourceWizardDraft)
        : await client.tools.createPluginSource(draft as PluginSourceWizardDraft)
      setDecisionMessage('__policy__', `${kind.toUpperCase()} create ${result.status}: ${result.errors.join(', ') || 'secrets redacted'}`)
      return result
    } catch (error) {
      const message = errorMessage(error)
      setDecisionMessage('__policy__', `${kind.toUpperCase()} create failed: ${message}`)
      throw error
    }
  }

  return (
    <ToolingConsole
      client={client}
      route={route}
      tools={state.tools}
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
      managementLoading={state.managementLoading}
      managementError={state.managementError}
      onSetPolicyMode={setPolicyMode}
      onUpsertSourcePolicy={upsertSourcePolicy}
      onUpsertToolOverride={upsertToolOverride}
      onRevokeGrant={revokeGrant}
      onTestSource={testSource}
      onCreateSource={createSource}
      onSelectProvider={selectProvider}
      onApprove={approve}
      onDeny={deny}
      onExecuteSafe={executeSafe}
    />
  )
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

function toolErrorMessage(result: AuroraResponse<unknown>): string {
  if (result.ok) return ''
  return result.error.message || 'Tooling catalog request failed.'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool approval action failed.'
}

function denialResultMessage(result: ToolApprovalDecisionResult): string {
  const correlation = result.correlationId ?? 'pending'
  const policy = result.policyDecisionId ? `, policy ${result.policyDecisionId}` : ''
  return `Denied with correlation ${correlation}${policy}`
}

function sourceActionContractName(kind: 'mcp' | 'plugin', action: 'test' | 'create'): string {
  if (kind === 'mcp') {
    return action === 'test' ? 'Tooling.TestMCPSource' : 'Tooling.CreateMCPSource'
  }
  return action === 'test' ? 'Tooling.TestPluginSource' : 'Tooling.CreatePluginSource'
}
