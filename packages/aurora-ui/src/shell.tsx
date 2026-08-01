'use client'

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  Lock,
  Menu,
  Network,
  PanelRight,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { auroraMobileTabs, auroraNavSections, getAuroraNavItem } from "./nav";
import type { AuroraNavItem } from "./nav";
import type { AuroraNavSection } from "./nav";
import { getAuroraSurfaceProfile } from "./platform-surface";
import { PRODUCT_COPY, productStatusCopy } from "./product-copy";
import type { AuroraShellSnapshot, RouteAvailability } from "./shell-data";
import { CapabilityDrawer } from "./state-surface";
import {
  EvidenceBadge,
  HealthBadge,
  IdentityBadge,
  ModeBadge,
  PrivacyBadge,
  StatusBadge,
  presentableSignal,
} from "./status-badges";
import { Avatar, AvatarFallback } from "#components/ui/avatar";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { Card } from "#components/ui/card";
import { cn } from "#lib/utils";

export interface AppShellProps {
  snapshot: AuroraShellSnapshot;
  currentPath?: string;
  children: ReactNode;
  onNavigate?: (href: string) => void;
  /** Admin navigation is hidden unless the current authenticated session proves it. */
  sessionIsAdmin?: boolean;
  /** Runtime mode feeds the centralized platform-surface classifier. */
  runtimeMode?: string;
}

