'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, Lock, Search, ShieldCheck } from 'lucide-react'
import {
  AuroraError,
  type AuditLogEntry,
  type AuditLogRequest,
  type AuroraClient,
  type AvailabilityState,
  type JsonObject,
  type JsonValue
} from '@aurora/client'
import { Alert, AlertDescription } from '#components/ui/alert'
import { Input } from '#components/ui/input'
import { EvidenceBadge, StatusBadge } from './status-badges'
import { Button, Card, DataTable, MetaGrid, type DataColumn } from './primitives'

const filterLabelClass = 'flex flex-col gap-1 text-xs text-muted-foreground'
const selectControlClass = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

export type AdminAuditLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export interface AdminAuditFilters {
  query: string
  event: string
  actor?: string
  action?: string
  resource?: string
  createdAfter?: string
  createdBefore?: string
  principalId: string
  peerOrProvider: string
  routePath: string
  approvalMode: string
  status: string
  toolId: string
  dataNamespace: string
  audioSessionId: string
  schedulerJobId: string
  correlationId: string
  denialReason: string
}

export interface AdminAuditRow {
  id: string
  event: string
  principalId: string
  action: string
  status: AdminAuditStatus
  createdAt: string
  correlationId: string
  peerId: string
  providerId: string
  routePath: string
  approvalMode: string
  toolId: string
  dataNamespace: string
  audioSessionId: string
  schedulerJobId: string
  denialReason: string
  receipt: string
  payloadHash: string
  supportBundleCorrelationIds: string[]
  details: JsonObject
  redactedPreview: string
  lifecycleLabel: string
  rawEvent: AuditLogEntry
}

export interface AdminAuditSnapshot {
  loadState: AdminAuditLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  backendFilter: AuditLogRequest
  filters: AdminAuditFilters
  rows: AdminAuditRow[]
  total: number
  warnings: string[]
  error: string | null
  evidenceSource: string
  exportState: AvailabilityState
  exportReason: string
}

export interface AdminAuditResourceProps {
  client: AuroraClient
}

export interface AdminAuditViewProps {
  snapshot: AdminAuditSnapshot
  filters?: Partial<AdminAuditFilters>
  onFiltersChange?: (filters: AdminAuditFilters) => void
  onExport?: (rows: AdminAuditRow[]) => void
}

const emptyFilters: AdminAuditFilters = {
  query: '',
  event: 'all',
  actor: '',
  action: '',
  resource: '',
  createdAfter: '',
  createdBefore: '',
  principalId: '',
  peerOrProvider: '',
  routePath: '',
  approvalMode: 'all',
  status: 'all',
  toolId: '',
  dataNamespace: '',
  audioSessionId: '',
  schedulerJobId: '',
  correlationId: '',
  denialReason: ''
}

const loadingSnapshot: AdminAuditSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  backendFilter: { limit: 100, offset: 0 },
  filters: emptyFilters,
  rows: [],
  total: 0,
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls',
  exportState: 'pending',
  exportReason: 'Audit export waits for redacted Auth.AuditLog status.'
}

const approvalLifecycleEvents = [
  'requested',
  'approved',
  'denied',
  'approve-all scope created',
  'token expired',
  'replay rejected',
  'executed',
  'dry-run'
]

const secretKeyPattern = /(token|secret|password|credential|api[_-]?key|authorization|raw_audio|audio_buffer)/i
const sensitivePayloadKeyPattern = /(payload|raw)/i
const safeHashKeyPattern = /(hash|digest|checksum|receipt|redacted)/i

export function AdminAuditResource({ client }: AdminAuditResourceProps) {
  const [filters, setFilters] = useState<AdminAuditFilters>(emptyFilters)
  const [snapshot, setSnapshot] = useState<AdminAuditSnapshot>(loadingSnapshot)

  useEffect(() => {
    let cancelled = false
    setSnapshot((current) => ({ ...loadingSnapshot, filters: current.filters }))
    void buildAdminAuditSnapshot(client, filters).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, filters])

  return (
    <AdminAuditView
      snapshot={snapshot}
      filters={filters}
      onFiltersChange={setFilters}
      onExport={(rows) => downloadAuditExport(rows)}
    />
  )
}

