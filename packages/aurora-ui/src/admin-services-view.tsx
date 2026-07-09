'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, FileCode2, Lock } from 'lucide-react'
import {
  AuroraError,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilitySummary,
  type ContractExposure,
  type ContractMethodType,
  type GetServicesResponse,
  type MethodDescriptor,
  type PrivacyClass,
  type ServiceInfo
} from '@aurora/client'
import { Card as ShadCard } from '#components/ui/card'
import { Badge } from '#components/ui/badge'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '#components/ui/table'
import { HealthBadge, ToneBadge, type BadgeTone } from './status-badges'
import { ConfirmDialog } from './shared-components'
import { Button, Card, StatStrip, FilterBar } from './primitives'

export type AdminServicesLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export interface AdminServiceControlAction {
  title: string
  description: string
  methodId: string
  severity: 'medium' | 'high' | 'critical'
  serviceModule: string
  requiresReason: boolean
  requiresTypedPhrase: string | null
}

export interface AdminServiceControlPreview {
  verb: 'restart' | 'stop' | 'reload'
  methodId: string
  state: AvailabilityState
  available: boolean
  requiresAdminAction: boolean
  reason: string
  action: AdminServiceControlAction | null
}

export interface AdminServiceRow {
  module: string
  version: string
  summary: string
  capabilities: string[]
  methodCount: number
  lastSeen: string
  status: string
  healthState: AvailabilityState
  instanceId: string | null
  providerLabel: string
  routeState: AvailabilityState
  routeReason: string
  privacyClass: PrivacyClass
  methods: MethodDescriptor[]
  controls: AdminServiceControlPreview[]
}

export interface AdminContractRow extends MethodDescriptor {
  availability: AvailabilityState
  providerLabel: string
  backendCoverage: 'http' | 'internal-only' | 'missing-capability' | 'gateway-builtin'
  privacyClass: PrivacyClass
  routeReason: string
  liveRegistryStatus: 'live-registry' | 'registry-only' | 'capability-only'
  conformanceStatus: 'conformant' | 'internal-only' | 'missing-capability' | 'gateway-builtin'
  generatedRoutePath: string | null
  openApiState: string
  exportState: string
  schemaState: string
  capabilityPermissions: string[]
}

export interface AdminServicesSnapshot {
  loadState: AdminServicesLoadState
  servicesMode: string
  generatedAt: string | null
  secretsRedacted: boolean
  services: AdminServiceRow[]
  contracts: AdminContractRow[]
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminServicesViewProps {
  snapshot: AdminServicesSnapshot
  onPreviewAdminAction?: ((action: AdminServiceControlAction) => void) | undefined
}

export interface AdminServicesResourceProps {
  client: AuroraClient
  onPreviewAdminAction?: ((action: AdminServiceControlAction) => void) | undefined
}

const loadingSnapshot: AdminServicesSnapshot = {
  loadState: 'loading',
  servicesMode: 'pending',
  generatedAt: null,
  secretsRedacted: true,
  services: [],
  contracts: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls'
}

export function AdminServicesResource({ client, onPreviewAdminAction }: AdminServicesResourceProps) {
  const [snapshot, setSnapshot] = useState<AdminServicesSnapshot>(loadingSnapshot)

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildAdminServicesSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return <AdminServicesView snapshot={snapshot} onPreviewAdminAction={onPreviewAdminAction} />
}

export async function buildAdminServicesSnapshot(client: AuroraClient): Promise<AdminServicesSnapshot> {
  const [servicesResult, methodsResult, catalogResult] = await Promise.allSettled([
    client.registry.listServices(),
    client.registry.listMethods(),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true, include_schemas: true })
  ])

  const services = valueOrNull(servicesResult)
  const methods = valueOrNull(methodsResult) ?? []
  const catalog = valueOrNull(catalogResult)
  const failures = [
    failureMessage('services', servicesResult),
    failureMessage('contracts', methodsResult),
    failureMessage('capability catalog', catalogResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [servicesResult, methodsResult, catalogResult].some(isDeniedFailure)
  const summaries = catalog ? summarizeCapabilities(catalog) : []

  if (!services && methods.length === 0 && !catalog) {
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      error: failures.join(' ') || 'Aurora services and contract status are unavailable.',
      warnings: failures,
      evidenceSource: 'Aurora request error'
    }
  }

  const rows = buildServiceRows(services, methods, summaries)
  const contracts = buildContractRows(methods, summaries)
  const loadState: AdminServicesLoadState = denied
    ? 'denied'
    : failures.length > 0
      ? 'degraded'
      : rows.length === 0 && contracts.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    servicesMode: services?.mode ?? 'unknown',
    generatedAt: catalog?.generated_at ?? null,
    secretsRedacted: catalog?.secrets_redacted ?? true,
    services: rows,
    contracts,
    warnings: failures,
    error: failures[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local transport' : 'Aurora service response'
  }
}

