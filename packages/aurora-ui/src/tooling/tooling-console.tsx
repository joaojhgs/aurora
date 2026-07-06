'use client'

import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  FileDiff,
  FlaskConical,
  History,
  KeyRound,
  Lock,
  Network,
  Package,
  Play,
  Plug,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X
} from 'lucide-react'
import type { AuroraClient, McpSourceWizardDraft, NormalizedSchedulerJob, PluginSourceWizardDraft, ToolApprovalCardModel, ToolApprovalGrantModel, ToolApprovalScope, ToolOnboardingValidationResult, ToolPolicyAuditEventModel, ToolPendingApprovalModel, ToolSourceDetailModel, ToolSourceSummaryModel, ToolingPageViewModel } from '@aurora/client'
import type { RouteAvailability } from '../shell-data'
import { getAuroraSurfaceProfile } from '../platform-surface'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from '../status-badges'
import { PageHeader } from '../state-surface'
import { Button, Card, MetaGrid, StatStrip } from '../primitives'
import {
  buildAuditRows,
  buildGrantRows,
  buildToolingPolicySummary,
  buildToolingPolicySummaryFromBackend,
  buildToolingSources,
  buildToolingSourcesFromBackend,
  isBlockedTool,
  isPendingApprovalTool,
  sourceSectionLabel,
  toolsForSourceSearch,
  type ToolingSourceModel,
  type ToolingSourceType,
  type ToolingTrustState
} from './source-model'

export interface ToolingConsoleProps {
  client: AuroraClient
  route: RouteAvailability
  tools: ToolApprovalCardModel[]
  loading: boolean
  error: string | null
  schedulerJobs: NormalizedSchedulerJob[]
  schedulerLoading: boolean
  schedulerError: string | null
  selectedProviders: Record<string, string>
  decisionMessages: Record<string, string>
  nativePlatform?: string | undefined
  policySummary?: ToolingPageViewModel['policy'] | null
  sourceSummaries?: ToolSourceSummaryModel[] | undefined
  sourceDetails?: Record<string, ToolSourceDetailModel | null> | undefined
  grants?: ToolApprovalGrantModel[] | undefined
  pendingApprovals?: ToolPendingApprovalModel[] | undefined
  auditEvents?: ToolPolicyAuditEventModel[] | undefined
  managementLoading?: boolean | undefined
  managementError?: string | null | undefined
  onSetPolicyMode?: (policyMode: string) => void
  onUpsertSourcePolicy?: ((source: ToolingSourceModel, trustTier: string, includeFutureTools?: boolean) => void) | undefined
  onUpsertToolOverride?: ((tool: ToolApprovalCardModel, approvalMode: string) => void) | undefined
  onRevokeGrant?: ((grant: ReturnType<typeof buildGrantRows>[number]) => void) | undefined
  onTestSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<ToolOnboardingValidationResult> | ToolOnboardingValidationResult) | undefined
  onCreateSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<ToolOnboardingValidationResult> | ToolOnboardingValidationResult) | undefined
  onSelectProvider: (tool: ToolApprovalCardModel, providerId: string) => void
  onApprove: (tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: (tool: ToolApprovalCardModel) => void
  onExecuteSafe: (tool: ToolApprovalCardModel) => void
}

const SOURCE_SECTIONS: ToolingSourceType[] = ['core', 'mcp', 'plugin', 'mesh', 'unknown', 'blocked']
type ToolingWorkspaceTab = 'tools' | 'policy' | 'grants' | 'approvals' | 'scheduler' | 'activity' | 'onboarding'

