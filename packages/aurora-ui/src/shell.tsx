import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { Lock, Menu, PanelRight, Sparkles } from 'lucide-react'
import { auroraMobileTabs, auroraNavSections, getAuroraNavItem } from './nav'
import type { AuroraNavItem } from './nav'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { CapabilityDrawer } from './state-surface'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'

export interface AppShellProps {
  snapshot: AuroraShellSnapshot
  currentPath?: string
  children: ReactNode
  onNavigate?: (href: string) => void
}

export function AppShell({ snapshot, currentPath = '/', children, onNavigate }: AppShellProps) {
  const activePath = normalizePath(currentPath)
  const activeRoute = snapshot.routes.find((route) => route.item.href === activePath)
  const modeLabel = shellModeLabel(snapshot.transportKind)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const handleMobileMenuToggle = useCallback(() => setMobileMenuOpen((open) => !open), [])
  const handleMobileNavigate = useCallback((href: string) => {
    setMobileMenuOpen(false)
    onNavigate?.(href)
  }, [onNavigate])
  return (
    <div className="aui-shell">
      <aside className="aui-sidebar" aria-label="Primary navigation">
        <BrandHeader snapshot={snapshot} />
        <ShellNavigation activePath={activePath} routes={snapshot.routes} {...(onNavigate ? { onNavigate: handleMobileNavigate } : {})} />
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
          <div className="aui-mobile-menu" data-open={mobileMenuOpen ? 'true' : 'false'}>
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={mobileMenuOpen}
              onClick={handleMobileMenuToggle}
            ><Menu size={20} /></button>
            <MobileNavigationSheet
              snapshot={snapshot}
              activePath={activePath}
              routes={snapshot.routes}
              {...(onNavigate ? { onNavigate: handleMobileNavigate } : {})}
            />
          </div>
          <div className="aui-status-row" aria-label="Aurora shell status">
            <ShellStatus label="Mode"><EvidenceBadge label={modeLabel} /></ShellStatus>
            <ShellStatus label="Route">
              {activeRoute ? <StatusBadge state={activeRoute.state} /> : <EvidenceBadge label="route pending" />}
            </ShellStatus>
            <ShellStatus label="Privacy">
              {activeRoute ? <PrivacyBadge privacy={activeRoute.item.privacyClass} /> : <EvidenceBadge label="privacy pending" />}
            </ShellStatus>
            <ShellStatus label="Routes"><EvidenceBadge label={`${snapshot.availableCount}/${snapshot.routeCount} ready`} /></ShellStatus>
          </div>
          <details className="aui-activity-drawer">
            <summary aria-label="Toggle activity rail"><PanelRight size={20} /></summary>
            <div className="aui-activity-drawer-panel">
              <ActivityRail snapshot={snapshot} />
            </div>
          </details>
        </header>
        <div className="aui-content-grid">
          <main className="aui-content" id="content">{children}</main>
          <ActivityRail snapshot={snapshot} />
        </div>
      </div>
      <MobileBottomTabs activePath={activePath} routes={snapshot.routes} {...(onNavigate ? { onNavigate } : {})} />
    </div>
  )
}

function MobileNavigationSheet({
  snapshot,
  activePath,
  routes,
  onNavigate
}: {
  snapshot: AuroraShellSnapshot
  activePath: string
  routes: RouteAvailability[]
  onNavigate?: (href: string) => void
}) {
  const activeRoute = routes.find((route) => route.item.href === activePath)
  return (
    <div className="aui-mobile-sheet" role="dialog" aria-labelledby="aui-mobile-sheet-title">
      <BrandHeader snapshot={snapshot} />
      <div className="aui-mobile-sheet-body">
        <p className="aui-mobile-sheet-title" id="aui-mobile-sheet-title">Navigation</p>
        <MobileSheetRouteSummary route={activeRoute} snapshot={snapshot} />
        <ShellNavigation activePath={activePath} routes={routes} compact {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <div className="aui-mobile-sheet-footer" aria-label="Mobile identity">
        <span className="aui-avatar">AD</span>
        <div><strong>admin</strong><span>{shellModeLabel(snapshot.transportKind)}</span></div>
      </div>
    </div>
  )
}

function MobileSheetRouteSummary({
  route,
  snapshot
}: {
  route: RouteAvailability | undefined
  snapshot: AuroraShellSnapshot
}) {
  return (
    <section className="aui-mobile-sheet-summary" aria-label="Current mobile route">
      <div>
        <span className="aui-kicker">Current route</span>
        <strong>{route?.item.label ?? 'Route pending'}</strong>
        <small>{route ? presentableSignal(route.explanation) : 'Waiting for Aurora.'}</small>
      </div>
      <div className="aui-mobile-sheet-summary-badges" aria-label="Current mobile route state">
        {route ? <StatusBadge state={route.state} /> : <EvidenceBadge label="pending" />}
        {route ? <PrivacyBadge privacy={route.item.privacyClass} /> : null}
        <EvidenceBadge label={`${snapshot.availableCount}/${snapshot.routeCount} ready`} />
      </div>
    </section>
  )
}

function MobileBottomTabs({
  activePath,
  routes,
  onNavigate
}: {
  activePath: string
  routes: RouteAvailability[]
  onNavigate?: (href: string) => void
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]))
  return (
    <nav className="aui-mobile-tabs" aria-label="Mobile navigation">
      {auroraMobileTabs.map((tab) => (
        <MobileBottomTab
          key={tab.id}
          tab={tab}
          route={routeById.get(tab.id)}
          active={activePath === tab.href}
          {...(onNavigate ? { onNavigate } : {})}
        />
      ))}
    </nav>
  )
}

