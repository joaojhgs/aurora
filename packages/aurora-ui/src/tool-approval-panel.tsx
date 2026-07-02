'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, Clock, FileDiff, FlaskConical, Play, Plug, ShieldAlert, Wrench, X } from 'lucide-react'
import type {
  AuroraClient,
  AuroraResponse,
  AvailabilityState,
  NormalizedSchedulerJob,
  ToolApprovalCardModel,
  ToolApprovalDecisionResult,
  ToolApprovalScope
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface ToolApprovalPanelProps {
  client: AuroraClient
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
  initialSchedulerJobs?: NormalizedSchedulerJob[] | undefined
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
}

export interface ToolDenialActionInput {
  client: AuroraClient
  tool: ToolApprovalCardModel
  selectedProviderId?: string | undefined
  reason?: string
}

export function ToolApprovalPanel({ client, route, initialTools, initialSchedulerJobs }: ToolApprovalPanelProps) {
  const [state, setState] = useState<ToolApprovalPanelState>(() => ({
    tools: initialTools ?? [],
    loading: !initialTools,
    error: null,
    schedulerJobs: initialSchedulerJobs ?? [],
    schedulerLoading: !initialSchedulerJobs,
    schedulerError: null,
    selectedProviders: {},
    decisionMessages: {}
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
      setState((current) => ({
        ...current,
        schedulerLoading: false,
        schedulerJobs: jobs,
        schedulerError: null
      }))
    }).catch((error) => {
      if (cancelled) return
      setState((current) => ({
        ...current,
        schedulerLoading: false,
        schedulerJobs: [],
        schedulerError: errorMessage(error)
      }))
    })
    return () => {
      cancelled = true
    }
  }, [client, initialSchedulerJobs])

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedToolId, setSelectedToolId] = useState<string | null>(initialTools?.[0]?.id ?? null)
  const counts = useMemo(() => toolCounts(state.tools), [state.tools])
  const jobCounts = useMemo(() => schedulerCounts(state.schedulerJobs), [state.schedulerJobs])
  const categories = useMemo(() => buildToolCategories(state.tools), [state.tools])
  const filteredTools = useMemo(() => filterTools(state.tools, category, query), [state.tools, category, query])
  const selectedTool = useMemo(
    () => filteredTools.find((tool) => tool.id === selectedToolId) ?? filteredTools[0] ?? state.tools[0] ?? null,
    [filteredTools, selectedToolId, state.tools]
  )

  async function approve(tool: ToolApprovalCardModel, scope: ToolApprovalScope, dryRun = false) {
    const selectedProviderId = state.selectedProviders[tool.id]
    setState((current) => ({
      ...current,
      decisionMessages: {
        ...current.decisionMessages,
        [tool.id]: dryRun ? 'Submitting dry-run approval...' : `Submitting ${scope} approval...`
      }
    }))
    try {
      const request = {
        tool,
        scope,
        approverPrincipalId: client.auth.snapshot().principalId ?? 'current-principal',
        reason: dryRun ? `Requested dry run for ${tool.name} from Aurora UI` : `Approved ${tool.name} from Aurora UI`,
        dryRun
      }
      const result = await client.tools.submitApprovalDecision(
        selectedProviderId ? { ...request, selectedProviderId } : request
      )
      setState((current) => ({
        ...current,
        decisionMessages: {
          ...current.decisionMessages,
          [tool.id]: `Approved with correlation ${result.correlationId ?? 'pending'}`
        }
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        decisionMessages: { ...current.decisionMessages, [tool.id]: errorMessage(error) }
      }))
    }
  }

  async function deny(tool: ToolApprovalCardModel) {
    const selectedProviderId = state.selectedProviders[tool.id]
    setState((current) => ({
      ...current,
      decisionMessages: {
        ...current.decisionMessages,
        [tool.id]: 'Submitting backend denial...'
      }
    }))
    try {
      const result = await submitToolDenialAction({
        client,
        tool,
        selectedProviderId,
        reason: `Denied ${tool.name} from Aurora UI`
      })
      setState((current) => ({
        ...current,
        decisionMessages: {
          ...current.decisionMessages,
          [tool.id]: denialResultMessage(result)
        }
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        decisionMessages: { ...current.decisionMessages, [tool.id]: errorMessage(error) }
      }))
    }
  }

  function selectProvider(tool: ToolApprovalCardModel, providerId: string) {
    setState((current) => ({
      ...current,
      selectedProviders: { ...current.selectedProviders, [tool.id]: providerId }
    }))
  }

  return (
    <section className="aui-tool-panel" aria-labelledby="tool-approval-title">
      <header className="aui-tool-header">
        <div>
          <p className="aui-kicker">Tools</p>
          <h1 id="tool-approval-title">Tools & Automations</h1>
          <p>
            Tool registry, approval cards, MCP/provider status, scheduler jobs, and execution logs stay bound to SDK evidence.
          </p>
        </div>
        <div className="aui-assistant-badges" aria-label="Tooling backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={route.item.privacyClass} />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={`${counts.total} tools`} />
          <EvidenceBadge label={`${counts.blocked} blocked`} />
          <EvidenceBadge label={`${jobCounts.total} scheduled jobs`} />
          <EvidenceBadge label={`${jobCounts.active} active automations`} />
        </div>
      </header>

      {route.disabled ? (
        <div className="aui-tool-alert" role="alert">
          Tooling is capability-gated: {route.blockers.join(', ') || 'no executable Tooling catalog entry'}.
        </div>
      ) : null}
      {state.error ? <div className="aui-tool-alert" role="alert">{state.error}</div> : null}

      <div className="aui-tool-layout">
        <section className="aui-tool-list" aria-busy={state.loading}>
          <div className="aui-tool-section-heading">
            <div>
              <p className="aui-kicker">Registry</p>
              <h2><Wrench size={18} aria-hidden />Tool registry and Approval cards</h2>
            </div>
            <span className="aui-action-chip"><Plug size={15} aria-hidden />Tooling.GetToolCatalog</span>
          </div>
          <div className="aui-tool-filters" aria-label="Tool catalog filters">
            <label>
              <span>Tool search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search tools, providers, permissions, or risk"
              />
            </label>
            <div className="aui-tool-category-tabs" role="tablist" aria-label="Tool categories">
              {categories.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={category === option.id}
                  onClick={() => setCategory(option.id)}
                >
                  {option.label}
                  <span>{option.count}</span>
                </button>
              ))}
            </div>
          </div>
          {state.loading ? <p className="aui-tool-empty">Loading Tooling catalog through AuroraClient...</p> : null}
          {!state.loading && state.tools.length === 0 ? (
            <p className="aui-tool-empty">No tools were returned by the SDK Tooling catalog.</p>
          ) : null}
          {!state.loading && state.tools.length > 0 && filteredTools.length === 0 ? (
            <p className="aui-tool-empty">No tools match the current category or search filter.</p>
          ) : null}
          {filteredTools.map((tool) => (
            <ToolApprovalCard
              key={tool.id}
              tool={tool}
              selectedProviderId={state.selectedProviders[tool.id]}
              decisionMessage={state.decisionMessages[tool.id] ?? null}
              routeDisabled={route.disabled}
              selected={selectedTool?.id === tool.id}
              onSelect={() => setSelectedToolId(tool.id)}
              onSelectProvider={(providerId) => selectProvider(tool, providerId)}
              onApprove={(scope, dryRun) => approve(tool, scope, dryRun)}
              onDeny={() => deny(tool)}
            />
          ))}
        </section>

        <aside className="aui-tool-summary" aria-label="Tool approval summary">
          {selectedTool ? <ToolDetailDrawer tool={selectedTool} /> : null}
          <section className="aui-tool-mcp" aria-label="MCP server status">
            <h2>MCP server status</h2>
            <dl>
              <div><dt>Providers</dt><dd>{providerStatusSummary(state.tools)}</dd></div>
              <div><dt>Reload support</dt><dd>Safe reload requires a backend Tooling reload/AdminAction contract.</dd></div>
            </dl>
            <button type="button" className="aui-secondary-action" disabled>Reload catalog</button>
          </section>
          <h2>Execution boundary</h2>
          <dl>
            <div><dt>Backend truth</dt><dd>Tooling.GetToolCatalog via AuroraClient</dd></div>
            <div><dt>Approval controller</dt><dd>client.approvals request/confirm</dd></div>
            <div><dt>Admin mutation</dt><dd>AdminAction when method_type manage/admin-critical</dd></div>
            <div><dt>Result evidence</dt><dd>provider, route path, audit receipt, correlation ID</dd></div>
            <div><dt>Route state</dt><dd>{route.state}</dd></div>
          </dl>
        </aside>
      </div>

      <section className="aui-tool-scheduler" aria-labelledby="tool-scheduler-title">
        <div className="aui-tool-section-heading">
          <div>
            <p className="aui-kicker">Automations</p>
            <h2 id="tool-scheduler-title"><CalendarClock size={18} aria-hidden />Scheduled jobs</h2>
          </div>
          <a className="aui-action-chip" href="/admin/scheduler">Open scheduler</a>
          <span className="aui-action-chip">Scheduler.ListJobs</span>
        </div>
        {state.schedulerError ? <div className="aui-tool-alert" role="alert">{state.schedulerError}</div> : null}
        {state.schedulerLoading ? <p className="aui-tool-empty">Loading scheduler jobs through AuroraClient...</p> : null}
        {!state.schedulerLoading && state.schedulerJobs.length === 0 && !state.schedulerError ? (
          <p className="aui-tool-empty">No scheduler jobs were returned by Scheduler.ListJobs.</p>
        ) : null}
        {state.schedulerJobs.length > 0 ? (
          <div className="aui-table-scroll">
            <table className="aui-table aui-tool-jobs-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Next</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {state.schedulerJobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <strong>{job.name}</strong>
                      <small>{job.action}</small>
                    </td>
                    <td><code>{job.schedule}</code></td>
                    <td>
                      <div className="aui-state-line">
                        <StatusBadge state={schedulerAvailability(job)} />
                        <span>{schedulerStatusLabel(job)}</span>
                      </div>
                    </td>
                    <td>{job.next_run ?? '—'}</td>
                    <td>
                      <strong>{job.target_peer_id ?? job.owner_peer_id}</strong>
                      <small>{job.target_resource_namespace ?? job.namespace}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </section>
  )
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
  return client.tools.submitDenialDecision(
    selectedProviderId ? { ...request, selectedProviderId } : request
  )
}


