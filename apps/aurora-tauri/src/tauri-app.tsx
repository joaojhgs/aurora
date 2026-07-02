import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  AdminAuditResource,
  AdminDevicesResource,
  AdminOverviewContent,
  AdminPluginsView,
  AdminRbacResource,
  AdminSchedulerView,
  AdminServicesResource,
  AppShell,
  AssistantView,
  BackupRestoreView,
  ConfigEditorView,
  MemoryView,
  MeshDiagnosticsResource,
  MeshPeersResource,
  ModelsView,
  OnboardingView,
  PairingQueueView,
  RouteMatrix,
  RoutePolicyResource,
  SettingsPermissionsView,
  StateSurface,
  ToolApprovalPanel,
  auroraNavSections,
  buildShellSnapshot,
  loadingShellSnapshot,
  navItemSnapshot,
  redactDiagnosticText,
  type AuroraNavItem,
  type AuroraShellSnapshot,
  type RouteAvailability,
} from "@aurora/ui";
import type {
  AdminOverviewManifest,
  AndroidLocalLightInferenceStatus,
  TauriAndroidBaselineStatus,
  TauriIosInvocationStatus,
  TauriNativeFeatureStatus,
  TauriNativePermissionStatus,
  TauriSidecarStatus,
} from "@aurora/client";
import { createAuroraTauriRuntime } from "./aurora-client";

const navItems = auroraNavSections.flatMap((section) => section.items)
type AuroraTauriRuntime = ReturnType<typeof createAuroraTauriRuntime>
type AuroraTauriClient = AuroraTauriRuntime['client']
type TauriRouteRenderer = (input: {
  route: RouteAvailability
  snapshot: AuroraShellSnapshot
  nativeContext: NativeContext
  client: AuroraTauriClient
  shutdown: () => Promise<void>
  assistantNativePermissions: Array<{ name: string; granted: boolean }>
  assistantNativeCapabilities: Array<{ name: string; enabled: boolean }>
}) => ReactElement

export const tauriRouteRegistry: Record<string, TauriRouteRenderer> = {
  assistant: ({ route, snapshot, client, assistantNativePermissions, assistantNativeCapabilities }) => (
    <AssistantView
      client={client}
      route={route}
      cancellationRoute={snapshot.assistantCancellationRoute ?? undefined}
      voiceRoutes={snapshot.assistantVoiceRoutes}
      nativePlatform={snapshot.nativePlatform}
      nativeAvailable={snapshot.nativeAvailable}
      nativePermissions={assistantNativePermissions}
      nativeCapabilities={assistantNativeCapabilities}
    />
  ),
  memory: ({ route, client }) => <MemoryView client={client} route={route} />,
  tools: ({ route, client }) => <ToolApprovalPanel client={client} route={route} />,
  mesh: ({ route, client }) => (
    <div className="ata-page-stack">
      <MeshPeersResource client={client} route={route} />
      <RoutePolicyResource client={client} route={route} />
    </div>
  ),
  admin: ({ client }) => <AdminOverviewResource client={client} />,
  services: ({ client }) => <AdminServicesResource client={client} />,
  access: ({ client }) => <AdminRbacResource client={client} />,
  tokens: ({ client }) => <AdminRbacResource client={client} />,
  devices: ({ client }) => <AdminDevicesResource client={client} />,
  config: ({ route, client }) => <ConfigEditorView client={client} route={route} />,
  contracts: ({ client }) => <AdminServicesResource client={client} />,
  plugins: ({ route, client }) => <AdminPluginsView client={client} route={route} />,
  pairing: ({ route, client }) => <PairingQueueView client={client} route={route} />,
  backups: ({ route, client }) => <BackupRestoreView client={client} route={route} />,
  scheduler: ({ route, client }) => <AdminSchedulerView client={client} route={route} />,
  audit: ({ client }) => <AdminAuditResource client={client} />,
  models: ({ client }) => <ModelsView client={client} />,
  diagnostics: ({ route, snapshot, nativeContext, client, shutdown }) => (
    <TauriDiagnosticsPage route={route} snapshot={snapshot} nativeContext={nativeContext} client={client} shutdown={shutdown} />
  ),
  onboarding: ({ snapshot, client }) => <OnboardingView client={client} snapshot={snapshot} />,
  settings: ({ snapshot }) => <SettingsPermissionsView snapshot={snapshot} />,
  data: ({ route, client }) => <MemoryView client={client} route={route} />,
  native: ({ snapshot }) => <SettingsPermissionsView snapshot={snapshot} />
}

