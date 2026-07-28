'use client'

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
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
import type { AuroraClient, AvailabilityState, JsonValue, McpSourceWizardDraft, NormalizedSchedulerJob, PluginSourceWizardDraft, ToolApprovalCardModel, ToolApprovalGrantModel, ToolApprovalScope, ToolExportDecisionModel, ToolExportPolicyModel, ToolExportScopeModel, ToolOnboardingValidationResult, ToolPolicyAuditEventModel, ToolPendingApprovalModel, ToolSourceDetailModel, ToolSourceSummaryModel, ToolingPageViewModel } from '@aurora/client'
import type { RouteAvailability } from '../shell-data'
import { getAuroraSurfaceProfile } from '../platform-surface'
import { safeErrorCopy } from '../product-copy'
import { ToneBadge, riskTone, trustTone, stateTone, type BadgeTone } from '../status-badges'
import { PageHeader } from '../state-surface'
import { Button, Card, DataTable, MetaGrid, StatStrip, Switch, type DataColumn } from '../primitives'
import { PageTabs } from '../shared-components'
import { Alert, AlertDescription } from '#components/ui/alert'
import { Badge } from '#components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { cn } from '#lib/utils'
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
  type BuiltinPluginModel,
  type ToolingSourceModel,
  type ToolingSourceType,
  type ToolingTrustState
} from './source-model'
import { ToolSharingGroupControl, ToolSharingRowControl, type ToolSharingMutation } from './tool-sharing-controls'

const SELECTED_SEGMENT_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in oklab, var(--primary) 22%, var(--muted))',
  color: 'var(--primary)',
  boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--primary) 38%, transparent)'
}

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
  builtinPlugins?: BuiltinPluginModel[] | undefined
  managementLoading?: boolean | undefined
  managementError?: string | null | undefined
  sharingPolicy?: ToolExportPolicyModel | null | undefined
  sharingPeers?: ToolExportScopeModel[] | undefined
  sharingDecisions?: Record<string, ToolExportDecisionModel | null> | undefined
  sharingLoading?: boolean | undefined
  sharingError?: string | null | undefined
  sharingMessage?: string | null | undefined
  sharingPendingKey?: string | null | undefined
  onMutateSharing?: ((mutation: ToolSharingMutation) => void) | undefined
  onTogglePlugin?: ((plugin: BuiltinPluginModel, active: boolean) => void) | undefined
  onSavePluginConfig?: ((plugin: BuiltinPluginModel, values: Record<string, JsonValue>) => void) | undefined
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

