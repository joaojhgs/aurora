"use client"

import { useQuery } from '@tanstack/react-query'
import type {
  AdminOverviewManifest,
  AdminOverviewServiceSummary,
  AuroraClient,
  AvailabilityState,
  CapabilitySummary,
  DeploymentTopologyResponse,
  MethodDescriptor
} from '@aurora/client'
import { Button as LinkButton, buttonVariants } from '#components/ui/button'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
import { EmptyState, PageHeader, RouteStateNotice, SurfaceSkeleton } from './state-surface'
import { Button, Card, DataTable, MetaGrid, type DataColumn } from './primitives'
import { AURORA_QUERY_STALE_TIMES, AuroraQueryProvider, useAuroraQueryScope } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import { adminActionLabel, adminErrorTitle, adminModuleLabel, adminReasonText, productAdminCountCopy, productAdminDeviceFeatureCopy, productAdminPairCountCopy, sanitizeAdminText } from './admin-product-copy'

export interface AdminOverviewViewProps {
  client: AuroraClient
}

export interface AdminOverviewContentProps {
  manifest: AdminOverviewManifest | null
  transportKind: string
  error?: unknown
  loading?: boolean
}

interface ActivityItem {
  id: string
  state: AvailabilityState | 'error'
  label: string
  detail: string
}

const gapListItemClass = 'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-border p-3'
const chipLinkClass = buttonVariants({ variant: 'outline', size: 'sm' })

export function AdminOverviewView(props: AdminOverviewViewProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <AdminOverviewViewQuery {...props} />
  return (
    <AuroraQueryProvider client={props.client}>
      <AdminOverviewViewQuery {...props} />
    </AuroraQueryProvider>
  )
}

function AdminOverviewViewQuery({ client }: AdminOverviewViewProps) {
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const overviewQuery = useQuery<AdminOverviewManifest, unknown>({
    queryKey: queryKeys.admin('overview'),
    queryFn: () => buildAdminOverviewSnapshot(client),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval
  })

  return (
    <AdminOverviewContent
      manifest={overviewQuery.data ?? null}
      transportKind={client.transport.kind}
      error={overviewQuery.error}
      loading={overviewQuery.isPending}
    />
  )
}

export async function buildAdminOverviewSnapshot(client: AuroraClient): Promise<AdminOverviewManifest> {
  return client.adminOverview.getManifest()
}