function ToolDetailDrawer({ tool }: { tool: ToolApprovalCardModel }) {
  const fields = toolSchemaFields(tool)
  const selectedProvider = tool.providers.find((provider) => provider.selectable) ?? tool.providers[0]
  return (
    <section className="aui-tool-detail-drawer" aria-labelledby="tool-detail-drawer-title">
      <p className="aui-kicker">Selected tool</p>
      <h2 id="tool-detail-drawer-title">Tool detail drawer</h2>
      <p>{tool.name}</p>
      <dl>
        <div><dt>Schema</dt><dd>{tool.argsSchema ? 'args_schema from Tooling.GetToolCatalog' : 'No schema reported by backend'}</dd></div>
        <div><dt>Permissions</dt><dd>{tool.requiredPermissions.join(', ') || 'No explicit permissions reported'}</dd></div>
        <div><dt>Provider</dt><dd>{selectedProvider?.label ?? tool.providerLabel} ({selectedProvider?.providerKind ?? tool.providerKind})</dd></div>
        <div><dt>Risk</dt><dd>{tool.riskClass}{tool.requiresAdminAction ? '; AdminAction required' : ''}</dd></div>
        <div><dt>Examples</dt><dd>{exampleSummary(tool)}</dd></div>
      </dl>
      <form className="aui-tool-param-form" aria-label="Generated parameter form">
        <strong>Generated parameter form</strong>
        {fields.length > 0 ? fields.map((field) => (
          <label key={field.name}>
            <span>{field.name}{field.required ? ' *' : ''}</span>
            <input readOnly value={field.example} aria-label={`${field.name} ${field.type} parameter`} />
            <small>{field.type}</small>
          </label>
        )) : <p>No writable parameters were reported for this tool.</p>}
      </form>
    </section>
  )
}