export function ToolingConsole({
  client,
  route,
  tools,
  loading,
  error,
  schedulerJobs,
  schedulerLoading,
  schedulerError,
  selectedProviders,
  decisionMessages,
  nativePlatform,
  policySummary,
  sourceSummaries = [],
  sourceDetails = {},
  grants: backendGrants = [],
  pendingApprovals: backendPendingApprovals = [],
  auditEvents: backendAuditEvents = [],
  managementLoading = false,
  managementError = null,
  onSetPolicyMode,
  onUpsertSourcePolicy,
  onUpsertToolOverride,
  onRevokeGrant,
  onTestSource,
  onCreateSource,
  onSelectProvider,
  onApprove,
  onDeny,
  onExecuteSafe
}: ToolingConsoleProps) {
  const [query, setQuery] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<ToolingWorkspaceTab>('tools')
  const [wizard, setWizard] = useState<'mcp' | 'plugin' | null>(null)
  const [wizardStep, setWizardStep] = useState(1)
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false)
  const [wizardResult, setWizardResult] = useState<string | null>(null)
  const [mcpDraft, setMcpDraft] = useState<McpSourceWizardDraft>(() => ({
    name: 'Aurora MCP source',
    url: '',
    command: '',
    args: [],
    transport: 'streamable_http',
    trustTier: 'untrusted',
    includeFutureTools: false,
    reason: 'Configured from /tools onboarding wizard'
  }))
  const [pluginDraft, setPluginDraft] = useState<PluginSourceWizardDraft>(() => ({
    packageName: '',
    pluginId: '',
    version: '',
    sourceUrl: '',
    trustTier: 'untrusted',
    includeFutureTools: false,
    reason: 'Configured from /tools onboarding wizard'
  }))
  const sources = useMemo(() => sourceSummaries.length > 0 ? buildToolingSourcesFromBackend(sourceSummaries, sourceDetails, tools) : buildToolingSources(tools), [sourceSummaries, sourceDetails, tools])
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? sources[0] ?? null
  const policy = useMemo(() => policySummary ? buildToolingPolicySummaryFromBackend(policySummary) : buildToolingPolicySummary(tools, sources), [policySummary, tools, sources])
  const grants = useMemo(() => backendGrants.length > 0 ? backendGrants.map((grant) => backendGrantRow(grant, sources)) : buildGrantRows(sources), [backendGrants, sources])
  const auditRows = useMemo(() => backendAuditEvents.length > 0 ? backendAuditEvents.map(backendAuditRow) : buildAuditRows(tools, schedulerJobs), [backendAuditEvents, tools, schedulerJobs])
  let runtimeMode: 'desktop-local' | 'mobile' | undefined
  if (client.transport.kind === 'tauri-local') runtimeMode = 'desktop-local'
  else if (client.transport.kind === 'native-mobile') runtimeMode = 'mobile'
  const surfaceProfile = useMemo(() => getAuroraSurfaceProfile({
    runtimeMode,
    transportKind: client.transport.kind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent
  }), [client.transport.kind, nativePlatform])
  const filteredSourceTools = selectedSource ? toolsForSourceSearch(selectedSource, query) : []
  const pendingApprovals = selectedSource ? selectedSource.tools.filter(isPendingApprovalTool) : []
  const selectedBackendPendingApprovals = selectedSource
    ? backendPendingApprovals.filter((approval) => pendingApprovalMatchesSource(approval, selectedSource))
    : []
  const backendPendingCount = selectedBackendPendingApprovals.length

  function showWizard(type: 'mcp' | 'plugin') {
    setWizard(type)
    setWizardStep(1)
    setActiveTab('onboarding')
  }

  return (
    <section className="aui-tool-panel aui-tool-console" aria-labelledby="tool-approval-title">
      <PageHeader
        eyebrow="Tools"
        id="tool-approval-title"
        title="Tools & Automations"
        description="Source-first Tooling control center for policy, grants, pending approvals, mesh catalog review, scheduler dependencies, onboarding, and redacted audit evidence."
        badges={
          <>
            <StatusBadge state={route.state} />
            <PrivacyBadge privacy={route.item.privacyClass} />
            <EvidenceBadge label={route.providerLabel} />
            <EvidenceBadge label={surfaceProfile.label} />
          </>
        }
      />

      <PolicyCommandBar
        policy={policy}
        route={route}
        transportKind={client.transport.kind}
        surfaceLabel={surfaceProfile.label}
        onAddMcp={() => showWizard('mcp')}
        onAddPlugin={() => showWizard('plugin')}
        onSetPolicyMode={onSetPolicyMode}
      />

      {route.disabled ? (
        <div className="aui-inline-alert aui-inline-alert-danger" role="alert">
          <ShieldAlert size={16} aria-hidden />
          <span>Tooling is capability-gated: {presentableSignal(route.blockers.join(', ') || 'no executable Tooling catalog entry')}. Route state {route.state}.</span>
        </div>
      ) : null}
      {error ? <div className="aui-inline-alert aui-inline-alert-danger" role="alert"><AlertTriangle size={16} aria-hidden /><span>{error}</span></div> : null}
      {managementError ? <div className="aui-inline-alert aui-inline-alert-danger" role="alert"><AlertTriangle size={16} aria-hidden /><span>Tooling management read models unavailable: {managementError}</span></div> : null}
      {managementLoading ? <div className="aui-inline-alert" role="status"><RefreshCw size={16} aria-hidden /><span>Loading Tooling.GetPolicySummary and Tooling.ListToolSources...</span></div> : null}

      <div className="aui-tool-source-layout">
        <SourceRail
          sources={sources}
          selectedSourceId={selectedSource?.id ?? null}
          loading={loading}
          query={query}
          onQuery={setQuery}
          drawerOpen={sourceDrawerOpen}
          onDrawerOpen={setSourceDrawerOpen}
          onSelectSource={(source) => setSelectedSourceId(source.id)}
          onAddMcp={() => showWizard('mcp')}
        />

        <main className="aui-tool-workspace" aria-label="Source detail">
          {loading ? <LoadingState /> : null}
          {!loading && sources.length === 0 ? <EmptyCatalog onAddMcp={() => showWizard('mcp')} /> : null}
          {!loading && selectedSource ? (
            <>
              <SourceOverview source={selectedSource} policyBypass={policy.bypassEnabled} />
              <WorkspaceTabs activeTab={activeTab} onTab={setActiveTab} pendingCount={Math.max(pendingApprovals.length, backendPendingCount)} />
              {activeTab === 'tools' ? (
                <ToolInventory
                  source={selectedSource}
                  tools={filteredSourceTools}
                  routeDisabled={route.disabled}
                  selectedProviders={selectedProviders}
                  decisionMessages={decisionMessages}
                  onSelectProvider={onSelectProvider}
                  onApprove={onApprove}
                  onDeny={onDeny}
                  onExecuteSafe={onExecuteSafe}
                />
              ) : null}
              {activeTab === 'policy' ? <PolicyWorkspace source={selectedSource} policyMode={policy.mode} onUpsertSourcePolicy={onUpsertSourcePolicy} onUpsertToolOverride={onUpsertToolOverride} /> : null}
              {activeTab === 'grants' ? <GrantsPanel grants={grants.filter((grant) => grant.source === selectedSource.id)} onRevokeGrant={onRevokeGrant} /> : null}
              {activeTab === 'approvals' ? (
                <ApprovalsPanel
                  approvals={pendingApprovals}
                  backendApprovals={selectedBackendPendingApprovals}
                  routeDisabled={route.disabled}
                  selectedProviders={selectedProviders}
                  decisionMessages={decisionMessages}
                  onSelectProvider={onSelectProvider}
                  onApprove={onApprove}
                  onDeny={onDeny}
                />
              ) : null}
              {activeTab === 'scheduler' ? <SchedulerPanel jobs={schedulerJobs} loading={schedulerLoading} error={schedulerError} /> : null}
              {activeTab === 'activity' ? <ActivityPanel rows={auditRows} /> : null}
              {activeTab === 'onboarding' ? (
                <OnboardingPanel
                  surfaceLabel={surfaceProfile.label}
                  canLaunchLocalCommands={surfaceProfile.supportsDesktopCommands}
                  wizard={wizard}
                  wizardStep={wizardStep}
                  mcpDraft={mcpDraft}
                  pluginDraft={pluginDraft}
                  resultMessage={wizardResult ?? decisionMessages.__policy__ ?? null}
                  onStep={setWizardStep}
                  onWizard={setWizard}
                  onMcpDraft={setMcpDraft}
                  onPluginDraft={setPluginDraft}
                  onTestSource={async (kind, draft) => {
                    setWizardResult(`Testing ${kind.toUpperCase()} source through ${sourceActionContractName(kind, 'test')}...`)
                    try {
                      const result = await onTestSource?.(kind, draft)
                      setWizardResult(onboardingResultMessage(kind, 'test', result))
                    } catch (error) {
                      setWizardResult(`${kind.toUpperCase()} source test failed: ${errorText(error)}`)
                    }
                  }}
                  onCreateSource={async (kind, draft) => {
                    setWizardResult(`Creating ${kind.toUpperCase()} source through ${sourceActionContractName(kind, 'create')}...`)
                    try {
                      const result = await onCreateSource?.(kind, draft)
                      setWizardResult(onboardingResultMessage(kind, 'create', result))
                    } catch (error) {
                      setWizardResult(`${kind.toUpperCase()} source create failed: ${errorText(error)}`)
                    }
                  }}
                />
              ) : null}
            </>
          ) : null}
        </main>
      </div>

    </section>
  )
}


function backendGrantRow(grant: ToolApprovalGrantModel, sources: ToolingSourceModel[]): ReturnType<typeof buildGrantRows>[number] {
  const grantSource = sourceForGrant(grant, sources)
  return {
    id: grant.id,
    target: grant.toolId ?? grant.localToolName ?? grant.providerServiceInstanceId ?? 'source policy',
    source: grantSource?.id ?? 'unknown',
    scope: grant.scope,
    status: grant.status,
    principal: grant.principalId ?? 'local-principal',
    expires: grant.expiresAt ? new Date(grant.expiresAt * 1000).toISOString() : 'backend default',
    evidence: grant.reason ?? grant.id
  }
}

function backendAuditRow(event: ToolPolicyAuditEventModel): ReturnType<typeof buildAuditRows>[number] {
  return {
    id: event.id,
    action: event.event,
    actor: event.principalId ?? 'Tooling',
    target: event.toolId ?? event.providerId ?? event.route ?? 'policy',
    timestamp: event.createdAt ?? 'not reported',
    status: event.action ?? 'recorded',
    correlationId: event.correlationId ?? 'pending',
    policyDecisionId: event.policyDecisionId ?? 'not reported'
  }
}

