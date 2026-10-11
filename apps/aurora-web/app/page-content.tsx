import { RouteMatrix, StateSurface } from '@aurora/ui'
import { getShellSnapshot } from './shell-state'
import { auroraWebRouteById } from './route-registry'
import { PRODUCT_ROUTE_COPY } from './product-copy'

export interface AuroraRoutePageProps {
  routeId: string
}

export async function AuroraRoutePage({ routeId }: AuroraRoutePageProps) {
  const snapshot = await getShellSnapshot()
  const item = auroraWebRouteById.get(routeId)
  const copy = PRODUCT_ROUTE_COPY[routeId] ?? {
    title: item?.label ?? 'Page unavailable',
    description: 'This feature is available through Aurora.',
  }
  const route = snapshot.routes.find((candidate) => candidate.item.id === routeId)
  const state = route?.state ?? item?.fallbackState ?? 'unsupported'
  const evidence = route
    ? route.disabled ? 'Aurora found this page, but it is not ready on this device.' : 'Aurora found this page and checked its availability.'
    : 'Aurora could not confirm this page is available.'
  return (
    <div className="aw-page-stack">
      <StateSurface
        title={copy.title}
        state={state}
        description={copy.description}
        evidence={evidence}
        actionLabel={route?.requiresAdminAction ? 'Approval needed' : route?.disabled ? 'Feature unavailable' : null}
      />
      <div className="aw-page-grid">
        <section className="aw-panel">
          <h2>Feature Status</h2>
          <dl className="aw-facts">
            <div><dt>Availability</dt><dd>{route ? 'Checked by Aurora' : 'Not available yet'}</dd></div>
            <div><dt>About</dt><dd>{copy.description}</dd></div>
            <div><dt>Access</dt><dd>{route ? 'Checked by Aurora' : 'Not available yet'}</dd></div>
            <div><dt>Changes</dt><dd>{route?.requiresAdminAction ? 'Extra confirmation required' : 'Unavailable actions stay off until Aurora confirms them'}</dd></div>
          </dl>
        </section>
        <section className="aw-panel">
          <h2>What Happens Next</h2>
          <p>
            This page appears when Aurora cannot confirm the feature is ready. Actions remain unavailable until
            the affected device is reachable and the feature is allowed.
          </p>
        </section>
      </div>
      {routeId === 'diagnostics' ? <RouteMatrix routes={snapshot.routes} /> : null}
    </div>
  )
}
