'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Database, Search, Trash2 } from 'lucide-react'
import type {
  AuroraClient,
  AuroraError,
  DBRAGNamespaceInfo,
  DBRAGProvenanceItem,
  NormalizedConversation,
  RAGPolicyDecision
} from '@aurora/client'
import { normalizeConversationMessage, normalizeRagPrivacyClass } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { PrivacyBadge, presentableSignal } from './status-badges'
import { safeErrorCopy } from './product-copy'
import { PageHeader } from './state-surface'
import { Button, Card, MetaGrid } from './primitives'
import { LocalDataMemoryPanel } from './local-data/storage-health-view.js'
import { Input } from '#components/ui/input'
import { Badge } from '#components/ui/badge'
import { cn } from '#lib/utils'

export interface MemoryViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialModel?: MemoryViewModel | undefined
  initialQuery?: string | undefined
}

export type MemoryLoadState = 'loading' | 'ready' | 'error'
export type MemoryNamespaceKind =
  | 'local-memory'
  | 'local-rag'
  | 'remote-peer'
  | 'imported-snapshot'
  | 'stale'
  | 'denied'
  | 'unavailable'

export interface MemoryNamespaceView {
  info: DBRAGNamespaceInfo
  kind: MemoryNamespaceKind
  label: string
  selectable: boolean
  stateCopy: string
  repairCopy: string | null
}

export interface MemoryActionState {
  supported: boolean
  disabled: boolean
  label: string
  reason: string
  requiresAdminAction: boolean
}

export interface MemoryViewModel {
  loadState: MemoryLoadState
  route: RouteAvailability
  conversations: NormalizedConversation[]
  namespaces: MemoryNamespaceView[]
  selectedNamespace: MemoryNamespaceView | null
  query: string
  searchDecision: RAGPolicyDecision | 'not-requested'
  searchItems: DBRAGProvenanceItem[]
  denialReason: string | null
  policyDecisionId: string | null
  correlationId: string | null
  error: string | null
  actions: {
    search: MemoryActionState
    export: MemoryActionState
    delete: MemoryActionState
    importPreview: MemoryActionState
  }
}

export interface BuildMemoryViewModelOptions {
  namespace?: string | null
  query?: string
  limit?: number
}

export async function buildMemoryViewModel(
  client: AuroraClient,
  route: RouteAvailability,
  options: BuildMemoryViewModelOptions = {}
): Promise<MemoryViewModel> {
  const query = options.query?.trim() ?? ''
  const [messagesResult, namespacesResult] = await Promise.all([
    client.memory.listMessages({ limit: 8 }),
    client.memory.listNamespaces({ include_remote: true, include_unavailable: true })
  ])

  if (!messagesResult.ok) return errorModel(route, query, memoryErrorMessage(messagesResult.error))
  if (!namespacesResult.ok) return errorModel(route, query, memoryErrorMessage(namespacesResult.error))

  const namespaces = namespacesResult.data.namespaces.map((namespace) => namespaceView(namespace))
  const requested = options.namespace
    ? namespaces.find((namespace) => namespace.info.namespace === options.namespace) ?? null
    : null
  const selectedNamespace = requested ?? namespaces.find((namespace) => namespace.selectable) ?? namespaces[0] ?? null
  let searchDecision: MemoryViewModel['searchDecision'] = 'not-requested'
  let searchItems: DBRAGProvenanceItem[] = []
  let denialReason: string | null = null
  let policyDecisionId: string | null = null
  let correlationId: string | null = null

  if (selectedNamespace && query) {
    const result = await client.memory.search({
      namespace: selectedNamespace.info.namespace,
      query,
      limit: options.limit ?? 10,
      mesh_selector: selectedNamespace.info.policy.explicit_selector_required
        ? {
            peer_id: selectedNamespace.info.provider_peer_id,
            resource_namespace: selectedNamespace.info.namespace
          }
        : null
    })
    if (result.ok) {
      searchDecision = result.data.decision
      searchItems = result.data.items
      denialReason = result.data.denial_reason
      policyDecisionId = result.data.policy_decision_id
      correlationId = result.data.correlation_id
    } else {
      return errorModel(route, query, memoryErrorMessage(result.error), namespaces, selectedNamespace)
    }
  }

  const conversations = messagesResult.data.messages.map(normalizeConversationMessage)
  return {
    loadState: 'ready',
    route,
    conversations,
    namespaces,
    selectedNamespace,
    query,
    searchDecision,
    searchItems,
    denialReason,
    policyDecisionId,
    correlationId,
    error: null,
    actions: buildActionStates(route, selectedNamespace)
  }
}

