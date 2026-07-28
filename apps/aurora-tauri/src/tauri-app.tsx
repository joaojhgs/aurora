import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  AdminAuditResource,
  AdminOverviewContent,
  AdminDevicesResource,
  AdminRbacResource,
  AdminSchedulerView,
  AdminServicesResource,
  AdminContractsResource,
  AdminTokensResource,
  AdminPluginsView,
  AppShell,
  AssistantView,
  AURORA_OWL_LOADER_STAGES,
  AuroraOwlLoader,
  BackupRestoreView,
  ConfigEditorView,
  MemoryView,
  DataPolicyResource,
  EvidenceBadge,
  MeshDiagnosticsResource,
  MeshPeersResource,
  ModelsView,
  type OnboardingModePreferenceStore,
  OnboardingView,
  PageHeader,
  PairingQueueView,
  RouteMatrix,
  RoutePolicyResource,
  ServiceRoutingResource,
  SettingsPermissionsView,
  StateSurface,
  ToolApprovalPanel,
  WebThinConnectionPanel,
  getAuroraSurfaceProfile,
  shouldShowForSurface,
  auroraNavSections,
  auroraEmbeddedNavItems,
  getAuroraNavItem,
  buildShellSnapshot,
  errorShellSnapshot,
  loadingShellSnapshot,
  navItemSnapshot,
  redactDiagnosticText,
  retainThinShellSnapshot,
  type AuroraNavItem,
  type AuroraOwlLoaderStageId,
  type AuroraShellSnapshot,
  type RouteAvailability,
  type WebThinRoomSecret,
} from "@aurora/ui";
import owlSrc from "./assets/aurora-owl.png";
import { GATEWAY_METHODS } from "@aurora/client";
import type {
  AdminOverviewManifest,
  AndroidLocalLightInferenceStatus,
  AuroraClient,
  ServiceInfo,
  TauriAndroidBaselineStatus,
  TauriIosInvocationStatus,
  TauriNativeFeatureStatus,
  TauriNativePermissionStatus,
  TauriSidecarStatus,
} from "@aurora/client";
import {
  bootstrapAuroraTauriRuntime,
  createAuroraTauriRuntime,
  createInitialAuroraTauriRuntime,
  requiresAsyncAuroraTauriBootstrap,
  type AndroidForegroundRuntimeStatus,
  type AndroidMediaPolicyStatus,
  type AuroraThinConnectionProfile,
  type AuroraThinProfileDocument,
} from "./aurora-client";
import {
  initMeshDeepLinks,
  isMobileTauriShell,
  scanMeshInviteQr,
} from "./mesh-deeplink";

const navItems = auroraNavSections.flatMap((section) => section.items);
const routePathItems = [...navItems, ...auroraEmbeddedNavItems];
export type AuroraTauriRuntime = ReturnType<typeof createAuroraTauriRuntime>;
type AuroraTauriClient = AuroraTauriRuntime["client"];
type TauriRouteRenderer = (input: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
  shutdown: () => Promise<void>;
  modePreferenceStore?: OnboardingModePreferenceStore | undefined;
  assistantNativePermissions: Array<{ name: string; granted: boolean }>;
  assistantNativeCapabilities: Array<{ name: string; enabled: boolean }>;
}) => ReactElement;

const primaryTauriRouteIds = [
  "assistant",
  "memory",
  "tools",
  "mesh",
  "admin",
  "services",
  "access",
  "tokens",
  "backups",
  "scheduler",
  "audit",
  "settings",
  "models",
] as const;

const embeddedTauriRouteIds = [
  "devices",
  "config",
  "contracts",
  "plugins",
  "pairing",
  "diagnostics",
  "data",
  "native",
  "onboarding",
] as const;

const tauriRouteIds = [
  ...primaryTauriRouteIds,
  ...embeddedTauriRouteIds,
] as const;

type TauriRouteId = (typeof tauriRouteIds)[number];

