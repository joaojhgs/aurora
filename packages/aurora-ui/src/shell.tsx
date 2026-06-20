import type { ReactNode } from 'react'
import { Lock, Menu, PanelRight, Sparkles } from 'lucide-react'
import { auroraMobileTabs, auroraNavSections, getAuroraNavItem } from './nav'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface AppShellProps {
  snapshot: AuroraShellSnapshot
  currentPath?: string
  children: ReactNode
}

export function AppShell({ snapshot, currentPath = '/', children }: AppShellProps) {
  const activePath = normalizePath(currentPath)
  return (
    <div className="aui-shell">
      <aside className="aui-sidebar" aria-label="Primary navigation">
        <BrandHeader snapshot={snapshot} />
        <ShellNavigation activePath={activePath} routes={snapshot.routes} />
        <div className="aui-sidebar-card">
          <span className="aui-avatar">AD</span>
          <div>
            <strong>admin</strong>
            <span>Capability gated</span>
          </div>
        </div>
      </aside>
      <div className="aui-main-column">
        <header className="aui-topbar">
          <details className="aui-mobile-menu">
            <summary aria-label="Open menu"><Menu size={20} /></summary>
            <ShellNavigation activePath={activePath} routes={snapshot.routes} compact />
          </details>
          <div className="aui-status-row" aria-label="Aurora shell status">
            <EvidenceBadge label={snapshot.transportKind} />
            <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
            <EvidenceBadge label={snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native deferred'} />
            <span className="aui-badge">{snapshot.availableCount}/{snapshot.routeCount} selectable</span>
          </div>
          <PanelRight className="aui-topbar-icon" aria-hidden />
        </header>
        <div className="aui-content-grid">
          <main className="aui-content" id="content">{children}</main>
          <ActivityRail snapshot={snapshot} />
        </div>
      </div>
      <nav className="aui-mobile-tabs" aria-label="Mobile navigation">
        {auroraMobileTabs.map((tab) => (
          <a key={tab.id} href={tab.href} aria-current={activePath === tab.href ? 'page' : undefined}>
            <tab.icon size={18} aria-hidden />
            <span>{tab.label}</span>
          </a>
        ))}
      </nav>
    </div>
  )
}

export function ShellNavigation({
  activePath,
  routes,
  compact = false
}: {
  activePath: string
  routes: RouteAvailability[]
  compact?: boolean
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]))
  return (
    <nav className={compact ? 'aui-nav aui-nav-compact' : 'aui-nav'}>
      {auroraNavSections.map((section) => (
        <section key={section.label}>
          <h2>{section.label}</h2>
          {section.items.map((item) => {
            const route = routeById.get(item.id)
            const active = activePath === item.href
            return (
              <a
                key={item.id}
                href={item.href}
                className={active ? 'active' : undefined}
                aria-current={active ? 'page' : undefined}
                aria-disabled={route?.disabled ? 'true' : undefined}
                title={route?.explanation}
              >
                <item.icon size={17} aria-hidden />
                <span>{item.label}</span>
                {item.adminGated ? <Lock size={13} aria-label="Admin gated" /> : null}
                {route ? <StatusDot state={route.state} /> : null}
              </a>
            )
          })}
        </section>
      ))}
    </nav>
  )
}

export function RouteMatrix({ routes }: { routes: RouteAvailability[] }) {
  return (
    <div className="aui-route-matrix">
      {routes.map((route) => (
        <RouteCard key={route.item.id} route={route} />
      ))}
    </div>
  )
}

function RouteCard({ route }: { route: RouteAvailability }) {
  const navItem = getAuroraNavItem(route.item.id)
  const Icon = navItem?.icon
  return (
    <article className="aui-route-card">
      <div className="aui-route-card-header">
        {Icon ? <Icon size={18} aria-hidden /> : null}
        <h3>{route.item.label}</h3>
        <StatusBadge state={route.state} />
      </div>
      <p>{route.explanation}</p>
      <dl>
        <div><dt>Provider</dt><dd>{route.providerLabel}</dd></div>
        <div><dt>Privacy</dt><dd><PrivacyBadge privacy={route.item.privacyClass} /></dd></div>
        <div><dt>Task</dt><dd>{route.item.expectedTask}</dd></div>
        <div><dt>AdminAction</dt><dd>{route.requiresAdminAction ? 'required for mutation' : 'not required'}</dd></div>
      </dl>
    </article>
  )
}

function BrandHeader({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  return (
    <div className="aui-brand">
      <span className="aui-brand-mark"><Sparkles size={17} aria-hidden /></span>
      <div>
        <strong>Aurora</strong>
        <span>{snapshot.nodeName}</span>
      </div>
    </div>
  )
}

function ActivityRail({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  return (
    <aside className="aui-activity" aria-label="Shell diagnostics">
      <p className="aui-kicker">Evidence</p>
      <h2>Runtime snapshot</h2>
      <dl>
        <div><dt>Source</dt><dd>{snapshot.evidenceSource}</dd></div>
        <div><dt>Peer</dt><dd>{snapshot.localPeerId ?? 'not reported'}</dd></div>
        <div><dt>Generated</dt><dd>{snapshot.generatedAt ?? 'pending'}</dd></div>
        <div><dt>Blocked routes</dt><dd>{snapshot.blockedCount}</dd></div>
      </dl>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    </aside>
  )
}

function StatusDot({ state }: { state: string }) {
  return <span className={`aui-status-dot aui-dot-${state}`} aria-hidden />
}

function normalizePath(path: string): string {
  if (!path || path === '') return '/'
  return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
}
