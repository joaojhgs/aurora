'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, CalendarClock, Pause, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  JsonObject,
  MethodDescriptor,
  NormalizedSchedulerJob,
  PrivacyClass,
  SchedulerActionResponse,
  SchedulerScheduleJobRequest
} from '@aurora/client'
import { SCHEDULER_METHODS, routePath } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type SchedulerLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'denied'
  | 'degraded'
  | 'service-unavailable'
  | 'error'

export type SchedulerOwnershipState =
  | 'local-owned'
  | 'delegated-owned'
  | 'remote-running'
  | 'foreign-denied'

export interface SchedulerOperationControl {
  action: 'cancel' | 'pause' | 'resume'
  methodId: string
  available: boolean
  state: AvailabilityState
  requiresAdminAction: boolean
  reason: string
}

export interface SchedulerJobRow {
  id: string
  name: string
  schedule: string
  action: string
  enabled: boolean
  status: string
  namespace: string
  ownership: SchedulerOwnershipState
  ownerLabel: string
  targetLabel: string
  approvalLabel: string
  policyDecisionId: string
  auditReceipt: string
  privacyClass: string
  nextRun: string
  lastRun: string
  blockedReason: string | null
  operationControls: SchedulerOperationControl[]
}

export interface SchedulerCreateControl {
  available: boolean
  state: AvailabilityState
  reason: string
  requiresAdminAction: boolean
  targetOptions: Array<{ id: string; label: string; disabled: boolean; reason: string }>
}

export interface AdminSchedulerSnapshot {
  loadState: SchedulerLoadState
  jobs: SchedulerJobRow[]
  createControl: SchedulerCreateControl
  totals: {
    local: number
    delegatedOwned: number
    remoteRunning: number
    foreignDenied: number
  }
  warnings: string[]
  error: string | null
  evidenceSource: string
  secretsRedacted: boolean
}

export interface AdminSchedulerViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialSnapshot?: AdminSchedulerSnapshot | undefined
}

interface SchedulerOperationState {
  status: 'pending' | 'ok' | 'failed'
  message: string
  auditReceipt: string | null
}