export async function buildAdminAuditSnapshot(
  client: AuroraClient,
  filters: Partial<AdminAuditFilters> = {}
): Promise<AdminAuditSnapshot> {
  const effectiveFilters = normalizeFilters(filters)
  const backendFilter = backendAuditFilter(effectiveFilters)

  try {
    const auditResult = await client.authApi.auditLog(backendFilter)
    if (!auditResult.ok) {
      const denied = isDeniedError(auditResult.error)
      return {
        ...loadingSnapshot,
        loadState: denied ? 'denied' : 'service-unavailable',
        backendFilter,
        filters: effectiveFilters,
        error: errorMessage(auditResult.error),
        warnings: [errorMessage(auditResult.error)],
        exportState: 'unsupported',
        exportReason: 'Export is disabled until Auth.AuditLog returns redacted audit status.',
        evidenceSource: 'Aurora request error'
      }
    }

    const allRows = auditResult.data.events.map(auditRow)
    const rows = allRows.filter((row) => rowMatchesFilters(row, effectiveFilters))
    const loadState: AdminAuditLoadState = rows.length === 0 ? 'empty' : 'ready'

    return {
      loadState,
      generatedAt: newestTimestamp(allRows),
      secretsRedacted: allRows.every((row) => row.details.secrets_redacted !== false),
      backendFilter,
      filters: effectiveFilters,
      rows,
      total: auditResult.data.total,
      warnings: unsupportedFilterWarnings(effectiveFilters, backendFilter),
      error: null,
      evidenceSource: client.transport.kind === 'mock' ? 'Local transport' : 'Aurora Auth.AuditLog response',
      exportState: rows.length > 0 ? 'available-local' : 'unsupported',
      exportReason: rows.length > 0
        ? 'Export includes the redacted normalized rows, payload hashes, receipts, and support-bundle correlation IDs.'
        : 'Export is disabled because no audit rows match the current filters.'
    }
  } catch (error) {
    const denied = isDeniedError(error)
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      backendFilter,
      filters: effectiveFilters,
      error: errorMessage(error),
      warnings: [errorMessage(error)],
      exportState: 'unsupported',
      exportReason: 'Export is disabled until Auth.AuditLog is available.',
      evidenceSource: 'Aurora transport error'
    }
  }
}

