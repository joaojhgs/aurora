'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, CalendarClock, Edit3, Pause, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  JsonObject,
  MethodDescriptor,
  NormalizedSchedulerJob,
  PrivacyClass,
  SchedulerActionResponse,
  SchedulerScheduleActionRequest,
  ToolApprovalCardModel
} from '@aurora/client'
import { SCHEDULER_METHODS, routePath } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge, ToneBadge, presentableSignal, type BadgeTone } from './status-badges'
import { adminActionLabel, adminErrorTitle, adminModuleLabel, adminReasonText, adminRouteCopy, sanitizeAdminText } from './admin-product-copy'
import {
  BadgeCluster,
  Button,
  Card,
  DataTable,
  DetailSheet,
  MetaGrid,
  StatStrip,
  type DataColumn
} from './primitives'

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
  action: 'edit' | 'cancel' | 'pause' | 'resume'
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
  runHistory: string
  toolIntegration: string
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

export interface SchedulerToolCreateOption {
  id: string
  label: string
  localName: string
  globalToolId: string
  providerPeerId: string | null
  serviceInstanceId: string | null
  disabled: boolean
  reason: string
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
  toolOptions: SchedulerToolCreateOption[]
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

type SchedulerActionKind = 'orchestrator.user_input' | 'tooling.execute'

export async function buildAdminSchedulerSnapshot(
  client: AuroraClient,
  route?: RouteAvailability
): Promise<AdminSchedulerSnapshot> {
  if (route?.disabled) {
    return {
      ...loadingSchedulerSnapshot,
      loadState: route.state === 'denied' ? 'denied' : route.state === 'degraded' ? 'degraded' : 'service-unavailable',
      error: adminRouteCopy(route),
      warnings: route.blockers.map((blocker) => adminReasonText(blocker)),
      evidenceSource: route.providerLabel,
      toolOptions: []
    }
  }

  const [jobsResult, methodsResult, catalogResult, toolsResult] = await Promise.allSettled([
    client.scheduler.listNormalizedJobs({ limit: 100 }),
    client.registry.listMethods(),
    client.capabilities.listCatalog({ include_unavailable: true }),
    client.tools.listApprovalCards({ include_unavailable: true, top_k: 1000 })
  ])
  const jobs = valueOrNull(jobsResult) ?? []
  const methods = valueOrNull(methodsResult) ?? []
  const catalog = valueOrNull(catalogResult)
  const toolCards = valueOrNull(toolsResult) ?? []
  const warnings = [
    failureMessage('scheduler jobs', jobsResult),
    failureMessage('available actions', methodsResult),
    failureMessage('capability catalog', catalogResult),
    failureMessage('tool catalog', toolsResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [jobsResult, methodsResult, catalogResult].some(isPermissionFailure)

  if (!valueOrNull(jobsResult) && methods.length === 0) {
    return {
      ...loadingSchedulerSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      error: warnings.join(' ') || 'Scheduler jobs and actions are unavailable.',
      warnings,
      evidenceSource: 'Aurora request error',
      toolOptions: []
    }
  }

  const rows = jobs.map((job) => jobRow(job, methods))
  const permissionWarnings = schedulerPermissionWarnings(methods)
  const loadState: SchedulerLoadState = denied
    ? 'denied'
    : warnings.length + permissionWarnings.length > 0
      ? 'degraded'
      : rows.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    jobs: rows,
    createControl: createControl(methods, catalog?.local_peer_id ?? 'local-peer', catalog?.providers ?? []),
    totals: schedulerTotals(rows),
    warnings: [...warnings, ...permissionWarnings],
    error: warnings[0] ?? permissionWarnings[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local preview' : 'Aurora service response',
    secretsRedacted: catalog?.secrets_redacted ?? true,
    toolOptions: schedulerToolOptions(toolCards)
  }
}

export function AdminSchedulerView({ client, route, initialSnapshot }: AdminSchedulerViewProps) {
  const [snapshot, setSnapshot] = useState<AdminSchedulerSnapshot>(initialSnapshot ?? loadingSchedulerSnapshot)
  const [operation, setOperation] = useState<SchedulerOperationState | null>(null)
  const [reason, setReason] = useState('Scheduler admin change')
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [jobName, setJobName] = useState('new-automation')
  const [cron, setCron] = useState('0 * * * *')
  const [targetPeer, setTargetPeer] = useState('local-peer')
  const [actionKind, setActionKind] = useState<SchedulerActionKind>('orchestrator.user_input')
  const [orchestratorText, setOrchestratorText] = useState('Run the scheduled assistant automation.')
  const [selectedToolId, setSelectedToolId] = useState('')
  const [toolArguments, setToolArguments] = useState('{}')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

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
  const selectedTool = useMemo(
    () => snapshot.toolOptions.find((option) => option.id === selectedToolId) ?? snapshot.toolOptions[0] ?? null,
    [snapshot.toolOptions, selectedToolId]
  )
  const canCreate = snapshot.createControl.available
    && reauthConfirmed
    && reason.trim().length > 0
    && jobName.trim().length > 0
    && cron.trim().length > 0
    && (actionKind !== 'tooling.execute' || Boolean(selectedTool))
    && operation?.status !== 'pending'

  async function runAdminAction(label: string, methodId: string, payload: JsonObject) {
    if (!reauthConfirmed) {
      setOperation({ status: 'failed', message: `${label} requires your recent admin unlock before submit.`, auditReceipt: null })
      return
    }
    setOperation({ status: 'pending', message: `${label} is pending admin confirmation and audit logging.`, auditReceipt: null })
    try {
      const result = await client.admin.execute<SchedulerActionResponse>({
        methodId,
        payload,
        reason: reason.trim(),
        reauthConfirmed,
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
    const actionSpec = buildScheduleActionSpec({
      actionKind,
      orchestratorText,
      selectedTool,
      toolArguments,
      targetPeer: selectedTarget.id,
      targetLabel: selectedTarget.label
    })
    if (!actionSpec) {
      setOperation({ status: 'failed', message: 'Select a tool and provide valid JSON arguments before scheduling the action.', auditReceipt: null })
      return
    }
    const payload: SchedulerScheduleActionRequest = {
      name: jobName.trim(),
      schedule: cron.trim(),
      action_spec: actionSpec,
      enabled: true,
      timezone: 'UTC',
      namespace: selectedTarget.id === 'local-peer' ? 'local:automation' : 'local:delegated',
      owner_peer_id: 'local-peer',
      target_selector: selectedTarget.id === 'local-peer' ? null : { peer_id: selectedTarget.id, provider: selectedTarget.label },
      delegated_permissions: actionKind === 'tooling.execute' ? ['Tooling.use'] : ['Orchestrator.use'],
      caller_peer_id: 'local-peer',
      privacy_class: selectedTarget.id === 'local-peer' ? 'personal' : 'sensitive'
    }
    void runAdminAction('Schedule typed action', SCHEDULER_METHODS.scheduleAction, payload as unknown as JsonObject)
  }

  const selectedJob = useMemo(
    () => snapshot.jobs.find((job) => job.id === selectedJobId) ?? null,
    [snapshot.jobs, selectedJobId]
  )

  return (
    <div className="flex flex-col gap-5" aria-labelledby="admin-scheduler-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 py-5">
        <div>
          <h1 id="admin-scheduler-title" className="text-xl font-semibold tracking-tight">Scheduler</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Recurring jobs and automations running on this node.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 px-6 pb-6">
      <SchedulerStatusPanel snapshot={snapshot} route={route} operation={operation} />

      <Card title="Ownership-scoped job table" icon={<CalendarClock size={18} aria-hidden />} ariaLabel="Jobs" flush>
        <SchedulerJobsTable
          jobs={snapshot.jobs}
          onRun={runAdminAction}
          pending={operation?.status === 'pending'}
          reauthConfirmed={reauthConfirmed}
          onSelect={setSelectedJobId}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="New job" icon={<ShieldCheck size={18} aria-hidden />} ariaLabel="Schedule automation">
          <p className="text-sm text-muted-foreground">{snapshot.createControl.reason}</p>
          <form className="flex flex-col gap-3" onSubmit={submitCreate}>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-job-name">Job name</label>
              <input id="scheduler-job-name" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={jobName} onChange={(event) => setJobName(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-cron">Schedule</label>
              <input id="scheduler-cron" className="rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm" value={cron} onChange={(event) => setCron(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-action">Action</label>
                <select id="scheduler-action" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={actionKind} onChange={(event) => setActionKind(event.currentTarget.value as 'orchestrator.user_input' | 'tooling.execute')} disabled={!snapshot.createControl.available}>
                  <option value="orchestrator.user_input">Assistant prompt</option>
                  <option value="tooling.execute">Tool action</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-target">Target device</label>
                <select id="scheduler-target" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={targetPeer} onChange={(event) => setTargetPeer(event.currentTarget.value)} disabled={!snapshot.createControl.available}>
                  {snapshot.createControl.targetOptions.map((option) => (
                    <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>
                  ))}
                </select>
              </div>
            {actionKind === 'orchestrator.user_input' ? (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-prompt">Assistant prompt</label>
                <textarea id="scheduler-prompt" className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={orchestratorText} rows={3} onChange={(event) => setOrchestratorText(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:col-span-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-tool">Tool</label>
                  <select id="scheduler-tool" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={selectedTool?.id ?? ''} onChange={(event) => setSelectedToolId(event.currentTarget.value)} disabled={!snapshot.createControl.available || snapshot.toolOptions.length === 0}>
                    {snapshot.toolOptions.map((tool) => (
                      <option key={tool.id} value={tool.id} disabled={tool.disabled}>{tool.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-tool-args">Tool arguments JSON</label>
                  <textarea id="scheduler-tool-args" className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm" value={toolArguments} rows={4} onChange={(event) => setToolArguments(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
                </div>
              </div>
            )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="scheduler-reason">Reason</label>
              <textarea id="scheduler-reason" className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm" value={reason} rows={3} onChange={(event) => setReason(event.currentTarget.value)} disabled={!snapshot.createControl.available} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reauthConfirmed}
                disabled={!snapshot.createControl.available}
                onChange={(event) => setReauthConfirmed(event.currentTarget.checked)}
              />
              <span>I confirm my recent admin unlock for scheduler changes</span>
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" icon={<Plus size={16} aria-hidden />} disabled={!canCreate} disabledReason={snapshot.createControl.reason}>
                Create schedule
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Delegation context" icon={<AlertTriangle size={18} aria-hidden />} ariaLabel="Delegation context">
          <MetaGrid
            columns={1}
            items={[
              { label: 'Connection', value: adminRouteCopy(route) },
              { label: 'Admin approval', value: route.requiresAdminAction ? 'required for schedule, cancel, pause, and resume' : 'not required' },
              { label: 'Target selector', value: selectedTarget ? adminReasonText(selectedTarget.reason, 'Ready') : 'no selector status' },
              { label: 'Blockers', value: adminReasonText(route.blockers.join(', ') || snapshot.error || 'none', 'none') }
            ]}
          />
        </Card>
      </div>
      </div>

      <DetailSheet
        open={Boolean(selectedJob)}
        onClose={() => setSelectedJobId(null)}
        title={selectedJob ? sanitizeAdminText(selectedJob.name) : 'Scheduler job'}
        description={selectedJob ? adminActionLabel(selectedJob.action) : undefined}
        badge={selectedJob ? <StatusBadge state={stateForJob(selectedJob)} /> : undefined}
      >
        {selectedJob ? (
          <MetaGrid
            columns={1}
            items={[
              { label: 'Job', value: sanitizeAdminText(selectedJob.id) },
              { label: 'Area', value: sanitizeAdminText(selectedJob.namespace) },
              { label: 'Ownership', value: ownershipLabel(selectedJob.ownership) },
              { label: 'Target and approval', value: `${selectedJob.targetLabel}; ${selectedJob.approvalLabel}` },
              { label: 'Approval record', value: sanitizeAdminText(selectedJob.policyDecisionId) },
              { label: 'Support reference', value: selectedJob.auditReceipt, mono: true },
              { label: 'Tool integration', value: selectedJob.toolIntegration },
              { label: 'Run history', value: selectedJob.runHistory },
              { label: 'Blocker', value: adminReasonText(selectedJob.blockedReason, 'none') }
            ]}
          />
        ) : null}
      </DetailSheet>
    </div>
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
  const noticeClass = 'flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground'
  const warningClass = 'flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning'
  if (snapshot.loadState === 'loading') return <div className={noticeClass} aria-live="polite"><CalendarClock size={16} aria-hidden />Loading scheduler jobs through Aurora.</div>
  if (route.disabled) return <div className={warningClass} role="alert"><AlertTriangle size={16} aria-hidden />{adminRouteCopy(route)}</div>
  if (snapshot.loadState === 'empty') return <div className={noticeClass} role="status"><CalendarClock size={16} aria-hidden />No scheduler jobs were returned for this namespace.</div>
  if (snapshot.error) return <div className={warningClass} role="alert"><AlertTriangle size={16} aria-hidden />{snapshot.error}</div>
  if (operation) {
    return (
      <div className={operation.status === 'failed' ? warningClass : noticeClass} role={operation.status === 'failed' ? 'alert' : 'status'}>
        <ShieldCheck size={16} aria-hidden />
        <span>{operation.message}</span>
        {operation.auditReceipt ? <code className="font-mono text-xs">{operation.auditReceipt}</code> : null}
      </div>
    )
  }
  return null
}

function SchedulerJobsTable({
  jobs,
  onRun,
  pending,
  reauthConfirmed,
  onSelect
}: {
  jobs: SchedulerJobRow[]
  onRun: (label: string, methodId: string, payload: JsonObject) => Promise<void>
  pending: boolean
  reauthConfirmed: boolean
  onSelect: (id: string) => void
}) {
  const columns: Array<DataColumn<SchedulerJobRow>> = [
    {
      key: 'job',
      header: 'Job',
      render: (job) => (
        <span className="flex flex-col gap-0.5">
          <strong>{job.name}</strong>
          <small className="text-muted-foreground">{job.toolIntegration}</small>
        </span>
      )
    },
    { key: 'schedule', header: 'Schedule', hideAt: 'md', render: (job) => <span className="font-mono text-xs">{job.schedule}</span> },
    {
      key: 'ownership',
      header: 'Ownership',
      hideAt: 'lg',
      render: (job) => (
        <span className="flex flex-col gap-0.5">
          <strong>{ownershipLabel(job.ownership)}</strong>
          <small className="text-muted-foreground">{job.ownerLabel}</small>
        </span>
      )
    },
    {
      key: 'approval',
      header: 'Target and approval',
      hideAt: 'lg',
      render: (job) => (
        <span className="flex flex-col gap-0.5">
          <span>{job.targetLabel}</span>
          <small className="text-muted-foreground">{job.approvalLabel}</small>
        </span>
      )
    },
    {
      key: 'runs',
      header: 'Status and next run',
      render: (job) => (
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5"><StatusBadge state={stateForJob(job)} /><PrivacyBadge privacy={privacyForJob(job)} /></span>
          <small className="text-muted-foreground">next {job.nextRun}; {job.runHistory}</small>
        </span>
      )
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      render: (job) => {
        const toggle = job.operationControls.find((control) => control.action === (job.enabled ? 'pause' : 'resume'))
        const secondary = job.operationControls.filter((control) => control.action === 'edit' || control.action === 'cancel')
        return (
          <div className="flex items-center justify-end gap-1.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            {toggle ? (
              <Button
                variant="outline"
                disabled={pending || !reauthConfirmed || !toggle.available}
                disabledReason={toggle.reason}
                icon={toggle.action === 'pause' ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                onClick={() => void onRun(
                  `${toggle.action} ${job.name}`,
                  toggle.methodId,
                  { job_id: job.id, namespace: job.namespace, owner_peer_id: ownerPeerFromLabel(job.ownerLabel), caller_peer_id: 'local-peer' }
                )}
              >
                {toggle.action === 'pause' ? 'Pause' : 'Resume'}
              </Button>
            ) : null}
            {secondary.map((control) => (
              <Button
                key={control.action}
                variant={control.action === 'cancel' ? 'danger' : 'ghost'}
                icon={control.action === 'edit' ? <Edit3 size={15} aria-hidden /> : <Trash2 size={15} aria-hidden />}
                disabled={pending || !reauthConfirmed || !control.available}
                disabledReason={control.reason}
                onClick={() => void onRun(
                  `${control.action} ${job.name}`,
                  control.methodId,
                  { job_id: job.id, namespace: job.namespace, owner_peer_id: ownerPeerFromLabel(job.ownerLabel), caller_peer_id: 'local-peer' }
                )}
              >
                {control.action}
              </Button>
            ))}
          </div>
        )
      }
    }
  ]
  return (
    <DataTable
      columns={columns}
      rows={jobs}
      getRowKey={(job) => job.id}
      onRowClick={(job) => onSelect(job.id)}
      empty={<p className="text-sm text-muted-foreground">No scheduler jobs available.</p>}
    />
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
    runHistory: runHistoryLabel(job),
    toolIntegration: toolIntegrationLabel(job),
    blockedReason: job.blocked_reason ?? job.last_error,
    operationControls: operationControls(job, methods)
  }
}

function operationControls(job: NormalizedSchedulerJob, methods: MethodDescriptor[]): SchedulerOperationControl[] {
  return [
    editOperationControl(methods),
    operationControl('cancel', SCHEDULER_METHODS.cancel, job, methods),
    operationControl('pause', SCHEDULER_METHODS.pause, job, methods),
    operationControl('resume', SCHEDULER_METHODS.resume, job, methods)
  ]
}

const SCHEDULER_EDIT_METHOD_CANDIDATES = ['Scheduler.Update', 'Scheduler.Edit'] as const

function editOperationControl(methods: MethodDescriptor[]): SchedulerOperationControl {
  const method = methods.find((candidate) => SCHEDULER_EDIT_METHOD_CANDIDATES.includes(candidate.busTopic as typeof SCHEDULER_EDIT_METHOD_CANDIDATES[number]))
  const methodId = method?.busTopic ?? SCHEDULER_EDIT_METHOD_CANDIDATES[0]
  const baseSupport = methodSupport(method)
  return {
    action: 'edit',
    methodId,
    available: false,
    state: baseSupport.state,
    requiresAdminAction: true,
    reason: method
      ? 'Editing is listed, but it is not ready in this version.'
      : 'Editing is not ready in this version.'
  }
}

function operationControl(
  action: 'cancel' | 'pause' | 'resume',
  methodId: string,
  job: NormalizedSchedulerJob,
  methods: MethodDescriptor[]
): SchedulerOperationControl {
  const method = methods.find((candidate) => candidate.busTopic === methodId)
  const support = job.actions[action]
  const methodSupportState = methodSupport(method)
  const methodSupported = methodSupportState.ok
  const supportAvailable = Boolean(support && !support.disabled)
  const available = methodSupported && supportAvailable
  const reason = !method
    ? schedulerActionUnavailableReason(action)
    : !method.availableOverHttp
      ? 'This action is only available inside Aurora.'
      : !hasSchedulerManagePermission(method)
        ? 'Permission is needed to use this feature.'
        : !methodSupported
        ? 'This action is not ready for admin changes.'
        : adminReasonText(support?.reason, available ? 'Available after admin confirmation.' : schedulerActionUnavailableReason(action))
  return {
    action,
    methodId,
    available,
    state: available ? stateForRawJob(job) : support?.status === 'denied' ? 'denied' : methodSupportState.state,
    requiresAdminAction: true,
    reason
  }
}

function schedulerActionUnavailableReason(action: 'cancel' | 'pause' | 'resume'): string {
  if (action === 'cancel') return 'Cancel is not ready for this job.'
  if (action === 'pause') return 'Pause is not ready for this job.'
  return 'Resume is not ready for this job.'
}

function createControl(
  methods: MethodDescriptor[],
  localPeerId: string,
  providers: Array<{ peer_id: string | null; node_name: string; eligible: boolean; reason: string; module: string }>
): SchedulerCreateControl {
  const method = methods.find((candidate) => candidate.busTopic === SCHEDULER_METHODS.scheduleAction)
  const support = methodSupport(method)
  const available = support.ok
  const schedulerProviders = providers.filter((provider) => provider.module === 'Scheduler')
  const targetOptions = schedulerProviders.length > 0
    ? schedulerProviders.map((provider) => {
      const peerId = provider.peer_id ?? localPeerId
      return {
        id: peerId,
        label: peerId === localPeerId ? 'Local scheduler' : sanitizeAdminText(provider.node_name || 'Connected scheduler'),
        disabled: !provider.eligible,
        reason: adminReasonText(provider.reason, 'Ready')
      }
    })
    : [{ id: localPeerId, label: 'Local scheduler', disabled: !available, reason: 'No scheduler target was returned by Aurora.' }]
  return {
    available,
    state: available ? 'available-local' : support.state,
    requiresAdminAction: true,
    reason: available
      ? 'Create and edit require admin confirmation, a selected target, approved permissions, and audit logging.'
      : support.reason ?? 'Schedule creation is not ready in this version.',
    targetOptions
  }
}

function methodSupport(method: MethodDescriptor | undefined): { ok: boolean; state: AvailabilityState; reason: string | null } {
  if (!method) return { ok: false, state: 'unsupported', reason: null }
  if (!method.availableOverHttp) return { ok: false, state: 'unsupported', reason: 'This action is only available inside Aurora.' }
  if (!hasSchedulerManagePermission(method)) {
    return { ok: false, state: 'denied', reason: 'Permission is needed to use this feature.' }
  }
  if (method.methodType !== 'manage' && method.methodType !== 'admin-critical') {
    return { ok: false, state: 'unsupported', reason: 'This action is not ready for admin changes.' }
  }
  return { ok: true, state: 'available-local', reason: null }
}

function hasSchedulerManagePermission(method: MethodDescriptor): boolean {
  return method.requiredPermissions.includes('Scheduler.manage')
}

function schedulerPermissionWarnings(methods: MethodDescriptor[]): string[] {
  return [SCHEDULER_METHODS.scheduleAction, SCHEDULER_METHODS.cancel, SCHEDULER_METHODS.pause, SCHEDULER_METHODS.resume]
    .map((methodId) => methods.find((candidate) => candidate.busTopic === methodId))
    .filter((method): method is MethodDescriptor => Boolean(method))
    .filter((method) => method.availableOverHttp && (method.methodType === 'manage' || method.methodType === 'admin-critical') && !hasSchedulerManagePermission(method))
    .map(() => 'Permission is needed before scheduler changes can run.')
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
  if (state === 'remote-running') return 'Running on connected device'
  return 'Denied by policy'
}

function approvalLabel(job: NormalizedSchedulerJob): string {
  const token = job.delegated_approval_token_present ? 'approval is saved' : 'next approval required'
  const permissions = job.delegated_permissions.length > 0 ? `${job.delegated_permissions.length} delegated permission(s)` : 'no delegated permissions'
  return `${token}; ${permissions}; approval record ${job.policy_decision_id ? 'present' : 'not reported'}`
}

function runHistoryLabel(job: NormalizedSchedulerJob): string {
  const last = job.last_run ?? 'never run'
  const failures = job.failure_count > 0 ? `${job.failure_count} failure${job.failure_count === 1 ? '' : 's'}` : '0 failures'
  const error = job.last_error ? `; last issue ${adminReasonText(job.last_error)}` : ''
  return `last ${last}; ${failures}; ${job.source === 'remote' ? 'connected device' : 'this device'}; timezone ${job.timezone ?? 'UTC'}${error}`
}

function toolIntegrationLabel(job: NormalizedSchedulerJob): string {
  if (job.action.startsWith('Tooling.')) {
    const namespace = job.target_resource_namespace ? sanitizeAdminText(job.target_resource_namespace) : 'tool target selected at run time'
    const permissions = job.delegated_permissions.length > 0 ? `${job.delegated_permissions.length} delegated permission(s)` : `${adminModuleLabel('Tooling')} permission not reported`
    return `${adminActionLabel(job.action)} -> ${namespace}; delegated ${permissions}`
  }
  return `${adminActionLabel(job.action)}; delegated ${job.delegated_permissions.length > 0 ? `${job.delegated_permissions.length} permission(s)` : 'no delegated permissions'}`
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


function schedulerToolOptions(tools: ToolApprovalCardModel[]): SchedulerToolCreateOption[] {
  return tools.map((tool) => ({
    id: tool.id,
    label: `${tool.name} (${tool.providerPeerId && tool.providerPeerId !== 'local' ? 'connected device' : 'this device'})`,
    localName: tool.name,
    globalToolId: tool.id,
    providerPeerId: tool.providerPeerId,
    serviceInstanceId: tool.serviceInstanceId,
    disabled: tool.state === 'denied' || tool.state === 'unavailable' || Boolean(tool.disabledReason),
    reason: adminReasonText(tool.disabledReason ?? tool.denialReason, 'Available from reviewed Tools.')
  }))
}

function buildScheduleActionSpec({
  actionKind,
  orchestratorText,
  selectedTool,
  toolArguments,
  targetPeer,
  targetLabel
}: {
  actionKind: 'orchestrator.user_input' | 'tooling.execute'
  orchestratorText: string
  selectedTool: SchedulerToolCreateOption | null
  toolArguments: string
  targetPeer: string
  targetLabel: string
}): SchedulerScheduleActionRequest['action_spec'] | null {
  if (actionKind === 'orchestrator.user_input') {
    return { kind: 'orchestrator.user_input', text: orchestratorText.trim(), source: 'admin.scheduler.ui' }
  }
  if (!selectedTool) return null
  let parsedArguments: Record<string, unknown>
  try {
    const parsed = JSON.parse(toolArguments || '{}') as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    parsedArguments = parsed as Record<string, unknown>
  } catch {
    return null
  }
  return {
    kind: 'tooling.execute',
    binding: {
      tool_name: selectedTool.localName,
      local_tool_name: selectedTool.localName,
      global_tool_id: selectedTool.globalToolId,
      provider_peer_id: selectedTool.providerPeerId,
      provider_service_instance_id: selectedTool.serviceInstanceId
    },
    arguments: parsedArguments,
    mesh_selector: selectedTool.providerPeerId && selectedTool.providerPeerId !== 'local'
      ? { peer_id: selectedTool.providerPeerId, provider: targetLabel }
      : targetPeer !== 'local-peer'
        ? { peer_id: targetPeer, provider: targetLabel }
        : null,
    caller_peer_id: 'local-peer'
  }
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
    'offline',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}

function loadStateTone(state: SchedulerLoadState): BadgeTone {
  if (state === 'ready') return 'success'
  if (state === 'error' || state === 'service-unavailable') return 'danger'
  return 'neutral'
}

function errorMessage(error: unknown): string {
  return adminErrorTitle(error)
}

const loadingSchedulerSnapshot: AdminSchedulerSnapshot = {
  loadState: 'loading',
  jobs: [],
  createControl: {
    available: false,
    state: 'unsupported',
    reason: 'pending Aurora service calls',
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
  evidenceSource: 'pending Aurora service calls',
  secretsRedacted: true,
  toolOptions: []
}
