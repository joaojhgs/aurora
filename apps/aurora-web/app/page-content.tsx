import { RouteMatrix, StateSurface, auroraNavSections, type AuroraNavItem } from '@aurora/ui'
import { getShellSnapshot } from './shell-state'

const routeById = new Map<string, AuroraNavItem>(
  auroraNavSections.flatMap((section) => section.items).map((item) => [item.id, item])
)

export interface AuroraRoutePageProps {
  routeId: string
  title: string
  description: string
}

export async function AuroraRoutePage({ routeId, title, description }: AuroraRoutePageProps) {
  const snapshot = await getShellSnapshot()
  const item = routeById.get(routeId)
  const route = snapshot.routes.find((candidate) => candidate.item.id === routeId)
  const state = route?.state ?? item?.fallbackState ?? 'unsupported'
  const evidence = route
    ? `${route.providerLabel}; blockers=${route.blockers.join(',') || 'none'}`
    : snapshot.evidenceSource
  return (
    <div className="aw-page-stack">
      <StateSurface
        title={title}
        state={state}
        description={description}
        evidence={evidence}
        actionLabel={route?.requiresAdminAction ? 'AdminAction required' : route?.disabled ? 'Capability unavailable' : null}
      />
      <div className="aw-page-grid">
        <section className="aw-panel">
          <h2>Route contract</h2>
          <dl className="aw-facts">
            <div><dt>Backend truth source</dt><dd>{snapshot.evidenceSource}</dd></div>
            <div><dt>Expected task</dt><dd>{route?.item.expectedTask ?? 'not mapped'}</dd></div>
            <div><dt>Privacy class</dt><dd>{route?.item.privacyClass ?? 'unknown'}</dd></div>
            <div><dt>Mutation control</dt><dd>{route?.requiresAdminAction ? 'AdminAction draft/confirm/audit' : 'read-only or later workflow task'}</dd></div>
          </dl>
        </section>
        <section className="aw-panel">
          <h2>UX boundary</h2>
          <p>
            This route is part of the production shell. Domain actions remain disabled or scoped until their downstream
            UI task wires the matching SDK operation, backend evidence, and verification.
          </p>
        </section>
      </div>
      {routeId === 'diagnostics' ? <RouteMatrix routes={snapshot.routes} /> : null}
    </div>
  )
}
