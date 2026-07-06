'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, FileDown, History, Mic, Network, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react'
import type {
  AuroraClient,
  DBRAGNamespaceInfo,
  NormalizedConversation,
  PrivacyClass,
  RoutePolicyEvaluation,
  RouteExplainRequest
} from '@aurora/client'
import { normalizeConversationMessage, normalizeRagPrivacyClass } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
import { PageHeader } from './state-surface'
import { Button, Card, DataTable, StatStrip, type DataColumn } from './primitives'

export type DataPolicyLoadState = 'loading' | 'ready' | 'degraded' | 'denied' | 'empty' | 'error'

export interface DataPolicyCheck {
  id: string
  label: string
  description: string
  routeRequest: RouteExplainRequest
  payload: unknown
  selector: unknown
  privacyClass: PrivacyClass
  dataClasses: PrivacyClass[]
  consentGranted: boolean
  privacyIndicatorShown: boolean
  allowCloudFallback: boolean
  auditReceiptTarget: string
  evaluation: RoutePolicyEvaluation | null
  error: string | null
}

export interface DataPolicySnapshot {
  loadState: DataPolicyLoadState
  generatedAt: string | null
  route: RouteAvailability
  namespaces: DBRAGNamespaceInfo[]
  conversations: NormalizedConversation[]
  checks: DataPolicyCheck[]
  error: string | null
  warnings: string[]
  secretsRedacted: boolean
}

export interface DataPolicyResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface DataPolicyViewProps {
  snapshot: DataPolicySnapshot
  onRefresh?: () => void
}

const loadingDataPolicySnapshot = (route: RouteAvailability): DataPolicySnapshot => ({
  loadState: 'loading',
  generatedAt: null,
  route,
  namespaces: [],
  conversations: [],
  checks: dataPolicyDefinitions().map((definition) => ({ ...definition, evaluation: null, error: null })),
  error: null,
  warnings: [],
  secretsRedacted: true
})

export function DataPolicyResource({ client, route }: DataPolicyResourceProps) {
  const [snapshot, setSnapshot] = useState<DataPolicySnapshot>(() => loadingDataPolicySnapshot(route))

  const refresh = useCallback(async () => {
    setSnapshot(loadingDataPolicySnapshot(route))
    setSnapshot(await buildDataPolicySnapshot(client, route))
  }, [client, route])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingDataPolicySnapshot(route))
    void buildDataPolicySnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route])

  return <DataPolicyView snapshot={snapshot} onRefresh={refresh} />
}

export async function buildDataPolicySnapshot(client: AuroraClient, route: RouteAvailability): Promise<DataPolicySnapshot> {
  const definitions = dataPolicyDefinitions()
  const [namespacesResult, messagesResult, catalogResult, ...checkResults] = await Promise.allSettled([
    client.memory.listNamespaces({ include_remote: true, include_unavailable: true }),
    client.memory.listMessages({ limit: 6 }),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true }),
    ...definitions.map((definition) => client.routes.evaluatePolicy({
      routeRequest: definition.routeRequest,
      payload: definition.payload,
      selector: definition.selector,
      privacyClass: definition.privacyClass,
      dataClasses: definition.dataClasses,
      consentGranted: definition.consentGranted,
      privacyIndicatorShown: definition.privacyIndicatorShown,
      allowCloudFallback: definition.allowCloudFallback,
      auditReceiptTarget: definition.auditReceiptTarget
    }))
  ])
  const namespacesResponse = settledOkData(namespacesResult)
  const messagesResponse = settledOkData(messagesResult)
  const catalogResponse = settledValue(catalogResult)
  const warnings = [
    settledWarning('DB.RAGListNamespaces', namespacesResult),
    settledWarning('DB.GetMessages', messagesResult),
    settledWarning('Gateway.GetCapabilityCatalog', catalogResult),
    ...checkResults.map((result, index) => settledWarning(definitions[index]?.label ?? `policy check ${index}`, result))
  ].filter((message): message is string => Boolean(message))
  const checks = definitions.map<DataPolicyCheck>((definition, index) => {
    const result = checkResults[index]
    if (result?.status === 'fulfilled') return { ...definition, evaluation: result.value, error: null }
    return { ...definition, evaluation: null, error: policyErrorText(result?.reason) }
  })
  const namespaces = namespacesResponse?.namespaces ?? []
  const conversations = (messagesResponse?.messages ?? []).map(normalizeConversationMessage)
  const denied = [namespacesResult, messagesResult, catalogResult, ...checkResults].some(isPermissionDenied)
  const allUnavailable = !namespacesResponse && !messagesResponse && checks.every((check) => !check.evaluation)
  const loadState: DataPolicyLoadState = denied
    ? 'denied'
    : allUnavailable
      ? 'error'
      : namespaces.length === 0 && conversations.length === 0
        ? 'empty'
        : warnings.length > 0 || checks.some((check) => check.evaluation && !check.evaluation.allowed)
          ? 'degraded'
          : 'ready'

  return {
    loadState,
    generatedAt: catalogResponse?.generated_at ?? null,
    route,
    namespaces,
    conversations,
    checks,
    error: allUnavailable ? 'Data policy status is unavailable through Aurora.' : null,
    warnings,
    secretsRedacted: catalogResponse?.secrets_redacted ?? true
  }
}

