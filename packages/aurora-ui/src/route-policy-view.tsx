'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Route, Save, ShieldCheck } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityCatalogResponse,
  JsonValue,
  PrivacyClass,
  RouteExplainRequest,
  RoutePolicyEvaluation
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
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
  draft: RoutePolicyDraft
  pendingSave?: boolean
  saveError?: string | null
  onDraftChange?: (draft: RoutePolicyDraft) => void
  onSelectScenario?: (id: RoutePolicyScenarioId) => void
  onRefresh?: () => void
  onSavePolicy?: () => void
}

const defaultDraft: RoutePolicyDraft = {
  module: 'TTS',
  requireExplicitSelector: true,
  allowedPeers: '',
  deniedPeers: '',
  requiredCapabilities: 'synthesize',
  minimumVersion: '',
  trustTier: 'paired',
  fallbackPolicy: 'local',
  safetySensitiveClasses: 'admin-critical, raw-audio, credential',
  reason: 'Update mesh route fallback and explicit selector policy',
  reauthConfirmed: false
}

const loadingSnapshot: RoutePolicySnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  routeState: 'pending',
  routeReason: 'Loading route policy capability through AuroraClient.',
  policyCapabilityState: 'pending',
  policyCapabilityReason: 'Loading Gateway.ExplainRoute and capability catalog.',
  configCapabilityState: 'pending',
  configCapabilityReason: 'Loading Config.Set AdminAction capability.',
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
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function RoutePolicyResource({ client, route }: RoutePolicyResourceProps) {
  const [snapshot, setSnapshot] = useState<RoutePolicySnapshot>(loadingSnapshot)
  const [draft, setDraft] = useState<RoutePolicyDraft>(defaultDraft)
  const [selectedScenarioId, setSelectedScenarioId] = useState<RoutePolicyScenarioId>('assistant_prompt')
  const [pendingSave, setPendingSave] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [persistedReceipt, setPersistedReceipt] = useState<string | null>(null)

  const loadPolicy = useCallback(async () => {
    setSnapshot({ ...loadingSnapshot, selectedScenarioId, persistedReceipt })
    const next = await buildRoutePolicySnapshot(client, route, selectedScenarioId, persistedReceipt)
    setSnapshot(next)
  }, [client, route, selectedScenarioId, persistedReceipt])

  useEffect(() => {
    let cancelled = false
    setSnapshot({ ...loadingSnapshot, selectedScenarioId, persistedReceipt })
    void buildRoutePolicySnapshot(client, route, selectedScenarioId, persistedReceipt).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route, selectedScenarioId, persistedReceipt])

  const savePolicy = useCallback(async () => {
    if (!snapshot.canEditPolicy) return
    setPendingSave(true)
    setSaveError(null)
    try {
      const result = await client.config.applyChange({
        change: routePolicyDraftChange(draft),
        reason: draft.reason,
        reauthConfirmed: draft.reauthConfirmed
      })
      setPersistedReceipt(result.confirmation.audit_receipt)
      await loadPolicy()
    } catch (error) {
      setSaveError(routePolicyErrorMessage(error))
    } finally {
      setPendingSave(false)
    }
  }, [client.config, draft, loadPolicy, snapshot.canEditPolicy])

  return (
    <RoutePolicyView
      snapshot={snapshot}
      draft={draft}
      pendingSave={pendingSave}
      saveError={saveError}
      onDraftChange={setDraft}
      onSelectScenario={setSelectedScenarioId}
      onRefresh={loadPolicy}
      onSavePolicy={savePolicy}
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
  const [catalogResult, ...scenarioResults] = await Promise.allSettled([
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true }),
    ...scenarioDefinitions.map((scenario) => {
      const request = {
        routeRequest: scenario.request,
        payload: scenario.payload,
        selector: scenario.selector,
        privacyClass: scenario.privacyClass,
        dataClasses: scenario.dataClasses,
        auditReceiptTarget: 'Auth.StoreAuditEvent'
      }
      return client.routes.evaluatePolicy({
        ...request,
        ...(scenario.consentGranted === undefined ? {} : { consentGranted: scenario.consentGranted }),
        ...(scenario.privacyIndicatorShown === undefined ? {} : { privacyIndicatorShown: scenario.privacyIndicatorShown }),
        ...(scenario.allowCloudFallback === undefined ? {} : { allowCloudFallback: scenario.allowCloudFallback })
      })
    })
  ])
  const catalog = settledValue(catalogResult)
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
    routeReason: route.disabled ? route.explanation : 'Mesh route policy screen is backed by AuroraClient route explain and capability catalog responses.',
    policyCapabilityState: policyCapability ? capabilityAvailability(policyCapability) : allFailed ? 'unsupported' : 'degraded',
    policyCapabilityReason: policyCapability
      ? capabilityReason(policyCapability)
      : 'Gateway.ExplainRoute capability was not present in the catalog response.',
    configCapabilityState: configCapability ? capabilityAvailability(configCapability) : 'unsupported',
    configCapabilityReason: configCapability
      ? capabilityReason(configCapability)
      : 'Config.Set AdminAction capability is required before route policy edits can be saved.',
    canEditPolicy,
    scenarios,
    selectedScenarioId,
    persistedReceipt,
    error: allFailed ? 'Route explain dry-runs are unavailable through AuroraClient.' : null,
    warnings: failures,
    evidenceSource: catalog ? 'AuroraClient capability catalog and Gateway.ExplainRoute' : 'AuroraClient route explain results'
  }
}

