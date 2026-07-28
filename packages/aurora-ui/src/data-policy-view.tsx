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
import { safeErrorCopy } from './product-copy'
import { PageHeader } from './state-surface'
import { Button, Card, DataTable, StatStrip, type DataColumn } from './primitives'
import { cn } from '#lib/utils'

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
    return { ...definition, evaluation: null, error: productDataPolicyErrorCopy(result?.reason) }
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
        <span className="flex flex-col gap-0.5">
          <strong>{namespace.namespace}</strong>
          <small className="text-xs text-muted-foreground">{namespace.record_count === null ? 'records unknown' : `${namespace.record_count} records`}</small>
        </span>
      )
    },
    { key: 'privacy', header: 'Privacy', render: (namespace) => <PrivacyBadge privacy={normalizeRagPrivacyClass(namespace.policy.privacy_class)} /> },
    {
      key: 'retention',
      header: 'Retention and sharing',
      render: (namespace) => (
        <span className="flex flex-col gap-0.5">
          <span>{namespace.policy.sharing_mode}</span>
          <small className="text-xs text-muted-foreground">{namespace.freshness ?? 'freshness not reported'}</small>
        </span>
      )
    },
    { key: 'visibility', header: 'Visibility', hideAt: 'lg', render: (namespace) => <span className="text-sm text-muted-foreground">{namespaceVisibility(namespace)}</span> },
    { key: 'flows', header: 'Data flows', hideAt: 'md', render: (namespace) => <span className="text-sm text-muted-foreground">{dataFlowText(namespace)}</span> },
    {
      key: 'audit',
      header: 'Audit and AdminAction',
      hideAt: 'lg',
      render: (namespace) => (
        <span className="text-sm text-muted-foreground">
          {namespace.policy.requires_admin_approval ? 'AdminAction required for export/import/delete' : namespace.policy.denial_reason ?? 'read/search policy only'}
        </span>
      )
    }
  ]

  return (
    <section className="flex flex-col gap-4" aria-labelledby="data-policy-title">
      <PageHeader
        eyebrow="Memory"
        id="data-policy-title"
        title="Data policy and retention"
        description="Review retention defaults, collection visibility, audio and transcript storage, sharing rules, and account history before data leaves Aurora."
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
          { label: 'Retention defaults', value: totals.retentionModes, caption: `${snapshot.namespaces.length} collection(s)` },
          { label: 'Collection visibility', value: `${totals.localNamespaces} local / ${totals.remoteNamespaces} shared`, caption: `${totals.deniedNamespaces} denied or stale` },
          { label: 'Audio and transcripts', value: `${snapshot.conversations.length} transcript record(s)`, caption: 'audio storage off by default' },
          { label: 'Audit trail', value: `${totals.auditTargets} target(s)`, caption: `${totals.policyDecisions} policy decision(s)` }
        ]}
      />

      {snapshot.error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          <span>{snapshot.error}</span>
        </div>
      ) : null}
      {snapshot.loadState === 'loading' ? <p className="text-sm text-muted-foreground">Loading data policy from Aurora.</p> : null}
      {snapshot.loadState === 'empty' ? <p className="text-sm text-muted-foreground">No collections or transcript records were returned by Aurora.</p> : null}
      {snapshot.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning" aria-label="Data policy warnings">
          {snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <Card
        title="Retention defaults and collection visibility"
        description="Aurora shows sharing mode, privacy class, available actions, freshness, and approval requirements for each collection."
        icon={<Database size={18} aria-hidden />}
        actions={<Button variant="ghost" icon={<RefreshCw size={15} aria-hidden />} onClick={onRefresh} disabled={snapshot.loadState === 'loading'}>Refresh</Button>}
      >
        <DataTable
          columns={retentionColumns}
          rows={snapshot.namespaces}
          getRowKey={(namespace) => namespace.namespace}
          empty="No collection policy rows returned."
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Audio, transcripts, and sharing rules"
          description="Storage choices are shown as policy state until Aurora can safely apply changes."
          icon={<Mic size={18} aria-hidden />}
        >
          <div className="flex flex-col gap-3">
            <DataPolicyToggle label="Audio storage" value="Off by default" detail="Audio is temporary unless the selected destination, consent, privacy indicator, and policy allow retention." />
            <DataPolicyToggle label="Transcript storage" value={`${snapshot.conversations.length} recent transcript record(s)`} detail="Conversation text keeps each record privacy class; retention changes require approval and account history." />
            <DataPolicyToggle label="Shared-device help" value={totals.remoteFallback} detail="Shared memory and audio work require explicit selection, consent, and privacy indicators where applicable, and cannot switch destinations silently." />
            <DataPolicyToggle label="Collection visibility" value={totals.visibilityPolicy} detail="Denied, stale, and secret collections stay visible as policy status but are not actionable data sources." />
          </div>
        </Card>

        <Card
          title="Export, delete, and import data flows"
          description="Each flow is enabled only when collection policy and approval permit it; sensitive values stay hidden."
          icon={<ShieldCheck size={18} aria-hidden />}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Data policy flow cards">
            <FlowCard icon={<FileDown size={18} aria-hidden />} label="Export snapshot" value={`${totals.exportableNamespaces} collection(s)`} detail="Exports require collection policy support plus approval before records leave this device." />
            <FlowCard icon={<Trash2 size={18} aria-hidden />} label="Delete record" value={`${totals.deleteableNamespaces} collection(s)`} detail="Deletes require an administrator reason, policy decision, and account history." />
            <FlowCard icon={<Upload size={18} aria-hidden />} label="Import preview" value={`${totals.importableNamespaces} collection(s)`} detail="Imports are previewed before saving; ownership changes and shared sources remain policy-gated." />
            <FlowCard icon={<Network size={18} aria-hidden />} label="Shared query" value={`${totals.remoteQueryableNamespaces} collection(s)`} detail="Shared search is allowed only for selected collections and never exposes unrestricted database access." />
          </div>
        </Card>
      </div>

      <Card
        title="Audit trail for policy changes"
        description="Aurora previews account history, policy decisions, sharing behavior, and blockers before data-policy changes."
        icon={<History size={18} aria-hidden />}
        actions={
          <a
            href="/admin/audit"
            className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Open audit log
          </a>
        }
      >
        <div className="flex flex-col gap-3" role="list" aria-label="Data policy audit trail">
          {snapshot.checks.map((check) => (
            <article
              key={check.id}
              className={cn(
                'flex flex-col gap-2 rounded-lg border border-border bg-card p-3',
                (check.evaluation?.allowed ?? false) && 'border-success/30 bg-success/5'
              )}
              role="listitem"
              data-selected={check.evaluation?.allowed ?? false}
            >
              <header className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">{check.label}</strong>
                <StatusBadge state={check.evaluation?.availability ?? (check.error ? 'unsupported' : 'pending')} />
              </header>
              <p className="text-xs text-muted-foreground">{check.description}</p>
              {check.error ? <p className="text-xs text-destructive" role="alert">{productDataPolicyErrorCopy(check.error)}</p> : null}
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <PolicyFact label="Privacy class" value={check.evaluation?.privacyClass ?? check.privacyClass} />
                <PolicyFact label="Decision" value={check.evaluation ? `${check.evaluation.decision}: ${check.evaluation.reasonCode}` : 'pending'} />
                <PolicyFact label="Sharing behavior" value={productSharingBehaviorCopy(check.evaluation?.preview.fallbackBehavior ?? 'not evaluated')} />
                <PolicyFact label="Account history" value={productDataPolicyHistoryCopy(check.evaluation?.preview.auditReceiptTarget ?? check.auditReceiptTarget)} />
              </dl>
            </article>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground" role="alert">Policy edits require administrator review and account history; this screen does not directly change retention, audio, transcript, sharing, export, delete, or import policy.</p>
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
    policyCheck('rag-search', 'Collection search policy', 'Collection search needs privacy class, selector, and Aurora route status.', 'DB.RAGSearch', 'DB', 'RAGSearch', { query: 'deployment notes', namespace: 'main.rag' }, { resource_namespace: 'main.rag' }, 'sensitive', ['sensitive'], true, true, false),
    policyCheck('raw-audio', 'Audio route', 'Audio cannot leave the device without consent and a visible privacy indicator.', 'STT.Transcribe', 'STT', 'Transcribe', { session_id: 'policy-preview', sample_format: 'pcm16' }, { resource_id: 'microphone:default' }, 'raw-audio', ['raw-audio'], false, false, false),
    policyCheck('transcript-storage', 'Transcript storage', 'Transcript retention follows policy and per-record privacy classes.', 'DB.GetMessages', 'DB', 'GetMessages', { limit: 6, message_type: 'TEXT' }, null, 'personal', ['personal'], true, true, false),
    policyCheck('remote-fallback', 'Shared-device help', 'Shared-device help is policy-controlled and requires explicit device or resource selection.', 'DB.RAGSearchRemote', 'DB', 'RAGSearchRemote', { query: 'remote namespace', namespace: 'peer-studio-gpu.memories' }, { peer_id: 'peer-studio-gpu', resource_namespace: 'peer-studio-gpu.memories' }, 'personal', ['personal'], true, true, false),
    policyCheck('export-import-delete', 'Export/delete/import policy', 'Data changes require collection support plus administrator approval and account history before records move.', 'DB.RAGExportNamespace', 'DB', 'RAGExportNamespace', { namespace: 'main.rag', include_tombstones: false }, { resource_namespace: 'main.rag' }, 'sensitive', ['sensitive'], true, true, false)
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
    audioPolicy: rawAudio?.evaluation?.allowed ? 'audio allowed by policy' : 'audio remains temporary until consent, indicator, and policy allow retention',
    remoteFallback: remoteFallback?.evaluation?.allowed ? 'shared-device help allowed after selection' : 'shared-device help blocked until selection and policy allow it',
    visibilityPolicy: deniedNamespaces > 0 ? 'Denied/stale collections visible as policy status' : 'All collections actionable by current policy',
    exportableNamespaces: namespaces.filter((namespace) => namespace.policy.export_supported).length,
    deleteableNamespaces: namespaces.filter((namespace) => namespace.policy.delete_supported).length,
    importableNamespaces: namespaces.filter((namespace) => namespace.policy.import_supported).length,
    remoteQueryableNamespaces: namespaces.filter((namespace) => namespace.policy.sharing_mode === 'remote_query' && namespace.policy.allowed_operations.includes('search')).length,
    conversationCount: conversations.length
  }
}

function namespaceVisibility(namespace: DBRAGNamespaceInfo) {
  const origin = namespace.source_peer_id === 'local-peer' ? 'this device' : 'shared device'
  return `${origin}; ${namespace.availability}; version ${namespace.schema_version}`
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

function productDataPolicyErrorCopy(error: unknown): string {
  return safeErrorCopy(error).title
}

function productSharingBehaviorCopy(value: string): string {
  if (/none|not evaluated/i.test(value)) return value
  if (/block|deny/i.test(value)) return 'Blocked until policy allows it'
  if (/fallback|remote|mesh|peer|cloud/i.test(value)) return 'Can use another approved device'
  return 'Uses the selected destination'
}

function productDataPolicyHistoryCopy(value: string): string {
  return value ? 'Account history enabled' : 'Not reported'
}

function PolicyFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function DataPolicyToggle({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 pb-3 last:border-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <strong className="text-sm font-medium">{value}</strong>
      </div>
      <small className="text-xs text-muted-foreground">{detail}</small>
    </div>
  )
}

function FlowCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <header className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <strong className="text-sm text-foreground">{label}</strong>
      </header>
      <p className="text-sm font-medium">{value}</p>
      <small className="text-xs text-muted-foreground">{detail}</small>
    </article>
  )
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