function sourceForGrant(grant: ToolApprovalGrantModel, sources: ToolingSourceModel[]): ToolingSourceModel | null {
  const metadataSourceId = typeof grant.metadata.source_id === 'string' ? grant.metadata.source_id : null
  if (metadataSourceId) return sources.find((source) => source.id === metadataSourceId) ?? null
  if (grant.toolId) {
    const byTool = sources.find((source) => source.tools.some((tool) => tool.id === grant.toolId))
    if (byTool) return byTool
  }
  if (grant.localToolName) {
    const byLocalName = sources.find((source) => source.tools.some((tool) => tool.name === grant.localToolName || tool.id.endsWith(`:${grant.localToolName}`)))
    if (byLocalName) return byLocalName
  }
  return sources.find((source) => {
    if (grant.providerPeerId && source.peerId !== grant.providerPeerId) return false
    if (grant.providerServiceInstanceId && source.serviceInstanceId !== grant.providerServiceInstanceId) return false
    return Boolean(grant.providerPeerId || grant.providerServiceInstanceId)
  }) ?? null
}

function pendingApprovalMatchesSource(approval: ToolPendingApprovalModel, source: ToolingSourceModel): boolean {
  const metadataSourceId = typeof approval.metadata.source_id === 'string' ? approval.metadata.source_id : null
  if (metadataSourceId) return metadataSourceId === source.id
  if (source.tools.some((tool) => tool.id === approval.toolName || tool.name === approval.toolName || tool.id.endsWith(`:${approval.toolName}`))) {
    return true
  }
  const providerId = typeof approval.metadata.provider_id === 'string' ? approval.metadata.provider_id : null
  const peerId = typeof approval.metadata.provider_peer_id === 'string' ? approval.metadata.provider_peer_id : null
  const serviceId = typeof approval.metadata.provider_service_instance_id === 'string' ? approval.metadata.provider_service_instance_id : null
  if (peerId && source.peerId && peerId !== source.peerId) return false
  if (serviceId && source.serviceInstanceId && serviceId !== source.serviceInstanceId) return false
  return Boolean(providerId && (providerId === source.id || providerId === source.serviceInstanceId || providerId === source.providerLabel))
}


function PolicyCommandBar({
  policy,
  route,
  transportKind,
  surfaceLabel,
  onAddMcp,
  onAddPlugin,
  onSetPolicyMode
}: {
  policy: ReturnType<typeof buildToolingPolicySummary>
  route: RouteAvailability
  transportKind: string
  surfaceLabel: string
  onAddMcp: () => void
  onAddPlugin: () => void
  onSetPolicyMode?: ((policyMode: string) => void) | undefined
}) {
  const dangerous = policy.bypassEnabled || policy.denyAll || policy.dryRunOnly
  return (
    <Card
      className="aui-tool-policy-command"
      ariaLabel="Tooling policy"
      icon={<ShieldCheck size={18} aria-hidden />}
      title="Tooling policy"
      description="Global policy console. Backend Tooling policy is authoritative; this page reads SDK management state first and routes durable mutations through typed Tooling contracts."
      actions={
        <>
          <Button variant="primary" icon={<Plug size={15} aria-hidden />} onClick={onAddMcp}>Add MCP server</Button>
          <Button variant="outline" icon={<Package size={15} aria-hidden />} onClick={onAddPlugin}>Add plugin</Button>
        </>
      }
    >
      <StatStrip
        ariaLabel="Tooling policy summary"
        items={[
          { label: 'Global policy mode', value: policy.mode, caption: policy.defaultBehavior, tone: dangerous ? 'warning' : 'default' },
          { label: 'Sources', value: policy.sourceCount, caption: `${policy.blockedCount} blocked tools`, tone: policy.blockedCount > 0 ? 'warning' : 'default' },
          { label: 'Pending approvals', value: policy.pendingApprovalCount, caption: 'assistant approvals stay inline; this is the management queue' },
          { label: 'Transport', value: transportKind, caption: surfaceLabel }
        ]}
      />
      {dangerous ? (
        <div className="aui-inline-alert aui-inline-alert-danger" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>{policy.denyAll ? 'Deny-all mode is active or inferred from Tooling policy/catalog state.' : 'Dry-run or bypass-sensitive policy state needs operator review.'}</span>
        </div>
      ) : null}
      <div className="aui-tool-policy-controls" aria-label="Policy controls">
        {['enforce', 'dry_run_only', 'deny_all', 'unrestricted_except_blocked'].map((mode) => (
          <button key={mode} type="button" aria-pressed={policy.mode === mode} onClick={() => onSetPolicyMode?.(mode)} disabled={!onSetPolicyMode} title="Route through Tooling.SetPolicyMode.">
            {mode}
          </button>
        ))}
        <span className="aui-action-chip"><Lock size={14} aria-hidden />Dangerous confirmations: ALLOW NON-BLOCKED TOOLS · DENY ALL TOOLS · DRY RUN ONLY</span>
        <span className="aui-action-chip"><FileDiff size={14} aria-hidden />{`${route.item.capabilityModule}.${route.item.capabilityMethod ?? route.item.expectedTask}`}</span>
      </div>
      <div className="aui-tool-lifecycle-strip" aria-label="Source catalog lifecycle">
        <span className="aui-action-chip"><Network size={14} aria-hidden />Negotiated catalog cache</span>
        <span className="aui-action-chip">epoch / hash tracked for mesh peers</span>
        <span className="aui-action-chip">stale, removed / unshared, stale grant, missing grant states block scheduler execution</span>
        <span className="aui-action-chip">Scheduled tool actions via Scheduler.ListJobs</span>
        <span className="aui-action-chip">Grant dependency warnings link to /admin/scheduler</span>
          <span className="aui-action-chip">AdminAction confirmation protects high-risk scheduled executions</span>
      </div>
      <div className="aui-tool-lifecycle-strip" aria-label="Management workspaces">
        <span className="aui-action-chip"><KeyRound size={14} aria-hidden />Durable grants</span>
        <span className="aui-action-chip"><Clock size={14} aria-hidden />Pending approvals</span>
        <span className="aui-action-chip">Approve in Assistant for one exact runtime call</span>
        <span className="aui-action-chip"><History size={14} aria-hidden />Activity and audit with correlation ID</span>
      </div>
      <div className="aui-tool-lifecycle-strip" aria-label="Platform surfaces">
        <span className="aui-action-chip">Desktop local</span>
        <span className="aui-action-chip">Web thin</span>
        <span className="aui-action-chip">Android</span>
        <span className="aui-action-chip">iOS</span>
        <span className="aui-action-chip">Demo data is labeled when fixtures are active</span>
      </div>
      <MetaGrid columns={2} items={[
        { label: 'Last policy change', value: policy.lastChanged },
        { label: 'Actor', value: policy.actor },
        { label: 'Evidence', value: policy.evidence },
        { label: 'Mutation status', value: 'Durable policy changes route through Tooling.SetPolicyMode.' }
      ]} />
    </Card>
  )
}

