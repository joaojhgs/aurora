'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, Filter, Lock, Search, ShieldCheck } from 'lucide-react'
import {
  AuroraError,
  type AuditLogEntry,
  type AuditLogRequest,
  type AuroraClient,
  type AvailabilityState,
  type JsonObject,
  type JsonValue
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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
  principalId: string
  peerOrProvider: string
  routePath: string
  approvalMode: string
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
  principalId: '',
  peerOrProvider: '',
  routePath: '',
  approvalMode: 'all',
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
  evidenceSource: 'pending AuroraClient SDK calls',
  exportState: 'pending',
  exportReason: 'Audit export waits for redacted Auth.AuditLog evidence.'
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
        exportReason: 'Export is disabled until Auth.AuditLog returns redacted audit evidence.',
        evidenceSource: 'AuroraClient SDK error'
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
      evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient Auth.AuditLog response',
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
      evidenceSource: 'AuroraClient transport error'
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
  const totals = auditTotals(visibleRows)

  return (
    <section className="aui-admin-audit" aria-labelledby="admin-audit-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-audit-title">Audit log</h1>
          <p>
            Audit search, mesh trace filters, event receipts, redacted payload previews, and export are loaded through AuroraClient.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Audit backend evidence">
          {isStatusBadgeState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <PrivacyBadge privacy="admin-critical" />
        </div>
      </header>

      <AuditStatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="Audit summary">
        <Metric label="Events" value={String(visibleRows.length)} detail={`${snapshot.total} returned by Auth.AuditLog`} />
        <Metric label="Denied" value={String(totals.denied)} detail="policy, auth, replay, or selector denial" />
        <Metric label="Approvals" value={String(totals.approvals)} detail="approval lifecycle events" />
        <Metric label="Correlations" value={String(totals.correlations)} detail="support-bundle trace IDs" />
      </div>

      <section className="aui-admin-panel" aria-labelledby="audit-controls-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Filters</p>
            <h2 id="audit-controls-title">Search and trace fields</h2>
          </div>
          <button
            className="aui-action-chip"
            type="button"
            disabled={snapshot.exportState === 'unsupported' || visibleRows.length === 0}
            title={snapshot.exportReason}
            onClick={() => onExport?.(visibleRows)}
          >
            <Download size={15} aria-hidden />
            Export redacted
          </button>
        </div>
        <AuditFilters
          filters={effectiveFilters}
          {...(onFiltersChange ? { onChange: onFiltersChange } : {})}
        />
        <div className="aui-audit-filter-note" role="status">
          <Filter size={16} aria-hidden />
          <span>{snapshot.exportReason}</span>
        </div>
      </section>

      <section className="aui-admin-panel" aria-labelledby="audit-events-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Events</p>
            <h2 id="audit-events-title">Redacted event details</h2>
          </div>
        </div>
        {visibleRows.length === 0 ? (
          <p className="aui-muted">No audit events match the current SDK-backed filters.</p>
        ) : (
          <div className="aui-table-scroll">
            <table className="aui-table aui-audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Principal</th>
                  <th>Route/provider</th>
                  <th>Status</th>
                  <th>Correlation</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
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
    <div className="aui-audit-filters">
      <label>
        <span>Search</span>
        <div className="aui-input-icon">
          <Search size={15} aria-hidden />
          <input value={filters.query} onChange={(event) => update('query', event.currentTarget.value)} placeholder="actor, event, receipt, route" />
        </div>
      </label>
      <label>
        <span>Event</span>
        <select value={filters.event} onChange={(event) => update('event', event.currentTarget.value)}>
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
      <FilterInput label="Principal" value={filters.principalId} onChange={(value) => update('principalId', value)} />
      <FilterInput label="Peer/provider" value={filters.peerOrProvider} onChange={(value) => update('peerOrProvider', value)} />
      <FilterInput label="Route path" value={filters.routePath} onChange={(value) => update('routePath', value)} />
      <label>
        <span>Approval mode</span>
        <select value={filters.approvalMode} onChange={(event) => update('approvalMode', event.currentTarget.value)}>
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
  )
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  )
}

function AuditRow({ row }: { row: AdminAuditRow }) {
  return (
    <tr>
      <td>
        <strong>{row.createdAt}</strong>
        <small>{row.lifecycleLabel}</small>
      </td>
      <td>
        <details className="aui-service-details">
          <summary>
            <strong>{row.event}</strong>
            <small>{row.action}</small>
          </summary>
          <div className="aui-service-drawer">
            <dl>
              <div><dt>Audit receipt</dt><dd>{row.receipt}</dd></div>
              <div><dt>Payload hash</dt><dd>{row.payloadHash}</dd></div>
              <div><dt>Approval mode</dt><dd>{row.approvalMode}</dd></div>
              <div><dt>Denial reason</dt><dd>{row.denialReason}</dd></div>
              <div><dt>Tool ID</dt><dd>{row.toolId}</dd></div>
              <div><dt>Data namespace</dt><dd>{row.dataNamespace}</dd></div>
              <div><dt>Audio session</dt><dd>{row.audioSessionId}</dd></div>
              <div><dt>Scheduler job</dt><dd>{row.schedulerJobId}</dd></div>
            </dl>
            <div className="aui-json-preview">
              <h3>Redacted payload preview</h3>
              <pre>{row.redactedPreview}</pre>
            </div>
          </div>
        </details>
      </td>
      <td>
        <strong>{row.principalId}</strong>
        <small>{row.receipt}</small>
      </td>
      <td>
        <strong>{row.routePath}</strong>
        <small>{row.peerId} / {row.providerId}</small>
      </td>
      <td>
        <div className="aui-state-line">
          <StatusBadge state={statusAvailability(row.status)} />
          <span>{row.status}</span>
        </div>
      </td>
      <td>
        <code>{row.correlationId}</code>
        <small>{row.supportBundleCorrelationIds.join(', ')}</small>
      </td>
    </tr>
  )
}

function AuditStatusPanel({ snapshot }: { snapshot: AdminAuditSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading audit events and redaction metadata through AuroraClient.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="aui-admin-notice" role="status">
        <ShieldCheck size={18} aria-hidden />
        <span>No audit rows match the active search and trace filters.</span>
      </div>
    )
  }
  return (
    <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
      <Lock size={18} aria-hidden />
      <span>{snapshot.error ?? 'Audit evidence is degraded or unavailable. Export remains disabled until redacted SDK data is present.'}</span>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="aui-admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
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
    approvalMode: filters.approvalMode && filters.approvalMode.trim() ? filters.approvalMode : 'all'
  }
}

function backendAuditFilter(filters: AdminAuditFilters): AuditLogRequest {
  return {
    limit: 250,
    offset: 0,
    event: filters.event !== 'all' ? filters.event : null,
    principal_id: blankToNull(filters.principalId),
    correlation_id: blankToNull(filters.correlationId),
    tool_id: blankToNull(filters.toolId),
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
  return checks.every(([needle, haystack]) => !needle.trim() || contains(haystack, needle))
}

function unsupportedFilterWarnings(filters: AdminAuditFilters, backendFilter: AuditLogRequest): string[] {
  const warnings: string[] = []
  if (filters.approvalMode !== 'all') warnings.push('Approval mode is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.dataNamespace.trim()) warnings.push('Data namespace is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.audioSessionId.trim()) warnings.push('Audio session is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.schedulerJobId.trim()) warnings.push('Scheduler job is filtered from redacted audit detail fields after Auth.AuditLog returns.')
  if (filters.denialReason.trim()) warnings.push('Denial reason is filtered from redacted audit detail fields after Auth.AuditLog returns.')
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
      secretKeyPattern.test(key) ? redactedToken(key, value) : sanitizeValue(value)
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

function auditTotals(rows: AdminAuditRow[]) {
  return {
    denied: rows.filter((row) => ['denied', 'failed', 'replay-rejected'].includes(row.status)).length,
    approvals: rows.filter((row) => approvalLifecycleEvents.some((event) => row.lifecycleLabel.includes(event))).length,
    correlations: sortedUnique(rows.flatMap((row) => row.supportBundleCorrelationIds)).length
  }
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

function hashPreview(details: JsonObject): string {
  const preview = JSON.stringify(details)
  let hash = 0
  for (let index = 0; index < preview.length; index += 1) {
    hash = (hash * 31 + preview.charCodeAt(index)) >>> 0
  }
  return `sha256-preview:${hash.toString(16).padStart(8, '0')}`
}

function blankToNull(value: string): string | null {
  return value.trim() || null
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

function isStatusBadgeState(value: string): value is AvailabilityState {
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
