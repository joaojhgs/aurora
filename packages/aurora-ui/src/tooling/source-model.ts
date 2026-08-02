import { mergeToolManagementInventory, type ConfigFieldMetadata, type NormalizedSchedulerJob, type ToolApprovalCardModel, type ToolSourceDetailModel, type ToolSourceSummaryModel, type ToolingPageViewModel } from '@aurora/client'

export type ToolingSourceType = 'core' | 'mcp' | 'plugin' | 'mesh' | 'unknown' | 'blocked'
export type ToolingTrustState = 'trusted' | 'approval-required' | 'blocked' | 'quarantined' | 'mixed'
export type ToolingPolicyMode = 'enforce' | 'deny_all' | 'dry_run_only' | 'unrestricted_except_blocked'

export interface ToolingSourceModel {
  id: string
  shareGroupId?: string | null
  shareGroupLabel?: string | null
  exportable?: boolean
  type: Exclude<ToolingSourceType, 'blocked'>
  name: string
  providerLabel: string
  providerKind: string
  transport: string | null
  peerId: string | null
  serviceInstanceId: string | null
  trustTier: string | null
  configuredTrustTier: string | null
  effectiveTrust: ToolingTrustState
  toolCount: number
  blockedToolCount: number
  pendingApprovalCount: number
  safeToolCount: number
  mutatingToolCount: number
  externalToolCount: number
  adminToolCount: number
  lastSeenLabel: string
  catalogState: string
  catalogEvidence: string
  routePath: string[]
  tools: ToolApprovalCardModel[]
}

export interface ToolingPolicySummaryModel {
  mode: ToolingPolicyMode
  defaultBehavior: string
  activeGrantCount: number
  pendingApprovalCount: number
  blockedCount: number
  sourceCount: number
  bypassEnabled: boolean
  dryRunOnly: boolean
  denyAll: boolean
  lastChanged: string
  actor: string
  evidence: string
}

export interface ToolingGrantRow {
  id: string
  target: string
  source: string
  scope: string
  status: 'active' | 'expired' | 'revoked' | 'stale' | 'needs-review'
  principal: string
  expires: string
  evidence: string
}

export interface ToolingAuditRow {
  id: string
  action: string
  actor: string
  target: string
  timestamp: string
  status: string
  correlationId: string
  policyDecisionId: string
}

export interface BuiltinPluginModel {
  id: string
  label: string
  active: boolean
  configured: boolean
  activateKeyPath: string
  /** Credential/config fields for this plugin (everything except the activate flag). */
  fields: ConfigFieldMetadata[]
  evidence: string
}

const BUILTIN_PLUGIN_PREFIX = 'services.tooling.plugins.'

const BUILTIN_PLUGIN_LABELS: Record<string, string> = {
  brave_search: 'Brave Search',
  gcalendar: 'Google Calendar',
  gmail: 'Gmail',
  github: 'GitHub',
  jira: 'Jira',
  openrecall: 'OpenRecall',
  slack: 'Slack',
}

/** Built-in plugins derived from config schema metadata (`services.tooling.plugins.*`). */
export function buildBuiltinPlugins(fields: ConfigFieldMetadata[]): BuiltinPluginModel[] {
  const byPlugin = new Map<string, ConfigFieldMetadata[]>()
  for (const field of fields) {
    if (!field.key_path.startsWith(BUILTIN_PLUGIN_PREFIX)) continue
    const rest = field.key_path.slice(BUILTIN_PLUGIN_PREFIX.length)
    const [pluginId, ...leaf] = rest.split('.')
    if (!pluginId || leaf.length === 0) continue
    byPlugin.set(pluginId, [...(byPlugin.get(pluginId) ?? []), field])
  }
  const plugins: BuiltinPluginModel[] = []
  for (const [pluginId, pluginFields] of byPlugin) {
    const activateField = pluginFields.find((field) => field.key_path === `${BUILTIN_PLUGIN_PREFIX}${pluginId}.activate`)
    if (!activateField) continue
    const credentialFields = pluginFields.filter((field) => field !== activateField)
    plugins.push({
      id: pluginId,
      label: BUILTIN_PLUGIN_LABELS[pluginId] ?? humanizePluginId(pluginId),
      active: activateField.current_value === true,
      configured: credentialFields.length === 0 || credentialFields.every((field) => hasConfiguredValue(field)),
      activateKeyPath: activateField.key_path,
      fields: credentialFields,
      evidence: 'Config.GetSchemaMetadata',
    })
  }
  return plugins.sort((left, right) => left.label.localeCompare(right.label))
}

