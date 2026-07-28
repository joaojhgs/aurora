"use client"

import { useEffect, useState } from 'react'
import type {
  AdminOverviewManifest,
  AdminOverviewServiceSummary,
  AuroraClient,
  AvailabilityState,
  CapabilitySummary,
  DeploymentTopologyResponse,
  MethodDescriptor
} from '@aurora/client'
import { buttonVariants } from '#components/ui/button'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
import { PageHeader } from './state-surface'
import { Button, Card, DataTable, MetaGrid, type DataColumn } from './primitives'
import { adminActionLabel, adminErrorTitle, adminModuleLabel, adminReasonText, sanitizeAdminText } from './admin-product-copy'

export interface AdminOverviewViewProps {
  client: AuroraClient
}

export interface AdminOverviewContentProps {
  manifest: AdminOverviewManifest | null
  transportKind: string
  error?: unknown
}

interface ActivityItem {
  id: string
  state: AvailabilityState | 'error'
  label: string
  detail: string
}

const emptyPanelClass = 'flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4 text-sm'
const gapListItemClass = 'grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-border p-3'
const chipLinkClass = buttonVariants({ variant: 'outline', size: 'sm' })

export function AdminOverviewView({ client }: AdminOverviewViewProps) {
  const [manifest, setManifest] = useState<AdminOverviewManifest | null>(null)
  const [error, setError] = useState<unknown>(new Error('Loading Aurora service overview.'))

  useEffect(() => {
    let cancelled = false
    setManifest(null)
    setError(new Error('Loading Aurora service overview.'))
    void buildAdminOverviewSnapshot(client).then(
      (next) => {
        if (!cancelled) {
          setManifest(next)
          setError(undefined)
        }
      },
      (nextError: unknown) => {
        if (!cancelled) {
          setManifest(null)
          setError(nextError)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [client])

  return <AdminOverviewContent manifest={manifest} transportKind={client.transport.kind} error={error} />
}

export async function buildAdminOverviewSnapshot(client: AuroraClient): Promise<AdminOverviewManifest> {
  return client.adminOverview.getManifest()
}

export function AdminOverviewContent({ manifest, transportKind, error }: AdminOverviewContentProps) {
  if (!manifest) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          id="admin-overview-title"
          eyebrow="Admin"
          title="Admin overview"
          description="Aurora could not load the service overview. Controls stay disabled until service status is available."
        />
        <div className={emptyPanelClass} role="alert">
          <h2 className="text-base font-semibold">Service overview unavailable</h2>
          <p className="text-muted-foreground">{errorMessage(error)}</p>
          <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
        </div>
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
        description="Service health, availability gaps, and repair paths for this Aurora setup."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/diagnostics">Diagnostics export</a>
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/admin/services">Services</a>
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/admin/contracts">Service actions</a>
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
        description="Protected changes"
        actions={<EvidenceBadge label={`${manageMethods.length} manage methods`} />}
        ariaLabel="Protected admin changes"
      >
        <h2 id="admin-action-title" className="text-base font-semibold">Protected admin changes</h2>
        <p className="text-sm text-muted-foreground">
          Sensitive operations are visible for review only. Use the dedicated confirmation flow to approve, run, undo, or inspect a failed action.
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
          <p className="text-sm text-muted-foreground">No protected actions were reported.</p>
        )}
      </Card>
    </div>
  )
}

function PosturePanel({ manifest, posture }: { manifest: AdminOverviewManifest; posture: AvailabilityState }) {
  const topology = manifest.deploymentTopology
  return (
    <Card
      description="Current availability for this Aurora setup."
      actions={<StatusBadge state={posture} />}
      ariaLabel="Deployment posture"
    >
      <h2 className="text-base font-semibold">Posture</h2>
      <MetaGrid
        ariaLabel="Deployment posture facts"
        items={[
          { label: 'Service mode', value: manifest.serviceMode },
          { label: 'Connection', value: topology ? deploymentModeLabel(topology) : 'Service layout unavailable' },
          { label: 'Refresh ID', value: manifest.registryDigest || 'not reported', mono: Boolean(manifest.registryDigest) },
          { label: 'Services', value: String(manifest.totals.services) },
          { label: 'Actions', value: `${manifest.totals.externalMethods} available / ${manifest.totals.internalMethods} Aurora-only` },
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
    { key: 'topology', header: 'Placement', render: (service) => servicePlacementLabel(service.topology) },
    { key: 'status', header: 'Status', render: (service) => (service.stale ? 'stale' : service.status) },
    { key: 'hint', header: 'Location', render: (service) => serviceLocationLabel(service.container_hint ?? service.process_hint), hideAt: 'md' }
  ]

  return (
    <Card
      description="Where Aurora services are running and whether they need attention."
      actions={<StatusBadge state={topologyState} />}
      ariaLabel="Service layout"
      flush={visibleServices.length > 0}
    >
      <h2 className="text-base font-semibold">Service layout</h2>
      {topology ? (
        <>
          <MetaGrid
            ariaLabel="Deployment topology facts"
            items={[
              { label: 'This screen', value: clientBoundaryLabel(transportKind, topology) },
              { label: 'Service layout', value: deploymentModeLabel(topology) },
              { label: 'Work queue', value: queueHealthLabel(topology) },
              { label: 'Connection health', value: connectionHealthLabel(topology) },
              { label: 'Service freshness', value: staleServices.length > 0 ? `${staleServices.length} service(s) need attention` : 'Current' },
              { label: 'Service locations', value: containerHintLabel(topology) },
              { label: 'Sensitive data', value: topology.secrets_redacted ? 'Protected' : 'Needs review' }
            ]}
          />

          {degradedReasons.length > 0 ? (
            <ul className="grid list-none gap-2 p-0" aria-label="Deployment degraded reasons">
              {degradedReasons.map((reason) => (
                <li key={reason} className={gapListItemClass}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <strong className="text-sm font-medium">{adminReasonText(reason)}</strong>
                    <small className="text-xs text-muted-foreground">{degradedReasonCopy(reason)}</small>
                  </div>
                  <StatusBadge state="degraded" />
                </li>
              ))}
            </ul>
          ) : (
            <div className={emptyPanelClass}>
              <h3 className="font-medium">No service layout issues reported</h3>
              <p className="text-muted-foreground">Aurora did not report service placement or queue issues in the current view.</p>
            </div>
          )}

          {visibleServices.length > 0 ? (
            <DataTable
              columns={topologyColumns}
              rows={visibleServices}
              getRowKey={(service) => `${service.module}:${service.instance_id ?? service.topology}`}
              caption="Service placement"
            />
          ) : null}
        </>
      ) : (
        <div className={emptyPanelClass} role="status">
          <h3 className="font-medium">Service layout unavailable</h3>
          <p className="text-muted-foreground">{manifest.deploymentTopologyError ? 'Aurora could not read service layout. Open diagnostics for details.' : 'Aurora did not return service layout.'}</p>
          <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5" aria-label="Deployment topology links and controls">
        <a className={chipLinkClass} href="/diagnostics">Diagnostics export</a>
        <a className={chipLinkClass} href="/admin/services">Services</a>
        <a className={chipLinkClass} href="/admin/contracts">Service actions</a>
        <a className={chipLinkClass} href="/admin/config">Config reload impact</a>
        <a className={chipLinkClass} href="https://github.com/joaojhgs/aurora/blob/main/README.process-mode.md">Process runbook</a>
        <Button
          type="button"
          variant="outline"
          disabled={!controlsSupported}
          disabledReason={
            controlsSupported
              ? 'Service controls are present, but this overview remains read-only.'
              : 'Service controls are not ready for this view.'
          }
        >
          Service controls {controlsSupported ? 'read-only here' : 'not ready'}
        </Button>
      </div>
    </Card>
  )
}

function ServiceHealthPanel({ services }: { services: AdminOverviewServiceSummary[] }) {
  const visible = services.slice(0, 10)
  const columns: Array<DataColumn<AdminOverviewServiceSummary>> = [
    { key: 'service', header: 'Service', render: (service) => adminModuleLabel(service.module) },
    { key: 'status', header: 'Status', render: (service) => sanitizeAdminText(service.status) },
    { key: 'methods', header: 'Actions', render: (service) => `${service.externalMethodCount} available / ${service.internalMethodCount} Aurora-only` },
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
        <div className={emptyPanelClass}>
          <h3 className="font-medium">No services reported</h3>
          <p className="text-muted-foreground">Aurora loaded successfully, but no service summaries were returned.</p>
          <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
        </div>
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
      description="Capabilities"
      actions={<EvidenceBadge label={`${gaps.length} gaps`} />}
      ariaLabel="Capability gaps"
    >
      <h2 className="text-base font-semibold">Gaps</h2>
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
        <div className={emptyPanelClass}>
          <h3 className="font-medium">No availability gaps reported</h3>
          <p className="text-muted-foreground">Aurora did not report denied, stale, consent-blocked, or unavailable actions.</p>
        </div>
      )}
      {internalOnly.length > 0 ? (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-primary">Actions only Aurora can use</summary>
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
      ariaLabel="Activity rail"
    >
      <h2 className="text-base font-semibold">Rail</h2>
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

function deploymentModeLabel(topology: DeploymentTopologyResponse): string {
  const mode = topology.architecture_mode.toLowerCase()
  const runtime = topology.runtime_mode.toLowerCase()
  if (runtime.includes('desktop-local') || runtime.includes('sidecar')) return 'Aurora running on this computer'
  if (runtime.includes('desktop-thin') || runtime.includes('server-thin')) return 'Connected to another Aurora device'
  if (runtime.includes('mesh') || mode.includes('mesh')) return 'Connected through approved devices'
  if (mode.includes('process')) return 'Aurora services running separately'
  if (mode.includes('thread')) return 'Aurora running together'
  return 'Aurora service layout reported'
}

function clientBoundaryLabel(transportKind: string, topology: DeploymentTopologyResponse): string {
  if (transportKind === 'tauri') return `This computer; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mesh') return `Approved devices; ${deploymentModeLabel(topology)}`
  if (transportKind === 'http') return `Connected; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mock') return `Local preview; ${deploymentModeLabel(topology)}`
  return deploymentModeLabel(topology)
}

function queueHealthLabel(topology: DeploymentTopologyResponse): string {
  const health = topology.bullmq_queue_health
  if (health.status === 'degraded') return 'Needs attention'
  if (health.queue_depth !== null) return `${health.queue_depth} waiting`
  if (!health.queue_lag_known) return 'Status incomplete'
  return 'Ready'
}

function connectionHealthLabel(topology: DeploymentTopologyResponse): string {
  if (topology.redis_reachable === false) return 'Connection needed for service queue'
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
  return services.length > 0 ? `${services.length} location hint(s)` : 'not reported'
}

function degradedReasonCopy(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized.includes('redis_unreachable')) return 'Aurora cannot reach the service queue. Open diagnostics and check the service host.'
  if (normalized.includes('bullmq_queue_lag_unknown')) return 'Aurora cannot confirm queue freshness. Open diagnostics before taking operator action.'
  if (normalized.includes('process_registry_stale')) return 'Service heartbeats are stale. Check Services before taking action.'
  if (normalized.includes('thread_mode_no_process_controls')) return 'This Aurora layout does not support separate service controls.'
  if (normalized.includes('mesh_peer_topology_untrusted')) return 'Connected device status is not trusted yet. Confirm the device before showing details.'
  return 'Open diagnostics and the runbook before taking operator action.'
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
      detail: `${manifest.totals.methods} actions across ${manifest.totals.services} services`
    },
    {
      id: 'catalog',
      state: manifest.totals.capabilityActions > 0 ? 'available-local' : 'unsupported',
      label: 'Available actions',
      detail: `${manifest.totals.capabilityActions} action(s) reported`
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
      detail: `${devicePlatformLabel(manifest.native.platform)}; ${manifest.native.capabilityKeys.length} feature(s)`
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
  if (/process|container/i.test(value)) return 'Separate service'
  if (/thread/i.test(value)) return 'Runs with Aurora'
  if (/remote|mesh/i.test(value)) return 'Connected device'
  return 'Reported'
}

function serviceLocationLabel(value: string | null | undefined): string {
  if (!value) return 'not reported'
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
