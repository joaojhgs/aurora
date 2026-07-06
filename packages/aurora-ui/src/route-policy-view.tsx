'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Route } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityCatalogResponse,
  JsonValue,
  PrivacyClass,
  RouteExplainRequest,
  RoutePolicyEvaluation
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type RoutePolicyLoadState = 'loading' | 'ready' | 'degraded' | 'denied' | 'unavailable' | 'error'
export type RoutePolicyScenarioId =
  | 'assistant_prompt'
  | 'tool_call'
  | 'rag_query'
  | 'audio_session'
  | 'model_runtime'
  | 'scheduler_job'
  | 'admin_action'

export interface RoutePolicyDraft {
  module: string
  requireExplicitSelector: boolean
  allowedPeers: string
  deniedPeers: string
  requiredCapabilities: string
  minimumVersion: string
  trustTier: string
  fallbackPolicy: 'local' | 'network' | 'error' | 'none'
  safetySensitiveClasses: string
  reason: string
  reauthConfirmed: boolean
}

export interface RoutePolicyScenario {
  id: RoutePolicyScenarioId
  label: string
  description: string
  request: RouteExplainRequest
  payload: unknown
  selector: unknown
  privacyClass: PrivacyClass
  dataClasses: PrivacyClass[]
  consentGranted?: boolean
  privacyIndicatorShown?: boolean
  allowCloudFallback?: boolean
}

export interface RoutePolicyScenarioResult {
  scenario: RoutePolicyScenario
  state: AvailabilityState
  evaluation: RoutePolicyEvaluation | null
  error: string | null
}

export interface RoutePolicySnapshot {
  loadState: RoutePolicyLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  routeState: AvailabilityState
  routeReason: string
  policyCapabilityState: AvailabilityState
  policyCapabilityReason: string
  configCapabilityState: AvailabilityState
  configCapabilityReason: string
  canEditPolicy: boolean
  scenarios: RoutePolicyScenarioResult[]
  selectedScenarioId: RoutePolicyScenarioId
  persistedReceipt: string | null
  error: string | null
  warnings: string[]
  evidenceSource: string
}

export interface RoutePolicyResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface RoutePolicyViewProps {
  snapshot: RoutePolicySnapshot
  onSelectScenario?: (id: RoutePolicyScenarioId) => void
  onRefresh?: () => void
}

const loadingSnapshot: RoutePolicySnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  routeState: 'pending',
  routeReason: 'Loading route policy capability through Aurora.',
  policyCapabilityState: 'pending',
  policyCapabilityReason: 'Loading Gateway.ExplainRoute and capability catalog.',
  configCapabilityState: 'pending',
  configCapabilityReason: 'Loading Config.Set approval capability.',
  canEditPolicy: false,
  scenarios: routePolicyScenarios().map((scenario) => ({
    scenario,
    state: 'pending',
    evaluation: null,
    error: null
  })),
  selectedScenarioId: 'assistant_prompt',
  persistedReceipt: null,
  error: null,
  warnings: [],
  evidenceSource: 'pending Aurora service calls'
}

export function RoutePolicyResource({ client, route }: RoutePolicyResourceProps) {
  const [snapshot, setSnapshot] = useState<RoutePolicySnapshot>(loadingSnapshot)
  const [selectedScenarioId, setSelectedScenarioId] = useState<RoutePolicyScenarioId>('assistant_prompt')

  const routeKey = routePolicyRouteKey(route)
  const stableRoute = useMemo(() => route, [routeKey])

  const loadPolicy = useCallback(async () => {
    setSnapshot({ ...loadingSnapshot, selectedScenarioId })
    const next = await buildRoutePolicySnapshot(client, stableRoute, selectedScenarioId)
    setSnapshot(next)
  }, [client, stableRoute, selectedScenarioId])

  useEffect(() => {
    let cancelled = false
    setSnapshot({ ...loadingSnapshot, selectedScenarioId })
    void buildRoutePolicySnapshot(client, stableRoute, selectedScenarioId).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, stableRoute, selectedScenarioId])

  return (
    <RoutePolicyView
      snapshot={snapshot}
      onSelectScenario={setSelectedScenarioId}
      onRefresh={loadPolicy}
    />
  )
}