export const tauriRouteRegistryRouteIds = Object.freeze(Object.keys(tauriRouteRegistry))

export function AuroraTauriApp() {
  const runtime = useMemo(() => createAuroraTauriRuntime(), []);
  const [snapshot, setSnapshot] =
    useState<AuroraShellSnapshot>(loadingShellSnapshot);
  const [currentPath, setCurrentPath] = useState(() => currentBrowserPath());
  const [sidecar, setSidecar] = useState<TauriSidecarStatus | null>(null);
  const [nativePermissions, setNativePermissions] =
    useState<TauriNativePermissionStatus | null>(null);
  const [nativeFeatures, setNativeFeatures] = useState<
    Record<string, TauriNativeFeatureStatus | null>
  >({});
  const [iosInvocationStatus, setIosInvocationStatus] =
    useState<TauriIosInvocationStatus | null>(null);
  const [iosLocalLightStatus, setIosLocalLightStatus] =
    useState<AndroidLocalLightInferenceStatus | null>(null);
  const [androidBaseline, setAndroidBaseline] =
    useState<TauriAndroidBaselineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const localSidecar =
        runtime.mode === "desktop-local"
          ? await runtime.startSidecar().catch((error: unknown) => ({
              running: false,
              mode: "desktop-local-start-failed",
              lastError: error instanceof Error ? error.message : String(error),
              details: {},
            }))
          : null;
      const [
        nextSnapshot,
        nextSidecar,
        nextNativePermissions,
        tray,
        notifications,
        iosVoice,
        iosInvocation,
        iosLocalLight,
        iosBackground,
        dialogs,
        audio,
        iosKeychain,
        iosBiometrics,
        android,
      ] = await Promise.all([
        buildShellSnapshot(runtime.client),
        localSidecar
          ? Promise.resolve(localSidecar)
          : runtime.sidecarStatus().catch(() => null),
        runtime.nativePermissionStatus().catch(() => null),
        runtime.trayStatus().catch(() => null),
        runtime.notificationStatus().catch(() => null),
        runtime.iosVoiceStatus().catch(() => null),
        runtime.iosInvocationStatus().catch(() => null),
        runtime.iosLocalLightInferenceStatus().catch(() => null),
        runtime.iosBackgroundStatus().catch(() => null),
        runtime.dialogStatus().catch(() => null),
        runtime.audioBridgeStatus().catch(() => null),
        runtime.iosSecureStorageStatus().catch(() => null),
        runtime.iosBiometricStatus().catch(() => null),
        runtime.androidBaselineStatus().catch(() => null),
      ]);
      if (!cancelled) {
        setSnapshot(nextSnapshot);
        setSidecar(nextSidecar);
        setNativePermissions(nextNativePermissions);
        setNativeFeatures({
          tray,
          notifications,
          iosVoice,
          iosBackground,
          dialogs,
          audio,
          iosKeychain,
          iosBiometrics,
        });
        setIosInvocationStatus(iosInvocation);
        setIosLocalLightStatus(iosLocalLight);
        setAndroidBaseline(android);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => setCurrentPath(currentBrowserPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((href: string) => {
    const nextPath = normalizePath(href);
    setCurrentPath(nextPath);
    if (
      typeof window !== "undefined" &&
      normalizePath(window.location.pathname) !== nextPath
    ) {
      window.history.pushState({}, "", nextPath);
    }
  }, []);

  const localMode = runtime.mode === "desktop-local";
  const sidecarEvidence = sidecar
    ? redactDiagnosticText(`${sidecar.mode ?? 'unknown'}; gateway=${sidecar.gatewayUrl ?? 'not configured'}; running=${String(sidecar.running)}`)
    : 'native sidecar status unavailable in this runtime'
  const nativeContext: NativeContext = {
    runtimeMode: runtime.mode,
    localMode,
    sidecar,
    sidecarEvidence,
    nativePermissions,
    nativeFeatures,
    iosInvocationStatus,
    iosLocalLightStatus,
    androidBaseline,
  };

  return (
    <AppShell
      snapshot={snapshot}
      currentPath={currentPath}
      onNavigate={navigate}
    >
      <TauriRouteContent
        path={currentPath}
        snapshot={snapshot}
        nativeContext={nativeContext}
        client={runtime.client}
        shutdown={runtime.shutdown}
      />
    </AppShell>
  );
}

interface NativeContext {
  runtimeMode: string;
  localMode: boolean;
  sidecar: TauriSidecarStatus | null;
  sidecarEvidence: string;
  nativePermissions: TauriNativePermissionStatus | null;
  nativeFeatures: Record<string, TauriNativeFeatureStatus | null>;
  iosInvocationStatus: TauriIosInvocationStatus | null;
  iosLocalLightStatus: AndroidLocalLightInferenceStatus | null;
  androidBaseline: TauriAndroidBaselineStatus | null;
}

function TauriRouteContent({
  path,
  snapshot,
  nativeContext,
  client,
  shutdown,
}: {
  path: string;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: ReturnType<typeof createAuroraTauriRuntime>["client"];
  shutdown: () => Promise<void>;
}) {
  const route = routeForPath(snapshot, path)
  const renderRoute = tauriRouteRegistry[route.item.id]
  const assistantNativePermissions = useMemo(
    () =>
      snapshot.nativePermissions.map((permission) => ({
        name: permission.name,
        granted: permission.granted,
      })),
    [snapshot.nativePermissions],
  );
  const assistantNativeCapabilities = useMemo(
    () => snapshot.nativeCapabilities.map((capability) => ({ name: capability.name, enabled: capability.enabled })),
    [snapshot.nativeCapabilities]
  )
  if (!renderRoute) return <MissingTauriRoute route={route} />
  return renderRoute({
    route,
    snapshot,
    nativeContext,
    client,
    shutdown,
    assistantNativePermissions,
    assistantNativeCapabilities
  })
}

function AdminOverviewResource({ client }: { client: AuroraTauriClient }) {
  const [manifest, setManifest] = useState<AdminOverviewManifest | null>(null)
  const [error, setError] = useState<unknown>(new Error('Loading admin overview manifest from AuroraClient.'))

  useEffect(() => {
    let cancelled = false
    setManifest(null)
    setError(new Error('Loading admin overview manifest from AuroraClient.'))
    void client.adminOverview.getManifest().then(
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

function TauriAdminOverviewPage({
  client
}: {
  client: ReturnType<typeof createAuroraTauriRuntime>['client']
}) {
  const [manifest, setManifest] = useState<AdminOverviewManifest | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    client.adminOverview.getManifest().then(
      (next) => {
        if (!cancelled) {
          setManifest(next)
          setError(null)
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

function TauriDiagnosticsPage({
  route,
  snapshot,
  nativeContext,
  client,
  shutdown
}: {
  route: RouteAvailability
  snapshot: AuroraShellSnapshot
  nativeContext: NativeContext
  client: AuroraTauriClient
  shutdown: () => Promise<void>
}) {
  return (
    <div className="ata-page-stack">
      <StateSurface
        title={
          nativeContext.localMode ? "Desktop local shell" : "Desktop thin shell"
        }
        state={
          snapshot.loadState === "error"
            ? "denied"
            : nativeContext.sidecar?.running
              ? "available-local"
              : nativeContext.localMode
                ? "pending"
                : "available-remote"
        }
        description="Aurora desktop uses the official Tauri shell while keeping service truth behind AuroraClient."
        evidence={nativeContext.sidecarEvidence}
        actionLabel={redactDiagnosticText(nativeContext.sidecar?.lastError) || null}
      />
      <section className="ata-panel">
        <h2>Native boundary</h2>
        <dl className="ata-facts">
          <div>
            <dt>Runtime mode</dt>
            <dd>{runtimeModeLabel(nativeContext.runtimeMode)}</dd>
          </div>
          <div>
            <dt>SDK transport</dt>
            <dd>{transportKindLabel(snapshot.transportKind, nativeContext.runtimeMode)}</dd>
          </div>
          <div>
            <dt>Sidecar supervisor</dt>
            <dd>
              {nativeContext.sidecar?.running
                ? "running"
                : nativeContext.localMode
                  ? "stopped or unavailable"
                  : "not used in thin mode"}
            </dd>
          </div>
          <div>
            <dt>Native manifest</dt>
            <dd>
              {snapshot.nativeAvailable
                ? snapshot.nativePlatform
                : "unavailable"}
            </dd>
          </div>
          <div>
            <dt>Tray</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.tray)}</dd>
          </div>
          <div>
            <dt>Notifications</dt>
            <dd>
              {nativeFeatureLabel(nativeContext.nativeFeatures.notifications)}
            </dd>
          </div>
          <div>
            <dt>iOS microphone capture</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.iosVoice)}</dd>
          </div>
          <div>
            <dt>iOS background voice</dt>
            <dd>
              {nativeFeatureLabel(nativeContext.nativeFeatures.iosBackground)}
            </dd>
          </div>
          <div>
            <dt>Dialogs</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.dialogs)}</dd>
          </div>
          <div>
            <dt>Audio bridge</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.audio)}</dd>
          </div>
          <div>
            <dt>iOS Keychain</dt>
            <dd>
              {nativeFeatureLabel(nativeContext.nativeFeatures.iosKeychain)}
            </dd>
          </div>
          <div>
            <dt>Face ID / Touch ID</dt>
            <dd>
              {nativeFeatureLabel(nativeContext.nativeFeatures.iosBiometrics)}
            </dd>
          </div>
          <div>
            <dt>iOS invocation</dt>
            <dd>{iosInvocationLabel(nativeContext.iosInvocationStatus)}</dd>
          </div>
          <div>
            <dt>iOS local-light inference</dt>
            <dd>
              {localLightInferenceLabel(nativeContext.iosLocalLightStatus)}
            </dd>
          </div>
          <div>
            <dt>Android baseline</dt>
            <dd>{androidBaselineLabel(nativeContext.androidBaseline)}</dd>
          </div>
          <div>
            <dt>Assistant role probe</dt>
            <dd>{assistantRoleProbeLabel(nativeContext.androidBaseline)}</dd>
          </div>
          <div>
            <dt>Denied native defaults</dt>
            <dd>
              {nativeContext.nativePermissions?.deniedByDefault.join(", ") ??
                "not available"}
            </dd>
          </div>
        </dl>
        <button
          className="ata-secondary"
          type="button"
          onClick={() => void shutdown()}
        >
          Shut down shell
        </button>
      </section>
      <RouteMatrix routes={snapshot.routes} />
      <MeshDiagnosticsResource client={client} route={route} />
    </div>
  );
}

function MissingTauriRoute({ route }: { route: RouteAvailability }) {
  return (
    <div className="ata-page-stack">
      <StateSurface
        title={`${route.item.label} route registry error`}
        state="denied"
        description="The Tauri shell could not find a production route component for this nav item."
        evidence={`${route.providerLabel}; blockers=${route.blockers.join(', ') || 'none'}`}
        actionLabel="Route registry repair required"
      />
      <section className="ata-panel">
        <h2>{route.item.label} route is unregistered</h2>
        <dl className="ata-facts">
          <div><dt>Expected task</dt><dd>{route.item.expectedTask}</dd></div>
          <div><dt>Privacy class</dt><dd>{route.item.privacyClass}</dd></div>
          <div><dt>Routeable</dt><dd>{route.routeable ? 'yes' : 'no'}</dd></div>
          <div><dt>Route id</dt><dd>{route.item.id}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function TauriAdminActionPage({ children, status }: { children: ReactNode; status: string | null }) {
  return (
    <div className="ata-page-stack">
      {status ? <p className="aui-message" role="status">{status}</p> : null}
      {children}
    </div>
  )
}

function isRbacAction(action: AdminRbacAction | AdminServiceControlAction): action is AdminRbacAction {
  return 'payload' in action
}

function routeForPath(snapshot: AuroraShellSnapshot, path: string): RouteAvailability {
  const normalized = normalizePath(path)
  const item = itemForPath(normalized) ?? navItems[0]!
  return snapshot.routes.find((route) => route.item.id === item.id) ?? fallbackRoute(item)
}

function itemForPath(path: string): AuroraNavItem | undefined {
  const normalized = normalizePath(path);
  return navItems.find((item) => normalizePath(item.href) === normalized);
}

function fallbackRoute(item: AuroraNavItem): RouteAvailability {
  return {
    item: navItemSnapshot(item),
    state: item.fallbackState,
    explanation: "Capability state is loading from AuroraClient.",
    providerLabel: "pending backend evidence",
    blockers: ["loading"],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ["pending SDK request"],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: item.methodType === "manage",
  };
}

function currentBrowserPath(): string {
  if (typeof window === "undefined") return "/";
  return normalizePath(window.location.pathname);
}

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  const withoutHash = path.split("#")[0] || "/";
  return withoutHash.endsWith("/") && withoutHash !== "/"
    ? withoutHash.slice(0, -1)
    : withoutHash;
}


function runtimeModeLabel(mode: string): string {
  if (mode === 'mock') return 'mock (degraded development fixture only)'
  if (mode === 'desktop-local') return 'desktop-local (Tauri sidecar supervised local stack)'
  if (mode === 'desktop-thin') return 'desktop-thin (remote Gateway, no local sidecar)'
  return mode
}

function transportKindLabel(transportKind: string, runtimeMode: string): string {
  if (runtimeMode === 'mock') return 'mock (SDK fixture transport; development fallback only)'
  if (transportKind === 'pending' && runtimeMode === 'desktop-local') return 'tauri (pending local Gateway readiness)'
  if (transportKind === 'pending' && runtimeMode === 'desktop-thin') return 'http (pending remote Gateway readiness)'
  return transportKind
}

function nativeFeatureLabel(
  feature: TauriNativeFeatureStatus | null | undefined,
): string {
  if (!feature) return "not available";
  if (feature.available) return `${feature.capability} available`;
  return `${feature.capability} denied by default`;
}

function iosInvocationLabel(
  status: TauriIosInvocationStatus | null | undefined,
): string {
  if (!status)
    return "Siri/Shortcuts/App Intents integration; no system assistant role claim.";
  const state = status.available ? status.surface : "not available";
  return `${state}; no system assistant role claim.`;
}

function localLightInferenceLabel(
  status: AndroidLocalLightInferenceStatus | null | undefined,
): string {
  if (!status) return "local-light inference provider pending native evidence.";
  return `${status.platform} ${status.providerId} ${status.state}; backend model catalog required=${String(status.backendModelCatalogRequired)}`;
}

function androidBaselineLabel(
  status: TauriAndroidBaselineStatus | null,
): string {
  if (!status) return "not available";
  return `${status.feature} ${status.state}; platform=${status.platform}`;
}

function assistantRoleProbeLabel(
  status: TauriAndroidBaselineStatus | null,
): string {
  if (!status) return "not available";
  return status.assistantRole.probeImplemented
    ? "native probe implemented"
    : `probe deferred; role availability unknown; ${status.assistantRole.reason}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