export function emptyMemoryViewModel(route: RouteAvailability, query = ''): MemoryViewModel {
  return {
    loadState: 'loading',
    route,
    conversations: [],
    namespaces: [],
    selectedNamespace: null,
    query,
    searchDecision: 'not-requested',
    searchItems: [],
    denialReason: null,
    policyDecisionId: null,
    correlationId: null,
    error: null,
    actions: buildActionStates(route, null)
  }
}

export function MemoryView({ client, route, initialModel, initialQuery = '' }: MemoryViewProps) {
  const [model, setModel] = useState<MemoryViewModel>(() => initialModel ?? emptyMemoryViewModel(route, initialQuery))
  const [query, setQuery] = useState(initialModel?.query ?? initialQuery)
  const [namespace, setNamespace] = useState(initialModel?.selectedNamespace?.info.namespace ?? '')
  const canSearch = model.actions.search.supported && !model.actions.search.disabled

  useEffect(() => {
    if (initialModel) return
    void refresh({ namespace: null, query: initialQuery })
  }, [initialModel, initialQuery, route])

  async function refresh(options: BuildMemoryViewModelOptions = {}) {
    setModel((current) => ({ ...current, loadState: 'loading' }))
    const next = await buildMemoryViewModel(client, route, {
      namespace: options.namespace ?? (namespace || null),
      query: options.query ?? query
    })
    setModel(next)
    setNamespace(next.selectedNamespace?.info.namespace ?? '')
    setQuery(next.query)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSearch) return
    void refresh({ namespace, query })
  }

  return (
    <section className="flex flex-col gap-5" aria-labelledby="memory-title">
      <PageHeader
        eyebrow="Memory"
        title="Memory & Knowledge"
        description="Conversation history, knowledge collections, and retention. See what is saved on this device and what comes from a connected Aurora device."
        id="memory-title"
      />

      <LocalDataMemoryPanel />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Collections from Connected Aurora device</h2>
        {model.namespaces.length === 0 ? (
          <Card ariaLabel="Memory collections">
            <div className="flex flex-col gap-1 py-1 text-sm">
              <strong className="font-medium">No collections yet</strong>
              <span className="text-muted-foreground">Collections appear after conversations, approved context, or imported knowledge are saved.</span>
            </div>
          </Card>
        ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Memory collections">
          {model.namespaces.map((candidate) => {
            const active = candidate.info.namespace === model.selectedNamespace?.info.namespace
            return (
              <button
                key={candidate.info.namespace}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setNamespace(candidate.info.namespace)
                  void refresh({ namespace: candidate.info.namespace, query })
                }}
                className={cn(
                  'flex flex-col gap-3 rounded-xl border bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors',
                  active ? 'border-primary' : 'border-border hover:border-foreground/30'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Database size={14} aria-hidden className="text-primary" />
                    {namespaceCollectionTitle(candidate)}
                  </span>
                  <PrivacyBadge privacy={normalizeRagPrivacyClass(candidate.info.policy.privacy_class)} />
                </div>
                <p className="text-2xl leading-none font-semibold">{recordCountLabel(candidate.info.record_count)}</p>
                <span className="text-[11.5px] text-muted-foreground">{namespaceStoreLabel(candidate)}</span>
              </button>
            )
          })}
        </div>
        )}
      </div>

      <Card flush ariaLabel="Memory list">
        <form className="flex items-center gap-2 border-b border-border px-4 py-3" onSubmit={onSubmit}>
          <Search size={15} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Search conversations</span>
          <Input
            id="memory-query"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            disabled={!canSearch || model.loadState === 'loading'}
            aria-label="Search conversations"
            placeholder="Search conversations…"
            className="h-7 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          <button type="submit" className="sr-only" disabled={!canSearch || query.trim().length === 0 || model.loadState === 'loading'}>
            Search
          </button>
        </form>

        {model.error ? (
          <p className="border-b border-border px-4 py-3 text-sm text-destructive" role="alert">
            {productMemoryErrorCopy(model.error)}
          </p>
        ) : null}
        {model.denialReason ? (
          <p className="border-b border-border px-4 py-3 text-sm text-destructive" role="alert">
            {productMemoryErrorCopy(model.denialReason)}
          </p>
        ) : null}

        {model.searchItems.length > 0 ? (
          <div className="flex flex-col divide-y divide-border">
            {model.searchItems.map((item) => (
              <MemoryResultCard
                key={`${item.namespace}:${item.key}`}
                item={item}
                namespace={model.namespaces.find((candidate) => candidate.info.namespace === item.namespace) ?? null}
              />
            ))}
          </div>
        ) : model.conversations.length === 0 ? (
          <div className="flex flex-col gap-1 px-4 py-6 text-sm">
            <strong className="font-medium">No conversations yet</strong>
            <span className="text-muted-foreground">Saved conversations will appear here.</span>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {model.conversations.map((message) => (
              <article key={message.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{message.content}</p>
                  <p className="font-mono text-[11.5px] text-muted-foreground">
                    {message.role} · {message.createdAt ?? 'Time not reported'} · {message.source}
                  </p>
                </div>
                <PrivacyBadge privacy={message.privacyClass} />
                <Button variant="ghost" disabled={model.actions.delete.disabled} disabledReason={productMemoryActionReasonCopy(model.actions.delete.reason)} ariaLabel="Delete conversation" icon={<Trash2 size={15} />}>
                  <span className="sr-only">Delete</span>
                </Button>
              </article>
            ))}
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">Deleting a memory previews affected saved records before removal.</p>
    </section>
  )
}

function MemoryResultCard({ item, namespace }: { item: DBRAGProvenanceItem; namespace: MemoryNamespaceView | null }) {
  const text = typeof item.value === 'string' ? item.value : JSON.stringify(item.value)
  return (
    <article className="flex flex-col gap-2 px-4 py-3">
      <header className="flex items-center gap-2">
        <strong className="text-[13px] font-medium">Saved result</strong>
        {item.redacted ? <Badge variant="destructive">Redacted</Badge> : null}
      </header>
      <p className="text-sm">{text}</p>
      <MetaGrid
        items={[
          { label: 'Collection', value: productMemoryCollectionCopy(item.namespace) },
          { label: 'Source', value: productMemorySourceCopy(item.provenance.source_peer_id) },
          {
            label: 'Saved through',
            value: item.provenance.owner_peer_id === item.provenance.source_peer_id
              ? 'owning device'
              : 'shared device'
          },
          { label: 'Privacy class', value: productMemoryPrivacyCopy(namespace?.info.policy.privacy_class) },
          { label: 'Citation', value: productReferenceCopy(item.provenance.record_id) },
          { label: 'Policy', value: productReferenceCopy(item.provenance.policy_decision_id) },
          { label: 'History', value: productReferenceCopy(item.provenance.correlation_id) },
          { label: 'Saved state', value: item.provenance.tombstone ? 'Deleted' : 'Active' }
        ]}
      />
      {item.redaction_reasons.length > 0 ? <small className="text-xs text-muted-foreground">Sensitive details hidden</small> : null}
    </article>
  )
}

function namespaceCollectionTitle(namespace: MemoryNamespaceView): string {
  const name = namespace.info.namespace
    .split(/[.:]/)
    .filter(Boolean)
    .at(-1) ?? namespace.info.namespace
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function recordCountLabel(count: number | null): string {
  return count === null ? 'Unknown records' : `${count.toLocaleString()} records`
}

function namespaceStoreLabel(namespace: MemoryNamespaceView): string {
  if (namespace.kind === 'local-memory') return 'Saved on this device'
  if (namespace.kind === 'local-rag') return 'Knowledge on this device'
  if (namespace.kind === 'imported-snapshot') return 'Imported snapshot'
  if (namespace.kind === 'remote-peer') return 'Shared by another device'
  if (namespace.kind === 'stale') return 'Shared device needs refresh'
  if (namespace.kind === 'denied') return 'Access denied by policy'
  return 'Store pending'
}

function namespaceView(info: DBRAGNamespaceInfo): MemoryNamespaceView {
  const kind = namespaceKind(info)
  const prefix = kind === 'local-memory'
    ? 'Local memory'
    : kind === 'local-rag'
        ? 'Local knowledge'
      : kind === 'imported-snapshot'
        ? 'Imported snapshot'
        : kind === 'remote-peer'
          ? 'Shared device'
          : kind
  const selectable = info.availability === 'available' && info.policy.allowed_operations.includes('search')
  return {
    info,
    kind,
    label: `${prefix}: ${info.namespace}`,
    selectable,
    stateCopy: `${info.availability}; ${info.policy.sharing_mode}; ${info.policy.privacy_class}`,
    repairCopy: namespaceRepairCopy(info)
  }
}

function namespaceKind(info: DBRAGNamespaceInfo): MemoryNamespaceKind {
  if (info.availability === 'stale') return 'stale'
  if (info.availability === 'denied') return 'denied'
  if (info.availability === 'unavailable') return 'unavailable'
  if (info.namespace.startsWith('imports.') || info.namespace.includes('.import')) return 'imported-snapshot'
  if (info.source_peer_id !== 'local-peer' || (info.provider_peer_id && info.provider_peer_id !== 'local-peer')) return 'remote-peer'
  if (info.namespace.includes('rag')) return 'local-rag'
  return 'local-memory'
}

function namespaceRepairCopy(info: DBRAGNamespaceInfo): string | null {
  if (info.policy.denial_reason) return info.policy.denial_reason
  if (info.availability === 'stale') return 'Refresh this shared device before selecting this collection.'
  if (info.availability === 'denied') return 'Policy denied access to this namespace.'
  if (info.policy.explicit_selector_required) return 'Choose the shared device or collection before searching.'
  if (info.embedding_model?.includes('legacy')) return 'Embedding compatibility must be checked before search.'
  return null
}

function buildActionStates(route: RouteAvailability, namespace: MemoryNamespaceView | null): MemoryViewModel['actions'] {
  const routeBlocked = route.disabled
  const policy = namespace?.info.policy ?? null
  return {
    search: {
      supported: Boolean(namespace),
      disabled: routeBlocked || !namespace?.selectable,
      label: 'Search',
      reason: routeBlocked
        ? `Route unavailable: ${presentableSignal(route.blockers.join(', ') || route.state)}`
        : namespace?.selectable
          ? 'Search uses Aurora.'
          : namespace?.repairCopy ?? 'Namespace is not selectable.'
          ,
      requiresAdminAction: false
    },
    export: actionState('Export snapshot', Boolean(policy?.export_supported), routeBlocked, Boolean(policy?.requires_admin_approval), policy?.denial_reason ?? null),
    delete: actionState('Delete record', Boolean(policy?.delete_supported), routeBlocked, true, policy?.denial_reason ?? null),
    importPreview: actionState('Import preview', Boolean(policy?.import_supported), routeBlocked, Boolean(policy?.requires_admin_approval), policy?.denial_reason ?? null)
  }
}

function actionState(
  label: string,
  supported: boolean,
  routeBlocked: boolean,
  requiresAdminAction: boolean,
  denialReason: string | null
): MemoryActionState {
  const reason = !supported
    ? `${label} unsupported for this namespace.`
    : routeBlocked
      ? `${label} disabled until the memory route is available.`
      : requiresAdminAction
        ? `${label} requires administrator or sharing approval.`
        : `${label} supported by policy.`
  return {
    supported,
    disabled: !supported || routeBlocked || requiresAdminAction || Boolean(denialReason),
    label,
    reason: denialReason ?? reason,
    requiresAdminAction
  }
}

function errorModel(
  route: RouteAvailability,
  query: string,
  error: string,
  namespaces: MemoryNamespaceView[] = [],
  selectedNamespace: MemoryNamespaceView | null = null
): MemoryViewModel {
  return {
    ...emptyMemoryViewModel(route, query),
    loadState: 'error',
    namespaces,
    selectedNamespace,
    error,
    actions: buildActionStates(route, selectedNamespace)
  }
}

function memoryErrorMessage(error: AuroraError): string {
  if (error.code === 'auth' || error.code === 'permission') return 'Memory request denied. Review access and try again.'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'Memory is unavailable for this Aurora setup.'
  if (error.code === 'privacy_blocked') return 'Memory access is blocked until selector, consent, or policy approval exists.'
  if (error.code === 'timeout') return 'Memory request timed out before Aurora responded.'
  return safeErrorCopy(error).title
}

function productMemoryErrorCopy(value: string): string {
  if (/permission|denied|access/i.test(value)) return 'Memory request denied. Review access and try again.'
  if (/timeout/i.test(value)) return 'Memory request timed out before Aurora responded.'
  return 'Memory is unavailable. Try again.'
}

function productMemorySourceCopy(value: string | null | undefined): string {
  return value === 'local-peer' || !value ? 'This device' : 'Shared device'
}

function productReferenceCopy(value: string | null | undefined): string {
  return value ? 'Available in account history' : 'Not reported'
}

function productMemoryCollectionCopy(value: string | null | undefined): string {
  return value ? 'Selected collection' : 'Not reported'
}

function productMemoryPrivacyCopy(value: string | null | undefined): string {
  if (value === 'raw-audio') return 'Audio'
  if (value === 'personal') return 'Personal'
  if (value === 'sensitive') return 'Sensitive'
  return 'Not reported for this collection'
}

function productMemoryActionReasonCopy(value: string): string {
  if (/permission|denied|blocked|auth/i.test(value)) return 'Review access before continuing.'
  if (/unsupported|unavailable|offline|missing/i.test(value)) return 'This action is unavailable right now.'
  return value ? 'This action is unavailable right now.' : value
}
