'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Download, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
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
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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
  const [isRefreshing, setIsRefreshing] = useState(false)
  const canSearch = model.actions.search.supported && !model.actions.search.disabled

  useEffect(() => {
    if (initialModel) return
    void refresh({ namespace: null, query: initialQuery })
  }, [initialModel, initialQuery])

  async function refresh(options: BuildMemoryViewModelOptions = {}) {
    setIsRefreshing(true)
    setModel((current) => ({ ...current, loadState: 'loading' }))
    const next = await buildMemoryViewModel(client, route, {
      namespace: options.namespace ?? (namespace || null),
      query: options.query ?? query
    })
    setModel(next)
    setNamespace(next.selectedNamespace?.info.namespace ?? '')
    setQuery(next.query)
    setIsRefreshing(false)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSearch) return
    void refresh({ namespace, query })
  }

  const selectedPrivacy = model.selectedNamespace
    ? normalizeRagPrivacyClass(model.selectedNamespace.info.policy.privacy_class)
    : route.item.privacyClass
  const statusCopy = useMemo(() => memoryStatusCopy(model), [model])

  return (
    <section className="aui-memory" aria-labelledby="memory-title">
      <header className="aui-memory-header">
        <div>
          <p className="aui-kicker">Memory</p>
          <h1 id="memory-title">History and RAG provenance</h1>
          <p>{statusCopy}</p>
        </div>
        <div className="aui-assistant-badges" aria-label="Memory backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={selectedPrivacy} />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={client.transport.kind} />
          {model.correlationId ? <EvidenceBadge label={`audit ${model.correlationId}`} /> : null}
        </div>
      </header>

      <form className="aui-memory-search" onSubmit={onSubmit}>
        <label htmlFor="memory-namespace">Namespace</label>
        <select
          id="memory-namespace"
          value={namespace}
          onChange={(event) => setNamespace(event.currentTarget.value)}
          disabled={model.loadState === 'loading'}
        >
          {model.namespaces.length === 0 ? <option value="">No namespace reported</option> : null}
          {model.namespaces.map((candidate) => (
            <option key={candidate.info.namespace} value={candidate.info.namespace}>
              {candidate.label}
            </option>
          ))}
        </select>

        <label htmlFor="memory-query">Search</label>
        <input
          id="memory-query"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          disabled={!canSearch || model.loadState === 'loading'}
          placeholder={canSearch ? 'Search memory and RAG...' : model.actions.search.reason}
        />
        <button type="submit" disabled={!canSearch || query.trim().length === 0 || model.loadState === 'loading'}>
          <Search size={16} aria-hidden />
          <span>Search</span>
        </button>
        <button type="button" disabled={isRefreshing} onClick={() => void refresh({ namespace, query })}>
          <RefreshCw size={16} aria-hidden />
          <span>Refresh</span>
        </button>
      </form>

      {model.error ? <p className="aui-memory-alert" role="alert">{model.error}</p> : null}
      {model.denialReason ? <p className="aui-memory-alert" role="alert">{model.denialReason}</p> : null}

      <div className="aui-memory-grid">
        <section className="aui-memory-panel" aria-labelledby="memory-namespaces-title">
          <h2 id="memory-namespaces-title">Namespaces</h2>
          <div className="aui-namespace-list">
            {model.namespaces.map((candidate) => (
              <button
                key={candidate.info.namespace}
                type="button"
                className={candidate.info.namespace === model.selectedNamespace?.info.namespace ? 'active' : ''}
                onClick={() => {
                  setNamespace(candidate.info.namespace)
                  void refresh({ namespace: candidate.info.namespace, query })
                }}
              >
                <strong>{candidate.label}</strong>
                <span>{candidate.stateCopy}</span>
                {candidate.repairCopy ? <em>{candidate.repairCopy}</em> : null}
              </button>
            ))}
          </div>
        </section>

        <section className="aui-memory-panel" aria-labelledby="memory-results-title" aria-live="polite">
          <h2 id="memory-results-title">Search results</h2>
          {model.searchItems.length === 0 ? (
            <div className="aui-memory-empty">
              <strong>{model.searchDecision === 'not-requested' ? 'Search has not run' : 'No visible results'}</strong>
              <span>{model.searchDecision === 'not-requested' ? 'Submit a query to ask the backend for provenance-backed records.' : model.denialReason ?? 'The backend returned no records for this namespace.'}</span>
            </div>
          ) : (
            <div className="aui-memory-results">
              {model.searchItems.map((item) => <MemoryResultCard key={`${item.namespace}:${item.key}`} item={item} />)}
            </div>
          )}
        </section>

        <section className="aui-memory-panel" aria-labelledby="memory-history-title">
          <h2 id="memory-history-title">Conversation history</h2>
          {model.conversations.length === 0 ? (
            <div className="aui-memory-empty">
              <strong>No conversations reported</strong>
              <span>History remains empty until DB.GetMessages returns backend rows.</span>
            </div>
          ) : (
            <div className="aui-conversation-list">
              {model.conversations.map((message) => (
                <article key={message.id}>
                  <header>
                    <strong>{message.role}</strong>
                    <PrivacyBadge privacy={message.privacyClass} />
                  </header>
                  <p>{message.content}</p>
                  <span>{message.createdAt ?? 'time not reported'} / {message.source}</span>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="aui-memory-panel" aria-labelledby="memory-actions-title">
          <h2 id="memory-actions-title">Data controls</h2>
          <MemoryActionButton icon="download" action={model.actions.export} />
          <MemoryActionButton icon="trash" action={model.actions.delete} />
          <MemoryActionButton icon="upload" action={model.actions.importPreview} />
          <dl className="aui-memory-facts">
            <div><dt>Policy</dt><dd>{model.selectedNamespace?.info.policy.sharing_mode ?? 'none'}</dd></div>
            <div><dt>Provider</dt><dd>{model.selectedNamespace?.info.provider_peer_id ?? 'not reported'}</dd></div>
            <div><dt>Source peer</dt><dd>{model.selectedNamespace?.info.source_peer_id ?? 'not reported'}</dd></div>
            <div><dt>Policy decision</dt><dd>{model.policyDecisionId ?? 'pending search'}</dd></div>
            <div><dt>Correlation</dt><dd>{model.correlationId ?? 'pending search'}</dd></div>
          </dl>
        </aside>
      </div>
    </section>
  )
}

function MemoryResultCard({ item }: { item: DBRAGProvenanceItem }) {
  const text = typeof item.value === 'string' ? item.value : JSON.stringify(item.value)
  return (
    <article className="aui-memory-result">
      <header>
        <strong>{item.key}</strong>
        {item.redacted ? <span className="aui-badge aui-badge-privacy-blocked">redacted</span> : null}
      </header>
      <p>{text}</p>
      <dl className="aui-memory-facts">
        <div><dt>Namespace</dt><dd>{item.namespace}</dd></div>
        <div><dt>Peer/provider</dt><dd>{item.provenance.source_peer_id}</dd></div>
        <div><dt>Route path</dt><dd>{item.provenance.owner_peer_id === item.provenance.source_peer_id ? 'owner peer' : `${item.provenance.source_peer_id} -> ${item.provenance.owner_peer_id}`}</dd></div>
        <div><dt>Citation</dt><dd>{item.provenance.record_id}</dd></div>
        <div><dt>Policy</dt><dd>{item.provenance.policy_decision_id}</dd></div>
        <div><dt>Audit</dt><dd>{item.provenance.correlation_id}</dd></div>
        <div><dt>Tombstone</dt><dd>{item.provenance.tombstone ? item.provenance.delete_reason ?? 'deleted' : 'active'}</dd></div>
      </dl>
      {item.redaction_reasons.length > 0 ? <small>{item.redaction_reasons.join(', ')}</small> : null}
    </article>
  )
}

function MemoryActionButton({ action, icon }: { action: MemoryActionState; icon: 'download' | 'trash' | 'upload' }) {
  const Icon = icon === 'download' ? Download : icon === 'trash' ? Trash2 : Upload
  return (
    <button className="aui-memory-action" type="button" disabled={action.disabled} title={action.reason}>
      <Icon size={16} aria-hidden />
      <span>{action.label}</span>
    </button>
  )
}

function namespaceView(info: DBRAGNamespaceInfo): MemoryNamespaceView {
  const kind = namespaceKind(info)
  const prefix = kind === 'local-memory'
    ? 'Local memory'
    : kind === 'local-rag'
      ? 'Local RAG'
      : kind === 'imported-snapshot'
        ? 'Imported snapshot'
        : kind === 'remote-peer'
          ? 'Remote peer'
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
  if (info.availability === 'stale') return 'Refresh peer manifest before selecting this namespace.'
  if (info.availability === 'denied') return 'Policy denied access to this namespace.'
  if (info.policy.explicit_selector_required) return 'Explicit peer/resource selector required.'
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
        ? `Route unavailable: ${route.blockers.join(', ') || route.state}`
        : namespace?.selectable
          ? 'Search uses DB.RAGSearchRemote through AuroraClient.'
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
        ? `${label} requires AdminAction or data-sharing approval.`
        : `${label} supported by backend policy.`
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

function memoryStatusCopy(model: MemoryViewModel): string {
  if (model.loadState === 'loading') return 'Loading conversation and namespace evidence from AuroraClient.'
  if (model.loadState === 'error') return model.error ?? 'Memory data could not be loaded.'
  if (!model.selectedNamespace) return 'No memory namespace was reported by the backend.'
  if (model.searchDecision === 'denied') return 'Backend policy denied this namespace search.'
  if (model.searchDecision === 'unavailable') return 'Selected namespace is unavailable or stale.'
  return 'Browse conversations, select a namespace, and inspect provenance before any data action.'
}

function memoryErrorMessage(error: AuroraError): string {
  if (error.code === 'auth' || error.code === 'permission') return 'Memory request denied by authentication or permissions.'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'Memory and RAG contracts are unavailable in this backend.'
  if (error.code === 'privacy_blocked') return 'Memory access is blocked until selector, consent, or policy approval exists.'
  if (error.code === 'timeout') return 'Memory request timed out before backend evidence arrived.'
  return error.message || 'Memory request failed.'
}