export function RoutePolicyView({
  snapshot,
  draft,
  pendingSave = false,
  saveError = null,
  onDraftChange,
  onSelectScenario,
  onRefresh,
  onSavePolicy
}: RoutePolicyViewProps) {
  const selected = useMemo(
    () => snapshot.scenarios.find((scenario) => scenario.scenario.id === snapshot.selectedScenarioId) ?? snapshot.scenarios[0],
    [snapshot.scenarios, snapshot.selectedScenarioId]
  )
  const saveDisabled = pendingSave || !snapshot.canEditPolicy || !draft.reason.trim() || !draft.reauthConfirmed

  return (
    <section className="aui-route-policy-view" aria-labelledby="route-policy-title">
      <header className="aui-route-policy-header">
        <div>
          <p className="aui-kicker">Mesh route policy</p>
          <h1 id="route-policy-title">Route policy and explain</h1>
          <p>Dry-run backend route decisions before changing peer fallback, explicit selector, trust, and latency-sensitive policy.</p>
        </div>
        <div className="aui-mesh-badges" aria-label="Route policy evidence">
          <StatusBadge state={snapshot.loadState === 'loading' ? 'pending' : snapshot.routeState} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <EvidenceBadge label={snapshot.evidenceSource} />
        </div>
      </header>

      <dl className="aui-route-policy-summary">
        <PolicyFact label="Route policy" value={`${snapshot.policyCapabilityState}: ${snapshot.policyCapabilityReason}`} />
        <PolicyFact label="Config mutation" value={`${snapshot.configCapabilityState}: ${snapshot.configCapabilityReason}`} />
        <PolicyFact label="Selected dry-run" value={selected ? `${selected.scenario.label}: ${selected.state}` : 'not loaded'} />
        <PolicyFact label="Audit receipt" value={snapshot.persistedReceipt ?? 'not persisted in this session'} />
      </dl>

      {snapshot.error ? <p className="aui-message aui-message-danger" role="alert">{snapshot.error}</p> : null}
      {saveError ? <p className="aui-message aui-message-danger" role="alert">{saveError}</p> : null}
      {snapshot.warnings.length > 0 ? (
        <ul className="aui-mesh-warnings" aria-label="Route policy warnings">
          {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <div className="aui-route-policy-layout">
        <section className="aui-route-policy-panel" aria-labelledby="route-dry-run-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">Dry-run route explain</p>
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

        <section className="aui-route-policy-panel" aria-labelledby="route-editor-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">AdminAction editor</p>
              <h2 id="route-editor-title">Mesh sharing policy</h2>
            </div>
            <StatusBadge state={snapshot.canEditPolicy ? 'available-local' : snapshot.configCapabilityState} />
          </div>
          <RoutePolicyEditor
            draft={draft}
            disabled={!snapshot.canEditPolicy || pendingSave}
            {...(onDraftChange ? { onDraftChange } : {})}
          />
          <footer className="aui-route-policy-actions">
            <button type="button" className="aui-button" disabled={saveDisabled} onClick={onSavePolicy}>
              <Save size={16} aria-hidden="true" />
              {pendingSave ? 'Submitting AdminAction' : 'Save policy'}
            </button>
            <p role={!snapshot.canEditPolicy || saveDisabled ? 'alert' : undefined}>
              {snapshot.canEditPolicy
                ? 'Reason and re-auth confirmation are required before Config.Set is submitted.'
                : snapshot.configCapabilityReason}
            </p>
          </footer>
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

function RoutePolicyEditor({
  draft,
  disabled,
  onDraftChange
}: {
  draft: RoutePolicyDraft
  disabled: boolean
  onDraftChange?: (draft: RoutePolicyDraft) => void
}) {
  function update<K extends keyof RoutePolicyDraft>(key: K, value: RoutePolicyDraft[K]) {
    onDraftChange?.({ ...draft, [key]: value })
  }

  return (
    <div className="aui-route-policy-form">
      <label>
        <span>Service module</span>
        <select value={draft.module} disabled={disabled} onChange={(event) => update('module', event.currentTarget.value)}>
          {['TTS', 'STT', 'Tooling', 'DB', 'Orchestrator', 'Scheduler', 'ModelRuntime', 'Admin'].map((module) => (
            <option key={module} value={module}>{module}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Fallback policy</span>
        <select value={draft.fallbackPolicy} disabled={disabled} onChange={(event) => update('fallbackPolicy', event.currentTarget.value as RoutePolicyDraft['fallbackPolicy'])}>
          <option value="local">local</option>
          <option value="network">network</option>
          <option value="error">error</option>
          <option value="none">none</option>
        </select>
      </label>
      <label>
        <span>Minimum version</span>
        <input value={draft.minimumVersion} disabled={disabled} placeholder="0.1.0" onChange={(event) => update('minimumVersion', event.currentTarget.value)} />
      </label>
      <label>
        <span>Trust tier</span>
        <input value={draft.trustTier} disabled={disabled} placeholder="paired" onChange={(event) => update('trustTier', event.currentTarget.value)} />
      </label>
      <label>
        <span>Allowed peers</span>
        <input value={draft.allowedPeers} disabled={disabled} placeholder="peer-a, peer-b" onChange={(event) => update('allowedPeers', event.currentTarget.value)} />
      </label>
      <label>
        <span>Denied peers (route explain)</span>
        <input value={draft.deniedPeers} disabled={disabled} placeholder="peer-x" onChange={(event) => update('deniedPeers', event.currentTarget.value)} />
      </label>
      <label>
        <span>Required capability tags</span>
        <input value={draft.requiredCapabilities} disabled={disabled} placeholder="synthesize, low-latency" onChange={(event) => update('requiredCapabilities', event.currentTarget.value)} />
      </label>
      <label>
        <span>Safety-sensitive classes</span>
        <input value={draft.safetySensitiveClasses} disabled={disabled} placeholder="admin-critical, raw-audio" onChange={(event) => update('safetySensitiveClasses', event.currentTarget.value)} />
      </label>
      <label className="aui-inline-field">
        <input
          type="checkbox"
          checked={draft.requireExplicitSelector}
          disabled={disabled}
          onChange={(event) => update('requireExplicitSelector', event.currentTarget.checked)}
        />
        <span>Require explicit peer/provider/resource selector</span>
      </label>
      <label className="aui-inline-field">
        <input
          type="checkbox"
          checked={draft.reauthConfirmed}
          disabled={disabled}
          onChange={(event) => update('reauthConfirmed', event.currentTarget.checked)}
        />
        <span>Re-authentication confirmed for AdminAction</span>
      </label>
      <label className="aui-route-policy-reason">
        <span>AdminAction reason</span>
        <textarea value={draft.reason} disabled={disabled} rows={3} onChange={(event) => update('reason', event.currentTarget.value)} />
      </label>
    </div>
  )
}

export function routePolicyScenarios(): RoutePolicyScenario[] {
  return [
    scenario('assistant_prompt', 'Assistant prompt', 'Prompt routing must keep personal text off fallback paths unless policy allows it.', 'Orchestrator.UserInput', 'Orchestrator', 'UserInput', { text: 'summarize my calendar' }, null, 'personal', ['personal']),
    scenario('tool_call', 'Tool call', 'Duplicated local and remote tools require provider identity, safety class, and approval state.', 'Tooling.ExecuteTool', 'Tooling', 'ExecuteTool', { global_tool_id: 'mesh:workstation:shell.run', args_hash: 'sha256:redacted' }, { tool_id: 'mesh:workstation:shell.run' }, 'admin-critical', ['admin-critical']),
    scenario('rag_query', 'Remote RAG namespace', 'RAG/data queries need namespace and privacy policy evidence; raw cross-peer SQL remains blocked.', 'DB.RAGSearch', 'DB', 'RAGSearch', { query: 'deployment notes', namespace: 'home-lab' }, { resource_id: 'rag:home-lab' }, 'sensitive', ['sensitive']),
    scenario('audio_session', 'Remote STT session', 'Audio sessions require consent and privacy indicator evidence before raw audio leaves the node.', 'STT.Transcribe', 'STT', 'Transcribe', { session_id: 'audio-session-preview', sample_format: 'pcm16' }, { resource_id: 'microphone:default' }, 'raw-audio', ['raw-audio'], true, true),
    scenario('model_runtime', 'Model runtime', 'Model selection can choose local, peer, or cloud fallback only when privacy class permits it.', 'Orchestrator.GetModelRuntime', 'Orchestrator', 'GetModelRuntime', { requested_runtime: 'balanced' }, { resource_id: 'model:balanced' }, 'personal', ['personal']),
    scenario('scheduler_job', 'Scheduler delegation', 'Delegated jobs need namespace, owner, target selector, and correlation policy.', 'Scheduler.ScheduleJob', 'Scheduler', 'ScheduleJob', { namespace: 'household', owner_peer_id: 'local', target_selector: { peer_id: 'studio-peer' } }, { peer_id: 'studio-peer', resource_id: 'scheduler:household' }, 'admin-critical', ['admin-critical']),
    scenario('admin_action', 'Admin action', 'Admin-critical mutations must preserve AdminAction and audit receipt requirements.', 'Config.Set', 'Config', 'Set', { key_path: 'services.tts.mesh_sharing', value: { require_explicit_selector: true } }, null, 'admin-critical', ['admin-critical'])
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
  if (!error) return 'AuroraClient route policy request failed.'
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
  if (blockers.length > 0) return blockers.join(', ')
  if (action.policy.approval_required) return `${action.topic} requires AdminAction/approval before mutation.`
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