export function AppShell({
  snapshot,
  currentPath = "/",
  children,
  onNavigate,
  sessionIsAdmin = false,
  runtimeMode,
}: AppShellProps) {
  const activePath = normalizePath(currentPath);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activityRailCollapsed, setActivityRailCollapsed] = useState(true);
  const handleMobileMenuToggle = useCallback(
    () => {
      setNavigationOpen((open) => {
        if (!open) setActivityRailCollapsed(true);
        return !open;
      });
    },
    [],
  );
  const handleActivityRailToggle = useCallback(
    () => {
      setActivityRailCollapsed((collapsed) => {
        if (collapsed) setNavigationOpen(false);
        return !collapsed;
      });
    },
    [],
  );
  const handleMobileNavigate = useCallback(
    (href: string) => {
      setNavigationOpen(false);
      onNavigate?.(href);
    },
    [onNavigate],
  );
  useEffect(() => {
    if (!navigationOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigationOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigationOpen]);
  return (
    <div
      className="aui-shell flex h-dvh w-full overflow-hidden bg-background text-foreground"
      data-activity-collapsed={activityRailCollapsed ? "true" : "false"}
      data-navigation-open={navigationOpen ? "true" : "false"}
    >
      <aside
        id="primary-navigation"
        className={cn(
          "aui-sidebar relative hidden min-w-0 shrink-0 flex-col overflow-hidden border-r bg-sidebar md:flex",
          navigationOpen ? "border-border" : "border-transparent",
        )}
        style={{
          width: 248,
          transition: "border-color 300ms ease",
        }}
        aria-label="Primary navigation"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close navigation menu"
          onClick={() => setNavigationOpen(false)}
          className="absolute top-2.5 right-2.5 z-10 md:hidden"
        >
          <Menu size={18} aria-hidden />
        </Button>
        <div className="flex h-full w-[248px] shrink-0 flex-col">
          <BrandHeader snapshot={snapshot} />
          <ShellNavigation
            activePath={activePath}
            routes={snapshot.routes}
            sessionIsAdmin={sessionIsAdmin}
            {...(onNavigate ? { onNavigate: handleMobileNavigate } : {})}
          />
          <div className="flex items-center gap-2 border-t border-border p-2.5">
            <Avatar className="size-[26px]">
              <AvatarFallback className="bg-primary/15 text-[11px] font-semibold text-primary">
                {shellAvatarLabel(sessionIsAdmin)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{shellIdentityLabel(sessionIsAdmin)}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">{shellAccessLabel(sessionIsAdmin, snapshot)}</p>
            </div>
          </div>
        </div>
      </aside>
      <div className="aui-main-column flex min-w-0 flex-1 flex-col">
        <header className="aui-topbar flex h-[54px] shrink-0 items-center gap-2.5 border-b border-border px-4">
          <div className="aui-mobile-menu md:hidden" data-open={navigationOpen ? "true" : "false"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={navigationOpen ? "Hide navigation menu" : "Show navigation menu"}
              aria-expanded={navigationOpen}
              aria-controls="primary-navigation"
              onClick={handleMobileMenuToggle}
              className="shrink-0"
            >
              <Menu size={20} aria-hidden />
            </Button>
            <div
              className="aui-mobile-sheet fixed left-0 z-40 w-[min(20rem,86vw)] overflow-hidden border border-border bg-background shadow-xl"
              aria-hidden={!navigationOpen}
              inert={!navigationOpen}
            >
              <MobileNavigationSheet
                snapshot={snapshot}
                activePath={activePath}
                routes={snapshot.routes}
                sessionIsAdmin={sessionIsAdmin}
                {...(onNavigate ? { onNavigate: handleMobileNavigate } : {})}
                onClose={() => setNavigationOpen(false)}
              />
            </div>
            {navigationOpen ? (
              <button
                type="button"
                className="aui-mobile-menu-backdrop fixed inset-0 z-30 cursor-default border-0 bg-black/40"
                aria-label="Close navigation menu"
                onClick={() => setNavigationOpen(false)}
              />
            ) : null}
          </div>
          <div className="aui-status-row flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" aria-label="Aurora shell status">
            <ModeBadge mode={shellSurfaceLabel(snapshot, runtimeMode)} className="aui-shell-status" />
            <HealthBadge health={shellHealthLabel(snapshot)} className="aui-shell-status" />
            <IdentityBadge identity={shellIdentityBadgeLabel(sessionIsAdmin)} className="aui-shell-status" />
          </div>
          <span
            className="aui-runtime-chip shrink-0 rounded-md border border-border bg-muted/40 px-2.5 py-1 font-mono text-[11.5px] text-muted-foreground"
            aria-label="Aurora version and connection state"
          >
            v0.9.2{" "}
            <strong className={snapshot.loadState === "error" ? "text-destructive" : "text-success"}>
              · {shellRuntimeStateLabel(snapshot)}
            </strong>
          </span>
          <span className="sr-only" aria-label="Aurora readiness">
            Aurora pages are ready
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={activityRailCollapsed ? "Show activity rail" : "Hide activity rail"}
            aria-pressed={activityRailCollapsed}
            title="Toggle activity rail"
            onClick={handleActivityRailToggle}
            className="aui-activity-toggle shrink-0"
          >
            <PanelRight size={18} aria-hidden />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="aui-content min-w-0 flex-1 overflow-y-auto" id="content">
            {children}
          </main>
          <aside
            className={cn(
              "aui-activity min-w-0 shrink-0 overflow-hidden border-l bg-background",
              activityRailCollapsed ? "border-transparent" : "border-border",
            )}
            style={{
              width: activityRailCollapsed ? 0 : 280,
              transition: "width 300ms cubic-bezier(0.22, 1, 0.36, 1), border-color 300ms ease",
            }}
            aria-label="Aurora activity"
            aria-hidden={activityRailCollapsed}
            inert={activityRailCollapsed}
          >
            <div className="h-full w-[280px] overflow-y-auto">
              <ActivityRail snapshot={snapshot} runtimeMode={runtimeMode} />
            </div>
          </aside>
        </div>
      </div>
      <MobileBottomTabs
        activePath={activePath}
        routes={snapshot.routes}
        sessionIsAdmin={sessionIsAdmin}
        {...(onNavigate ? { onNavigate } : {})}
      />
    </div>
  );
}

function MobileNavigationSheet({
  snapshot,
  activePath,
  routes,
  sessionIsAdmin,
  onNavigate,
  onClose,
}: {
  snapshot: AuroraShellSnapshot;
  activePath: string;
  routes: RouteAvailability[];
  sessionIsAdmin: boolean;
  onNavigate?: (href: string) => void;
  onClose: () => void;
}) {
  const activeRoute = routes.find((route) => route.item.href === activePath);
  return (
    <div className="aui-mobile-sheet-layout flex h-full flex-col" role="dialog" aria-labelledby="aui-mobile-sheet-title">
      <div className="aui-mobile-sheet-header flex items-center border-b border-border">
        <BrandHeader snapshot={snapshot} />
        <Button type="button" variant="ghost" size="icon" aria-label="Close navigation menu" onClick={onClose}>
          <X size={18} aria-hidden />
        </Button>
      </div>
      <div className="aui-mobile-sheet-body flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="aui-mobile-sheet-title text-sm font-semibold" id="aui-mobile-sheet-title">
          Navigation
        </p>
        <MobileSheetRouteSummary route={activeRoute} snapshot={snapshot} />
        <ShellNavigation
          activePath={activePath}
          routes={routes}
          compact
          sessionIsAdmin={sessionIsAdmin}
          {...(onNavigate ? { onNavigate } : {})}
        />
      </div>
      <div className="aui-mobile-sheet-footer flex items-center gap-2 border-t border-border p-3" aria-label="Mobile identity">
        <Avatar className="aui-avatar size-[26px]">
          <AvatarFallback className="bg-primary/15 text-[11px] font-semibold text-primary">
            {shellAvatarLabel(sessionIsAdmin)}
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="text-xs font-medium">{shellIdentityLabel(sessionIsAdmin)}</p>
          <p className="text-[10.5px] text-muted-foreground">{shellAccessLabel(sessionIsAdmin, snapshot)}</p>
        </div>
      </div>
    </div>
  );
}

function MobileSheetRouteSummary({
  route,
  snapshot,
}: {
  route: RouteAvailability | undefined;
  snapshot: AuroraShellSnapshot;
}) {
  return (
    <Card className="aui-mobile-sheet-summary p-3" aria-label="Current mobile route">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Current route</span>
        <strong className="text-sm">{route?.item.label ?? "Assistant"}</strong>
        <small className="text-xs text-muted-foreground">
          {route ? shellRouteSummaryLabel(route) : "Aurora cockpit ready."}
        </small>
      </div>
      <div className="aui-mobile-sheet-summary-badges mt-2 flex flex-wrap items-center gap-1.5" aria-label="Current mobile route state">
        <EvidenceBadge label={route ? shellRouteBadgeLabel(route) : "Ready"} />
        <EvidenceBadge label={snapshot.loadState === "ready" ? "Ready" : "Checking"} />
      </div>
    </Card>
  );
}

function MobileBottomTabs({
  activePath,
  routes,
  sessionIsAdmin,
  onNavigate,
}: {
  activePath: string;
  routes: RouteAvailability[];
  sessionIsAdmin: boolean;
  onNavigate?: (href: string) => void;
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]));
  const mobileTabOrder = new Set(["assistant", "mesh", "settings"]);
  const tabs = auroraMobileTabs.filter(
    (tab) => mobileTabOrder.has(tab.id) && (sessionIsAdmin || !tab.adminGated || tab.id === "settings"),
  );
  return (
    <nav className="aui-mobile-tabs fixed inset-x-0 bottom-0 z-10 flex items-center justify-around border-t border-border bg-background py-1.5 md:hidden" aria-label="Mobile navigation">
      {tabs.map((tab) => (
        <MobileBottomTab
          key={tab.id}
          tab={tab}
          route={routeById.get(tab.id)}
          active={activePath === tab.href}
          {...(onNavigate ? { onNavigate } : {})}
        />
      ))}
    </nav>
  );
}

