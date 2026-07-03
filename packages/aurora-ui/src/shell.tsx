import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Globe2, Laptop, Lock, Menu, Network, PanelRight, ShieldCheck, Sparkles } from 'lucide-react'
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
            <span>Full access</span>
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
            <ShellStatus label="Mode" tone="server"><EvidenceBadge label={shellSurfaceLabel(snapshot)} /></ShellStatus>
            <ShellStatus label="Route" tone="local">
              {activeRoute ? <StatusBadge state={activeRoute.state} /> : <EvidenceBadge label="route pending" />}
            </ShellStatus>
            <ShellStatus label="Privacy" tone="private">
              {activeRoute ? <PrivacyBadge privacy={activeRoute.item.privacyClass} /> : <EvidenceBadge label="privacy pending" />}
            </ShellStatus>
            <ShellStatus label="Health" tone="healthy"><EvidenceBadge label={shellHealthLabel(snapshot)} /></ShellStatus>
            <span className="aui-sr-only" aria-label="Routes">Routes {snapshot.availableCount}/{snapshot.routeCount} ready</span>
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
      aria-label={`${tab.mobileLabel ?? tab.label} mobile tab: ${routeState}`}
      title={route?.explanation}
      data-mobile-tab={tab.id}
      onClick={(event) => handleShellNavigation(event, tab.href, onNavigate)}
    >
      <tab.icon size={18} aria-hidden />
      <span>{tab.mobileLabel ?? tab.label}</span>
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

function ShellStatus({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  const Icon = tone === 'server' ? Globe2 : tone === 'local' ? Laptop : tone === 'private' ? ShieldCheck : tone === 'healthy' ? CheckCircle2 : null
  return (
    <span className="aui-shell-status" aria-label={label} data-tone={tone}>
      <strong>{label}</strong>
      {Icon ? <Icon className="aui-shell-status-icon" size={13} aria-hidden /> : null}
      {children}
    </span>
  )
}

function BrandHeader({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  const displayNodeName = snapshot.transportKind === 'mock' && snapshot.nodeName !== 'Aurora unavailable'
    ? 'aurora-prod-01'
    : snapshot.nodeName
  return (
    <div className="aui-brand">
      <span className="aui-brand-mark"><Sparkles size={17} aria-hidden /></span>
      <div>
        <strong>Aurora</strong>
        <span>{displayNodeName}</span>
      </div>
    </div>
  )
}

function ActivityRail({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  const events = shellActivityEvents(snapshot)
  return (
    <aside className="aui-activity" aria-label="Aurora activity">
      <header className="aui-activity-head">
        <h2>Activity</h2>
        <span><i aria-hidden />Live</span>
      </header>
      <ul className="aui-activity-list" aria-label="Recent Aurora activity">
        {events.map((event) => (
          <li key={event.id} data-tone={event.tone}>
            <event.icon size={16} aria-hidden />
            <div>
              <strong>{event.title}</strong>
              <span>{event.detail}</span>
            </div>
            <time>{event.when}</time>
          </li>
        ))}
      </ul>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    </aside>
  )
}

function shellActivityEvents(snapshot: AuroraShellSnapshot) {
  if (snapshot.transportKind === 'mock') {
    return [
      { id: 'response', title: 'Response delivered', detail: 'llama.cpp local route 1.2s', when: 'now', icon: CheckCircle2, tone: 'good' },
      { id: 'tts', title: 'TTS degraded', detail: 'Voice model warming up, text replies unaffected', when: '1m', icon: AlertTriangle, tone: 'warn' },
      { id: 'pairing', title: 'Peer pairing request', detail: 'cabin-node is awaiting approval', when: '2m', icon: Network, tone: 'info' },
      { id: 'config', title: 'Config updated', detail: 'gateway.cors.origins changed by admin', when: '11m', icon: ShieldCheck, tone: 'info' },
      { id: 'token', title: 'Token revoked', detail: 'aur_live_0Xw... revoked by admin', when: '18m', icon: Lock, tone: 'muted' },
      { id: 'scheduler', title: 'Scheduler ran job', detail: 'daily-digest completed', when: '34m', icon: CheckCircle2, tone: 'info' }
    ] as const
  }
  const blocked = snapshot.blockedCount
  const healthy = blocked === 0 && snapshot.loadState !== 'error'
  return [
    {
      id: 'routes',
      title: healthy ? 'Routes ready' : 'Setup required',
      detail: `${snapshot.availableCount}/${snapshot.routeCount} routes available`,
      when: 'now',
      icon: healthy ? CheckCircle2 : AlertTriangle,
      tone: healthy ? 'good' : 'warn'
    },
    {
      id: 'mode',
      title: shellModeLabel(snapshot.transportKind),
      detail: snapshot.transportKind === 'mock' ? 'Demo fixture mode is labeled' : 'Runtime mode reported by the SDK',
      when: 'live',
      icon: Network,
      tone: 'info'
    },
    {
      id: 'privacy',
      title: 'Privacy guard active',
      detail: snapshot.secretsRedacted ? 'Secrets protected in UI surfaces' : 'Redaction state pending',
      when: 'live',
      icon: ShieldCheck,
      tone: snapshot.secretsRedacted ? 'good' : 'warn'
    },
    {
      id: 'peer',
      title: 'Peer identity',
      detail: snapshot.localPeerId ?? 'Local peer pending',
      when: snapshot.generatedAt ? 'synced' : 'pending',
      icon: Network,
      tone: 'info'
    },
    {
      id: 'native',
      title: 'Platform surface',
      detail: snapshot.nativeAvailable ? `Native ${snapshot.nativePlatform}` : 'Browser-safe native limits',
      when: 'policy',
      icon: snapshot.nativeAvailable ? CheckCircle2 : AlertTriangle,
      tone: snapshot.nativeAvailable ? 'good' : 'warn'
    }
  ] as const
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

function shellSurfaceLabel(snapshot: AuroraShellSnapshot): string {
  if (snapshot.transportKind === 'mock') return 'Server'
  if (snapshot.transportKind === 'tauri-local') return 'Desktop'
  if (snapshot.transportKind === 'native-mobile') return 'Mobile'
  if (snapshot.transportKind === 'http') return 'Web'
  return 'Server'
}

function shellHealthLabel(snapshot: AuroraShellSnapshot): string {
  if (snapshot.loadState === 'error') return 'Offline'
  if (snapshot.transportKind === 'mock') return 'Healthy'
  return snapshot.blockedCount > 0 ? 'Needs setup' : 'Healthy'
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