export function AdminServicesView({ snapshot, onPreviewAdminAction }: AdminServicesViewProps) {
  const [pendingAction, setPendingAction] = useState<AdminServiceControlAction | null>(null)

  return (
    <div className="flex h-full flex-col" aria-labelledby="admin-services-title">
      <div className="border-b border-border px-6 py-5">
        <h1 id="admin-services-title" className="text-xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-muted-foreground">Backend service health and restart control. Admins only.</p>
      </div>
      <div className="flex flex-col gap-4 px-6 py-5">
        <StatusPanel snapshot={snapshot} />
        <ServiceCardGrid services={snapshot.services} onPreviewControl={setPendingAction} />
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.title ?? ''}
        description={pendingAction?.description ?? ''}
        confirmLabel="Restart"
        destructive={pendingAction?.severity === 'critical'}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction) onPreviewAdminAction?.(pendingAction)
          setPendingAction(null)
        }}
      />
    </div>
  )
}

export function AdminContractsResource({ client }: { client: AuroraClient }) {
  const [snapshot, setSnapshot] = useState<AdminServicesSnapshot>(loadingSnapshot)

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildAdminServicesSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return <AdminContractsView snapshot={snapshot} />
}

export function AdminContractsView({ snapshot }: { snapshot: AdminServicesSnapshot }) {
  const totals = useMemo(() => serviceTotals(snapshot.services), [snapshot.services])
  const state = snapshot.loadState

  return (
    <div className="flex flex-col gap-4" aria-labelledby="admin-contracts-title">
      <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
        <div>
          <h1 id="admin-contracts-title" className="text-xl font-semibold tracking-tight">Contracts registry</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Method exposure, Gateway routes, schemas, permissions, and conformance status are rendered from Gateway.GetRegistry plus capability catalog data. Service lifecycle controls stay on /admin/services.
          </p>
        </div>
        <div aria-label="Contracts registry status">
          <AvailabilityBadge state={state} />
        </div>
      </div>

      <div className="flex flex-col gap-4 px-6 pb-6">
        <StatusPanel snapshot={snapshot} />

        <StatStrip
          ariaLabel="Contract registry coverage summary"
          items={[
            { label: 'Contracts', value: String(snapshot.contracts.length), caption: `${totals.manageMethods} manage/admin` },
            { label: 'Services', value: String(snapshot.services.length), caption: 'registry modules with descriptors' },
            { label: 'Needs attention', value: String(totals.unavailable), caption: 'denied, stale, blocked, or awaiting support' },
            { label: 'Updated', value: snapshot.generatedAt ?? 'pending', caption: 'catalog timestamp' }
          ]}
        />

        <ContractsPanel contracts={snapshot.contracts} />
      </div>
    </div>
  )
}

/** Availability-state tone mapper for this screen's badges (route/health/contract state). */
function availabilityTone(state: AvailabilityState): BadgeTone {
  if (state === 'available-local' || state === 'available-remote') return 'success'
  if (state === 'degraded' || state === 'stale' || state === 'pending') return 'warning'
  if (state === 'denied' || state === 'privacy-blocked') return 'danger'
  return 'neutral'
}

