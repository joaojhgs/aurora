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
  const [error, setError] = useState<unknown>(new Error('Loading admin overview manifest from Aurora.'))

  useEffect(() => {
    let cancelled = false
    setManifest(null)
    setError(new Error('Loading admin overview manifest from Aurora.'))
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
          description="Aurora could not load the admin overview manifest. Controls stay disabled until service status is available."
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
        description="Deployment posture, service health, capability gaps, and repair paths are rendered from the SDK admin overview manifest."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/diagnostics">Diagnostics export</a>
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/admin/services">Services</a>
            <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/admin/contracts">Contracts registry</a>
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
        description="Mutation boundary"
        actions={<EvidenceBadge label={`${manageMethods.length} manage methods`} />}
        ariaLabel="AdminAction controller"
      >
        <h2 id="admin-action-title" className="text-base font-semibold">AdminAction controller</h2>
        <p className="text-sm text-muted-foreground">
          Manage/admin-critical operations are visible for audit planning only. They remain disabled here until a dedicated AdminAction flow provides draft, confirm, submit, rollback, and error state.
        </p>
        {manageMethods.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {manageMethods.slice(0, 8).map((method) => (
              <Button
                key={`${method.module}.${method.name}`}
                type="button"
                variant="outline"
                disabled
                disabledReason="AdminAction draft/confirm/audit is required before this mutation can run."
              >
                {method.module}.{method.name}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No manage methods were reported by the registry.</p>
        )}
      </Card>
    </div>
  )
}

function PosturePanel({ manifest, posture }: { manifest: AdminOverviewManifest; posture: AvailabilityState }) {
  const topology = manifest.deploymentTopology
  return (
    <Card
      description="Deployment posture from the admin overview manifest."
      actions={<StatusBadge state={posture} />}
      ariaLabel="Deployment posture"
    >
      <h2 className="text-base font-semibold">Posture</h2>
      <MetaGrid
        ariaLabel="Deployment posture facts"
        items={[
          { label: 'Service mode', value: manifest.serviceMode },
          { label: 'Runtime', value: topology ? deploymentModeLabel(topology) : 'service contract topology unavailable' },
          { label: 'Registry digest', value: manifest.registryDigest || 'not reported', mono: Boolean(manifest.registryDigest) },
          { label: 'Services', value: String(manifest.totals.services) },
          { label: 'Methods', value: `${manifest.totals.externalMethods} external / ${manifest.totals.internalMethods} internal` },
          { label: 'Peers', value: String(manifest.totals.peers) },
          { label: 'Native', value: `${manifest.native.availability} via ${manifest.native.evidenceSource}` }
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
    { key: 'service', header: 'Service', render: (service) => service.module },
    { key: 'topology', header: 'Topology', render: (service) => service.topology },
    { key: 'status', header: 'Status', render: (service) => (service.stale ? 'stale' : service.status) },
    { key: 'hint', header: 'Hint', render: (service) => service.container_hint ?? service.process_hint ?? 'not reported', hideAt: 'md' }
  ]

  return (
    <Card
      description="Runtime topology from Gateway.GetDeploymentTopology."
      actions={<StatusBadge state={topologyState} />}
      ariaLabel="Deployment topology"
      flush={visibleServices.length > 0}
    >
      <h2 className="text-base font-semibold">Deployment topology</h2>
      {topology ? (
        <>
          <MetaGrid
            ariaLabel="Deployment topology facts"
            items={[
              { label: 'Client boundary', value: clientBoundaryLabel(transportKind, topology) },
              { label: 'Architecture', value: `${topology.architecture_mode} / ${topology.runtime_mode}` },
              { label: 'Bus backend', value: topology.bus_backend },
              { label: 'Redis', value: redisHealthLabel(topology) },
              { label: 'BullMQ', value: busHealthLabel(topology) },
              { label: 'Registry freshness', value: staleServices.length > 0 ? `${staleServices.length} stale services` : 'fresh topology status' },
              { label: 'Container hints', value: containerHintLabel(topology) },
              { label: 'Redaction', value: topology.secrets_redacted ? 'secrets protected by backend' : 'redaction not confirmed' }
            ]}
          />

          {degradedReasons.length > 0 ? (
            <ul className="grid list-none gap-2 p-0" aria-label="Deployment degraded reasons">
              {degradedReasons.map((reason) => (
                <li key={reason} className={gapListItemClass}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <strong className="text-sm font-medium">{reason}</strong>
                    <small className="text-xs text-muted-foreground">{degradedReasonCopy(reason)}</small>
                  </div>
                  <StatusBadge state="degraded" />
                </li>
              ))}
            </ul>
          ) : (
            <div className={emptyPanelClass}>
              <h3 className="font-medium">No topology degradation reported</h3>
              <p className="text-muted-foreground">BE-016 did not report Redis, BullMQ, process registry, or mesh topology degradation in this snapshot.</p>
            </div>
          )}

          {visibleServices.length > 0 ? (
            <DataTable
              columns={topologyColumns}
              rows={visibleServices}
              getRowKey={(service) => `${service.module}:${service.instance_id ?? service.topology}`}
              caption="Service process topology"
            />
          ) : null}
        </>
      ) : (
        <div className={emptyPanelClass} role="status">
          <h3 className="font-medium">Deployment topology unavailable</h3>
          <p className="text-muted-foreground">{manifest.deploymentTopologyError ?? 'Gateway.GetDeploymentTopology did not return service contract status.'}</p>
          <a className={chipLinkClass} href="/diagnostics">Open diagnostics</a>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5" aria-label="Deployment topology links and controls">
        <a className={chipLinkClass} href="/diagnostics">Diagnostics export</a>
        <a className={chipLinkClass} href="/admin/services">Services</a>
        <a className={chipLinkClass} href="/admin/contracts">Contracts registry</a>
        <a className={chipLinkClass} href="/admin/config">Config reload impact</a>
        <a className={chipLinkClass} href="https://github.com/joaojhgs/aurora/blob/main/README.process-mode.md">Process runbook</a>
        <Button
          type="button"
          variant="outline"
          disabled={!controlsSupported}
          disabledReason={
            controlsSupported
              ? 'service contract process controls are present, but this overview remains read-only.'
              : 'Process restart/control requires service contract capability and AdminAction wiring.'
          }
        >
          Process controls {controlsSupported ? 'read-only here' : 'unsupported'}
        </Button>
      </div>
    </Card>
  )
}

function ServiceHealthPanel({ services }: { services: AdminOverviewServiceSummary[] }) {
  const visible = services.slice(0, 10)
  const columns: Array<DataColumn<AdminOverviewServiceSummary>> = [
    { key: 'service', header: 'Service', render: (service) => service.module },
    { key: 'status', header: 'Status', render: (service) => service.status },
    { key: 'methods', header: 'Methods', render: (service) => `${service.externalMethodCount} external / ${service.internalMethodCount} internal` },
    { key: 'permissions', header: 'Permissions', render: (service) => service.requiredPermissions.join(', ') || 'none' }
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
          <p className="text-muted-foreground">The registry loaded, but no service summaries were returned by the SDK.</p>
          <a className={chipLinkClass} href="/diagnostics">Inspect registry</a>
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
                <strong className="text-sm font-medium">{gap.module}.{gap.method}</strong>
                <small className="text-xs text-muted-foreground">{gap.providerId} / {gap.serviceInstanceId}</small>
                <span className="text-xs text-muted-foreground">{gap.routeBlockers.join(', ') || 'backend reported unavailable'}</span>
              </div>
              <StatusBadge state={gap.availability} />
              <PrivacyBadge privacy={gap.privacyClass} />
            </li>
          ))}
        </ul>
      ) : (
        <div className={emptyPanelClass}>
          <h3 className="font-medium">No capability gaps reported</h3>
          <p className="text-muted-foreground">The capability catalog did not report denied, stale, privacy-blocked, or unsupported actions.</p>
        </div>
      )}
      {internalOnly.length > 0 ? (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-primary">Internal-only methods</summary>
          <ul className="mt-2 flex flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {internalOnly.slice(0, 10).map((method) => (
              <li key={`${method.module}.${method.name}`}>{method.module}.{method.name}</li>
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
      actions={<EvidenceBadge label="SDK snapshot" />}
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
  if (runtime.includes('desktop-local') || runtime.includes('sidecar')) return 'desktop local sidecar'
  if (runtime.includes('desktop-thin') || runtime.includes('server-thin')) return 'remote Gateway thin client'
  if (runtime.includes('mesh') || mode.includes('mesh')) return 'mesh peer-only shell'
  if (mode.includes('process')) return 'server process-mode deployment'
  if (mode.includes('thread')) return 'local thread-mode app'
  return `${topology.architecture_mode} / ${topology.runtime_mode}`
}

function clientBoundaryLabel(transportKind: string, topology: DeploymentTopologyResponse): string {
  if (transportKind === 'tauri') return `Desktop local through SDK; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mesh') return `Mesh transport through SDK; ${deploymentModeLabel(topology)}`
  if (transportKind === 'http') return `Supported remote Gateway client through SDK HTTP transport; ${deploymentModeLabel(topology)}`
  if (transportKind === 'mock') return `Local transport; ${deploymentModeLabel(topology)}`
  return `${transportKind} transport; ${deploymentModeLabel(topology)}`
}

function redisHealthLabel(topology: DeploymentTopologyResponse): string {
  if (topology.redis_reachable === true) return `${topology.redis_url_redacted ?? 'redacted Redis URL'} reachable`
  if (topology.redis_reachable === false) return 'unreachable; check Redis service and REDIS_URL redaction'
  return topology.architecture_mode === 'threads' ? 'not required for thread mode' : 'not reported'
}

function busHealthLabel(topology: DeploymentTopologyResponse): string {
  const health = topology.bullmq_queue_health
  const parts = [health.backend, health.status]
  if (health.queue_depth !== null) parts.push(`queue depth ${health.queue_depth}`)
  if (!health.queue_lag_known) parts.push('queue lag unknown')
  return parts.join(' / ')
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
  return services.join(' / ') || 'not reported'
}

function degradedReasonCopy(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized.includes('redis_unreachable')) return 'Open diagnostics, verify Redis is running, and confirm the redacted REDIS_URL target.'
  if (normalized.includes('bullmq_queue_lag_unknown')) return 'BullMQ queue lag is unavailable; use diagnostics before trusting process-mode throughput.'
  if (normalized.includes('process_registry_stale')) return 'Service registry heartbeat is stale; inspect /admin/services and /admin/contracts before taking action.'
  if (normalized.includes('thread_mode_no_process_controls')) return 'Thread mode runs in one Python process; process restart controls are intentionally disabled.'
  if (normalized.includes('mesh_peer_topology_untrusted')) return 'Remote peer topology is not trusted; require authenticated peer status before displaying details.'
  return 'Inspect diagnostics and the process-mode runbook before taking operator action.'
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
      label: 'Registry loaded',
      detail: `${manifest.totals.methods} methods across ${manifest.totals.services} services`
    },
    {
      id: 'catalog',
      state: manifest.totals.capabilityActions > 0 ? 'available-local' : 'unsupported',
      label: 'Capability catalog',
      detail: `${manifest.totals.capabilityActions} executable actions reported`
    },
    {
      id: 'gap',
      state: newestGap?.availability ?? 'available-local',
      label: newestGap ? `${newestGap.module}.${newestGap.method}` : 'No active gap',
      detail: newestGap?.routeBlockers.join(', ') || 'No blocked capability in the current SDK snapshot'
    },
    {
      id: 'native',
      state: manifest.native.availability,
      label: 'Native manifest',
      detail: `${manifest.native.platform}; ${manifest.native.capabilityKeys.length} capabilities`
    }
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown SDK error'
}