function SourceRail({
  sources,
  selectedSourceId,
  loading,
  query,
  onQuery,
  drawerOpen,
  onDrawerOpen,
  onSelectSource,
  onAddMcp
}: {
  sources: ToolingSourceModel[]
  selectedSourceId: string | null
  loading: boolean
  query: string
  onQuery: (value: string) => void
  drawerOpen: boolean
  onDrawerOpen: (open: boolean) => void
  onSelectSource: (source: ToolingSourceModel) => void
  onAddMcp: () => void
}) {
  const hasMcpSource = sources.some((source) => source.type === 'mcp')
  const addMcpLabel = hasMcpSource ? 'Connect another MCP server' : 'Connect your first MCP server'
  return (
    <aside id="tool-source-drawer" className={`aui-tool-source-rail ${drawerOpen ? 'aui-tool-source-rail-open' : ''}`} aria-label="Source rail">
      <div className="aui-tool-mobile-source-head">
        <strong>Source catalog</strong>
        <span className="aui-action-chip">Tool source drawer</span>
        <button
          className="aui-tool-mobile-drawer-trigger"
          type="button"
          aria-expanded={drawerOpen}
          aria-controls="tool-source-drawer"
          onClick={() => onDrawerOpen(!drawerOpen)}
        >
          {drawerOpen ? 'Close source drawer' : 'Open source drawer'}
        </button>
      </div>
      <label className="aui-tool-search">
        <Search size={15} aria-hidden />
        <span className="sr-only">Search sources and tools</span>
        <input value={query} onChange={(event) => onQuery(event.currentTarget.value)} type="search" placeholder="Search sources, tools, policy" />
      </label>
      {loading ? <p className="aui-tool-empty">Loading Tooling catalog through Aurora...</p> : null}
      {SOURCE_SECTIONS.map((section) => {
        const sectionSources = section === 'blocked'
          ? sources.filter((source) => source.blockedToolCount > 0 || source.effectiveTrust === 'blocked')
          : sources.filter((source) => source.type === section)
        return (
          <section key={section} className="aui-tool-source-section" aria-label={sourceSectionLabel(section)}>
            <header>
              <span>{sourceSectionLabel(section)}</span>
              <span>{sectionSources.length}</span>
            </header>
            {sectionSources.length === 0 ? <p>{section === 'mcp' ? 'No MCP servers connected.' : 'No sources in this group.'}</p> : null}
            {sectionSources.map((source) => (
              <button
                key={`${section}:${source.id}`}
                type="button"
                className="aui-tool-source-row"
                aria-pressed={selectedSourceId === source.id}
                onClick={() => onSelectSource(source)}
              >
                {sourceIcon(source.type)}
                <span>
                  <strong>{source.name}</strong>
                  <small>{source.catalogState}</small>
                </span>
                <em>{source.toolCount}</em>
                <TrustPill trust={source.effectiveTrust} />
              </button>
            ))}
          </section>
        )
      })}
      <Button variant="outline" icon={<Plug size={15} aria-hidden />} onClick={onAddMcp}>{addMcpLabel}</Button>
    </aside>
  )
}

function SourceOverview({ source, policyBypass }: { source: ToolingSourceModel; policyBypass: boolean }) {
  return (
    <Card
      className="aui-tool-source-overview"
      ariaLabel="Selected source overview"
      icon={sourceIcon(source.type)}
      title={source.name}
      description={`${sourceSectionLabel(source.type)} · ${source.catalogEvidence}`}
      actions={<><TrustPill trust={source.effectiveTrust} />{policyBypass ? <span className="aui-risk-pill aui-risk-admin-critical">Bypassed</span> : null}</>}
    >
      <StatStrip ariaLabel="Selected source statistics" items={[
        { label: 'Tools', value: source.toolCount, caption: `${source.safeToolCount} safe local/read tools` },
        { label: 'Pending', value: source.pendingApprovalCount, caption: 'runtime approvals', tone: source.pendingApprovalCount ? 'warning' : 'default' },
        { label: 'Blocked', value: source.blockedToolCount, caption: 'child overrides or provider errors', tone: source.blockedToolCount ? 'danger' : 'default' },
        { label: 'Mesh/cache', value: source.type === 'mesh' ? 'cached' : 'local', caption: source.lastSeenLabel }
      ]} />
      <MetaGrid columns={2} items={[
        { label: 'Provider', value: source.providerLabel },
        { label: 'Trust tier', value: source.trustTier ?? 'not reported' },
        { label: 'Transport', value: source.transport ?? 'not reported' },
        { label: 'Route path', value: source.routePath.join(' -> ') || 'not reported', mono: true },
        { label: 'Future-tool inheritance', value: source.type === 'core' ? 'core source reviewed' : 'off until backend source policy says otherwise' },
        { label: 'Review state', value: source.catalogState }
      ]} />
    </Card>
  )
}

function WorkspaceTabs({ activeTab, onTab, pendingCount }: { activeTab: ToolingWorkspaceTab; onTab: (tab: ToolingWorkspaceTab) => void; pendingCount: number }) {
  const tabs = [
    ['tools', 'Tools'], ['policy', 'Policy'], ['grants', 'Grants'], ['approvals', `Approvals ${pendingCount}`], ['scheduler', 'Scheduler'], ['activity', 'Audit'], ['onboarding', 'Onboarding']
  ] as const
  return (
    <div className="aui-tool-tabs" role="tablist" aria-label="Source workspace tabs">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={activeTab === id} onClick={() => onTab(id)}>{label}</button>
      ))}
    </div>
  )
}

