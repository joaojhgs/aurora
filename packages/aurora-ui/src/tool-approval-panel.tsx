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

  const counts = useMemo(() => toolCounts(state.tools), [state.tools])
  const jobCounts = useMemo(() => schedulerCounts(state.schedulerJobs), [state.schedulerJobs])

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
          {state.loading ? <p className="aui-tool-empty">Loading Tooling catalog through AuroraClient...</p> : null}
          {!state.loading && state.tools.length === 0 ? (
            <p className="aui-tool-empty">No tools were returned by the SDK Tooling catalog.</p>
          ) : null}
          {state.tools.map((tool) => (
            <ToolApprovalCard
              key={tool.id}
              tool={tool}
              selectedProviderId={state.selectedProviders[tool.id]}
              decisionMessage={state.decisionMessages[tool.id] ?? null}
              routeDisabled={route.disabled}
              onSelectProvider={(providerId) => selectProvider(tool, providerId)}
              onApprove={(scope, dryRun) => approve(tool, scope, dryRun)}
              onDeny={() => deny(tool)}
            />
          ))}
        </section>

        <aside className="aui-tool-summary" aria-label="Tool approval summary">
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

function ToolApprovalCard({
  tool,
  selectedProviderId,
  decisionMessage,
  routeDisabled,
  onSelectProvider,
  onApprove,
  onDeny
}: {
  tool: ToolApprovalCardModel
  selectedProviderId?: string | undefined
  decisionMessage: string | null
  routeDisabled: boolean
  onSelectProvider: (providerId: string) => void
  onApprove: (scope: ToolApprovalScope, dryRun?: boolean) => void
  onDeny: () => void
}) {
  const selectedProvider = tool.providers.find((provider) => provider.id === selectedProviderId)
    ?? tool.providers.find((provider) => provider.selectable)
    ?? tool.providers[0]
  const selectorMissing = tool.providerSelectorRequired && !selectedProviderId && tool.providers.length > 1
  const blocked = routeDisabled || tool.state === 'unavailable' || tool.state === 'denied' || tool.state === 'expired' || tool.state === 'replay-rejected'
  const approveDisabled = blocked || selectorMissing || tool.state === 'dry-run-only'
  const dryRunDisabled = blocked || selectorMissing || !tool.dryRunSupported
  const denyDisabled = blocked || selectorMissing
  const adminLabel = tool.requiresAdminAction ? 'AdminAction required' : 'tool approval'

  return (
    <article className={`aui-tool-card aui-tool-state-${tool.state}`}>
      <header className="aui-tool-card-header">
        <div>
          <h2>{tool.name}</h2>
          <p>{tool.description}</p>
        </div>
        <span className={`aui-risk-pill aui-risk-${riskClassName(tool.riskClass)}`}>{tool.riskClass}</span>
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
  if (tool.state === 'unavailable') return `Unavailable: ${tool.disabledReason ?? 'service unavailable'}.`
  if (tool.state === 'executed') return 'Tool result includes audit and correlation evidence.'
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