export function AdminAuditView({
  snapshot,
  filters,
  onFiltersChange,
  onExport
}: AdminAuditViewProps) {
  const effectiveFilters = normalizeFilters({ ...snapshot.filters, ...filters })
  const visibleRows = useMemo(
    () => snapshot.rows.filter((row) => rowMatchesFilters(row, effectiveFilters)),
    [snapshot.rows, effectiveFilters]
  )
  const [selectedRowId, setSelectedRowId] = useState<string | null>(visibleRows[0]?.id ?? null)
  const selectedRow = visibleRows.find((row) => row.id === selectedRowId) ?? visibleRows[0] ?? null

  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelectedRowId(null)
      return
    }
    if (!selectedRowId || !visibleRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(visibleRows[0]?.id ?? null)
    }
  }, [selectedRowId, visibleRows])

  const eventColumns: Array<DataColumn<AdminAuditRow>> = [
    {
      key: 'time',
      header: 'Time',
      render: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm font-medium">{row.createdAt}</strong>
          <small className="text-xs text-muted-foreground">{row.lifecycleLabel}</small>
        </span>
      )
    },
    {
      key: 'event',
      header: 'Event / action',
      render: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm font-medium">{row.event}</strong>
          <small className="text-xs text-muted-foreground">{row.action}</small>
        </span>
      )
    },
    { key: 'principal', header: 'Principal', render: (row) => <span className="block min-w-0 text-sm break-words">{row.principalId}</span> },
    {
      key: 'resource',
      header: 'Route / resource',
      hideAt: 'lg',
      render: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm font-medium">{row.routePath}</strong>
          <small className="text-xs text-muted-foreground">{row.peerId} / {row.providerId}</small>
        </span>
      )
    },
    {
      key: 'result',
      header: 'Result',
      render: (row) => (
        <div className="flex items-center gap-2">
          <StatusBadge state={statusAvailability(row.status)} />
          <span className="min-w-0 break-words text-sm">{row.status}</span>
        </div>
      )
    },
    {
      key: 'correlation',
      header: 'Correlation / receipt',
      hideAt: 'md',
      render: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <code className="font-mono text-xs">{row.correlationId}</code>
          <small className="font-mono text-xs text-muted-foreground">{row.receipt}</small>
        </span>
      )
    }
  ]

  return (
    <div className="flex h-full flex-col" aria-labelledby="admin-audit-title">
      <div className="border-b border-border px-6 py-5">
        <h1 id="admin-audit-title" className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">Audit search, mesh trace filters, event receipts, redacted payload previews, and export are loaded through Aurora.</p>
      </div>

      <div className="flex flex-col gap-4 px-6 py-5">
        <AuditStatusPanel snapshot={snapshot} />

        <Card
          ariaLabel="Filters"
          title="Search actor, action, resource, and time"
          description={snapshot.exportReason}
          actions={
            <Button
              variant="outline"
              icon={<Download size={15} aria-hidden />}
              disabled={snapshot.exportState === 'unsupported' || visibleRows.length === 0}
              disabledReason={snapshot.exportReason}
              onClick={() => onExport?.(visibleRows)}
            >
              Export redacted
            </Button>
          }
        >
          <div role="group" aria-label="Filters">
            <AuditFilters
              filters={effectiveFilters}
              {...(onFiltersChange ? { onChange: onFiltersChange } : {})}
            />
          </div>
        </Card>

        <Card ariaLabel="Events" title="Redacted event details" flush>
          <DataTable
            columns={eventColumns}
            rows={visibleRows}
            getRowKey={(row) => row.id}
            onRowClick={(row) => setSelectedRowId(row.id)}
            empty={<p>No audit events match the current SDK-backed filters.</p>}
          />
        </Card>
        {selectedRow ? <AuditDetailDrawer row={selectedRow} /> : null}
      </div>
    </div>
  )
}

export function buildAuditExport(rows: AdminAuditRow[]) {
  return {
    exported_at: new Date(0).toISOString(),
    redaction: {
      secrets_redacted: true,
      raw_payloads_included: false
    },
    support_bundle_correlation_ids: sortedUnique(rows.flatMap((row) => row.supportBundleCorrelationIds)),
    events: rows.map((row) => ({
      id: row.id,
      event: row.event,
      action: row.action,
      status: row.status,
      created_at: row.createdAt,
      principal_id: row.principalId,
      correlation_id: row.correlationId,
      peer_id: row.peerId,
      provider_id: row.providerId,
      route_path: row.routePath,
      approval_mode: row.approvalMode,
      tool_id: row.toolId,
      data_namespace: row.dataNamespace,
      audio_session_id: row.audioSessionId,
      scheduler_job_id: row.schedulerJobId,
      denial_reason: row.denialReason,
      audit_receipt: row.receipt,
      payload_hash: row.payloadHash,
      redacted_preview: row.redactedPreview
    }))
  }
}

