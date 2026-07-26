'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RefreshCw, Waypoints } from 'lucide-react'
import {
  AUTH_METHODS,
  GATEWAY_METHODS,
  routePath,
  type AuroraClient,
  type CallableFeatureContract,
  type CapabilityCatalogResponse,
  type ConfigDiffEntry,
  type ConfigFieldMetadata,
  type GetRegistryResponse,
  type GetServicesResponse,
  type JsonObject,
  type JsonValue,
  type MeshPeerListResponse,
  type MeshStatusResponse,
  type ServiceInfo,
} from '@aurora/client'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card'
import { Checkbox } from '#components/ui/checkbox'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Switch } from '#components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { meshPeerErrorMessage } from './mesh-peers-view'
import type { RouteAvailability } from './shell-data'

export type ServiceRoutingLoadState = 'loading' | 'ready' | 'degraded' | 'unavailable'
export type ServiceRoutingProviderMode = 'any' | 'selected' | 'none'

interface ServiceRoutingTarget {
  id: string
  label: string
  basePath: string
  registryModules: string[]
}

const SERVICE_ROUTING_TARGETS: ServiceRoutingTarget[] = [
  { id: 'orchestrator', label: 'Orchestrator', basePath: 'services.orchestrator', registryModules: ['orchestrator'] },
  { id: 'db', label: 'Memory & RAG', basePath: 'services.db', registryModules: ['db'] },
  { id: 'tooling', label: 'Tooling', basePath: 'services.tooling', registryModules: ['tooling'] },
  { id: 'scheduler', label: 'Scheduler', basePath: 'services.scheduler', registryModules: ['scheduler'] },
  { id: 'tts', label: 'Text to speech', basePath: 'services.tts', registryModules: ['tts'] },
  { id: 'stt-coordinator', label: 'STT coordinator', basePath: 'services.stt.coordinator', registryModules: ['sttcoordinator', 'coordinator', 'stt'] },
  { id: 'stt-wakeword', label: 'STT wake word', basePath: 'services.stt.wakeword', registryModules: ['sttwakeword', 'wakeword'] },
  { id: 'stt-transcription', label: 'STT transcription', basePath: 'services.stt.transcription', registryModules: ['stttranscription', 'transcription'] },
]

export const SERVICE_ROUTING_PREFER_OPTIONS = ['local', 'network', 'local_only', 'network_only'] as const
export const SERVICE_ROUTING_FALLBACK_OPTIONS = ['local', 'network', 'error', 'none'] as const

export interface ServiceRoutingExportPolicy {
  share: boolean
  maxConcurrent: number
  unsharedFeatureIds: string[]
  unsharedMethodIds: string[]
}

export interface ServiceRoutingOutboundPolicy {
  prefer: string
  fallback: string
  allowedProviderPeerIds: string[] | null
  minVersion: string | null
  requiredProviderFeatureIds: string[]
  requiredProviderCapabilityTags: string[]
  requireExplicitSelector: boolean
}

export interface ServiceRoutingFeatureMethod {
  topic: string
  label: string
  summary: string
}

export interface ServiceRoutingFeatureOption {
  featureId: string
  label: string
  summary: string
  methods: ServiceRoutingFeatureMethod[]
  stale: boolean
}

export interface ServiceRoutingOption {
  id: string
  label: string
  stale: boolean
}

export interface ServiceRoutingRow {
  id: string
  label: string
  basePath: string
  sharingPath: string
  routingPath: string
  registryStatus: string
  registryVersion: string | null
  registered: boolean
  exportPolicy: ServiceRoutingExportPolicy
  routingPolicy: ServiceRoutingOutboundPolicy
  exportFeatures: ServiceRoutingFeatureOption[]
  ungroupedMethods: ServiceRoutingFeatureMethod[]
  staleMethodIds: string[]
  providerOptions: ServiceRoutingOption[]
  remoteFeatureOptions: ServiceRoutingOption[]
  remoteCapabilityTagOptions: ServiceRoutingOption[]
}

export interface ServiceRoutingKnownPeer {
  peerId: string
  label: string
}

export interface ServiceRoutingSnapshot {
  loadState: ServiceRoutingLoadState
  rows: ServiceRoutingRow[]
  knownPeers: ServiceRoutingKnownPeer[]
  editable: boolean
  registryMode: string | null
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface ServiceRoutingChange {
  keyPath: string
  value: JsonValue
}

export interface ServiceRoutingResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface ServiceRoutingViewProps {
  snapshot: ServiceRoutingSnapshot
  pendingRowId?: string | null
  mutationError?: string | null
  onRefresh?: () => void
  onPreviewRow?: (row: ServiceRoutingRow, changes: ServiceRoutingChange[]) => Promise<ServiceRoutingPreviewEvidence>
  onSaveRow?: (row: ServiceRoutingRow, changes: ServiceRoutingChange[], preview: ServiceRoutingPreviewEvidence, confirmation: ServiceRoutingSaveConfirmation) => void
}

export interface ServiceRoutingSaveConfirmation { reauthConfirmed: boolean }

export interface ServiceRoutingPreviewEvidence {
  valid: boolean
  diffs: ConfigDiffEntry[]
  errors: string[]
  baseRevision: number | null
  previewToken: string | null
  changedPaths: string[]
  secretsRedacted: boolean
}

interface ServiceRoutingReviewState {
  generation: number
  changes: ServiceRoutingChange[]
  status: 'loading' | 'ready' | 'error'
  evidence: ServiceRoutingPreviewEvidence | null
  error: string | null
  reauthConfirmed: boolean
}

export interface ServiceRoutingRowDraft {
  share: boolean
  maxConcurrent: string
  unsharedFeatureIds: string[]
  unsharedMethodIds: string[]
  prefer: string
  fallback: string
  providerMode: ServiceRoutingProviderMode
  selectedProviderPeerIds: string[]
  minVersion: string
  requiredProviderFeatureIds: string[]
  requiredProviderCapabilityTags: string[]
  requireExplicitSelector: boolean
}

const loadingSnapshot: ServiceRoutingSnapshot = {
  loadState: 'loading',
  rows: [],
  knownPeers: [],
  editable: false,
  registryMode: null,
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls',
}

export function ServiceRoutingResource({ client, route }: ServiceRoutingResourceProps) {
  const [snapshot, setSnapshot] = useState<ServiceRoutingSnapshot>(loadingSnapshot)
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const routeKey = [route.item.id, route.state, route.disabled ? 'disabled' : 'enabled'].join('|')
  const stableRoute = useMemo(() => route, [routeKey])

  const load = useCallback(async () => {
    setSnapshot(loadingSnapshot)
    setSnapshot(await buildServiceRoutingSnapshot(client, stableRoute))
  }, [client, stableRoute])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildServiceRoutingSnapshot(client, stableRoute).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, stableRoute])

  const previewRow = useCallback(
    async (_row: ServiceRoutingRow, changes: ServiceRoutingChange[]) => previewServiceRoutingChanges(client, changes),
    [client.config],
  )

  const saveRow = useCallback(
    async (row: ServiceRoutingRow, changes: ServiceRoutingChange[], preview: ServiceRoutingPreviewEvidence, confirmation: ServiceRoutingSaveConfirmation) => {
      if (changes.length === 0) return
      setPendingRowId(row.id)
      setMutationError(null)
      try {
        await commitServiceRoutingChanges(client, row, changes, preview, confirmation)
        await load()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        setPendingRowId(null)
      }
    },
    [client.config, load],
  )

  return <ServiceRoutingView snapshot={snapshot} pendingRowId={pendingRowId} mutationError={mutationError} onRefresh={load} onPreviewRow={previewRow} onSaveRow={saveRow} />
}