export async function buildAdminSchedulerSnapshot(
  client: AuroraClient,
  route?: RouteAvailability
): Promise<AdminSchedulerSnapshot> {
  if (route?.disabled) {
    return {
      ...loadingSchedulerSnapshot,
      loadState: route.state === 'denied' ? 'denied' : route.state === 'degraded' ? 'degraded' : 'service-unavailable',
      error: route.blockers.join(', ') || route.explanation,
      warnings: route.blockers,
      evidenceSource: route.providerLabel
    }
  }

  const [jobsResult, methodsResult, catalogResult] = await Promise.allSettled([
    client.scheduler.listNormalizedJobs({ limit: 100 }),
    client.registry.listMethods(),
    client.capabilities.listCatalog({ include_unavailable: true })
  ])
  const jobs = valueOrNull(jobsResult) ?? []
  const methods = valueOrNull(methodsResult) ?? []
  const catalog = valueOrNull(catalogResult)
  const warnings = [
    failureMessage('scheduler jobs', jobsResult),
    failureMessage('registry methods', methodsResult),
    failureMessage('capability catalog', catalogResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [jobsResult, methodsResult, catalogResult].some(isPermissionFailure)

  if (!valueOrNull(jobsResult) && methods.length === 0) {
    return {
      ...loadingSchedulerSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      error: warnings.join(' ') || 'Scheduler jobs and registry methods are unavailable.',
      warnings,
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const rows = jobs.map((job) => jobRow(job, methods))
  const loadState: SchedulerLoadState = denied
    ? 'denied'
    : warnings.length > 0
      ? 'degraded'
      : rows.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    jobs: rows,
    createControl: createControl(methods, catalog?.local_peer_id ?? 'local-peer', catalog?.providers ?? []),
    totals: schedulerTotals(rows),
    warnings,
    error: warnings[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response',
    secretsRedacted: catalog?.secrets_redacted ?? true
  }
}

export function AdminSchedulerView({ client, route, initialSnapshot }: AdminSchedulerViewProps) {
  const [snapshot, setSnapshot] = useState<AdminSchedulerSnapshot>(initialSnapshot ?? loadingSchedulerSnapshot)
  const [operation, setOperation] = useState<SchedulerOperationState | null>(null)
  const [reason, setReason] = useState('Scheduler admin change')
  const [jobName, setJobName] = useState('new-automation')
  const [cron, setCron] = useState('0 * * * *')
  const [targetPeer, setTargetPeer] = useState('local-peer')
  const [action, setAction] = useState('Orchestrator.ExternalUserInput')

  useEffect(() => {
    let active = true
    if (initialSnapshot && initialSnapshot.loadState !== 'loading') return
    setSnapshot(loadingSchedulerSnapshot)
    buildAdminSchedulerSnapshot(client, route).then((next) => {
      if (active) setSnapshot(next)
    })
    return () => {
      active = false
    }
  }, [client, route, initialSnapshot])

  const selectedTarget = useMemo(
    () => snapshot.createControl.targetOptions.find((option) => option.id === targetPeer) ?? snapshot.createControl.targetOptions[0] ?? null,
    [snapshot.createControl.targetOptions, targetPeer]
  )
  const canCreate = snapshot.createControl.available && reason.trim().length > 0 && jobName.trim().length > 0 && cron.trim().length > 0 && operation?.status !== 'pending'

  async function runAdminAction(label: string, methodId: string, payload: JsonObject) {
    setOperation({ status: 'pending', message: `${label} pending AdminAction draft, confirmation, and audit.`, auditReceipt: null })
    try {
      const result = await client.admin.execute<SchedulerActionResponse>({
        methodId,
        payload,
        reason: reason.trim(),
        reauthConfirmed: true,
        affectedResources: ['scheduler.jobs'],
        path: pathForSchedulerMethod(methodId)
      })
      setOperation({
        status: result.data.ok ? 'ok' : 'failed',
        message: result.data.reason ?? `${label} returned ${result.data.status}.`,
        auditReceipt: result.data.audit_event ?? result.confirmation.audit_receipt
      })
      const next = await buildAdminSchedulerSnapshot(client, route)
      setSnapshot(next)
    } catch (error) {
      setOperation({ status: 'failed', message: errorMessage(error), auditReceipt: null })
    }
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canCreate || !selectedTarget) return
    const payload: SchedulerScheduleJobRequest = {
      name: jobName.trim(),
      schedule: cron.trim(),
      action: action.trim(),
      enabled: true,
      timezone: 'UTC',
      namespace: selectedTarget.id === 'local-peer' ? 'local:automation' : 'local:delegated',
      owner_peer_id: 'local-peer',
      target_selector: selectedTarget.id === 'local-peer' ? null : { peer_id: selectedTarget.id, provider: selectedTarget.label },
      delegated_permissions: action.startsWith('Tooling.') ? ['Tooling.use'] : ['Orchestrator.use'],
      policy_decision_id: selectedTarget.id === 'local-peer' ? 'policy-local-scheduler-ui' : 'policy-remote-scheduler-ui',
      caller_peer_id: 'local-peer',
      privacy_class: selectedTarget.id === 'local-peer' ? 'personal' : 'sensitive'
    }
    void runAdminAction('Schedule job', SCHEDULER_METHODS.schedule, payload as unknown as JsonObject)
  }

  return (
    <section className="aui-admin-scheduler" aria-labelledby="admin-scheduler-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-scheduler-title"><CalendarClock size={24} aria-hidden /> Scheduler jobs</h1>
          <p>
            Jobs, ownership namespaces, delegated permissions, approval policy, target peer, and audit receipts are loaded through AuroraClient.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Scheduler backend evidence">
          {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy="admin-critical" />
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        </div>
      </header>

      <SchedulerStatusPanel snapshot={snapshot} route={route} operation={operation} />

      <div className="aui-admin-metrics" aria-label="Scheduler job ownership summary">
        <Metric label="Local" value={String(snapshot.totals.local)} detail="owned and running on this node" />
        <Metric label="Delegated" value={String(snapshot.totals.delegatedOwned)} detail="owned here, target remote" />
        <Metric label="Remote running" value={String(snapshot.totals.remoteRunning)} detail="foreign owner visible to this node" />
        <Metric label="Denied" value={String(snapshot.totals.foreignDenied)} detail="foreign namespace blocked" />
      </div>

      <div className="aui-admin-grid">
        <section className="aui-admin-panel" aria-labelledby="scheduler-create-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">Create</p>
              <h2 id="scheduler-create-title">Schedule automation</h2>
            </div>
            <ShieldCheck size={18} aria-hidden />
          </div>
          <form className="aui-scheduler-form" onSubmit={submitCreate}>
            <label htmlFor="scheduler-job-name">Job name</label>
            <input id="scheduler-job-name" value={jobName} onChange={(event) => setJobName(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            <label htmlFor="scheduler-cron">Schedule</label>
            <input id="scheduler-cron" value={cron} onChange={(event) => setCron(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            <label htmlFor="scheduler-action">Action</label>
            <select id="scheduler-action" value={action} onChange={(event) => setAction(event.currentTarget.value)} disabled={!snapshot.createControl.available}>
              <option value="Orchestrator.ExternalUserInput">Orchestrator.ExternalUserInput</option>
              <option value="Tooling.ExecuteTool">Tooling.ExecuteTool</option>
            </select>
            <label htmlFor="scheduler-target">Target peer/provider</label>
            <select id="scheduler-target" value={targetPeer} onChange={(event) => setTargetPeer(event.currentTarget.value)} disabled={!snapshot.createControl.available}>
              {snapshot.createControl.targetOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="scheduler-reason">AdminAction reason</label>
            <textarea id="scheduler-reason" value={reason} rows={3} onChange={(event) => setReason(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            <button type="submit" disabled={!canCreate}><Plus size={16} aria-hidden />Create via AdminAction</button>
          </form>
          <p className="aui-muted">{snapshot.createControl.reason}</p>
        </section>

        <section className="aui-admin-panel" aria-labelledby="scheduler-policy-title">
          <div className="aui-panel-heading">
            <div>
              <p className="aui-kicker">Policy</p>
              <h2 id="scheduler-policy-title">Delegation context</h2>
            </div>
            <AlertTriangle size={18} aria-hidden />
          </div>
          <dl className="aui-scheduler-facts">
            <div><dt>Route</dt><dd>{route.explanation}</dd></div>
            <div><dt>AdminAction</dt><dd>{route.requiresAdminAction ? 'required for schedule, cancel, pause, and resume' : 'not required by route metadata'}</dd></div>
            <div><dt>Target selector</dt><dd>{selectedTarget ? selectedTarget.reason : 'no selector evidence'}</dd></div>
            <div><dt>Blockers</dt><dd>{route.blockers.join(', ') || snapshot.error || 'none'}</dd></div>
          </dl>
        </section>
      </div>

      <section className="aui-admin-panel" aria-labelledby="scheduler-jobs-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Jobs</p>
            <h2 id="scheduler-jobs-title">Ownership-scoped job table</h2>
          </div>
          <CalendarClock size={18} aria-hidden />
        </div>
        <SchedulerJobsTable jobs={snapshot.jobs} onRun={runAdminAction} pending={operation?.status === 'pending'} />
      </section>
    </section>
  )
}

function SchedulerStatusPanel({
  snapshot,
  route,
  operation
}: {
  snapshot: AdminSchedulerSnapshot
  route: RouteAvailability
  operation: SchedulerOperationState | null
}) {
  if (snapshot.loadState === 'loading') return <div className="aui-admin-notice" aria-live="polite"><CalendarClock size={18} aria-hidden />Loading scheduler jobs through AuroraClient.</div>
  if (route.disabled) return <div className="aui-admin-notice aui-admin-notice-warning" role="alert"><AlertTriangle size={18} aria-hidden />{route.blockers.join(', ') || route.explanation}</div>
  if (snapshot.loadState === 'empty') return <div className="aui-admin-notice" role="status"><CalendarClock size={18} aria-hidden />No scheduler jobs were returned for this namespace.</div>
  if (snapshot.error) return <div className="aui-admin-notice aui-admin-notice-warning" role="alert"><AlertTriangle size={18} aria-hidden />{snapshot.error}</div>
  if (operation) {
    return (
      <div className={operation.status === 'failed' ? 'aui-admin-notice aui-admin-notice-warning' : 'aui-admin-notice'} role={operation.status === 'failed' ? 'alert' : 'status'}>
        <ShieldCheck size={18} aria-hidden />
        <span>{operation.message}</span>
        {operation.auditReceipt ? <code>{operation.auditReceipt}</code> : null}
      </div>
    )
  }
  return null
}

function SchedulerJobsTable({
  jobs,
  onRun,
  pending
}: {
  jobs: SchedulerJobRow[]
  onRun: (label: string, methodId: string, payload: JsonObject) => Promise<void>
  pending: boolean
}) {
  if (jobs.length === 0) return <p className="aui-muted">No scheduler jobs available.</p>
  return (
    <div className="aui-table-scroll">
      <table className="aui-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Ownership</th>
            <th>Target and approval</th>
            <th>Runs</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <details className="aui-service-details">
                  <summary><strong>{job.name}</strong><small>{job.action}</small></summary>
                  <div className="aui-service-drawer">
                    <dl>
                      <div><dt>Job ID</dt><dd>{job.id}</dd></div>
                      <div><dt>Namespace</dt><dd>{job.namespace}</dd></div>
                      <div><dt>Policy decision</dt><dd>{job.policyDecisionId}</dd></div>
                      <div><dt>Audit</dt><dd>{job.auditReceipt}</dd></div>
                      <div><dt>Blocker</dt><dd>{job.blockedReason ?? 'none'}</dd></div>
                    </dl>
                  </div>
                </details>
                <div className="aui-state-line"><StatusBadge state={stateForJob(job)} /><PrivacyBadge privacy={privacyForJob(job)} /></div>
              </td>
              <td><strong>{ownershipLabel(job.ownership)}</strong><small>{job.ownerLabel}</small></td>
              <td><span>{job.targetLabel}</span><small>{job.approvalLabel}</small></td>
              <td><code>{job.schedule}</code><small>next {job.nextRun}; last {job.lastRun}</small></td>
              <td>
                <div className="aui-tool-actions">
                  {job.operationControls.map((control) => (
                    <button
                      key={control.action}
                      type="button"
                      className="aui-secondary-action"
                      disabled={pending || !control.available}
                      title={control.reason}
                      onClick={() => void onRun(
                        `${control.action} ${job.name}`,
                        control.methodId,
                        { job_id: job.id, namespace: job.namespace, owner_peer_id: ownerPeerFromLabel(job.ownerLabel), caller_peer_id: 'local-peer' }
                      )}
                    >
                      {control.action === 'cancel' ? <Trash2 size={15} aria-hidden /> : control.action === 'pause' ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
                      {control.action}
                    </button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function jobRow(job: NormalizedSchedulerJob, methods: MethodDescriptor[]): SchedulerJobRow {
  const ownership = ownershipForJob(job)
  return {
    id: job.job_id,
    name: job.name,
    schedule: job.schedule,
    action: job.action,
    enabled: job.enabled,
    status: job.status ?? (job.enabled ? 'active' : 'disabled'),
    namespace: job.namespace,
    ownership,
    ownerLabel: `${job.owner_peer_id}/${job.owner_principal_id}`,
    targetLabel: job.target_peer_id ? `${job.target_peer_id}${job.target_resource_namespace ? ` / ${job.target_resource_namespace}` : ''}` : 'local node',
    approvalLabel: approvalLabel(job),
    policyDecisionId: job.policy_decision_id ?? 'not reported',
    auditReceipt: job.correlation_id ?? 'audit pending',
    privacyClass: job.privacy_class,
    nextRun: job.next_run ?? 'not scheduled',
    lastRun: job.last_run ?? 'never',
    blockedReason: job.blocked_reason ?? job.last_error,
    operationControls: operationControls(job, methods)
  }
}

function operationControls(job: NormalizedSchedulerJob, methods: MethodDescriptor[]): SchedulerOperationControl[] {
  return [
    operationControl('cancel', SCHEDULER_METHODS.cancel, job, methods),
    operationControl('pause', SCHEDULER_METHODS.pause, job, methods),
    operationControl('resume', SCHEDULER_METHODS.resume, job, methods)
  ]
}

function operationControl(
  action: 'cancel' | 'pause' | 'resume',
  methodId: string,
  job: NormalizedSchedulerJob,
  methods: MethodDescriptor[]
): SchedulerOperationControl {
  const method = methods.find((candidate) => candidate.busTopic === methodId)
  const support = job.actions[action]
  const methodSupported = Boolean(method?.availableOverHttp && (method.methodType === 'manage' || method.methodType === 'admin-critical'))
  const supportAvailable = Boolean(support && !support.disabled)
  const available = methodSupported && supportAvailable
  const reason = !method
    ? `${methodId} is not advertised by Gateway registry.`
    : !method.availableOverHttp
      ? `${methodId} is internal-only and disabled for the UI.`
      : !methodSupported
        ? `${methodId} is not marked manage/admin-critical.`
        : support?.reason ?? (available ? 'Available through AdminAction draft/confirm/audit.' : `${action} is unsupported for this job.`)
  return {
    action,
    methodId,
    available,
    state: available ? stateForRawJob(job) : support?.status === 'denied' ? 'denied' : 'unsupported',
    requiresAdminAction: true,
    reason
  }
}

function createControl(
  methods: MethodDescriptor[],
  localPeerId: string,
  providers: Array<{ peer_id: string; node_name: string; eligible: boolean; reason: string; module: string }>
): SchedulerCreateControl {
  const method = methods.find((candidate) => candidate.busTopic === SCHEDULER_METHODS.schedule)
  const available = Boolean(method?.availableOverHttp && (method.methodType === 'manage' || method.methodType === 'admin-critical'))
  const schedulerProviders = providers.filter((provider) => provider.module === 'Scheduler')
  const targetOptions = schedulerProviders.length > 0
    ? schedulerProviders.map((provider) => ({
      id: provider.peer_id,
      label: provider.peer_id === localPeerId ? 'Local scheduler' : `${provider.node_name} (${provider.peer_id})`,
      disabled: !provider.eligible,
      reason: provider.reason
    }))
    : [{ id: localPeerId, label: 'Local scheduler', disabled: !available, reason: 'No Scheduler provider was returned by capability catalog.' }]
  return {
    available,
    state: available ? 'available-local' : 'unsupported',
    requiresAdminAction: true,
    reason: available
      ? 'Create/edit uses AdminAction; remote execution requires target selector, delegated permissions, policy decision, and audit correlation.'
      : `${SCHEDULER_METHODS.schedule} is not advertised as an external manage/admin-critical method.`,
    targetOptions
  }
}

function ownershipForJob(job: NormalizedSchedulerJob): SchedulerOwnershipState {
  if (job.blocked_reason || job.status === 'denied') return 'foreign-denied'
  if (job.owner_peer_id !== 'local-peer') return 'remote-running'
  if (job.target_peer_id && job.target_peer_id !== 'local-peer') return 'delegated-owned'
  return 'local-owned'
}

function ownershipLabel(state: SchedulerOwnershipState): string {
  if (state === 'local-owned') return 'Local job'
  if (state === 'delegated-owned') return 'Delegated by this node'
  if (state === 'remote-running') return 'Running on remote peer'
  return 'Denied foreign namespace'
}

function approvalLabel(job: NormalizedSchedulerJob): string {
  const token = job.delegated_approval_token_present ? 'approval token present' : 'next approval required'
  const permissions = job.delegated_permissions.length > 0 ? job.delegated_permissions.join(', ') : 'no delegated permissions'
  return `${token}; ${permissions}; policy ${job.policy_decision_id ?? 'not reported'}`
}

function schedulerTotals(rows: SchedulerJobRow[]) {
  return {
    local: rows.filter((row) => row.ownership === 'local-owned').length,
    delegatedOwned: rows.filter((row) => row.ownership === 'delegated-owned').length,
    remoteRunning: rows.filter((row) => row.ownership === 'remote-running').length,
    foreignDenied: rows.filter((row) => row.ownership === 'foreign-denied').length
  }
}

function stateForJob(job: Pick<SchedulerJobRow, 'ownership' | 'enabled'>): AvailabilityState {
  if (job.ownership === 'foreign-denied') return 'denied'
  if (job.ownership === 'remote-running') return 'available-remote'
  if (job.ownership === 'delegated-owned') return 'degraded'
  return job.enabled ? 'available-local' : 'pending'
}

function stateForRawJob(job: NormalizedSchedulerJob): AvailabilityState {
  return stateForJob({
    ownership: ownershipForJob(job),
    enabled: job.enabled
  })
}

function privacyForJob(job: Pick<SchedulerJobRow, 'privacyClass'>): PrivacyClass {
  const value = job.privacyClass
  if (value === 'public' || value === 'personal' || value === 'sensitive' || value === 'secret' || value === 'raw-audio' || value === 'credential' || value === 'admin-critical') return value
  return 'admin-critical'
}

function pathForSchedulerMethod(methodId: string): string {
  const [, method] = methodId.split('.')
  return routePath('Scheduler', method ?? 'ListJobs')
}

function ownerPeerFromLabel(label: string): string {
  return label.split('/')[0] || 'local-peer'
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null
  return `${label}: ${errorMessage(result.reason)}`
}

function isPermissionFailure(result: PromiseSettledResult<unknown>): boolean {
  return result.status === 'rejected' && typeof result.reason === 'object' && result.reason !== null && 'code' in result.reason && (result.reason as { code?: unknown }).code === 'permission'
}

function isAvailabilityState(value: string): value is AvailabilityState {
  return [
    'available-local',
    'available-remote',
    'pending',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="aui-admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

const loadingSchedulerSnapshot: AdminSchedulerSnapshot = {
  loadState: 'loading',
  jobs: [],
  createControl: {
    available: false,
    state: 'unsupported',
    reason: 'pending AuroraClient SDK calls',
    requiresAdminAction: true,
    targetOptions: []
  },
  totals: {
    local: 0,
    delegatedOwned: 0,
    remoteRunning: 0,
    foreignDenied: 0
  },
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls',
  secretsRedacted: true
}