function ToolInventory(props: {
  source: ToolingSourceModel
  tools: ToolApprovalCardModel[]
  routeDisabled: boolean
  selectedProviders: Record<string, string>
  decisionMessages: Record<string, string>
  onSelectProvider: (tool: ToolApprovalCardModel, providerId: string) => void
  onApprove: (tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: (tool: ToolApprovalCardModel) => void
  onExecuteSafe: (tool: ToolApprovalCardModel) => void
}) {
  if (props.tools.length === 0) return <p className="aui-tool-empty">No tools match the current source/search filter.</p>
  return (
    <div className="aui-tool-source-tools" aria-label={`${props.source.name} tools`}>
      {props.tools.map((tool) => (
        <ToolRow
          key={tool.id}
          tool={tool}
          source={props.source}
          selectedProviderId={props.selectedProviders[tool.id]}
          decisionMessage={props.decisionMessages[tool.id] ?? null}
          routeDisabled={props.routeDisabled}
          onSelectProvider={(providerId) => props.onSelectProvider(tool, providerId)}
          onApprove={(scope, dryRun) => props.onApprove(tool, scope, dryRun)}
          onDeny={() => props.onDeny(tool)}
          onExecuteSafe={() => props.onExecuteSafe(tool)}
        />
      ))}
    </div>
  )
}

function ToolRow({
  tool,
  source,
  selectedProviderId,
  decisionMessage,
  routeDisabled,
  onSelectProvider,
  onApprove,
  onDeny,
  onExecuteSafe
}: {
  tool: ToolApprovalCardModel
  source: ToolingSourceModel
  selectedProviderId?: string | undefined
  decisionMessage: string | null
  routeDisabled: boolean
  onSelectProvider: (providerId: string) => void
  onApprove: (scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: () => void
  onExecuteSafe?: (() => void) | undefined
}) {
  const selectedProvider = tool.providers.find((provider) => provider.id === selectedProviderId)
    ?? tool.providers.find((provider) => provider.selectable)
    ?? tool.providers[0]
  const selectorMissing = tool.providerSelectorRequired && !selectedProviderId && tool.providers.length > 1
  const adminActionPending = tool.requiresAdminAction && tool.state !== 'approved' && tool.state !== 'executed'
  const blocked = routeDisabled || isBlockedTool(tool)
  const approveDisabled = blocked || selectorMissing || adminActionPending || tool.state === 'dry-run-only'
  const dryRunDisabled = blocked || selectorMissing || !tool.dryRunSupported
  const executeSafeEnabled = Boolean(onExecuteSafe) && safeLocalExecutable(tool) && !routeDisabled
  const fields = toolSchemaFields(tool)
  return (
    <details className={`aui-tool-row aui-tool-state-${tool.state}`}>
      <summary>
        <span className="aui-tool-row-title">
          {toolStateIcon(tool)}
          <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
        </span>
        <span className="aui-tool-row-badges">
          <span className={`aui-risk-pill aui-risk-${riskClassName(tool.riskClass)}`}>{tool.riskClass}</span>
          <span className="aui-action-chip">{tool.approvalRequired ? 'approval required' : 'ready'}</span>
          <ChevronDown size={15} aria-hidden />
        </span>
      </summary>
      <MetaGrid columns={2} items={[
        { label: 'Effective policy', value: effectivePolicyCopy(tool, source) },
        { label: 'Provider', value: selectedProvider?.label ?? tool.providerLabel },
        { label: 'Permissions', value: tool.requiredPermissions.join(', ') || 'No explicit permissions reported' },
        { label: 'Capability', value: capabilityCopy(tool) },
        { label: 'Args hash', value: tool.argsHash ?? 'not reported', mono: true },
        { label: 'Audit', value: tool.auditDestination ?? 'audit pending' },
        { label: 'Correlation', value: tool.correlationId ?? 'pending', mono: true },
        { label: 'LLM/scheduler binding', value: `${tool.approvalRequired ? 'LLM approval-gated' : 'LLM-bindable'} · ${tool.requiresAdminAction ? 'AdminAction for scheduling' : 'scheduler review required'}` }
      ]} />
      {tool.providers.length > 1 || tool.providerSelectorRequired ? (
        <label className="aui-tool-select">
          <span>Provider selector</span>
          <select value={selectedProviderId ?? ''} onChange={(event) => onSelectProvider(event.currentTarget.value)}>
            <option value="">Select provider</option>
            {tool.providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.selectable}>{provider.label}</option>)}
          </select>
          <small>{selectorMissing ? 'Backend requires an explicit provider selector before approval.' : selectedProvider?.reason ?? 'Provider selected from catalog.'}</small>
        </label>
      ) : null}
      <details className="aui-tool-details">
        <summary><FileDiff size={15} aria-hidden /> Advanced details and redacted payloads</summary>
        <RedactedPreview label="Redacted arguments" value={tool.argsPreview} fallback="No argument preview reported." />
        <RedactedPreview label="Dry-run preview" value={tool.dryRunPreview} fallback="No dry-run preview reported." />
        <div className="aui-tool-param-form" aria-label="Arguments schema summary">
          <strong>Arguments schema summary</strong>
          {fields.length > 0 ? fields.map((field) => (
            <label key={field.name}>
              <span>{field.name}{field.required ? ' *' : ''}</span>
              <input readOnly value={field.example} aria-label={`${field.name} ${field.type} parameter`} />
              <small>{field.type}</small>
            </label>
          )) : <p>No writable parameters were reported for this tool.</p>}
        </div>
        {tool.result ? <ToolResultCard result={tool.result} /> : null}
      </details>
      <div className="aui-tool-status-row" role={blocked ? 'alert' : 'status'}>{toolStateIcon(tool)}<span>{stateCopy(tool)}</span></div>
      <div className="aui-tool-actions">
        <Button variant="outline" icon={<FlaskConical size={15} aria-hidden />} disabled={dryRunDisabled} onClick={() => onApprove('once', true)}>Dry run</Button>
        <Button variant="outline" icon={<X size={15} aria-hidden />} disabled={blocked || selectorMissing} onClick={onDeny}>Deny</Button>
        {executeSafeEnabled ? <Button variant="primary" icon={<Play size={15} aria-hidden />} ariaLabel="Execute safe local through Tooling.ExecuteTool" onClick={onExecuteSafe}>Execute safe local</Button> : null}
        {tool.approvalRequired ? tool.approvalScopes.map((scope) => (
          <Button key={scope} variant="primary" icon={<Check size={15} aria-hidden />} disabled={approveDisabled} onClick={() => onApprove(scope)}>{scopeLabel(scope)}</Button>
        )) : null}
      </div>
      {decisionMessage ? <p className="aui-tool-message" role="status">{decisionMessage}</p> : null}
    </details>
  )
}

function PolicyWorkspace({
  source,
  policyMode,
  onUpsertSourcePolicy,
  onUpsertToolOverride
}: {
  source: ToolingSourceModel
  policyMode: string
  onUpsertSourcePolicy?: ((source: ToolingSourceModel, trustTier: string, includeFutureTools?: boolean) => void) | undefined
  onUpsertToolOverride?: ((tool: ToolApprovalCardModel, approvalMode: string) => void) | undefined
}) {
  return (
    <div className="aui-tool-grid-two">
      <Card title="Source trust" icon={<SlidersHorizontal size={18} aria-hidden />} description="Trust is displayed from backend Tooling source policy evidence; durable mutations route through Tooling.UpsertSourcePolicy.">
        <MetaGrid columns={1} items={[
          { label: 'Effective trust', value: source.effectiveTrust },
          { label: 'Future child tools', value: source.type === 'core' ? 'trusted core catalog' : 'approval required by default unless backend policy explicitly enables inheritance' },
          { label: 'Global mode', value: policyMode },
          { label: 'Blocked child overrides', value: source.blockedToolCount }
        ]} />
        <div className="aui-tool-policy-controls">
          {['trusted', 'untrusted', 'blocked'].map((trust) => (
            <button key={trust} type="button" onClick={() => onUpsertSourcePolicy?.(source, trust)} disabled={!onUpsertSourcePolicy}>{trust}</button>
          ))}
          <button type="button" onClick={() => onUpsertSourcePolicy?.(source, 'trusted', true)} disabled={!onUpsertSourcePolicy}>Trust future child tools</button>
        </div>
      </Card>
      <Card title="Per-tool overrides" icon={<Wrench size={18} aria-hidden />} description="Blocked overrides win over source trust; revoking the durable grant restores source inheritance.">
        {source.tools.map((tool) => (
          <div key={tool.id} className="aui-tool-mini-row">
            <strong>{tool.name}</strong>
            <span>{effectivePolicyCopy(tool, source)}</span>
            <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'approve_all_for_peer')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Trust override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Trust tool</Button>
            <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'ask_each_time')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Approval override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Require approval</Button>
            <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'deny_all')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Block override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Block tool</Button>
          </div>
        ))}
        <p className="aui-tool-empty">To remove a durable child override and inherit from the source again, revoke its grant in the Grants tab.</p>
      </Card>
    </div>
  )
}