export async function buildRoutePolicySnapshot(
  client: AuroraClient,
  route: RouteAvailability,
  selectedScenarioId: RoutePolicyScenarioId = 'assistant_prompt',
  persistedReceipt: string | null = null
): Promise<RoutePolicySnapshot> {
  const scenarioDefinitions = routePolicyScenarios()
  const catalogResult = await Promise.allSettled([
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true })
  ]).then(([result]) => result!)
  const catalog = settledValue(catalogResult)
  const scenarioResults = catalog
    ? await Promise.allSettled(
        scenarioDefinitions.map((scenario) => evaluateRoutePolicyScenario(client, scenario, catalog))
      )
    : await Promise.allSettled(
        scenarioDefinitions.map((scenario) => explainRoutePolicyScenarioFailure(client, scenario, catalogResult))
      )
  const scenarios = scenarioDefinitions.map<RoutePolicyScenarioResult>((scenario, index) => {
    const result = scenarioResults[index]
    if (result?.status === 'fulfilled') {
      return { scenario, state: result.value.availability, evaluation: result.value, error: null }
    }
    return {
      scenario,
      state: route.disabled ? route.state : 'unsupported',
      evaluation: null,
      error: routePolicyErrorMessage(result?.reason)
    }
  })
  const failures = [
    settledFailure('capability catalog', catalogResult),
    ...scenarioResults.map((result, index) => settledFailure(scenarioDefinitions[index]?.label ?? `scenario ${index}`, result))
  ].filter((message): message is string => Boolean(message))
  const denied = [catalogResult, ...scenarioResults].some(isDeniedFailure)
  const policyCapability = catalog ? capabilityByTopic(catalog, 'Gateway.ExplainRoute') : null
  const configCapability = catalog ? capabilityByTopic(catalog, 'Config.Set') : null
  const canEditPolicy = Boolean(
    !route.disabled &&
    configCapability &&
    ['available-local', 'available-remote', 'degraded'].includes(capabilityAvailability(configCapability)) &&
    configCapability.policy.approval_required
  )
  const allFailed = scenarios.every((scenario) => !scenario.evaluation)
  const loadState: RoutePolicyLoadState = denied
    ? 'denied'
    : route.disabled || allFailed
      ? 'unavailable'
      : failures.length > 0 || scenarios.some((scenario) => ['denied', 'degraded', 'stale', 'privacy-blocked', 'unsupported'].includes(scenario.state))
        ? 'degraded'
        : 'ready'

  return {
    loadState,
    generatedAt: catalog?.generated_at ?? null,
    secretsRedacted: catalog?.secrets_redacted ?? (scenarios.some((scenario) => scenario.evaluation?.preview.secretsRedacted) || true),
    routeState: route.disabled ? route.state : 'available-local',
    routeReason: route.disabled ? presentableSignal(route.explanation) : 'Mesh route policy screen is backed by Aurora route explain and capability catalog responses.',
    policyCapabilityState: policyCapability ? capabilityAvailability(policyCapability) : allFailed ? 'unsupported' : 'degraded',
    policyCapabilityReason: policyCapability
      ? capabilityReason(policyCapability)
      : 'Gateway.ExplainRoute capability was not present in the catalog response.',
    configCapabilityState: configCapability ? capabilityAvailability(configCapability) : 'unsupported',
    configCapabilityReason: configCapability
      ? capabilityReason(configCapability)
      : 'Config.Set approval capability is required before route policy edits can be saved.',
    canEditPolicy,
    scenarios,
    selectedScenarioId,
    persistedReceipt,
    error: allFailed ? 'Route explain is unavailable through Aurora.' : null,
    warnings: failures,
    evidenceSource: catalog ? 'Aurora capability catalog and Gateway.ExplainRoute' : 'Aurora route explain results'
  }
}

async function explainRoutePolicyScenarioFailure(
  client: AuroraClient,
  scenario: RoutePolicyScenario,
  catalogResult: PromiseSettledResult<CapabilityCatalogResponse>
): Promise<RoutePolicyEvaluation> {
  try {
    await client.routes.explain(scenario.request)
  } catch (error) {
    throw error
  }
  throw catalogResult.status === 'rejected'
    ? catalogResult.reason
    : new Error('Capability catalog response was unavailable for route policy evaluation.')
}