function AvailabilityBadge({ state }: { state: AvailabilityState | AdminServicesLoadState }) {
  const normalized: AvailabilityState = isAvailabilityState(state) ? state : 'pending'
  return <ToneBadge tone={availabilityTone(normalized)}>{state}</ToneBadge>
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

function StatusPanel({ snapshot }: { snapshot: AdminServicesSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
        <Activity size={16} aria-hidden />
        <span>Loading services, contracts, and capability catalog through Aurora.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" role="status">
        <FileCode2 size={16} aria-hidden />
        <span>No service registry or method contracts were returned by the SDK.</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">
      <Lock size={16} aria-hidden />
      <span>{snapshot.error ?? 'Some service status needs attention. Controls remain disabled until Aurora marks them ready.'}</span>
    </div>
  )
}

function ServiceCardGrid({
  services,
  onPreviewControl
}: {
  services: AdminServiceRow[]
  onPreviewControl: (action: AdminServiceControlAction) => void
}) {
  if (services.length === 0) return <p className="text-sm text-muted-foreground">No services to show.</p>
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
      {services.map((service) => {
        const restart = service.controls.find((control) => control.verb === 'restart') ?? null
        return (
          <ShadCard key={service.module} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[13.5px] font-semibold">{service.module}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{service.instanceId ?? service.version}</p>
              </div>
              <HealthBadge health={service.status} />
            </div>
            <p className="my-2.5 text-xs leading-relaxed text-muted-foreground">{service.summary || `${service.module} service`}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">{service.methodCount} methods · {service.lastSeen}</span>
              <Button
                variant="outline"
                disabled={!restart?.available || !restart.action}
                disabledReason={restart?.reason ?? 'Restart control is not available for this service.'}
                onClick={() => { if (restart?.action) onPreviewControl(restart.action) }}
              >
                Restart
              </Button>
            </div>
          </ShadCard>
        )
      })}
    </div>
  )
}

