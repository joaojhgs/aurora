import type {
  AdminOverviewManifest,
  AdminOverviewServiceSummary,
  AuroraClient,
  AvailabilityState,
  CapabilitySummary,
  MethodDescriptor
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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

export async function AdminOverviewView({ client }: AdminOverviewViewProps) {
  try {
    const manifest = await client.adminOverview.getManifest()
    return <AdminOverviewContent manifest={manifest} transportKind={client.transport.kind} />
  } catch (error) {
    return <AdminOverviewContent manifest={null} transportKind={client.transport.kind} error={error} />
  }
}

export function AdminOverviewContent({ manifest, transportKind, error }: AdminOverviewContentProps) {
  if (!manifest) {
    return (
      <section className="aui-admin-overview" aria-labelledby="admin-overview-title">
        <AdminOverviewHeader
          title="Admin overview"
          description="AuroraClient could not load the admin overview manifest. Controls stay disabled until backend evidence is available."
          transportKind={transportKind}
          generatedAt="pending"
          secretsRedacted
        />
        <div className="aui-admin-empty" role="alert">
          <h2>Service overview unavailable</h2>
          <p>{errorMessage(error)}</p>
          <a className="aui-action-chip" href="/diagnostics">Open diagnostics</a>
        </div>
      </section>
    )
  }

  const posture = deploymentPosture(manifest)
  const gaps = capabilityGaps(manifest)
  const activity = activityItems(manifest, gaps)
  const manageMethods = manifest.methods.filter((method) => method.methodType === 'manage')

  return (
    <section className="aui-admin-overview" aria-labelledby="admin-overview-title">
      <AdminOverviewHeader
        title="Admin overview"
        description="Deployment posture, service health, capability gaps, and repair paths are rendered from the SDK admin overview manifest."
        transportKind={transportKind}
        generatedAt={manifest.generatedAt}
        secretsRedacted={manifest.privacy.secretsRedacted}
      />

      <div className="aui-admin-grid">
        <PosturePanel manifest={manifest} posture={posture} />
        <ServiceHealthPanel services={manifest.services} />
        <CapabilityGapPanel gaps={gaps} internalOnly={manifest.internalOnly} />
        <ActivityPanel items={activity} />
      </div>

      <section className="aui-admin-panel" aria-labelledby="admin-action-title">
        <div className="aui-admin-panel-header">
          <div>
            <p className="aui-kicker">Mutation boundary</p>
            <h2 id="admin-action-title">AdminAction controller</h2>
          </div>
          <EvidenceBadge label={`${manageMethods.length} manage methods`} />
        </div>
        <p>
          Manage/admin-critical operations are visible for audit planning only. They remain disabled here until their
          downstream task wires the matching AdminAction draft, confirm, submit, rollback, and error flow.
        </p>
        {manageMethods.length > 0 ? (
          <div className="aui-admin-action-list">
            {manageMethods.slice(0, 8).map((method) => (
              <button
                key={`${method.module}.${method.name}`}
                type="button"
                className="aui-action-chip"
                disabled
                title="AdminAction draft/confirm/audit is required before this mutation can run."
              >
                {method.module}.{method.name}
              </button>
            ))}
          </div>
        ) : (
          <p>No manage methods were reported by the registry.</p>
        )}
      </section>
    </section>
  )
}

function AdminOverviewHeader({
  title,
  description,
  transportKind,
  generatedAt,
  secretsRedacted
}: {
  title: string
  description: string
  transportKind: string
  generatedAt: string
  secretsRedacted: boolean
}) {
  return (
    <header className="aui-admin-header">
      <div>
        <p className="aui-kicker">Operator surface</p>
        <h1 id="admin-overview-title">{title}</h1>
        <p>{description}</p>
      </div>
      <div className="aui-admin-badges" aria-label="Admin overview evidence">
        <EvidenceBadge label={transportKind} />
        <EvidenceBadge label={secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        <EvidenceBadge label={generatedAt} />
      </div>
    </header>
  )
}

function PosturePanel({ manifest, posture }: { manifest: AdminOverviewManifest; posture: AvailabilityState }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="deployment-posture-title">
      <div className="aui-admin-panel-header">
        <div>
          <p className="aui-kicker">Deployment</p>
          <h2 id="deployment-posture-title">Posture</h2>
        </div>
        <StatusBadge state={posture} />
      </div>
      <dl className="aui-admin-facts">
        <div><dt>Service mode</dt><dd>{manifest.serviceMode}</dd></div>
        <div><dt>Registry digest</dt><dd>{manifest.registryDigest || 'not reported'}</dd></div>
        <div><dt>Services</dt><dd>{manifest.totals.services}</dd></div>
        <div><dt>Methods</dt><dd>{manifest.totals.externalMethods} external / {manifest.totals.internalMethods} internal</dd></div>
        <div><dt>Peers</dt><dd>{manifest.totals.peers}</dd></div>
        <div><dt>Native</dt><dd>{manifest.native.availability} via {manifest.native.evidenceSource}</dd></div>
      </dl>
    </section>
  )
}

function ServiceHealthPanel({ services }: { services: AdminOverviewServiceSummary[] }) {
  const visible = services.slice(0, 10)
  return (
    <section className="aui-admin-panel" aria-labelledby="service-health-title">
      <div className="aui-admin-panel-header">
        <div>
          <p className="aui-kicker">Services</p>
          <h2 id="service-health-title">Health</h2>
        </div>
        <EvidenceBadge label={`${services.length} reported`} />
      </div>
      {visible.length > 0 ? (
        <div className="aui-table-wrap">
          <table className="aui-admin-table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Status</th>
                <th scope="col">Methods</th>
                <th scope="col">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((service) => (
                <tr key={service.module}>
                  <th scope="row">{service.module}</th>
                  <td>{service.status}</td>
                  <td>{service.externalMethodCount} external / {service.internalMethodCount} internal</td>
                  <td>{service.requiredPermissions.join(', ') || 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="aui-admin-empty">
          <h3>No services reported</h3>
          <p>The registry loaded, but no service summaries were returned by the SDK.</p>
          <a className="aui-action-chip" href="/diagnostics">Inspect registry</a>
        </div>
      )}
    </section>
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
    <section className="aui-admin-panel" aria-labelledby="capability-gaps-title">
      <div className="aui-admin-panel-header">
        <div>
          <p className="aui-kicker">Capabilities</p>
          <h2 id="capability-gaps-title">Gaps</h2>
        </div>
        <EvidenceBadge label={`${gaps.length} gaps`} />
      </div>
      {gaps.length > 0 ? (
        <ul className="aui-admin-gap-list">
          {gaps.slice(0, 8).map((gap) => (
            <li key={gap.id}>
              <div>
                <strong>{gap.module}.{gap.method}</strong>
                <small>{gap.providerId} / {gap.serviceInstanceId}</small>
                <span>{gap.routeBlockers.join(', ') || 'backend reported unavailable'}</span>
              </div>
              <StatusBadge state={gap.availability} />
              <PrivacyBadge privacy={gap.privacyClass} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="aui-admin-empty">
          <h3>No capability gaps reported</h3>
          <p>The capability catalog did not report denied, stale, privacy-blocked, or unsupported actions.</p>
        </div>
      )}
      {internalOnly.length > 0 ? (
        <details className="aui-admin-details">
          <summary>Internal-only methods</summary>
          <ul>
            {internalOnly.slice(0, 10).map((method) => (
              <li key={`${method.module}.${method.name}`}>{method.module}.{method.name}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

function ActivityPanel({ items }: { items: ActivityItem[] }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="activity-rail-title">
      <div className="aui-admin-panel-header">
        <div>
          <p className="aui-kicker">Activity</p>
          <h2 id="activity-rail-title">Rail</h2>
        </div>
        <EvidenceBadge label="SDK snapshot" />
      </div>
      <ol className="aui-admin-activity">
        {items.map((item) => (
          <li key={item.id}>
            <span className={`aui-admin-activity-dot aui-dot-${item.state}`} aria-hidden />
            <div>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function deploymentPosture(manifest: AdminOverviewManifest): AvailabilityState {
  if (manifest.totals.services === 0) return 'unsupported'
  if (manifest.unavailable.some((capability) => capability.availability === 'denied')) return 'denied'
  if (manifest.unavailable.some((capability) => capability.availability === 'stale')) return 'stale'
  if (manifest.unavailable.length > 0 || manifest.internalOnly.length > 0) return 'degraded'
  return 'available-local'
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
