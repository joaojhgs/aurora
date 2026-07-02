'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Download, FlaskConical, Plug, RefreshCw, ShieldCheck, Stethoscope } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  MethodDescriptor,
  ToolApprovalCardModel,
  ToolApprovalScope
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type AdminPluginsLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'denied'
  | 'degraded'
  | 'service-unavailable'
  | 'error'

export type ToolProviderGroup =
  | 'local-built-in'
  | 'local-plugin'
  | 'local-mcp'
  | 'remote-peer-built-in'
  | 'remote-peer-plugin-mcp'
  | 'unavailable-stale'

export type ToolPolicyMode =
  | 'share-none'
  | 'share-service'
  | 'share-selected'
  | 'deny-selected'
  | 'require-confirmation'
  | 'dry-run-only'
  | 'allowed-peers'

export interface AdminPluginActionPreview {
  id: string
  label: string
  methodId: string
  available: boolean
  requiresAdminAction: boolean
  state: AvailabilityState
  reason: string
  affectedResources: string[]
  repairState: 'admin-action-ready' | 'missing-contract' | 'missing-route' | 'missing-admin-action' | 'invalid-method-type'
  routePath: string | null
}

export interface AdminToolPolicyControl {
  mode: ToolPolicyMode
  label: string
  methodId: string
  available: boolean
  readOnly: boolean
  requiresAdminAction: boolean
  reason: string
}

export interface AdminToolInventoryRow {
  id: string
  name: string
  description: string
  providerGroup: ToolProviderGroup
  providerLabel: string
  providerPeerId: string
  serviceInstanceId: string
  installedState: 'installed-local' | 'discoverable-peer' | 'shared-to-peers' | 'unavailable'
  enabledState: 'enabled' | 'disabled' | 'pending-approval' | 'read-only-remote'
  healthState: AvailabilityState
  providerStatus: string
  providerErrors: string[]
  providerLogs: string[]
  routeState: AvailabilityState
  routeReason: string
  riskClass: string
  dataClasses: string[]
  admin: boolean
  mutating: boolean
  external: boolean
  approvalMode: string
  defaultTtl: string
  lastAuditOutcome: string
  policyControls: AdminToolPolicyControl[]
  secretsRedacted: boolean
}

export interface AdminPluginsSnapshot {
  loadState: AdminPluginsLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  tools: AdminToolInventoryRow[]
  providerGroups: Array<{ group: ToolProviderGroup; label: string; count: number }>
  actions: AdminPluginActionPreview[]
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminPluginsViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialSnapshot?: AdminPluginsSnapshot | undefined
}