function hasConfiguredValue(field: ConfigFieldMetadata): boolean {
  const value = field.current_value
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function humanizePluginId(pluginId: string): string {
  return pluginId.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

export function buildToolingSourcesFromBackend(
  summaries: ToolSourceSummaryModel[],
  details: Record<string, ToolSourceDetailModel | null>,
  fallbackTools: ToolApprovalCardModel[]
): ToolingSourceModel[] {
  if (summaries.length === 0) return []
  return summaries.map((summary) => {
    const detail = details[summary.id] ?? null
    const sourceTools = detail
      ? mergeToolManagementInventory(detail.tools, detail.blockedTools, detail.retainedTools)
      : fallbackTools.filter((tool) => sourceMatchesSummary(tool, summary))
    const blockedCount = detail
      ? Math.max(detail.blockedTools.length, summary.blockedToolCount)
      : summary.blockedToolCount
    return sourceFromSummary(summary, sourceTools, blockedCount)
  }).sort((left, right) => sourceSortWeight(left.type) - sourceSortWeight(right.type) || left.name.localeCompare(right.name))
}

export function buildToolingPolicySummaryFromBackend(policy: ToolingPageViewModel['policy']): ToolingPolicySummaryModel {
  return {
    mode: backendPolicyMode(policy),
    defaultBehavior: policy.defaultApprovalMode,
    activeGrantCount: policy.activeGrantCount,
    pendingApprovalCount: policy.pendingApprovalCount,
    blockedCount: policy.blockedToolCount + policy.blockedSourceCount,
    sourceCount: policy.sourceCount,
    bypassEnabled: policy.unrestrictedExceptBlocked,
    dryRunOnly: policy.dryRunOnly,
    denyAll: policy.denyAll,
    lastChanged: policy.lastPolicyChangeAt ?? 'No policy change reported',
    actor: policy.lastPolicyChangeActor ?? 'Tooling.GetPolicySummary',
    evidence: 'Tooling.GetPolicySummary'
  }
}

function backendPolicyMode(policy: ToolingPageViewModel['policy']): ToolingPolicyMode {
  if (policy.denyAll) return 'deny_all'
  if (policy.dryRunOnly) return 'dry_run_only'
  if (policy.unrestrictedExceptBlocked) return 'unrestricted_except_blocked'
  const mode = (policy as { mode?: unknown }).mode
  if (mode === 'enforce' || mode === 'deny_all' || mode === 'dry_run_only' || mode === 'unrestricted_except_blocked') return mode
  return 'enforce'
}

function sourceFromSummary(summary: ToolSourceSummaryModel, tools: ToolApprovalCardModel[], blockedCount: number): ToolingSourceModel {
  const type = sourceTypeFromBackendKind(summary.kind)
  const pendingApprovalCount = summary.approvalRequiredCount || tools.filter(isPendingApprovalTool).length
  return {
    id: summary.id,
    shareGroupId: tools[0]?.shareGroupId ?? null,
    shareGroupLabel: tools[0]?.shareGroupLabel ?? null,
    exportable: tools.length > 0 && tools.every((tool) => tool.exportable === true),
    type,
    name: summary.label,
    providerLabel: summary.label,
    providerKind: summary.providerKind ?? summary.kind,
    transport: summary.transport,
    peerId: summary.providerPeerId,
    serviceInstanceId: summary.providerServiceInstanceId,
    trustTier: summary.trustTier,
    configuredTrustTier: summary.configuredTrustTier ?? null,
    effectiveTrust: effectiveTrustFromSummary(summary),
    toolCount: Math.max(summary.toolCount, tools.length),
    blockedToolCount: blockedCount,
    pendingApprovalCount,
    safeToolCount: tools.filter((tool) => !tool.approvalRequired && !tool.mutating && !tool.dataEgress).length,
    mutatingToolCount: tools.filter((tool) => tool.mutating).length,
    externalToolCount: tools.filter((tool) => tool.dataEgress || tool.riskClass === 'external').length,
    adminToolCount: tools.filter((tool) => tool.requiresAdminAction || `${tool.riskClass}`.includes('admin')).length,
    lastSeenLabel: summary.lastAnnouncementAt ?? summary.generatedAt ?? 'Tooling.ListToolSources',
    catalogState: summary.status,
    catalogEvidence: summary.cacheStatus ?? summary.catalogCacheState ?? 'Tooling.ListToolSources',
    routePath: ['Tooling.ListToolSources', 'Tooling.GetToolSourceDetail'],
    tools
  }
}

function effectiveTrustFromSummary(summary: ToolSourceSummaryModel): ToolingTrustState {
  switch (summary.status) {
    case 'blocked':
      return 'blocked'
    case 'needs-review':
      return 'approval-required'
    case 'stale':
    case 'removed':
    case 'unshared':
      return 'mixed'
  }
  switch (summary.trustTier) {
    case 'trusted':
      return 'trusted'
    case 'blocked':
      return 'blocked'
    case 'unknown':
      return 'quarantined'
    case 'untrusted':
    default:
      return 'approval-required'
  }
}

function sourceTypeFromBackendKind(kind: string): Exclude<ToolingSourceType, 'blocked'> {
  if (kind === 'core') return 'core'
  if (kind === 'mcp') return 'mcp'
  if (kind === 'plugin') return 'plugin'
  if (kind === 'mesh_peer' || kind === 'mesh') return 'mesh'
  return 'unknown'
}

function sourceMatchesSummary(tool: ToolApprovalCardModel, summary: ToolSourceSummaryModel): boolean {
  if (tool.sourceId && tool.sourceId === summary.id) return true
  const summaryType = sourceTypeFromBackendKind(summary.kind)
  if (sourceTypeForTool(tool) !== summaryType) return false
  if (summaryType === 'mesh') {
    if (summary.providerPeerId && tool.providerPeerId !== summary.providerPeerId) return false
    if (summary.providerServiceInstanceId && tool.serviceInstanceId !== summary.providerServiceInstanceId) return false
    return true
  }
  if (summary.providerPeerId && summary.providerPeerId !== 'local' && tool.providerPeerId !== summary.providerPeerId) return false
  if (summary.providerServiceInstanceId && tool.serviceInstanceId && summary.providerServiceInstanceId !== tool.serviceInstanceId) return false
  if (summaryType === 'mcp' || summaryType === 'plugin' || summaryType === 'unknown') {
    return Boolean(tool.sourceId || tool.serviceInstanceId === summary.providerServiceInstanceId || tool.providerLabel === summary.label)
  }
  return summaryType === 'core' && (!tool.providerPeerId || tool.providerPeerId === 'local' || tool.providerPeerId === 'local-peer')
}

export function buildToolingSources(tools: ToolApprovalCardModel[]): ToolingSourceModel[] {
  const groups = new Map<string, ToolApprovalCardModel[]>()
  for (const tool of tools) {
    const key = sourceIdForTool(tool)
    groups.set(key, [...(groups.get(key) ?? []), tool])
  }
  return [...groups.entries()]
    .map(([id, groupTools]) => sourceFromTools(id, groupTools))
    .sort((left, right) => sourceSortWeight(left.type) - sourceSortWeight(right.type) || left.name.localeCompare(right.name))
}

export function buildToolingPolicySummary(tools: ToolApprovalCardModel[], sources: ToolingSourceModel[]): ToolingPolicySummaryModel {
  const pendingApprovalCount = tools.filter(isPendingApprovalTool).length
  const blockedCount = tools.filter(isBlockedTool).length
  const dryRunOnly = tools.some((tool) => tool.state === 'dry-run-only' || tool.dryRunRequired)
  const denyAll = tools.length > 0 && blockedCount === tools.length
  let mode: ToolingPolicyMode = 'enforce'
  if (denyAll) mode = 'deny_all'
  else if (dryRunOnly) mode = 'dry_run_only'
  return {
    mode,
    defaultBehavior: dryRunOnly ? 'Preview outside changes until Aurora confirms approval.' : 'Ask for approval when the tool policy requires it.',
    activeGrantCount: tools.filter((tool) => tool.state === 'approved' || tool.state === 'executed').length,
    pendingApprovalCount,
    blockedCount,
    sourceCount: sources.length,
    bypassEnabled: false,
    dryRunOnly,
    denyAll,
    lastChanged: 'Tooling.GetPolicySummary unavailable',
    actor: 'Aurora',
    evidence: 'Derived from the current Aurora tool list because management data was unavailable.'
  }
}

export function buildGrantRows(sources: ToolingSourceModel[]): ToolingGrantRow[] {
  return sources.flatMap((source) => source.tools
    .filter((tool) => tool.state === 'approved' || tool.state === 'executed' || tool.approvalScopes.length > 0)
    .slice(0, 3)
    .map((tool) => ({
      id: tool.approvalRequestId ?? tool.policyDecisionId ?? `${source.id}:${tool.id}:grant`,
      target: tool.name,
      source: source.id,
      scope: tool.requestedApprovalScope ?? tool.approvalScopes[0] ?? 'catalog-review',
      status: grantStatusForTool(tool),
      principal: tool.providerPeerId ?? 'local-principal',
      expires: formatExpiry(tool.expiresAt),
      evidence: tool.policyDecisionId ?? tool.auditDestination ?? 'policy details pending'
    })))
}

export function buildAuditRows(tools: ToolApprovalCardModel[], schedulerJobs: NormalizedSchedulerJob[]): ToolingAuditRow[] {
  const toolRows = tools.slice(0, 8).map((tool) => ({
    id: tool.correlationId ?? tool.id,
    action: auditActionForTool(tool),
    actor: tool.providerPeerId ?? 'local-peer',
    target: tool.name,
    timestamp: 'catalog snapshot',
    status: tool.state,
    correlationId: tool.correlationId ?? 'pending',
    policyDecisionId: tool.policyDecisionId ?? 'not reported'
  }))
  const schedulerRows = schedulerJobs.slice(0, 4).map((job) => ({
    id: `scheduler:${job.job_id}`,
    action: 'Scheduled tool action reviewed',
    actor: job.owner_peer_id ?? 'scheduler',
    target: job.name,
    timestamp: job.next_run ?? 'not scheduled',
    status: job.blocked_reason ? 'blocked' : job.status ?? 'active',
    correlationId: job.job_id,
    policyDecisionId: job.blocked_reason ?? 'scheduler grant dependency'
  }))
  return [...toolRows, ...schedulerRows]
}

export function toolsForSourceSearch(source: ToolingSourceModel, query: string): ToolApprovalCardModel[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return source.tools
  return source.tools.filter((tool) => [
    tool.name,
    tool.description,
    tool.riskClass,
    tool.state,
    tool.requiredPermissions.join(' '),
    tool.routePath.join(' '),
  ].join(' ').toLowerCase().includes(normalized))
}

export function isBlockedTool(tool: ToolApprovalCardModel): boolean {
  return ['denied', 'expired', 'replay-rejected', 'unavailable', 'failed'].includes(tool.state)
}

export function isPendingApprovalTool(tool: ToolApprovalCardModel): boolean {
  return tool.approvalRequired && !isBlockedTool(tool) && tool.state !== 'approved' && tool.state !== 'executed'
}

export function sourceSectionLabel(type: ToolingSourceType): string {
  switch (type) {
    case 'core': return 'Core tools'
    case 'mcp': return 'MCP servers'
    case 'plugin': return 'Plugins'
    case 'mesh': return 'Mesh peers'
    case 'unknown': return 'Unknown / quarantined'
    case 'blocked': return 'Blocked'
  }
}

function sourceFromTools(id: string, tools: ToolApprovalCardModel[]): ToolingSourceModel {
  const first = tools[0]
  const type = first ? sourceTypeForTool(first) : 'unknown'
  const blockedToolCount = tools.filter(isBlockedTool).length
  const pendingApprovalCount = tools.filter(isPendingApprovalTool).length
  const name = sourceName(first, type)
  return {
    id,
    shareGroupId: first?.shareGroupId ?? null,
    shareGroupLabel: first?.shareGroupLabel ?? null,
    exportable: tools.length > 0 && tools.every((tool) => tool.exportable === true),
    type,
    name,
    providerLabel: first?.providerLabel ?? name,
    providerKind: first?.providerKind ?? 'unknown',
    transport: first?.transport ?? null,
    peerId: first?.providerPeerId ?? null,
    serviceInstanceId: first?.serviceInstanceId ?? null,
    trustTier: first?.trustTier ?? null,
    configuredTrustTier: null,
    effectiveTrust: effectiveTrust(tools, blockedToolCount, pendingApprovalCount),
    toolCount: tools.length,
    blockedToolCount,
    pendingApprovalCount,
    safeToolCount: tools.filter((tool) => !tool.approvalRequired && !tool.mutating && !tool.dataEgress).length,
    mutatingToolCount: tools.filter((tool) => tool.mutating).length,
    externalToolCount: tools.filter((tool) => tool.dataEgress || tool.riskClass === 'external').length,
    adminToolCount: tools.filter((tool) => tool.requiresAdminAction || `${tool.riskClass}`.includes('admin')).length,
    lastSeenLabel: type === 'mesh' ? 'last shared tool list' : 'latest local tool list',
    catalogState: catalogState(type, blockedToolCount, pendingApprovalCount),
    catalogEvidence: catalogEvidence(type, first),
    routePath: first?.routePath ?? [],
    tools
  }
}

function sourceIdForTool(tool: ToolApprovalCardModel): string {
  if (tool.shareGroupId) {
    return isRemoteTool(tool)
      ? `mesh:${tool.providerPeerId ?? 'remote'}:${tool.shareGroupId}`
      : tool.shareGroupId
  }
  if (tool.sourceId) return tool.sourceId
  const sourceType = sourceTypeForTool(tool)
  if (sourceType === 'mesh') {
    return `mesh:${tool.providerPeerId ?? 'remote'}:${safeSourceSegment(tool.serviceInstanceId ?? tool.providerLabel ?? 'Tooling')}`
  }
  return `local:${sourceType}`
}

function isRemoteTool(tool: ToolApprovalCardModel): boolean {
  const kind = tool.providerKind.toLowerCase()
  return tool.sourceType === 'mesh' || tool.sourceType === 'mesh_peer'
    || kind === 'mesh' || kind === 'mesh_peer' || kind === 'remote'
}

function safeSourceSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'default'
}

function sourceTypeForTool(tool: ToolApprovalCardModel): Exclude<ToolingSourceType, 'blocked'> {
  if (tool.sourceType === 'core' || tool.sourceType === 'mcp' || tool.sourceType === 'plugin' || tool.sourceType === 'unknown') return tool.sourceType
  if (tool.sourceType === 'mesh_peer' || tool.sourceType === 'mesh') return 'mesh'
  const text = `${tool.providerKind} ${tool.providerLabel} ${tool.transport} ${tool.id}`.toLowerCase()
  if (tool.providerKind === 'mesh' || text.includes('mesh:') || text.includes('webrtc')) return 'mesh'
  if (tool.transport === 'mcp' || text.includes('mcp')) return 'mcp'
  if (text.includes('plugin')) return 'plugin'
  if (tool.providerKind === 'local' || tool.transport === 'local-bus' || tool.providerPeerId === 'local-peer') return 'core'
  return 'unknown'
}

function sourceName(tool: ToolApprovalCardModel | undefined, type: Exclude<ToolingSourceType, 'blocked'>): string {
  if (!tool) return sourceSectionLabel(type)
  if (type === 'mesh' && tool.shareGroupLabel) {
    return `${tool.providerLabel || tool.providerPeerId || 'Approved device'} · ${tool.shareGroupLabel}`
  }
  if (tool.shareGroupLabel) return tool.shareGroupLabel
  if (type === 'mesh') return tool.providerLabel || tool.providerPeerId || sourceSectionLabel(type)
  if (type === 'mcp') return tool.serviceInstanceId ?? tool.providerLabel
  if (type === 'core') return tool.providerLabel.includes('Tooling') ? 'Aurora core Tooling' : tool.providerLabel
  return tool.providerLabel
}

function effectiveTrust(tools: ToolApprovalCardModel[], blockedCount: number, pendingCount: number): ToolingTrustState {
  if (tools.length > 0 && blockedCount === tools.length) return 'blocked'
  if (blockedCount > 0) return 'mixed'
  if (pendingCount > 0) return 'approval-required'
  if (tools.some((tool) => tool.trustTier === 'untrusted')) return 'approval-required'
  if (tools.some((tool) => tool.trustTier === 'unknown' || tool.providerKind === 'unknown')) return 'quarantined'
  return tools.some((tool) => tool.trustTier === 'trusted') ? 'trusted' : 'approval-required'
}

function catalogState(type: Exclude<ToolingSourceType, 'blocked'>, blockedCount: number, pendingCount: number): string {
  if (blockedCount > 0) return 'needs review'
  if (pendingCount > 0) return 'approval queue active'
  if (type === 'mesh') return 'reviewed shared list'
  return 'ready'
}

function catalogEvidence(type: Exclude<ToolingSourceType, 'blocked'>, tool: ToolApprovalCardModel | undefined): string {
  if (type === 'mesh') return tool?.auditDestination ?? 'Aurora shared tools'
  if (type === 'mcp') return tool?.serviceInstanceId ?? 'MCP tools'
  return tool?.auditDestination ?? 'Aurora tools'
}

function sourceSortWeight(type: Exclude<ToolingSourceType, 'blocked'>): number {
  switch (type) {
    case 'core':
      return 0
    case 'mcp':
      return 1
    case 'plugin':
      return 2
    case 'mesh':
      return 3
    case 'unknown':
      return 4
  }
}

function grantStatusForTool(tool: ToolApprovalCardModel): ToolingGrantRow['status'] {
  if (tool.state === 'expired') return 'expired'
  if (tool.state === 'denied' || tool.state === 'replay-rejected') return 'revoked'
  if (tool.state === 'unavailable' || tool.disabledReason) return 'stale'
  if (tool.providerKind === 'mesh' && tool.approvalRequired) return 'needs-review'
  return 'active'
}

function formatExpiry(expiresAt: ToolApprovalCardModel['expiresAt']): string {
  if (!expiresAt) return 'backend default'
  if (typeof expiresAt === 'number') return new Date(expiresAt * 1000).toISOString()
  return expiresAt
}

function auditActionForTool(tool: ToolApprovalCardModel): string {
  if (tool.state === 'executed') return 'Tool executed'
  if (tool.state === 'denied') return 'Tool denied'
  if (tool.state === 'expired') return 'Grant expired'
  if (tool.state === 'replay-rejected') return 'Replay rejected'
  if (tool.state === 'unavailable') return 'Device unavailable'
  if (tool.approvalRequired) return 'Approval requested'
  return 'Catalog reviewed'
}
