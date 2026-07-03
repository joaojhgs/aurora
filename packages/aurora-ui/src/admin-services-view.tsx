'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, FileCode2, Lock, RefreshCw, RotateCw, Search, Square } from 'lucide-react'
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
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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
    evidenceSource: client.transport.kind === 'mock' ? 'Demo transport' : 'Aurora service response'
  }
}

export function AdminServicesView({ snapshot, onPreviewAdminAction }: AdminServicesViewProps) {
  const totals = useMemo(() => serviceTotals(snapshot.services), [snapshot.services])
  const state = snapshot.loadState

  return (
    <section className="aui-admin-services" aria-labelledby="admin-services-title">
      <AdminEvidenceHeader
        title="Services"
        titleId="admin-services-title"
        description="Service registry health, route status, and AdminAction service controls are rendered from Aurora SDK responses. Method contract browsing lives on /admin/contracts."
        snapshot={snapshot}
        state={state}
        badgeLabel="Admin services service status"
      />

      <StatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="Service coverage summary">
        <Metric label="Services" value={String(snapshot.services.length)} detail={`${totals.selectable} selectable`} />
        <Metric label="Methods" value={String(snapshot.contracts.length)} detail={`${totals.manageMethods} manage/admin`} />
        <Metric label="Unavailable" value={String(totals.unavailable)} detail="denied, stale, blocked, or unsupported" />
        <Metric label="Generated" value={snapshot.generatedAt ?? 'pending'} detail="capability catalog timestamp" />
      </div>

      <div className="aui-admin-grid">
        <ServicesTable services={snapshot.services} onPreviewAdminAction={onPreviewAdminAction} />
      </div>
    </section>
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
    <section className="aui-admin-services" aria-labelledby="admin-contracts-title">
      <AdminEvidenceHeader
        title="Contracts registry"
        titleId="admin-contracts-title"
        description="Method exposure, generated Gateway routes, schemas, permissions, and conformance status are rendered from Gateway.GetRegistry plus capability catalog data. Service lifecycle controls stay on /admin/services."
        snapshot={snapshot}
        state={state}
        badgeLabel="Admin contracts service status"
      />

      <StatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="Contract registry coverage summary">
        <Metric label="Contracts" value={String(snapshot.contracts.length)} detail={`${totals.manageMethods} manage/admin`} />
        <Metric label="Services" value={String(snapshot.services.length)} detail="registry modules with descriptors" />
        <Metric label="Unavailable" value={String(totals.unavailable)} detail="denied, stale, blocked, or unsupported" />
        <Metric label="Generated" value={snapshot.generatedAt ?? 'pending'} detail="capability catalog timestamp" />
      </div>

      <ContractsPanel contracts={snapshot.contracts} />
    </section>
  )
}

function AdminEvidenceHeader({
  title,
  titleId,
  description,
  snapshot,
  state,
  badgeLabel
}: {
  title: string
  titleId: string
  description: string
  snapshot: AdminServicesSnapshot
  state: AdminServicesLoadState
  badgeLabel: string
}) {
  return (
    <header className="aui-admin-header">
      <div>
        <p className="aui-kicker">Admin</p>
        <h1 id={titleId}>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="aui-admin-badges" aria-label={badgeLabel}>
        {isAvailabilityState(state) ? <StatusBadge state={state} /> : <span className={`aui-badge aui-badge-${state}`}>{state}</span>}
        <EvidenceBadge label={snapshot.evidenceSource} />
        <EvidenceBadge label={`mode ${snapshot.servicesMode}`} />
        <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
      </div>
    </header>
  )
}

function StatusPanel({ snapshot }: { snapshot: AdminServicesSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading services, contracts, and capability catalog through Aurora.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="aui-admin-notice" role="status">
        <FileCode2 size={18} aria-hidden />
        <span>No service registry or method contracts were returned by the SDK.</span>
      </div>
    )
  }
  return (
    <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
      <Lock size={18} aria-hidden />
      <span>{snapshot.error ?? 'Some service status is unavailable. Unsupported controls remain disabled.'}</span>
    </div>
  )
}