export async function buildAdminPluginsSnapshot(
  client: AuroraClient,
  route?: RouteAvailability
): Promise<AdminPluginsSnapshot> {
  if (route?.disabled) {
    return {
      ...loadingPluginsSnapshot,
      loadState: route.state === 'denied' ? 'denied' : route.state === 'degraded' ? 'degraded' : 'service-unavailable',
      warnings: route.blockers,
      error: route.blockers.join(', ') || route.explanation,
      evidenceSource: route.providerLabel
    }
  }

  const [toolsResult, methodsResult] = await Promise.allSettled([
    client.tools.loadApprovalCards(),
    client.registry.listMethods()
  ])
  const toolsResponse = valueOrNull(toolsResult)
  const methods = valueOrNull(methodsResult) ?? []
  const warnings = [
    failureMessage('tool catalog', toolsResult),
    failureMessage('registry methods', methodsResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [toolsResult, methodsResult].some(isDeniedFailure) || (toolsResponse?.ok === false && isPermissionError(toolsResponse.error))

  if ((!toolsResponse || !toolsResponse.ok) && methods.length === 0) {
    return {
      ...loadingPluginsSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      warnings,
      error: toolsResponse && !toolsResponse.ok
        ? toolsResponse.error.message
        : warnings.join(' ') || 'Tooling catalog and registry methods are unavailable.',
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const toolFailure = toolsResponse && !toolsResponse.ok ? toolsResponse.error.message : null
  const toolCards = toolsResponse?.ok ? toolsResponse.data : []
  const rows = toolCards.map((tool) => buildToolInventoryRow(tool, methods))
  const actionPreviews = buildActionPreviews(methods, rows)
  const allWarnings = toolFailure ? [...warnings, toolFailure] : warnings
  const loadState: AdminPluginsLoadState = denied
    ? 'denied'
    : allWarnings.length > 0
      ? 'degraded'
      : rows.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    generatedAt: null,
    secretsRedacted: rows.every((row) => row.secretsRedacted),
    tools: rows,
    providerGroups: groupCounts(rows),
    actions: actionPreviews,
    warnings: allWarnings,
    error: allWarnings[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response'
  }
}

export function AdminPluginsView({ client, route, initialSnapshot }: AdminPluginsViewProps) {
  const [snapshot, setSnapshot] = useState<AdminPluginsSnapshot>(initialSnapshot ?? loadingPluginsSnapshot)
  const [message, setMessage] = useState<string | null>(null)
  const totals = useMemo(() => adminPluginTotals(snapshot.tools), [snapshot.tools])

  useEffect(() => {
    let cancelled = false
    if (initialSnapshot && initialSnapshot.loadState !== 'loading') return
    setSnapshot(loadingPluginsSnapshot)
    buildAdminPluginsSnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route, initialSnapshot])

  async function previewAction(action: AdminPluginActionPreview) {
    if (!action.available) {
      setMessage(action.reason)
      return
    }
    setMessage(`AdminAction preview required for ${action.methodId}; backend confirmation is not auto-submitted from this summary.`)
  }

  return (
    <section className="aui-admin-services" aria-labelledby="admin-plugins-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-plugins-title"><Plug size={24} aria-hidden /> Plugins, MCP, and tools</h1>
          <p>
            Plugin, MCP, and aggregate tool inventory is rendered from AuroraClient. Reload, install, and sharing
            mutations stay AdminAction-gated and disabled when the backend contract is not advertised.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Plugin admin backend evidence">
          {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={route.item.privacyClass} />
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        </div>
      </header>

      <PluginsStatusPanel snapshot={snapshot} route={route} message={message} />

      <div className="aui-admin-metrics" aria-label="Plugin and tool summary">
        <Metric label="Tools" value={String(snapshot.tools.length)} detail={`${totals.local} local / ${totals.remote} remote`} />
        <Metric label="Plugin/MCP" value={String(totals.pluginLike)} detail="provider classified" />
        <Metric label="Policy gated" value={String(totals.policyGated)} detail="approval or AdminAction" />
        <Metric label="Unavailable" value={String(totals.unavailable)} detail="denied, stale, or service unavailable" />
      </div>

      <div className="aui-admin-grid">
        <section className="aui-admin-panel" aria-labelledby="provider-groups-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">Providers</p>
              <h2 id="provider-groups-title">Provider grouping</h2>
            </div>
            <Boxes size={18} aria-hidden />
          </div>
          <div className="aui-config-history">
            {snapshot.providerGroups.map((group) => (
              <article key={group.group}>
                <div>
                  <strong>{group.label}</strong>
                  <span>{group.count} catalog item(s)</span>
                </div>
                <StatusBadge state={group.group === 'unavailable-stale' ? 'stale' : 'available-local'} />
              </article>
            ))}
          </div>
        </section>

        <section className="aui-admin-panel" aria-labelledby="plugin-actions-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">AdminAction</p>
              <h2 id="plugin-actions-title">Reload and install controls</h2>
            </div>
            <ShieldCheck size={18} aria-hidden />
          </div>
          <div className="aui-config-history">
            {snapshot.actions.map((action) => (
              <article key={action.id}>
                <div>
                  <strong>{action.label}</strong>
                  <code>{action.methodId}</code>
                  <span>{action.reason}</span>
                  {action.repairState !== 'admin-action-ready' ? <small>Repair state: {action.repairState}</small> : <small>Route: {action.routePath}</small>}
                </div>
                <button type="button" className="aui-action-chip" disabled={!action.available} onClick={() => void previewAction(action)}>
                  {action.id.includes('install') ? <Download size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />}
                  AdminAction
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="aui-admin-panel" aria-labelledby="tool-inventory-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Inventory</p>
            <h2 id="tool-inventory-title">Tool risk and sharing policy</h2>
          </div>
          <FlaskConical size={18} aria-hidden />
        </div>
        {snapshot.tools.length === 0 ? <p className="aui-muted">No plugin, MCP, or tool catalog entries were returned by the SDK.</p> : null}
        <div className="aui-table-scroll">
          <table className="aui-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Provider</th>
                <th>Health</th>
                <th>Risk</th>
                <th>Policy</th>
                <th>Audit and logs</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.tools.map((tool) => <ToolInventoryRow key={tool.id} tool={tool} />)}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

function PluginsStatusPanel({
  snapshot,
  route,
  message
}: {
  snapshot: AdminPluginsSnapshot
  route: RouteAvailability
  message: string | null
}) {
  if (snapshot.loadState === 'loading') {
    return <div className="aui-admin-notice" aria-live="polite"><RefreshCw size={18} aria-hidden />Loading Tooling catalog through AuroraClient.</div>
  }
  if (route.disabled) {
    return <div className="aui-admin-notice aui-admin-notice-warning" role="alert"><AlertTriangle size={18} aria-hidden />{route.blockers.join(', ') || route.explanation}</div>
  }
  if (snapshot.loadState === 'empty') {
    return <div className="aui-admin-notice" role="status"><Plug size={18} aria-hidden />No Tooling catalog entries were returned.</div>
  }
  if (snapshot.error) {
    return <div className="aui-admin-notice aui-admin-notice-warning" role="alert"><AlertTriangle size={18} aria-hidden />{snapshot.error}</div>
  }
  if (message) {
    return <div className="aui-admin-notice" role="status"><ShieldCheck size={18} aria-hidden />{message}</div>
  }
  return null
}

function ToolInventoryRow({ tool }: { tool: AdminToolInventoryRow }) {
  return (
    <tr>
      <td>
        <details className="aui-service-details">
          <summary>
            <strong>{tool.name}</strong>
            <small>{tool.description}</small>
          </summary>
          <div className="aui-service-drawer">
            <dl>
              <div><dt>Tool ID</dt><dd>{tool.id}</dd></div>
              <div><dt>Install state</dt><dd>{tool.installedState}</dd></div>
              <div><dt>Data classes</dt><dd>{tool.dataClasses.join(', ') || 'none reported'}</dd></div>
              <div><dt>Flags</dt><dd>{tool.admin ? 'admin ' : ''}{tool.mutating ? 'mutating ' : ''}{tool.external ? 'external' : 'local-only'}</dd></div>
              <div><dt>Default TTL</dt><dd>{tool.defaultTtl}</dd></div>
            </dl>
          </div>
        </details>
      </td>
      <td>
        <div className="aui-state-line">
          <StatusBadge state={tool.routeState} />
          <span>{providerGroupLabel(tool.providerGroup)}</span>
        </div>
        <small>{tool.providerLabel}; peer {tool.providerPeerId}; service {tool.serviceInstanceId}</small>
      </td>
      <td>
        <div className="aui-state-line">
          <StatusBadge state={tool.healthState} />
          <span>{tool.enabledState}</span>
        </div>
        <small>{tool.providerStatus}</small>
        {tool.providerErrors.length > 0 ? <small>Errors: {tool.providerErrors.join('; ')}</small> : null}
      </td>
      <td>
        <span className={`aui-risk-pill aui-risk-${riskClassName(tool.riskClass)}`}>{tool.riskClass}</span>
        <small>{tool.approvalMode}</small>
      </td>
      <td>
        <div className="aui-method-list">
          {tool.policyControls.map((control) => (
            <span key={control.mode} className={`aui-method-chip ${control.available ? '' : 'aui-method-chip-disabled'}`} title={control.reason}>
              {control.label}: {control.readOnly ? 'read-only' : control.available ? 'AdminAction' : 'disabled'}
            </span>
          ))}
        </div>
      </td>
      <td>
        <code>{tool.lastAuditOutcome}</code>
        <small>{tool.routeReason}</small>
        <details className="aui-service-details">
          <summary><Stethoscope size={14} aria-hidden /> Provider logs</summary>
          <ul>
            {tool.providerLogs.map((log) => <li key={log}>{log}</li>)}
          </ul>
        </details>
      </td>
    </tr>
  )
}

function buildToolInventoryRow(tool: ToolApprovalCardModel, methods: MethodDescriptor[]): AdminToolInventoryRow {
  const providerGroup = classifyProvider(tool)
  const remote = providerGroup === 'remote-peer-built-in' || providerGroup === 'remote-peer-plugin-mcp'
  const unavailable = isUnavailableTool(tool)
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    providerGroup: unavailable ? 'unavailable-stale' : providerGroup,
    providerLabel: tool.providerLabel,
    providerPeerId: tool.providerPeerId ?? 'local',
    serviceInstanceId: tool.serviceInstanceId ?? 'not reported',
    installedState: unavailable
      ? 'unavailable'
      : remote
        ? 'discoverable-peer'
        : tool.approvalRequired || tool.requiresAdminAction
          ? 'shared-to-peers'
          : 'installed-local',
    enabledState: enabledStateForTool(tool, remote, unavailable),
    healthState: stateForTool(tool),
    providerStatus: providerStatus(tool),
    providerErrors: providerErrors(tool),
    providerLogs: providerLogs(tool),
    routeState: stateForTool(tool),
    routeReason: tool.disabledReason ?? tool.denialReason ?? (tool.providers.map((provider) => provider.reason).join('; ') || 'catalog provider'),
    riskClass: tool.riskClass,
    dataClasses: dataClassesForTool(tool),
    admin: tool.requiresAdminAction,
    mutating: tool.mutating,
    external: tool.dataEgress || tool.providerKind === 'cloud' || tool.transport === 'mcp',
    approvalMode: approvalMode(tool),
    defaultTtl: tool.tokenTtlSeconds ? `${tool.tokenTtlSeconds}s` : 'backend default',
    lastAuditOutcome: tool.result?.auditReceipt ?? tool.auditDestination ?? tool.correlationId ?? 'audit pending',
    policyControls: buildPolicyControls(tool, methods, remote, unavailable),
    secretsRedacted: tool.secretsRedacted
  }
}

function buildActionPreviews(methods: MethodDescriptor[], rows: AdminToolInventoryRow[]): AdminPluginActionPreview[] {
  return [
    actionPreview({
      id: 'reload-plugins',
      label: 'Reload plugin and MCP catalog',
      methodId: 'Tooling.ReloadPlugins',
      methods,
      affectedResources: ['tooling:plugins', 'tooling:mcp']
    }),
    actionPreview({
      id: 'install-plugin',
      label: 'Install plugin package',
      methodId: 'Tooling.InstallPlugin',
      methods,
      affectedResources: ['tooling:plugins']
    }),
    actionPreview({
      id: 'update-tool-policy',
      label: 'Update local tool sharing policy',
      methodId: 'Tooling.UpdateToolSharingPolicy',
      methods,
      affectedResources: rows.filter((row) => !row.providerGroup.startsWith('remote')).map((row) => `tool:${row.id}`)
    })
  ]
}

function actionPreview(input: {
  id: string
  label: string
  methodId: string
  methods: MethodDescriptor[]
  affectedResources: string[]
}): AdminPluginActionPreview {
  const method = input.methods.find((candidate) => candidate.busTopic === input.methodId)
  const external = method?.availableOverHttp === true
  const hasRoute = Boolean(method?.routePath)
  const manage = method?.methodType === 'manage' || method?.methodType === 'admin-critical'
  const adminActionReady = hasAdminActionGateway(input.methods)
  const repairState: AdminPluginActionPreview['repairState'] = !method
    ? 'missing-contract'
    : !hasRoute || !external
      ? 'missing-route'
      : !manage
        ? 'invalid-method-type'
        : !adminActionReady
          ? 'missing-admin-action'
          : 'admin-action-ready'
  return {
    id: input.id,
    label: input.label,
    methodId: input.methodId,
    available: repairState === 'admin-action-ready',
    requiresAdminAction: manage,
    state: repairState === 'admin-action-ready' ? 'available-local' : repairState === 'missing-contract' ? 'unsupported' : 'privacy-blocked',
    reason: pluginActionReason(input.methodId, repairState),
    affectedResources: input.affectedResources,
    repairState,
    routePath: method?.routePath ?? null
  }
}

function hasAdminActionGateway(methods: MethodDescriptor[]): boolean {
  const draft = methods.some((method) => method.busTopic === 'Gateway.AdminActionDraft' && method.availableOverHttp && Boolean(method.routePath))
  const confirm = methods.some((method) => method.busTopic === 'Gateway.AdminActionConfirm' && method.availableOverHttp && Boolean(method.routePath))
  return draft && confirm
}

function pluginActionReason(methodId: string, repairState: AdminPluginActionPreview['repairState']): string {
  if (repairState === 'admin-action-ready') return 'Available through a real Gateway route after AdminAction draft/confirm/audit.'
  if (repairState === 'missing-contract') return `${methodId} is not advertised by Gateway registry; repair the backend contract before enabling this control.`
  if (repairState === 'missing-route') return `${methodId} has no routeable Gateway HTTP path; add/export the route before UI reload is enabled.`
  if (repairState === 'missing-admin-action') return 'Gateway.AdminActionDraft and Gateway.AdminActionConfirm must be routeable before plugin mutations are enabled.'
  return `${methodId} is not marked manage/admin-critical; backend must classify this mutation as AdminAction-gated.`
}

function buildPolicyControls(tool: ToolApprovalCardModel, methods: MethodDescriptor[], remote: boolean, unavailable: boolean): AdminToolPolicyControl[] {
  const methodId = 'Tooling.UpdateToolSharingPolicy'
  const advertised = methods.some((method) => method.busTopic === methodId && method.availableOverHttp && method.methodType === 'manage')
  const readOnly = remote
  const unsupportedReason = advertised
    ? 'Policy changes require AdminAction draft/confirm/audit.'
    : `${methodId} is not advertised; policy is read-only in this checkout.`
  if (unavailable) {
    const reason = 'Unavailable tooling is not presented as working; repair the provider/service before changing sharing policy or executing.'
    return [
      policyControl('share-none', 'Share none', methodId, false, false, reason),
      policyControl('share-service', 'Share service/toolkit', methodId, false, false, reason),
      policyControl('share-selected', 'Share selected', methodId, false, false, reason),
      policyControl('deny-selected', 'Deny selected', methodId, false, false, reason),
      policyControl('require-confirmation', 'Require confirmation', methodId, false, false, reason),
      policyControl('dry-run-only', 'Dry-run only', methodId, false, false, reason),
      policyControl('allowed-peers', 'Allowed peers/providers', methodId, false, false, reason)
    ]
  }
  return [
    policyControl('share-none', 'Share none', methodId, advertised, readOnly, unsupportedReason),
    policyControl('share-service', 'Share service/toolkit', methodId, advertised, readOnly, unsupportedReason),
    policyControl('share-selected', 'Share selected', methodId, advertised, readOnly, unsupportedReason),
    policyControl('deny-selected', 'Deny selected', methodId, advertised, readOnly, unsupportedReason),
    policyControl('require-confirmation', 'Require confirmation', methodId, advertised || tool.approvalRequired, readOnly, tool.approvalRequired ? 'Current backend policy requires approval.' : unsupportedReason),
    policyControl('dry-run-only', 'Dry-run only', methodId, advertised || tool.dryRunRequired, readOnly, tool.dryRunRequired ? 'Current backend policy requires dry-run only.' : unsupportedReason),
    policyControl('allowed-peers', 'Allowed peers/providers', methodId, advertised, readOnly, unsupportedReason)
  ]
}

function policyControl(
  mode: ToolPolicyMode,
  label: string,
  methodId: string,
  available: boolean,
  readOnly: boolean,
  reason: string
): AdminToolPolicyControl {
  return {
    mode,
    label,
    methodId,
    available: available && !readOnly,
    readOnly,
    requiresAdminAction: true,
    reason: readOnly ? 'Remote peer tool policy is read-only unless this node owns the policy.' : reason
  }
}


function enabledStateForTool(tool: ToolApprovalCardModel, remote: boolean, unavailable: boolean): AdminToolInventoryRow['enabledState'] {
  if (unavailable || tool.state === 'denied') return 'disabled'
  if (remote) return 'read-only-remote'
  if (tool.approvalRequired || tool.requiresAdminAction || tool.providerSelectorRequired || tool.selectorRequired) return 'pending-approval'
  return 'enabled'
}

function providerStatus(tool: ToolApprovalCardModel): string {
  if (tool.state === 'unavailable') return `disabled: ${tool.disabledReason ?? 'provider unavailable'}`
  if (tool.state === 'denied') return `disabled: ${tool.denialReason ?? 'policy denied'}`
  if (tool.providerSelectorRequired || tool.selectorRequired) return 'selector required before execution'
  if (tool.dryRunRequired) return 'dry-run-only provider policy'
  if (tool.providers.length > 0) return tool.providers.map((provider) => `${provider.label}: ${provider.reason}`).join('; ')
  return 'provider reports available'
}

function providerErrors(tool: ToolApprovalCardModel): string[] {
  return [
    tool.disabledReason,
    tool.denialReason,
    tool.result?.error ?? null,
    ...tool.providers.filter((provider) => !provider.selectable).map((provider) => provider.reason)
  ].filter((value): value is string => Boolean(value))
}

function providerLogs(tool: ToolApprovalCardModel): string[] {
  const logs = [
    `state=${tool.state}`,
    `provider=${tool.providerLabel}`,
    `transport=${tool.transport ?? 'not reported'}`,
    `route=${tool.routePath.join(' -> ') || 'not reported'}`,
    tool.correlationId ? `correlation=${tool.correlationId}` : null,
    tool.policyDecisionId ? `policy=${tool.policyDecisionId}` : null,
    tool.approvalRequestId ? `approval=${tool.approvalRequestId}` : null,
    tool.result?.auditReceipt ? `audit=${tool.result.auditReceipt}` : null,
    tool.result?.status ? `last-result=${tool.result.status}` : null,
    tool.result?.redactionStatus ? `redaction=${tool.result.redactionStatus}` : null
  ].filter((value): value is string => Boolean(value))
  return logs.length > 0 ? logs : ['No provider log metadata reported by backend.']
}

function classifyProvider(tool: ToolApprovalCardModel): ToolProviderGroup {
  const id = `${tool.id} ${tool.providerKind} ${tool.providerLabel} ${tool.transport}`.toLowerCase()
  const remote = Boolean(tool.providerPeerId && tool.providerPeerId !== 'local-peer') || tool.providerKind === 'mesh'
  const pluginOrMcp = id.includes('plugin') || id.includes('mcp') || tool.transport === 'mcp' || tool.providerKind === 'cloud'
  if (remote && pluginOrMcp) return 'remote-peer-plugin-mcp'
  if (remote) return 'remote-peer-built-in'
  if (pluginOrMcp && tool.transport === 'mcp') return 'local-mcp'
  if (pluginOrMcp) return 'local-plugin'
  return 'local-built-in'
}

function stateForTool(tool: ToolApprovalCardModel): AvailabilityState {
  if (tool.state === 'denied') return 'denied'
  if (tool.state === 'unavailable') return 'stale'
  if (tool.providerSelectorRequired || tool.selectorRequired) return 'privacy-blocked'
  if (tool.dryRunRequired || tool.state === 'expired' || tool.state === 'replay-rejected' || tool.state === 'failed') return 'degraded'
  if (tool.providerPeerId && tool.providerPeerId !== 'local-peer') return 'available-remote'
  return 'available-local'
}

function approvalMode(tool: ToolApprovalCardModel): string {
  if (tool.state === 'unavailable') return `unavailable: ${tool.disabledReason ?? 'provider/service unavailable'}`
  if (tool.state === 'denied') return `denied: ${tool.denialReason ?? 'backend policy denied'}`
  if (tool.state === 'expired') return 'expired approval; request a fresh backend approval'
  if (tool.state === 'replay-rejected') return `replay rejected: ${tool.denialReason ?? 'backend replay protection'}`
  if (tool.dryRunRequired) return 'dry-run-only'
  if (tool.providerSelectorRequired) return 'provider selector required'
  if (tool.approvalRequired) return tool.requestedApprovalScope ?? tool.approvalScopes[0] ?? 'approval required'
  return 'no approval required'
}

function isUnavailableTool(tool: ToolApprovalCardModel): boolean {
  return tool.state === 'unavailable'
    || tool.state === 'denied'
    || tool.state === 'expired'
    || tool.state === 'replay-rejected'
    || tool.providerLabel.toLowerCase().includes('stale')
}

function dataClassesForTool(tool: ToolApprovalCardModel): string[] {
  const classes = new Set<string>()
  if (tool.dataEgress) classes.add('external-egress')
  if (tool.riskClass.includes('admin')) classes.add('admin-critical')
  if (tool.riskClass.includes('sensitive')) classes.add('sensitive')
  if (tool.mutating) classes.add('mutating')
  if (classes.size === 0) classes.add('public')
  return [...classes]
}

function groupCounts(rows: AdminToolInventoryRow[]) {
  const counts = new Map<ToolProviderGroup, number>()
  for (const row of rows) counts.set(row.providerGroup, (counts.get(row.providerGroup) ?? 0) + 1)
  return [...counts.entries()].map(([group, count]) => ({ group, label: providerGroupLabel(group), count }))
}

function adminPluginTotals(rows: AdminToolInventoryRow[]) {
  return {
    local: rows.filter((row) => row.providerGroup.startsWith('local')).length,
    remote: rows.filter((row) => row.providerGroup.startsWith('remote')).length,
    pluginLike: rows.filter((row) => row.providerGroup.includes('plugin') || row.providerGroup.includes('mcp')).length,
    policyGated: rows.filter((row) => row.admin || row.approvalMode !== 'no approval required').length,
    unavailable: rows.filter((row) => row.routeState === 'denied' || row.routeState === 'stale' || row.routeState === 'unsupported').length
  }
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="aui-admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function providerGroupLabel(group: ToolProviderGroup): string {
  if (group === 'local-built-in') return 'Local built-in'
  if (group === 'local-plugin') return 'Local plugin'
  if (group === 'local-mcp') return 'Local MCP'
  if (group === 'remote-peer-built-in') return 'Remote peer built-in'
  if (group === 'remote-peer-plugin-mcp') return 'Remote peer plugin/MCP'
  return 'Unavailable or stale provider'
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null
  return `${label}: ${errorMessage(result.reason)}`
}

function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  return result.status === 'rejected' && isPermissionError(result.reason)
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'permission'
}

function isAvailabilityState(value: string): value is AvailabilityState {
  return [
    'available-local',
    'available-remote',
    'pending',
    'offline',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}

function riskClassName(risk: string): string {
  return risk.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const loadingPluginsSnapshot: AdminPluginsSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  tools: [],
  providerGroups: [],
  actions: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}