function ContractsPanel({ contracts }: { contracts: AdminContractRow[] }) {
  const modules = useMemo(() => Array.from(new Set(contracts.map((contract) => contract.module))).sort(), [contracts])
  const [query, setQuery] = useState('')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [exposureFilter, setExposureFilter] = useState<ContractExposure | 'all'>('all')
  const [selectedTopic, setSelectedTopic] = useState<string | null>(contracts[0]?.busTopic ?? null)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredContracts = useMemo(
    () => contracts.filter((contract) => {
      const matchesQuery = normalizedQuery.length === 0 || [
        contract.busTopic,
        contract.summary,
        contract.module,
        contract.name,
        contract.routePath ?? '',
        contract.inputModel ?? '',
        contract.outputModel ?? '',
        contract.requiredPermissions.join(' ')
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
      const matchesModule = moduleFilter === 'all' || contract.module === moduleFilter
      const matchesExposure = exposureFilter === 'all' || contract.exposure === exposureFilter
      return matchesQuery && matchesModule && matchesExposure
    }),
    [contracts, exposureFilter, moduleFilter, normalizedQuery]
  )
  const selectedContract = contracts.find((contract) => contract.busTopic === selectedTopic) ?? filteredContracts[0] ?? contracts[0]
  const groupedContracts = groupContractsByModule(filteredContracts)

  return (
    <Card title="Contracts" flush>
      {contracts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No method descriptors were returned by Gateway.GetRegistry.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <FilterBar
            search={{
              value: query,
              onChange: setQuery,
              placeholder: 'Method, route, schema, permission',
              label: 'Search contracts'
            }}
            controls={
              <>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>Service/module</span>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={moduleFilter}
                    onChange={(event) => setModuleFilter(event.currentTarget.value)}
                  >
                    <option value="all">All modules</option>
                    {modules.map((module) => <option key={module} value={module}>{module}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>Exposure</span>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                    value={exposureFilter}
                    onChange={(event) => setExposureFilter(event.currentTarget.value as ContractExposure | 'all')}
                  >
                    <option value="all">All exposures</option>
                    <option value="external">external</option>
                    <option value="internal">internal</option>
                    <option value="both">both</option>
                    <option value="gateway_builtin">gateway_builtin</option>
                  </select>
                </label>
                <label className="sr-only">
                  <span>Method detail</span>
                  <select
                    value={selectedContract?.busTopic ?? ''}
                    onChange={(event) => setSelectedTopic(event.currentTarget.value)}
                    aria-label="Select contract detail"
                  >
                    {filteredContracts.map((contract) => (
                      <option key={contract.busTopic} value={contract.busTopic}>{contract.busTopic}</option>
                    ))}
                  </select>
                </label>
              </>
            }
          />

          <StatStrip
            ariaLabel="Contract explorer summary"
            items={[
              { label: 'Filtered methods', value: String(filteredContracts.length), caption: `${modules.length} service modules` },
              { label: 'HTTP routes', value: String(filteredContracts.filter((contract) => contract.availableOverHttp).length), caption: 'SDK route paths' },
              { label: 'Live registry', value: String(filteredContracts.filter((contract) => contract.liveRegistryStatus === 'live-registry').length), caption: 'registry + capability catalog' },
              { label: 'Schemas', value: String(filteredContracts.filter((contract) => contract.inputSchema || contract.outputSchema).length), caption: 'input or output JSON Schema' }
            ]}
          />

          {filteredContracts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contracts match the current search and filters.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableCaption className="sr-only">
                  Contract registry browser grouped by service module with method detail controls
                </TableCaption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Service/module</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Exposure</TableHead>
                    <TableHead>Backend</TableHead>
                    <TableHead>Gateway route</TableHead>
                    <TableHead>Conformance</TableHead>
                    <TableHead>Permissions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedContracts.map((group) => (
                    <ContractModuleGroup
                      key={group.module}
                      module={group.module}
                      contracts={group.contracts}
                      selectedTopic={selectedContract?.busTopic ?? null}
                      onSelect={setSelectedTopic}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {selectedContract ? <ContractDetail contract={selectedContract} /> : null}
        </div>
      )}
    </Card>
  )
}

function ContractModuleGroup({
  module,
  contracts,
  selectedTopic,
  onSelect
}: {
  module: string
  contracts: AdminContractRow[]
  selectedTopic: string | null
  onSelect: (topic: string) => void
}) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableHead colSpan={8} scope="rowgroup" className="bg-muted/40 text-xs font-semibold text-foreground">
          {module} module / {contracts.length} contracts
        </TableHead>
      </TableRow>
      {contracts.map((contract) => (
        <TableRow key={contract.busTopic} aria-selected={contract.busTopic === selectedTopic}>
          <TableCell className="font-medium">{contract.module}</TableCell>
          <TableCell>
            <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => onSelect(contract.busTopic)}>
              {contract.busTopic}
            </button>
            <p className="text-xs text-muted-foreground">{contract.summary || 'No summary provided.'}</p>
          </TableCell>
          <TableCell><MethodTypeBadge type={contract.methodType} /></TableCell>
          <TableCell><ExposureBadge exposure={contract.exposure} /></TableCell>
          <TableCell><BackendCoverageBadge coverage={contract.backendCoverage} /></TableCell>
          <TableCell>
            <div className="flex items-center gap-1.5">
              <AvailabilityBadge state={contract.availability} />
              <span className="text-xs text-muted-foreground">{contract.generatedRoutePath ?? 'not HTTP-exposed'}</span>
            </div>
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap gap-1">
              <Badge variant="secondary" className="font-mono text-[10.5px]">{contract.liveRegistryStatus}</Badge>
              <Badge variant="secondary" className="font-mono text-[10.5px]">{contract.conformanceStatus}</Badge>
            </div>
          </TableCell>
          <TableCell><PermissionChips permissions={contract.requiredPermissions} /></TableCell>
        </TableRow>
      ))}
    </>
  )
}

function MethodTypeBadge({ type }: { type: ContractMethodType }) {
  return <Badge variant="outline" className="capitalize">{type}</Badge>
}

function ExposureBadge({ exposure }: { exposure: ContractExposure }) {
  return <Badge variant="outline" className="capitalize">{exposure}</Badge>
}

function BackendCoverageBadge({ coverage }: { coverage: AdminContractRow['backendCoverage'] }) {
  return <Badge variant="outline" className="capitalize">{coverage}</Badge>
}

function ContractDetail({ contract }: { contract: AdminContractRow }) {
  return (
    <aside className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="contract-detail-title">
      <div>
        <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Method detail</p>
        <h3 id="contract-detail-title" className="font-mono text-sm font-semibold">{contract.busTopic}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{contract.summary || 'No summary provided by the live registry descriptor.'}</p>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Service/module</dt><dd className="font-medium">{contract.module}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Method</dt><dd className="font-medium">{contract.name}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Input model</dt><dd className="font-medium">{contract.inputModel ?? 'none'}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Output model</dt><dd className="font-medium">{contract.outputModel ?? 'none'}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Exposure</dt><dd><ExposureBadge exposure={contract.exposure} /></dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Permissions</dt><dd><PermissionChips permissions={contract.requiredPermissions} /></dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Capability permissions</dt><dd><PermissionChips permissions={contract.capabilityPermissions} /></dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Gateway route path</dt><dd className="font-mono text-xs">{contract.generatedRoutePath ?? 'not HTTP-exposed'}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">OpenAPI/export state</dt><dd className="font-medium">{contract.openApiState}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Export state</dt><dd className="font-medium">{contract.exportState}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Live-registry status</dt><dd className="font-medium">{contract.liveRegistryStatus}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Contract conformance</dt><dd className="font-medium">{contract.conformanceStatus}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Capability route status</dt><dd className="font-medium">{contract.routeReason}</dd></div>
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"><dt className="text-muted-foreground">Schema state</dt><dd className="font-medium">{contract.schemaState}</dd></div>
      </dl>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Input and output schema detail">
        <SchemaBlock title="Input schema" schema={contract.inputSchema} />
        <SchemaBlock title="Output schema" schema={contract.outputSchema} />
      </div>
    </aside>
  )
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((permission) => (
        <code key={permission} className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">{permission}</code>
      ))}
      {permissions.length === 0 ? <span className="text-xs text-muted-foreground">none</span> : null}
    </div>
  )
}