export function DataPolicyView({ snapshot, onRefresh }: DataPolicyViewProps) {
  const totals = useMemo(() => dataPolicyTotals(snapshot.namespaces, snapshot.conversations, snapshot.checks), [snapshot.namespaces, snapshot.conversations, snapshot.checks])

  const retentionColumns: Array<DataColumn<DBRAGNamespaceInfo>> = [
    {
      key: 'namespace',
      header: 'Namespace',
      render: (namespace) => (
        <span className="aui-cell-stack">
          <strong>{namespace.namespace}</strong>
          <small>{namespace.record_count === null ? 'records unknown' : `${namespace.record_count} records`}</small>
        </span>
      )
    },
    { key: 'privacy', header: 'Privacy', render: (namespace) => <PrivacyBadge privacy={normalizeRagPrivacyClass(namespace.policy.privacy_class)} /> },
    {
      key: 'retention',
      header: 'Retention and sharing',
      render: (namespace) => (
        <span className="aui-cell-stack">
          <span>{namespace.policy.sharing_mode}</span>
          <small>{namespace.freshness ?? 'freshness not reported'}</small>
        </span>
      )
    },
    { key: 'visibility', header: 'Visibility', hideAt: 'lg', render: (namespace) => <span className="aui-cell-text">{namespaceVisibility(namespace)}</span> },
    { key: 'flows', header: 'Data flows', hideAt: 'md', render: (namespace) => <span className="aui-cell-text">{dataFlowText(namespace)}</span> },
    {
      key: 'audit',
      header: 'Audit and AdminAction',
      hideAt: 'lg',
      render: (namespace) => (
        <span className="aui-cell-text">
          {namespace.policy.requires_admin_approval ? 'AdminAction required for export/import/delete' : namespace.policy.denial_reason ?? 'read/search policy only'}
        </span>
      )
    }
  ]

  return (
    <section className="aui-route-policy-view" aria-labelledby="data-policy-title">
      <PageHeader
        eyebrow="Memory"
        id="data-policy-title"
        title="Data policy and retention"
        description="Review settings-style privacy controls for retention defaults, namespace visibility, raw audio/transcript storage, remote fallback rules, data flows, and audit state before data leaves Aurora."
        badges={
          <>
            <StatusBadge state={dataPolicyStatusState(snapshot.loadState)} />
            <PrivacyBadge privacy={totals.highestPrivacy} />
            <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
            <EvidenceBadge label={snapshot.generatedAt ?? 'Gateway catalog timestamp pending'} />
          </>
        }
      />

      <StatStrip
        ariaLabel="Data policy summary"
        items={[
          { label: 'Retention defaults', value: totals.retentionModes, caption: `${snapshot.namespaces.length} namespace(s)` },
          { label: 'Namespace visibility', value: `${totals.localNamespaces} local / ${totals.remoteNamespaces} remote`, caption: `${totals.deniedNamespaces} denied or stale` },
          { label: 'Raw audio/transcripts', value: `${snapshot.conversations.length} transcript record(s)`, caption: 'raw audio off by default' },
          { label: 'Audit trail', value: `${totals.auditTargets} target(s)`, caption: `${totals.policyDecisions} policy decision(s)` }
        ]}
      />

      {snapshot.error ? <div className="aui-inline-alert aui-inline-alert-danger" role="alert"><span>{snapshot.error}</span></div> : null}
      {snapshot.loadState === 'loading' ? <p className="aui-message">Loading data policy from Aurora.</p> : null}
      {snapshot.loadState === 'empty' ? <p className="aui-message">No namespaces or transcript records were returned by the backend.</p> : null}
      {snapshot.warnings.length > 0 ? (
        <ul className="aui-mesh-warnings" aria-label="Data policy warnings">
          {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <Card
        title="Retention defaults and namespace visibility"
        description="DB.RAGListNamespaces is the source of truth for sharing mode, privacy class, operations, freshness, and AdminAction requirements."
        icon={<Database size={18} aria-hidden />}
        actions={<Button variant="ghost" icon={<RefreshCw size={15} aria-hidden />} onClick={onRefresh} disabled={snapshot.loadState === 'loading'}>Refresh</Button>}
      >
        <DataTable
          columns={retentionColumns}
          rows={snapshot.namespaces}
          getRowKey={(namespace) => namespace.namespace}
          empty={<div className="aui-empty-inline"><p>No namespace policy rows returned.</p></div>}
        />
      </Card>

      <div className="aui-two-col">
        <Card
          title="Raw audio, transcripts, and fallback rules"
          description="Storage toggles are represented as policy state until backend AdminAction mutation endpoints exist."
          icon={<Mic size={18} aria-hidden />}
        >
          <div className="aui-policy-toggles">
            <DataPolicyToggle label="Raw audio storage" value="Off by default" detail="Raw audio is transient unless the selected route, consent, privacy indicator, and backend policy allow retention." />
            <DataPolicyToggle label="Transcript storage" value={`${snapshot.conversations.length} recent transcript record(s)`} detail="Conversation text is loaded via DB.GetMessages and inherits each record privacy class; retention changes require AdminAction audit." />
            <DataPolicyToggle label="Remote/mesh fallback" value={totals.remoteFallback} detail="Remote RAG and audio routes require explicit selector, consent/privacy indicators where applicable, and cannot silently fall back to cloud." />
            <DataPolicyToggle label="Namespace visibility" value={totals.visibilityPolicy} detail="Denied, stale, and secret namespaces stay visible as policy status but are not actionable data sources." />
          </div>
        </Card>

        <Card
          title="Export, delete, and import data flows"
          description="Each flow is enabled only when namespace policy and AdminAction permit it; no raw payloads or tokens are rendered."
          icon={<ShieldCheck size={18} aria-hidden />}
        >
          <div className="aui-route-scenarios" aria-label="Data policy flow cards">
            <FlowCard icon={<FileDown size={18} aria-hidden />} label="Export snapshot" value={`${totals.exportableNamespaces} namespace(s)`} detail="Exports require namespace policy support plus AdminAction approval before records leave this node." />
            <FlowCard icon={<Trash2 size={18} aria-hidden />} label="Delete record" value={`${totals.deleteableNamespaces} namespace(s)`} detail="Deletes remain admin-critical and must carry reason, policy decision, and audit correlation." />
            <FlowCard icon={<Upload size={18} aria-hidden />} label="Import preview" value={`${totals.importableNamespaces} namespace(s)`} detail="Imports are previewed before write; owner overwrite and remote source metadata remain policy-gated." />
            <FlowCard icon={<Network size={18} aria-hidden />} label="Remote query" value={`${totals.remoteQueryableNamespaces} namespace(s)`} detail="Remote query is allowed only for selected namespaces and never exposes raw SQL or unrestricted replication." />
          </div>
        </Card>
      </div>

      <Card
        title="Audit trail for policy changes"
        description="Route policy dry-runs show the audit target, policy decision, fallback behavior, and blockers that would accompany data-policy changes."
        icon={<History size={18} aria-hidden />}
        actions={<a className="aui-btn aui-btn-ghost aui-btn-sm" href="/admin/audit">Open audit log</a>}
      >
        <div className="aui-route-scenarios" role="list" aria-label="Data policy audit trail">
          {snapshot.checks.map((check) => (
            <article key={check.id} className="aui-route-candidate" role="listitem" data-selected={check.evaluation?.allowed ?? false}>
              <header>
                <strong>{check.label}</strong>
                <StatusBadge state={check.evaluation?.availability ?? (check.error ? 'unsupported' : 'pending')} />
              </header>
              <p>{check.description}</p>
              {check.error ? <p className="aui-message aui-message-danger">{check.error}</p> : null}
              <dl className="aui-route-policy-summary">
                <PolicyFact label="Privacy class" value={check.evaluation?.privacyClass ?? check.privacyClass} />
                <PolicyFact label="Decision" value={check.evaluation ? `${check.evaluation.decision}: ${check.evaluation.reasonCode}` : 'pending'} />
                <PolicyFact label="Fallback" value={check.evaluation?.preview.fallbackBehavior ?? 'not evaluated'} />
                <PolicyFact label="Audit target" value={check.evaluation?.preview.auditReceiptTarget ?? check.auditReceiptTarget} />
              </dl>
            </article>
          ))}
        </div>
        <p className="aui-message" role="alert">Policy edits require AdminAction draft/confirm/audit through Config.Set; this route does not mutate retention, raw audio, transcript, fallback, export, delete, or import policy directly.</p>
      </Card>
    </section>
  )
}


function dataPolicyStatusState(state: DataPolicyLoadState) {
  if (state === 'loading') return 'pending'
  if (state === 'ready') return 'available-local'
  if (state === 'empty') return 'degraded'
  if (state === 'error') return 'unsupported'
  return state
}

function dataPolicyDefinitions(): Omit<DataPolicyCheck, 'evaluation' | 'error'>[] {
  return [
    policyCheck('rag-search', 'RAG search policy', 'Namespace search needs privacy class, selector, and backend route status.', 'DB.RAGSearch', 'DB', 'RAGSearch', { query: 'deployment notes', namespace: 'main.rag' }, { resource_namespace: 'main.rag' }, 'sensitive', ['sensitive'], true, true, false),
    policyCheck('raw-audio', 'Raw audio route', 'Raw audio cannot leave the device without consent and a visible privacy indicator.', 'STT.Transcribe', 'STT', 'Transcribe', { session_id: 'policy-preview', sample_format: 'pcm16' }, { resource_id: 'microphone:default' }, 'raw-audio', ['raw-audio'], false, false, false),
    policyCheck('transcript-storage', 'Transcript storage', 'Transcript retention follows DB.GetMessages policy and per-record privacy classes.', 'DB.GetMessages', 'DB', 'GetMessages', { limit: 6, message_type: 'TEXT' }, null, 'personal', ['personal'], true, true, false),
    policyCheck('remote-fallback', 'Remote mesh fallback', 'Remote fallback is policy-controlled and requires explicit peer/resource selector status.', 'DB.RAGSearchRemote', 'DB', 'RAGSearchRemote', { query: 'remote namespace', namespace: 'peer-studio-gpu.memories' }, { peer_id: 'peer-studio-gpu', resource_namespace: 'peer-studio-gpu.memories' }, 'personal', ['personal'], true, true, false),
    policyCheck('export-import-delete', 'Export/delete/import policy', 'Data mutations require namespace support plus AdminAction/audit before payload movement.', 'DB.RAGExportNamespace', 'DB', 'RAGExportNamespace', { namespace: 'main.rag', include_tombstones: false }, { resource_namespace: 'main.rag' }, 'sensitive', ['sensitive'], true, true, false)
  ]
}

function policyCheck(
  id: string,
  label: string,
  description: string,
  topic: string,
  module: string,
  method: string,
  payload: unknown,
  selector: unknown,
  privacyClass: PrivacyClass,
  dataClasses: PrivacyClass[],
  consentGranted: boolean,
  privacyIndicatorShown: boolean,
  allowCloudFallback: boolean
): Omit<DataPolicyCheck, 'evaluation' | 'error'> {
  return {
    id,
    label,
    description,
    routeRequest: { topic, module, method, selector },
    payload,
    selector,
    privacyClass,
    dataClasses,
    consentGranted,
    privacyIndicatorShown,
    allowCloudFallback,
    auditReceiptTarget: 'Auth.StoreAuditEvent'
  }
}

function dataPolicyTotals(namespaces: DBRAGNamespaceInfo[], conversations: NormalizedConversation[], checks: DataPolicyCheck[]) {
  const retentionModes = [...new Set(namespaces.map((namespace) => namespace.policy.sharing_mode))].join(', ') || 'policy pending'
  const localNamespaces = namespaces.filter((namespace) => namespace.source_peer_id === namespace.owner_peer_id && namespace.owner_peer_id === 'local-peer').length
  const remoteNamespaces = namespaces.filter((namespace) => namespace.source_peer_id !== 'local-peer' || namespace.owner_peer_id !== 'local-peer').length
  const deniedNamespaces = namespaces.filter((namespace) => namespace.availability === 'denied' || namespace.availability === 'stale').length
  const privacyOrder: PrivacyClass[] = ['public', 'personal', 'sensitive', 'secret', 'credential', 'raw-audio', 'admin-critical']
  const highestPrivacy = namespaces.reduce<PrivacyClass>((highest, namespace) => {
    const privacy = normalizeRagPrivacyClass(namespace.policy.privacy_class)
    return privacyOrder.indexOf(privacy) > privacyOrder.indexOf(highest) ? privacy : highest
  }, 'personal')
  const auditTargets = new Set(checks.map((check) => check.evaluation?.preview.auditReceiptTarget ?? check.auditReceiptTarget)).size
  const policyDecisions = checks.filter((check) => check.evaluation).length
  const rawAudio = checks.find((check) => check.id === 'raw-audio')
  const remoteFallback = checks.find((check) => check.id === 'remote-fallback')
  return {
    retentionModes,
    localNamespaces,
    remoteNamespaces,
    deniedNamespaces,
    highestPrivacy,
    auditTargets,
    policyDecisions,
    audioPolicy: rawAudio?.evaluation?.allowed ? 'raw audio route allowed by policy' : 'raw audio transient until consent/indicator/backend policy allow retention',
    remoteFallback: remoteFallback?.evaluation?.allowed ? 'remote fallback allowed with selector status' : 'remote fallback blocked unless selector/backend policy allow it',
    visibilityPolicy: deniedNamespaces > 0 ? 'Denied/stale namespaces visible as policy status' : 'All namespaces actionable by current policy',
    exportableNamespaces: namespaces.filter((namespace) => namespace.policy.export_supported).length,
    deleteableNamespaces: namespaces.filter((namespace) => namespace.policy.delete_supported).length,
    importableNamespaces: namespaces.filter((namespace) => namespace.policy.import_supported).length,
    remoteQueryableNamespaces: namespaces.filter((namespace) => namespace.policy.sharing_mode === 'remote_query' && namespace.policy.allowed_operations.includes('search')).length,
    conversationCount: conversations.length
  }
}

function namespaceVisibility(namespace: DBRAGNamespaceInfo) {
  const origin = namespace.source_peer_id === 'local-peer' ? 'local node' : `remote peer ${namespace.source_peer_id}`
  return `${origin}; ${namespace.availability}; schema ${namespace.schema_version}`
}

function dataFlowText(namespace: DBRAGNamespaceInfo) {
  const flows = [
    namespace.policy.allowed_operations.includes('search') ? 'search' : null,
    namespace.policy.export_supported ? 'export' : null,
    namespace.policy.import_supported ? 'import' : null,
    namespace.policy.delete_supported ? 'delete' : null
  ].filter((value): value is string => Boolean(value))
  return flows.length > 0 ? flows.join(', ') : namespace.policy.denial_reason ?? 'no data flow allowed'
}

function PolicyFact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function DataPolicyToggle({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <label><span>{label}</span><strong>{value}</strong><small>{detail}</small></label>
}

function FlowCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <article className="aui-route-candidate"><header>{icon}<strong>{label}</strong></header><p>{value}</p><small>{detail}</small></article>
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function settledOkData<T extends { ok: boolean; data?: unknown; error?: unknown }>(result: PromiseSettledResult<T>) {
  if (result.status === 'fulfilled' && result.value.ok) return result.value.data as T extends { data?: infer D } ? D : never
  return null
}

function settledWarning(label: string, result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'rejected') return `${label}: ${policyErrorText(result.reason)}`
  const value = result.value
  if (isAuroraResponseFailure(value)) return `${label}: ${policyErrorText(value.error)}`
  return null
}

function isAuroraResponseFailure(value: unknown): value is { ok: false; error: unknown } {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false && 'error' in value
}

function isPermissionDenied(result: PromiseSettledResult<unknown>) {
  if (result.status === 'rejected') return /permission|auth|denied|privacy/i.test(policyErrorText(result.reason))
  if (isAuroraResponseFailure(result.value)) return /permission|auth|denied|privacy/i.test(policyErrorText(result.value.error))
  return false
}

function policyErrorText(error: unknown): string {
  if (!error) return 'unknown policy error'
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const message = record.message ?? record.code ?? record.name
    if (typeof message === 'string' && message.trim()) return message
  }
  return String(error)
}