function AuditFilters({
  filters,
  onChange
}: {
  filters: AdminAuditFilters
  onChange?: (filters: AdminAuditFilters) => void
}) {
  const update = (key: keyof AdminAuditFilters, value: string) => {
    onChange?.({ ...filters, [key]: value })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2.5">
        <label className={`col-span-2 ${filterLabelClass}`}>
          <span>Search</span>
          <div className="relative">
            <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" value={filters.query} onChange={(event) => update('query', event.currentTarget.value)} placeholder="actor, event, receipt, route" />
          </div>
        </label>
        <label className={filterLabelClass}>
          <span>Event</span>
          <select className={selectControlClass} value={filters.event} onChange={(event) => update('event', event.currentTarget.value)}>
            <option value="all">All events</option>
            <option value="admin_action.requested">Requested</option>
            <option value="admin_action.confirmed">Approved</option>
            <option value="admin_action.denied">Denied</option>
            <option value="tooling.approval_scope_created">Approve-all scope created</option>
            <option value="tooling.approval_token_expired">Token expired</option>
            <option value="tooling.approval_replay_rejected">Replay rejected</option>
            <option value="tooling.execute.completed">Executed</option>
            <option value="tooling.execute.dry_run">Dry-run</option>
          </select>
        </label>
        <label className={filterLabelClass}>
          <span>Result</span>
          <select className={selectControlClass} value={filters.status} onChange={(event) => update('status', event.currentTarget.value)}>
            <option value="all">All results</option>
            <option value="requested">Requested</option>
            <option value="approved">Approved</option>
            <option value="executed">Executed</option>
            <option value="denied">Denied</option>
            <option value="failed">Failed</option>
            <option value="token-expired">Token expired</option>
            <option value="replay-rejected">Replay rejected</option>
            <option value="dry-run">Dry-run</option>
            <option value="recorded">Recorded</option>
          </select>
        </label>
        <FilterInput label="Created after" type="datetime-local" value={filters.createdAfter ?? ''} onChange={(value) => update('createdAfter', value)} />
        <FilterInput label="Created before" type="datetime-local" value={filters.createdBefore ?? ''} onChange={(value) => update('createdBefore', value)} />
      </div>
      <details className="border-t border-dashed border-border pt-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">More filters</summary>
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2.5">
          <FilterInput label="Actor" value={filters.actor ?? ''} onChange={(value) => update('actor', value)} />
          <FilterInput label="Action" value={filters.action ?? ''} onChange={(value) => update('action', value)} />
          <FilterInput label="Resource" value={filters.resource ?? ''} onChange={(value) => update('resource', value)} />
          <FilterInput label="Principal" value={filters.principalId} onChange={(value) => update('principalId', value)} />
          <FilterInput label="Peer/provider" value={filters.peerOrProvider} onChange={(value) => update('peerOrProvider', value)} />
          <FilterInput label="Route path" value={filters.routePath} onChange={(value) => update('routePath', value)} />
          <label className={filterLabelClass}>
            <span>Approval mode</span>
            <select className={selectControlClass} value={filters.approvalMode} onChange={(event) => update('approvalMode', event.currentTarget.value)}>
              <option value="all">All modes</option>
              <option value="none">None</option>
              <option value="single">Single approval</option>
              <option value="approve_all">Approve all</option>
              <option value="admin_action">AdminAction</option>
              <option value="dry_run">Dry-run</option>
            </select>
          </label>
          <FilterInput label="Tool ID" value={filters.toolId} onChange={(value) => update('toolId', value)} />
          <FilterInput label="Data namespace" value={filters.dataNamespace} onChange={(value) => update('dataNamespace', value)} />
          <FilterInput label="Audio session" value={filters.audioSessionId} onChange={(value) => update('audioSessionId', value)} />
          <FilterInput label="Scheduler job" value={filters.schedulerJobId} onChange={(value) => update('schedulerJobId', value)} />
          <FilterInput label="Correlation ID" value={filters.correlationId} onChange={(value) => update('correlationId', value)} />
          <FilterInput label="Denial reason" value={filters.denialReason} onChange={(value) => update('denialReason', value)} />
        </div>
      </details>
    </div>
  )
}

function FilterInput({ label, type = 'text', value, onChange }: { label: string; type?: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={filterLabelClass}>
      <span>{label}</span>
      <Input type={type} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  )
}

function AuditDetailDrawer({ row }: { row: AdminAuditRow }) {
  return (
    <Card
      ariaLabel="Selected detail"
      icon={<ShieldCheck size={18} aria-hidden />}
      title={<span id="audit-selected-detail-title">Selected detail: {row.event}</span>}
      description="Redacted payload preview, receipts, and correlation ids for the selected event."
      actions={<EvidenceBadge label={`correlation ${row.correlationId}`} />}
    >
      <MetaGrid
        items={[
          { label: 'Actor', value: row.principalId },
          { label: 'Action', value: row.action },
          { label: 'Resource', value: resourceSummary(row) },
          { label: 'Created at', value: row.createdAt },
          { label: 'Correlation ID', value: row.correlationId, mono: true },
          { label: 'Audit receipt', value: row.receipt, mono: true },
          { label: 'Payload hash', value: row.payloadHash, mono: true },
          { label: 'Approval mode', value: row.approvalMode },
          { label: 'Denial reason', value: row.denialReason },
          { label: 'Tool ID', value: row.toolId },
          { label: 'Data namespace', value: row.dataNamespace },
          { label: 'Audio session', value: row.audioSessionId },
          { label: 'Scheduler job', value: row.schedulerJobId },
          { label: 'Support-bundle correlations', value: row.supportBundleCorrelationIds.join(', ') || 'none' }
        ]}
      />
      <div className="mt-3 flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Redacted payload preview</h3>
        <code className="block overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre">{row.redactedPreview}</code>
      </div>
    </Card>
  )
}