export const tauriRouteRegistry = {
  assistant: ({
    route,
    snapshot,
    nativeContext,
    client,
    assistantNativePermissions,
    assistantNativeCapabilities,
  }) => (
    <AssistantView
      client={client}
      route={route}
      cancellationRoute={snapshot.assistantCancellationRoute ?? undefined}
      voiceRoutes={snapshot.assistantVoiceRoutes}
      nativePlatform={snapshot.nativePlatform}
      nativeAvailable={snapshot.nativeAvailable}
      nativePermissions={assistantNativePermissions}
      nativeCapabilities={assistantNativeCapabilities}
      runtimeHealth={{
        selectedModel: null,
        routeLabel: `${route.providerLabel} / ${route.state}`,
        sidecarHealth: nativeContext.sidecar?.running
          ? "running"
          : nativeContext.localMode
            ? "pending sidecar readiness"
            : "not used in thin/mock mode",
        gatewayHealth: nativeContext.sidecar?.gatewayUrl
          ? `Gateway ${nativeContext.sidecar.gatewayUrl}`
          : `${snapshot.transportKind} transport`,
      }}
    />
  ),
  memory: ({ route, client }) => <MemoryView client={client} route={route} />,
  tools: ({ route, client }) => (
    <div className="ata-page-stack">
      <p className="text-xs font-medium text-muted-foreground">Sources</p>
      <ToolApprovalPanel client={client} route={route} />
    </div>
  ),
  mesh: ({ route, nativeContext, client }) => {
    const inviteParam = initialThinInviteFromUrl();
    return (
      <div className="ata-page-stack">
        <MeshPeersResource
          key={inviteParam ?? "mesh-peers"}
          client={client}
          route={route}
          surfaceProfile={nativeContext.surfaceProfile}
          thinPeer={nativeContext.thinPeer}
          initialInviteText={inviteParam}
          {...(isMobileTauriShell() ? { onScanQr: scanMeshInviteQr } : {})}
        />
        <ServiceRoutingResource
          client={client}
          route={route}
          thinPeer={nativeContext.thinPeer}
        />
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Outbound route decision preview (advanced)
          </summary>
          <RoutePolicyResource client={client} route={route} />
        </details>
      </div>
    );
  },
  admin: ({ route, snapshot, nativeContext, client, shutdown }) => (
    <TauriAdminOverviewPage
      route={route}
      snapshot={snapshot}
      nativeContext={nativeContext}
      client={client}
      shutdown={shutdown}
    />
  ),
  services: ({ client }) => <AdminServicesResource client={client} />,
  access: ({ client }) => <AdminRbacResource client={client} />,
  tokens: ({ client }) => <AdminTokensResource client={client} />,
  backups: ({ route, client }) => (
    <BackupRestoreView client={client} route={route} />
  ),
  scheduler: ({ route, client }) => (
    <AdminSchedulerView client={client} route={route} />
  ),
  audit: ({ client }) => <AdminAuditResource client={client} />,
  settings: ({ route, snapshot, nativeContext, client }) => (
    <TauriSettingsPage
      route={route}
      snapshot={snapshot}
      nativeContext={nativeContext}
      client={client}
    />
  ),
  devices: ({ client }) => <AdminDevicesResource client={client} />,
  config: ({ route, client }) => (
    <ConfigEditorView client={client} route={route} />
  ),
  contracts: ({ client }) => <AdminContractsResource client={client} />,
  plugins: ({ route, client }) => (
    <AdminPluginsView client={client} route={route} />
  ),
  pairing: ({ route, client }) => (
    <PairingQueueView client={client} route={route} />
  ),
  diagnostics: ({ route, snapshot, nativeContext, client, shutdown }) => (
    <TauriDiagnosticsPage
      route={route}
      snapshot={snapshot}
      nativeContext={nativeContext}
      client={client}
      shutdown={shutdown}
    />
  ),
  data: ({ route, client }) => (
    <DataPolicyResource client={client} route={route} />
  ),
  native: ({ snapshot, nativeContext }) => (
    <TauriNativeSettingsPage
      snapshot={snapshot}
      nativeContext={nativeContext}
    />
  ),
  models: ({ client }) => <ModelsView client={client} />,
  onboarding: ({ snapshot, client, modePreferenceStore }) => (
    <OnboardingView
      client={client}
      snapshot={snapshot}
      modePreferenceStore={modePreferenceStore}
    />
  ),
} satisfies Record<TauriRouteId, TauriRouteRenderer>;

const tauriRouteIdSet = new Set<string>(tauriRouteIds);

export const tauriRouteRegistryRouteIds = Object.freeze([
  ...primaryTauriRouteIds,
]);

export async function rebuildAuroraThinRuntime(
  runtime: AuroraTauriRuntime,
  action: (
    controller: NonNullable<AuroraTauriRuntime["thinProfileController"]>,
  ) => Promise<AuroraThinProfileDocument>,
): Promise<AuroraTauriRuntime> {
  const controller = runtime.thinProfileController;
  if (!controller) return runtime;
  const document = await action(controller);
  await runtime.dispose();
  return controller.createRuntime(document);
}

const DESKTOP_LOCAL_GATEWAY_READY_TIMEOUT_MS = 45_000;
const DESKTOP_LOCAL_GATEWAY_RETRY_DELAY_MS = 500;
const DESKTOP_LOCAL_SNAPSHOT_READY_TIMEOUT_MS = 10_000;