function SchemaBlock({ title, schema }: { title: string; schema: MethodDescriptor['inputSchema'] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      {schema ? (
        <code className="block max-h-48 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(schema, null, 2)}</code>
      ) : (
        <p className="text-xs text-muted-foreground">No JSON Schema exported by this registry descriptor.</p>
      )}
    </section>
  )
}

function buildServiceRows(
  response: GetServicesResponse | null,
  methods: MethodDescriptor[],
  capabilities: CapabilitySummary[]
): AdminServiceRow[] {
  return (response?.services ?? []).map((service) => {
    const serviceMethods = methods.filter((method) => method.module === service.module)
    const primary = bestCapabilityForModule(service.module, capabilities)
    return {
      module: service.module,
      version: service.version,
      summary: service.summary,
      capabilities: service.capabilities,
      methodCount: service.method_count,
      lastSeen: service.last_seen,
      status: service.status,
      healthState: healthState(service),
      instanceId: service.instance_id,
      providerLabel: primary ? providerLabel(primary) : `${service.module} provider pending`,
      routeState: primary?.availability ?? 'unsupported',
      routeReason: primary ? routeReason(primary) : 'Capability catalog does not advertise this service as executable.',
      privacyClass: primary?.privacyClass ?? 'public',
      methods: serviceMethods,
      controls: ['restart', 'reload', 'stop'].map((verb) =>
        serviceControl(service, verb as 'restart' | 'reload' | 'stop', serviceMethods, capabilities)
      )
    }
  })
}

function buildContractRows(
  methods: MethodDescriptor[],
  capabilities: CapabilitySummary[]
): AdminContractRow[] {
  return methods
    .map((method) => {
      const capability = capabilities.find((candidate) => candidate.busTopic === method.busTopic)
      return {
        ...method,
        availability: capability?.availability ?? methodAvailability(method),
        providerLabel: capability ? providerLabel(capability) : `${method.module} provider pending`,
        backendCoverage: backendCoverage(method, capability),
        privacyClass: capability?.privacyClass ?? privacyForMethod(method),
        routeReason: capability ? routeReason(capability) : 'No capability catalog action exists for this method.',
        liveRegistryStatus: (capability ? 'live-registry' : 'registry-only') as AdminContractRow['liveRegistryStatus'],
        conformanceStatus: contractConformance(method, capability),
        generatedRoutePath: method.routePath,
        openApiState: openApiEvidence(method),
        exportState: exportEvidence(method, capability),
        schemaState: schemaEvidence(method, capability),
        capabilityPermissions: capability?.requiredPermissions ?? []
      }
    })
    .sort((a, b) => a.busTopic.localeCompare(b.busTopic))
}

