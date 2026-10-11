'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
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
import { getAuroraNavItem, visibleAuroraMobileTabs, visibleAuroraNavSections } from "./nav";
import type { AuroraNavItem } from "./nav";
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from "./platform-surface";
import { useAuroraStateScopeId } from "./query";
import {
  selectConnectionScopeId,
  selectConnectionState,
  selectPeerConnectionScopeId,
  selectPeerConnectionState,
  useConnectionStore,
  type AuroraConnectionState,
  type AuroraPeerConnectionState,
} from "./state/connection-store";
import { auroraRuntimeVersionLabel } from "./version";
import { PRODUCT_COPY, productStatusCopy } from "./product-copy";
import type { AuroraShellSnapshot, RouteAvailability } from "./shell-data";
import type { AuroraNodeMode } from "./runtime-profile";
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
  /** Product role is separate from the physical surface and transport. */
  nodeMode?: AuroraNodeMode;
  /** Whether this node's own local services started successfully. */
  localNodeAvailable?: boolean;
}

export function AppShell({
  snapshot,
  currentPath = "/",
  children,
  onNavigate,
  sessionIsAdmin = false,
  runtimeMode,
  nodeMode,
  localNodeAvailable,
}: AppShellProps) {
  const activePath = normalizePath(currentPath);
  const surfaceProfile = getAuroraSurfaceProfile({
    runtimeMode,
    nodeMode,
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
  });
  const mobileViewport = useMobileVisualViewport(surfaceProfile.isMobile);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activityRailCollapsed, setActivityRailCollapsed] = useState(true);
  const contentRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const activeStateScopeId = useAuroraStateScopeId();
  const peerConnectionState = useConnectionStore((state) => (
    selectPeerConnectionScopeId(state) === activeStateScopeId
      ? selectPeerConnectionState(state)
      : null
  ));
  const connectionState = useConnectionStore((state) => (
    selectConnectionScopeId(state) === activeStateScopeId
      ? selectConnectionState(state)
      : null
  ));
  const closeMobileNavigation = useCallback(() => {
    mobileMenuButtonRef.current?.focus();
    setNavigationOpen(false);
  }, []);
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
      closeMobileNavigation();
      onNavigate?.(href);
    },
    [closeMobileNavigation, onNavigate],
  );
  useEffect(() => {
    if (!navigationOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileNavigation();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeMobileNavigation, navigationOpen]);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activePath]);
  return (
    <div
      className="aui-shell flex h-dvh min-h-0 w-full overflow-hidden bg-[var(--aui-bg)] text-[var(--aui-ink)]"
      data-activity-collapsed={activityRailCollapsed ? "true" : "false"}
      data-mobile-viewport={surfaceProfile.isMobile && mobileViewport.height !== null ? "true" : undefined}
      data-navigation-open={navigationOpen ? "true" : "false"}
      data-virtual-keyboard-open={mobileViewport.keyboardOpen ? "true" : undefined}
      style={mobileViewport.height === null ? undefined : ({
        "--aui-visual-viewport-height": `${mobileViewport.height}px`,
      } as CSSProperties)}
    >
      <aside
        id="primary-navigation"
        className={cn(
          "aui-sidebar relative flex min-w-0 basis-64 shrink-0 flex-col overflow-hidden border-r bg-sidebar [@media(max-width:1040px)]:hidden",
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
          className="absolute top-2.5 right-2.5 z-10 hidden [@media(max-width:1040px)]:inline-flex"
        >
          <X size={18} aria-hidden />
        </Button>
        <div className="flex h-full w-[248px] shrink-0 flex-col">
          <BrandHeader snapshot={snapshot} />
          <ShellNavigation
            activePath={activePath}
            routes={snapshot.routes}
            sessionIsAdmin={sessionIsAdmin}
            surfaceProfile={surfaceProfile}
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
      <div className="aui-main-column flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="aui-topbar relative z-20 flex h-14 min-h-14 shrink-0 items-center gap-[0.65rem] border-b border-border bg-[var(--aui-bg)] !px-4 py-0 [@media(max-width:720px)]:!pl-3 [@media(max-width:720px)]:!pr-[0.45rem]">
            <div className="aui-mobile-menu hidden [@media(max-width:1040px)]:block" data-open={navigationOpen ? "true" : "false"}>
            <Button
              ref={mobileMenuButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={navigationOpen ? "Hide navigation menu" : "Show navigation menu"}
              aria-expanded={navigationOpen}
              aria-controls="primary-navigation"
              onClick={handleMobileMenuToggle}
              className="relative z-50 shrink-0"
            >
              <Menu size={20} aria-hidden />
            </Button>
            <div
              className="aui-mobile-sheet fixed bottom-0 left-0 z-40 flex w-[min(19rem,90vw)] flex-col overflow-hidden border-r border-border bg-sidebar shadow-[0_1rem_3rem_rgb(0_0_0_/_0.16)]"
              aria-hidden={!navigationOpen}
              hidden={!navigationOpen}
              inert={!navigationOpen}
            >
              <MobileNavigationSheet
                snapshot={snapshot}
                activePath={activePath}
                routes={snapshot.routes}
                sessionIsAdmin={sessionIsAdmin}
                surfaceProfile={surfaceProfile}
                {...(onNavigate ? { onNavigate: handleMobileNavigate } : {})}
                onClose={closeMobileNavigation}
              />
            </div>
            {navigationOpen ? (
              <button
                type="button"
                className="aui-mobile-menu-backdrop fixed inset-0 z-30 cursor-default border-0 bg-black/40"
                aria-label="Close navigation menu"
                onClick={closeMobileNavigation}
              />
            ) : null}
          </div>
          <div className="aui-status-row flex min-w-0 flex-1 items-center gap-[0.35rem] overflow-x-auto" aria-label="Aurora shell status">
            <ModeBadge mode={shellSurfaceLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable)} className="aui-shell-status" />
            <HealthBadge health={shellHealthLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable, peerConnectionState, connectionState)} className="aui-shell-status" />
            <IdentityBadge identity={shellIdentityBadgeLabel(sessionIsAdmin)} className="aui-shell-status" />
          </div>
          <span
            className="aui-runtime-chip inline-flex min-h-7 shrink-0 items-center gap-[0.28rem] rounded-[0.45rem] border border-border bg-[color-mix(in_srgb,var(--aui-surface-3)_40%,transparent)] px-[0.56rem] py-1 font-mono text-[0.72rem] text-[var(--aui-muted)]"
            aria-label="Aurora version and connection state"
          >
            <span className="aui-runtime-version">v{auroraRuntimeVersionLabel(snapshot.serverVersion)}</span>{" "}
            <strong className={shellRuntimeStateToneClass(snapshot, runtimeMode, nodeMode, localNodeAvailable, peerConnectionState, connectionState)}>
              <span className="aui-runtime-separator">· </span>{shellRuntimeStateLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable, peerConnectionState, connectionState)}
            </strong>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={activityRailCollapsed ? "Show activity rail" : "Hide activity rail"}
            aria-pressed={activityRailCollapsed}
            title="Toggle activity rail"
            onClick={handleActivityRailToggle}
            className="aui-activity-toggle size-8 shrink-0 border-0 rounded-[0.45rem] bg-transparent text-[var(--aui-muted)] hover:bg-transparent aria-pressed:bg-[color-mix(in_srgb,var(--aui-primary)_10%,transparent)] aria-pressed:text-[var(--aui-primary)] aria-pressed:hover:bg-[color-mix(in_srgb,var(--aui-primary)_10%,transparent)]"
          >
            <PanelRight size={18} aria-hidden />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main
            ref={contentRef}
            className="aui-content relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain pb-[calc(4.8rem+env(safe-area-inset-bottom))] [scrollbar-gutter:stable] [touch-action:pan-y] md:pb-0"
            id="content"
          >
            {children}
          </main>
          <aside
            className={cn(
              "aui-activity min-w-0 basis-72 shrink-0 overflow-hidden border-l bg-[var(--aui-bg)]",
              activityRailCollapsed ? "border-transparent" : "border-border",
            )}
            aria-label="Aurora activity"
            aria-hidden={activityRailCollapsed}
            inert={activityRailCollapsed}
          >
            <div className="h-full w-[280px] overflow-y-auto">
              <ActivityRail
                snapshot={snapshot}
                runtimeMode={runtimeMode}
                nodeMode={nodeMode}
                localNodeAvailable={localNodeAvailable}
              />
            </div>
          </aside>
        </div>
      </div>
      <MobileBottomTabs
        activePath={activePath}
        routes={snapshot.routes}
        sessionIsAdmin={sessionIsAdmin}
        surfaceProfile={surfaceProfile}
        {...(onNavigate ? { onNavigate } : {})}
      />
    </div>
  );
}