export async function previewServiceRoutingChanges(client: AuroraClient, changes: ServiceRoutingChange[]): Promise<ServiceRoutingPreviewEvidence> {
  const configChanges = changes.map((change) => ({ key_path: change.keyPath, value: change.value }))
  const result = await client.config.previewDiff({ changes: configChanges })
  if (!result.ok) throw new Error(meshPeerErrorMessage(result.error))
  return {
    valid: result.data.valid,
    diffs: result.data.diffs,
    errors: result.data.errors,
    baseRevision: typeof result.data.base_revision === 'number' ? result.data.base_revision : null,
    previewToken: result.data.preview_token || null,
    changedPaths: result.data.changed_paths,
    secretsRedacted: result.data.secrets_redacted,
  }
}

export async function commitServiceRoutingChanges(client: AuroraClient, row: ServiceRoutingRow, changes: ServiceRoutingChange[], preview: ServiceRoutingPreviewEvidence, confirmation: ServiceRoutingSaveConfirmation): Promise<void> {
  if (confirmation.reauthConfirmed !== true) throw new Error('Explicit reauthentication confirmation is required before saving service policy changes.')
  const configChanges = changes.map((change) => ({ key_path: change.keyPath, value: change.value }))
  if (!preview.valid) {
    throw new Error(preview.errors.join('; ') || 'Service policy change was not valid.')
  }
  if (typeof preview.baseRevision !== 'number' || !preview.previewToken) {
    throw new Error('Config preview did not return the revision token required for an atomic save.')
  }
  const committed = await client.config.commitChangeSet({
    request: {
      changes: configChanges,
      base_revision: preview.baseRevision,
      preview_token: preview.previewToken,
    },
    reason: `Update ${row.label} service sharing and outbound routing`,
    reauthConfirmed: confirmation.reauthConfirmed,
  })
  if (!committed.data.success) {
    const reason = committed.data.error_code === 'config_revision_conflict'
      ? 'Configuration changed since preview. Refresh and review before saving again.'
      : committed.data.error || committed.data.error_code || 'Atomic service policy save failed.'
    throw new Error(reason)
  }
}