function groupContractsByModule(contracts: AdminContractRow[]): Array<{ module: string; contracts: AdminContractRow[] }> {
  const groups = new Map<string, AdminContractRow[]>()
  for (const contract of contracts) {
    const group = groups.get(contract.module) ?? []
    group.push(contract)
    groups.set(contract.module, group)
  }
  return [...groups.entries()]
    .map(([module, grouped]) => ({ module, contracts: grouped }))
    .sort((a, b) => a.module.localeCompare(b.module))
}

function contractConformance(method: MethodDescriptor, capability: CapabilitySummary | undefined): AdminContractRow['conformanceStatus'] {
  if (method.exposure === 'gateway_builtin') return 'gateway-builtin'
  if (!method.availableOverHttp) return 'internal-only'
  return capability ? 'conformant' : 'missing-capability'
}

function openApiEvidence(method: MethodDescriptor): string {
  if (!method.availableOverHttp || !method.routePath) return 'Internal-only contract is intentionally absent from OpenAPI HTTP paths.'
  return `Gateway/OpenAPI path ${method.routePath} from live registry descriptor ${method.module}.${method.name}.`
}

function exportEvidence(method: MethodDescriptor, capability: CapabilitySummary | undefined): string {
  const registryEvidence = `Gateway.GetRegistry exported ${method.busTopic}`
  const capabilityEvidence = capability ? `; Gateway.GetCapabilityCatalog action ${capability.id}` : '; no capability-catalog action matched this bus topic'
  return `${registryEvidence}${capabilityEvidence}.`
}

function schemaEvidence(method: MethodDescriptor, capability: CapabilitySummary | undefined): string {
  const registrySchemas = [method.inputSchema ? 'input schema' : null, method.outputSchema ? 'output schema' : null]
    .filter((value): value is string => Boolean(value))
  const capabilitySchemas = capability
    ? [capability.raw.input_schema ? 'capability input schema' : null, capability.raw.output_schema ? 'capability output schema' : null]
      .filter((value): value is string => Boolean(value))
    : []
  const evidence = [...registrySchemas, ...capabilitySchemas]
  return evidence.length > 0 ? evidence.join(', ') : 'No JSON Schema exported by registry or capability catalog.'
}

function serviceControl(
  service: ServiceInfo,
  verb: 'restart' | 'reload' | 'stop',
  methods: MethodDescriptor[],
  capabilities: CapabilitySummary[]
): AdminServiceControlPreview {
  const methodId = serviceControlMethodId(verb)
  const descriptor = methods.find((method) => method.busTopic === methodId)
  const capability = capabilities.find((candidate) => candidate.busTopic === methodId)
  const state = capability?.availability ?? (descriptor ? methodAvailability(descriptor) : 'unsupported')
  const requiresAdminAction = descriptor?.methodType === 'manage' || privacyForMethod(descriptor) === 'admin-critical'
  const available = Boolean(
    descriptor?.availableOverHttp &&
    requiresAdminAction &&
    capability &&
    ['available-local', 'available-remote', 'degraded'].includes(capability.availability)
  )
  const reason = controlReason(descriptor, capability, requiresAdminAction)
  return {
    verb,
    methodId,
    state,
    available,
    requiresAdminAction,
    reason,
    action: available
      ? {
          title: `${serviceControlLabel(verb)} ${service.module}`,
          description: `Aurora will ${verb} ${service.module} only through the AdminAction draft/confirm/audit controller.`,
          methodId,
          severity: verb === 'stop' ? 'critical' : 'high',
          serviceModule: service.module,
          requiresReason: true,
          requiresTypedPhrase: verb === 'stop' ? service.module : null
        }
      : null
  }
}


function serviceControlMethodId(verb: AdminServiceControlPreview['verb']): string {
  if (verb === 'restart') return 'Supervisor.RestartService'
  if (verb === 'reload') return 'Config.ReloadService'
  return 'Supervisor.StopService'
}

function serviceControlLabel(verb: AdminServiceControlPreview['verb']): string {
  if (verb === 'restart') return 'Restart'
  if (verb === 'reload') return 'Reload'
  return 'Stop'
}