function ToolApprovalCard({
  tool,
  selectedProviderId,
  decisionMessage,
  routeDisabled,
  selected,
  onSelect,
  onSelectProvider,
  onApprove,
  onDeny
}: {
  tool: ToolApprovalCardModel
  selectedProviderId?: string | undefined
  decisionMessage: string | null
  routeDisabled: boolean
  selected: boolean
  onSelect: () => void
  onSelectProvider: (providerId: string) => void
  onApprove: (scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: () => void
}) {
  const selectedProvider = tool.providers.find((provider) => provider.id === selectedProviderId)
    ?? tool.providers.find((provider) => provider.selectable)
    ?? tool.providers[0]
  const selectorMissing = tool.providerSelectorRequired && !selectedProviderId && tool.providers.length > 1
  const adminActionPending = tool.requiresAdminAction && tool.state !== 'approved' && tool.state !== 'executed'
  const blocked = routeDisabled || tool.state === 'unavailable' || tool.state === 'denied' || tool.state === 'expired' || tool.state === 'replay-rejected'
  const approveDisabled = blocked || selectorMissing || adminActionPending || tool.state === 'dry-run-only'
  const dryRunDisabled = blocked || selectorMissing || !tool.dryRunSupported
  const denyDisabled = blocked || selectorMissing
  const adminLabel = tool.requiresAdminAction ? 'AdminAction required' : 'tool approval'

  return (
    <article className={`aui-tool-card aui-tool-state-${tool.state}${selected ? ' selected' : ''}`}>
      <header className="aui-tool-card-header">
        <div>
          <h2>{tool.name}</h2>
          <p>{tool.description}</p>
        </div>
        <div className="aui-tool-card-actions">
          <span className={`aui-risk-pill aui-risk-${riskClassName(tool.riskClass)}`}>{tool.riskClass}</span>
          <button type="button" className="aui-secondary-action" aria-pressed={selected} onClick={onSelect}>View details</button>
        </div>
      </header>

      <div className="aui-tool-meta" aria-label={`${tool.name} approval metadata`}>
        <KeyValue label="Provider" value={selectedProvider?.label ?? tool.providerLabel} />
        <KeyValue label="Peer" value={selectedProvider?.providerPeerId ?? tool.providerPeerId ?? 'local'} />
        <KeyValue label="Trust tier" value={selectedProvider?.trustTier ?? tool.trustTier ?? 'not reported'} />
        <KeyValue label="Transport" value={selectedProvider?.transport ?? tool.transport ?? 'not reported'} />
        <KeyValue label="Data egress" value={tool.dataEgress ? 'yes' : 'no'} />
        <KeyValue label="Mutation" value={tool.mutating ? adminLabel : 'read-only'} />
        <KeyValue label="Args hash" value={tool.argsHash ?? 'not reported'} />
        <KeyValue label="TTL" value={tool.tokenTtlSeconds ? `${tool.tokenTtlSeconds}s` : 'backend default'} />
        <KeyValue label="Audit" value={tool.auditDestination ?? 'audit pending'} />
        <KeyValue label="Correlation" value={tool.correlationId ?? 'pending'} />
      </div>

      {tool.providers.length > 1 || tool.providerSelectorRequired ? (
        <label className="aui-tool-select">
          <span>Provider selector</span>
          <select
            value={selectedProviderId ?? ''}
            onChange={(event) => onSelectProvider(event.currentTarget.value)}
            aria-describedby={`${idFromTool(tool.id)}-selector-help`}
          >
            <option value="">Select provider</option>
            {tool.providers.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!provider.selectable}>
                {provider.label}
              </option>
            ))}
          </select>
          <small id={`${idFromTool(tool.id)}-selector-help`}>
            {selectorMissing ? 'Backend requires an explicit provider selector before approval.' : selectedProvider?.reason ?? 'Provider selected from catalog.'}
          </small>
        </label>
      ) : null}

      <details className="aui-tool-details">
        <summary><FileDiff size={15} aria-hidden />Arguments and result</summary>
        <RedactedPreview label="Redacted arguments" value={tool.argsPreview} fallback="No argument preview reported." />
        <RedactedPreview label="Dry-run preview" value={tool.dryRunPreview} fallback="No dry-run preview reported." />
        {tool.result ? <ToolResultCard result={tool.result} /> : null}
      </details>

      <div className="aui-tool-status-row" role={blocked ? 'alert' : 'status'}>
        {statusIcon(tool.state)}
        <span>{stateCopy(tool)}</span>
      </div>

      <div className="aui-tool-actions">
        <button type="button" className="aui-secondary-action" disabled={dryRunDisabled} onClick={() => onApprove('once', true)}>
          <FlaskConical size={15} aria-hidden />
          Dry run
        </button>
        <button type="button" className="aui-secondary-action" disabled={denyDisabled} onClick={onDeny}>
          <X size={15} aria-hidden />
          Deny
        </button>
        {tool.approvalScopes.map((scope) => (
          <button
            key={scope}
            type="button"
            className="aui-primary-action"
            disabled={approveDisabled}
            onClick={() => onApprove(scope)}
          >
            <Check size={15} aria-hidden />
            {scopeLabel(scope)}
          </button>
        ))}
      </div>

      {decisionMessage ? <p className="aui-tool-message" role="status">{decisionMessage}</p> : null}
    </article>
  )
}