export function AuroraTauriApp({
  runtimeOverride,
  initialSnapshotOverride,
}: {
  runtimeOverride?: AuroraTauriRuntime;
  initialSnapshotOverride?: AuroraShellSnapshot;
} = {}) {
  const initialRuntime = useMemo(
    () => runtimeOverride ?? createInitialAuroraTauriRuntime(),
    [runtimeOverride],
  );
  const [runtime, setRuntime] = useState(initialRuntime);
  const [thinPeerReadyRevision, setThinPeerReadyRevision] = useState(0);
  const [profileBootstrapReady, setProfileBootstrapReady] = useState(
    () => Boolean(runtimeOverride) || !requiresAsyncAuroraTauriBootstrap(),
  );
  const [snapshot, setSnapshot] = useState<AuroraShellSnapshot>(
    initialSnapshotOverride ?? loadingShellSnapshot,
  );
  const [loadingStage, setLoadingStage] =
    useState<AuroraOwlLoaderStageId>("boot");
  const [loadingProgressPct, setLoadingProgressPct] = useState<number | null>(
    null,
  );
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
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
  const [androidForeground, setAndroidForeground] =
    useState<AndroidForegroundRuntimeStatus | null>(null);
  const [androidMediaPolicy, setAndroidMediaPolicy] =
    useState<AndroidMediaPolicyStatus | null>(null);

  useEffect(() => {
    if (runtimeOverride || !requiresAsyncAuroraTauriBootstrap()) return;
    let cancelled = false;
    void bootstrapAuroraTauriRuntime()
      .then(async (nextRuntime) => {
        if (cancelled) {
          await nextRuntime.dispose();
          return;
        }
        await runtime.dispose();
        if (!cancelled) {
          setRuntime(nextRuntime);
          setProfileBootstrapReady(true);
        }
      })
      .catch((error) => {
        console.warn("desktop-thin profile bootstrap failed", error);
        if (!cancelled) setProfileBootstrapReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeOverride]);

  const rebuildThinRuntime = useCallback(
    async (
      action: (
        controller: NonNullable<
          AuroraTauriRuntime["thinProfileController"]
        >,
      ) => Promise<AuroraThinProfileDocument>,
    ) => {
      setRuntime(await rebuildAuroraThinRuntime(runtime, action));
    },
    [runtime],
  );

  const saveThinProfile = useCallback(
    (
      profile: AuroraThinConnectionProfile,
      roomSecret?: {
        roomSecretRef: string;
        roomSecret: string;
      },
    ) =>
      rebuildThinRuntime((controller) =>
        controller.saveProfile(profile, roomSecret),
      ),
    [rebuildThinRuntime],
  );

  const selectThinProfile = useCallback(
    (profileId: string) =>
      rebuildThinRuntime((controller) =>
        controller.selectProfile(profileId),
      ),
    [rebuildThinRuntime],
  );

  useEffect(() => {
    const peer = runtime.thinPeer;
    if (!peer) return;
    let ready = false;
    return peer.subscribe((peerSnapshot) => {
      const nextReady =
        peerSnapshot.status === "authorized" ||
        peerSnapshot.status === "fallback-http";
      if (nextReady && !ready) {
        setThinPeerReadyRevision((revision) => revision + 1);
      }
      ready = nextReady;
    });
  }, [runtime]);

  useEffect(() => {
    let cancelled = false;
    const reportStage = (stage: AuroraOwlLoaderStageId) => {
      if (cancelled) return;
      setLoadingStage(stage);
      setLoadingProgressPct(null);
      setLoadingDetail(null);
    };
    const reportProgress = (progressPct: number, detail: string) => {
      if (cancelled) return;
      setLoadingProgressPct(progressPct);
      setLoadingDetail(detail);
    };
    async function load() {
      let readySidecar: TauriSidecarStatus | null = null;
      let modelsPhaseActive = false;
      try {
        if (runtime.requiresOnboarding) {
          setSnapshot({
            ...loadingShellSnapshot,
            loadState: "ready",
            nodeName: "Aurora thin client",
            transportKind: runtime.client.transport.kind,
            evidenceSource:
              "runtime profile required before network requests are enabled",
          });
          reportStage("ready");
          return;
        }
        reportStage("core");
        readySidecar = await runRuntimeReadinessProbes(
          runtime,
          reportStage,
          reportProgress,
        );
        reportStage("models");
        const modelsTotal = 16;
        let modelsCompleted = 0;
        modelsPhaseActive = true;
        const trackModelsProgress = <T,>(promise: Promise<T>): Promise<T> =>
          promise.finally(() => {
            modelsCompleted += 1;
          });
        void pollRegistryServices(
          runtime,
          () => modelsPhaseActive && !cancelled,
          (detail) =>
            reportProgress(
              modelsProgressPct(modelsCompleted, modelsTotal),
              detail,
            ),
        );
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
          androidForegroundStatus,
          androidMediaPolicyStatus,
        ] = await Promise.all([
          trackModelsProgress(
            buildRuntimeShellSnapshot(
              runtime.client,
              runtime.mode === "desktop-local",
            ),
          ),
          trackModelsProgress(
            readySidecar
              ? Promise.resolve(readySidecar)
              : runtime.sidecarStatus().catch(() => null),
          ),
          trackModelsProgress(
            runtime.nativePermissionStatus().catch(() => null),
          ),
          trackModelsProgress(runtime.trayStatus().catch(() => null)),
          trackModelsProgress(runtime.notificationStatus().catch(() => null)),
          trackModelsProgress(runtime.iosVoiceStatus().catch(() => null)),
          trackModelsProgress(runtime.iosInvocationStatus().catch(() => null)),
          trackModelsProgress(
            runtime.iosLocalLightInferenceStatus().catch(() => null),
          ),
          trackModelsProgress(runtime.iosBackgroundStatus().catch(() => null)),
          trackModelsProgress(runtime.dialogStatus().catch(() => null)),
          trackModelsProgress(runtime.audioBridgeStatus().catch(() => null)),
          trackModelsProgress(
            runtime.iosSecureStorageStatus().catch(() => null),
          ),
          trackModelsProgress(runtime.iosBiometricStatus().catch(() => null)),
          trackModelsProgress(
            runtime.androidBaselineStatus().catch(() => null),
          ),
          trackModelsProgress(
            runtime.androidForegroundStatus().catch(() => null),
          ),
          trackModelsProgress(
            runtime.androidMediaPolicyStatus().catch(() => null),
          ),
        ]);
        modelsPhaseActive = false;
        reportStage("assistant");
        await runtime.client.authApi.whoAmI().catch(() => null);
        if (!cancelled) {
          reportStage("workspace");
          setSnapshot((current) =>
            retainThinShellSnapshot(
              current,
              nextSnapshot,
              runtime.thinPeer?.snapshot(),
            ),
          );
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
          setAndroidForeground(androidForegroundStatus);
          setAndroidMediaPolicy(androidMediaPolicyStatus);
          reportStage("ready");
        }
      } catch (error) {
        modelsPhaseActive = false;
        if (!cancelled) {
          setSnapshot((current) =>
            retainThinShellSnapshot(
              current,
              errorShellSnapshot(runtime.client.transport.kind, error),
              runtime.thinPeer?.snapshot(),
            ),
          );
          setSidecar(readySidecar);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [runtime, thinPeerReadyRevision]);

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

  // aurora://mesh/invite deep links (cold start and while running) land on the mesh page with
  // the invite in the URL fragment only; the nonce forces a re-render so an already-mounted
  // mesh page remounts its resource and the fragment scrubber picks the invite up.
  const [, setDeepLinkNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    initMeshDeepLinks((inviteUrl) => {
      if (typeof window === "undefined") return;
      window.history.pushState(
        {},
        "",
        `/mesh#invite=${encodeURIComponent(inviteUrl)}`,
      );
      navigate("/mesh");
      setDeepLinkNonce((nonce) => nonce + 1);
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch((error) => console.warn("aurora deep-link init failed", error));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [navigate]);

  const localMode = runtime.mode === "desktop-local";
  const sidecarEvidence = sidecar
    ? redactDiagnosticText(
        `${sidecar.mode ?? "unknown"}; gateway=${sidecar.gatewayUrl ?? "not configured"}; running=${String(sidecar.running)}`,
      )
    : "native sidecar status unavailable in this runtime";
  const surfaceProfile = getAuroraSurfaceProfile({
    runtimeMode: runtime.mode,
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent:
      typeof window === "undefined" ? undefined : window.navigator.userAgent,
  });
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
    androidForeground,
    androidMediaPolicy,
    surfaceProfile,
    thinConnectionMode: runtime.thinConnectionMode,
    thinPeer: runtime.thinPeer,
    thinDiagnostics: runtime.thinDiagnostics,
    thinProfile: runtime.thinProfile,
    thinProfileController: runtime.thinProfileController,
    saveThinProfile,
    selectThinProfile,
  };

  if (!profileBootstrapReady) {
    return (
      <AuroraOwlLoader
        owlSrc={owlSrc}
        stageId="boot"
        progressPct={null}
        detail="Loading the device connection profile"
      />
    );
  }

  if (
    runtime.requiresOnboarding &&
    runtime.thinPeer &&
    runtime.thinProfileController
  ) {
    return (
      <OnboardingView
        client={runtime.client}
        snapshot={snapshot}
        modePreferenceStore={runtime.modePreferenceStore}
        setupRequired
        thinConnectionPanel={
          <WebThinConnectionPanel
            peer={runtime.thinPeer}
            mode={runtime.thinConnectionMode}
            transportKind={runtime.client.transport.kind}
            nativePlatform={snapshot.nativePlatform}
            initialInviteText={
              runtime.pendingThinInviteText ?? initialThinInviteFromUrl()
            }
            profile={runtime.thinProfile}
            profiles={runtime.thinProfileController.document.profiles}
            profileStoreEvidence={runtime.thinProfileController.evidence}
            onSaveProfile={async (profile, roomSecret) => {
              await saveThinProfile(profile, roomSecret);
              navigate("/mesh");
            }}
            onSelectProfile={selectThinProfile}
            configureOnly
            {...(isMobileTauriShell() ? { onScanQr: scanMeshInviteQr } : {})}
          />
        }
      />
    );
  }

  if (snapshot.loadState === "loading") {
    return (
      <AuroraOwlLoader
        owlSrc={owlSrc}
        stageId={loadingStage}
        progressPct={loadingProgressPct}
        detail={loadingDetail}
      />
    );
  }

  return (
    <AppShell
      snapshot={snapshot}
      currentPath={currentPath}
      onNavigate={navigate}
      sessionIsAdmin={runtime.client.auth.snapshot().isAdmin}
      runtimeMode={runtime.mode}
    >
      <TauriRouteContent
        path={currentPath}
        snapshot={snapshot}
        nativeContext={nativeContext}
        client={runtime.client}
        modePreferenceStore={runtime.modePreferenceStore}
        shutdown={runtime.shutdown}
      />
    </AppShell>
  );
}

async function runRuntimeReadinessProbes(
  runtime: AuroraTauriRuntime,
  reportStage: (stage: AuroraOwlLoaderStageId) => void,
  reportProgress: (progressPct: number, detail: string) => void,
): Promise<TauriSidecarStatus | null> {
  if (runtime.mode !== "desktop-local") {
    reportStage("mesh");
    return null;
  }

  const startedSidecar = await runtime.startSidecar();
  const statusSidecar = await runtime.sidecarStatus();
  const readySidecar = statusSidecar ?? startedSidecar;
  if (!readySidecar) {
    throw new Error(
      "Tauri local sidecar status command did not return readiness status",
    );
  }
  assertReadySidecar(readySidecar);
  reportProgress(CORE_PROGRESS_PCT, sidecarStartupDetail(readySidecar));

  reportStage("mesh");
  return waitForGatewayReadiness(runtime, readySidecar, reportProgress);
}

function sidecarStartupDetail(sidecar: TauriSidecarStatus): string {
  const parts = [`sidecar ${sidecar.mode ?? "process"}`];
  if (sidecar.pid) parts.push(`pid ${sidecar.pid}`);
  return parts.join(" · ");
}

function assertReadySidecar(sidecar: TauriSidecarStatus): void {
  if (sidecar.running && !sidecar.lastError) return;
  throw new Error(
    `Tauri local sidecar is not ready: ${sidecar.lastError ?? "sidecar status command reported not running"}`,
  );
}

async function probeGatewayReadiness(client: AuroraClient): Promise<void> {
  await client.request<Record<string, unknown>>(
    GATEWAY_METHODS.health,
    undefined,
    {
      path: "/api/health",
      httpMethod: "GET",
      timeoutMs: 5_000,
    },
  );
  await client.registry.getRegistry();
  await client.registry.listServices();
  const sessions = await client.memory.listSessions({ type: "chat", limit: 1 });
  if (!sessions.ok) throw sessions.error;
}

async function waitForGatewayReadiness(
  runtime: AuroraTauriRuntime,
  initialSidecar: TauriSidecarStatus,
  reportProgress: (progressPct: number, detail: string) => void,
): Promise<TauriSidecarStatus> {
  let latestSidecar = initialSidecar;
  let lastError: unknown = null;
  const startedAt = Date.now();
  const deadline = startedAt + DESKTOP_LOCAL_GATEWAY_READY_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt += 1;
    const elapsedMs = Date.now() - startedAt;
    reportProgress(
      meshProgressPct(elapsedMs),
      meshAttemptDetail(attempt, elapsedMs, latestSidecar, lastError),
    );
    try {
      await probeGatewayReadiness(runtime.client);
      return latestSidecar;
    } catch (error) {
      lastError = error;
      latestSidecar =
        (await runtime.sidecarStatus().catch(() => latestSidecar)) ??
        latestSidecar;
      assertReadySidecar(latestSidecar);
      await delay(DESKTOP_LOCAL_GATEWAY_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Tauri local Gateway did not become ready within ${DESKTOP_LOCAL_GATEWAY_READY_TIMEOUT_MS}ms. Last probe error: ${readinessErrorMessage(lastError)}`,
  );
}

const CORE_PROGRESS_PCT = AURORA_OWL_LOADER_STAGES.find(
  (stage) => stage.id === "core",
)!.progress;
const MESH_PROGRESS_FLOOR_PCT = CORE_PROGRESS_PCT;
const MESH_PROGRESS_CEILING_PCT = AURORA_OWL_LOADER_STAGES.find(
  (stage) => stage.id === "mesh",
)!.progress;
const MODELS_PROGRESS_FLOOR_PCT = MESH_PROGRESS_CEILING_PCT;
const MODELS_PROGRESS_CEILING_PCT = AURORA_OWL_LOADER_STAGES.find(
  (stage) => stage.id === "models",
)!.progress;

function meshProgressPct(elapsedMs: number): number {
  const elapsedRatio = Math.min(
    1,
    elapsedMs / DESKTOP_LOCAL_GATEWAY_READY_TIMEOUT_MS,
  );
  return (
    MESH_PROGRESS_FLOOR_PCT +
    Math.round(
      elapsedRatio * (MESH_PROGRESS_CEILING_PCT - MESH_PROGRESS_FLOOR_PCT),
    )
  );
}

function meshAttemptDetail(
  attempt: number,
  elapsedMs: number,
  sidecar: TauriSidecarStatus,
  lastError: unknown,
): string {
  const elapsedS = Math.round(elapsedMs / 1000);
  const parts = [
    `attempt ${attempt}`,
    `${elapsedS}s elapsed`,
    `gateway ${sidecar.gatewayUrl ?? "pending"}`,
  ];
  if (lastError) parts.push(readinessErrorMessage(lastError));
  return parts.join(" · ");
}

function modelsProgressPct(completed: number, total: number): number {
  const ratio = total > 0 ? Math.min(1, completed / total) : 1;
  return (
    MODELS_PROGRESS_FLOOR_PCT +
    Math.round(
      ratio * (MODELS_PROGRESS_CEILING_PCT - MODELS_PROGRESS_FLOOR_PCT),
    )
  );
}

const REGISTRY_POLL_INTERVAL_MS = 400;

/**
 * Polls the real backend service registry (Gateway.GetServices) so the loader reflects
 * genuine backend services as they announce themselves, instead of a synthetic counter.
 */
async function pollRegistryServices(
  runtime: AuroraTauriRuntime,
  isActive: () => boolean,
  reportDetail: (detail: string) => void,
): Promise<void> {
  while (isActive()) {
    try {
      const { services } = await runtime.client.registry.listServices();
      if (isActive()) reportDetail(registryPollDetail(services));
    } catch {
      // Registry momentarily unreachable mid-poll; keep retrying until the phase ends.
    }
    await delay(REGISTRY_POLL_INTERVAL_MS);
  }
}

function registryPollDetail(services: ServiceInfo[]): string {
  if (services.length === 0) return "waiting for services to register…";
  const healthy = services.filter(
    (service) => service.status === "healthy",
  ).length;
  const names = services.map((service) => service.module).sort();
  const preview = names.slice(0, 4).join(", ");
  const overflow = names.length > 4 ? ` +${names.length - 4} more` : "";
  return `${healthy} / ${services.length} services healthy · ${preview}${overflow}`;
}

async function buildRuntimeShellSnapshot(
  client: AuroraClient,
  retryTransientError: boolean,
): Promise<AuroraShellSnapshot> {
  if (!retryTransientError) return buildShellSnapshot(client);

  let snapshot = await buildShellSnapshot(client);
  if (snapshot.loadState !== "error") return snapshot;

  const deadline = Date.now() + DESKTOP_LOCAL_SNAPSHOT_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    await delay(DESKTOP_LOCAL_GATEWAY_RETRY_DELAY_MS);
    snapshot = await buildShellSnapshot(client);
    if (snapshot.loadState !== "error") return snapshot;
  }
  return snapshot;
}

function readinessErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown Gateway readiness error";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NativeContext {
  runtimeMode: string;
  localMode: boolean;
  sidecar: TauriSidecarStatus | null;
  sidecarEvidence: string;
  surfaceProfile: ReturnType<typeof getAuroraSurfaceProfile>;
  thinConnectionMode: ReturnType<
    typeof createAuroraTauriRuntime
  >["thinConnectionMode"];
  thinPeer?: ReturnType<typeof createAuroraTauriRuntime>["thinPeer"];
  thinDiagnostics: ReturnType<
    typeof createAuroraTauriRuntime
  >["thinDiagnostics"];
  thinProfile?: AuroraThinConnectionProfile | undefined;
  thinProfileController?: AuroraTauriRuntime["thinProfileController"];
  saveThinProfile: (
    profile: AuroraThinConnectionProfile,
    roomSecret?: WebThinRoomSecret,
  ) => Promise<void>;
  selectThinProfile: (profileId: string) => Promise<void>;
  nativePermissions: TauriNativePermissionStatus | null;
  nativeFeatures: Record<string, TauriNativeFeatureStatus | null>;
  iosInvocationStatus: TauriIosInvocationStatus | null;
  iosLocalLightStatus: AndroidLocalLightInferenceStatus | null;
  androidBaseline: TauriAndroidBaselineStatus | null;
  androidForeground: AndroidForegroundRuntimeStatus | null;
  androidMediaPolicy: AndroidMediaPolicyStatus | null;
}

function TauriRouteContent({
  path,
  snapshot,
  nativeContext,
  client,
  modePreferenceStore,
  shutdown,
}: {
  path: string;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: ReturnType<typeof createAuroraTauriRuntime>["client"];
  modePreferenceStore?: OnboardingModePreferenceStore | undefined;
  shutdown: () => Promise<void>;
}) {
  const route = routeForPath(snapshot, path);
  const renderRoute = routeRendererFor(route.item.id);
  const assistantNativePermissions = useMemo(
    () =>
      snapshot.nativePermissions.map((permission) => ({
        name: permission.name,
        granted: permission.granted,
      })),
    [snapshot.nativePermissions],
  );
  const assistantNativeCapabilities = useMemo(
    () =>
      snapshot.nativeCapabilities.map((capability) => ({
        name: capability.name,
        enabled: capability.enabled,
      })),
    [snapshot.nativeCapabilities],
  );
  if (!renderRoute) return <MissingTauriRoute route={route} />;
  return renderRoute({
    route,
    snapshot,
    nativeContext,
    client,
    shutdown,
    modePreferenceStore,
    assistantNativePermissions,
    assistantNativeCapabilities,
  });
}

function TauriNativeSettingsPage({
  snapshot,
  nativeContext,
}: {
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
}) {
  const rows = nativeCommandRows(nativeContext);
  const showDesktopCommands = shouldShowForSurface(
    nativeContext.surfaceProfile,
    "desktopCommands",
  );
  return (
    <div className="ata-page-stack">
      <SettingsPermissionsView
        snapshot={snapshot}
        surface="native"
        currentPath="/settings/native"
      />
      {showDesktopCommands ? (
        <section
          className="ata-panel"
          aria-labelledby="tauri-native-command-title"
        >
          <h2 id="tauri-native-command-title">Desktop controls</h2>
          <p>
            Local desktop controls are shown only when Aurora is running inside
            the Tauri desktop shell with the local sidecar enabled.
          </p>
          <dl className="ata-facts">
            {rows.map((row) => (
              <div key={row.command}>
                <dt>{row.label}</dt>
                <dd>
                  <code>{row.command}</code> · {row.status} · {row.source}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <section
          className="ata-panel"
          aria-labelledby="tauri-native-thin-title"
        >
          <h2 id="tauri-native-thin-title">Native controls</h2>
          <p>
            {nativeContext.surfaceProfile.label} uses remote or platform-managed
            capabilities. Local desktop sidecar controls are hidden on this
            surface.
          </p>
        </section>
      )}
    </div>
  );
}

function routeRendererFor(routeId: string): TauriRouteRenderer | undefined {
  return isTauriRouteId(routeId) ? tauriRouteRegistry[routeId] : undefined;
}

function isTauriRouteId(routeId: string): routeId is TauriRouteId {
  return tauriRouteIdSet.has(routeId);
}

function TauriAdminOverviewPage({
  route,
  snapshot,
  nativeContext,
  client,
  shutdown,
}: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
  shutdown: () => Promise<void>;
}) {
  const [manifest, setManifest] = useState<AdminOverviewManifest | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    client.adminOverview.getManifest().then(
      (next) => {
        if (!cancelled) {
          setManifest(next);
          setError(null);
        }
      },
      (nextError: unknown) => {
        if (!cancelled) {
          setManifest(null);
          setError(nextError);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const [activeTab, setActiveTab] = useState<"overview" | "diagnostics">(
    "overview",
  );
  const diagnosticsRoute = embeddedRoute("diagnostics", snapshot) ?? route;
  return (
    <div className="ata-page-stack">
      <div
        className="aui-tab-list"
        role="tablist"
        aria-label="Admin overview sections"
      >
        <button
          type="button"
          id="admin-overview-tab-overview"
          role="tab"
          aria-selected={activeTab === "overview"}
          aria-controls="admin-overview-panel-overview"
          data-active={activeTab === "overview"}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          id="admin-overview-tab-diagnostics"
          role="tab"
          aria-selected={activeTab === "diagnostics"}
          aria-controls="admin-overview-panel-diagnostics"
          data-active={activeTab === "diagnostics"}
          onClick={() => setActiveTab("diagnostics")}
        >
          Diagnostics
        </button>
      </div>
      <section
        id="admin-overview-panel-overview"
        role="tabpanel"
        aria-labelledby="admin-overview-tab-overview"
        hidden={activeTab !== "overview"}
        className="aui-tab-panel"
      >
        <AdminOverviewContent
          manifest={manifest}
          transportKind={client.transport.kind}
          error={error}
        />
      </section>
      <section
        id="admin-overview-panel-diagnostics"
        role="tabpanel"
        aria-labelledby="admin-overview-tab-diagnostics"
        hidden={activeTab !== "diagnostics"}
        className="aui-tab-panel"
      >
        <TauriDiagnosticsPage
          route={diagnosticsRoute}
          snapshot={snapshot}
          nativeContext={nativeContext}
          client={client}
          shutdown={shutdown}
        />
      </section>
    </div>
  );
}

function TauriSettingsPage({
  route,
  snapshot,
  nativeContext,
  client,
}: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
}) {
  const configRoute = embeddedRoute("config", snapshot) ?? route;
  const dataRoute = embeddedRoute("data", snapshot) ?? route;
  const [activeTab, setActiveTab] = useState<
    "general" | "configuration" | "advanced"
  >("general");
  return (
    <div className="ata-page-stack">
      <PageHeader
        id="tauri-settings-title"
        eyebrow="Settings"
        title="Settings"
        description="General permissions, schema-backed configuration, and advanced data-policy controls are grouped on one Settings page."
        badges={
          <>
            <EvidenceBadge label={snapshot.evidenceSource} />
            <EvidenceBadge
              label={
                snapshot.secretsRedacted
                  ? "secrets protected"
                  : "redaction pending"
              }
            />
            <EvidenceBadge label={nativeContext.surfaceProfile.label} />
          </>
        }
      />
      <p className="aui-muted">
        Settings includes Data policy and retention plus Native platform
        settings in the Advanced section.
      </p>
      <div
        className="aui-tab-list"
        role="tablist"
        aria-label="Settings sections"
      >
        <button
          type="button"
          id="settings-tab-general"
          role="tab"
          aria-selected={activeTab === "general"}
          aria-controls="settings-panel-general"
          data-active={activeTab === "general"}
          onClick={() => setActiveTab("general")}
        >
          General
        </button>
        <button
          type="button"
          id="settings-tab-configuration"
          role="tab"
          aria-selected={activeTab === "configuration"}
          aria-controls="settings-panel-configuration"
          data-active={activeTab === "configuration"}
          onClick={() => setActiveTab("configuration")}
        >
          Configuration
        </button>
        <button
          type="button"
          id="settings-tab-advanced"
          role="tab"
          aria-selected={activeTab === "advanced"}
          aria-controls="settings-panel-advanced"
          data-active={activeTab === "advanced"}
          onClick={() => setActiveTab("advanced")}
        >
          Advanced
        </button>
      </div>
      <section
        id="settings-panel-general"
        role="tabpanel"
        aria-labelledby="settings-tab-general"
        hidden={activeTab !== "general"}
        className="aui-tab-panel"
      >
        <SettingsPermissionsView
          snapshot={snapshot}
          surface="settings"
          currentPath="/settings"
          hideTabs
        />
      </section>
      <section
        id="settings-panel-configuration"
        role="tabpanel"
        aria-labelledby="settings-tab-configuration"
        hidden={activeTab !== "configuration"}
        className="aui-tab-panel"
      >
        <ConfigEditorView client={client} route={configRoute} />
      </section>
      <section
        id="settings-panel-advanced"
        role="tabpanel"
        aria-labelledby="settings-tab-advanced"
        hidden={activeTab !== "advanced"}
        className="aui-tab-panel"
      >
        <div className="ata-page-stack">
          <DataPolicyResource client={client} route={dataRoute} />
          <TauriNativeSettingsPage
            snapshot={snapshot}
            nativeContext={nativeContext}
          />
        </div>
      </section>
    </div>
  );
}

function embeddedRoute(
  id: string,
  snapshot: AuroraShellSnapshot,
): RouteAvailability | null {
  const existing = snapshot.routes.find((route) => route.item.id === id);
  if (existing) return existing;
  const item = getAuroraNavItem(id);
  if (!item) return null;
  return {
    item: navItemSnapshot(item),
    state: unavailableFallbackState(item),
    explanation:
      "Embedded route state is unavailable until the backend snapshot reports this capability.",
    providerLabel: "embedded route unavailable",
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ["embedded route fallback"],
    selectorRequired: false,
    approvalRequired: item.adminGated ?? false,
    routeable: false,
    disabled: true,
    requiresAdminAction: item.adminGated ?? false,
  };
}

function TauriDiagnosticsPage({
  route,
  snapshot,
  nativeContext,
  client,
  shutdown,
}: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
  shutdown: () => Promise<void>;
}) {
  return (
    <div className="ata-page-stack">
      {nativeContext.thinPeer ? (
        <WebThinConnectionPanel
          peer={nativeContext.thinPeer}
          mode={nativeContext.thinConnectionMode}
          transportKind={client.transport.kind}
          nativePlatform={snapshot.nativePlatform}
          initialInviteText={initialThinInviteFromUrl()}
          profile={nativeContext.thinProfile}
          profiles={nativeContext.thinProfileController?.document.profiles}
          profileStoreEvidence={nativeContext.thinProfileController?.evidence}
          {...(nativeContext.thinProfileController
            ? {
                onSaveProfile: nativeContext.saveThinProfile,
                onSelectProfile: nativeContext.selectThinProfile,
              }
            : {})}
        />
      ) : null}
      <StateSurface
        title={
          nativeContext.localMode
            ? "Desktop local shell"
            : thinShellTitle(nativeContext)
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
        description="Aurora desktop uses the official Tauri shell while keeping service state behind the Gateway boundary."
        evidence={
          shouldShowForSurface(nativeContext.surfaceProfile, "sidecar")
            ? nativeContext.sidecarEvidence
            : null
        }
        actionLabel={
          redactDiagnosticText(nativeContext.sidecar?.lastError) || null
        }
      />
      <section className="ata-panel">
        <h2>Native boundary</h2>
        <dl className="ata-facts">
          <div>
            <dt>Runtime mode</dt>
            <dd>{runtimeModeLabel(nativeContext.runtimeMode)}</dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>
              {transportKindLabel(
                snapshot.transportKind,
                nativeContext.runtimeMode,
              )}
            </dd>
          </div>
          {shouldShowForSurface(nativeContext.surfaceProfile, "webrtcThin") ? (
            <>
              <div>
                <dt>Thin connection mode</dt>
                <dd>{nativeContext.thinConnectionMode}</dd>
              </div>
              <div>
                <dt>Thin peer status</dt>
                <dd>
                  {nativeContext.thinPeer?.snapshot().status ??
                    "not configured"}
                </dd>
              </div>
              <div>
                <dt>Thin secrets</dt>
                <dd>
                  {nativeContext.thinPeer?.snapshot().secretsPersisted === false
                    ? "memory-only"
                    : "none persisted by this shell"}
                </dd>
              </div>
              <div>
                <dt>Thin diagnostics</dt>
                <dd>{nativeContext.thinDiagnostics().join(" · ")}</dd>
              </div>
            </>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "sidecar") ? (
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
          ) : null}
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
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>iOS microphone capture</dt>
              <dd>
                {nativeFeatureLabel(nativeContext.nativeFeatures.iosVoice)}
              </dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>iOS background voice</dt>
              <dd>
                {nativeFeatureLabel(nativeContext.nativeFeatures.iosBackground)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Dialogs</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.dialogs)}</dd>
          </div>
          <div>
            <dt>Audio bridge</dt>
            <dd>{nativeFeatureLabel(nativeContext.nativeFeatures.audio)}</dd>
          </div>
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>iOS Keychain</dt>
              <dd>
                {nativeFeatureLabel(nativeContext.nativeFeatures.iosKeychain)}
              </dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>Face ID / Touch ID</dt>
              <dd>
                {nativeFeatureLabel(nativeContext.nativeFeatures.iosBiometrics)}
              </dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>iOS invocation</dt>
              <dd>{iosInvocationLabel(nativeContext.iosInvocationStatus)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>iOS local-light inference</dt>
              <dd>
                {localLightInferenceLabel(nativeContext.iosLocalLightStatus)}
              </dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Android baseline</dt>
              <dd>{androidBaselineLabel(nativeContext.androidBaseline)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Assistant role</dt>
              <dd>{assistantRoleProbeLabel(nativeContext.androidBaseline)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Android foreground</dt>
              <dd>{androidForegroundLabel(nativeContext.androidForeground)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Android media policy</dt>
              <dd>{androidMediaPolicyLabel(nativeContext.androidMediaPolicy)}</dd>
            </div>
          ) : null}
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
      <MeshDiagnosticsResource
        client={client}
        route={route}
        thinPeer={nativeContext.thinPeer}
      />
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
        evidence={null}
        actionLabel="Route registry repair required"
      />
      <section className="ata-panel">
        <h2>{route.item.label} route is unregistered</h2>
        <dl className="ata-facts">
          <div>
            <dt>Privacy class</dt>
            <dd>{route.item.privacyClass}</dd>
          </div>
          <div>
            <dt>Routeable</dt>
            <dd>{route.routeable ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt>Route id</dt>
            <dd>{route.item.id}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function routeForPath(
  snapshot: AuroraShellSnapshot,
  path: string,
): RouteAvailability {
  const normalized = normalizePath(path);
  const item = itemForPath(normalized) ?? navItems[0]!;
  const existing = snapshot.routes.find((route) => route.item.id === item.id);
  if (!existing) return fallbackRoute(item);
  if (existing.disabled && existing.evidenceSources.length === 0) {
    return { ...existing, evidenceSources: ["pending SDK request"] };
  }
  return existing;
}

function itemForPath(path: string): AuroraNavItem | undefined {
  const normalized = normalizePath(path);
  return routePathItems.find((item) => normalizePath(item.href) === normalized);
}

function fallbackRoute(item: AuroraNavItem): RouteAvailability {
  return {
    item: navItemSnapshot(item),
    state: unavailableFallbackState(item),
    explanation: "Capability state is loading.",
    providerLabel: "pending",
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

function unavailableFallbackState(
  item: AuroraNavItem,
): RouteAvailability["state"] {
  return ["available-local", "available-remote", "degraded"].includes(
    item.fallbackState,
  )
    ? "pending"
    : item.fallbackState;
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

function nativeCommandRows(
  nativeContext: NativeContext,
): Array<{ label: string; command: string; status: string; source: string }> {
  return [
    {
      label: "Native permissions",
      command: "aurora_native_permission_status",
      status: nativeContext.nativePermissions
        ? `${nativeContext.nativePermissions.platform}; denied=${nativeContext.nativePermissions.deniedByDefault.length}`
        : "not available",
      source:
        nativeContext.nativePermissions?.evidenceSource ??
        commandUnavailableSource(nativeContext),
    },
    nativeFeatureRow(
      "Tray",
      "aurora_tray_status",
      nativeContext.nativeFeatures.tray,
      nativeContext,
    ),
    nativeFeatureRow(
      "Notifications",
      "aurora_notification_status",
      nativeContext.nativeFeatures.notifications,
      nativeContext,
    ),
    nativeFeatureRow(
      "Dialogs",
      "aurora_dialog_status",
      nativeContext.nativeFeatures.dialogs,
      nativeContext,
    ),
    nativeFeatureRow(
      "Audio bridge",
      "aurora_audio_bridge_status",
      nativeContext.nativeFeatures.audio,
      nativeContext,
    ),
    {
      label: "Sidecar",
      command: "aurora_sidecar_status",
      status: nativeContext.sidecar
        ? `running=${String(nativeContext.sidecar.running)}; mode=${nativeContext.sidecar.mode ?? "unknown"}`
        : "not available",
      source: nativeContext.sidecar
        ? "aurora-sidecar-status"
        : commandUnavailableSource(nativeContext),
    },
  ];
}


function androidForegroundLabel(status: AndroidForegroundRuntimeStatus | null): string {
  if (!status) return "native command unavailable; WebView visibility fallback pending";
  const state = status.foreground && status.visible && status.focused ? "focused foreground" : "not focused foreground";
  return `${state}; ${status.source}${status.reason ? `; ${status.reason}` : ""}`;
}

function androidMediaPolicyLabel(status: AndroidMediaPolicyStatus | null): string {
  if (!status) return "focused foreground WebView mic only; no durable background wakeword";
  return `foreground mic=${String(status.microphoneAllowedInForeground)}; background wakeword=false; ${status.source}${status.reason ? `; ${status.reason}` : ""}`;
}

function nativeFeatureRow(
  label: string,
  command: string,
  feature: TauriNativeFeatureStatus | null | undefined,
  nativeContext: NativeContext,
): { label: string; command: string; status: string; source: string } {
  return {
    label,
    command,
    status: nativeFeatureLabel(feature),
    source: feature?.source ?? commandUnavailableSource(nativeContext),
  };
}

function commandUnavailableSource(nativeContext: NativeContext): string {
  return nativeContext.localMode
    ? "Tauri command unavailable"
    : "not used on this surface";
}

function thinShellTitle(nativeContext: NativeContext): string {
  const prefix = nativeContext.surfaceProfile.isAndroid ? "Android thin" : "Desktop thin";
  if (nativeContext.thinConnectionMode === "http-only")
    return `${prefix} shell`;
  return `${prefix} ${nativeContext.thinConnectionMode} shell`;
}

function initialThinInviteFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  const invite = hashParams.get("invite");
  if (!invite) return null;
  hashParams.delete("invite");
  const nextHash = hashParams.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
  );
  return invite;
}


function runtimeModeLabel(mode: string): string {
  if (mode === "mock") return "Local mode";
  if (mode === "desktop-local")
    return "desktop-local (Tauri sidecar supervised local stack)";
  if (mode === "desktop-thin")
    return "desktop-thin (remote Gateway, no local sidecar)";
  return mode;
}

function transportKindLabel(
  transportKind: string,
  runtimeMode: string,
): string {
  if (runtimeMode === "mock") return "Local mode";
  if (transportKind === "pending" && runtimeMode === "desktop-local")
    return "tauri (pending local Gateway readiness)";
  if (transportKind === "pending" && runtimeMode === "desktop-thin")
    return "http (pending remote Gateway readiness)";
  return transportKind;
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
  if (!status) return "local-light inference provider pending native support.";
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
  if (error instanceof Error) return error.message;
  return String(error);
}
