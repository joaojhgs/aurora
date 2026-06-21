'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Clock, FileDiff, FlaskConical, Play, ShieldAlert, X } from 'lucide-react'
import type {
  AuroraClient,
  AuroraResponse,
  ToolApprovalCardModel,
  ToolApprovalScope
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface ToolApprovalPanelProps {
  client: AuroraClient
  route: RouteAvailability
  initialTools?: ToolApprovalCardModel[] | undefined
}

export interface ToolApprovalPanelState {
  tools: ToolApprovalCardModel[]
  loading: boolean
  error: string | null
  selectedProviders: Record<string, string>
  decisionMessages: Record<string, string>
}

export function ToolApprovalPanel({ client, route, initialTools }: ToolApprovalPanelProps) {
  const [state, setState] = useState<ToolApprovalPanelState>(() => ({
    tools: initialTools ?? [],
    loading: !initialTools,
    error: null,
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

  const counts = useMemo(() => toolCounts(state.tools), [state.tools])

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

  function deny(tool: ToolApprovalCardModel) {
    setState((current) => ({
      ...current,
      decisionMessages: {
        ...current.decisionMessages,
        [tool.id]: 'Denied locally in the approval UI; backend confirmation is required when a request ID is present.'
      }
    }))
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
          <h1 id="tool-approval-title">Approval cards</h1>
          <p>
            Tool execution stays disabled until SDK catalog, route policy, approval, selector, and audit evidence
            all line up.
          </p>
        </div>
        <div className="aui-assistant-badges" aria-label="Tooling backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={route.item.privacyClass} />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={`${counts.total} tools`} />
          <EvidenceBadge label={`${counts.blocked} blocked`} />
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
    </section>
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
        <JsonPreview label="Redacted arguments" value={tool.argsPreview} fallback="No argument preview reported." />
        <JsonPreview label="Dry-run preview" value={tool.dryRunPreview} fallback="No dry-run preview reported." />
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
        <button type="button" className="aui-secondary-action" disabled={blocked} onClick={onDeny}>
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
      <JsonPreview label="Redacted output" value={result.outputPreview} fallback={result.error ?? 'No output preview reported.'} />
    </section>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function JsonPreview({ label, value, fallback }: { label: string; value: object | null; fallback: string }) {
  return (
    <div className="aui-json-preview">
      <h3>{label}</h3>
      <pre>{value ? JSON.stringify(value, null, 2) : fallback}</pre>
    </div>
  )
}

function toolCounts(tools: ToolApprovalCardModel[]) {
  return {
    total: tools.length,
    blocked: tools.filter((tool) => ['denied', 'expired', 'replay-rejected', 'unavailable', 'provider-selector-required', 'dry-run-only'].includes(tool.state)).length
  }
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