function ToolResultCard({ result }: { result: NonNullable<ToolApprovalCardModel['result']> }) {
  return (
    <section className="aui-tool-result" aria-label="Tool result">
      <h3>Result</h3>
      <div className="aui-tool-meta">
        <KeyValue label="Status" value={result.status} />
        <KeyValue label="Provider" value={result.providerPeerId ?? 'local'} />
        <KeyValue label="Correlation" value={result.correlationId ?? 'pending'} />
        <KeyValue label="Audit receipt" value={result.auditReceipt ?? 'pending'} />
        <KeyValue label="Route path" value={result.routePath.join(' -> ') || 'not reported'} />
        <KeyValue label="Duration" value={result.durationMs === null ? 'not reported' : `${result.durationMs}ms`} />
        <KeyValue label="Redaction" value={result.redactionStatus ?? 'not reported'} />
        <KeyValue label="Retry/fallback" value={`${result.retryEligible ? 'retry' : 'no retry'} / ${result.fallbackEligible ? 'fallback' : 'no fallback'}`} />
      </div>
      <RedactedPreview label="Redacted output" value={result.outputPreview} fallback={result.error ?? 'No output preview reported.'} />
    </section>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function RedactedPreview({ label, value, fallback }: { label: string; value: object | null; fallback: string }) {
  return (
    <div className="aui-redacted-preview">
      <h3>{label}</h3>
      <code>{value ? JSON.stringify(value, null, 2) : fallback}</code>
    </div>
  )
}

function toolCounts(tools: ToolApprovalCardModel[]) {
  return {
    total: tools.length,
    blocked: tools.filter((tool) => ['denied', 'expired', 'replay-rejected', 'unavailable', 'provider-selector-required', 'dry-run-only'].includes(tool.state)).length
  }
}

function buildToolCategories(tools: ToolApprovalCardModel[]) {
  const base = [
    { id: 'all', label: 'All', count: tools.length },
    { id: 'read', label: 'Read-only', count: tools.filter((tool) => toolCategory(tool) === 'read').length },
    { id: 'mutating', label: 'Mutating', count: tools.filter((tool) => toolCategory(tool) === 'mutating').length },
    { id: 'external', label: 'External', count: tools.filter((tool) => toolCategory(tool) === 'external').length },
    { id: 'admin', label: 'Admin', count: tools.filter((tool) => toolCategory(tool) === 'admin').length }
  ]
  return base.filter((category) => category.id === 'all' || category.count > 0)
}

function filterTools(tools: ToolApprovalCardModel[], category: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  return tools.filter((tool) => {
    const categoryMatch = category === 'all' || toolCategory(tool) === category
    if (!categoryMatch) return false
    if (!normalizedQuery) return true
    return toolSearchHaystack(tool).includes(normalizedQuery)
  })
}

function toolCategory(tool: ToolApprovalCardModel) {
  if (tool.requiresAdminAction || tool.riskClass.includes('admin')) return 'admin'
  if (tool.dataEgress || tool.riskClass === 'external') return 'external'
  if (tool.mutating || ['mutating', 'standard'].includes(tool.riskClass)) return 'mutating'
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

function providerStatusSummary(tools: ToolApprovalCardModel[]) {
  const providers = new Set<string>()
  let mcpLike = 0
  for (const tool of tools) {
    const labels = tool.providers.length > 0
      ? tool.providers.map((provider) => ({ id: provider.id, providerKind: provider.providerKind }))
      : [{ id: tool.providerLabel, providerKind: tool.providerKind }]
    for (const provider of labels) {
      providers.add(provider.id)
      if (`${provider.providerKind} ${provider.id}`.toLowerCase().includes('mcp')) mcpLike += 1
    }
  }
  if (providers.size === 0) return 'No providers reported by catalog.'
  return `${providers.size} provider endpoints from catalog; ${mcpLike} MCP-like endpoint${mcpLike === 1 ? '' : 's'} reported.`
}

function toolSchemaFields(tool: ToolApprovalCardModel) {
  const required = schemaRequiredFields(tool.argsSchema)
  const properties = schemaProperties(tool.argsSchema)
  if (properties) {
    return Object.entries(properties).map(([name, schema]) => ({
      name,
      type: schemaFieldType(schema),
      required: required.includes(name),
      example: exampleValue(name, tool)
    }))
  }
  if (tool.argsPreview) {
    return Object.keys(tool.argsPreview).map((name) => ({
      name,
      type: typeof tool.argsPreview?.[name],
      required: false,
      example: exampleValue(name, tool)
    }))
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
  return 'unknown'
}

function exampleValue(name: string, tool: ToolApprovalCardModel) {
  const value = recordValue(tool.argsPreview, name)
    ?? recordValue(tool.dryRunPreview, name)
    ?? ''
  if (value === '') return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function exampleSummary(tool: ToolApprovalCardModel) {
  if (tool.dryRunPreview) return `Dry-run preview: ${JSON.stringify(tool.dryRunPreview)}`
  if (tool.argsPreview) return `Arguments preview: ${JSON.stringify(tool.argsPreview)}`
  return 'No example payload reported by backend.'
}

function recordValue(value: unknown, key: string): Record<string, unknown> | unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return (value as Record<string, unknown>)[key] ?? null
}

function schedulerCounts(jobs: NormalizedSchedulerJob[]) {
  return {
    total: jobs.length,
    active: jobs.filter((job) => job.enabled && !job.blocked_reason).length
  }
}

function schedulerAvailability(job: NormalizedSchedulerJob): AvailabilityState {
  if (job.blocked_reason || job.last_error) return 'denied'
  if (!job.enabled || job.status === 'paused') return 'degraded'
  if (job.status === 'delegated' || job.status === 'remote-running') return 'available-remote'
  return 'available-local'
}

function schedulerStatusLabel(job: NormalizedSchedulerJob): string {
  if (job.blocked_reason) return `blocked: ${job.blocked_reason}`
  if (job.last_error) return `error: ${job.last_error}`
  if (!job.enabled) return 'paused'
  return job.status ?? 'active'
}

function stateCopy(tool: ToolApprovalCardModel): string {
  if (tool.state === 'provider-selector-required') return 'Provider selector required before approval.'
  if (tool.state === 'dry-run-only') return 'Dry-run only until backend policy permits execution.'
  if (tool.state === 'denied') return `Denied: ${tool.denialReason ?? 'backend policy denied approval'}.`
  if (tool.state === 'expired') return 'Approval expired; request a fresh backend approval.'
  if (tool.state === 'replay-rejected') return `Replay rejected: ${tool.denialReason ?? 'backend replay protection blocked it'}.`
  if (tool.state === 'unavailable') return `Unavailable: ${tool.disabledReason ?? 'service unavailable'}. Disabled until provider/service repair completes.`
  if (tool.state === 'executed') return 'Tool result includes audit and correlation evidence.'
  if (tool.requiresAdminAction) return 'AdminAction confirmation required before approval or execution.'
  if (tool.approvalRequired) return 'Approval required before execution.'
  return 'No approval required by current backend policy.'
}

function statusIcon(state: ToolApprovalCardModel['state']) {
  if (state === 'ready' || state === 'approved' || state === 'executed') return <Check size={16} aria-hidden />
  if (state === 'expired') return <Clock size={16} aria-hidden />
  if (state === 'dry-run-only') return <FlaskConical size={16} aria-hidden />
  if (state === 'denied' || state === 'replay-rejected' || state === 'unavailable' || state === 'failed') return <ShieldAlert size={16} aria-hidden />
  return <Play size={16} aria-hidden />
}

function scopeLabel(scope: ToolApprovalScope): string {
  if (scope === 'once') return 'Approve once'
  if (scope === 'session') return 'Approve session'
  if (scope === 'peer') return 'Approve peer'
  if (scope === 'local-safe-tools') return 'Approve local safe'
  return `Approve ${scope}`
}

function riskClassName(risk: string): string {
  return risk.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

function idFromTool(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
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