function AuditStatusPanel({ snapshot }: { snapshot: AdminAuditSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-sm" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading audit events and redaction metadata through Aurora.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-sm" role="status">
        <ShieldCheck size={18} aria-hidden />
        <span>No audit rows match the active search and trace filters.</span>
      </div>
    )
  }
  return (
    <Alert variant="destructive">
      <Lock size={18} aria-hidden />
      <AlertDescription>{snapshot.error ?? 'Audit status is degraded or unavailable. Export remains disabled until redacted SDK data is present.'}</AlertDescription>
    </Alert>
  )
}

function auditRow(entry: AuditLogEntry): AdminAuditRow {
  const details = sanitizeDetails(parseDetails(entry.details))
  const event = stringValue(entry.event) || stringValue(details.event) || 'audit event'
  const action = stringValue(entry.action) || stringValue(details.action) || event
  const correlationId = firstString(entry.correlation_id, details.correlation_id, details.trace_id, details.support_bundle_correlation_id) || 'not reported'
  const peerId = firstString(entry.peer_id, details.peer_id, details.source_peer_id, details.target_peer_id) || 'local'
  const providerId = firstString(entry.provider_id, details.provider_id, details.provider_peer_id, details.provider_service_instance_id) || 'local provider'
  const routePath = firstString(entry.route, details.route, details.route_path, details.route_target, details.method_id) || 'not reported'
  const status = auditStatus(event, details)
  const supportBundleCorrelationIds = sortedUnique([
    correlationId,
    ...arrayStrings(details.support_bundle_correlation_ids),
    ...arrayStrings(details.correlation_ids)
  ].filter((value) => value && value !== 'not reported'))
  const payloadHash = firstString(details.payload_hash, details.args_hash, details.details_hash, details.redacted_payload_hash) || hashPreview(details)

  return {
    id: firstString(entry.id, details.event_id, correlationId, `${event}:${entry.created_at ?? ''}`) || event,
    event,
    principalId: firstString(entry.principal_id, details.principal_id, details.caller_principal_id, details.actor) || 'unknown principal',
    action,
    status,
    createdAt: stringValue(entry.created_at) || 'time not reported',
    correlationId,
    peerId,
    providerId,
    routePath,
    approvalMode: firstString(details.approval_mode, details.requested_approval_scope, details.approval_scope) || 'none',
    toolId: firstString(entry.tool_id, details.tool_id, details.global_tool_id, details.tool_name) || 'not applicable',
    dataNamespace: firstString(details.data_namespace, details.namespace, details.rag_namespace) || 'not applicable',
    audioSessionId: firstString(details.audio_session_id, details.session_id, details.stream_id) || 'not applicable',
    schedulerJobId: firstString(details.scheduler_job_id, details.job_id) || 'not applicable',
    denialReason: firstString(details.denial_reason, details.reason, details.error_code) || (status === 'denied' ? 'denied' : 'none'),
    receipt: firstString(details.audit_receipt, details.receipt, entry.id) || 'not reported',
    payloadHash,
    supportBundleCorrelationIds,
    details,
    redactedPreview: JSON.stringify(details, null, 2),
    lifecycleLabel: lifecycleLabel(event, details, status),
    rawEvent: entry
  }
}

function normalizeFilters(filters: Partial<AdminAuditFilters>): AdminAuditFilters {
  return {
    ...emptyFilters,
    ...filters,
    event: filters.event && filters.event.trim() ? filters.event : 'all',
    approvalMode: filters.approvalMode && filters.approvalMode.trim() ? filters.approvalMode : 'all',
    status: filters.status && filters.status.trim() ? filters.status : 'all'
  }
}