interface MobileVisualViewportState {
  height: number | null;
  keyboardOpen: boolean;
}

const CLOSED_MOBILE_VIEWPORT: MobileVisualViewportState = {
  height: null,
  keyboardOpen: false,
};

function useMobileVisualViewport(enabled: boolean): MobileVisualViewportState {
  const baselineHeightRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState<MobileVisualViewportState>(() => {
    const initial = readMobileVisualViewport(enabled);
    baselineHeightRef.current = initial.height;
    return initial;
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      baselineHeightRef.current = null;
      setViewport(CLOSED_MOBILE_VIEWPORT);
      return;
    }

    const syncViewport = () => {
      const measured = readMobileVisualViewport(true);
      const resizedForKeyboard = isTextEntryFocused()
        && measured.height !== null
        && baselineHeightRef.current !== null
        && baselineHeightRef.current - measured.height >= 120;
      const next = resizedForKeyboard && !measured.keyboardOpen
        ? { ...measured, keyboardOpen: true }
        : measured;
      if (!next.keyboardOpen && next.height !== null) {
        baselineHeightRef.current = next.height;
      }
      setViewport((current) => (
        current.height === next.height && current.keyboardOpen === next.keyboardOpen
          ? current
          : next
      ));
    };
    const visualViewport = window.visualViewport;
    syncViewport();
    window.addEventListener("resize", syncViewport);
    document.addEventListener("focusin", syncViewport);
    document.addEventListener("focusout", syncViewport);
    visualViewport?.addEventListener("resize", syncViewport);
    visualViewport?.addEventListener("scroll", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      document.removeEventListener("focusin", syncViewport);
      document.removeEventListener("focusout", syncViewport);
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
    };
  }, [enabled]);

  return viewport;
}