function GrantsPanel({ grants, onRevokeGrant }: { grants: ReturnType<typeof buildGrantRows>; onRevokeGrant?: ((grant: ReturnType<typeof buildGrantRows>[number]) => void) | undefined }) {
  return (
    <Card title="Durable grants" icon={<KeyRound size={18} aria-hidden />} description="Grant rows come from Tooling.ListApprovalGrants when available and fall back to catalog evidence only while offline.">
      {grants.length === 0 ? <p className="aui-tool-empty">No active, expired, revoked, stale, or needs-review grants reported for this source.</p> : null}
      {grants.map((grant) => (
        <div key={grant.id} className="aui-tool-mini-row">
          <strong>{grant.target}</strong>
          <span>{grant.scope} · {grant.principal} · {grant.expires}</span>
          <span className={`aui-risk-pill aui-risk-${riskClassName(grant.status)}`}>{grant.status}</span>
          <Button variant="ghost" onClick={() => onRevokeGrant?.(grant)} disabled={!onRevokeGrant} disabledReason={!onRevokeGrant ? 'Grant revocation requires Tooling.RevokeApprovalGrant.' : undefined}>Revoke</Button>
        </div>
      ))}
    </Card>
  )
}

function ApprovalsPanel(props: {
  approvals: ToolApprovalCardModel[]
  backendApprovals: ToolPendingApprovalModel[]
  routeDisabled: boolean
  selectedProviders: Record<string, string>
  decisionMessages: Record<string, string>
  onSelectProvider: (tool: ToolApprovalCardModel, providerId: string) => void
  onApprove: (tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: (tool: ToolApprovalCardModel) => void
}) {
  return (
    <Card title="Pending approvals" icon={<Clock size={18} aria-hidden />} description="Assistant inline approval remains in chat; this queue explains backend pending requests and grants.">
      {props.approvals.length === 0 && props.backendApprovals.length === 0 ? <p className="aui-tool-empty">No pending runtime approvals are present in the current Tooling catalog snapshot.</p> : null}
      {props.backendApprovals.map((approval) => (
        <div key={approval.id} className="aui-tool-mini-row">
          <strong>{approval.displayName}</strong>
          <span>{approval.status} · thread {approval.threadId} · approval {approval.approvalRequestId ?? 'pending id'}</span>
          <span className="aui-action-chip">Approve in Assistant</span>
          <code>{approval.correlationId ?? 'correlation pending'}</code>
        </div>
      ))}
      {props.approvals.map((tool) => (
        <ToolRow
          key={tool.id}
          tool={tool}
          source={sourceForApproval(tool)}
          routeDisabled={props.routeDisabled}
          selectedProviderId={props.selectedProviders[tool.id]}
          decisionMessage={props.decisionMessages[tool.id] ?? null}
          onSelectProvider={(providerId) => props.onSelectProvider(tool, providerId)}
          onApprove={(scope, dryRun) => props.onApprove(tool, scope, dryRun)}
          onDeny={() => props.onDeny(tool)}
        />
      ))}
    </Card>
  )
}


function sourceForApproval(tool: ToolApprovalCardModel): ToolingSourceModel {
  const source = buildToolingSources([tool])[0]
  if (!source) throw new Error(`Unable to derive Tooling source for ${tool.id}`)
  return source
}

function SchedulerPanel({ jobs, loading, error }: { jobs: NormalizedSchedulerJob[]; loading: boolean; error: string | null }) {
  return (
    <Card title="Scheduled tool actions" icon={<CalendarClock size={18} aria-hidden />} description="Scheduled jobs show grant dependencies and stale/revoked warning states from Scheduler.ListJobs.">
      {error ? <div className="aui-inline-alert aui-inline-alert-danger" role="alert"><AlertTriangle size={16} aria-hidden /><span>{error}</span></div> : null}
      {loading ? <p className="aui-tool-empty">Loading scheduler jobs through Aurora...</p> : null}
      {!loading && jobs.length === 0 && !error ? <p className="aui-tool-empty">No scheduler jobs were returned by Scheduler.ListJobs.</p> : null}
      {jobs.map((job) => (
        <div key={job.job_id} className="aui-tool-mini-row">
          <strong>{job.name}</strong>
          <span><code>{job.schedule}</code> · {job.action} · next {job.next_run ?? 'not scheduled'}</span>
          <StatusBadge state={schedulerAvailability(job)} />
          <span>{job.blocked_reason ? `grant warning: ${job.blocked_reason}` : 'grant dependency review required before fire'}</span>
        </div>
      ))}
      <a className="aui-btn aui-btn-ghost aui-btn-sm" href="/admin/scheduler">Open scheduler</a>
      <span className="aui-action-chip">Scheduler.ListJobs</span>
    </Card>
  )
}

function ActivityPanel({ rows }: { rows: ReturnType<typeof buildAuditRows> }) {
  return (
    <Card title="Activity and audit" icon={<History size={18} aria-hidden />} description="Recent policy, grant, tool execution, catalog, onboarding, and scheduler events with redacted payload boundaries.">
      <div className="aui-table-scroll">
        <table className="aui-table aui-tool-jobs-table">
          <thead><tr><th>Action</th><th>Target</th><th>Status</th><th>Correlation</th><th>Policy</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.action}</strong><small>{row.actor}</small></td>
              <td>{row.target}</td>
              <td>{row.status}</td>
              <td><code>{row.correlationId}</code></td>
              <td><code>{row.policyDecisionId}</code></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  )
}

function OnboardingPanel({
  surfaceLabel,
  canLaunchLocalCommands,
  wizard,
  wizardStep,
  mcpDraft,
  pluginDraft,
  resultMessage,
  onStep,
  onWizard,
  onMcpDraft,
  onPluginDraft,
  onTestSource,
  onCreateSource
}: {
  surfaceLabel: string
  canLaunchLocalCommands: boolean
  wizard: 'mcp' | 'plugin' | null
  wizardStep: number
  mcpDraft: McpSourceWizardDraft
  pluginDraft: PluginSourceWizardDraft
  resultMessage: string | null
  onStep: (step: number) => void
  onWizard: (wizard: 'mcp' | 'plugin' | null) => void
  onMcpDraft: (draft: McpSourceWizardDraft) => void
  onPluginDraft: (draft: PluginSourceWizardDraft) => void
  onTestSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<void> | void) | undefined
  onCreateSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<void> | void) | undefined
}) {
  const title = wizard === 'plugin' ? 'Plugin source wizard' : 'MCP server wizard'
  return (
    <Card title="Onboarding wizard UI" icon={<ServerCog size={18} aria-hidden />} description="Connect MCP servers and plugin sources through SDK-backed contracts without logging secrets.">
      <div className="aui-tool-wizard-actions">
        <Button variant={wizard === 'mcp' ? 'primary' : 'outline'} icon={<Plug size={15} aria-hidden />} onClick={() => onWizard('mcp')}>Add MCP server</Button>
        <Button variant={wizard === 'plugin' ? 'primary' : 'outline'} icon={<Package size={15} aria-hidden />} onClick={() => onWizard('plugin')}>Add plugin source</Button>
      </div>
      <div className="aui-tool-wizard" role="dialog" aria-modal="false" aria-labelledby="tool-wizard-title">
        <header>
          <h3 id="tool-wizard-title">{title}</h3>
          <p>{surfaceLabel}; local command launch is {canLaunchLocalCommands ? 'available for desktop-local source tests' : 'not available on this surface'}.</p>
        </header>
        <div className="aui-tool-tabs" role="tablist" aria-label="Wizard steps">
          {['Details', 'Authenticate', 'Discover', 'Trust'].map((label, index) => (
            <button key={label} type="button" role="tab" aria-selected={wizardStep === index + 1} onClick={() => onStep(index + 1)}>{index + 1}. {label}</button>
          ))}
        </div>
        <WizardStep
          wizard={wizard ?? 'mcp'}
          step={wizardStep}
          canLaunchLocalCommands={canLaunchLocalCommands}
          mcpDraft={mcpDraft}
          pluginDraft={pluginDraft}
          resultMessage={resultMessage}
          onMcpDraft={onMcpDraft}
          onPluginDraft={onPluginDraft}
          onTestSource={onTestSource}
          onCreateSource={onCreateSource}
        />
      </div>
    </Card>
  )
}