const SOURCE_SECTIONS: ToolingSourceType[] = ['core', 'mcp', 'mesh', 'unknown', 'blocked']
type ToolingPageTab = 'tools' | 'plugins'
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
  builtinPlugins = [],
  managementLoading = false,
  managementError = null,
  sharingPolicy = null,
  sharingPeers = [],
  sharingDecisions = {},
  sharingLoading = false,
  sharingError = null,
  sharingMessage = null,
  sharingPendingKey = null,
  onMutateSharing,
  onTogglePlugin,
  onSavePluginConfig,
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
  const [activePageTab, setActivePageTab] = useState<ToolingPageTab>('tools')
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
  const inventoryLoading = loading || managementLoading
  const sources = useMemo(
    () => managementLoading
      ? []
      : sourceSummaries.length > 0
        ? buildToolingSourcesFromBackend(sourceSummaries, sourceDetails, tools)
        : buildToolingSources(tools),
    [managementLoading, sourceSummaries, sourceDetails, tools]
  )
  const toolSources = useMemo(() => sources.filter((source) => source.type !== 'plugin'), [sources])
  const pluginSources = useMemo(() => sources.filter((source) => source.type === 'plugin'), [sources])
  const selectedSource = toolSources.find((source) => source.id === selectedSourceId) ?? toolSources[0] ?? null
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

  function showWizard(type: 'mcp' | 'plugin') {
    setWizard(type)
    setWizardStep(1)
    setActivePageTab(type === 'plugin' ? 'plugins' : 'tools')
  }

  return (
    <section aria-labelledby="tool-approval-title" className="flex flex-col gap-4">
      <PageHeader
        eyebrow={null}
        id="tool-approval-title"
        title="Tools & Plugins"
        description="Review tool sources, choose what needs approval, and add MCP servers or plugins."
        actions={
          <div className="flex flex-wrap items-center gap-2" aria-label="Tools policy summary">
            {managementLoading ? (
              <>
                <Badge variant="outline">Policy loading…</Badge>
                <Badge variant="outline">Sources loading…</Badge>
              </>
            ) : (
              <Badge variant="outline">Policy: <strong className="ml-1 font-semibold">{policyModeLabel(policy.mode)}</strong></Badge>
            )}
            <Button variant="primary" icon={<Plug size={15} aria-hidden />} onClick={() => showWizard('mcp')} disabled={managementLoading}>Add MCP source</Button>
          </div>
        }
      />

      {route.disabled ? (
        <Alert variant="destructive" role="alert">
          <ShieldAlert />
          <AlertDescription>Tools are unavailable. Review access and try again.</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertDescription>{toolingSafeMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
      {managementError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertDescription>{toolingSafeMessage(managementError)}</AlertDescription>
        </Alert>
      ) : null}
      {managementLoading ? (
        <Alert role="status">
          <RefreshCw />
          <AlertDescription>Loading tools and approval settings...</AlertDescription>
        </Alert>
      ) : null}

      <PageTabs
        value={activePageTab}
        onValueChange={(value) => setActivePageTab(value === 'plugins' ? 'plugins' : 'tools')}
        ariaLabel="Tools and plugins sections"
        items={[
          {
            value: 'tools',
            label: 'Tools',
            content: (
              <div className="flex flex-col gap-4 py-4 lg:flex-row lg:items-start" aria-label="Tools">
                <SourceRail
                  sources={toolSources}
                  selectedSourceId={selectedSource?.id ?? null}
                  loading={inventoryLoading}
                  query={query}
                  onQuery={setQuery}
                  drawerOpen={sourceDrawerOpen}
                  onDrawerOpen={setSourceDrawerOpen}
                  onSelectSource={(source) => setSelectedSourceId(source.id)}
                  onAddMcp={() => showWizard('mcp')}
                />

                <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-auto" aria-label="Source detail">
                  {inventoryLoading ? <LoadingState /> : null}
                  {!inventoryLoading && toolSources.length === 0 ? <EmptyCatalog onAddMcp={() => showWizard('mcp')} /> : null}
                  {!inventoryLoading && selectedSource ? (
                    <>
                      <SourceOverview
                        source={selectedSource}
                        policyBypass={policy.bypassEnabled}
                        policyMessage={decisionMessages.__policy__ ?? null}
                        onUpsertSourcePolicy={onUpsertSourcePolicy}
                        sharingControl={selectedSource.type !== 'mesh' && selectedSource.shareGroupId ? (
                          <ToolSharingGroupControl
                            groupId={selectedSource.shareGroupId}
                            groupLabel={selectedSource.shareGroupLabel ?? selectedSource.name}
                            policy={sharingPolicy}
                            peers={sharingPeers}
                            loading={sharingLoading}
                            error={sharingError}
                            message={sharingMessage}
                            pending={sharingPendingKey === `group:${selectedSource.shareGroupId}`}
                            {...(onMutateSharing ? { onMutate: onMutateSharing } : {})}
                          />
                        ) : null}
                      />
                      <ToolDetailTable
                        source={selectedSource}
                        tools={filteredSourceTools}
                        decisionMessages={decisionMessages}
                        onUpsertToolOverride={onUpsertToolOverride}
                        sharingPolicy={sharingPolicy}
                        sharingPeers={sharingPeers}
                        sharingDecisions={sharingDecisions}
                        sharingLoading={sharingLoading}
                        sharingError={sharingError}
                        sharingMessage={sharingMessage}
                        sharingPendingKey={sharingPendingKey}
                        onMutateSharing={onMutateSharing}
                      />
                    </>
                  ) : null}
                </main>
              </div>
            )
          },
          {
            value: 'plugins',
            label: 'Plugins',
            content: (
              <PluginsWorkspace
                loading={managementLoading}
                pluginSources={pluginSources}
                builtinPlugins={builtinPlugins}
                tools={tools}
                surfaceLabel={surfaceProfile.label}
                wizard={wizard === 'plugin' ? wizard : null}
                wizardStep={wizardStep}
                pluginDraft={pluginDraft}
                resultMessage={decisionMessages.__plugins__ ?? wizardResult ?? decisionMessages.__policy__ ?? null}
                onTogglePlugin={onTogglePlugin}
                onSavePluginConfig={onSavePluginConfig}
                onStep={setWizardStep}
                onPluginDraft={setPluginDraft}
                onClose={() => setWizard(null)}
                onConfigure={(source) => {
                  setWizard('plugin')
                  setWizardStep(1)
                  setPluginDraft({
                    ...pluginDraft,
                    packageName: source.name,
                    pluginId: source.serviceInstanceId ?? source.id,
                    sourceUrl: typeof source.transport === 'string' && source.transport.startsWith('http') ? source.transport : (pluginDraft.sourceUrl ?? null),
                    reason: `Configure plugin source ${source.id} from /tools`
                  })
                }}
                onTestSource={async (draft) => {
                  setWizardResult('Checking plugin...')
                  try {
                    const result = await onTestSource?.('plugin', draft)
                    setWizardResult(onboardingResultMessage('plugin', 'test', result))
                  } catch (error) {
                    setWizardResult(toolingSafeMessage(error))
                  }
                }}
                onCreateSource={async (draft) => {
                  setWizardResult('Saving plugin...')
                  try {
                    const result = await onCreateSource?.('plugin', draft)
                    setWizardResult(onboardingResultMessage('plugin', 'create', result))
                  } catch (error) {
                    setWizardResult(toolingSafeMessage(error))
                  }
                }}
              />
            )
          }
        ]}
      />

      {wizard === 'mcp' ? (
        <McpSourceModal
          canLaunchLocalCommands={surfaceProfile.supportsDesktopCommands}
          wizardStep={wizardStep}
          mcpDraft={mcpDraft}
          resultMessage={wizardResult ?? decisionMessages.__policy__ ?? null}
          onClose={() => setWizard(null)}
          onStep={setWizardStep}
          onMcpDraft={setMcpDraft}
          onTestSource={async (draft) => {
            setWizardResult('Testing MCP source...')
            try {
              const result = await onTestSource?.('mcp', draft)
              setWizardResult(onboardingResultMessage('mcp', 'test', result))
            } catch (error) {
              setWizardResult(toolingSafeMessage(error))
            }
          }}
          onCreateSource={async (draft) => {
            setWizardResult('Creating MCP source...')
            try {
              const result = await onCreateSource?.('mcp', draft)
              setWizardResult(onboardingResultMessage('mcp', 'create', result))
            } catch (error) {
              setWizardResult(toolingSafeMessage(error))
            }
          }}
        />
      ) : null}

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
      ariaLabel="Tooling policy"
      icon={<ShieldCheck size={18} aria-hidden />}
      title="Tooling policy"
      description="Global tool policy. Aurora reads saved management state first and sends changes through the approved admin flow."
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
          { label: 'Connection', value: policyConnectionLabel(transportKind), caption: surfaceLabel }
        ]}
      />
      {dangerous ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertDescription>{policy.denyAll ? 'Deny-all mode is active or inferred from Tooling policy/catalog state.' : 'Dry-run or bypass-sensitive policy state needs operator review.'}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Policy controls">
        {['enforce', 'dry_run_only', 'deny_all', 'unrestricted_except_blocked'].map((mode) => (
          <Button key={mode} variant={policy.mode === mode ? 'primary' : 'outline'} ariaPressed={policy.mode === mode} onClick={() => onSetPolicyMode?.(mode)} disabled={!onSetPolicyMode} disabledReason="Route through Tooling.SetPolicyMode.">
            {mode}
          </Button>
        ))}
        <Badge variant="outline" className="gap-1"><Lock size={14} aria-hidden />Dangerous confirmations: ALLOW NON-BLOCKED TOOLS · DENY ALL TOOLS · DRY RUN ONLY</Badge>
        <Badge variant="outline" className="gap-1"><FileDiff size={14} aria-hidden />{`${route.item.capabilityModule}.${route.item.capabilityMethod ?? route.item.expectedTask}`}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Source catalog lifecycle">
        <Badge variant="outline" className="gap-1"><Network size={14} aria-hidden />Negotiated catalog cache</Badge>
        <Badge variant="outline">epoch / hash tracked for mesh peers</Badge>
        <Badge variant="outline">stale, removed / unshared, stale grant, missing grant states block scheduler execution</Badge>
        <Badge variant="outline">Scheduled tool actions via Scheduler.ListJobs</Badge>
        <Badge variant="outline">Grant dependency warnings link to /admin/scheduler</Badge>
        <Badge variant="outline">AdminAction confirmation protects high-risk scheduled executions</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Management workspaces">
        <Badge variant="outline" className="gap-1"><KeyRound size={14} aria-hidden />Durable grants</Badge>
        <Badge variant="outline" className="gap-1"><Clock size={14} aria-hidden />Pending approvals</Badge>
        <Badge variant="outline">Approve in Assistant for one exact tool use</Badge>
        <Badge variant="outline" className="gap-1"><History size={14} aria-hidden />Activity and audit with correlation ID</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Platform surfaces">
        <Badge variant="outline">Desktop local</Badge>
        <Badge variant="outline">Web</Badge>
        <Badge variant="outline">Android</Badge>
        <Badge variant="outline">iOS</Badge>
      </div>
      <MetaGrid columns={2} items={[
        { label: 'Last policy change', value: policy.lastChanged },
        { label: 'Actor', value: policy.actor },
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
  const visibleSources = sources.filter((source) => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return true
    return [source.name, source.providerLabel, source.catalogState, source.type].some((value) => value.toLowerCase().includes(normalized))
      || source.tools.some((tool) => [tool.name, tool.description].some((value) => value.toLowerCase().includes(normalized)))
  })
  return (
    <aside
      id="tool-source-drawer"
      className={cn('flex-col gap-3 rounded-xl border border-border bg-card p-3 lg:flex lg:w-72 lg:shrink-0', drawerOpen ? 'flex' : 'hidden lg:flex')}
      aria-label="Source rail"
    >
      <div className="flex items-center justify-between lg:hidden">
        <strong className="text-sm font-semibold">Sources</strong>
        <Button
          variant="outline"
          ariaExpanded={drawerOpen}
          ariaControls="tool-source-drawer"
          onClick={() => onDrawerOpen(!drawerOpen)}
        >
          {drawerOpen ? 'Close' : 'Sources'}
        </Button>
      </div>
      <label className="relative">
        <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <span className="sr-only">Search sources and tools</span>
        <input
          className="h-9 w-full rounded-lg border border-border bg-transparent pr-3 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={query}
          onChange={(event) => onQuery(event.currentTarget.value)}
          type="search"
          placeholder="Search sources or tools"
          disabled={loading}
        />
      </label>
      {loading ? <p className="text-sm text-muted-foreground">Loading tools…</p> : null}
      <div className="flex flex-col gap-1" aria-label="Tool sources">
        {!loading && visibleSources.length === 0 ? <p className="text-sm text-muted-foreground">No sources match this search.</p> : null}
        {visibleSources.map((source) => (
          <button
            key={source.id}
            type="button"
            className={cn(
              'flex items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted',
              selectedSourceId === source.id && 'border-border bg-muted'
            )}
            aria-pressed={selectedSourceId === source.id}
            onClick={() => onSelectSource(source)}
          >
            <span className="flex flex-col">
              <strong className="font-medium">{source.name}</strong>
              <small className="text-xs text-muted-foreground">{sourceSectionLabel(source.type)} · {source.toolCount} tools</small>
            </span>
            <TrustPill trust={source.effectiveTrust} />
          </button>
        ))}
      </div>
      <Button variant="outline" icon={<Plug size={15} aria-hidden />} onClick={onAddMcp} disabled={loading}>Add MCP source</Button>
    </aside>
  )
}

const SOURCE_TRUST_ACTIONS: { tier: 'inherit' | 'trusted' | 'untrusted' | 'blocked'; label: string }[] = [
  { tier: 'inherit', label: 'Inherit' },
  { tier: 'trusted', label: 'Trust all' },
  { tier: 'untrusted', label: 'Require approval' },
  { tier: 'blocked', label: 'Block all' },
]

function SourceOverview({
  source,
  policyBypass,
  policyMessage,
  sharingControl,
  onUpsertSourcePolicy
}: {
  source: ToolingSourceModel
  policyBypass: boolean
  policyMessage: string | null
  sharingControl?: ReactNode
  onUpsertSourcePolicy?: ((source: ToolingSourceModel, trustTier: string, includeFutureTools?: boolean) => void) | undefined
}) {
  const configuredTier = source.configuredTrustTier ?? 'inherit'
  return (
    <Card
      ariaLabel="Selected source overview"
      title="Execution approval"
      description={`Controls the approval or grant required after sharing, service policy, and peer permissions have already allowed a request. ${source.name} · ${sourceSectionLabel(source.type)} · ${source.toolCount} tools.`}
      actions={<><TrustPill trust={source.effectiveTrust} />{policyBypass ? <ToneBadge tone="danger">Wide access</ToneBadge> : null}</>}
    >
      <div className="flex flex-col gap-1 bg-muted/10 px-3">
        <div className="flex flex-col gap-2.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <strong className="text-sm">Default approval</strong>
            <span className="text-xs text-muted-foreground">Applies to this source and newly discovered tools.</span>
          </div>
          <ToggleGroup
            value={[configuredTier]}
            onValueChange={(values) => {
              const trustTier = values[0]
              if (trustTier) onUpsertSourcePolicy?.(source, trustTier, true)
            }}
            variant="default"
            spacing={1}
            disabled={!onUpsertSourcePolicy}
            aria-label={`Trust policy for ${source.name}`}
            className="bg-background/60 p-1 shadow-inner"
          >
            {SOURCE_TRUST_ACTIONS.map((action) => (
              <ToggleGroupItem
                key={action.tier}
                value={action.tier}
                className={cn(
                  'bg-muted/60 text-foreground/75 shadow-sm transition-colors hover:bg-muted hover:text-foreground',
                  configuredTier === action.tier && 'font-medium shadow-none'
                )}
                style={configuredTier === action.tier ? SELECTED_SEGMENT_STYLE : undefined}
              >
                {action.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {sharingControl}
      </div>
      {policyMessage ? <p className="mt-2 text-xs" aria-live="polite">{policyMessage}</p> : null}
    </Card>
  )
}

function WorkspaceTabs({ activeTab, onTab, pendingCount }: { activeTab: ToolingWorkspaceTab; onTab: (tab: ToolingWorkspaceTab) => void; pendingCount: number }) {
  const tabs = [
    ['tools', 'Tools'], ['policy', 'Policy'], ['grants', 'Grants'], ['approvals', `Approvals ${pendingCount}`], ['scheduler', 'Scheduler'], ['activity', 'Audit'], ['onboarding', 'Onboarding']
  ] as const
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Source workspace tabs">
      {tabs.map(([id, label]) => (
        <Button key={id} variant={activeTab === id ? 'primary' : 'outline'} ariaPressed={activeTab === id} onClick={() => onTab(id)}>{label}</Button>
      ))}
    </div>
  )
}

function PluginsWorkspace({
  loading,
  pluginSources,
  builtinPlugins,
  tools,
  wizard,
  wizardStep,
  pluginDraft,
  resultMessage,
  onStep,
  onPluginDraft,
  onConfigure,
  onClose,
  onTogglePlugin,
  onSavePluginConfig,
  onTestSource,
  onCreateSource
}: {
  loading: boolean
  pluginSources: ToolingSourceModel[]
  builtinPlugins: BuiltinPluginModel[]
  tools: ToolApprovalCardModel[]
  surfaceLabel: string
  wizard: 'plugin' | null
  wizardStep: number
  pluginDraft: PluginSourceWizardDraft
  resultMessage: string | null
  onStep: (step: number) => void
  onPluginDraft: (draft: PluginSourceWizardDraft) => void
  onConfigure: (source: ToolingSourceModel) => void
  onClose: () => void
  onTogglePlugin?: ((plugin: BuiltinPluginModel, active: boolean) => void) | undefined
  onSavePluginConfig?: ((plugin: BuiltinPluginModel, values: Record<string, JsonValue>) => void) | undefined
  onTestSource?: ((draft: PluginSourceWizardDraft) => Promise<void> | void) | undefined
  onCreateSource?: ((draft: PluginSourceWizardDraft) => Promise<void> | void) | undefined
}) {
  void tools
  const [configPluginId, setConfigPluginId] = useState<string | null>(null)
  const configPlugin = builtinPlugins.find((plugin) => plugin.id === configPluginId) ?? null
  const plugins = pluginSources.map((source) => ({ source, status: pluginStatus(source) }))
  return (
    <main className="flex flex-col gap-4 py-4" aria-label="Plugins">
      {loading ? <LoadingState title="Loading plugins" detail="Loading plugins and saved settings." /> : null}
      {resultMessage ? <Alert><AlertDescription>{toolingSafeMessage(resultMessage)}</AlertDescription></Alert> : null}
      {!loading && builtinPlugins.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3.5">
          {builtinPlugins.map((plugin) => {
            const status = plugin.active ? 'active' : plugin.configured ? 'ready to activate' : 'not configured'
            return (
              <Card
                key={plugin.id}
                title={plugin.label}
                icon={<Package size={18} aria-hidden />}
                description={builtinPluginDescription(plugin)}
                actions={<ToneBadge tone={plugin.active ? 'success' : plugin.configured ? 'neutral' : 'warning'}>{status}</ToneBadge>}
              >
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <Switch
                    checked={plugin.active}
                    label={plugin.active ? 'Active' : 'Inactive'}
                    disabled={!onTogglePlugin || (!plugin.active && !plugin.configured && plugin.fields.length > 0)}
                    disabledReason={!onTogglePlugin ? 'Plugin activation is unavailable in this surface.' : 'Configure credentials before activating.'}
                    onChange={(checked) => onTogglePlugin?.(plugin, checked)}
                    id={`plugin-active-${plugin.id}`}
                  />
                  {plugin.fields.length > 0 ? (
                    <Button variant={plugin.configured ? 'outline' : 'primary'} onClick={() => setConfigPluginId(plugin.id)}>
                      Configure
                    </Button>
                  ) : null}
                </div>
              </Card>
            )
          })}
        </div>
      ) : null}
      {!loading && plugins.length > 0 ? (
        <>
          <h3 className="mt-2 text-sm font-semibold">Plugin tool sources</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3.5">
            {plugins.map(({ source, status }) => (
              <Card key={source.id} title={source.name} icon={<Package size={18} aria-hidden />} description={`${sourceSectionLabel(source.type)} · ${source.toolCount} tools`} actions={<ToneBadge tone={pluginStatusTone(status)}>{status}</ToneBadge>}>
                <p className="text-sm text-muted-foreground">{source.providerLabel}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="outline" onClick={() => onConfigure(source)}>Configure source</Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}
      {!loading && builtinPlugins.length === 0 && plugins.length === 0 ? (
        <Card title="Plugins" icon={<Package size={18} aria-hidden />} description="No plugins are available on this Aurora device yet." actions={<Button variant="primary" icon={<Package size={15} aria-hidden />} onClick={() => onConfigure(newPluginSourceDraft())}>Add plugin source</Button>} />
      ) : null}
      {configPlugin ? (
        <BuiltinPluginConfigModal
          plugin={configPlugin}
          onClose={() => setConfigPluginId(null)}
          onSave={(values) => {
            onSavePluginConfig?.(configPlugin, values)
            setConfigPluginId(null)
          }}
        />
      ) : null}
      {wizard ? (
        <PluginConfigModal
          pluginName={pluginDraft.packageName || pluginDraft.pluginId || 'plugin'}
          wizardStep={wizardStep}
          pluginDraft={pluginDraft}
          resultMessage={resultMessage}
          onClose={onClose}
          onStep={onStep}
          onPluginDraft={onPluginDraft}
          onTestSource={onTestSource}
          onCreateSource={onCreateSource}
        />
      ) : null}
    </main>
  )
}

function builtinPluginDescription(plugin: BuiltinPluginModel): string {
  if (plugin.fields.length === 0) return 'Built-in plugin; no extra credentials required.'
  const fieldNames = plugin.fields.map((field) => field.key_path.split('.').at(-1)?.replace(/_/g, ' ')).filter(Boolean)
  return `Built-in plugin; needs ${fieldNames.join(', ')}.`
}

function BuiltinPluginConfigModal({ plugin, onClose, onSave }: { plugin: BuiltinPluginModel; onClose: () => void; onSave: (values: Record<string, JsonValue>) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const changes: Record<string, JsonValue> = {}
  for (const [keyPath, value] of Object.entries(drafts)) {
    if (value !== '') changes[keyPath] = value
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <Card
        className="w-full max-w-md"
        title={`Configure ${plugin.label}`}
        icon={<KeyRound size={18} aria-hidden />}
        description="Credentials are saved securely; secrets are never shown again."
        actions={<Button variant="ghost" onClick={onClose} ariaLabel={`Close configure ${plugin.label}`}>Close</Button>}
      >
        <div className="flex flex-col gap-3">
          {plugin.fields.map((field) => {
            const leaf = field.key_path.split('.').at(-1) ?? field.key_path
            const isSet = field.current_value !== null && field.current_value !== undefined && field.current_value !== ''
            return (
              <label key={field.key_path} className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">
                  {leaf.replace(/_/g, ' ')}
                  {field.secret ? ' (secret)' : ''}
                  {isSet ? ' · currently set' : ' · not set'}
                </span>
                <input
                  type={field.secret ? 'password' : 'text'}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  placeholder={isSet ? 'Leave blank to keep the current value' : field.description || leaf}
                  value={drafts[field.key_path] ?? ''}
                  onChange={(event) => setDrafts((current) => ({ ...current, [field.key_path]: event.currentTarget.value }))}
                />
              </label>
            )
          })}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => onSave(changes)} ariaLabel={`Save ${plugin.label} configuration`}>
              Save
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function McpSourceModal({
  canLaunchLocalCommands,
  wizardStep,
  mcpDraft,
  resultMessage,
  onClose,
  onStep,
  onMcpDraft,
  onTestSource,
  onCreateSource
}: {
  canLaunchLocalCommands: boolean
  wizardStep: number
  mcpDraft: McpSourceWizardDraft
  resultMessage: string | null
  onClose: () => void
  onStep: (step: number) => void
  onMcpDraft: (draft: McpSourceWizardDraft) => void
  onTestSource?: ((draft: McpSourceWizardDraft) => Promise<void> | void) | undefined
  onCreateSource?: ((draft: McpSourceWizardDraft) => Promise<void> | void) | undefined
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <Card className="w-full max-w-lg" title="Add MCP source" icon={<Plug size={18} aria-hidden />} description="Connect a new MCP server. New tools need review before Aurora uses them." actions={<Button variant="ghost" onClick={onClose} ariaLabel="Close Add MCP source">Close</Button>}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="MCP source steps">{['Details', 'Authenticate', 'Discover', 'Trust'].map((label, index) => <Button key={label} variant={wizardStep === index + 1 ? 'primary' : 'outline'} ariaPressed={wizardStep === index + 1} onClick={() => onStep(index + 1)}>{index + 1}. {label}</Button>)}</div>
          <WizardStep wizard="mcp" step={wizardStep} canLaunchLocalCommands={canLaunchLocalCommands} mcpDraft={mcpDraft} pluginDraft={{ packageName: '', pluginId: '', version: '', sourceUrl: '', trustTier: 'untrusted', includeFutureTools: false }} resultMessage={resultMessage} onMcpDraft={onMcpDraft} onPluginDraft={() => undefined} onTestSource={(_, draft) => onTestSource?.(draft as McpSourceWizardDraft)} onCreateSource={(_, draft) => onCreateSource?.(draft as McpSourceWizardDraft)} />
        </div>
      </Card>
    </div>
  )
}

function PluginConfigModal({
  pluginName,
  wizardStep,
  pluginDraft,
  resultMessage,
  onClose,
  onStep,
  onPluginDraft,
  onTestSource,
  onCreateSource
}: {
  pluginName: string
  wizardStep: number
  pluginDraft: PluginSourceWizardDraft
  resultMessage: string | null
  onClose: () => void
  onStep: (step: number) => void
  onPluginDraft: (draft: PluginSourceWizardDraft) => void
  onTestSource?: ((draft: PluginSourceWizardDraft) => Promise<void> | void) | undefined
  onCreateSource?: ((draft: PluginSourceWizardDraft) => Promise<void> | void) | undefined
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <Card className="w-full max-w-lg" title={`Configure ${pluginName}`} icon={<ServerCog size={18} aria-hidden />} description="Save the plugin details, then review its tools before Aurora uses them." actions={<Button variant="ghost" onClick={onClose} ariaLabel="Close plugin configuration">Close</Button>}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Plugin configure steps">{['Details', 'Authenticate', 'Discover', 'Trust'].map((label, index) => <Button key={label} variant={wizardStep === index + 1 ? 'primary' : 'outline'} ariaPressed={wizardStep === index + 1} onClick={() => onStep(index + 1)}>{index + 1}. {label}</Button>)}</div>
          <WizardStep wizard="plugin" step={wizardStep} canLaunchLocalCommands={false} mcpDraft={{ name: '', transport: 'streamable_http', trustTier: 'untrusted', includeFutureTools: false }} pluginDraft={pluginDraft} resultMessage={resultMessage} onMcpDraft={() => undefined} onPluginDraft={onPluginDraft} onTestSource={(_, draft) => onTestSource?.(draft as PluginSourceWizardDraft)} onCreateSource={(_, draft) => onCreateSource?.(draft as PluginSourceWizardDraft)} />
          <div className="flex items-center gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { void onCreateSource?.(pluginDraft) }}>Save & activate</Button></div>
        </div>
      </Card>
    </div>
  )
}

function newPluginSourceDraft(): ToolingSourceModel {
  return {
    id: 'local:plugin:new',
    type: 'plugin',
    name: 'New plugin',
    providerLabel: 'New plugin',
    providerKind: 'plugin',
    transport: null,
    peerId: 'local',
    serviceInstanceId: null,
    trustTier: 'untrusted',
    configuredTrustTier: null,
    effectiveTrust: 'approval-required',
    toolCount: 0,
    blockedToolCount: 0,
    pendingApprovalCount: 0,
    safeToolCount: 0,
    mutatingToolCount: 0,
    externalToolCount: 0,
    adminToolCount: 0,
    lastSeenLabel: 'new SDK draft',
    catalogState: 'unconfigured',
    catalogEvidence: 'Tooling.CreatePluginSource',
    routePath: ['Tooling.TestPluginSource', 'Tooling.CreatePluginSource'],
    tools: []
  }
}

function pluginStatus(source: ToolingSourceModel): 'active' | 'inactive' | 'unconfigured' {
  if (source.catalogState === 'active' || source.effectiveTrust === 'trusted') return 'active'
  if (['blocked', 'stale', 'removed', 'unshared'].some((state) => source.catalogState.includes(state)) || source.effectiveTrust === 'blocked') return 'inactive'
  return 'unconfigured'
}

function pluginStatusTone(status: 'active' | 'inactive' | 'unconfigured'): BadgeTone {
  if (status === 'active') return 'success'
  if (status === 'inactive') return 'danger'
  return 'neutral'
}

const TOOL_POLICY_ACTIONS: { mode: string; label: string; trustTier: string | null }[] = [
  { mode: 'inherit', label: 'Inherit', trustTier: null },
  { mode: 'approve_all_for_peer', label: 'Trust', trustTier: 'trusted' },
  { mode: 'ask_each_time', label: 'Require approval', trustTier: 'untrusted' },
  { mode: 'deny_all', label: 'Block', trustTier: 'blocked' },
]

interface ToolPolicyTag {
  label: string
  tone: BadgeTone
}

/** Effective per-tool policy derived from the catalog card (trust tier, approval and dry-run flags). */
function toolPolicyTag(tool: ToolApprovalCardModel): ToolPolicyTag {
  if (tool.blockReasonCode === 'permission_denied' || tool.blockReasonCode === 'recipient_missing_tool_permissions') {
    return { label: 'missing permission', tone: 'danger' }
  }
  if (tool.trustTier === 'blocked' || isBlockedTool(tool)) return { label: 'blocked', tone: 'danger' }
  if (tool.dryRunRequired || tool.state === 'dry-run-only') return { label: 'dry-run only', tone: 'warning' }
  if (tool.requiresAdminAction) return { label: 'admin action', tone: 'warning' }
  if (tool.approvalRequired) return { label: 'approval required', tone: 'warning' }
  if (tool.trustTier === 'trusted') return { label: 'trusted', tone: 'success' }
  return { label: 'approval required', tone: 'warning' }
}

function ToolDetailTable({
  source,
  tools,
  decisionMessages,
  onUpsertToolOverride,
  sharingPolicy,
  sharingPeers,
  sharingDecisions,
  sharingLoading,
  sharingError,
  sharingMessage,
  sharingPendingKey,
  onMutateSharing
}: {
  source: ToolingSourceModel
  tools: ToolApprovalCardModel[]
  decisionMessages: Record<string, string>
  onUpsertToolOverride?: ((tool: ToolApprovalCardModel, approvalMode: string) => void) | undefined
  sharingPolicy: ToolExportPolicyModel | null
  sharingPeers: ToolExportScopeModel[]
  sharingDecisions: Record<string, ToolExportDecisionModel | null>
  sharingLoading: boolean
  sharingError: string | null
  sharingMessage: string | null
  sharingPendingKey: string | null
  onMutateSharing?: ((mutation: ToolSharingMutation) => void) | undefined
}) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)
  return (
    <Card title="Tools" icon={<Wrench size={18} aria-hidden />} description="Expand a tool to review what it can do and choose whether it needs approval.">
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tools match the current source/search filter.</p>
      ) : (
        <Table className="border-separate border-spacing-y-1">
          <TableHeader className="[&_tr]:border-0 [&_th]:border-b [&_th]:border-border/30">
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Policy</TableHead>
              <TableHead className="text-right">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((tool) => {
              const expanded = expandedToolId === tool.id
              const policy = toolPolicyTag(tool)
              const message = decisionMessages[tool.id] ?? null
              return (
                <ToolDetailRow
                  key={`${source.id}:detail:${tool.id}`}
                  tool={tool}
                  policy={policy}
                  expanded={expanded}
                  message={message}
                  onToggle={() => setExpandedToolId(expanded ? null : tool.id)}
                  onUpsertToolOverride={onUpsertToolOverride}
                  sharingPolicy={sharingPolicy}
                  sharingPeers={sharingPeers}
                  sharingDecision={sharingDecisions[tool.id] ?? null}
                  sharingLoading={sharingLoading}
                  sharingError={sharingError}
                  sharingMessage={sharingMessage}
                  sharingPending={sharingPendingKey === `tool:${tool.id}`}
                  onMutateSharing={onMutateSharing}
                />
              )
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

function ToolDetailRow({
  tool,
  policy,
  expanded,
  message,
  onToggle,
  onUpsertToolOverride,
  sharingPolicy,
  sharingPeers,
  sharingDecision,
  sharingLoading,
  sharingError,
  sharingMessage,
  sharingPending,
  onMutateSharing
}: {
  tool: ToolApprovalCardModel
  policy: ToolPolicyTag
  expanded: boolean
  message: string | null
  onToggle: () => void
  onUpsertToolOverride?: ((tool: ToolApprovalCardModel, approvalMode: string) => void) | undefined
  sharingPolicy: ToolExportPolicyModel | null
  sharingPeers: ToolExportScopeModel[]
  sharingDecision: ToolExportDecisionModel | null
  sharingLoading: boolean
  sharingError: string | null
  sharingMessage: string | null
  sharingPending: boolean
  onMutateSharing?: ((mutation: ToolSharingMutation) => void) | undefined
}) {
  return (
    <>
      <TableRow
        onClick={onToggle}
        className={cn(
          'cursor-pointer border-0 bg-muted/[0.08] transition-colors hover:bg-muted/30 [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md',
          expanded && 'bg-muted/25'
        )}
      >
        <TableCell>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`Toggle details for ${tool.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
            className="flex w-full items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
          >
            <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded ? '' : '-rotate-90')} aria-hidden />
            <span className="flex min-w-0 flex-col" style={{ maxWidth: 360 }}>
              <strong className="truncate font-mono text-[12.5px] font-medium">{tool.name}</strong>
              {!expanded ? <small className={cn('truncate text-xs', tool.disabledReason ? 'text-destructive' : 'text-muted-foreground')}>{tool.disabledReason ? toolDisabledCopy(tool) : tool.description}</small> : null}
            </span>
          </button>
        </TableCell>
        <TableCell><ToneBadge tone={riskTone(tool.riskClass)}>{tool.riskClass}</ToneBadge></TableCell>
        <TableCell><ToneBadge tone={policy.tone}>{policy.label}</ToneBadge></TableCell>
        <TableCell className="text-right"><ToneBadge tone={stateTone(tool.state)}>{prototypeStateLabel(tool)}</ToneBadge></TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="border-0 hover:bg-transparent">
          <TableCell colSpan={4} className="rounded-md bg-muted/20" style={{ whiteSpace: 'normal' }}>
            <div className="flex flex-col gap-3 py-1.5">
              <p className="text-sm text-muted-foreground">{tool.description || 'No description provided.'}</p>
              {tool.disabledReason ? (
                <p className="text-sm text-destructive" role="status">
                  {toolDisabledCopy(tool)}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {tool.mutating ? 'Changes data' : 'Reads data'}
                {tool.mutating ? ' · mutating' : ''}
                {tool.dataEgress ? ' · data egress' : ''}
                {tool.providerLabel ? ` · ${tool.providerLabel}` : ''}
              </p>
              <div className="flex flex-col gap-1 bg-background/25 px-3">
                <ToolSharingRowControl
                  tool={tool}
                  policy={sharingPolicy}
                  peers={sharingPeers}
                  decision={sharingDecision}
                  loading={sharingLoading}
                  error={sharingError}
                  message={sharingMessage}
                  pending={sharingPending}
                  {...(onMutateSharing ? { onMutate: onMutateSharing } : {})}
                />
                <div className="flex flex-col gap-2.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-0.5">
                    <strong className="text-xs">Execution approval</strong>
                    <span className="text-xs text-muted-foreground">Override approval for this tool.</span>
                  </div>
                  <ToggleGroup
                    value={[TOOL_POLICY_ACTIONS.find((action) => action.trustTier === (tool.configuredTrustTier ?? null))?.mode ?? 'inherit']}
                    onValueChange={(values) => {
                      const approvalMode = values[0]
                      if (approvalMode) onUpsertToolOverride?.(tool, approvalMode)
                    }}
                    variant="default"
                    size="sm"
                    spacing={1}
                    disabled={!onUpsertToolOverride}
                    aria-label={`Policy override for ${tool.name}`}
                    className="bg-background/60 p-1 shadow-inner"
                  >
                    {TOOL_POLICY_ACTIONS.map((action) => (
                      <ToggleGroupItem
                        key={action.mode}
                        value={action.mode}
                        className={cn(
                          'bg-muted/60 text-foreground/75 shadow-sm transition-colors hover:bg-muted hover:text-foreground',
                          action.trustTier === (tool.configuredTrustTier ?? null) && 'font-medium shadow-none'
                        )}
                        style={action.trustTier === (tool.configuredTrustTier ?? null) ? SELECTED_SEGMENT_STYLE : undefined}
                      >
                        {action.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
              {message ? <p className="text-xs" aria-live="polite">{message}</p> : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function prototypeStateLabel(tool: ToolApprovalCardModel): string {
  if (tool.blockReasonCode === 'permission_denied' || tool.blockReasonCode === 'recipient_missing_tool_permissions') return 'not callable'
  if (/unavailable|unsupported/i.test(tool.state)) return 'needs repair'
  if (tool.state === 'provider-selector-required') return 'choose source'
  if (tool.state === 'dry-run-only') return 'preview only'
  if (tool.state === 'replay-rejected') return 'needs review'
  return tool.state.replace(/_/g, ' ')
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
  if (props.tools.length === 0) return <p className="text-sm text-muted-foreground">No tools match the current source/search filter.</p>
  return (
    <div className="flex flex-col gap-2" aria-label={`${props.source.name} tools`}>
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
    <details className="rounded-xl border border-border bg-card p-3" data-state={tool.state}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          {toolStateIcon(tool)}
          <span className="flex flex-col"><strong className="font-medium">{tool.name}</strong><small className="text-xs text-muted-foreground">{tool.description}</small></span>
        </span>
        <span className="flex items-center gap-2">
          <ToneBadge tone={riskTone(tool.riskClass)}>{tool.riskClass}</ToneBadge>
          <Badge variant="outline">{tool.approvalRequired ? 'approval required' : 'ready'}</Badge>
          <ChevronDown size={15} aria-hidden />
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <MetaGrid columns={2} items={[
          { label: 'Current access', value: effectivePolicyCopy(tool, source) },
          { label: 'Device or source', value: selectedProvider?.label ?? tool.providerLabel },
          { label: 'Permissions', value: tool.requiredPermissions.join(', ') || 'No explicit permissions reported' },
          { label: 'What it can do', value: capabilityCopy(tool) },
          { label: 'Reference ID', value: tool.correlationId ?? 'pending', mono: true },
          { label: 'Scheduling', value: tool.requiresAdminAction ? 'Needs administrator confirmation' : 'Review before scheduling' }
        ]} />
        {tool.providers.length > 1 || tool.providerSelectorRequired ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>Choose source</span>
            <select
              className="h-9 rounded-lg border border-border bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={selectedProviderId ?? ''}
              onChange={(event) => onSelectProvider(event.currentTarget.value)}
            >
              <option value="">Select source</option>
              {tool.providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.selectable}>{provider.label}</option>)}
            </select>
            <small className="text-xs text-muted-foreground">{selectorMissing ? 'Choose a source before approving.' : 'Source selected.'}</small>
          </label>
        ) : null}
        <details className="rounded-lg border border-border p-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm"><FileDiff size={15} aria-hidden /> Advanced details</summary>
          <div className="mt-2.5 flex flex-col gap-2.5">
            <RedactedPreview label="Inputs" value={tool.argsPreview} fallback="No input preview available." />
            <RedactedPreview label="Preview" value={tool.dryRunPreview} fallback="No preview available." />
            <div className="flex flex-col gap-1.5" aria-label="Input summary">
              <strong className="text-sm font-medium">Input summary</strong>
              {fields.length > 0 ? fields.map((field) => (
                <label key={field.name} className="flex flex-col gap-0.5 text-xs">
                  <span>{field.name}{field.required ? ' *' : ''}</span>
                  <input readOnly value={field.example} aria-label={`${field.name} ${field.type} parameter`} className="h-8 rounded-md border border-border bg-transparent px-2 font-mono text-xs" />
                  <small className="text-muted-foreground">{field.type}</small>
                </label>
              )) : <p className="text-sm text-muted-foreground">No writable parameters were reported for this tool.</p>}
            </div>
            {tool.result ? <ToolResultCard result={tool.result} /> : null}
          </div>
        </details>
        <div className="flex items-center gap-2 text-sm" role={blocked ? 'alert' : 'status'}>{toolStateIcon(tool)}<span>{stateCopy(tool)}</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" icon={<FlaskConical size={15} aria-hidden />} disabled={dryRunDisabled} onClick={() => onApprove('once', true)}>Dry run</Button>
          <Button variant="outline" icon={<X size={15} aria-hidden />} disabled={blocked || selectorMissing} onClick={onDeny}>Deny</Button>
          {executeSafeEnabled ? <Button variant="primary" icon={<Play size={15} aria-hidden />} ariaLabel="Run safe local tool" onClick={onExecuteSafe}>Run safe local</Button> : null}
          {tool.approvalRequired ? tool.approvalScopes.map((scope) => (
            <Button key={scope} variant="primary" icon={<Check size={15} aria-hidden />} disabled={approveDisabled} onClick={() => onApprove(scope)}>{scopeLabel(scope)}</Button>
          )) : null}
        </div>
        {decisionMessage ? <p className="text-sm text-muted-foreground" role="status">{decisionMessage}</p> : null}
      </div>
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Source trust" icon={<SlidersHorizontal size={18} aria-hidden />} description="Trust shows the saved source policy. Changes use the approved admin flow.">
        <MetaGrid columns={1} items={[
          { label: 'Effective trust', value: source.effectiveTrust },
          { label: 'Future child tools', value: source.type === 'core' ? 'trusted core catalog' : 'approval required by default unless backend policy explicitly enables inheritance' },
          { label: 'Global mode', value: policyMode },
          { label: 'Blocked child overrides', value: source.blockedToolCount }
        ]} />
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {['trusted', 'untrusted', 'blocked'].map((trust) => (
            <Button key={trust} variant="outline" onClick={() => onUpsertSourcePolicy?.(source, trust)} disabled={!onUpsertSourcePolicy}>{trust}</Button>
          ))}
          <Button variant="outline" onClick={() => onUpsertSourcePolicy?.(source, 'trusted', true)} disabled={!onUpsertSourcePolicy}>Trust future child tools</Button>
        </div>
      </Card>
      <Card title="Per-tool overrides" icon={<Wrench size={18} aria-hidden />} description="Blocked overrides win over source trust; revoking the durable grant restores source inheritance.">
        <div className="flex flex-col gap-2">
          {source.tools.map((tool) => (
            <div key={tool.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-sm">
              <strong className="font-medium">{tool.name}</strong>
              <span className="text-muted-foreground">{effectivePolicyCopy(tool, source)}</span>
              <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'approve_all_for_peer')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Trust override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Trust tool</Button>
              <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'ask_each_time')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Approval override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Require approval</Button>
              <Button variant="ghost" onClick={() => onUpsertToolOverride?.(tool, 'deny_all')} disabled={!onUpsertToolOverride} disabledReason={!onUpsertToolOverride ? 'Block override requires Tooling.UpsertToolPolicyOverride.' : undefined}>Block tool</Button>
            </div>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">To remove a durable child override and inherit from the source again, revoke its grant in the Grants tab.</p>
      </Card>
    </div>
  )
}

function GrantsPanel({ grants, onRevokeGrant }: { grants: ReturnType<typeof buildGrantRows>; onRevokeGrant?: ((grant: ReturnType<typeof buildGrantRows>[number]) => void) | undefined }) {
  return (
    <Card title="Durable grants" icon={<KeyRound size={18} aria-hidden />} description="Grant rows show saved approvals when available and current tool-list details while offline.">
      {grants.length === 0 ? <p className="text-sm text-muted-foreground">No active, expired, revoked, stale, or needs-review grants reported for this source.</p> : null}
      <div className="flex flex-col gap-2">
        {grants.map((grant) => (
          <div key={grant.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-sm">
            <strong className="font-medium">{grant.target}</strong>
            <span className="text-muted-foreground">{grant.scope} · {grant.principal} · {grant.expires}</span>
            <ToneBadge tone={stateTone(grant.status)}>{grant.status}</ToneBadge>
            <Button variant="ghost" onClick={() => onRevokeGrant?.(grant)} disabled={!onRevokeGrant} disabledReason={!onRevokeGrant ? 'Grant revocation requires Tooling.RevokeApprovalGrant.' : undefined}>Revoke</Button>
          </div>
        ))}
      </div>
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
      {props.approvals.length === 0 && props.backendApprovals.length === 0 ? <p className="text-sm text-muted-foreground">No pending runtime approvals are present in the current Tooling catalog snapshot.</p> : null}
      {props.backendApprovals.map((approval) => (
        <div key={approval.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-sm">
          <strong className="font-medium">{approval.displayName}</strong>
          <span className="text-muted-foreground">{approval.status} · thread {approval.threadId} · approval {approval.approvalRequestId ?? 'pending id'}</span>
          <Badge variant="outline">Approve in Assistant</Badge>
          <code className="font-mono text-xs text-muted-foreground">{approval.correlationId ?? 'correlation pending'}</code>
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
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading scheduler jobs through Aurora...</p> : null}
      {!loading && jobs.length === 0 && !error ? <p className="text-sm text-muted-foreground">No scheduler jobs were returned by Scheduler.ListJobs.</p> : null}
      <div className="flex flex-col gap-2">
        {jobs.map((job) => (
          <div key={job.job_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-sm">
            <strong className="font-medium">{job.name}</strong>
            <span className="text-muted-foreground"><code className="font-mono text-xs">{job.schedule}</code> · {job.action} · next {job.next_run ?? 'not scheduled'}</span>
            <StateIndicator state={schedulerAvailability(job)} />
            <span className="text-muted-foreground">{job.blocked_reason ? `grant warning: ${job.blocked_reason}` : 'grant dependency review required before fire'}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <a className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline" href="/admin/scheduler">Open scheduler</a>
        <Badge variant="outline">Scheduler.ListJobs</Badge>
      </div>
    </Card>
  )
}

function ActivityPanel({ rows }: { rows: ReturnType<typeof buildAuditRows> }) {
  const columns: Array<DataColumn<ReturnType<typeof buildAuditRows>[number]>> = [
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <div className="flex flex-col">
          <strong className="font-medium">{row.action}</strong>
          <small className="text-xs text-muted-foreground">{row.actor}</small>
        </div>
      )
    },
    { key: 'target', header: 'Target', render: (row) => row.target },
    { key: 'status', header: 'Status', render: (row) => row.status },
    { key: 'correlation', header: 'Correlation', render: (row) => <code className="font-mono text-xs">{row.correlationId}</code> },
    { key: 'policy', header: 'Policy', render: (row) => <code className="font-mono text-xs">{row.policyDecisionId}</code> }
  ]
  return (
    <Card title="Activity and audit" icon={<History size={18} aria-hidden />} description="Recent policy, grant, tool execution, catalog, onboarding, and scheduler events with redacted payload boundaries.">
      <DataTable columns={columns} rows={rows} getRowKey={(row) => row.id} />
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
    <Card title="Onboarding wizard UI" icon={<ServerCog size={18} aria-hidden />} description="Connect MCP servers and plugin sources without logging secrets.">
      <div className="flex items-center gap-2">
        <Button variant={wizard === 'mcp' ? 'primary' : 'outline'} icon={<Plug size={15} aria-hidden />} onClick={() => onWizard('mcp')}>Add MCP server</Button>
        <Button variant={wizard === 'plugin' ? 'primary' : 'outline'} icon={<Package size={15} aria-hidden />} onClick={() => onWizard('plugin')}>Add plugin source</Button>
      </div>
      <div className="mt-3 flex flex-col gap-3" role="dialog" aria-modal="false" aria-labelledby="tool-wizard-title">
        <header className="flex flex-col gap-1">
          <h3 id="tool-wizard-title" className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{surfaceLabel}; local command launch is {canLaunchLocalCommands ? 'available for desktop-local source tests' : 'not available on this surface'}.</p>
        </header>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Wizard steps">
          {['Details', 'Authenticate', 'Discover', 'Trust'].map((label, index) => (
            <Button key={label} variant={wizardStep === index + 1 ? 'primary' : 'outline'} ariaPressed={wizardStep === index + 1} onClick={() => onStep(index + 1)}>{index + 1}. {label}</Button>
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

  const inputClassName = 'h-9 rounded-lg border border-border bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
  if (step === 1) return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span>{wizard === 'mcp' ? 'Display name' : 'Package name'}</span>
        <input
          className={inputClassName}
          value={wizard === 'mcp' ? mcpDraft.name : pluginDraft.packageName}
          onChange={(event) => wizard === 'mcp' ? onMcpDraft({ ...mcpDraft, name: event.currentTarget.value }) : onPluginDraft({ ...pluginDraft, packageName: event.currentTarget.value })}
          placeholder={wizard === 'mcp' ? 'Filesystem MCP' : '@aurora/plugin-package'}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{wizard === 'mcp' ? 'Server URL or command profile' : 'Package source or install path'}</span>
        <input className={inputClassName} value={endpointValue} onChange={(event) => updateEndpoint(event.currentTarget.value)} placeholder={canLaunchLocalCommands ? 'stdio command or https://server' : 'https://server'} />
      </label>
      <p className="text-sm text-muted-foreground">Aurora checks the connection before saving.</p>
    </div>
  )
  if (step === 2) return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm"><span>Auth type</span><select className={inputClassName} defaultValue="none"><option value="none">No auth</option><option value="bearer">Bearer token</option><option value="oauth">OAuth</option></select></label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Secret value</span>
        <input
          className={inputClassName}
          type="password"
          placeholder="Stored only for active submission"
          onChange={(event) => updateSecret(event.currentTarget.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">Secrets are obscured and never echoed in audit previews.</p>
    </div>
  )
  if (step === 3) return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Check the connection before saving. Secrets are never shown again.</p>
      <Button variant="outline" onClick={() => { void onTestSource?.(wizard, draft) }} disabled={!onTestSource} disabledReason={!onTestSource ? 'Connection check is unavailable right now.' : undefined}>Test connection</Button>
      {resultMessage ? <p className="text-sm text-muted-foreground" role="status">{toolingSafeMessage(resultMessage)}</p> : null}
    </div>
  )
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">New tools require approval unless you choose to trust this source.</p>
      <Button variant="primary" onClick={() => { void onCreateSource?.(wizard, draft) }} disabled={!onCreateSource} disabledReason={!onCreateSource ? 'Saving is unavailable right now.' : undefined}>Create source</Button>
      {resultMessage ? <p className="text-sm text-muted-foreground" role="status">{toolingSafeMessage(resultMessage)}</p> : null}
    </div>
  )
}

function onboardingResultMessage(kind: 'mcp' | 'plugin', action: 'test' | 'create', result: ToolOnboardingValidationResult | undefined): string {
  const label = kind === 'mcp' ? 'MCP source' : 'Plugin source'
  if (!result) return `${label} is not available right now.`
  if (result.status === 'unsupported') return `${label} is not available in this Aurora version yet.`
  if (result.ok) return action === 'test'
    ? `${label} connection looks ready.`
    : `${label} saved. Review its tools before use.`
  return `${label} could not be saved. Check the details and try again.`
}

function LoadingState({
  title = 'Loading source catalog',
  detail = 'Loading catalog, source details, policy, grants, approvals, sharing state, and peer metadata.'
}: {
  title?: string
  detail?: string
} = {}) {
  return <Card title={title} icon={<RefreshCw size={18} aria-hidden />}><p className="text-sm text-muted-foreground" role="status">{detail}</p></Card>
}

function EmptyCatalog({ onAddMcp }: { onAddMcp: () => void }) {
  return <Card title="No sources" icon={<Boxes size={18} aria-hidden />}><p className="text-sm text-muted-foreground">No core, MCP, plugin, mesh, unknown, or blocked sources were returned by the SDK catalog.</p><Button variant="primary" onClick={onAddMcp}>Connect your first MCP server</Button></Card>
}

function TrustPill({ trust }: { trust: ToolingTrustState }) {
  return <ToneBadge tone={trustTone(trust)}>{trustLabel(trust)}</ToneBadge>
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
    <section className="flex flex-col gap-2 rounded-lg border border-border p-2.5" aria-label="Tool result">
      <h3 className="text-sm font-semibold">Result</h3>
      <MetaGrid items={[
        { label: 'Status', value: resultStatusCopy(result.status) },
        { label: 'Device', value: result.providerPeerId ? 'Selected Aurora device' : 'This device' },
        { label: 'Reference ID', value: result.correlationId ?? 'pending', mono: true },
        { label: 'Activity record', value: result.auditReceipt ? 'Recorded' : 'Pending' },
        { label: 'Duration', value: result.durationMs === null ? 'not reported' : `${result.durationMs}ms` },
        { label: 'Retry', value: result.retryEligible ? 'Available' : 'Not available' }
      ]} />
      <RedactedPreview label="Output" value={result.outputPreview} fallback={result.error ? safeErrorCopy({ code: 'connection_lost' }).title : 'No output preview available.'} />
    </section>
  )
}

function RedactedPreview({ label, value, fallback }: { label: string; value: object | null; fallback: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-muted-foreground">{label}</h3>
      <code className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">{value ? JSON.stringify(value, null, 2) : fallback}</code>
    </div>
  )
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
  if (tool.state === 'provider-selector-required') return 'Choose a source before approving.'
  if (tool.state === 'dry-run-only') return 'Preview only until approval changes.'
  if (tool.state === 'denied') return 'Approval was denied.'
  if (tool.state === 'expired') return 'Approval expired; request a fresh approval.'
  if (tool.state === 'replay-rejected') return 'This request needs a fresh approval.'
  if (tool.state === 'unavailable') return toolDisabledCopy(tool)
  if (tool.state === 'executed') return 'Tool completed and an activity record is available.'
  if (tool.requiresAdminAction) return 'Administrator confirmation is required before approval or use.'
  if (tool.approvalRequired) return 'Approval required before execution.'
  return 'No approval required by current policy.'
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
  if (isBlockedTool(tool)) return 'Blocked until this source is reviewed.'
  if (source.effectiveTrust === 'trusted' && !tool.approvalRequired) return 'Trusted from reviewed source.'
  if (tool.approvalRequired) return 'Approval required for this exact tool scope.'
  return `${trustLabel(source.effectiveTrust)} from ${source.name}.`
}

function toolDisabledCopy(tool: ToolApprovalCardModel): string {
  if (tool.blockReasonCode === 'permission_denied' || tool.blockReasonCode === 'recipient_missing_tool_permissions') {
    return 'Permission is needed to use this tool.'
  }
  if (/unsupported/i.test(tool.state) || /unsupported/i.test(tool.disabledReason ?? '')) {
    return 'This Aurora version cannot use that feature yet.'
  }
  return 'This tool needs attention before Aurora can use it.'
}

function resultStatusCopy(status: string): string {
  if (/success|ok|completed/i.test(status)) return 'Completed'
  if (/pending|running/i.test(status)) return 'In progress'
  if (/denied|blocked|failed|error/i.test(status)) return 'Needs attention'
  return 'Received'
}

function trustLabel(trust: ToolingTrustState): string {
  if (trust === 'approval-required') return 'Approval required'
  if (trust === 'quarantined') return 'Needs review'
  return trust
}

function policyModeLabel(mode: string): string {
  if (mode === 'dry_run_only') return 'Preview only'
  if (mode === 'deny_all') return 'All blocked'
  if (mode === 'unrestricted_except_blocked') return 'Wide access'
  return 'Enforced'
}

function policyConnectionLabel(kind: string): string {
  if (/native-mobile/i.test(kind)) return 'Mobile app'
  if (/tauri-local/i.test(kind)) return 'This computer'
  if (/http/i.test(kind)) return 'Aurora address'
  return 'Aurora connection'
}

function toolingSafeMessage(message: unknown): string {
  if (typeof message !== 'string') return safeErrorCopy(message).title
  if (/permission|denied/i.test(message)) return safeErrorCopy({ code: 'permission_denied' }).title
  if (/unsupported/i.test(message)) return safeErrorCopy({ code: 'unsupported' }).title
  if (/connect|offline|transport|route|runtime|gateway|network/i.test(message)) return safeErrorCopy({ code: 'connection_lost' }).title
  return safeErrorCopy({ code: 'connection_lost' }).title
}
function capabilityCopy(tool: ToolApprovalCardModel): string {
  const flags = [tool.mutating ? 'write/execute' : 'read', tool.dataEgress ? 'network/data egress' : 'local data', tool.requiresAdminAction ? 'admin' : null].filter(Boolean)
  return flags.join(' · ')
}
function StateIndicator({ state }: { state: AvailabilityState }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full',
        state === 'available-local' || state === 'available-remote' ? 'bg-success' : state === 'degraded' || state === 'pending' || state === 'stale' ? 'bg-warning' : 'bg-destructive'
      )}
      data-state={state}
      aria-hidden="true"
    />
  )
}
