'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, FileCode2, Lock, Play, RotateCw, Square } from 'lucide-react'
import {
  AuroraError,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilityCatalogResponse,
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
  verb: 'restart' | 'stop'
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
  evidenceSource: 'pending AuroraClient SDK calls'
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
      error: failures.join(' ') || 'Aurora services and contract evidence are unavailable.',
      warnings: failures,
      evidenceSource: 'AuroraClient SDK error'
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
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response'
  }
}

export function AdminServicesView({ snapshot, onPreviewAdminAction }: AdminServicesViewProps) {
  const totals = useMemo(() => serviceTotals(snapshot.services), [snapshot.services])
  const state = snapshot.loadState

  return (
    <section className="aui-admin-services" aria-labelledby="admin-services-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-services-title">Services and contracts</h1>
          <p>
            Service registry, method exposure, route evidence, and control previews are rendered from AuroraClient SDK
            responses.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Admin services backend evidence">
          {isAvailabilityState(state) ? <StatusBadge state={state} /> : <span className={`aui-badge aui-badge-${state}`}>{state}</span>}
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={`mode ${snapshot.servicesMode}`} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        </div>
      </header>

      <StatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="Service coverage summary">
        <Metric label="Services" value={String(snapshot.services.length)} detail={`${totals.selectable} selectable`} />
        <Metric label="Methods" value={String(snapshot.contracts.length)} detail={`${totals.manageMethods} manage/admin`} />
        <Metric label="Unavailable" value={String(totals.unavailable)} detail="denied, stale, blocked, or unsupported" />
        <Metric label="Generated" value={snapshot.generatedAt ?? 'pending'} detail="capability catalog timestamp" />
      </div>

      <div className="aui-admin-grid">
        <ServicesTable services={snapshot.services} onPreviewAdminAction={onPreviewAdminAction} />
        <ContractsPanel contracts={snapshot.contracts} />
      </div>
    </section>
  )
}

function StatusPanel({ snapshot }: { snapshot: AdminServicesSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading services, contracts, and capability catalog through AuroraClient.</span>
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
      <span>{snapshot.error ?? 'Some backend evidence is unavailable. Unsupported controls remain disabled.'}</span>
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
    <section className="aui-admin-panel" aria-labelledby="services-table-title">
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
            <thead>
              <tr>
                <th>Module</th>
                <th>Health</th>
                <th>Route</th>
                <th>Capabilities</th>
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
          </summary>
          <div className="aui-service-drawer">
            <dl>
              <div><dt>Version</dt><dd>{service.version}</dd></div>
              <div><dt>Last seen</dt><dd>{service.lastSeen}</dd></div>
              <div><dt>Provider</dt><dd>{service.providerLabel}</dd></div>
              <div><dt>Route evidence</dt><dd>{service.routeReason}</dd></div>
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

function MethodList({ methods }: { methods: MethodDescriptor[] }) {
  if (methods.length === 0) return <p className="aui-muted">No registry methods were reported for this service.</p>
  return (
    <ul className="aui-method-list" aria-label="Service methods">
      {methods.map((method) => (
        <li key={method.busTopic}>
          <code>{method.busTopic}</code>
          <span>{method.exposure}</span>
          <span>{method.methodType}</span>
          <small>{method.summary || 'No summary provided.'}</small>
        </li>
      ))}
    </ul>
  )
}

function ContractsPanel({ contracts }: { contracts: AdminContractRow[] }) {
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
        <div className="aui-table-scroll">
          <table className="aui-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Type</th>
                <th>Exposure</th>
                <th>Backend</th>
                <th>Route</th>
                <th>Privacy</th>
                <th>Permissions</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((contract) => (
                <tr key={contract.busTopic}>
                  <td>
                    <strong>{contract.busTopic}</strong>
                    <small>{contract.summary || 'No summary provided.'}</small>
                  </td>
                  <td><MethodTypeBadge type={contract.methodType} /></td>
                  <td><ExposureBadge exposure={contract.exposure} /></td>
                  <td><BackendCoverageBadge coverage={contract.backendCoverage} /></td>
                  <td>
                    <div className="aui-state-line">
                      <StatusBadge state={contract.availability} />
                      <span>{contract.routePath ?? 'not HTTP-exposed'}</span>
                    </div>
                  </td>
                  <td><PrivacyBadge privacy={contract.privacyClass} /></td>
                  <td>
                    <div className="aui-chip-list">
                      {contract.requiredPermissions.map((permission) => (
                        <code className="aui-chip" key={permission}>{permission}</code>
                      ))}
                      {contract.requiredPermissions.length === 0 ? <span className="aui-muted">none</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
      controls: ['restart', 'stop'].map((verb) =>
        serviceControl(service, verb as 'restart' | 'stop', serviceMethods, capabilities)
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
        routeReason: capability ? routeReason(capability) : 'No capability catalog action exists for this method.'
      }
    })
    .sort((a, b) => a.busTopic.localeCompare(b.busTopic))
}

function serviceControl(
  service: ServiceInfo,
  verb: 'restart' | 'stop',
  methods: MethodDescriptor[],
  capabilities: CapabilitySummary[]
): AdminServiceControlPreview {
  const methodId = `Supervisor.${verb === 'restart' ? 'RestartService' : 'StopService'}`
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
          title: `${verb === 'restart' ? 'Restart' : 'Stop'} ${service.module}`,
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
    'privacy-blocked': 4,
    denied: 5,
    stale: 6,
    unsupported: 7
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
  if (!descriptor.availableOverHttp) return 'Supervisor control is internal-only and not available to this SDK transport.'
  if (!requiresAdminAction) return 'Supervisor control is not marked manage/admin-critical; UI will not execute it.'
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
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}