function ServicesTable({
  services,
  onPreviewAdminAction
}: {
  services: AdminServiceRow[]
  onPreviewAdminAction?: ((action: AdminServiceControlAction) => void) | undefined
}) {
  return (
    <section className="aui-admin-panel" aria-label="Services table with health">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Registry</p>
          <h2 id="services-table-title">Services</h2>
        </div>
      </div>
      {services.length === 0 ? (
        <p className="aui-muted">No services were returned by Gateway.GetServices.</p>
      ) : (
        <div className="aui-table-scroll">
          <table className="aui-table">
            <caption className="aui-sr-only">
              Services table with health, route state, capabilities, heartbeat, instance, and AdminAction controls
            </caption>
            <thead>
              <tr>
                <th>Module</th>
                <th>Health</th>
                <th>Route</th>
                <th>Capabilities</th>
                <th>Heartbeat</th>
                <th>Methods</th>
                <th>Instance</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <ServiceTableRow
                  key={service.module}
                  service={service}
                  onPreviewAdminAction={onPreviewAdminAction}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ServiceTableRow({
  service,
  onPreviewAdminAction
}: {
  service: AdminServiceRow
  onPreviewAdminAction?: ((action: AdminServiceControlAction) => void) | undefined
}) {
  return (
    <tr>
      <td>
        <details className="aui-service-details">
          <summary>
            <strong>{service.module}</strong>
            <small>{service.summary || `${service.module} service`}</small>
            <span className="aui-detail-affordance">Details: routes, methods, and backend exposure</span>
          </summary>
          <div className="aui-service-drawer">
            <dl>
              <div><dt>Version</dt><dd>{service.version}</dd></div>
              <div><dt>Last seen</dt><dd>{service.lastSeen}</dd></div>
              <div><dt>Provider</dt><dd>{service.providerLabel}</dd></div>
              <div><dt>Route state</dt><dd>{service.routeReason}</dd></div>
              <div><dt>Capabilities</dt><dd>{service.capabilities.length}</dd></div>
              <div><dt>Control posture</dt><dd>{controlPosture(service.controls)}</dd></div>
              <div><dt>Errors/logs</dt><dd>{serviceLogsAndErrorsLabel(service)}</dd></div>
            </dl>
            <MethodList methods={service.methods} />
          </div>
        </details>
      </td>
      <td><StatusBadge state={service.healthState} /></td>
      <td>
        <div className="aui-state-line">
          <StatusBadge state={service.routeState} />
          <span>{service.providerLabel}</span>
        </div>
      </td>
      <td>
        <div className="aui-chip-list">
          {service.capabilities.slice(0, 4).map((capability) => (
            <span className="aui-chip" key={capability}>{capability}</span>
          ))}
          {service.capabilities.length === 0 ? <span className="aui-muted">none reported</span> : null}
        </div>
      </td>
      <td>
        <time dateTime={service.lastSeen}>{service.lastSeen}</time>
      </td>
      <td>
        <strong>{service.methodCount}</strong>
        <small>{service.controls.filter((control) => control.available).length} AdminAction-ready controls</small>
      </td>
      <td><code>{service.instanceId ?? 'not reported'}</code></td>
      <td>
        <div className="aui-icon-actions">
          {service.controls.map((control) => (
            <button
              key={control.verb}
              type="button"
              aria-label={`${control.verb} ${service.module}`}
              title={control.reason}
              disabled={!control.available || !control.action}
              onClick={() => {
                if (control.action) onPreviewAdminAction?.(control.action)
              }}
            >
              {control.verb === 'restart'
                ? <RotateCw size={16} aria-hidden />
                : control.verb === 'reload'
                  ? <RefreshCw size={16} aria-hidden />
                  : control.available
                    ? <Square size={16} aria-hidden />
                    : <Lock size={16} aria-hidden />}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}


function serviceLogsAndErrorsLabel(service: AdminServiceRow): string {
  if (service.healthState === 'available-local' || service.healthState === 'available-remote') {
    return 'No active errors reported by the service registry; detailed logs require diagnostics export.'
  }
  return `${service.status || service.healthState}; inspect diagnostics export for service logs.`
}

function controlPosture(controls: AdminServiceControlPreview[]): string {
  const ready = controls.filter((control) => control.available).length
  if (ready === 0) return 'No executable control surfaced to this SDK transport.'
  return `${ready}/${controls.length} controls require AdminAction draft/confirm/audit before execution.`
}

function methodExposureLabel(exposure: ContractExposure): string {
  return exposure === 'internal' ? 'internal-only' : exposure
}

function MethodList({ methods }: { methods: MethodDescriptor[] }) {
  if (methods.length === 0) return <p className="aui-muted">No registry methods were reported for this service.</p>
  return (
    <ul className="aui-method-list" aria-label="Service methods">
      {methods.map((method) => (
        <li key={method.busTopic}>
          <code>{method.busTopic}</code>
          <span>{methodExposureLabel(method.exposure)}</span>
          <span>{method.methodType}</span>
          <small>{method.summary || 'No summary provided.'}</small>
        </li>
      ))}
    </ul>
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
    <section className="aui-admin-panel" aria-labelledby="contracts-table-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Explorer</p>
          <h2 id="contracts-table-title">Contracts</h2>
        </div>
      </div>
      {contracts.length === 0 ? (
        <p className="aui-muted">No method descriptors were returned by Gateway.GetRegistry.</p>
      ) : (
        <div className="aui-contract-browser">
          <div className="aui-admin-toolbar" aria-label="Contract search and filters">
            <label>
              <span>Search contracts</span>
              <span className="aui-input-with-icon">
                <Search size={14} aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Method, route, schema, permission"
                  aria-label="Search contracts"
                />
              </span>
            </label>
            <label>
              <span>Service/module</span>
              <select value={moduleFilter} onChange={(event) => setModuleFilter(event.currentTarget.value)}>
                <option value="all">All modules</option>
                {modules.map((module) => <option key={module} value={module}>{module}</option>)}
              </select>
            </label>
            <label>
              <span>Exposure</span>
              <select
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
            <label>
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
          </div>

          <div className="aui-admin-metrics" aria-label="Contract explorer summary">
            <Metric label="Filtered methods" value={String(filteredContracts.length)} detail={`${modules.length} service modules`} />
            <Metric label="HTTP routes" value={String(filteredContracts.filter((contract) => contract.availableOverHttp).length)} detail="generated SDK route paths" />
            <Metric label="Live registry" value={String(filteredContracts.filter((contract) => contract.liveRegistryStatus === 'live-registry').length)} detail="registry + capability catalog" />
            <Metric label="Schemas" value={String(filteredContracts.filter((contract) => contract.inputSchema || contract.outputSchema).length)} detail="input or output JSON Schema" />
          </div>

          {filteredContracts.length === 0 ? (
            <p className="aui-muted">No contracts match the current search and filters.</p>
          ) : (
            <div className="aui-table-scroll">
              <table className="aui-table">
                <caption className="aui-sr-only">
                  Contract registry browser grouped by service module with method detail controls
                </caption>
                <thead>
                  <tr>
                    <th>Service/module</th>
                    <th>Method</th>
                    <th>Type</th>
                    <th>Exposure</th>
                    <th>Backend</th>
                    <th>Generated route</th>
                    <th>Conformance</th>
                    <th>Permissions</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedContracts.map((group) => (
                    <ContractModuleGroup
                      key={group.module}
                      module={group.module}
                      contracts={group.contracts}
                      selectedTopic={selectedContract?.busTopic ?? null}
                      onSelect={setSelectedTopic}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selectedContract ? <ContractDetail contract={selectedContract} /> : null}
        </div>
      )}
    </section>
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
      <tr className="aui-table-group-row">
        <th colSpan={8} scope="rowgroup">{module} module / {contracts.length} contracts</th>
      </tr>
      {contracts.map((contract) => (
        <tr key={contract.busTopic} aria-selected={contract.busTopic === selectedTopic}>
          <td><strong>{contract.module}</strong></td>
          <td>
            <button type="button" className="aui-link-button" onClick={() => onSelect(contract.busTopic)}>
              {contract.busTopic}
            </button>
            <small>{contract.summary || 'No summary provided.'}</small>
          </td>
          <td><MethodTypeBadge type={contract.methodType} /></td>
          <td><ExposureBadge exposure={contract.exposure} /></td>
          <td><BackendCoverageBadge coverage={contract.backendCoverage} /></td>
          <td>
            <div className="aui-state-line">
              <StatusBadge state={contract.availability} />
              <span>{contract.generatedRoutePath ?? 'not HTTP-exposed'}</span>
            </div>
          </td>
          <td>
            <div className="aui-chip-list">
              <span className="aui-chip">{contract.liveRegistryStatus}</span>
              <span className="aui-chip">{contract.conformanceStatus}</span>
            </div>
          </td>
          <td><PermissionChips permissions={contract.requiredPermissions} /></td>
        </tr>
      ))}
    </>
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

function MethodTypeBadge({ type }: { type: ContractMethodType }) {
  return <span className={`aui-badge aui-method-${type}`}>{type}</span>
}

function ExposureBadge({ exposure }: { exposure: ContractExposure }) {
  return <span className={`aui-badge aui-exposure-${exposure}`}>{exposure}</span>
}

function BackendCoverageBadge({ coverage }: { coverage: AdminContractRow['backendCoverage'] }) {
  return <span className={`aui-badge aui-backend-${coverage}`}>{coverage}</span>
}

function ContractDetail({ contract }: { contract: AdminContractRow }) {
  return (
    <aside className="aui-admin-detail" aria-labelledby="contract-detail-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Method detail</p>
          <h3 id="contract-detail-title">{contract.busTopic}</h3>
          <p>{contract.summary || 'No summary provided by the live registry descriptor.'}</p>
        </div>
      </div>
      <dl className="aui-detail-grid">
        <div><dt>Service/module</dt><dd>{contract.module}</dd></div>
        <div><dt>Method</dt><dd>{contract.name}</dd></div>
        <div><dt>Input model</dt><dd>{contract.inputModel ?? 'none'}</dd></div>
        <div><dt>Output model</dt><dd>{contract.outputModel ?? 'none'}</dd></div>
        <div><dt>Exposure</dt><dd><ExposureBadge exposure={contract.exposure} /></dd></div>
        <div><dt>Permissions</dt><dd><PermissionChips permissions={contract.requiredPermissions} /></dd></div>
        <div><dt>Capability permissions</dt><dd><PermissionChips permissions={contract.capabilityPermissions} /></dd></div>
        <div><dt>Generated route path</dt><dd><code>{contract.generatedRoutePath ?? 'not HTTP-exposed'}</code></dd></div>
        <div><dt>OpenAPI/export state</dt><dd>{contract.openApiState}</dd></div>
        <div><dt>Export state</dt><dd>{contract.exportState}</dd></div>
        <div><dt>Live-registry status</dt><dd>{contract.liveRegistryStatus}</dd></div>
        <div><dt>Contract conformance</dt><dd>{contract.conformanceStatus}</dd></div>
        <div><dt>Capability route status</dt><dd>{contract.routeReason}</dd></div>
        <div><dt>Schema state</dt><dd>{contract.schemaState}</dd></div>
      </dl>
      <div className="aui-schema-grid" aria-label="Input and output schema detail">
        <SchemaBlock title="Input schema" schema={contract.inputSchema} />
        <SchemaBlock title="Output schema" schema={contract.outputSchema} />
      </div>
    </aside>
  )
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  return (
    <div className="aui-chip-list">
      {permissions.map((permission) => (
        <code className="aui-chip" key={permission}>{permission}</code>
      ))}
      {permissions.length === 0 ? <span className="aui-muted">none</span> : null}
    </div>
  )
}

function SchemaBlock({ title, schema }: { title: string; schema: MethodDescriptor['inputSchema'] }) {
  return (
    <section>
      <h4>{title}</h4>
      {schema ? <code className="aui-schema-code">{JSON.stringify(schema, null, 2)}</code> : <p className="aui-muted">No JSON Schema exported by this registry descriptor.</p>}
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
  if (!method.availableOverHttp || !method.routePath) return 'Internal-only contract is intentionally absent from generated OpenAPI HTTP paths.'
  return `Generated Gateway/OpenAPI path ${method.routePath} from live registry descriptor ${method.module}.${method.name}.`
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