function MobileBottomTab({
  tab,
  route,
  active,
  onNavigate
}: {
  tab: AuroraNavItem
  route: RouteAvailability | undefined
  active: boolean
  onNavigate?: (href: string) => void
}) {
  const routeState = route?.state ?? 'pending'
  return (
    <a
      href={tab.href}
      aria-current={active ? 'page' : undefined}
      aria-disabled={route?.disabled ? 'true' : undefined}
      aria-label={`${tab.label} mobile tab: ${routeState}`}
      title={route?.explanation}
      data-mobile-tab={tab.id}
      onClick={(event) => handleShellNavigation(event, tab.href, onNavigate)}
    >
      <tab.icon size={18} aria-hidden />
      <span>{tab.label}</span>
      <span className="aui-mobile-tab-state">
        {route ? <StatusBadge state={route.state} /> : <EvidenceBadge label="pending" />}
      </span>
    </a>
  )
}

export function ShellNavigation({
  activePath,
  routes,
  compact = false,
  onNavigate
}: {
  activePath: string
  routes: RouteAvailability[]
  compact?: boolean
  onNavigate?: (href: string) => void
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]))
  return (
    <nav className={compact ? 'aui-nav aui-nav-compact' : 'aui-nav'} aria-label={compact ? 'Mobile sheet route navigation' : 'Primary route navigation'}>
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
                onClick={(event) => handleShellNavigation(event, item.href, onNavigate)}
              >
                <item.icon size={17} aria-hidden />
                <span>{item.label}</span>
                {item.adminGated ? <Lock size={13} aria-label="Admin gated" /> : null}
                {route ? (
                  <span className="aui-nav-status-chip" aria-label={`${item.label} route state`}>
                    <StatusBadge state={route.state} />
                  </span>
                ) : null}
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
      <p>{presentableSignal(route.explanation)}</p>
      <dl>
        <div><dt>Provider</dt><dd>{route.providerLabel}</dd></div>
        <div><dt>Privacy</dt><dd><PrivacyBadge privacy={route.item.privacyClass} /></dd></div>
        <div><dt>Approval</dt><dd>{route.requiresAdminAction ? 'required for changes' : 'not required'}</dd></div>
      </dl>
      <CapabilityDrawer route={route} />
    </article>
  )
}

function handleShellNavigation(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate: ((href: string) => void) | undefined
) {
  if (!onNavigate) return
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  if (!href.startsWith('/')) return
  event.preventDefault()
  onNavigate(href)
}

function ShellStatus({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="aui-shell-status" aria-label={label}>
      <strong>{label}</strong>
      {children}
    </span>
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
    <aside className="aui-activity" aria-label="Aurora activity">
      <p className="aui-kicker">Activity</p>
      <h2>System</h2>
      <dl>
        <div><dt>Connection</dt><dd>{shellModeLabel(snapshot.transportKind)}</dd></div>
        <div><dt>Peer</dt><dd>{snapshot.localPeerId ?? 'local node pending'}</dd></div>
        <div><dt>Updated</dt><dd>{snapshot.generatedAt ?? 'pending'}</dd></div>
        <div><dt>Needs setup</dt><dd>{snapshot.blockedCount}</dd></div>
      </dl>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    </aside>
  )
}

function QuickDiagnosticsIndicator({
  snapshot,
  onNavigate
}: {
  snapshot: AuroraShellSnapshot
  onNavigate?: (href: string) => void
}) {
  const state = snapshot.loadState === 'error'
    ? 'denied'
    : snapshot.blockedCount > 0
      ? 'degraded'
      : 'available-local'
  return (
    <a
      className="aui-quick-diagnostics"
      href="/diagnostics"
      aria-label="Quick diagnostics"
      onClick={(event) => handleShellNavigation(event, '/diagnostics', onNavigate)}
    >
      <span>
        <strong>System</strong>
        <small>{snapshot.blockedCount > 0 ? `${snapshot.blockedCount} routes need setup` : 'All routes ready'}</small>
      </span>
      <span className="aui-quick-diagnostics-badges">
        <StatusBadge state={state} />
        <EvidenceBadge label={shellModeLabel(snapshot.transportKind)} />
      </span>
    </a>
  )
}

function shellModeLabel(transportKind: string): string {
  if (transportKind === 'tauri-local') return 'Desktop local'
  if (transportKind === 'tauri-thin') return 'Desktop thin'
  if (transportKind === 'native-mobile') return 'Mobile thin'
  if (transportKind === 'mock') return 'Demo mode'
  if (transportKind === 'http') return 'Web thin'
  return transportKind
}

function normalizePath(path: string): string {
  if (!path || path === '') return '/'
  return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
}