export async function buildServiceRoutingSnapshot(client: AuroraClient, route: RouteAvailability): Promise<ServiceRoutingSnapshot> {
  const [registryResult, servicesResult, configResult, metadataResult, catalogResult, meshStatusResult, peersResult] = await Promise.allSettled([
    withSnapshotTimeout(client.registry.getRegistry(), 'full service registry'),
    withSnapshotTimeout(client.registry.listServices(), 'service registry status'),
    withSnapshotTimeout(client.config.get({ section: 'services' }), 'service config'),
    withSnapshotTimeout(client.config.getSchemaMetadata({ include_values: false }), 'config metadata'),
    withSnapshotTimeout(client.capabilities.listCatalog({ include_unavailable: true }), 'recipient capability catalog'),
    withSnapshotTimeout(client.requestResult<MeshStatusResponse, JsonObject>(GATEWAY_METHODS.getMeshStatus, {}, { path: routePath('Gateway', 'GetMeshStatus'), timeoutMs: 8_000 }), 'mesh status'),
    withSnapshotTimeout(client.requestResult<MeshPeerListResponse, JsonObject>(AUTH_METHODS.meshListPeers, { include_disconnected: true }, { path: routePath('Auth', 'MeshListPeers'), timeoutMs: 5_000 }), 'mesh peers'),
  ])
  const registry = fulfilled(registryResult)
  const services = fulfilled(servicesResult)
  const configResponse = fulfilledOk(configResult)
  const config = (configResponse?.config as JsonObject | undefined) ?? null
  const metadata = fulfilledOk(metadataResult)
  const metadataFields: ConfigFieldMetadata[] = metadata?.fields ?? []
  const catalog = fulfilled(catalogResult)
  const meshStatus = fulfilledOk(meshStatusResult)
  const persistedPeers = fulfilledOk(peersResult)?.peers ?? []
  const warnings = [
    rejectedWarning(registryResult, 'full service registry'),
    rejectedWarning(servicesResult, 'service registry status'),
    rejectedWarning(configResult, 'service config'),
    rejectedWarning(metadataResult, 'config metadata'),
    rejectedWarning(catalogResult, 'recipient capability catalog'),
    rejectedWarning(meshStatusResult, 'mesh status'),
  ].filter((message): message is string => Boolean(message))

  if (route.disabled || (!registry && !services && !config)) {
    return {
      ...loadingSnapshot,
      loadState: 'unavailable',
      warnings,
      error: route.disabled ? 'Gateway routing capability is unavailable for this route.' : 'Service registry and configuration are both unreachable.',
      evidenceSource: 'Aurora request error',
    }
  }

  const knownPeerMap = new Map<string, string>()
  for (const peer of meshStatus?.peers ?? []) knownPeerMap.set(peer.peer_id, peer.node_name || peer.peer_id)
  for (const peer of persistedPeers) if (!knownPeerMap.has(peer.peer_id)) knownPeerMap.set(peer.peer_id, peer.node_name || peer.peer_id)
  for (const provider of catalog?.providers ?? []) {
    if (isRemoteProvider(provider.peer_id, provider.provider_kind) && provider.peer_id && !knownPeerMap.has(provider.peer_id)) {
      knownPeerMap.set(provider.peer_id, provider.node_name || provider.peer_id)
    }
  }
  const knownPeers = [...knownPeerMap.entries()]
    .map(([peerId, label]) => ({ peerId, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.peerId.localeCompare(b.peerId))

  const g010MetadataReady = supportsG010Metadata(metadataFields)
  if (metadata && !g010MetadataReady) warnings.push('Service sharing/routing schema metadata is legacy or incomplete; editing is disabled until the split policy contract is available.')
  const rows = SERVICE_ROUTING_TARGETS.map((target) => buildRow(target, config, metadataFields, registry, services, catalog, meshStatus, knownPeerMap))
  return {
    loadState: warnings.length > 0 ? 'degraded' : 'ready',
    rows,
    knownPeers,
    editable: metadata !== null && g010MetadataReady,
    registryMode: services?.mode ?? null,
    warnings,
    error: null,
    evidenceSource: 'Gateway registry, recipient capability catalog, mesh status, peers, and Config service responses',
  }
}

function buildRow(
  target: ServiceRoutingTarget,
  config: JsonObject | null,
  metadataFields: ConfigFieldMetadata[],
  registry: GetRegistryResponse | null,
  services: GetServicesResponse | null,
  catalog: CapabilityCatalogResponse | null,
  meshStatus: MeshStatusResponse | null,
  peerLabels: Map<string, string>,
): ServiceRoutingRow {
  const registered = matchRegistryService(target.registryModules, services?.services ?? [])
  const registryModule = matchRegistryModule(target.registryModules, registry)
  const sharingPath = `${target.basePath}.mesh_sharing`
  const routingPath = `${target.basePath}.mesh_routing`
  const exportPolicy = readExportPolicy(config, sharingPath, metadataFields)
  const routingPolicy = readOutboundPolicy(config, routingPath, metadataFields)
  const exportProjection = buildExportFeatures(registryModule, exportPolicy)
  const remoteOptions = buildRemoteOptions(target.registryModules, catalog, meshStatus, routingPolicy, peerLabels)
  return {
    id: target.id,
    label: target.label,
    basePath: target.basePath,
    sharingPath,
    routingPath,
    registryStatus: registered?.status ?? 'not registered',
    registryVersion: registered?.version ?? registryModule?.version ?? null,
    registered: Boolean(registered || registryModule),
    exportPolicy,
    routingPolicy,
    exportFeatures: exportProjection.features,
    ungroupedMethods: exportProjection.ungroupedMethods,
    staleMethodIds: exportProjection.staleMethodIds,
    providerOptions: remoteOptions.providers,
    remoteFeatureOptions: remoteOptions.features,
    remoteCapabilityTagOptions: remoteOptions.tags,
  }
}

function readExportPolicy(config: JsonObject | null, path: string, metadataFields: ConfigFieldMetadata[]): ServiceRoutingExportPolicy {
  const block = readBlock(config, path)
  const defaults = metadataDefaults(metadataFields, path)
  return {
    share: readBoolean(block.share ?? defaults.get('share'), false),
    maxConcurrent: readNumber(block.max_concurrent ?? defaults.get('max_concurrent'), 10),
    unsharedFeatureIds: stringList(block.unshared_feature_ids ?? defaults.get('unshared_feature_ids')),
    unsharedMethodIds: stringList(block.unshared_method_ids ?? defaults.get('unshared_method_ids')),
  }
}

function readOutboundPolicy(config: JsonObject | null, path: string, metadataFields: ConfigFieldMetadata[]): ServiceRoutingOutboundPolicy {
  const block = readBlock(config, path)
  const defaults = metadataDefaults(metadataFields, path)
  const rawProviders = block.allowed_provider_peer_ids ?? defaults.get('allowed_provider_peer_ids')
  return {
    prefer: readString(block.prefer ?? defaults.get('prefer'), 'local'),
    fallback: readString(block.fallback ?? defaults.get('fallback'), 'local'),
    allowedProviderPeerIds: rawProviders === null ? null : Array.isArray(rawProviders) ? uniqueStrings(rawProviders) : null,
    minVersion: nullableString(block.min_version ?? defaults.get('min_version')),
    requiredProviderFeatureIds: stringList(block.required_provider_feature_ids ?? defaults.get('required_provider_feature_ids')),
    requiredProviderCapabilityTags: stringList(block.required_provider_capability_tags ?? defaults.get('required_provider_capability_tags')),
    requireExplicitSelector: readBoolean(block.require_explicit_selector ?? defaults.get('require_explicit_selector'), false),
  }
}

function buildExportFeatures(
  module: GetRegistryResponse['modules'][number] | null,
  policy: ServiceRoutingExportPolicy,
): { features: ServiceRoutingFeatureOption[]; ungroupedMethods: ServiceRoutingFeatureMethod[]; staleMethodIds: string[] } {
  const methods = (module?.methods ?? []).filter((method) => (method.exposure === 'external' || method.exposure === 'both') && method.bus_topic)
  const methodMap = new Map(methods.map((method) => [method.bus_topic!, method]))
  const features: ServiceRoutingFeatureOption[] = (module?.callable_features ?? []).map((feature) => ({
    featureId: feature.feature_id,
    label: feature.label || feature.feature_id,
    summary: feature.summary,
    methods: feature.method_ids
      .map((topic) => methodMap.get(topic))
      .filter((method): method is NonNullable<typeof method> => Boolean(method))
      .map((method) => ({ topic: method.bus_topic!, label: method.name, summary: method.summary })),
    stale: false,
  }))
  const knownFeatures = new Set(features.map((feature) => feature.featureId))
  for (const featureId of policy.unsharedFeatureIds) {
    if (!knownFeatures.has(featureId)) features.push({ featureId, label: featureId, summary: 'Configured feature is not present in the current registry.', methods: [], stale: true })
  }
  const staleMethodIds = policy.unsharedMethodIds.filter((topic) => !methodMap.has(topic)).sort()
  const groupedTopics = new Set((module?.callable_features ?? []).flatMap((feature) => feature.method_ids))
  const ungroupedMethods = methods
    .filter((method) => !groupedTopics.has(method.bus_topic!))
    .map((method) => ({ topic: method.bus_topic!, label: method.name, summary: method.summary }))
    .sort((a, b) => a.topic.localeCompare(b.topic))
  return { features: features.sort((a, b) => a.label.localeCompare(b.label)), ungroupedMethods, staleMethodIds }
}

function buildRemoteOptions(
  registryModules: string[],
  catalog: CapabilityCatalogResponse | null,
  meshStatus: MeshStatusResponse | null,
  policy: ServiceRoutingOutboundPolicy,
  peerLabels: Map<string, string>,
): { providers: ServiceRoutingOption[]; features: ServiceRoutingOption[]; tags: ServiceRoutingOption[] } {
  const featureLabels = new Map<string, string>()
  const tags = new Set<string>()
  const providerPeerIds = new Set<string>()
  for (const provider of catalog?.providers ?? []) {
    if (matchesModule(provider.module, registryModules) && isRemoteProvider(provider.peer_id, provider.provider_kind) && provider.peer_id) providerPeerIds.add(provider.peer_id)
  }
  for (const peer of meshStatus?.peers ?? []) {
    for (const service of peer.services) {
      if (matchesModule(service.module, registryModules)) for (const tag of service.capabilities) tags.add(tag)
    }
  }
  for (const action of catalog?.actions ?? []) {
    if (!matchesModule(action.module, registryModules) || !isRemoteProvider(action.peer_id, action.provider_kind)) continue
    if (action.peer_id) providerPeerIds.add(action.peer_id)
    for (const feature of action.callable_features ?? []) featureLabels.set(feature.feature_id, feature.label || feature.feature_id)
    for (const featureId of action.callable_feature_ids ?? []) if (!featureLabels.has(featureId)) featureLabels.set(featureId, featureId)
  }
  const configuredFeatures = new Set(policy.requiredProviderFeatureIds)
  const configuredTags = new Set(policy.requiredProviderCapabilityTags)
  const configuredProviders = new Set(policy.allowedProviderPeerIds ?? [])
  for (const peerId of configuredProviders) providerPeerIds.add(peerId)
  for (const id of configuredFeatures) if (!featureLabels.has(id)) featureLabels.set(id, id)
  for (const tag of configuredTags) tags.add(tag)
  return {
    providers: [...providerPeerIds].map((id) => ({ id, label: peerLabels.get(id) ?? id, stale: configuredProviders.has(id) && !remoteCatalogProviderExists(catalog, registryModules, id) })).sort(optionSort),
    features: [...featureLabels.entries()].map(([id, label]) => ({ id, label, stale: configuredFeatures.has(id) && !remoteCatalogFeatureExists(catalog, registryModules, id) })).sort(optionSort),
    tags: [...tags].map((id) => ({ id, label: id, stale: configuredTags.has(id) && !remoteManifestTagExists(meshStatus, registryModules, id) })).sort(optionSort),
  }
}

export function serviceRoutingProviderMode(value: string[] | null): ServiceRoutingProviderMode {
  if (value === null) return 'any'
  return value.length === 0 ? 'none' : 'selected'
}

export function serviceRoutingDraftFromRow(row: ServiceRoutingRow): ServiceRoutingRowDraft {
  return {
    share: row.exportPolicy.share,
    maxConcurrent: String(row.exportPolicy.maxConcurrent),
    unsharedFeatureIds: [...row.exportPolicy.unsharedFeatureIds].sort(),
    unsharedMethodIds: [...row.exportPolicy.unsharedMethodIds].sort(),
    prefer: row.routingPolicy.prefer,
    fallback: row.routingPolicy.fallback,
    providerMode: serviceRoutingProviderMode(row.routingPolicy.allowedProviderPeerIds),
    selectedProviderPeerIds: [...(row.routingPolicy.allowedProviderPeerIds ?? [])].sort(),
    minVersion: row.routingPolicy.minVersion ?? '',
    requiredProviderFeatureIds: [...row.routingPolicy.requiredProviderFeatureIds].sort(),
    requiredProviderCapabilityTags: [...row.routingPolicy.requiredProviderCapabilityTags].sort(),
    requireExplicitSelector: row.routingPolicy.requireExplicitSelector,
  }
}

export function serviceRoutingDraftChanges(row: ServiceRoutingRow, draft: ServiceRoutingRowDraft): ServiceRoutingChange[] {
  const original = serviceRoutingDraftFromRow(row)
  const changes: ServiceRoutingChange[] = []
  pushChange(changes, draft.share !== original.share, `${row.sharingPath}.share`, draft.share)
  if (draft.maxConcurrent !== original.maxConcurrent && validMaxConcurrency(draft.maxConcurrent)) {
    changes.push({ keyPath: `${row.sharingPath}.max_concurrent`, value: Number(draft.maxConcurrent) })
  }
  pushListChange(changes, draft.unsharedFeatureIds, original.unsharedFeatureIds, `${row.sharingPath}.unshared_feature_ids`)
  pushListChange(changes, draft.unsharedMethodIds, original.unsharedMethodIds, `${row.sharingPath}.unshared_method_ids`)
  pushChange(changes, draft.prefer !== original.prefer, `${row.routingPath}.prefer`, draft.prefer)
  pushChange(changes, draft.fallback !== original.fallback, `${row.routingPath}.fallback`, draft.fallback)
  const providerValue = draft.providerMode === 'any' ? null : draft.providerMode === 'none' ? [] : uniqueStrings(draft.selectedProviderPeerIds)
  if (!sameNullableList(providerValue, row.routingPolicy.allowedProviderPeerIds)) changes.push({ keyPath: `${row.routingPath}.allowed_provider_peer_ids`, value: providerValue })
  const minVersion = draft.minVersion.trim() || null
  pushChange(changes, minVersion !== row.routingPolicy.minVersion, `${row.routingPath}.min_version`, minVersion)
  pushListChange(changes, draft.requiredProviderFeatureIds, original.requiredProviderFeatureIds, `${row.routingPath}.required_provider_feature_ids`)
  pushListChange(changes, draft.requiredProviderCapabilityTags, original.requiredProviderCapabilityTags, `${row.routingPath}.required_provider_capability_tags`)
  pushChange(changes, draft.requireExplicitSelector !== original.requireExplicitSelector, `${row.routingPath}.require_explicit_selector`, draft.requireExplicitSelector)
  return changes
}

export function ServiceRoutingView({ snapshot, pendingRowId = null, mutationError = null, onRefresh, onPreviewRow, onSaveRow }: ServiceRoutingViewProps) {
  const [drafts, setDrafts] = useState<Record<string, ServiceRoutingRowDraft>>({})
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
  const [reviews, setReviews] = useState<Record<string, ServiceRoutingReviewState | undefined>>({})
  const reviewGenerations = useRef<Record<string, number>>({})
  useEffect(() => {
    setDrafts(Object.fromEntries(snapshot.rows.map((row) => [row.id, serviceRoutingDraftFromRow(row)])))
    setReviews({})
  }, [snapshot.rows])
  const readOnly = !snapshot.editable || !onPreviewRow || !onSaveRow || snapshot.loadState === 'loading' || snapshot.loadState === 'unavailable'
  const invalidateReview = (rowId: string) => {
    reviewGenerations.current[rowId] = (reviewGenerations.current[rowId] ?? 0) + 1
    setReviews((current) => ({ ...current, [rowId]: undefined }))
  }
  const reviewRow = async (row: ServiceRoutingRow, changes: ServiceRoutingChange[]) => {
    const generation = (reviewGenerations.current[row.id] ?? 0) + 1
    reviewGenerations.current[row.id] = generation
    setReviews((current) => ({ ...current, [row.id]: { generation, changes, status: 'loading', evidence: null, error: null, reauthConfirmed: false } }))
    try {
      const evidence = await onPreviewRow?.(row, changes)
      if (!evidence) throw new Error('Config preview is unavailable.')
      setReviews((current) => {
        const active = current[row.id]
        return active?.status === 'loading' && active.generation === generation
          ? { ...current, [row.id]: { generation, changes, status: 'ready', evidence, error: null, reauthConfirmed: false } }
          : current
      })
    } catch (error) {
      setReviews((current) => {
        const active = current[row.id]
        return active?.status === 'loading' && active.generation === generation
          ? { ...current, [row.id]: { generation, changes, status: 'error', evidence: null, error: meshPeerErrorMessage(error), reauthConfirmed: false } }
          : current
      })
    }
  }
  const confirmRow = (row: ServiceRoutingRow) => {
    const review = reviews[row.id]
    if (!review?.evidence || !review.reauthConfirmed || !review.evidence.valid || review.evidence.baseRevision === null || !review.evidence.previewToken) return
    onSaveRow?.(row, review.changes, review.evidence, { reauthConfirmed: review.reauthConfirmed })
  }

  return (
    <Card aria-labelledby="service-routing-title">
      <CardHeader>
        <CardTitle id="service-routing-title" className="flex items-center gap-2"><Waypoints /> Service sharing and outbound routing</CardTitle>
        <CardDescription>
          Control what this device shares separately from where this device sends work. Routing provider choices never grant inbound access; peer RBAC remains authoritative.
        </CardDescription>
        <CardAction><Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={snapshot.loadState === 'loading'}><RefreshCw data-icon="inline-start" /> Refresh</Button></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Service policy evidence summary"><Badge variant="outline">{friendlyLoadState(snapshot.loadState)}</Badge><span>{snapshot.rows.length} service policies</span><span className="text-muted-foreground">Evidence: {snapshot.evidenceSource}</span></div>
        <div aria-live="polite" className="empty:hidden">
          {mutationError ? <p className="text-sm text-destructive">Service policy update failed: {mutationError}</p> : null}
          {snapshot.error ? <p className="text-sm text-destructive">{snapshot.error}</p> : null}
          {snapshot.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
          {readOnly && snapshot.loadState !== 'loading' ? <p className="text-xs text-muted-foreground">Service policies are read-only right now{snapshot.editable ? '' : ' (config metadata unavailable)'}.</p> : null}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader><TableRow><TableHead>Service</TableHead><TableHead>Status</TableHead><TableHead>Shared</TableHead><TableHead>Outbound preference</TableHead><TableHead>Fallback</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {snapshot.rows.map((row) => {
                const draft = drafts[row.id] ?? serviceRoutingDraftFromRow(row)
                const changes = serviceRoutingDraftChanges(row, draft)
                const pending = pendingRowId === row.id
                const expanded = expandedRowId === row.id
                const disabled = readOnly || pending
                const updateDraft = (patch: Partial<ServiceRoutingRowDraft>) => { invalidateReview(row.id); setDrafts((current) => ({ ...current, [row.id]: { ...draft, ...patch } })) }
                return <ServiceRoutingTableRow key={row.id} row={row} draft={draft} knownPeers={snapshot.knownPeers} dirty={changes.length > 0} pending={pending} disabled={disabled} expanded={expanded} review={reviews[row.id]} onToggleExpanded={() => setExpandedRowId(expanded ? null : row.id)} onDraftChange={updateDraft} onReview={() => { void reviewRow(row, changes) }} onCancelReview={() => invalidateReview(row.id)} onReauthChange={(checked) => setReviews((current) => current[row.id] ? ({ ...current, [row.id]: { ...current[row.id]!, reauthConfirmed: checked } }) : current)} onConfirm={() => confirmRow(row)} />
              })}
              {snapshot.loadState === 'loading' && snapshot.rows.length === 0 ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Loading service sharing and routing policy through Aurora…</TableCell></TableRow> : null}
              {snapshot.loadState !== 'loading' && snapshot.rows.length === 0 ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No mesh-capable service policies were found.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </div>
        <div className="grid gap-3 md:hidden" aria-label="Mobile service policy cards">
          {snapshot.rows.map((row) => {
            const draft = drafts[row.id] ?? serviceRoutingDraftFromRow(row)
            const changes = serviceRoutingDraftChanges(row, draft)
            const pending = pendingRowId === row.id
            const expanded = expandedRowId === row.id
            const disabled = readOnly || pending
            const updateDraft = (patch: Partial<ServiceRoutingRowDraft>) => { invalidateReview(row.id); setDrafts((current) => ({ ...current, [row.id]: { ...draft, ...patch } })) }
            return <ServiceRoutingMobileCard key={row.id} row={row} draft={draft} changes={changes} pending={pending} disabled={disabled} expanded={expanded} review={reviews[row.id]} onToggleExpanded={() => setExpandedRowId(expanded ? null : row.id)} onDraftChange={updateDraft} onReview={() => { void reviewRow(row, changes) }} onCancelReview={() => invalidateReview(row.id)} onReauthChange={(checked) => setReviews((current) => current[row.id] ? ({ ...current, [row.id]: { ...current[row.id]!, reauthConfirmed: checked } }) : current)} onConfirm={() => confirmRow(row)} />
          })}
          {snapshot.loadState === 'loading' && snapshot.rows.length === 0 ? <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">Loading service sharing and routing policy through Aurora…</p> : null}
          {snapshot.loadState !== 'loading' && snapshot.rows.length === 0 ? <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">No mesh-capable service policies were found.</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ServiceRoutingTableRow({ row, draft, knownPeers: _knownPeers, dirty, pending, disabled, expanded, review, onToggleExpanded, onDraftChange, onReview, onCancelReview, onReauthChange, onConfirm }: { row: ServiceRoutingRow; draft: ServiceRoutingRowDraft; knownPeers: ServiceRoutingKnownPeer[]; dirty: boolean; pending: boolean; disabled: boolean; expanded: boolean; review: ServiceRoutingReviewState | undefined; onToggleExpanded: () => void; onDraftChange: (patch: Partial<ServiceRoutingRowDraft>) => void; onReview: () => void; onCancelReview: () => void; onReauthChange: (checked: boolean) => void; onConfirm: () => void }) {
  const selectedModeInvalid = draft.providerMode === 'selected' && draft.selectedProviderPeerIds.length === 0
  const maxInvalid = !validMaxConcurrency(draft.maxConcurrent)
  const detailsId = `desktop-${row.id}-details`
  return (
    <>
      <TableRow data-state={dirty ? 'selected' : undefined}>
        <TableCell><button type="button" className="flex items-start gap-1.5 text-left" onClick={onToggleExpanded} aria-expanded={expanded} aria-controls={detailsId} aria-label={`Toggle service sharing and outbound routing for ${row.label}`}><ChevronDown className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} /><span className="flex min-w-36 flex-col"><span className="text-sm font-medium">{row.label}</span><code className="truncate font-mono text-[10.5px] text-muted-foreground">{row.basePath.replace(/^services\./, '')}{row.registryVersion ? ` · v${row.registryVersion}` : ''}</code></span></button></TableCell>
        <TableCell><ServiceStatusBadge status={row.registryStatus} registered={row.registered} /></TableCell>
        <TableCell><Switch checked={draft.share} disabled={disabled} aria-label={`Share ${row.label} from this device`} onCheckedChange={(checked) => onDraftChange({ share: Boolean(checked) })} /></TableCell>
        <TableCell><PolicySelect value={draft.prefer} options={SERVICE_ROUTING_PREFER_OPTIONS} disabled={disabled} ariaLabel={`Outbound routing preference for ${row.label}`} onChange={(prefer) => onDraftChange({ prefer })} /></TableCell>
        <TableCell><PolicySelect value={draft.fallback} options={SERVICE_ROUTING_FALLBACK_OPTIONS} disabled={disabled} ariaLabel={`Outbound fallback for ${row.label}`} onChange={(fallback) => onDraftChange({ fallback })} /></TableCell>
        <TableCell className="text-right"><Button type="button" size="sm" disabled={disabled || !dirty || selectedModeInvalid || maxInvalid} onClick={onReview}>{pending ? 'Saving…' : 'Review changes'}</Button></TableCell>
      </TableRow>
      {review ? <TableRow><TableCell colSpan={6}><ChangeReview review={review} pending={pending} onCancel={onCancelReview} onReauthChange={onReauthChange} onConfirm={onConfirm} /></TableCell></TableRow> : null}
      {expanded ? <TableRow id={detailsId} className="hover:bg-transparent"><TableCell colSpan={6} className="bg-muted/30" style={{ whiteSpace: 'normal' }}><div className="grid gap-5 py-2 lg:grid-cols-2">
        <section aria-labelledby={`${row.id}-sharing-heading`} className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3">
          <div><h3 id={`${row.id}-sharing-heading`} className="text-sm font-semibold">Shared from this device</h3><p className="text-[11px] text-muted-foreground">Sharing includes future external methods by default. Uncheck a callable feature or exact method to exclude it.</p></div>
          <Label className="flex items-center justify-between gap-3 text-[12.5px] font-normal normal-case tracking-normal"><span>Share service to mesh</span><Switch checked={draft.share} disabled={disabled} aria-label={`Share ${row.label} service to mesh`} onCheckedChange={(checked) => onDraftChange({ share: Boolean(checked) })} /></Label>
          <Label className="flex items-center justify-between gap-3 text-[12.5px] font-normal normal-case tracking-normal"><span>Maximum concurrent remote calls</span><Input className="h-8 w-20 text-right" type="number" min={0} step={1} value={draft.maxConcurrent} disabled={disabled} aria-invalid={maxInvalid} aria-label={`Maximum concurrent remote calls for ${row.label}`} onChange={(event) => onDraftChange({ maxConcurrent: event.currentTarget.value })} /></Label>{maxInvalid ? <p className="text-xs text-destructive">Maximum concurrency must be a nonnegative integer.</p> : null}
          <div className="flex flex-col gap-2">{row.exportFeatures.map((feature) => <FeatureExportControl key={feature.featureId} feature={feature} draft={draft} disabled={disabled} onDraftChange={onDraftChange} />)}{row.exportFeatures.length === 0 ? <p className="text-xs text-muted-foreground">No callable feature contracts are available for this service.</p> : null}</div>
          {row.ungroupedMethods.length > 0 ? <ExactMethodControls title="Other callable methods" methods={row.ungroupedMethods} draft={draft} disabled={disabled} onDraftChange={onDraftChange} /> : null}
          {row.staleMethodIds.filter((topic) => draft.unsharedMethodIds.includes(topic)).map((topic) => <div key={topic} className="flex items-center justify-between gap-2 rounded border border-amber-500/40 px-2 py-1 text-xs"><span><code>{topic}</code> <Badge variant="outline">stale configured method</Badge></span><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onDraftChange({ unsharedMethodIds: draft.unsharedMethodIds.filter((id) => id !== topic) })}>Remove exclusion</Button></div>)}
        </section>
        <section aria-labelledby={`${row.id}-routing-heading`} className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-3">
          <div><h3 id={`${row.id}-routing-heading`} className="text-sm font-semibold">Route requests through peers</h3><p className="text-[11px] text-muted-foreground">Allowed routing providers control where this device sends work. They grant no inbound access.</p></div>
          <div className="grid gap-2 sm:grid-cols-2"><PolicySelect value={draft.prefer} options={SERVICE_ROUTING_PREFER_OPTIONS} disabled={disabled} ariaLabel={`Routing preference for ${row.label}`} onChange={(prefer) => onDraftChange({ prefer })} /><PolicySelect value={draft.fallback} options={SERVICE_ROUTING_FALLBACK_OPTIONS} disabled={disabled} ariaLabel={`Fallback strategy for ${row.label}`} onChange={(fallback) => onDraftChange({ fallback })} /></div>
          <fieldset className="flex flex-col gap-2"><legend className="text-[12.5px] font-medium">Allowed routing providers</legend>{(['any', 'selected', 'none'] as const).map((mode) => <Label key={mode} className="flex items-center gap-2 text-[12.5px] font-normal normal-case tracking-normal"><input type="radio" name={`${row.id}-provider-mode`} value={mode} checked={draft.providerMode === mode} disabled={disabled} onChange={() => onDraftChange({ providerMode: mode })} /><span>{mode === 'any' ? 'Any eligible provider' : mode === 'selected' ? 'Selected providers' : 'None (disable remote providers)'}</span></Label>)}</fieldset>
          {draft.providerMode === 'selected' ? <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">{row.providerOptions.map((peer) => <Label key={peer.id} className="flex items-center gap-2 text-[12.5px] font-normal normal-case tracking-normal"><Checkbox checked={draft.selectedProviderPeerIds.includes(peer.id)} disabled={disabled} onCheckedChange={() => onDraftChange({ selectedProviderPeerIds: toggleListValue(draft.selectedProviderPeerIds, peer.id) })} /><span className="min-w-0"><span className="block truncate">{peer.label}</span>{peer.label !== peer.id ? <code className="block truncate font-mono text-[10px] text-muted-foreground">{peer.id}</code> : null}</span>{peer.stale ? <Badge variant="outline">stale</Badge> : null}</Label>)}{row.providerOptions.length === 0 ? <p className="text-xs text-muted-foreground">No recipient-projected providers are available for this service.</p> : null}{selectedModeInvalid ? <p className="text-xs text-destructive">Select at least one provider, or choose Any or None.</p> : null}</div> : null}
          <Label className="flex flex-col gap-1 text-[12.5px] font-normal normal-case tracking-normal"><span>Minimum provider version</span><Input value={draft.minVersion} disabled={disabled} placeholder="Any compatible version" aria-label={`Minimum provider version for ${row.label}`} onChange={(event) => onDraftChange({ minVersion: event.currentTarget.value })} /></Label>
          <OptionChecklist title="Required callable features" description="Every selected feature must be complete in the recipient-projected remote manifest." options={row.remoteFeatureOptions} selected={draft.requiredProviderFeatureIds} disabled={disabled} onToggle={(id) => onDraftChange({ requiredProviderFeatureIds: toggleListValue(draft.requiredProviderFeatureIds, id) })} />
          <OptionChecklist title="Required provider capability tags" description="All selected hardware or implementation tags must be advertised; tags do not grant method access." options={row.remoteCapabilityTagOptions} selected={draft.requiredProviderCapabilityTags} disabled={disabled} onToggle={(id) => onDraftChange({ requiredProviderCapabilityTags: toggleListValue(draft.requiredProviderCapabilityTags, id) })} />
          <Label className="flex items-center justify-between gap-3 text-[12.5px] font-normal normal-case tracking-normal"><span><span className="block">Require explicit selector</span><span className="block text-[11px] text-muted-foreground">Callers must name a peer before routing remotely.</span></span><Switch checked={draft.requireExplicitSelector} disabled={disabled} aria-label={`Require explicit selector for ${row.label}`} onCheckedChange={(checked) => onDraftChange({ requireExplicitSelector: Boolean(checked) })} /></Label>
        </section>
      </div></TableCell></TableRow> : null}
    </>
  )
}

function ServiceRoutingMobileCard({ row, draft, changes, pending, disabled, expanded, review, onToggleExpanded, onDraftChange, onReview, onCancelReview, onReauthChange, onConfirm }: { row: ServiceRoutingRow; draft: ServiceRoutingRowDraft; changes: ServiceRoutingChange[]; pending: boolean; disabled: boolean; expanded: boolean; review: ServiceRoutingReviewState | undefined; onToggleExpanded: () => void; onDraftChange: (patch: Partial<ServiceRoutingRowDraft>) => void; onReview: () => void; onCancelReview: () => void; onReauthChange: (checked: boolean) => void; onConfirm: () => void }) {
  const maxInvalid = !validMaxConcurrency(draft.maxConcurrent)
  const selectedInvalid = draft.providerMode === 'selected' && draft.selectedProviderPeerIds.length === 0
  const detailsId = `mobile-${row.id}-details`
  return <article className="flex flex-col gap-3 rounded-xl border border-border p-3"><header className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{row.label}</h3><ServiceStatusBadge status={row.registryStatus} registered={row.registered} /></div><Button type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={expanded} aria-controls={detailsId} onClick={onToggleExpanded}>{expanded ? 'Hide details' : 'Edit policy'}</Button></header><div className="grid gap-2"><Label className="flex items-center justify-between text-sm font-normal normal-case tracking-normal"><span>Shared from this device</span><Switch checked={draft.share} disabled={disabled} aria-label={`Share ${row.label} from this device on mobile`} onCheckedChange={(checked) => onDraftChange({ share: Boolean(checked) })} /></Label><PolicySelect value={draft.prefer} options={SERVICE_ROUTING_PREFER_OPTIONS} disabled={disabled} ariaLabel={`Mobile outbound routing preference for ${row.label}`} onChange={(prefer) => onDraftChange({ prefer })} /></div>{expanded ? <div id={detailsId} className="flex flex-col gap-4"><section className="flex flex-col gap-2"><h4 className="text-sm font-semibold">Shared from this device</h4><Label className="flex items-center justify-between text-xs font-normal normal-case tracking-normal"><span>Maximum concurrent remote calls</span><Input className="h-8 w-20" type="number" min={0} step={1} value={draft.maxConcurrent} aria-invalid={maxInvalid} disabled={disabled} onChange={(event) => onDraftChange({ maxConcurrent: event.currentTarget.value })} /></Label>{maxInvalid ? <p className="text-xs text-destructive">Maximum concurrency must be a nonnegative integer.</p> : null}{row.exportFeatures.map((feature) => <FeatureExportControl key={feature.featureId} feature={feature} draft={draft} disabled={disabled} onDraftChange={onDraftChange} />)}{row.ungroupedMethods.length ? <ExactMethodControls title="Other callable methods" methods={row.ungroupedMethods} draft={draft} disabled={disabled} onDraftChange={onDraftChange} /> : null}{row.staleMethodIds.filter((topic) => draft.unsharedMethodIds.includes(topic)).map((topic) => <div key={topic} className="flex items-center justify-between gap-2 rounded border border-amber-500/40 p-2 text-xs"><code>{topic}</code><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onDraftChange({ unsharedMethodIds: draft.unsharedMethodIds.filter((id) => id !== topic) })}>Remove exclusion</Button></div>)}</section><section className="flex flex-col gap-2"><h4 className="text-sm font-semibold">Route requests through peers</h4><PolicySelect value={draft.fallback} options={SERVICE_ROUTING_FALLBACK_OPTIONS} disabled={disabled} ariaLabel={`Mobile fallback for ${row.label}`} onChange={(fallback) => onDraftChange({ fallback })} /><fieldset className="flex flex-col gap-1"><legend className="text-xs font-medium">Allowed routing providers</legend>{(['any', 'selected', 'none'] as const).map((mode) => <Label key={mode} className="flex gap-2 text-xs font-normal normal-case tracking-normal"><input type="radio" name={`mobile-${row.id}-providers`} value={mode} disabled={disabled} checked={draft.providerMode === mode} onChange={() => onDraftChange({ providerMode: mode })} />{mode === 'any' ? 'Any eligible provider' : mode === 'selected' ? 'Selected providers' : 'None (disable remote providers)'}</Label>)}</fieldset>{draft.providerMode === 'selected' ? row.providerOptions.map((peer) => <Label key={peer.id} className="flex items-center gap-2 text-xs font-normal normal-case tracking-normal"><Checkbox checked={draft.selectedProviderPeerIds.includes(peer.id)} disabled={disabled} onCheckedChange={() => onDraftChange({ selectedProviderPeerIds: toggleListValue(draft.selectedProviderPeerIds, peer.id) })} />{peer.label}{peer.label !== peer.id ? <code>{peer.id}</code> : null}{peer.stale ? <Badge variant="outline">stale</Badge> : null}</Label>) : null}{selectedInvalid ? <p className="text-xs text-destructive">Select at least one provider, or choose Any or None.</p> : null}<Input value={draft.minVersion} disabled={disabled} placeholder="Minimum provider version" onChange={(event) => onDraftChange({ minVersion: event.currentTarget.value })} /><OptionChecklist title="Required callable features" description="All selected features must be complete." options={row.remoteFeatureOptions} selected={draft.requiredProviderFeatureIds} disabled={disabled} onToggle={(id) => onDraftChange({ requiredProviderFeatureIds: toggleListValue(draft.requiredProviderFeatureIds, id) })} /><OptionChecklist title="Required provider capability tags" description="All selected tags must be advertised." options={row.remoteCapabilityTagOptions} selected={draft.requiredProviderCapabilityTags} disabled={disabled} onToggle={(id) => onDraftChange({ requiredProviderCapabilityTags: toggleListValue(draft.requiredProviderCapabilityTags, id) })} /><Label className="flex items-center justify-between text-xs font-normal normal-case tracking-normal">Require explicit selector<Switch checked={draft.requireExplicitSelector} disabled={disabled} onCheckedChange={(checked) => onDraftChange({ requireExplicitSelector: Boolean(checked) })} /></Label></section></div> : null}{review ? <ChangeReview review={review} pending={pending} onCancel={onCancelReview} onReauthChange={onReauthChange} onConfirm={onConfirm} /> : <Button type="button" disabled={disabled || changes.length === 0 || maxInvalid || selectedInvalid} onClick={onReview}>Review changes</Button>}</article>
}

function ChangeReview({ review, pending, onCancel, onReauthChange, onConfirm }: { review: ServiceRoutingReviewState; pending: boolean; onCancel: () => void; onReauthChange: (checked: boolean) => void; onConfirm: () => void }) {
  const evidenceReady = review.status === 'ready' && review.evidence?.valid === true && review.evidence.baseRevision !== null && Boolean(review.evidence.previewToken)
  return <div role="region" aria-label="Authoritative service policy change preview" className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3">
    <div><p className="text-sm font-semibold">Review {review.changes.length} atomic change{review.changes.length === 1 ? '' : 's'}</p><p className="text-xs text-muted-foreground">No configuration has been written. Aurora Config must validate this exact change set before confirmation.</p></div>
    {review.status === 'loading' ? <p className="text-xs text-muted-foreground">Loading authoritative Config.PreviewDiff evidence…</p> : null}
    {review.error ? <p role="alert" className="text-xs text-destructive">Preview failed: {review.error}</p> : null}
    {review.evidence ? <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-2"><Badge variant="outline">{review.evidence.valid ? 'Preview valid' : 'Preview invalid'}</Badge><span>Base revision: {review.evidence.baseRevision ?? 'missing'}</span><span>Preview token: {review.evidence.previewToken ? 'present' : 'missing'}</span></div>
      {review.evidence.errors.length ? <ul className="list-inside list-disc text-destructive">{review.evidence.errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
      <ul className="flex flex-col gap-1">{review.evidence.diffs.map((diff) => <li key={diff.key_path} className="rounded border border-border p-2"><code>{diff.key_path}</code><span className="block text-muted-foreground">{diff.secret ? 'Secret value redacted' : `${previewValue(diff.old_value)} → ${previewValue(diff.new_value)}`}</span><span className="block">{diff.reload_required ? 'Reload required' : 'No reload required'}{diff.restart_required ? ' · restart required' : ''}</span></li>)}</ul>
      {review.evidence.diffs.length === 0 ? <p className="text-muted-foreground">Aurora reported no effective configuration differences.</p> : null}
    </div> : null}
    <Label className="flex items-start gap-2 text-xs font-normal normal-case tracking-normal"><Checkbox checked={review.reauthConfirmed} disabled={pending || review.status !== 'ready'} onCheckedChange={(checked) => onReauthChange(Boolean(checked))} /><span>I confirm recent in-session admin unlock and authorize this exact preview.</span></Label>
    <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={pending} onClick={onCancel}>Cancel</Button><Button type="button" size="sm" disabled={pending || !evidenceReady || !review.reauthConfirmed} onClick={onConfirm}>{pending ? 'Saving…' : 'Confirm and save atomically'}</Button></div>
  </div>
}

function ExactMethodControls({ title, methods, draft, disabled, onDraftChange }: { title: string; methods: ServiceRoutingFeatureMethod[]; draft: ServiceRoutingRowDraft; disabled: boolean; onDraftChange: (patch: Partial<ServiceRoutingRowDraft>) => void }) {
  return <div className="flex flex-col gap-1 rounded-lg border border-border p-2"><p className="text-xs font-medium">{title}</p>{methods.map((method) => <Label key={method.topic} className="flex items-center gap-2 text-xs font-normal normal-case tracking-normal"><Checkbox checked={!draft.unsharedMethodIds.includes(method.topic)} disabled={disabled} onCheckedChange={() => onDraftChange({ unsharedMethodIds: toggleListValue(draft.unsharedMethodIds, method.topic) })} /><span>{method.label}</span>{method.label !== method.topic ? <code className="text-[10px] text-muted-foreground">{method.topic}</code> : null}</Label>)}</div>
}

function FeatureExportControl({ feature, draft, disabled, onDraftChange }: { feature: ServiceRoutingFeatureOption; draft: ServiceRoutingRowDraft; disabled: boolean; onDraftChange: (patch: Partial<ServiceRoutingRowDraft>) => void }) {
  const shared = !draft.unsharedFeatureIds.includes(feature.featureId)
  return <div className="rounded-lg border border-border p-2"><Label className="flex items-start gap-2 text-[12.5px] font-normal normal-case tracking-normal"><Checkbox checked={shared} disabled={disabled} onCheckedChange={() => onDraftChange({ unsharedFeatureIds: toggleListValue(draft.unsharedFeatureIds, feature.featureId) })} /><span><span className="font-medium">{feature.label}</span>{feature.label !== feature.featureId ? <> <code className="text-[10px] text-muted-foreground">{feature.featureId}</code></> : null}{feature.stale ? <Badge className="ml-1" variant="outline">stale</Badge> : null}<span className="block text-[11px] text-muted-foreground">{feature.summary}</span></span></Label><div className="ml-6 mt-2 flex flex-col gap-1">{feature.methods.map((method) => <Label key={method.topic} className="flex items-start gap-2 text-[11.5px] font-normal normal-case tracking-normal"><Checkbox checked={!draft.unsharedMethodIds.includes(method.topic)} disabled={disabled || !shared} onCheckedChange={() => onDraftChange({ unsharedMethodIds: toggleListValue(draft.unsharedMethodIds, method.topic) })} /><span><span className="block">{method.label}</span>{method.label !== method.topic ? <code className="text-[10px] text-muted-foreground">{method.topic}</code> : null}</span></Label>)}</div></div>
}

function OptionChecklist({ title, description, options, selected, disabled, onToggle }: { title: string; description: string; options: ServiceRoutingOption[]; selected: string[]; disabled: boolean; onToggle: (id: string) => void }) {
  return <div className="flex flex-col gap-1.5"><div><p className="text-[12.5px] font-medium">{title}</p><p className="text-[11px] text-muted-foreground">{description}</p></div>{options.length === 0 ? <p className="rounded border border-border px-2 py-1 text-xs text-muted-foreground">No remote provider options are currently advertised.</p> : <div className="flex flex-col gap-1 rounded border border-border p-2">{options.map((option) => <Label key={option.id} className="flex items-center gap-2 text-[12px] font-normal normal-case tracking-normal"><Checkbox checked={selected.includes(option.id)} disabled={disabled} onCheckedChange={() => onToggle(option.id)} /><span>{option.label}</span>{option.label !== option.id ? <code className="text-[10px] text-muted-foreground">{option.id}</code> : null}{option.stale ? <Badge variant="outline">stale</Badge> : null}</Label>)}</div>}</div>
}

function ServiceStatusBadge({ status, registered }: { status: string; registered: boolean }) {
  const normalized = status.toLowerCase()
  const dotClass = !registered ? 'bg-muted-foreground/40' : normalized === 'healthy' ? 'bg-emerald-500' : normalized === 'degraded' ? 'bg-amber-500' : 'bg-destructive'
  return <Badge variant="outline" className="gap-1.5"><span aria-hidden className={`size-1.5 rounded-full ${dotClass}`} />{registered ? status : 'not registered'}</Badge>
}

function PolicySelect({ value, options, disabled, ariaLabel, onChange }: { value: string; options: readonly string[]; disabled: boolean; ariaLabel: string; onChange: (value: string) => void }) {
  const items = options.includes(value) ? options : [value, ...options]
  return <Select value={value} disabled={disabled} onValueChange={(next) => next && typeof next === 'string' && onChange(next)}><SelectTrigger size="sm" className="w-full" disabled={disabled} aria-label={ariaLabel}><SelectValue>{friendlyPolicyOption(value)}</SelectValue></SelectTrigger><SelectContent>{items.map((option) => <SelectItem key={option} value={option}>{friendlyPolicyOption(option)}</SelectItem>)}</SelectContent></Select>
}

function friendlyLoadState(state: ServiceRoutingLoadState): string { return state === 'ready' ? 'Ready' : state === 'degraded' ? 'Degraded evidence' : state === 'loading' ? 'Loading' : 'Unavailable' }
function friendlyPolicyOption(value: string): string {
  return ({ local: 'Prefer local', network: 'Prefer peers', local_only: 'Local only', network_only: 'Peers only', error: 'Return an error', none: 'No fallback' } as Record<string, string>)[value] ?? value.replace(/_/g, ' ')
}
function changeSummary(value: JsonValue): string { if (value === null) return 'Any eligible provider / unset'; if (Array.isArray(value)) return value.length ? `${value.length} selected value${value.length === 1 ? '' : 's'}` : 'None'; if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'; return String(value) }
function previewValue(value: JsonValue | undefined): string { return value === undefined ? 'unset' : changeSummary(value) }

const SNAPSHOT_CALL_TIMEOUT_MS = 9_000
function withSnapshotTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not respond within ${SNAPSHOT_CALL_TIMEOUT_MS}ms`)), SNAPSHOT_CALL_TIMEOUT_MS) })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

function fulfilled<T>(result: PromiseSettledResult<T>): T | null { return result.status === 'fulfilled' ? result.value : null }
function fulfilledOk<T>(result: PromiseSettledResult<{ ok: boolean; data?: T | null }>): T | null { return result.status === 'fulfilled' && result.value.ok ? result.value.data ?? null : null }
function rejectedWarning(result: PromiseSettledResult<unknown>, label: string): string | null { return result.status === 'rejected' ? `${label} unavailable: ${meshPeerErrorMessage(result.reason)}` : null }
function normalizeModule(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '') }
function matchesModule(module: string, candidates: string[]): boolean { return candidates.includes(normalizeModule(module)) }
function matchRegistryService(candidates: string[], services: ServiceInfo[]): ServiceInfo | null { return services.find((service) => matchesModule(service.module, candidates)) ?? null }
function matchRegistryModule(candidates: string[], registry: GetRegistryResponse | null): GetRegistryResponse['modules'][number] | null { return registry?.modules.find((module) => matchesModule(module.module, candidates)) ?? null }
function isRemoteProvider(peerId: string | null, providerKind: string): boolean { return Boolean(peerId) && providerKind !== 'local' }
function optionSort(a: ServiceRoutingOption, b: ServiceRoutingOption): number { return a.label.localeCompare(b.label) || a.id.localeCompare(b.id) }
function remoteCatalogFeatureExists(catalog: CapabilityCatalogResponse | null, modules: string[], id: string): boolean { return (catalog?.actions ?? []).some((action) => matchesModule(action.module, modules) && isRemoteProvider(action.peer_id, action.provider_kind) && ((action.callable_feature_ids ?? []).includes(id) || (action.callable_features ?? []).some((feature) => feature.feature_id === id))) }
function remoteCatalogProviderExists(catalog: CapabilityCatalogResponse | null, modules: string[], peerId: string): boolean { return (catalog?.providers ?? []).some((provider) => provider.peer_id === peerId && matchesModule(provider.module, modules) && isRemoteProvider(provider.peer_id, provider.provider_kind)) || (catalog?.actions ?? []).some((action) => action.peer_id === peerId && matchesModule(action.module, modules) && isRemoteProvider(action.peer_id, action.provider_kind)) }
function remoteManifestTagExists(meshStatus: MeshStatusResponse | null, modules: string[], id: string): boolean { return (meshStatus?.peers ?? []).some((peer) => peer.services.some((service) => matchesModule(service.module, modules) && service.capabilities.includes(id))) }
function readBlock(config: JsonObject | null, path: string): JsonObject { const value = config ? (readPath(config, path.replace(/^services\./, '')) ?? readPath(config, path)) : undefined; return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {} }
function metadataDefaults(fields: ConfigFieldMetadata[], path: string): Map<string, JsonValue | undefined> { return new Map(fields.filter((field) => field.key_path.startsWith(`${path}.`)).map((field) => [field.key_path.slice(path.length + 1), field.default])) }
function readPath(config: JsonObject, path: string): JsonValue | undefined { let current: unknown = config; for (const part of path.split('.')) { if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current)) return undefined; current = (current as Record<string, unknown>)[part] } return current as JsonValue }
function readBoolean(value: unknown, fallback: boolean): boolean { return typeof value === 'boolean' ? value : fallback }
function readString(value: unknown, fallback: string): string { return typeof value === 'string' && value ? value : fallback }
function nullableString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function readNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function uniqueStrings(value: readonly unknown[]): string[] { return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)).map((item) => item.trim()).filter(Boolean))].sort() }
function stringList(value: unknown): string[] { return Array.isArray(value) ? uniqueStrings(value) : [] }
function toggleListValue(list: string[], value: string): string[] { return list.includes(value) ? list.filter((item) => item !== value) : [...list, value].sort() }
function sameNullableList(a: string[] | null, b: string[] | null): boolean { return a === null || b === null ? a === b : uniqueStrings(a).join('\n') === uniqueStrings(b).join('\n') }
function pushChange(changes: ServiceRoutingChange[], changed: boolean, keyPath: string, value: JsonValue): void { if (changed) changes.push({ keyPath, value }) }
function pushListChange(changes: ServiceRoutingChange[], next: string[], original: string[], keyPath: string): void { if (uniqueStrings(next).join('\n') !== uniqueStrings(original).join('\n')) changes.push({ keyPath, value: uniqueStrings(next) }) }
function supportsG010Metadata(fields: ConfigFieldMetadata[]): boolean {
  const paths = new Set(fields.map((field) => field.key_path))
  return SERVICE_ROUTING_TARGETS.every((target) => [
    `${target.basePath}.mesh_sharing.share`,
    `${target.basePath}.mesh_sharing.max_concurrent`,
    `${target.basePath}.mesh_sharing.unshared_feature_ids`,
    `${target.basePath}.mesh_sharing.unshared_method_ids`,
    `${target.basePath}.mesh_routing.prefer`,
    `${target.basePath}.mesh_routing.fallback`,
    `${target.basePath}.mesh_routing.allowed_provider_peer_ids`,
    `${target.basePath}.mesh_routing.min_version`,
    `${target.basePath}.mesh_routing.required_provider_feature_ids`,
    `${target.basePath}.mesh_routing.required_provider_capability_tags`,
    `${target.basePath}.mesh_routing.require_explicit_selector`,
  ].every((path) => paths.has(path)))
}
export function validMaxConcurrency(value: string): boolean { return /^(0|[1-9]\d*)$/.test(value.trim()) }