function serviceTotals(services: AdminServiceRow[]) {
  return {
    selectable: services.filter((service) => ['available-local', 'available-remote', 'degraded'].includes(service.routeState)).length,
    unavailable: services.filter((service) => !['available-local', 'available-remote', 'degraded'].includes(service.routeState)).length,
    manageMethods: services.reduce(
      (count, service) => count + service.methods.filter((method) => method.methodType === 'manage').length,
      0
    )
  }
}

function bestCapabilityForModule(module: string, capabilities: CapabilitySummary[]): CapabilitySummary | undefined {
  return [...capabilities]
    .filter((capability) => capability.module === module)
    .sort((a, b) => availabilityRank(a.availability) - availabilityRank(b.availability))[0]
}

function availabilityRank(state: AvailabilityState): number {
  const ranks: Record<AvailabilityState, number> = {
    'available-local': 0,
    'available-remote': 1,
    degraded: 2,
    pending: 3,
    offline: 4,
    'privacy-blocked': 5,
    denied: 6,
    stale: 7,
    unsupported: 8
  }
  return ranks[state]
}

function methodAvailability(method: MethodDescriptor): AvailabilityState {
  if (method.exposure === 'internal') return 'unsupported'
  if (!method.availableOverHttp) return 'unsupported'
  return method.methodType === 'manage' ? 'privacy-blocked' : 'degraded'
}
function backendCoverage(method: MethodDescriptor, capability: CapabilitySummary | undefined): AdminContractRow['backendCoverage'] {
  if (method.exposure === 'gateway_builtin') return 'gateway-builtin'
  if (!method.availableOverHttp) return 'internal-only'
  if (!capability) return 'missing-capability'
  return 'http'
}

function privacyForMethod(method: MethodDescriptor | undefined): PrivacyClass {
  if (!method) return 'public'
  if (method.methodType === 'manage') return 'admin-critical'
  if (method.requiredPermissions.some((permission) => permission.toLowerCase().includes('auth'))) return 'credential'
  return 'public'
}

function healthState(service: ServiceInfo): AvailabilityState {
  const status = service.status.toLowerCase()
  if (status.includes('healthy') || status.includes('running') || status.includes('available')) return 'available-local'
  if (status.includes('stale')) return 'stale'
  if (status.includes('denied') || status.includes('unauthorized')) return 'denied'
  if (status.includes('degraded')) return 'degraded'
  if (status.includes('starting') || status.includes('pending')) return 'pending'
  return 'unsupported'
}

function providerLabel(capability: CapabilitySummary): string {
  const location = capability.peerId && capability.peerId !== 'local-peer' ? `remote:${capability.peerId}` : capability.providerId
  return `${location} / ${capability.serviceInstanceId}`
}

function routeReason(capability: CapabilitySummary): string {
  if (capability.routeBlockers.length > 0) return capability.routeBlockers.join(', ')
  return `${capability.module}.${capability.method} is ${capability.availability}`
}

function controlReason(
  descriptor: MethodDescriptor | undefined,
  capability: CapabilitySummary | undefined,
  requiresAdminAction: boolean
): string {
  if (!descriptor) return 'Supervisor control contract is not present in the service registry.'
  if (!descriptor.availableOverHttp) return `${descriptor.busTopic} is internal-only and not available to this SDK transport.`
  if (!requiresAdminAction) return `${descriptor.busTopic} is not marked manage/admin-critical; UI will not execute it.`
  if (!capability) return 'Capability catalog does not advertise this control as executable.'
  if (!['available-local', 'available-remote', 'degraded'].includes(capability.availability)) {
    return routeReason(capability)
  }
  return 'Preview requires AdminAction draft/confirm/audit before any mutation request.'
}

function valueOrNull<T>(settled: PromiseSettledResult<T>): T | null {
  return settled.status === 'fulfilled' ? settled.value : null
}

function failureMessage(label: string, settled: PromiseSettledResult<unknown>): string | null {
  if (settled.status === 'fulfilled') return null
  return `${label}: ${errorMessage(settled.reason)}`
}

function isDeniedFailure(settled: PromiseSettledResult<unknown>): boolean {
  if (settled.status === 'fulfilled') return false
  const reason = settled.reason as Partial<AuroraError>
  return reason.code === 'auth' || reason.code === 'permission'
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
}