function backendAuditFilter(filters: AdminAuditFilters): AuditLogRequest {
  return {
    limit: 250,
    offset: 0,
    event: filters.event !== 'all' ? filters.event : null,
    principal_id: blankToNull(filters.actor) ?? blankToNull(filters.principalId),
    correlation_id: blankToNull(filters.correlationId),
    tool_id: blankToNull(filters.toolId),
    action: blankToNull(filters.action),
    route: blankToNull(filters.routePath)
  }
}

function rowMatchesFilters(row: AdminAuditRow, filters: AdminAuditFilters): boolean {
  const checks: Array<[string, string]> = [
    [filters.query, [
      row.event,
      row.action,
      row.principalId,
      row.peerId,
      row.providerId,
      row.routePath,
      row.correlationId,
      row.receipt,
      row.redactedPreview
    ].join(' ')],
    [filters.actor ?? '', row.principalId],
    [filters.action ?? '', row.action],
    [filters.resource ?? '', resourceSummary(row)],
    [filters.principalId, row.principalId],
    [filters.peerOrProvider, `${row.peerId} ${row.providerId}`],
    [filters.routePath, row.routePath],
    [filters.toolId, row.toolId],
    [filters.dataNamespace, row.dataNamespace],
    [filters.audioSessionId, row.audioSessionId],
    [filters.schedulerJobId, row.schedulerJobId],
    [filters.correlationId, row.correlationId],
    [filters.denialReason, row.denialReason]
  ]
  if (filters.event !== 'all' && !contains(row.event, filters.event)) return false
  if (filters.approvalMode !== 'all' && !contains(row.approvalMode, filters.approvalMode)) return false
  if (filters.status !== 'all' && row.status !== filters.status) return false
  if (!matchesTimeRange(row.createdAt, filters.createdAfter ?? '', filters.createdBefore ?? '')) return false
  return checks.every(([needle, haystack]) => !needle.trim() || contains(haystack, needle))
}

function unsupportedFilterWarnings(filters: AdminAuditFilters, backendFilter: AuditLogRequest): string[] {
  const warnings: string[] = []
  if ((filters.resource ?? '').trim()) warnings.push('Resource is filtered from normalized route, peer, provider, tool, namespace, audio, and scheduler fields after Auth.AuditLog returns.')
  if ((filters.createdAfter ?? '').trim() || (filters.createdBefore ?? '').trim()) warnings.push('Time range is filtered from returned audit rows after Auth.AuditLog returns.')
  if (filters.approvalMode !== 'all') warnings.push('Approval mode is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.dataNamespace.trim()) warnings.push('Data namespace is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.audioSessionId.trim()) warnings.push('Audio session is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.schedulerJobId.trim()) warnings.push('Scheduler job is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.denialReason.trim()) warnings.push('Denial reason is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.status !== 'all') warnings.push('Result is filtered from normalized audit status after Auth.AuditLog returns.')
  if (filters.peerOrProvider.trim()) warnings.push('Peer/provider is filtered from returned audit rows to avoid over-constraining backend peer_id/provider_id filters.')
  return warnings
}

function parseDetails(details: unknown): JsonObject {
  if (typeof details === 'string' && details.trim()) {
    try {
      const parsed = JSON.parse(details) as unknown
      return isJsonObject(parsed) ? parsed : { preview: String(parsed) }
    } catch {
      return { preview: redactString(details) }
    }
  }
  return isJsonObject(details) ? details : {}
}

function sanitizeDetails(details: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      isSensitiveDetailKey(key) ? redactedToken(key, value) : sanitizeValue(value)
    ])
  ) as JsonObject
}

function sanitizeValue(value: JsonValue | undefined): JsonValue {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (isJsonObject(value)) return sanitizeDetails(value)
  return value ?? null
}

function redactedToken(key: string, value: JsonValue | undefined): JsonValue {
  if (typeof value === 'string' && value.startsWith('hash:')) return value
  return `${key}:redacted`
}

function isSensitiveDetailKey(key: string): boolean {
  return secretKeyPattern.test(key) || (sensitivePayloadKeyPattern.test(key) && !safeHashKeyPattern.test(key))
}