export function AdminOverviewContent({ manifest, transportKind, error, loading = false }: AdminOverviewContentProps) {
  if (!manifest && loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
        <PageHeader
          id="admin-overview-title"
          eyebrow="Admin"
          title="Admin overview"
          description="Loading service health and availability."
        />
        <SurfaceSkeleton title="Service overview loading" lines={4} />
      </div>
    )
  }
  if (!manifest) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          id="admin-overview-title"
          eyebrow="Admin"
          title="Admin overview"
          description="Aurora could not load the service overview. Controls stay disabled until service status is available."
        />
        <RouteStateNotice
          title="Service overview unavailable"
          state="error"
          message={errorMessage(error)}
        />
        <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
      </div>
    )
  }

  const posture = deploymentPosture(manifest)
  const gaps = capabilityGaps(manifest)
  const activity = activityItems(manifest, gaps)
  const manageMethods = manifest.methods.filter((method) => method.methodType === 'manage')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        id="admin-overview-title"
        eyebrow="Admin"
        title="Admin overview"
        description="Readiness, unavailable features, and next steps for this Aurora setup."
        actions={
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <LinkButton variant="outline" size="sm" nativeButton={false} role="link" style={{ lineHeight: 'var(--text-sm--line-height)' }} render={<a href="/diagnostics" />}>Diagnostics export</LinkButton>
            <LinkButton variant="outline" size="sm" nativeButton={false} role="link" style={{ lineHeight: 'var(--text-sm--line-height)' }} render={<a href="/admin/services" />}>Services</LinkButton>
            <LinkButton variant="outline" size="sm" nativeButton={false} role="link" style={{ lineHeight: 'var(--text-sm--line-height)' }} render={<a href="/admin/contracts" />}>Service actions</LinkButton>
          </div>
        }
      />

      <div className="flex flex-col gap-3.5">
        <PosturePanel manifest={manifest} posture={posture} />
        <DeploymentTopologyPanel manifest={manifest} transportKind={transportKind} />
        <ServiceHealthPanel services={manifest.services} />
        <CapabilityGapPanel gaps={gaps} internalOnly={manifest.internalOnly} />
        <ActivityPanel items={activity} />
      </div>

      <Card
        description="Protected actions"
        actions={<EvidenceBadge label={`${manageMethods.length} protected actions`} />}
        ariaLabel="Protected actions"
      >
        <h2 id="admin-action-title" className="text-base font-semibold">Protected actions</h2>
        <p className="text-sm text-muted-foreground">
          Sensitive changes are visible for review only. Use the confirmation flow to approve, run, undo, or inspect a failed action.
        </p>
        {manageMethods.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {manageMethods.slice(0, 8).map((method) => (
              <Button
                key={`${method.module}.${method.name}`}
                type="button"
                variant="outline"
                disabled
                disabledReason="Admin confirmation is required before this action can run."
              >
                {adminActionLabel(method)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No protected actions are available right now.</p>
        )}
      </Card>
    </div>
  )
}

function PosturePanel({ manifest, posture }: { manifest: AdminOverviewManifest; posture: AvailabilityState }) {
  const topology = manifest.deploymentTopology
  return (
    <Card
      className="@container/readiness"
      description="Current readiness for this Aurora setup."
      actions={<StatusBadge state={posture} />}
      ariaLabel="Aurora readiness"
    >
      <h2 className="text-base font-semibold">Readiness</h2>
      <MetaGrid
        ariaLabel="Aurora readiness facts"
        columns={1}
        className="@min-[36rem]/readiness:grid-cols-2"
        items={[
          { label: 'How Aurora is running', value: serviceModeLabel(manifest.serviceMode) },
          { label: 'Connection', value: topology ? deploymentModeLabel(topology) : 'Where Aurora runs unavailable' },
          {
            label: 'Last update',
            value: manifest.registryDigest ? 'Available' : 'Not reported'
          },
          { label: 'Services', value: String(manifest.totals.services) },
          { label: 'Actions', value: `${manifest.totals.externalMethods} available / ${manifest.totals.internalMethods} protected` },
          { label: 'Peers', value: String(manifest.totals.peers) },
          { label: 'Device features', value: deviceFeatureLabel(manifest.native.availability) }
        ]}
      />
    </Card>
  )
}

function DeploymentTopologyPanel({
  manifest,
  transportKind
}: {
  manifest: AdminOverviewManifest
  transportKind: string
}) {
  const topology = manifest.deploymentTopology
  const topologyState = deploymentTopologyState(topology, manifest.deploymentTopologyError)
  const staleServices = topology?.service_process_topology.filter((service) => service.stale) ?? []
  const visibleServices = topology?.service_process_topology.slice(0, 6) ?? []
  const degradedReasons = sortedUnique([
    ...(topology?.mode_capability_degradations ?? []),
    ...(topology?.bullmq_queue_health.degraded_reasons ?? [])
  ])
  const controlsSupported = supportsProcessControls(manifest)
  const topologyColumns: Array<DataColumn<(typeof visibleServices)[number]>> = [
    { key: 'service', header: 'Service', render: (service) => adminModuleLabel(service.module) },
    { key: 'topology', header: 'Runs as', render: (service) => servicePlacementLabel(service.topology) },
    { key: 'status', header: 'Status', render: (service) => (service.stale ? 'Needs refresh' : serviceStatusLabel(service.status)) },
    { key: 'hint', header: 'Location', render: (service) => serviceLocationLabel(service.container_hint ?? service.process_hint), hideAt: 'md' }
  ]

  return (
    <Card
      title={<h2 className="text-base font-semibold">Where Aurora runs</h2>}
      description="Where Aurora is available and whether anything needs attention."
      actions={<StatusBadge state={topologyState} />}
      ariaLabel="Where Aurora runs"
    >
      <div className="@container/deployment flex min-w-0 flex-col gap-4">
        {topology ? (
          <>
            <MetaGrid
              columns={1}
              className="@min-[40rem]/deployment:grid-cols-2"
              ariaLabel="Aurora location details"
              items={[
                { label: 'This view', value: clientBoundaryLabel(transportKind, topology) },
                { label: 'Where Aurora runs', value: deploymentModeLabel(topology) },
                { label: 'Pending work', value: queueHealthLabel(topology) },
                { label: 'Connection', value: connectionHealthLabel(topology) },
                { label: 'Service status', value: staleServices.length > 0 ? `${staleServices.length} service(s) need attention` : 'Current' },
                { label: 'Locations', value: containerHintLabel(topology) },
                { label: 'Sensitive data', value: topology.secrets_redacted ? 'Protected' : 'Needs review' }
              ]}
            />

            {degradedReasons.length > 0 ? (
              <ul className="grid list-none gap-2 p-0" aria-label="Items needing attention">
                {degradedReasons.map((reason) => (
                  <li key={reason} className={gapListItemClass}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <strong className="text-sm font-medium">{degradedReasonTitle(reason)}</strong>
                      <small className="text-xs text-muted-foreground">{degradedReasonCopy(reason)}</small>
                    </div>
                    <StatusBadge state="degraded" />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No service issues reported"
                message="Services are running without any reported issues."
              />
            )}

            {visibleServices.length > 0 ? (
              <DataTable
                columns={topologyColumns}
                rows={visibleServices}
                getRowKey={(service) => `${service.module}:${service.instance_id ?? service.topology}`}
                caption="Where services run"
              />
            ) : null}
          </>
        ) : (
          <>
            <RouteStateNotice
              title="Where Aurora runs unavailable"
              state="empty"
              message={manifest.deploymentTopologyError ? 'Aurora could not read where services are running. Open diagnostics for details.' : 'Aurora did not return where services are running.'}
            />
            <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
          </>
        )}

        <div className="flex flex-wrap gap-1.5" aria-label="Admin overview links and actions">
          <a className={chipLinkClass} href="/diagnostics">Diagnostics export</a>
          <a className={chipLinkClass} href="/admin/services">Services</a>
          <a className={chipLinkClass} href="/admin/contracts">Service actions</a>
          <a className={chipLinkClass} href="/admin/config">Settings impact</a>
          <a className={chipLinkClass} href="https://github.com/joaojhgs/aurora/blob/main/README.process-mode.md">Operations guide</a>
          <Button
            type="button"
            variant="outline"
            disabled={!controlsSupported}
            disabledReason={
              controlsSupported
                ? 'Service actions are present, but this overview remains read-only.'
                : 'Service actions are not ready for this view.'
            }
          >
            Service actions {controlsSupported ? 'read-only here' : 'not ready'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ServiceHealthPanel({ services }: { services: AdminOverviewServiceSummary[] }) {
  const visible = services.slice(0, 10)
  const columns: Array<DataColumn<AdminOverviewServiceSummary>> = [
    { key: 'service', header: 'Service', render: (service) => adminModuleLabel(service.module) },
    { key: 'status', header: 'Status', render: (service) => serviceStatusLabel(service.status) },
    { key: 'methods', header: 'Actions', render: (service) => `${service.externalMethodCount} available / ${service.internalMethodCount} protected` },
    { key: 'permissions', header: 'Permissions', render: (service) => service.requiredPermissions.length > 0 ? `${service.requiredPermissions.length} needed` : 'none' }
  ]
  return (
    <Card
      description="Services"
      actions={<EvidenceBadge label={`${services.length} reported`} />}
      ariaLabel="Service health"
    >
      <h2 className="text-base font-semibold">Health</h2>
      {visible.length > 0 ? (
        <DataTable columns={columns} rows={visible} getRowKey={(service) => service.module} caption="Service health" />
      ) : (
        <>
          <EmptyState
            title="No services shown"
            message="Aurora loaded successfully, but no service summaries are available right now."
          />
          <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
        </>
      )}
    </Card>
  )
}

function CapabilityGapPanel({
  gaps,
  internalOnly
}: {
  gaps: CapabilitySummary[]
  internalOnly: MethodDescriptor[]
}) {
  return (
    <Card
      description="Unavailable features"
      actions={<EvidenceBadge label={`${gaps.length} unavailable`} />}
      ariaLabel="Unavailable features"
    >
      <h2 className="text-base font-semibold">Unavailable features</h2>
      {gaps.length > 0 ? (
        <ul className="grid list-none gap-2 p-0">
          {gaps.slice(0, 8).map((gap) => (
            <li key={gap.id} className={gapListItemClass}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <strong className="text-sm font-medium">{adminCapabilityLabel(gap)}</strong>
                <small className="text-xs text-muted-foreground">{serviceTargetLabel(gap)}</small>
                <span className="text-xs text-muted-foreground">{availabilityReason(gap)}</span>
              </div>
              <StatusBadge state={gap.availability} />
              <PrivacyBadge privacy={gap.privacyClass} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No unavailable features reported"
          message="Aurora did not report blocked, out-of-date, permission-needed, or unavailable actions."
        />
      )}
      {internalOnly.length > 0 ? (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-primary">Background actions</summary>
          <ul className="mt-2 flex flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {internalOnly.slice(0, 10).map((method) => (
              <li key={`${method.module}.${method.name}`}>{adminActionLabel(method)}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  )
}

function ActivityPanel({ items }: { items: ActivityItem[] }) {
  return (
    <Card
      description="Activity"
      actions={<EvidenceBadge label="Current view" />}
      ariaLabel="Activity"
    >
      <h2 className="text-base font-semibold">Activity</h2>
      <ol className="grid list-none gap-2 p-0">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2.5 rounded-lg border border-border p-3">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${activityDotClass(item.state)}`} aria-hidden />
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-sm font-medium">{item.label}</strong>
              <small className="text-xs text-muted-foreground">{item.detail}</small>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function activityDotClass(state: ActivityItem['state']): string {
  if (state === 'available-local' || state === 'available-remote') return 'bg-success'
  if (state === 'pending' || state === 'degraded' || state === 'offline') return 'bg-warning'
  if (state === 'denied' || state === 'privacy-blocked') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

function deploymentPosture(manifest: AdminOverviewManifest): AvailabilityState {
  if (manifest.deploymentTopologyError) return 'degraded'
  if (manifest.deploymentTopology?.bullmq_queue_health.status === 'degraded') return 'degraded'
  if (manifest.deploymentTopology?.mode_capability_degradations.length) return 'degraded'
  if (manifest.totals.services === 0) return 'unsupported'
  if (manifest.unavailable.some((capability) => capability.availability === 'denied')) return 'denied'
  if (manifest.unavailable.some((capability) => capability.availability === 'stale')) return 'stale'
  if (manifest.unavailable.length > 0 || manifest.internalOnly.length > 0) return 'degraded'
  if (manifest.deploymentTopology?.runtime_mode.toLowerCase().includes('thin')) return 'available-remote'
  return 'available-local'
}

function deploymentTopologyState(
  topology: DeploymentTopologyResponse | null,
  error: string | null
): AvailabilityState {
  if (error || !topology) return 'unsupported'
  if (
    topology.redis_reachable === false ||
    topology.bullmq_queue_health.status === 'degraded' ||
    topology.bullmq_queue_health.degraded_reasons.length > 0 ||
    topology.mode_capability_degradations.length > 0 ||
    topology.service_process_topology.some((service) => service.stale) ||
    topology.mesh_peer_topology_trusted === false
  ) {
    return 'degraded'
  }
  if (topology.runtime_mode.includes('mesh') || topology.architecture_mode.includes('mesh')) {
    return topology.mesh_peer_topology_trusted ? 'available-remote' : 'privacy-blocked'
  }
  if (topology.runtime_mode.includes('thin')) return 'available-remote'
  return 'available-local'
}

function serviceModeLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('process')) return 'Services run independently'
  if (normalized.includes('thread')) return 'Services run together'
  if (normalized.includes('mesh')) return 'Connected through approved devices'
  if (normalized.includes('remote') || normalized.includes('thin')) return 'Connected to another Aurora device'
  if (normalized.includes('local')) return 'Available on this device'
  return 'Reported'
}

function deploymentModeLabel(topology: DeploymentTopologyResponse): string {
  const mode = topology.architecture_mode.toLowerCase()
  const runtime = topology.runtime_mode.toLowerCase()
  if (runtime.includes('desktop-local') || runtime.includes('sidecar')) return 'Available on this computer'
  if (runtime.includes('desktop-thin') || runtime.includes('server-thin')) return 'Connected to another Aurora device'
  if (runtime.includes('mesh') || mode.includes('mesh')) return 'Connected through approved devices'
  if (mode.includes('process')) return 'Services run independently'
  if (mode.includes('thread')) return 'Services run together'
  return 'Aurora status reported'
}

function clientBoundaryLabel(transportKind: string, topology: DeploymentTopologyResponse): string {
  if (transportKind === 'tauri') return `This computer; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mesh') return `Approved devices; ${deploymentModeLabel(topology)}`
  if (transportKind === 'http') return `Connected; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mock') return `Preview; ${deploymentModeLabel(topology)}`
  return deploymentModeLabel(topology)
}

function queueHealthLabel(topology: DeploymentTopologyResponse): string {
  const health = topology.bullmq_queue_health
  if (health.status === 'degraded') return 'Needs attention'
  if (health.queue_depth !== null) return `${health.queue_depth} waiting`
  if (!health.queue_lag_known) return 'Status unavailable'
  return 'Ready'
}

function connectionHealthLabel(topology: DeploymentTopologyResponse): string {
  if (topology.redis_reachable === false) return 'Connection needed for pending work'
  if (topology.redis_reachable === true) return 'Connected'
  return topology.architecture_mode === 'threads' ? 'Not needed' : 'Not reported'
}

function containerHintLabel(topology: DeploymentTopologyResponse): string {
  const hints = topology.container_topology_hints
  const services = [
    hints.orchestrator,
    hints.compose_file,
    hints.redis_service,
    hints.gateway_service,
    hints.config_service
  ].filter(Boolean)
  return services.length > 0 ? productAdminCountCopy(services.length, 'location') : 'Not reported'
}

function degradedReasonTitle(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized.includes('redis_unreachable')) return 'Connection needs attention'
  if (normalized.includes('bullmq_queue_lag_unknown')) return 'Pending work needs review'
  if (normalized.includes('process_registry_stale')) return 'Service status needs refresh'
  if (normalized.includes('thread_mode_no_process_controls')) return 'Separate service actions unavailable'
  if (normalized.includes('mesh_peer_topology_untrusted')) return 'Connected device needs confirmation'
  return adminReasonText(reason)
}

function degradedReasonCopy(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized.includes('redis_unreachable')) return 'Aurora cannot check pending work. Open diagnostics and check the device running Aurora.'
  if (normalized.includes('bullmq_queue_lag_unknown')) return 'Aurora cannot confirm pending work is current. Open diagnostics before taking action.'
  if (normalized.includes('process_registry_stale')) return 'Service status may be out of date. Check Services before taking action.'
  if (normalized.includes('thread_mode_no_process_controls')) return 'This Aurora setup does not support separate service actions.'
  if (normalized.includes('mesh_peer_topology_untrusted')) return 'Confirm the connected device before showing details.'
  return 'Open diagnostics and the guide before taking action.'
}

function supportsProcessControls(manifest: AdminOverviewManifest): boolean {
  return manifest.methods.some((method) =>
    method.busTopic === 'Supervisor.RestartService' &&
    method.methodType === 'manage' &&
    method.availableOverHttp &&
    !manifest.deploymentTopology?.mode_capability_degradations.includes('thread_mode_no_process_controls')
  )
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function capabilityGaps(manifest: AdminOverviewManifest): CapabilitySummary[] {
  return [...manifest.unavailable].sort((a, b) =>
    `${a.availability}:${a.module}:${a.method}`.localeCompare(`${b.availability}:${b.module}:${b.method}`)
  )
}

function activityItems(manifest: AdminOverviewManifest, gaps: CapabilitySummary[]): ActivityItem[] {
  const newestGap = gaps[0]
  return [
    {
      id: 'registry',
      state: manifest.totals.methods > 0 ? 'available-local' : 'unsupported',
      label: 'Service list loaded',
      detail: productAdminPairCountCopy(manifest.totals.methods, 'action', manifest.totals.services, 'service')
    },
    {
      id: 'catalog',
      state: manifest.totals.capabilityActions > 0 ? 'available-local' : 'unsupported',
      label: 'Available actions',
      detail: `${manifest.totals.capabilityActions} actions available`
    },
    {
      id: 'gap',
      state: newestGap?.availability ?? 'available-local',
      label: newestGap ? adminCapabilityLabel(newestGap) : 'No active gap',
      detail: newestGap ? availabilityReason(newestGap) : 'No blocked action in the current view'
    },
    {
      id: 'native',
      state: manifest.native.availability,
      label: 'Device features',
      detail: productAdminDeviceFeatureCopy(devicePlatformLabel(manifest.native.platform), manifest.native.capabilityKeys.length)
    }
  ]
}

function adminCapabilityLabel(capability: CapabilitySummary): string {
  return adminActionLabel({
    module: capability.module,
    name: capability.method,
    busTopic: capability.busTopic ?? capability.method,
  })
}

function errorMessage(error: unknown): string {
  return adminErrorTitle(error)
}

function deviceFeatureLabel(state: AvailabilityState): string {
  if (state === 'available-local' || state === 'available-remote') return 'Available'
  if (state === 'pending') return 'Checking'
  if (state === 'denied' || state === 'privacy-blocked') return 'Needs permission'
  if (state === 'offline') return 'This device is offline'
  return 'Not ready'
}

function devicePlatformLabel(platform: string): string {
  if (/android/i.test(platform)) return 'Android'
  if (/ios|iphone|ipad/i.test(platform)) return 'iOS'
  if (/darwin|mac/i.test(platform)) return 'macOS'
  if (/windows/i.test(platform)) return 'Windows'
  if (/linux/i.test(platform)) return 'Linux'
  return 'Device'
}

function servicePlacementLabel(value: string): string {
  if (/process|container/i.test(value)) return 'Runs separately'
  if (/thread/i.test(value)) return 'Runs together'
  if (/remote|mesh/i.test(value)) return 'Connected device'
  return 'Reported'
}

function serviceStatusLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (/healthy|ready|running|ok/.test(normalized)) return 'Ready'
  if (/stale|degraded|slow|lag/.test(normalized)) return 'Needs attention'
  if (/offline|down|failed|error|unavailable/.test(normalized)) return 'Unavailable'
  return sanitizeAdminText(value, 'Reported')
}

function serviceLocationLabel(value: string | null | undefined): string {
  if (!value) return 'Not reported'
  return 'Configured'
}

function serviceTargetLabel(gap: CapabilitySummary): string {
  if (gap.peerId && gap.peerId !== 'local-peer') return 'Connected device'
  return 'This device'
}

function availabilityReason(capability: CapabilitySummary): string {
  if (capability.availability === 'offline' || capability.availability === 'stale') return 'This device is offline'
  if (capability.availability === 'denied' || capability.availability === 'privacy-blocked') return 'Permission is needed to use this feature'
  if (capability.availability === 'unsupported') return 'This Aurora version cannot use that feature yet'
  if (capability.routeBlockers.length > 0) return 'This action is not ready yet'
  return 'Ready'
}