function evaluateRoutePolicyScenario(
  client: AuroraClient,
  scenario: RoutePolicyScenario,
  catalog: CapabilityCatalogResponse
): Promise<RoutePolicyEvaluation> {
  const request = {
    routeRequest: scenario.request,
    payload: scenario.payload,
    selector: scenario.selector,
    privacyClass: scenario.privacyClass,
    dataClasses: scenario.dataClasses,
    auditReceiptTarget: 'Auth.StoreAuditEvent',
    catalog
  }
  return client.routes.evaluatePolicy({
    ...request,
    ...(scenario.consentGranted === undefined ? {} : { consentGranted: scenario.consentGranted }),
    ...(scenario.privacyIndicatorShown === undefined ? {} : { privacyIndicatorShown: scenario.privacyIndicatorShown }),
    ...(scenario.allowCloudFallback === undefined ? {} : { allowCloudFallback: scenario.allowCloudFallback })
  })
}

function routePolicyRouteKey(route: RouteAvailability): string {
  return [
    route.item.id,
    route.state,
    route.disabled ? 'disabled' : 'enabled',
    route.requiresAdminAction ? 'admin' : 'user',
    presentableSignal(route.explanation)
  ].join('|')
}

export function RoutePolicyView({
  snapshot,
  onSelectScenario,
  onRefresh
}: RoutePolicyViewProps) {
  const selected = useMemo(
    () => snapshot.scenarios.find((scenario) => scenario.scenario.id === snapshot.selectedScenarioId) ?? snapshot.scenarios[0],
    [snapshot.scenarios, snapshot.selectedScenarioId]
  )
  return (
    <section className="aui-route-policy-view" aria-labelledby="route-policy-title">
      <header className="aui-route-policy-header">
        <div>
          <p className="aui-kicker">Mesh route policy</p>
          <h1 id="route-policy-title">Route policy decisions</h1>
          <p>Review how Aurora routes peer, privacy, selector, and fallback scenarios before configuration changes are applied.</p>
        </div>
        <div className="aui-mesh-badges" aria-label="Route policy status">
          <StatusBadge state={snapshot.loadState === 'loading' ? 'pending' : snapshot.routeState} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
          <EvidenceBadge label={snapshot.evidenceSource} />
        </div>
      </header>

      <dl className="aui-route-policy-summary">
        <PolicyFact label="Route policy" value={`${snapshot.policyCapabilityState}: ${snapshot.policyCapabilityReason}`} />
        <PolicyFact label="Selected scenario" value={selected ? `${selected.scenario.label}: ${selected.state}` : 'not loaded'} />
      </dl>

      {snapshot.error ? <p className="aui-message aui-message-danger" role="alert">{snapshot.error}</p> : null}
      {snapshot.warnings.length > 0 ? (
        <ul className="aui-mesh-warnings" aria-label="Route policy warnings">
          {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <div className="aui-route-policy-layout">
        <section className="aui-route-policy-panel" aria-labelledby="route-dry-run-title">
          <div className="aui-panel-heading">
            <div>
              <h2 id="route-dry-run-title">Backend decision matrix</h2>
            </div>
            <button className="aui-button" type="button" onClick={onRefresh} disabled={snapshot.loadState === 'loading'}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </button>
          </div>
          <div className="aui-route-scenarios" role="tablist" aria-label="Route explain scenarios">
            {snapshot.scenarios.map((result) => (
              <button
                key={result.scenario.id}
                type="button"
                role="tab"
                aria-selected={result.scenario.id === snapshot.selectedScenarioId}
                data-active={result.scenario.id === snapshot.selectedScenarioId}
                onClick={() => onSelectScenario?.(result.scenario.id)}
              >
                <Route size={16} aria-hidden="true" />
                <span>{result.scenario.label}</span>
                <StatusBadge state={result.state} />
              </button>
            ))}
          </div>
          {selected ? <RouteScenarioDetails result={selected} /> : null}
        </section>
      </div>
    </section>
  )
}

function RouteScenarioDetails({ result }: { result: RoutePolicyScenarioResult }) {
  const evaluation = result.evaluation
  return (
    <article className="aui-route-explain-card" data-state={result.state}>
      <header>
        <div>
          <h3>{result.scenario.label}</h3>
          <p>{result.scenario.description}</p>
        </div>
        <div className="aui-route-explain-badges">
          <StatusBadge state={result.state} />
          {evaluation ? <PrivacyBadge privacy={evaluation.privacyClass} /> : null}
        </div>
      </header>
      {result.error ? <p className="aui-message aui-message-danger" role="alert">{result.error}</p> : null}
      {evaluation ? (
        <>
          <dl className="aui-route-policy-summary">
            <PolicyFact label="Decision" value={`${evaluation.decision}: ${evaluation.reasonCode}`} />
            <PolicyFact label="Selected provider" value={previewTarget(evaluation)} />
            <PolicyFact label="Fallback" value={evaluation.preview.fallbackBehavior} />
            <PolicyFact label="Repair path" value={evaluation.repairPath ?? 'none required'} />
            <PolicyFact label="Selector" value={evaluation.explicitSelectorRequired ? 'explicit selector required' : 'selector accepted or not required'} />
            <PolicyFact label="Audit" value={evaluation.preview.auditReceiptTarget ?? 'not reported'} />
          </dl>
          <div className="aui-route-candidates">
            {evaluation.route.candidates.map((candidate) => (
              <article key={candidate.provider_id} className="aui-route-candidate" data-selected={candidate.selected}>
                <header>
                  <strong>{candidate.provider_kind} / {candidate.provider_id}</strong>
                  <StatusBadge state={candidate.selected ? 'available-remote' : candidate.included ? 'degraded' : 'denied'} />
                </header>
                <dl className="aui-route-policy-summary">
                  <PolicyFact label="Peer" value={candidate.peer_id} />
                  <PolicyFact label="Latency" value={candidate.latency_ms === null ? 'not reported' : `${candidate.latency_ms} ms`} />
                  <PolicyFact label="Capacity" value={`${candidate.active_calls}/${candidate.max_concurrent}; ${candidate.available_capacity ?? 'unknown'} available`} />
                  <PolicyFact label="Reason" value={`${candidate.reason_code}: ${candidate.reason}`} />
                </dl>
                {candidate.blockers.length > 0 ? (
                  <ul>
                    {candidate.blockers.map((blocker) => (
                      <li key={`${candidate.provider_id}-${blocker.code}`}>{blocker.code}: {blocker.message}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : null}
    </article>
  )
}

export function routePolicyScenarios(): RoutePolicyScenario[] {
  return [
    scenario('assistant_prompt', 'Assistant prompt', 'Prompt routing must keep personal text off fallback paths unless policy allows it.', 'Orchestrator.UserInput', 'Orchestrator', 'UserInput', { text: 'summarize my calendar' }, null, 'personal', ['personal']),
    scenario('tool_call', 'Tool call', 'Duplicated local and remote tools require provider identity, safety class, and approval state.', 'Tooling.ExecuteTool', 'Tooling', 'ExecuteTool', { global_tool_id: 'mesh:workstation:shell.run', args_hash: 'sha256:redacted' }, { tool_id: 'mesh:workstation:shell.run' }, 'admin-critical', ['admin-critical']),
    scenario('rag_query', 'Remote RAG namespace', 'RAG/data queries need namespace and privacy policy status; raw cross-peer SQL remains blocked.', 'DB.RAGSearch', 'DB', 'RAGSearch', { query: 'deployment notes', namespace: 'home-lab' }, { resource_id: 'rag:home-lab' }, 'sensitive', ['sensitive']),
    scenario('audio_session', 'Remote STT session', 'Audio sessions require consent and privacy indicator status before raw audio leaves the node.', 'STT.Transcribe', 'STT', 'Transcribe', { session_id: 'audio-session-preview', sample_format: 'pcm16' }, { resource_id: 'microphone:default' }, 'raw-audio', ['raw-audio'], true, true),
    scenario('model_runtime', 'Model runtime', 'Model selection can choose local, peer, or cloud fallback only when privacy class permits it.', 'Orchestrator.GetModelRuntime', 'Orchestrator', 'GetModelRuntime', { requested_runtime: 'balanced' }, { resource_id: 'model:balanced' }, 'personal', ['personal']),
    scenario('scheduler_job', 'Scheduler delegation', 'Delegated jobs need namespace, owner, target selector, and correlation policy.', 'Scheduler.ScheduleJob', 'Scheduler', 'ScheduleJob', { namespace: 'household', owner_peer_id: 'local', target_selector: { peer_id: 'studio-peer' } }, { peer_id: 'studio-peer', resource_id: 'scheduler:household' }, 'admin-critical', ['admin-critical']),
    scenario('admin_action', 'Sensitive config change', 'Admin-critical mutations must preserve confirmation and audit receipt requirements.', 'Config.Set', 'Config', 'Set', { key_path: 'services.tts.mesh_sharing', value: { require_explicit_selector: true } }, null, 'admin-critical', ['admin-critical'])
  ]
}

export function routePolicyDraftChange(draft: RoutePolicyDraft): { key_path: string; value: JsonValue } {
  return {
    key_path: `services.${configModuleKey(draft.module)}.mesh_sharing`,
    value: {
      require_explicit_selector: draft.requireExplicitSelector,
      allowed_peers: csvList(draft.allowedPeers),
      required_capabilities: csvList(draft.requiredCapabilities) ?? [],
      min_version: draft.minimumVersion.trim() || null,
      fallback: draft.fallbackPolicy
    }
  }
}

export function routePolicyErrorMessage(error: unknown): string {
  if (!error) return 'Aurora route policy request failed.'
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message?: unknown }).message)
  return String(error)
}

function scenario(
  id: RoutePolicyScenarioId,
  label: string,
  description: string,
  topic: string,
  module: string,
  method: string,
  payload: unknown,
  selector: unknown,
  privacyClass: PrivacyClass,
  dataClasses: PrivacyClass[],
  consentGranted = false,
  privacyIndicatorShown = false,
  allowCloudFallback = false
): RoutePolicyScenario {
  return {
    id,
    label,
    description,
    request: { topic, module, method, selector, include_candidates: true },
    payload,
    selector,
    privacyClass,
    dataClasses,
    consentGranted,
    privacyIndicatorShown,
    allowCloudFallback
  }
}

function capabilityByTopic(catalog: CapabilityCatalogResponse, topic: string) {
  return catalog.actions.find((action) => action.topic === topic) ?? null
}

function capabilityAvailability(action: CapabilityCatalogResponse['actions'][number]): AvailabilityState {
  if (action.freshness.stale) return 'stale'
  if (action.policy.denial_reasons.length > 0 || action.bindability === 'denied') return 'denied'
  if (action.route_blockers.length > 0 || action.bindability === 'unavailable') return 'unsupported'
  if (action.policy.explicit_selector_required || action.policy.selector_required) return 'privacy-blocked'
  if (action.bindability === 'degraded') return 'degraded'
  return action.provider_kind === 'local' ? 'available-local' : 'available-remote'
}

function capabilityReason(action: CapabilityCatalogResponse['actions'][number]): string {
  const blockers = [...action.route_blockers, ...action.policy.denial_reasons]
  if (blockers.length > 0) return presentableSignal(blockers.join(', '))
  if (action.policy.approval_required) return `${action.topic} requires approval before mutation.`
  return `${action.topic} is ${action.bindability} via ${action.provider_kind}.`
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function settledFailure(label: string, result: PromiseSettledResult<unknown> | undefined): string | null {
  if (!result || result.status === 'fulfilled') return null
  return `${label}: ${routePolicyErrorMessage(result.reason)}`
}

function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  return result.status === 'rejected' && routePolicyErrorMessage(result.reason).toLowerCase().includes('denied')
}

function previewTarget(evaluation: RoutePolicyEvaluation): string {
  if (evaluation.preview.providerId || evaluation.preview.peerId) {
    return `${evaluation.preview.providerKind} / ${evaluation.preview.providerId ?? 'provider pending'} / ${evaluation.preview.peerId ?? 'peer pending'}`
  }
  return evaluation.route.selected_target || 'none'
}

function PolicyFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function csvList(value: string): string[] | null {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean)
  return items.length > 0 ? items : null
}

function configModuleKey(module: string): string {
  const normalized = module.toLowerCase()
  if (normalized === 'stt') return 'stt_transcription'
  if (normalized === 'modelruntime') return 'orchestrator'
  if (normalized === 'admin') return 'gateway'
  return normalized
}