function redactString(value: string): string {
  return value
    .replace(/(token|password|secret|api[_-]?key)["=: ]+[^,"}\s]+/gi, '$1:redacted')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer redacted')
}

function auditStatus(event: string, details: JsonObject): AdminAuditStatus {
  const joined = `${event} ${stringValue(details.status)} ${stringValue(details.reason)} ${stringValue(details.error_code)}`.toLowerCase()
  if (joined.includes('dry_run') || joined.includes('dry-run')) return 'dry-run'
  if (joined.includes('replay') && joined.includes('reject')) return 'replay-rejected'
  if (joined.includes('expired')) return 'token-expired'
  if (joined.includes('denied') || joined.includes('permission') || joined.includes('unauthorized')) return 'denied'
  if (joined.includes('failed') || joined.includes('error')) return 'failed'
  if (joined.includes('requested') || joined.includes('pending')) return 'requested'
  if (joined.includes('approved') || joined.includes('confirmed')) return 'approved'
  if (joined.includes('executed') || joined.includes('completed') || joined.includes('success')) return 'executed'
  return 'recorded'
}

function lifecycleLabel(event: string, details: JsonObject, status: AdminAuditStatus): string {
  const explicit = firstString(details.lifecycle, details.lifecycle_event)
  if (explicit) return explicit
  if (
    event.includes('approve_all') ||
    event.includes('approval_scope') ||
    firstString(details.approval_mode, details.requested_approval_scope, details.approval_scope) === 'approve_all'
  ) return 'approve-all scope created'
  if (status === 'token-expired') return 'token expired'
  if (status === 'replay-rejected') return 'replay rejected'
  if (approvalLifecycleEvents.includes(status)) return status
  return status === 'recorded' ? 'audit event recorded' : status
}

function statusAvailability(status: AdminAuditStatus): AvailabilityState {
  if (status === 'denied' || status === 'failed' || status === 'replay-rejected') return 'denied'
  if (status === 'requested') return 'pending'
  if (status === 'token-expired' || status === 'dry-run') return 'degraded'
  return 'available-local'
}

function downloadAuditExport(rows: AdminAuditRow[]) {
  if (typeof document === 'undefined') return
  const payload = JSON.stringify(buildAuditExport(rows), null, 2)
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'aurora-audit-redacted-export.json'
  link.click()
  URL.revokeObjectURL(url)
}

function newestTimestamp(rows: AdminAuditRow[]): string | null {
  return rows.map((row) => row.createdAt).filter(Boolean).sort().at(-1) ?? null
}

function resourceSummary(row: AdminAuditRow): string {
  return [
    row.routePath,
    row.toolId,
    row.dataNamespace,
    row.audioSessionId,
    row.schedulerJobId,
    row.peerId,
    row.providerId
  ].join(' ')
}

function matchesTimeRange(createdAt: string, createdAfter: string, createdBefore: string): boolean {
  const createdTime = Date.parse(createdAt)
  if (Number.isNaN(createdTime)) return !createdAfter.trim() && !createdBefore.trim()
  const afterTime = createdAfter.trim() ? Date.parse(createdAfter) : Number.NaN
  const beforeTime = createdBefore.trim() ? Date.parse(createdBefore) : Number.NaN
  if (!Number.isNaN(afterTime) && createdTime < afterTime) return false
  if (!Number.isNaN(beforeTime) && createdTime > beforeTime) return false
  return true
}

function hashPreview(details: JsonObject): string {
  const preview = JSON.stringify(details)
  let hash = 0
  for (let index = 0; index < preview.length; index += 1) {
    hash = (hash * 31 + preview.charCodeAt(index)) >>> 0
  }
  return `sha256-preview:${hash.toString(16).padStart(8, '0')}`
}

function blankToNull(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function contains(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.trim().toLowerCase())
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function arrayStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
}

function isDeniedError(error: unknown): boolean {
  const maybe = error as Partial<AuroraError>
  return maybe.code === 'auth' || maybe.code === 'permission'
}

type AdminAuditStatus =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'executed'
  | 'dry-run'
  | 'token-expired'
  | 'replay-rejected'
  | 'failed'
  | 'recorded'