function WizardStep({
  wizard,
  step,
  canLaunchLocalCommands,
  mcpDraft,
  pluginDraft,
  resultMessage,
  onMcpDraft,
  onPluginDraft,
  onTestSource,
  onCreateSource
}: {
  wizard: 'mcp' | 'plugin'
  step: number
  canLaunchLocalCommands: boolean
  mcpDraft: McpSourceWizardDraft
  pluginDraft: PluginSourceWizardDraft
  resultMessage: string | null
  onMcpDraft: (draft: McpSourceWizardDraft) => void
  onPluginDraft: (draft: PluginSourceWizardDraft) => void
  onTestSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<void> | void) | undefined
  onCreateSource?: ((kind: 'mcp' | 'plugin', draft: McpSourceWizardDraft | PluginSourceWizardDraft) => Promise<void> | void) | undefined
}) {
  const draft = wizard === 'mcp' ? mcpDraft : pluginDraft
  const endpointValue = wizard === 'mcp' ? (mcpDraft.url || mcpDraft.command || '') : (pluginDraft.sourceUrl || '')

  function updateEndpoint(value: string) {
    if (wizard === 'mcp') {
      const isUrl = /^https?:\/\//i.test(value)
      const transport = isUrl || !canLaunchLocalCommands ? 'streamable_http' : 'stdio'
      onMcpDraft({ ...mcpDraft, command: isUrl ? '' : value, url: isUrl ? value : '', transport })
    } else {
      onPluginDraft({ ...pluginDraft, sourceUrl: value })
    }
  }

  function updateSecret(value: string) {
    if (wizard === 'mcp') {
      onMcpDraft({ ...mcpDraft, env: value ? { AURORA_AUTH_TOKEN: value } : {} })
      return
    }
    onPluginDraft({ ...pluginDraft, metadata: value ? { auth_token: value } : {} })
  }

  if (step === 1) return (
    <div className="aui-tool-wizard-step">
      <label>
        <span>{wizard === 'mcp' ? 'Display name' : 'Package name'}</span>
        <input
          value={wizard === 'mcp' ? mcpDraft.name : pluginDraft.packageName}
          onChange={(event) => wizard === 'mcp' ? onMcpDraft({ ...mcpDraft, name: event.currentTarget.value }) : onPluginDraft({ ...pluginDraft, packageName: event.currentTarget.value })}
          placeholder={wizard === 'mcp' ? 'Filesystem MCP' : '@aurora/plugin-package'}
        />
      </label>
      <label>
        <span>{wizard === 'mcp' ? 'Server URL or command profile' : 'Package source or install path'}</span>
        <input value={endpointValue} onChange={(event) => updateEndpoint(event.currentTarget.value)} placeholder={canLaunchLocalCommands ? 'stdio command or https://server' : 'https://server'} />
      </label>
      <p>Validation and saving route through {sourceActionContractName(wizard, 'test')} and {sourceActionContractName(wizard, 'create')}.</p>
    </div>
  )
  if (step === 2) return (
    <div className="aui-tool-wizard-step">
      <label><span>Auth type</span><select defaultValue="none"><option value="none">No auth</option><option value="bearer">Bearer token</option><option value="oauth">OAuth</option></select></label>
      <label>
        <span>Secret value</span>
        <input
          type="password"
          placeholder="Stored only for active submission"
          onChange={(event) => updateSecret(event.currentTarget.value)}
        />
      </label>
      <p>Secrets are obscured and never echoed in audit previews.</p>
    </div>
  )
  if (step === 3) return (
    <div className="aui-tool-wizard-step">
      <p>Run a backend validation before creating the source. Results stay redacted and appear in the status preview below.</p>
      <Button variant="outline" onClick={() => { void onTestSource?.(wizard, draft) }} disabled={!onTestSource} disabledReason={!onTestSource ? 'Testing requires Tooling.TestMCPSource or Tooling.TestPluginSource.' : undefined}>Test connection</Button>
      {resultMessage ? <p className="aui-tool-message" role="status">{resultMessage}</p> : null}
    </div>
  )
  return (
    <div className="aui-tool-wizard-step">
      <p>Default trust: approval required. Future-tool inheritance remains off unless explicitly enabled by backend source policy.</p>
      <Button variant="primary" onClick={() => { void onCreateSource?.(wizard, draft) }} disabled={!onCreateSource} disabledReason={!onCreateSource ? 'Create source requires Tooling.CreateMCPSource or Tooling.CreatePluginSource.' : undefined}>Create source</Button>
      {resultMessage ? <p className="aui-tool-message" role="status">{resultMessage}</p> : null}
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function onboardingResultMessage(kind: 'mcp' | 'plugin', action: 'test' | 'create', result: ToolOnboardingValidationResult | undefined): string {
  const prefix = `${kind.toUpperCase()} source ${action}`
  if (!result) return `${prefix} unavailable: ${sourceActionContractName(kind, action)} is not connected.`
  const detail = result.errors.join(', ') || (result.supported ? 'secrets redacted' : 'backend reports unsupported on this runtime')
  if (result.status === 'unsupported') return `${prefix} unsupported: ${detail}`
  if (result.ok) return `${prefix} valid. Review the redacted backend status and audit activity before trusting this source.`
  return `${prefix} failed: ${detail}`
}

function sourceActionContractName(kind: 'mcp' | 'plugin', action: 'test' | 'create'): string {
  if (kind === 'mcp') {
    return action === 'test' ? 'Tooling.TestMCPSource' : 'Tooling.CreateMCPSource'
  }
  return action === 'test' ? 'Tooling.TestPluginSource' : 'Tooling.CreatePluginSource'
}

function LoadingState() {
  return <Card title="Loading source catalog" icon={<RefreshCw size={18} aria-hidden />}><p className="aui-tool-empty">Loading Tooling.GetToolCatalog through the Aurora SDK.</p></Card>
}

function EmptyCatalog({ onAddMcp }: { onAddMcp: () => void }) {
  return <Card title="No sources" icon={<Boxes size={18} aria-hidden />}><p className="aui-tool-empty">No core, MCP, plugin, mesh, unknown, or blocked sources were returned by the SDK catalog.</p><Button variant="primary" onClick={onAddMcp}>Connect your first MCP server</Button></Card>
}

function TrustPill({ trust }: { trust: ToolingTrustState }) {
  return <span className={`aui-risk-pill aui-risk-${riskClassName(trust)}`}>{trust}</span>
}

function sourceIcon(type: Exclude<ToolingSourceType, 'blocked'>) {
  if (type === 'core') return <Wrench size={16} aria-hidden />
  if (type === 'mcp') return <Plug size={16} aria-hidden />
  if (type === 'plugin') return <Package size={16} aria-hidden />
  if (type === 'mesh') return <Network size={16} aria-hidden />
  return <ShieldAlert size={16} aria-hidden />
}

function ToolResultCard({ result }: { result: NonNullable<ToolApprovalCardModel['result']> }) {
  return (
    <section className="aui-tool-result" aria-label="Tool result">
      <h3>Result</h3>
      <MetaGrid items={[
        { label: 'Status', value: result.status },
        { label: 'Provider', value: result.providerPeerId ?? 'local' },
        { label: 'Correlation', value: result.correlationId ?? 'pending', mono: true },
        { label: 'Audit receipt', value: result.auditReceipt ?? 'pending', mono: true },
        { label: 'Route path', value: result.routePath.join(' -> ') || 'not reported' },
        { label: 'Duration', value: result.durationMs === null ? 'not reported' : `${result.durationMs}ms` },
        { label: 'Redaction', value: result.redactionStatus ?? 'not reported' },
        { label: 'Retry/fallback', value: `${result.retryEligible ? 'retry' : 'no retry'} / ${result.fallbackEligible ? 'fallback' : 'no fallback'}` }
      ]} />
      <RedactedPreview label="Redacted output" value={result.outputPreview} fallback={result.error ?? 'No output preview reported.'} />
    </section>
  )
}

function RedactedPreview({ label, value, fallback }: { label: string; value: object | null; fallback: string }) {
  return <div className="aui-redacted-preview"><h3>{label}</h3><code>{value ? JSON.stringify(value, null, 2) : fallback}</code></div>
}

function toolSchemaFields(tool: ToolApprovalCardModel) {
  const required = schemaRequiredFields(tool.argsSchema)
  const properties = schemaProperties(tool.argsSchema)
  if (properties) {
    return Object.entries(properties).map(([name, schema]) => ({ name, type: schemaFieldType(schema), required: required.includes(name), example: exampleValue(name, tool) }))
  }
  if (tool.argsPreview) {
    return Object.keys(tool.argsPreview).map((name) => ({ name, type: typeof tool.argsPreview?.[name], required: false, example: exampleValue(name, tool) }))
  }
  return []
}

function schemaProperties(schema: object | null) {
  const properties = recordValue(schema, 'properties')
  return properties && !Array.isArray(properties) ? properties : null
}
function schemaRequiredFields(schema: object | null) {
  const required = schema && 'required' in schema ? (schema as Record<string, unknown>).required : null
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}
function schemaFieldType(schema: unknown) {
  const type = recordValue(schema, 'type')
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.filter((value) => typeof value === 'string').join(' | ') || 'unknown'
  const enumValues = recordValue(schema, 'enum')
  return Array.isArray(enumValues) ? `enum(${enumValues.join(', ')})` : 'unknown'
}
function exampleValue(name: string, tool: ToolApprovalCardModel) {
  const value = recordValue(tool.argsPreview, name) ?? recordValue(tool.dryRunPreview, name) ?? ''
  if (value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}
function recordValue(value: unknown, key: string): Record<string, unknown> | unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return (value as Record<string, unknown>)[key] ?? null
}

function safeLocalExecutable(tool: ToolApprovalCardModel) {
  const localProvider = tool.providerKind === 'local' || tool.providerPeerId === null || tool.providerPeerId === 'local-peer' || tool.transport === 'local-bus'
  return localProvider && tool.state === 'ready' && !tool.approvalRequired && !tool.requiresAdminAction && !tool.mutating && !tool.dataEgress && !tool.providerSelectorRequired
}
function schedulerAvailability(job: NormalizedSchedulerJob) {
  if (job.blocked_reason || job.last_error) return 'denied' as const
  if (!job.enabled || job.status === 'paused') return 'degraded' as const
  if (job.status === 'delegated' || job.status === 'remote-running') return 'available-remote' as const
  return 'available-local' as const
}
function stateCopy(tool: ToolApprovalCardModel): string {
  if (tool.state === 'provider-selector-required') return 'Provider selector required before approval.'
  if (tool.state === 'dry-run-only') return 'Dry-run only until backend policy permits execution.'
  if (tool.state === 'denied') return `Denied: ${tool.denialReason ?? 'backend policy denied approval'}.`
  if (tool.state === 'expired') return 'Approval expired; request a fresh backend approval.'
  if (tool.state === 'replay-rejected') return `Replay rejected: ${tool.denialReason ?? 'backend replay protection blocked it'}.`
  if (tool.state === 'unavailable') return `Unavailable: ${tool.disabledReason ?? 'service unavailable'}. Disabled until provider/service repair completes.`
  if (tool.state === 'executed') return 'Tool result includes audit and correlation status.'
  if (tool.requiresAdminAction) return 'AdminAction confirmation required before approval or execution.'
  if (tool.approvalRequired) return 'Approval required before execution.'
  return 'No approval required by current backend policy.'
}
function toolStateIcon(tool: ToolApprovalCardModel) {
  if (tool.state === 'ready' || tool.state === 'approved' || tool.state === 'executed') return <Check size={16} aria-hidden />
  if (tool.state === 'expired') return <Clock size={16} aria-hidden />
  if (tool.state === 'dry-run-only') return <FlaskConical size={16} aria-hidden />
  if (isBlockedTool(tool)) return <ShieldAlert size={16} aria-hidden />
  return <Play size={16} aria-hidden />
}
function scopeLabel(scope: ToolApprovalScope): string {
  if (scope === 'once') return 'Approve once'
  if (scope === 'session') return 'Approve session'
  if (scope === 'peer') return 'Approve peer'
  if (scope === 'local-safe-tools') return 'Approve local safe'
  return `Approve ${scope}`
}
function effectivePolicyCopy(tool: ToolApprovalCardModel, source: ToolingSourceModel): string {
  if (isBlockedTool(tool)) return 'Blocked override or provider error wins over parent source trust.'
  if (source.effectiveTrust === 'trusted' && !tool.approvalRequired) return 'Inherited trusted from reviewed source.'
  if (tool.approvalRequired) return 'Approval required for this exact tool scope.'
  return `Inherited ${source.effectiveTrust} from ${source.name}.`
}
function capabilityCopy(tool: ToolApprovalCardModel): string {
  const flags = [tool.mutating ? 'write/execute' : 'read', tool.dataEgress ? 'network/data egress' : 'local data', tool.requiresAdminAction ? 'admin' : null].filter(Boolean)
  return flags.join(' · ')
}
function riskClassName(risk: string): string {
  return risk.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}