function MobileBottomTab({
  tab,
  route,
  active,
  onNavigate,
}: {
  tab: AuroraNavItem;
  route: RouteAvailability | undefined;
  active: boolean;
  onNavigate?: (href: string) => void;
}) {
  const routeState = route?.state ?? "pending";
  return (
    <a
      href={tab.href}
      aria-current={active ? "page" : undefined}
      aria-disabled={route?.disabled ? "true" : undefined}
      aria-label={`${tab.mobileLabel ?? tab.label} mobile tab: ${routeState}`}
      data-mobile-tab={tab.id}
      onClick={(event) => handleShellNavigation(event, tab.href, onNavigate)}
      className={cn("flex flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[10.5px]", active ? "text-primary" : "text-muted-foreground")}
    >
      <tab.icon size={18} aria-hidden />
      <span>{tab.mobileLabel ?? tab.label}</span>
      <span className="sr-only" aria-hidden="true" />
    </a>
  );
}

export function ShellNavigation({
  activePath,
  routes,
  compact = false,
  sessionIsAdmin = false,
  onNavigate,
}: {
  activePath: string;
  routes: RouteAvailability[];
  compact?: boolean;
  sessionIsAdmin?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]));
  const navigationSections = shellNavigationSections(sessionIsAdmin);
  return (
    <nav
      className={cn("aui-nav flex flex-1 flex-col gap-4", compact ? "p-0" : "p-2.5")}
      aria-label={compact ? "Mobile sheet route navigation" : "Primary route navigation"}
    >
      {navigationSections.map((section) => (
        <section key={section.label} className="flex flex-col gap-0.5">
          <h2 className="mb-1 px-2 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{section.label}</h2>
          {section.items.map((item) => {
            const route = routeById.get(item.id);
            const active = activePath === item.href;
            return (
              <a
                key={item.id}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium",
                  active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                )}
                aria-current={active ? "page" : undefined}
                aria-disabled={route?.disabled ? "true" : undefined}
                onClick={(event) => handleShellNavigation(event, item.href, onNavigate)}
              >
                <item.icon size={15} className="shrink-0" aria-hidden />
                <span className="flex-1 truncate">{item.label}</span>
                {item.adminGated ? <Lock size={11} className="shrink-0 opacity-55" aria-label="Admin gated" /> : null}
                {route?.selectorRequired ? (
                  <span aria-label={`${item.label} selection required`}>
                    <EvidenceBadge label="Select" />
                  </span>
                ) : null}
              </a>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function shellNavigationSections(sessionIsAdmin: boolean): AuroraNavSection[] {
  if (sessionIsAdmin) return auroraNavSections;
  const settings = auroraNavSections
    .flatMap((section) => section.items)
    .find((item) => item.id === "settings");
  return auroraNavSections.flatMap((section) => {
    if (section.label === "Operate · admin only") return [];
    if (section.label !== "Configure" || !settings) return [section];
    return [{ ...section, items: [settings, ...section.items] }];
  });
}

export function RouteMatrix({ routes }: { routes: RouteAvailability[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {routes.map((route) => (
        <RouteCard key={route.item.id} route={route} />
      ))}
    </div>
  );
}

function RouteCard({ route }: { route: RouteAvailability }) {
  const navItem = getAuroraNavItem(route.item.id);
  const Icon = navItem?.icon;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        {Icon ? <Icon size={18} aria-hidden /> : null}
        <h3 className="flex-1 text-sm font-semibold">{route.item.label}</h3>
        <StatusBadge state={route.state} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{presentableSignal(route.explanation)}</p>
      <dl className="mt-3 flex flex-col gap-1 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Source</dt>
          <dd className="text-right">{route.providerLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Privacy</dt>
          <dd>
            <PrivacyBadge privacy={route.item.privacyClass} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Approval</dt>
          <dd className="text-right">{route.requiresAdminAction ? "required for changes" : "not required"}</dd>
        </div>
      </dl>
      <div className="mt-3">
        <CapabilityDrawer route={route} />
      </div>
    </Card>
  );
}

function handleShellNavigation(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate: ((href: string) => void) | undefined,
) {
  if (!onNavigate) return;
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  if (!href.startsWith("/")) return;
  event.preventDefault();
  onNavigate(href);
}

function BrandHeader({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  const displayNodeName = shellNodeLabel(snapshot);
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-[15px]">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Sparkles size={17} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-tight font-semibold">Aurora</p>
        <p className="truncate text-[11.5px] leading-tight text-muted-foreground">{displayNodeName}</p>
      </div>
    </div>
  );
}

function ActivityRail({
  snapshot,
  runtimeMode,
}: {
  snapshot: AuroraShellSnapshot;
  runtimeMode?: string | undefined;
}) {
  const events = shellActivityEvents(snapshot, runtimeMode);
  const shellAlertCopy = snapshot.error ? productStatusCopy("connection-failed").title : null;
  return (
    <aside className="flex h-full flex-col" aria-label="Aurora activity">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <Badge variant="outline" className="gap-1">
          <i aria-hidden className="size-1.5 rounded-full bg-success" />
          {activityRailBadgeLabel(snapshot)}
        </Badge>
      </header>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Recent Aurora activity">
        {events.map((event) => (
          <li key={event.id} data-tone={event.tone} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-muted/40">
            <event.icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-[13px] font-medium">{event.title}</strong>
              <span className="block truncate text-xs text-muted-foreground">{event.detail}</span>
            </div>
            <time className="shrink-0 text-[10.5px] text-muted-foreground">{event.when}</time>
          </li>
        ))}
      </ul>
      {shellAlertCopy ? (
        <p role="alert" className="border-t border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {shellAlertCopy}
        </p>
      ) : null}
    </aside>
  );
}

function activityRailBadgeLabel(snapshot: AuroraShellSnapshot): string {
  if (snapshot.loadState === "error") return "Offline";
  if (snapshot.loadState !== "ready") return "Syncing";
  return "Live";
}

function shellActivityEvents(snapshot: AuroraShellSnapshot, runtimeMode?: string) {
  const healthy = snapshot.loadState !== "error";
  const surface = shellSurfaceProfile(snapshot, runtimeMode);
  return [
    {
      id: "routes",
      title: healthy ? "Aurora ready" : "Setup required",
      detail: healthy ? "Pages and actions are available" : "Check the connected device",
      when: "now",
      icon: healthy ? CheckCircle2 : Clock3,
      tone: healthy ? "good" : "warn",
    },
    {
      id: "mode",
      title: shellModeLabel(snapshot, runtimeMode),
      detail: "Connected to Aurora",
      when: "live",
      icon: Network,
      tone: "info",
    },
    {
      id: "privacy",
      title: "Privacy guard active",
      detail: snapshot.secretsRedacted
        ? "Sensitive details stay hidden"
        : "Redaction state pending",
      when: "live",
      icon: ShieldCheck,
      tone: snapshot.secretsRedacted ? "good" : "warn",
    },
    {
      id: "peer",
      title: "Peer identity",
      detail: snapshot.localPeerId ?? shellNodeLabel(snapshot),
      when: snapshot.generatedAt ? "synced" : "ready",
      icon: Network,
      tone: "info",
    },
    {
      id: "native",
      title: "Device profile",
      detail: snapshot.nativeAvailable
        ? `Native ${snapshot.nativePlatform}`
        : surface.usesNativeShell
          ? productSurfaceLabel(snapshot, runtimeMode)
          : `${productSurfaceLabel(snapshot, runtimeMode)}; local controls unavailable`,
      when: "policy",
      icon: snapshot.nativeAvailable ? CheckCircle2 : Clock3,
      tone: snapshot.nativeAvailable ? "good" : "info",
    },
  ] as const;
}

function shellSurfaceLabel(snapshot: AuroraShellSnapshot, runtimeMode?: string): string {
  return productSurfaceLabel(snapshot, runtimeMode);
}

function shellHealthLabel(snapshot: AuroraShellSnapshot): string {
  if (snapshot.loadState === "error") return "Offline";
  if (snapshot.loadState === "loading") return "Connecting";
  return "Healthy";
}

function shellNodeLabel(snapshot: AuroraShellSnapshot): string {
  return snapshot.nodeName.trim() || "Aurora node";
}

function shellAvatarLabel(sessionIsAdmin: boolean): string {
  return sessionIsAdmin ? "AD" : "ME";
}

function shellIdentityLabel(sessionIsAdmin: boolean): string {
  return sessionIsAdmin ? "admin" : "member";
}

function shellIdentityBadgeLabel(sessionIsAdmin: boolean): string {
  return sessionIsAdmin ? "Admin" : "Member";
}

function shellAccessLabel(sessionIsAdmin: boolean, snapshot: AuroraShellSnapshot): string {
  return sessionIsAdmin ? `${PRODUCT_COPY.permissions.administrator} on ${shellNodeLabel(snapshot)}` : PRODUCT_COPY.permissions.limited;
}

function shellRuntimeStateLabel(snapshot: AuroraShellSnapshot): string {
  if (snapshot.loadState === "error") return "offline";
  if (snapshot.loadState === "loading") return "syncing";
  return "connected";
}

function shellRouteSummaryLabel(route: RouteAvailability): string {
  if (route.disabled) return "Operator workflow is configured for review.";
  if (route.selectorRequired)
    return "Choose a preferred local device before running.";
  return "Ready for operator workflow.";
}

function shellRouteBadgeLabel(route: RouteAvailability): string {
  if (route.selectorRequired) return "Select";
  if (route.disabled) return "Review";
  return "Ready";
}

function shellModeLabel(snapshot: AuroraShellSnapshot, runtimeMode?: string): string {
  return productSurfaceLabel(snapshot, runtimeMode);
}

function shellSurfaceProfile(snapshot: AuroraShellSnapshot, runtimeMode?: string) {
  return getAuroraSurfaceProfile({
    runtimeMode,
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
  });
}

function productSurfaceLabel(snapshot: AuroraShellSnapshot, runtimeMode?: string): string {
  const profile = shellSurfaceProfile(snapshot, runtimeMode);
  if (profile.usesLocalSidecar) return "Aurora is running on this computer";
  if (snapshot.loadState === "error") return `${shellNodeLabel(snapshot)} is offline`;
  if (profile.isMobile) return "This device is available";
  return `Connected to ${shellNodeLabel(snapshot)}`;
}

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}
