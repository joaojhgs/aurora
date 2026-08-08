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
  Button,
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
  LocalServiceRoutingResource,
  ServiceRoutingResource,
  SettingsPermissionsView,
  StateSurface,
  LightweightToolApprovalPanel,
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
  retainThinShellSnapshot,
  type AuroraNavItem,
  type AuroraOwlLoaderStageId,
  type AuroraShellSnapshot,
  type RouteAvailability,
  type WebThinRoomSecret,
} from "@aurora/ui";
import {
  type LightweightAssistantDependencies,
} from "@aurora/ui/local-assistant";
import {
  LocalDataProvider,
  type LocalDataBackendFactory,
} from "@aurora/ui/local-data";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@aurora/ui/components/ui/alert-dialog";
import owlSrc from "./assets/aurora-owl.png";
import { GATEWAY_METHODS } from "@aurora/client";
import {
  createLightweightToolClientAdapter,
  createOnDeviceLightweightToolPolicy,
  mergeLightweightAssistantTools,
  onDeviceAssistantPermissions,
  type LightweightToolClientDelegate,
  type LightweightToolExecutionResponse,
} from "@aurora/client/lightweight-orchestrator";
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
  ToolApprovalConfirmRequest,
  ToolApprovalConfirmResponse,
  ToolApprovalRequestResponse,
  ToolingProjectionToolInfo,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
} from "@aurora/client";
import type {
  LocalDataBackend,
  LocalDataBackendStatus,
} from "@aurora/client/local-data";
import type {
  ProviderLocalApprovalControllerPort,
  ProviderLocalApprovalRequest,
  ProviderLocalApprovalSnapshot,
} from "@aurora/client/local-tools";
import {
  bootstrapAuroraTauriRuntime,
  createAuroraTauriRuntime,
  createInitialAuroraTauriRuntime,
  loadTauriRemoteAssistantTools,
  requiresAsyncAuroraTauriBootstrap,
  type AndroidForegroundRuntimeStatus,
  type AndroidMediaPolicyStatus,
  type AuroraTauriRuntime as AuroraTauriRuntimeModel,
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
export type AuroraTauriRuntime = AuroraTauriRuntimeModel;
type AuroraTauriClient = AuroraTauriRuntime["client"];
type TauriRouteRenderer = (input: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
  shutdown: () => Promise<void>;
  modePreferenceStore?: OnboardingModePreferenceStore | undefined;
  applyModePreference?: (() => Promise<void>) | undefined;
  navigate: (href: string) => void;
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
      surfaceProfile={nativeContext.surfaceProfile}
      executionHost={nativeContext.thinPeer ? "connected-device" : "this-device"}
      localAssistant={tauriLocalAssistant(nativeContext, client)}
      nativeVoice={nativeContext.nativeVoice}
      nativeMobileVoice={nativeContext.nativeMobileVoice}
      runtimeHealth={{
        selectedModel: null,
        routeLabel: nativeContext.thinPeer
          ? "Connected Aurora device"
          : routeAvailabilityLabel(route),
        sidecarHealth: nativeContext.sidecar?.running
          ? "Ready"
          : nativeContext.localMode
            ? "Starting Aurora on this computer"
            : "Not needed for this connection",
        gatewayHealth: nativeContext.sidecar?.gatewayUrl
          ? "Connected on this computer"
          : transportKindLabel(
              snapshot.transportKind,
              nativeContext.runtimeMode,
            ),
      }}
    />
  ),
  memory: ({ route, nativeContext, client }) => (
    <TauriMemoryPage
      route={route}
      nativeContext={nativeContext}
      client={client}
    />
  ),
  tools: ({ route, snapshot, nativeContext, client }) => {
    const localProvider = nativeContext.localToolProvider;
    const localSharing = nativeContext.localFeatureSharing;
    if (nativeContext.surfaceProfile.ownsLocalNodeState) {
      return (
        <LightweightToolApprovalPanel
          client={client}
          route={route}
          localTools={localProvider?.localToolRegistry.publicTools() ?? []}
          remoteTools={nativeContext.remoteTools ?? []}
          nativePlatform={snapshot.nativePlatform}
          {...(localSharing ? { featureSharing: localSharing } : {})}
        />
      );
    }
    return (
      <div className="ata-page-stack">
        <p className="text-xs font-medium text-muted-foreground">Sources</p>
        <ToolApprovalPanel
          client={client}
          route={route}
          nativePlatform={snapshot.nativePlatform}
        />
      </div>
    );
  },
  mesh: ({ route, nativeContext, client }) => {
    const inviteParam = initialThinInviteFromUrl();
    const providerStatus = nativeContext.localNodeProviderStatus;
    const localNode = localMeshNodeIdentity(nativeContext);
    return (
      <div
        className="ata-page-stack"
        data-local-node-provider={
          providerStatus?.available
            ? "available"
            : nativeContext.nodeMode === "mesh-node"
              ? "unavailable"
              : "not-configured"
        }
        data-local-data-writable={String(providerStatus?.available === true)}
        data-local-feature-count={String(
          providerStatus?.registeredToolIds.length ?? 0,
        )}
      >
        {nativeContext.nodeMode === "mesh-node" &&
        providerStatus &&
        !providerStatus.available ? (
          <p className="text-sm text-muted-foreground" role="status">
            Services from this device are unavailable right now. Review this
            device&apos;s setup and try again.
          </p>
        ) : null}
        <MeshPeersResource
          key={inviteParam ?? "mesh-peers"}
          client={client}
          route={route}
          surfaceProfile={nativeContext.surfaceProfile}
          thinPeer={nativeContext.thinPeer}
          initialInviteText={inviteParam}
          localFeatureSharing={nativeContext.localFeatureSharing}
          localNode={localNode}
          {...(isMobileTauriShell() ? { onScanQr: scanMeshInviteQr } : {})}
        />
        {nativeContext.surfaceProfile.canManageLocalServiceConfiguration ? (
          <ServiceRoutingResource
            client={client}
            route={route}
            thinPeer={nativeContext.thinPeer}
          />
        ) : nativeContext.surfaceProfile.ownsLocalNodeState &&
          nativeContext.localFeatureSharing ? (
          <LocalServiceRoutingResource
            featureSharing={nativeContext.localFeatureSharing}
            client={client}
            route={route}
            thinPeer={nativeContext.thinPeer}
          />
        ) : null}
        {nativeContext.surfaceProfile.canManageLocalServiceConfiguration ||
        nativeContext.surfaceProfile.isRemoteConsole ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Device selection details
            </summary>
            <RoutePolicyResource client={client} route={route} />
          </details>
        ) : null}
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
  settings: ({ route, snapshot, nativeContext, client, navigate }) => (
    <TauriSettingsPage
      route={route}
      snapshot={snapshot}
      nativeContext={nativeContext}
      client={client}
      onChangeDeviceSetup={() => navigate("/onboarding")}
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
  onboarding: ({
    snapshot,
    client,
    modePreferenceStore,
    applyModePreference,
  }) => (
    <OnboardingView
      client={client}
      snapshot={snapshot}
      modePreferenceStore={modePreferenceStore}
      onApplyModePreference={applyModePreference}
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
  return await controller.createRuntime(document);
}

const DESKTOP_LOCAL_GATEWAY_READY_TIMEOUT_MS = 45_000;
const DESKTOP_LOCAL_GATEWAY_RETRY_DELAY_MS = 500;
const DESKTOP_LOCAL_SNAPSHOT_READY_TIMEOUT_MS = 10_000;
const NATIVE_MOBILE_VOICE_STATUS_POLL_MS = 2_000;

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
  const [assistantRemoteTools, setAssistantRemoteTools] = useState<
    readonly ToolingProjectionToolInfo[]
  >(() => initialRuntime.localAssistant?.remoteTools ?? []);
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
  const [nativeMobileVoiceAvailable, setNativeMobileVoiceAvailable] =
    useState(false);

  useEffect(() => {
    const nativeMobileVoice = runtime.nativeMobileVoice;
    setNativeMobileVoiceAvailable(false);
    if (!nativeMobileVoice) {
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        const status = await nativeMobileVoice.status();
        if (active) setNativeMobileVoiceAvailable(status.available);
      } catch {
        if (active) setNativeMobileVoiceAvailable(false);
      }
    };
    void refresh();
    const poll = window.setInterval(() => {
      void refresh();
    }, NATIVE_MOBILE_VOICE_STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [runtime.nativeMobileVoice]);

  useEffect(() => {
    if (runtimeOverride || !requiresAsyncAuroraTauriBootstrap()) return;
    let cancelled = false;
    // React StrictMode intentionally mounts, cleans up, and mounts effects
    // again in development. Deferring the side-effectful runtime bootstrap
    // lets the synthetic first cleanup cancel before it creates a second MQTT
    // signaling peer and native RTCPeerConnection.
    queueMicrotask(() => {
      if (cancelled) return;
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

  const applyModePreference = useCallback(async () => {
    if (!runtime.thinProfile || !runtime.thinProfileController) return;
    await rebuildThinRuntime((controller) =>
      controller.saveProfile(runtime.thinProfile!),
    );
  }, [rebuildThinRuntime, runtime.thinProfile, runtime.thinProfileController]);

  useEffect(() => {
    const peer = runtime.thinPeer;
    let cancelled = false;
    let refreshEpoch = 0;
    let ready = false;
    setAssistantRemoteTools(runtime.localAssistant?.remoteTools ?? []);

    const refreshRemoteTools = async () => {
      const epoch = ++refreshEpoch;
      const tools = await loadTauriRemoteAssistantTools(runtime);
      if (!cancelled && epoch === refreshEpoch) {
        setAssistantRemoteTools(tools);
      }
    };

    if (!peer) {
      if (runtime.nodeMode === "mesh-node" || runtime.localAssistant || runtime.localToolProvider) void refreshRemoteTools();
      return () => {
        cancelled = true;
        refreshEpoch += 1;
      };
    }

    const onPeerSnapshot = (peerSnapshot: ReturnType<typeof peer.snapshot>) => {
      const nextReady =
        peerSnapshot.status === "authorized" ||
        peerSnapshot.status === "fallback-http";
      if (nextReady && !ready) {
        ready = true;
        setThinPeerReadyRevision((revision) => revision + 1);
        if (runtime.nodeMode === "mesh-node" || runtime.localAssistant || runtime.localToolProvider) void refreshRemoteTools();
      } else if (!nextReady && ready) {
        ready = false;
        refreshEpoch += 1;
        setAssistantRemoteTools([]);
      }
    };
    const unsubscribe = peer.subscribe(onPeerSnapshot);
    onPeerSnapshot(peer.snapshot());
    return () => {
      cancelled = true;
      refreshEpoch += 1;
      unsubscribe();
    };
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
              runtime.nativeCapabilityManifest,
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
  const surfaceProfile = getAuroraSurfaceProfile({
    runtimeMode: runtime.mode,
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    nodeMode: runtime.nodeMode,
    runtimeTier: runtime.runtimeTier,
    nativeVoicePresent: runtime.nativeMobileVoice !== undefined,
    nativeVoiceAvailable: nativeMobileVoiceAvailable,
    userAgent:
      typeof window === "undefined" ? undefined : window.navigator.userAgent,
  });
  const nativeContext: NativeContext = {
    runtimeMode: runtime.mode,
    localMode,
    sidecar,
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
    thinFeatures: runtime.thinFeatures,
    nodeMode: runtime.nodeMode,
    localNodeProviderStatus: runtime.localNodeProviderStatus,
    localFeatureSharing: runtime.localFeatureSharing,
    localToolProvider: runtime.localToolProvider,
    localAssistant: runtime.localAssistant
      ? {
          ...runtime.localAssistant,
          remoteTools: assistantRemoteTools,
        }
      : undefined,
    remoteTools: assistantRemoteTools,
    runtimeProfile: runtime.runtimeProfile,
    localData: runtime.localData,
    nativeVoice: runtime.nativeVoice,
    nativeMobileVoice: runtime.nativeMobileVoice,
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
            localFeatureSharing={runtime.localFeatureSharing}
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
    <>
      <AppShell
        snapshot={snapshot}
        currentPath={currentPath}
        onNavigate={navigate}
        sessionIsAdmin={runtime.client.auth.snapshot().isAdmin}
        runtimeMode={runtime.mode}
        nodeMode={runtime.nodeMode}
        localNodeAvailable={runtime.localNodeProviderStatus?.available}
      >
        <TauriRouteContent
          path={currentPath}
          snapshot={snapshot}
          nativeContext={nativeContext}
          client={runtime.client}
          modePreferenceStore={runtime.modePreferenceStore}
          applyModePreference={applyModePreference}
          navigate={navigate}
          shutdown={runtime.shutdown}
        />
      </AppShell>
      <LocalFeatureApprovalPrompt controller={runtime.localToolApprovals} />
    </>
  );
}

const EMPTY_LOCAL_APPROVAL_SNAPSHOT: ProviderLocalApprovalSnapshot = {
  pending: [],
  revision: 0,
};

function LocalFeatureApprovalPrompt({
  controller,
}: {
  controller?: ProviderLocalApprovalControllerPort | undefined;
}) {
  const [snapshot, setSnapshot] = useState<ProviderLocalApprovalSnapshot>(() =>
    controller?.snapshot() ?? EMPTY_LOCAL_APPROVAL_SNAPSHOT,
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(EMPTY_LOCAL_APPROVAL_SNAPSHOT);
      return;
    }
    setSnapshot(controller.snapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  const request = snapshot.pending[0];
  if (!request || !controller) return null;

  return (
    <AlertDialog open>
      <AlertDialogContent
        className="ata-local-feature-approval"
        data-local-feature-approval="pending"
        size="sm"
      >
        <AlertDialogHeader>
          <p className="ata-local-feature-approval-kicker">Approval needed</p>
          <AlertDialogTitle>Allow {request.toolDisplayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            A connected Aurora device wants to use this feature on your device. It runs only if you allow it once.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="ata-local-feature-approval-body">
          <p className="ata-local-feature-approval-description">{request.toolDescription}</p>
          <ApprovalRequestPreview request={request} />
          {snapshot.pending.length > 1 ? (
            <p className="ata-local-feature-approval-queue">
              {snapshot.pending.length - 1} more request{snapshot.pending.length === 2 ? "" : "s"} waiting.
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => controller.decide(request.id, "deny")}>
            Deny
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => controller.decide(request.id, "approve")}>
            Allow once
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ApprovalRequestPreview({ request }: { request: ProviderLocalApprovalRequest }) {
  const entries = Object.entries(request.displayArgsPreview);
  if (entries.length === 0) return null;
  return (
    <dl className="ata-local-feature-approval-preview">
      {entries.map(([key, value]) => (
        <div className="ata-local-feature-approval-preview-row" key={key}>
          <dt>{friendlyApprovalField(key)}</dt>
          <dd>
            {approvalPreviewText(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function friendlyApprovalField(value: string): string {
  const spaced = value.replace(/[._-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function approvalPreviewText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
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
  return sidecar.running
    ? "Aurora is starting on this computer"
    : "Aurora on this computer needs attention";
}

export interface TauriReadinessDiagnostic {
  code: "AURORA_TAURI_SIDECAR_NOT_READY" | "AURORA_TAURI_GATEWAY_NOT_READY";
  message: string;
  sidecar: {
    running: boolean;
    mode: string | null;
    lastError: string | null;
    details: string | null;
  };
  gateway?: {
    attempt: number;
    elapsedMs: number;
    lastProbeError: string | null;
  };
}

export class TauriReadinessError extends Error {
  readonly code: TauriReadinessDiagnostic["code"];
  readonly diagnosticCause: TauriReadinessDiagnostic;

  constructor(message: string, diagnosticCause: TauriReadinessDiagnostic) {
    super(message);
    this.name = "TauriReadinessError";
    this.code = diagnosticCause.code;
    this.diagnosticCause = diagnosticCause;
  }
}

export function assertReadySidecar(sidecar: TauriSidecarStatus): void {
  if (sidecar.running && !sidecar.lastError) return;
  throw new TauriReadinessError(
    "Aurora on this computer could not start. Restart Aurora and try again.",
    readinessDiagnostic("AURORA_TAURI_SIDECAR_NOT_READY", sidecar),
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

export async function waitForGatewayReadiness(
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

  throw new TauriReadinessError(
    "Aurora on this computer did not finish starting. Restart Aurora and try again.",
    readinessDiagnostic("AURORA_TAURI_GATEWAY_NOT_READY", latestSidecar, {
      attempt,
      elapsedMs: Date.now() - startedAt,
      lastProbeError: diagnosticText(lastError),
    }),
  );
}

function readinessDiagnostic(
  code: TauriReadinessDiagnostic["code"],
  sidecar: TauriSidecarStatus,
  gateway?: TauriReadinessDiagnostic["gateway"],
): TauriReadinessDiagnostic {
  return {
    code,
    message:
      code === "AURORA_TAURI_SIDECAR_NOT_READY"
        ? "Local Aurora startup did not report a ready service."
        : "Local Aurora startup completed, but the app could not confirm service readiness before timeout.",
    sidecar: {
      running: Boolean(sidecar.running),
      mode: diagnosticText(sidecar.mode),
      lastError: diagnosticText(sidecar.lastError),
      details: diagnosticText(sidecar.details),
    },
    ...(gateway ? { gateway } : {}),
  };
}

function diagnosticText(value: unknown): string | null {
  if (value == null) return null;
  const raw =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
        ? value
        : safeStringifyDiagnostic(value);
  return redactDiagnosticText(raw);
}

function safeStringifyDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(
      /"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)"\s*:\s*"[^"]*"/giu,
      '"$1":"[redacted]"',
    )
    .replace(/https?:\/\/[^\s"')]+/giu, "[redacted-url]")
    .replace(/wss?:\/\/[^\s"')]+/giu, "[redacted-url]")
    .replace(
      /\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|bearer|api[_ -]?key|authorization|room_password)\b\s*[:=]\s*["']?[^"',\s}]+/giu,
      "$1=[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted-secret]")
    .slice(0, 1_200);
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
  _attempt: number,
  elapsedMs: number,
  _sidecar: TauriSidecarStatus,
  _lastError: unknown,
): string {
  const elapsedS = Math.round(elapsedMs / 1000);
  return `Connecting Aurora on this computer · ${elapsedS}s`;
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
  if (services.length === 0) return "Preparing Aurora features…";
  const healthy = services.filter(
    (service) => service.status === "healthy",
  ).length;
  return `Preparing Aurora features · ${healthy} of ${services.length} ready`;
}

async function buildRuntimeShellSnapshot(
  client: AuroraClient,
  retryTransientError: boolean,
  nativeManifest?: AuroraTauriRuntime["nativeCapabilityManifest"],
): Promise<AuroraShellSnapshot> {
  const options = nativeManifest ? { nativeManifest } : undefined;
  if (!retryTransientError) return buildShellSnapshot(client, options);

  let snapshot = await buildShellSnapshot(client, options);
  if (snapshot.loadState !== "error") return snapshot;

  const deadline = Date.now() + DESKTOP_LOCAL_SNAPSHOT_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    await delay(DESKTOP_LOCAL_GATEWAY_RETRY_DELAY_MS);
    snapshot = await buildShellSnapshot(client, options);
    if (snapshot.loadState !== "error") return snapshot;
  }
  return snapshot;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NativeContext {
  runtimeMode: string;
  localMode: boolean;
  sidecar: TauriSidecarStatus | null;
  surfaceProfile: ReturnType<typeof getAuroraSurfaceProfile>;
  thinConnectionMode: ReturnType<
    typeof createAuroraTauriRuntime
  >["thinConnectionMode"];
  thinPeer?: ReturnType<typeof createAuroraTauriRuntime>["thinPeer"];
  thinFeatures?: AuroraTauriRuntime["thinFeatures"];
  nodeMode?: AuroraTauriRuntime["nodeMode"];
  localNodeProviderStatus?: AuroraTauriRuntime["localNodeProviderStatus"];
  localFeatureSharing?: AuroraTauriRuntime["localFeatureSharing"];
  localToolProvider?: AuroraTauriRuntime["localToolProvider"];
  localAssistant?: AuroraTauriRuntime["localAssistant"];
  remoteTools?: readonly ToolingProjectionToolInfo[];
  runtimeProfile?: AuroraTauriRuntime["runtimeProfile"];
  localData?: AuroraTauriRuntime["localData"];
  nativeVoice?: AuroraTauriRuntime["nativeVoice"];
  nativeMobileVoice?: AuroraTauriRuntime["nativeMobileVoice"];
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

function localMeshNodeIdentity(
  nativeContext: NativeContext,
): { peerId: string; nodeName: string } | undefined {
  if (nativeContext.nodeMode !== "mesh-node") return undefined;
  const localNode = nativeContext.runtimeProfile?.localNode;
  const peerId = localNode?.stablePeerId ?? nativeContext.thinProfile?.localStablePeerId;
  const nodeName = localNode?.nodeName ?? nativeContext.thinProfile?.nodeName;
  if (!peerId || !nodeName) return undefined;
  return { peerId, nodeName };
}

function tauriLocalAssistant(
  nativeContext: NativeContext,
  client: AuroraClient,
): LightweightAssistantDependencies | null {
  const localData = nativeContext.localData;
  const localToolProvider = nativeContext.localToolProvider;
  const localAssistant = nativeContext.localAssistant;
  if (
    nativeContext.thinFeatures?.lightweightOrchestratorEnabled !== true
    || !localData
    || !localData.ownerAvailable
    || !localToolProvider
    || !localAssistant
  ) {
    return null;
  }
  const localTools = localToolProvider.localToolRegistry.publicTools();
  const availableTools = mergeLightweightAssistantTools(
    localTools,
    localAssistant.remoteTools ?? [],
  );
  const localPolicy = createOnDeviceLightweightToolPolicy({
    localRegistry: localToolProvider.localToolRegistry,
    providerPeerId: localToolProvider.providerPeerId,
    serviceInstanceId: localToolProvider.serviceInstanceId,
  });
  return {
    provider: localAssistant.provider,
    tools: createLightweightToolClientAdapter({
      localRegistry: localToolProvider.localToolRegistry,
      localPolicy,
      remote: tauriRemoteToolDelegate(client),
      availableTools,
      providerPeerId: localToolProvider.providerPeerId,
      serviceInstanceId: localToolProvider.serviceInstanceId,
      callerPeerId: localData.localNodeId,
      callerPrincipalId: localData.profileId,
      callerPermissions: onDeviceAssistantPermissions(localTools),
    }),
    localData: localData.session,
    envelopeCrypto: localData.crypto,
    scope: {
      profileId: localData.session.profileId,
      localNodeId: localData.session.localNodeId,
    },
    availableTools,
  };
}

function tauriRemoteToolDelegate(client: AuroraClient): LightweightToolClientDelegate {
  return {
    prepareExecution: (payload) =>
      client.tools.prepareExecution<
        ToolingPrepareExecutionResponse,
        ToolingPrepareExecutionRequest
      >(payload),
    requestApproval: (payload) =>
      client.tools.requestApproval<
        ToolApprovalRequestResponse,
        ToolingPrepareExecutionRequest
      >(payload),
    confirmExecution: (payload) =>
      client.tools.confirmExecution<
        ToolApprovalConfirmResponse,
        ToolApprovalConfirmRequest
      >(payload),
    execute: (payload) =>
      client.tools.execute<
        LightweightToolExecutionResponse,
        ToolingPrepareExecutionRequest
      >(payload),
  };
}

function TauriRouteContent({
  path,
  snapshot,
  nativeContext,
  client,
  modePreferenceStore,
  applyModePreference,
  navigate,
  shutdown,
}: {
  path: string;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: ReturnType<typeof createAuroraTauriRuntime>["client"];
  modePreferenceStore?: OnboardingModePreferenceStore | undefined;
  applyModePreference?: (() => Promise<void>) | undefined;
  navigate: (href: string) => void;
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
    applyModePreference,
    navigate,
    assistantNativePermissions,
    assistantNativeCapabilities,
  });
}

function TauriMemoryPage({
  route,
  nativeContext,
  client,
}: {
  route: RouteAvailability;
  nativeContext: NativeContext;
  client: ReturnType<typeof createAuroraTauriRuntime>["client"];
}) {
  const localData = nativeContext.localData;
  const backendFactory = useMemo(
    () => (localData ? tauriLocalDataBackendFactory(localData) : null),
    [localData],
  );
  if (!localData) return <MemoryView client={client} route={route} />;
  return (
    <LocalDataProvider
      profileId={localData.profileId}
      localNodeId={localData.localNodeId}
      ownerAvailable={localData.ownerAvailable}
      backendFactory={backendFactory ?? undefined}
    >
      <MemoryView client={client} route={route} />
    </LocalDataProvider>
  );
}

function tauriLocalDataBackendFactory(
  localData: NonNullable<AuroraTauriRuntime["localData"]>,
): LocalDataBackendFactory {
  return async () => tauriLocalDataBackend(localData);
}

function tauriLocalDataBackend(
  localData: NonNullable<AuroraTauriRuntime["localData"]>,
): LocalDataBackend {
  return {
    kind: "sqlite-tauri",
    persistent: true,
    sqlite: true,
    open: async (profileId, localNodeId) => {
      if (
        profileId !== localData.profileId ||
        localNodeId !== localData.localNodeId
      ) {
        throw new Error("Local data is available only for this device.");
      }
      return localData.session;
    },
    status: async (): Promise<LocalDataBackendStatus> => ({
      kind: "sqlite-tauri",
      persistent: true,
      sqlite: true,
      profileId: localData.profileId,
      schemaVersion: localData.session.schemaVersion,
      migrationState: "idle",
    }),
    close: async () => undefined,
  };
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
          <h2 id="tauri-native-command-title">Device controls</h2>
          <p>
            Features provided by this computer are listed here with their
            current access state.
          </p>
          <dl className="ata-facts">
            {rows.map((row) => (
              <div key={row.id}>
                <dt>{row.label}</dt>
                <dd>{row.status}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <section
          className="ata-panel"
          aria-labelledby="tauri-native-thin-title"
        >
          <h2 id="tauri-native-thin-title">Device controls</h2>
          <p>
            {surfaceTitle(nativeContext)} uses features supplied by the
            connected device or this device. Computer-only controls are not
            available here.
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
  onChangeDeviceSetup,
}: {
  route: RouteAvailability;
  snapshot: AuroraShellSnapshot;
  nativeContext: NativeContext;
  client: AuroraTauriClient;
  onChangeDeviceSetup: () => void;
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
        description="Permissions, connection choices, privacy, and data controls are grouped on one Settings page."
        badges={
          <>
            <EvidenceBadge
              label={
                snapshot.loadState === "ready"
                  ? "Settings available"
                  : "Settings need attention"
              }
            />
            <EvidenceBadge
              label={
                snapshot.secretsRedacted
                  ? "secrets protected"
                  : "sensitive details need attention"
              }
            />
            <EvidenceBadge label={surfaceTitle(nativeContext)} />
          </>
        }
      />
      <p className="aui-muted">
        Privacy history and device-specific controls are available in Advanced.
      </p>
      {nativeContext.thinProfileController ? (
        <section className="ata-panel" aria-labelledby="device-setup-title">
          <h2 id="device-setup-title">How this device works with Aurora</h2>
          <p className="aui-muted">
            {nativeContext.nodeMode === "mesh-node"
              ? "Approved Aurora devices can use features you choose from this device."
              : "This device uses Aurora running on another approved device or server."}
          </p>
          <Button variant="outline" onClick={onChangeDeviceSetup}>
            Change device setup
          </Button>
        </section>
      ) : null}
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
          localFeatureSharing={nativeContext.localFeatureSharing}
          {...(nativeContext.thinProfileController
            ? {
                onSaveProfile: nativeContext.saveThinProfile,
                onSelectProfile: nativeContext.selectThinProfile,
              }
            : {})}
        />
      ) : null}
      <StateSurface
        title={surfaceTitle(nativeContext)}
        state={
          snapshot.loadState === "error"
            ? "denied"
            : nativeContext.sidecar?.running
              ? "available-local"
              : nativeContext.localMode
                ? "pending"
                : "available-remote"
        }
        description="Connection, device features, and repair status are shown below."
        evidence={null}
        actionLabel={
          nativeContext.sidecar?.lastError
            ? "Aurora on this computer needs attention. Restart Aurora and try again."
            : null
        }
      />
      <section className="ata-panel">
        <h2>Device status</h2>
        <dl className="ata-facts">
          <div>
            <dt>Aurora setup</dt>
            <dd>{runtimeModeLabel(nativeContext.runtimeMode)}</dd>
          </div>
          <div>
            <dt>Connection</dt>
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
                <dt>Connection preference</dt>
                <dd>
                  {connectionModeLabel(nativeContext.thinConnectionMode)}
                </dd>
              </div>
              <div>
                <dt>Connected device</dt>
                <dd>
                  {peerConnectionStatusLabel(
                    nativeContext.thinPeer?.snapshot().status,
                  )}
                </dd>
              </div>
              <div>
                <dt>Saved access</dt>
                <dd>
                  {savedAccessLabel(
                    nativeContext.thinPeer?.snapshot().secretsPersisted,
                  )}
                </dd>
              </div>
              <div>
                <dt>Connection status</dt>
                <dd>
                  {peerConnectionDetailLabel(
                    nativeContext.thinPeer?.snapshot().status,
                  )}
                </dd>
              </div>
            </>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "sidecar") ? (
            <div>
              <dt>Aurora on this computer</dt>
              <dd>
                {nativeContext.sidecar?.running
                  ? "Ready"
                  : nativeContext.localMode
                    ? "Needs attention"
                    : "Not needed for this connection"}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Device support</dt>
            <dd>
              {snapshot.nativeAvailable
                ? platformLabel(snapshot.nativePlatform)
                : "Not available"}
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
            <dt>Audio access</dt>
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
              <dt>Siri and Shortcuts</dt>
              <dd>{iosInvocationLabel(nativeContext.iosInvocationStatus)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "ios") ? (
            <div>
              <dt>On-device models</dt>
              <dd>
                {localLightInferenceLabel(nativeContext.iosLocalLightStatus)}
              </dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Android support</dt>
              <dd>{androidBaselineLabel(nativeContext.androidBaseline)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Assistant access</dt>
              <dd>{assistantRoleProbeLabel(nativeContext.androidBaseline)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>App visibility</dt>
              <dd>{androidForegroundLabel(nativeContext.androidForeground)}</dd>
            </div>
          ) : null}
          {shouldShowForSurface(nativeContext.surfaceProfile, "android") ? (
            <div>
              <dt>Microphone use</dt>
              <dd>{androidMediaPolicyLabel(nativeContext.androidMediaPolicy)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Permissions to review</dt>
            <dd>
              {permissionsToReviewLabel(nativeContext.nativePermissions)}
            </dd>
          </div>
        </dl>
        <button
          className="ata-secondary"
          type="button"
          onClick={() => void shutdown()}
        >
          Close Aurora
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

export function MissingTauriRoute({
  route: _route,
}: {
  route: RouteAvailability;
}) {
  return (
    <div className="ata-page-stack">
      <StateSurface
        title="Page unavailable"
        state="denied"
        description="Aurora could not open this page. Return to the previous page and try again."
        evidence={null}
        actionLabel="Your settings and data are unchanged."
      />
      <section className="ata-panel">
        <h2>What you can do</h2>
        <p>Restart Aurora, then open this page again.</p>
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
): Array<{ id: string; label: string; status: string }> {
  return [
    {
      id: "device-permissions",
      label: "Device permissions",
      status: permissionsToReviewLabel(nativeContext.nativePermissions),
    },
    nativeFeatureRow(
      "tray",
      "Tray",
      nativeContext.nativeFeatures.tray,
    ),
    nativeFeatureRow(
      "notifications",
      "Notifications",
      nativeContext.nativeFeatures.notifications,
    ),
    nativeFeatureRow(
      "dialogs",
      "Dialogs",
      nativeContext.nativeFeatures.dialogs,
    ),
    nativeFeatureRow(
      "audio",
      "Audio access",
      nativeContext.nativeFeatures.audio,
    ),
    {
      id: "local-aurora",
      label: "Aurora on this computer",
      status: nativeContext.sidecar?.running ? "Ready" : "Needs attention",
    },
  ];
}

function androidForegroundLabel(
  status: AndroidForegroundRuntimeStatus | null,
): string {
  if (!status) return "Open Aurora to use this feature";
  return status.foreground && status.visible && status.focused
    ? "Ready while Aurora is open"
    : "Open Aurora to use this feature";
}

function androidMediaPolicyLabel(
  status: AndroidMediaPolicyStatus | null,
): string {
  if (!status) {
    return "Microphone use is available only while Aurora is open; background listening is unavailable";
  }
  return status.microphoneAllowedInForeground
    ? "Microphone available while Aurora is open; background listening is unavailable"
    : "Microphone access is unavailable; review device permissions";
}

function nativeFeatureRow(
  id: string,
  label: string,
  feature: TauriNativeFeatureStatus | null | undefined,
): { id: string; label: string; status: string } {
  return {
    id,
    label,
    status: nativeFeatureLabel(feature),
  };
}

function surfaceTitle(nativeContext: NativeContext): string {
  if (nativeContext.localMode) return "This computer";
  if (nativeContext.surfaceProfile.isAndroid) return "This Android device";
  if (nativeContext.surfaceProfile.isIos) return "This iPhone or iPad";
  if (nativeContext.surfaceProfile.isMobile) return "This mobile device";
  return "Connected Aurora device";
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
export function runtimeModeLabel(mode: string): string {
  if (mode === "mock") return "Local mode";
  if (mode === "desktop-local") return "Local on this computer";
  if (mode === "desktop-thin") return "Connected to another Aurora device";
  if (mode === "mobile-native") return "Aurora on this mobile device";
  if (mode === "web" || mode === "web-thin") {
    return "Connected in this browser";
  }
  return "Aurora setup unavailable";
}

export function transportKindLabel(
  transportKind: string,
  runtimeMode: string,
): string {
  if (runtimeMode === "mock") return "Local mode";
  if (transportKind === "pending" && runtimeMode === "desktop-local")
    return "Starting on this computer";
  if (transportKind === "pending" && runtimeMode === "desktop-thin")
    return "Connecting to your Aurora device";
  if (transportKind === "tauri" || transportKind === "tauri-local") {
    return "On this computer";
  }
  if (
    transportKind === "mesh" ||
    transportKind === "webrtc" ||
    transportKind === "webrtc-only" ||
    transportKind === "webrtc-preferred"
  ) {
    return "Direct device connection";
  }
  if (
    transportKind === "http" ||
    transportKind === "https" ||
    transportKind === "gateway"
  ) {
    return "Connected through your Aurora home device";
  }
  if (transportKind === "mock") return "Local mode";
  return "Connection unavailable";
}

export function nativeFeatureLabel(
  feature: TauriNativeFeatureStatus | null | undefined,
): string {
  if (!feature) return "Not available";
  if (feature.available) return "Available";
  return "Permission needed";
}

export function iosInvocationLabel(
  status: TauriIosInvocationStatus | null | undefined,
): string {
  const state = status?.state ?? null;
  if (status?.available && state !== "degraded" && !state?.startsWith("pending")) {
    return "Available; Aurora does not replace the system assistant";
  }
  if (state === "degraded" || state?.startsWith("pending")) {
    return "Needs attention; Aurora does not replace the system assistant";
  }
  return "Not available; Aurora does not replace the system assistant";
}

export function localLightInferenceLabel(
  status: AndroidLocalLightInferenceStatus | null | undefined,
): string {
  if (!status) return "Not available";
  if (status.available || status.state === "available") return "Available";
  if (status.state === "needs_native_permission") return "Permission needed";
  if (status.state === "degraded") return "Needs attention";
  if (status.state === "fallback") {
    return "Available through a connected Aurora device";
  }
  if (status.state === "unsupported_platform") return "Not available";
  return "Status unavailable";
}

export function androidBaselineLabel(
  status: TauriAndroidBaselineStatus | null,
): string {
  if (!status) return "Not available";
  if (status.available || status.state === "available") return "Available";
  if (status.state === "needs_native_permission") return "Permission needed";
  if (status.state === "degraded") return "Needs attention";
  if (status.state === "fallback") {
    return "Available through a connected Aurora device";
  }
  if (status.state === "unsupported_platform") return "Not available";
  return "Status unavailable";
}

export function assistantRoleProbeLabel(
  status: TauriAndroidBaselineStatus | null,
): string {
  if (!status) return "Not available";
  if (status.assistantRole.roleHeld) return "Selected";
  if (
    status.assistantRole.roleAvailable ||
    status.assistantRole.requestable ||
    status.assistantRole.packageQualified
  ) {
    return "Available";
  }
  if (status.assistantRole.denied) return "Permission needed";
  return "Not available";
}

export function connectionModeLabel(mode: string): string {
  if (mode === "http-only") return "Home device";
  if (mode === "webrtc-only") return "Direct device";
  if (mode === "webrtc-preferred") return "Best available";
  return "Not configured";
}

export function peerConnectionStatusLabel(
  status: string | null | undefined,
): string {
  if (
    status === "authorized" ||
    status === "connected" ||
    status === "fallback-http"
  ) {
    return "Connected";
  }
  if (status === "pairing" || status === "verification") {
    return "Waiting for approval";
  }
  if (status === "connecting" || status === "reconnecting") {
    return "Connecting";
  }
  if (
    status === "error" ||
    status === "closed" ||
    status === "disconnected" ||
    status === "offline"
  ) {
    return "Needs attention";
  }
  if (status === "idle" || status === "not-configured" || status == null) {
    return "Not configured";
  }
  return "Checking";
}

function peerConnectionDetailLabel(status: string | null | undefined): string {
  const productStatus = peerConnectionStatusLabel(status);
  if (productStatus === "Connected") return "Ready";
  if (productStatus === "Waiting for approval") {
    return "Approve this device to continue";
  }
  if (productStatus === "Connecting") return "Connecting";
  if (productStatus === "Needs attention") {
    return "Reconnect this device and try again";
  }
  if (productStatus === "Not configured") {
    return "Connect a device to continue";
  }
  return "Checking connection";
}

export function savedAccessLabel(
  secretsPersisted: boolean | null | undefined,
): string {
  if (secretsPersisted === true) return "Protected on this device";
  if (secretsPersisted === false) return "Available for this session only";
  return "No saved access";
}

function platformLabel(platform: string | null | undefined): string {
  const normalized = platform?.trim().toLowerCase();
  if (normalized === "darwin" || normalized === "macos") return "macOS";
  if (normalized === "windows" || normalized === "win32") return "Windows";
  if (normalized === "linux") return "Linux";
  if (normalized === "android") return "Android";
  if (
    normalized === "ios" ||
    normalized === "iphone" ||
    normalized === "ipad"
  ) {
    return "iPhone or iPad";
  }
  return "Device";
}

function permissionsToReviewLabel(
  status: TauriNativePermissionStatus | null,
): string {
  if (!status) return "Status unavailable";
  const count = status.deniedByDefault.length;
  if (count === 0) return "None";
  return `${count} ${count === 1 ? "permission needs" : "permissions need"} review`;
}

function routeAvailabilityLabel(route: RouteAvailability): string {
  if (route.state === "available-local") return "Available on this device";
  if (route.state === "available-remote") {
    return "Available from a connected Aurora device";
  }
  if (route.state === "denied" || route.state === "privacy-blocked") {
    return "Permission needed";
  }
  if (route.state === "pending") return "Checking";
  if (route.state === "degraded" || route.state === "stale") {
    return "Needs attention";
  }
  return "Unavailable";
}