function isTextEntryFocused(): boolean {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement) return true;
  if (activeElement instanceof HTMLInputElement) {
    return ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(activeElement.type);
  }
  return activeElement instanceof HTMLElement && activeElement.isContentEditable;
}

function readMobileVisualViewport(enabled: boolean): MobileVisualViewportState {
  if (!enabled || typeof window === "undefined") return CLOSED_MOBILE_VIEWPORT;
  if (!window.visualViewport) return CLOSED_MOBILE_VIEWPORT;
  const layoutHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight ?? 0);
  const visualViewport = window.visualViewport;
  const visualHeight = Math.max(1, visualViewport.height);
  const visualBottom = visualHeight + Math.max(0, visualViewport.offsetTop);
  const coveredHeight = Math.max(0, layoutHeight - visualBottom);
  return {
    height: Math.round(visualHeight),
    keyboardOpen: coveredHeight >= 120,
  };
}

function MobileNavigationSheet({
  snapshot,
  activePath,
  routes,
  sessionIsAdmin,
  surfaceProfile,
  onNavigate,
  onClose,
}: {
  snapshot: AuroraShellSnapshot;
  activePath: string;
  routes: RouteAvailability[];
  sessionIsAdmin: boolean;
  surfaceProfile: AuroraSurfaceProfile;
  onNavigate?: (href: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="dialog" aria-labelledby="aui-mobile-sheet-title">
      <div className="aui-mobile-sheet-header flex shrink-0 items-center justify-between border-b border-border">
        <BrandHeader snapshot={snapshot} />
        <Button type="button" variant="ghost" size="icon" aria-label="Close navigation menu" onClick={onClose}>
          <X size={18} aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="mx-3 mt-3 mb-[0.45rem] text-[0.72rem] leading-[calc(1.25/0.875)] font-extrabold tracking-[0.04em] text-[var(--aui-muted)] uppercase" id="aui-mobile-sheet-title">
          Navigation
        </p>
        <ShellNavigation
          activePath={activePath}
          routes={routes}
          compact
          sessionIsAdmin={sessionIsAdmin}
          surfaceProfile={surfaceProfile}
          {...(onNavigate ? { onNavigate } : {})}
        />
      </div>
      <div className="aui-mobile-sheet-footer flex shrink-0 items-center gap-[0.65rem] border-t border-border p-[0.7rem] pb-[max(0.7rem,env(safe-area-inset-bottom))] text-[0.82rem] text-[var(--aui-muted)]" aria-label="Mobile identity">
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

function MobileBottomTabs({
  activePath,
  routes,
  sessionIsAdmin,
  surfaceProfile,
  onNavigate,
}: {
  activePath: string;
  routes: RouteAvailability[];
  sessionIsAdmin: boolean;
  surfaceProfile: AuroraSurfaceProfile;
  onNavigate?: (href: string) => void;
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]));
  const tabs = visibleAuroraMobileTabs(surfaceProfile, sessionIsAdmin);
  return (
    <nav
      className="aui-mobile-tabs fixed inset-x-0 bottom-0 z-30 hidden min-h-[calc(4.1rem+env(safe-area-inset-bottom))] grid-cols-3 items-center justify-around border-t border-border bg-sidebar/95 px-0 pt-1.5 pb-[env(safe-area-inset-bottom)] backdrop-blur-[18px] [@media(max-width:1040px)]:grid [@media(max-width:1040px)]:px-1 [@media(max-width:1040px)]:pt-[0.35rem]"
      aria-label="Mobile navigation"
    >
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
  const routeStateLabel = mobileTabStateLabel(routeState);
  return (
    <a
      href={tab.href}
      aria-current={active ? "page" : undefined}
      aria-label={`${tab.mobileLabel ?? tab.label} tab, ${routeStateLabel}`}
      data-mobile-tab={tab.id}
      onClick={(event) => handleShellNavigation(event, tab.href, onNavigate)}
      className={cn(
        "relative flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[10.5px] [@media(max-width:1040px)]:grid [@media(max-width:1040px)]:min-h-[3.3rem] [@media(max-width:1040px)]:place-items-center [@media(max-width:1040px)]:gap-[0.22rem] [@media(max-width:1040px)]:px-[0.12rem] [@media(max-width:1040px)]:pt-[0.42rem] [@media(max-width:1040px)]:pb-[0.3rem] [@media(max-width:1040px)]:text-[0.7rem]",
        active ? "!text-primary before:absolute before:top-[0.22rem] before:h-[0.16rem] before:w-6 before:rounded-full before:bg-primary [@media(max-width:860px)]:before:content-[''] [@media(min-width:861px)]:before:hidden" : "!text-[var(--aui-ink)]",
      )}
    >
      <tab.icon size={18} aria-hidden />
      <span className="block w-full max-w-full overflow-visible text-center text-clip whitespace-nowrap">{tab.mobileLabel ?? tab.label}</span>
      <span className="sr-only" aria-hidden="true" />
    </a>
  );
}

function mobileTabStateLabel(state: RouteAvailability["state"]): string {
  switch (state) {
    case "available-local":
    case "available-remote":
      return "available";
    case "pending":
      return "starting";
    case "degraded":
      return "needs attention";
    case "stale":
      return "refresh needed";
    case "privacy-blocked":
      return "permission needed";
    case "denied":
      return "access needed";
    case "unsupported":
    default:
      return "not available";
  }
}

export function ShellNavigation({
  activePath,
  routes,
  compact = false,
  sessionIsAdmin = false,
  surfaceProfile,
  onNavigate,
}: {
  activePath: string;
  routes: RouteAvailability[];
  compact?: boolean;
  sessionIsAdmin?: boolean;
  surfaceProfile: AuroraSurfaceProfile;
  onNavigate?: (href: string) => void;
}) {
  const routeById = new Map(routes.map((route) => [route.item.id, route]));
  const navigationSections = visibleAuroraNavSections(surfaceProfile, sessionIsAdmin);
  return (
    <nav
      className="aui-nav flex flex-1 flex-col gap-[1.05rem] overflow-auto px-3 py-[0.95rem]"
      aria-label={compact ? "Mobile sheet route navigation" : "Primary route navigation"}
    >
      {navigationSections.map((section) => (
        <section key={section.label} className="flex flex-col gap-0.5">
          <h2 className="mb-[0.35rem] px-2 text-[0.7rem] font-[650] tracking-[0.055em] text-[var(--aui-muted)] uppercase">{section.label}</h2>
          {section.items.map((item) => {
            const route = routeById.get(item.id);
            const active = activePath === item.href;
            return (
              <a
                key={item.id}
                href={item.href}
                className={cn(
                  "grid min-h-8 grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-[0.55rem] rounded-[0.45rem] border-0 bg-transparent px-2 py-[0.36rem] text-[0.875rem] font-semibold",
                  active
                    ? "bg-sidebar-accent !text-sidebar-accent-foreground"
                    : "!text-[var(--aui-muted)] hover:bg-sidebar-accent hover:!text-[var(--aui-ink)]"
                )}
                aria-current={active ? "page" : undefined}
                onClick={(event) => handleShellNavigation(event, item.href, onNavigate)}
              >
                <item.icon size={15} className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{item.label}</span>
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
  nodeMode,
  localNodeAvailable,
}: {
  snapshot: AuroraShellSnapshot;
  runtimeMode?: string | undefined;
  nodeMode?: AuroraNodeMode | undefined;
  localNodeAvailable?: boolean | undefined;
}) {
  const events = shellActivityEvents(snapshot, runtimeMode, nodeMode, localNodeAvailable);
  const shellAlertCopy = snapshot.error
    ? shellCapabilitiesNeedAttention(snapshot)
      ? "Some Aurora features could not be refreshed. They will update automatically."
      : productStatusCopy("connection-failed").title
    : null;
  return (
    <aside className="flex h-full flex-col" aria-label="Aurora activity">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        <Badge variant="outline" className="gap-1">
          <i aria-hidden className="size-1.5 rounded-full bg-success" />
          {activityRailBadgeLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable)}
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

function activityRailBadgeLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
): string {
  if (localNodeNeedsAttention(snapshot, runtimeMode, nodeMode, localNodeAvailable)) return "Attention";
  if (shellCapabilitiesNeedAttention(snapshot)) return "Attention";
  if (shellRuntimeStateIsOffline(snapshot, runtimeMode, nodeMode)) return "Offline";
  if (isRetainedPeerOutageOnLocalNode(snapshot, runtimeMode, nodeMode)) return "Live";
  if (snapshot.loadState !== "ready") return "Syncing";
  return "Live";
}

function shellActivityEvents(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
) {
  const healthy = !shellRuntimeStateIsOffline(snapshot, runtimeMode, nodeMode)
    && !localNodeNeedsAttention(snapshot, runtimeMode, nodeMode, localNodeAvailable)
    && !shellCapabilitiesNeedAttention(snapshot);
  const surface = shellSurfaceProfile(snapshot, runtimeMode, nodeMode);
  const nodeLabel = shellNodeLabel(snapshot);
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
      title: shellModeLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable),
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
      title: "Device connection",
      detail: nodeLabel === "this device" ? "This device is connected" : `${nodeLabel} is connected`,
      when: "ready",
      icon: Network,
      tone: "info",
    },
    {
      id: "native",
      title: "Device features",
      detail: snapshot.nativeAvailable
        ? "Device features available"
        : surface.usesNativeShell
          ? productSurfaceLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable)
          : `${productSurfaceLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable)}; local controls unavailable`,
      when: snapshot.nativeAvailable ? "ready" : "limited",
      icon: snapshot.nativeAvailable ? CheckCircle2 : Clock3,
      tone: snapshot.nativeAvailable ? "good" : "info",
    },
  ] as const;
}

function shellSurfaceLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
): string {
  return productSurfaceLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable);
}

export function shellHealthLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
  peerConnectionState?: AuroraPeerConnectionState | null,
  connectionState?: AuroraConnectionState | null,
): string {
  const peerHealth = peerConnectionHealthLabel(peerConnectionState);
  if (peerHealth && peerHealth !== "Healthy") return peerHealth;
  const aggregateHealth = aggregateConnectionHealthLabel(connectionState);
  if (aggregateHealth && aggregateHealth !== "Healthy") return aggregateHealth;
  if (localNodeNeedsAttention(snapshot, runtimeMode, nodeMode, localNodeAvailable)) return "Degraded";
  if (shellCapabilitiesNeedAttention(snapshot)) return "Degraded";
  if (shellRuntimeStateIsOffline(snapshot, runtimeMode, nodeMode)) return "Offline";
  if (peerHealth) return peerHealth;
  if (aggregateHealth) return aggregateHealth;
  if (snapshot.loadState === "loading") return "Connecting";
  return "Healthy";
}

function shellNodeLabel(snapshot: AuroraShellSnapshot): string {
  const label = snapshot.nodeName.trim();
  if (/^(?:local|local-peer|localhost|aurora web thin client)$/i.test(label)) return "this device";
  return label || "This device";
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

export function shellRuntimeStateLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
  peerConnectionState?: AuroraPeerConnectionState | null,
  connectionState?: AuroraConnectionState | null,
): string {
  const peerLabel = peerConnectionRuntimeLabel(peerConnectionState);
  if (peerLabel && peerLabel !== "connected") return peerLabel;
  const aggregateLabel = aggregateConnectionRuntimeLabel(connectionState);
  if (aggregateLabel && aggregateLabel !== "connected") return aggregateLabel;
  if (localNodeNeedsAttention(snapshot, runtimeMode, nodeMode, localNodeAvailable)) return "attention";
  if (shellCapabilitiesNeedAttention(snapshot)) return "attention";
  if (shellRuntimeStateIsOffline(snapshot, runtimeMode, nodeMode)) return "offline";
  if (peerLabel) return peerLabel;
  if (aggregateLabel) return aggregateLabel;
  if (isRetainedPeerOutageOnLocalNode(snapshot, runtimeMode, nodeMode)) return "available";
  if (snapshot.loadState === "loading") return "syncing";
  return "connected";
}

function shellModeLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
): string {
  return productSurfaceLabel(snapshot, runtimeMode, nodeMode, localNodeAvailable);
}

export function shellRuntimeStateToneClass(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
  peerConnectionState?: AuroraPeerConnectionState | null,
  connectionState?: AuroraConnectionState | null,
): string {
  const peerTone = peerConnectionRuntimeToneClass(peerConnectionState);
  if (peerTone && peerTone !== "text-success") return peerTone;
  const aggregateTone = aggregateConnectionRuntimeToneClass(connectionState);
  if (aggregateTone && aggregateTone !== "text-success") return aggregateTone;
  if (localNodeNeedsAttention(snapshot, runtimeMode, nodeMode, localNodeAvailable)) return "text-warning";
  if (shellCapabilitiesNeedAttention(snapshot)) return "text-warning";
  if (shellRuntimeStateIsOffline(snapshot, runtimeMode, nodeMode)) return "text-destructive";
  if (peerTone) return peerTone;
  if (aggregateTone) return aggregateTone;
  return "text-success";
}

function aggregateConnectionHealthLabel(connectionState?: AuroraConnectionState | null): string | null {
  if (!connectionState) return null;
  if (connectionState === "connected") return "Healthy";
  // Stream loss means updates are delayed; queries and local services may work.
  return "Degraded";
}

function aggregateConnectionRuntimeLabel(connectionState?: AuroraConnectionState | null): string | null {
  if (!connectionState) return null;
  if (connectionState === "connected") return "connected";
  if (connectionState === "connecting" || connectionState === "reconnecting") return "syncing";
  return "attention";
}

function aggregateConnectionRuntimeToneClass(connectionState?: AuroraConnectionState | null): string | null {
  if (!connectionState) return null;
  if (connectionState === "connected") return "text-success";
  return "text-warning";
}

function peerConnectionHealthLabel(peerConnectionState?: AuroraPeerConnectionState | null): string | null {
  if (!peerConnectionState) return null;
  if (peerConnectionState === "connected") return "Healthy";
  if (peerConnectionState === "connecting" || peerConnectionState === "reconnecting") return "Connecting";
  return "Offline";
}

function peerConnectionRuntimeLabel(peerConnectionState?: AuroraPeerConnectionState | null): string | null {
  if (!peerConnectionState) return null;
  if (peerConnectionState === "connected") return "connected";
  if (peerConnectionState === "connecting" || peerConnectionState === "reconnecting") return "syncing";
  return "offline";
}

function peerConnectionRuntimeToneClass(peerConnectionState?: AuroraPeerConnectionState | null): string | null {
  if (!peerConnectionState) return null;
  if (peerConnectionState === "connected") return "text-success";
  if (peerConnectionState === "connecting" || peerConnectionState === "reconnecting") return "text-warning";
  return "text-destructive";
}

function shellSurfaceProfile(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
) {
  return getAuroraSurfaceProfile({
    runtimeMode,
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    nodeMode,
  });
}

function isRetainedPeerOutageOnLocalNode(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
): boolean {
  return shellSurfaceProfile(snapshot, runtimeMode, nodeMode).ownsLocalNodeState
    && snapshot.loadState === "error"
    && snapshot.error === null
    && snapshot.transportKind === "mesh";
}

function shellRuntimeStateIsOffline(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
): boolean {
  return (snapshot.loadState === "error" || snapshot.connectionState === "offline")
    && snapshot.connectionState !== "connected"
    && !isRetainedPeerOutageOnLocalNode(snapshot, runtimeMode, nodeMode);
}

function shellCapabilitiesNeedAttention(snapshot: AuroraShellSnapshot): boolean {
  return snapshot.connectionState === "connected"
    && snapshot.capabilityFreshness === "stale";
}

function localNodeNeedsAttention(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
): boolean {
  return localNodeAvailable === false
    && shellSurfaceProfile(snapshot, runtimeMode, nodeMode).ownsLocalNodeState;
}

function productSurfaceLabel(
  snapshot: AuroraShellSnapshot,
  runtimeMode?: string,
  nodeMode?: AuroraNodeMode,
  localNodeAvailable?: boolean,
): string {
  const profile = shellSurfaceProfile(snapshot, runtimeMode, nodeMode);
  if (profile.usesLocalSidecar) return "Aurora is running on this computer";
  if (localNodeAvailable === false && profile.ownsLocalNodeState) return "Device setup needs attention";
  if (isRetainedPeerOutageOnLocalNode(snapshot, runtimeMode, nodeMode)) return "This device is available";
  if (shellCapabilitiesNeedAttention(snapshot)) {
    return profile.ownsLocalNodeState
      ? "This device is available"
      : `Connected to ${shellNodeLabel(snapshot)}`;
  }
  if (snapshot.loadState === "error") return `${shellNodeLabel(snapshot)} is offline`;
  if (profile.ownsLocalNodeState) return "This device is available";
  if (nodeMode === "remote-console") return `Connected to ${shellNodeLabel(snapshot)}`;
  if (profile.isMobile) return "This device is available";
  return `Connected to ${shellNodeLabel(snapshot)}`;
}

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}
