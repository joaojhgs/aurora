import {
  AuroraClient,
  HttpGatewayTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  type TauriAndroidBaselineStatus,
  type AndroidLocalLightInferenceStatus,
  type TauriIosInvocationStatus,
  type TauriNativeFeatureStatus,
  type TauriNativePermissionStatus,
  type TauriSidecarStatus,
} from "@aurora/client";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AURORA_RELEASE_FOCUSED_MEDIA_EVENT,
  activeThinConnectionProfile,
  createBrowserWebThinRuntime,
  emptyThinProfileDocument,
  explainBrowserThinRuntime,
  getAuroraSurfaceProfile,
  isThinConnectionProfileConfigured,
  parseThinProfileDocument as parseSharedThinProfileDocument,
  parseWebRtcInvite,
  sanitizeThinConnectionProfile,
  serializeThinProfileDocument as serializeSharedThinProfileDocument,
  type ParsedWebRtcInvite,
  type ThinConnectionProfile,
  type ThinProfileDocument,
  type AuroraWebRtcRolloutFlags,
  type AuroraThinConnectionMode,
  type BrowserWebThinRuntime,
} from "@aurora/ui";
import {
  NativePeerCredentialStore,
  type MeshPeerCredentialRecord,
  type MeshReconnectChallengeMessage,
  type MeshReconnectProofMessage,
  type PeerCredentialStatus,
  type StoredPeerCredentialMetadata,
  type WebRtcPeerCredentialStore,
  type WebRtcPeerConnectionProfile,
} from "@aurora/client/webrtc";

export interface AuroraTauriRuntime {
  client: AuroraClient;
  mode: "desktop-local" | "desktop-thin" | "mobile-native" | "mock";
  thinConnectionMode: AuroraThinConnectionMode;
  thinPeer?: BrowserWebThinRuntime["peer"] | undefined;
  thinDiagnostics: () => string[];
  thinProfile?: AuroraThinConnectionProfile | undefined;
  thinProfileConfigured: boolean;
  requiresOnboarding: boolean;
  pendingThinInviteText: string | null;
  thinProfileController?: AuroraThinProfileController | undefined;
  modePreferenceStore?: AuroraModePreferenceStore;
  sidecarStatus: () => Promise<TauriSidecarStatus | null>;
  startSidecar: () => Promise<TauriSidecarStatus | null>;
  stopSidecar: () => Promise<TauriSidecarStatus | null>;
  nativePermissionStatus: () => Promise<TauriNativePermissionStatus | null>;
  trayStatus: () => Promise<TauriNativeFeatureStatus | null>;
  notificationStatus: () => Promise<TauriNativeFeatureStatus | null>;
  iosVoiceStatus: () => Promise<TauriNativeFeatureStatus | null>;
  iosInvocationStatus: () => Promise<TauriIosInvocationStatus | null>;
  iosLocalLightInferenceStatus: () => Promise<AndroidLocalLightInferenceStatus | null>;
  iosBackgroundStatus: () => Promise<TauriNativeFeatureStatus | null>;
  dialogStatus: () => Promise<TauriNativeFeatureStatus | null>;
  audioBridgeStatus: () => Promise<TauriNativeFeatureStatus | null>;
  iosSecureStorageStatus: () => Promise<TauriNativeFeatureStatus | null>;
  iosBiometricStatus: () => Promise<TauriNativeFeatureStatus | null>;
  androidBaselineStatus: () => Promise<TauriAndroidBaselineStatus | null>;
  androidForegroundStatus: () => Promise<AndroidForegroundRuntimeStatus | null>;
  androidMediaPolicyStatus: () => Promise<AndroidMediaPolicyStatus | null>;
  dispose: () => Promise<void>;
  overlayShow?: (
    mode: AuroraOverlayRuntimeMode,
  ) => Promise<AuroraOverlayCommandStatus | null>;
  overlayHide?: () => Promise<AuroraOverlayCommandStatus | null>;
  overlayStatus?: () => Promise<AuroraOverlayCommandStatus | null>;
  overlaySetPassthrough?: (
    enabled: boolean,
  ) => Promise<AuroraOverlayCommandStatus | null>;
  overlayStartDrag?: () => Promise<AuroraOverlayCommandStatus | null>;
  overlayMoveBy?: (
    dx: number,
    dy: number,
  ) => Promise<AuroraOverlayCommandStatus | null>;
  overlayRegisterHotkey?: (
    accelerator: string,
  ) => Promise<AuroraOverlayCommandStatus | null>;
  overlayUnregisterHotkey?: () => Promise<AuroraOverlayCommandStatus | null>;
  listenOverlayMode?: (
    handler: AuroraOverlayModeListener,
  ) => Promise<() => void>;
  shutdown: () => Promise<void>;
}


export interface AndroidForegroundRuntimeStatus {
  platform: "android";
  foreground: boolean;
  visible: boolean;
  focused: boolean;
  source: string;
  reason?: string;
  phase?: string;
}

export interface AndroidMediaPolicyStatus {
  platform: "android";
  microphoneAllowedInForeground: boolean;
  backgroundWakewordAllowed: false;
  source: string;
  reason?: string;
}

export type AuroraThinConnectionProfile = ThinConnectionProfile;
export type AuroraThinProfileDocument = ThinProfileDocument;

export interface AuroraThinProfileStore {
  evidence: string;
  load: () => Promise<AuroraThinProfileDocument>;
  save: (document: AuroraThinProfileDocument) => Promise<void>;
}

export interface AuroraThinProfileController {
  evidence: string;
  document: AuroraThinProfileDocument;
  saveProfile: (
    profile: AuroraThinConnectionProfile,
    roomSecret?: {
      roomSecretRef: string;
      roomSecret: string;
    },
  ) => Promise<AuroraThinProfileDocument>;
  selectProfile: (profileId: string) => Promise<AuroraThinProfileDocument>;
  createRuntime: (
    document: AuroraThinProfileDocument,
  ) => AuroraTauriRuntime;
}

export function isThinProfileConfigured(
  profile: AuroraThinConnectionProfile | undefined,
): boolean {
  return isThinConnectionProfileConfigured(profile);
}

export function thinProfileFromParsedWebRtcInvite(
  parsed: ParsedWebRtcInvite,
  baseProfile?: AuroraThinConnectionProfile | undefined,
): {
  profile: AuroraThinConnectionProfile;
  roomSecret: { roomSecretRef: string; roomSecret: string };
} {
  const surfaceDefaults = thinSurfaceDefaults();
  const profile = sanitizeThinConnectionProfile({
    id: baseProfile?.id || "default",
    label: baseProfile?.label || surfaceDefaults.label,
    mode: baseProfile?.gatewayUrl ? "webrtc-preferred" : "webrtc-only",
    gatewayUrl: baseProfile?.gatewayUrl || "",
    signalingUrl:
      baseProfile?.signalingUrl ||
      parsed.profile.signalingBrokers[0] ||
      "",
    nodeName:
      baseProfile?.nodeName ||
      surfaceDefaults.nodeName,
    localStablePeerId:
      baseProfile?.localStablePeerId || surfaceDefaults.localStablePeerId,
    webrtcProfile: parsed.profile,
  });
  return {
    profile,
    roomSecret: {
      roomSecretRef: parsed.profile.roomSecretRef,
      roomSecret: parsed.roomSecret,
    },
  };
}

export function thinProfileFromWebRtcInvite(
  inviteText: string,
  baseProfile?: AuroraThinConnectionProfile | undefined,
): ReturnType<typeof thinProfileFromParsedWebRtcInvite> | null {
  const parsed = parseWebRtcInvite(inviteText, {
    nodeName: baseProfile?.nodeName,
    signalingUrl: baseProfile?.signalingUrl,
    allowInsecureLoopbackSignaling: truthy(
      import.meta.env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK,
    ),
  });
  return parsed ? thinProfileFromParsedWebRtcInvite(parsed, baseProfile) : null;
}

export interface AuroraModePreferenceStore {
  evidence: string;
  readSelectedMode: () => Promise<string | null>;
  writeSelectedMode: (modeId: string) => Promise<boolean>;
}

export type AuroraOverlayRuntimeMode = "voice" | "text";
export type AuroraOverlayModeListener = (payload: unknown) => void;

export interface AuroraOverlayCommandStatus {
  ok?: boolean;
  mode?: AuroraOverlayRuntimeMode | "hidden";
  visible?: boolean;
  pointerPassthrough?: boolean;
  accelerator?: string;
  reason?: string;
  [key: string]: unknown;
}

const ONBOARDING_MODE_KEY = "aurora.session.onboarding-mode";
const DEFAULT_THIN_CONNECTION_MODE: AuroraThinConnectionMode = "http-only";
export const ANDROID_NATIVE_PLUGIN_NAME = "aurora-native";
export const ANDROID_LIFECYCLE_EVENT = "aurora://android-lifecycle";

export async function bootstrapAuroraTauriRuntime(
  profileStore?: AuroraThinProfileStore,
): Promise<AuroraTauriRuntime> {
  if (!requiresAsyncAuroraTauriBootstrap()) return createAuroraTauriRuntime();
  const thinInviteText = consumeFragmentInviteFromRuntime();
  const preferredStore =
    profileStore ??
    secureThinProfileStore(new TauriLocalTransport({ invoke, listen }));
  let store = preferredStore;
  let document: AuroraThinProfileDocument;
  try {
    document = await preferredStore.load();
  } catch {
    store = createMemoryThinProfileStore();
    document = await store.load();
  }
  return createAuroraTauriRuntime({
    thinProfileStore: store,
    thinProfileDocument: document,
    thinInviteText,
    consumeThinInvite: false,
  });
}

export function createInitialAuroraTauriRuntime(): AuroraTauriRuntime {
  return createAuroraTauriRuntime({
    consumeThinInvite: !requiresAsyncAuroraTauriBootstrap(),
  });
}

export function requiresAsyncAuroraTauriBootstrap(): boolean {
  return isPackagedDesktopThinRuntime() || (isTauriRuntime() && isMobileTauriRuntime());
}

export function createAuroraTauriRuntime({
  thinProfileStore,
  thinProfileDocument,
  thinInviteText: explicitThinInviteText,
  consumeThinInvite = true,
}: {
  thinProfileStore?: AuroraThinProfileStore;
  thinProfileDocument?: AuroraThinProfileDocument;
  thinInviteText?: string | null;
  consumeThinInvite?: boolean;
} = {}): AuroraTauriRuntime {
  const configuredProfile = activeThinProfile(thinProfileDocument);
  const configuredGatewayUrl = configuredProfile?.gatewayUrl || undefined;
  const thinConnectionMode =
    configuredProfile?.mode ?? DEFAULT_THIN_CONNECTION_MODE;
  const thinInviteText =
    explicitThinInviteText ??
    (consumeThinInvite ? consumeFragmentInviteFromRuntime() : null);
  const thinProfileController =
    thinProfileStore && thinProfileDocument
      ? createThinProfileController(thinProfileStore, thinProfileDocument)
      : undefined;
  const thinProfileConfigured = isThinProfileConfigured(configuredProfile);

  if (isTauriRuntime()) {
    const nativeTransport = new TauriLocalTransport({ invoke, listen });
    const isMobileNative = isMobileTauriRuntime();

    if (isMobileNative) {
      if (isAndroidTauriRuntime() || isIosTauriRuntime()) {
        const mobilePlatform = isAndroidTauriRuntime() ? "android" : "ios";
        const thinRuntime = createTauriWebThinRuntime({
          mode: thinConnectionMode,
          gatewayUrl: configuredGatewayUrl,
          signalingUrl: configuredProfile?.signalingUrl,
          webrtcProfile: configuredProfile?.webrtcProfile,
          inviteText: thinInviteText,
          runtimeMode: "mobile-native",
          nodeName:
            configuredProfile?.nodeName ||
            `Aurora ${mobilePlatform} thin WebView`,
          localStablePeerId: configuredProfile?.localStablePeerId,
        });
        const releaseMobileLifecycle = isAndroidTauriRuntime()
          ? installAndroidLifecyclePolicy(thinRuntime)
          : async () => undefined;
        return {
          client: thinRuntime.client,
          mode: "mobile-native",
          thinConnectionMode,
          thinPeer: thinRuntime.peer,
          thinDiagnostics: () =>
            explainTauriThinRuntime(
              thinConnectionMode,
              configuredGatewayUrl,
              configuredProfile?.signalingUrl,
              thinInviteText,
              "mobile-native",
              mobilePlatform,
          ),
          thinProfile: configuredProfile,
          thinProfileConfigured,
          requiresOnboarding: !thinProfileConfigured,
          pendingThinInviteText: thinInviteText,
          thinProfileController,
          modePreferenceStore: memoryOnlyModePreferenceStore(
            `${mobilePlatform} thin mode preference is selected by the narrow nonsecret thin profile; no generic secure storage`,
          ),
          sidecarStatus: async () => null,
          startSidecar: async () => null,
          stopSidecar: async () => null,
          nativePermissionStatus: () =>
            nativeTransport.getNativePermissionStatus(),
          trayStatus: async () => null,
          notificationStatus: () => nativeTransport.getNotificationStatus(),
          iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
          iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
          iosLocalLightInferenceStatus: () =>
            nativeTransport.getIosLocalLightInferenceStatus(),
          iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
          dialogStatus: () => nativeTransport.getDialogStatus(),
          audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
          iosSecureStorageStatus: () =>
            nativeTransport.getIosSecureStorageStatus(),
          iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
          androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
          androidForegroundStatus: () => androidForegroundStatus(),
          androidMediaPolicyStatus: () => androidMediaPolicyStatus(),
          dispose: async () => {
            await releaseMobileLifecycle();
            await thinRuntime.close();
          },
          ...noopOverlayControls(`${mobilePlatform}-thin-runtime`),
          shutdown: async () => {
            await releaseMobileLifecycle();
            await thinRuntime.close();
          },
        };
      }

      const mobileClient = configuredGatewayUrl
        ? createDynamicHttpClient(configuredGatewayUrl)
        : new AuroraClient({ transport: nativeTransport });

      return {
        client: mobileClient,
        mode: "mobile-native",
        thinConnectionMode: DEFAULT_THIN_CONNECTION_MODE,
        thinDiagnostics: () => [
          "mode=http-only",
          "Unrecognized mobile Tauri surface uses the platform transport; Android and iOS use the shared WebView thin runtime",
        ],
        thinProfileConfigured: false,
        requiresOnboarding: false,
        pendingThinInviteText: null,
        modePreferenceStore: secureModePreferenceStore(
          nativeTransport,
          "Tauri secure storage for mobile native mode preference",
        ),
        sidecarStatus: async () => null,
        startSidecar: async () => null,
        stopSidecar: async () => null,
        nativePermissionStatus: () =>
          nativeTransport.getNativePermissionStatus(),
        trayStatus: async () => null,
        notificationStatus: () => nativeTransport.getNotificationStatus(),
        iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
        iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
        iosLocalLightInferenceStatus: () =>
          nativeTransport.getIosLocalLightInferenceStatus(),
        iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
        dialogStatus: () => nativeTransport.getDialogStatus(),
        audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
        iosSecureStorageStatus: () =>
          nativeTransport.getIosSecureStorageStatus(),
        iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
        androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
        androidForegroundStatus: async () => null,
        androidMediaPolicyStatus: async () => null,
        dispose: async () => undefined,
        ...noopOverlayControls("mobile-native-runtime"),
        shutdown: async () => undefined,
      };
    }

    if (
      isPackagedDesktopThinRuntime() ||
      configuredProfile ||
      configuredGatewayUrl ||
      thinConnectionMode !== "http-only"
    ) {
      const thinRuntime = createTauriWebThinRuntime({
        mode: thinConnectionMode,
        gatewayUrl: configuredGatewayUrl,
        signalingUrl: configuredProfile?.signalingUrl,
        webrtcProfile: configuredProfile?.webrtcProfile,
        inviteText: thinInviteText,
        runtimeMode: "desktop-thin",
        nodeName:
          configuredProfile?.nodeName ||
          "Aurora Tauri desktop thin shell",
        localStablePeerId: configuredProfile?.localStablePeerId,
      });
      return {
        client: thinRuntime.client,
        mode: "desktop-thin",
        thinConnectionMode,
        thinPeer: thinRuntime.peer,
        thinDiagnostics: () =>
          explainTauriThinRuntime(
            thinConnectionMode,
            configuredGatewayUrl,
            configuredProfile?.signalingUrl,
            thinInviteText,
        ),
        thinProfile: configuredProfile,
        thinProfileConfigured,
        requiresOnboarding: !thinProfileConfigured,
        pendingThinInviteText: thinInviteText,
        thinProfileController,
        modePreferenceStore: memoryOnlyModePreferenceStore(
          "Desktop-thin mode preference is runtime/profile selected; no generic secure-storage permission",
        ),
        sidecarStatus: async () => null,
        startSidecar: async () => null,
        stopSidecar: async () => null,
        nativePermissionStatus: () =>
          nativeTransport.getNativePermissionStatus(),
        trayStatus: () => nativeTransport.getTrayStatus(),
        notificationStatus: () => nativeTransport.getNotificationStatus(),
        iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
        iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
        iosLocalLightInferenceStatus: () =>
          nativeTransport.getIosLocalLightInferenceStatus(),
        iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
        dialogStatus: () => nativeTransport.getDialogStatus(),
        audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
        iosSecureStorageStatus: () =>
          nativeTransport.getIosSecureStorageStatus(),
        iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
        androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
        androidForegroundStatus: async () => null,
        androidMediaPolicyStatus: async () => null,
        dispose: () => thinRuntime.close(),
        ...tauriOverlayControls(),
        shutdown: async () => {
          await thinRuntime.close();
          await invoke<void>("aurora_shutdown");
        },
      };
    }

    return {
      client: new AuroraClient({ transport: nativeTransport }),
      mode: "desktop-local",
      thinConnectionMode: DEFAULT_THIN_CONNECTION_MODE,
      thinDiagnostics: () => [
        "mode=http-only",
        "desktop-local preserves Rust-supervised Python sidecar and STTCoordinator wakeword ownership",
      ],
      thinProfileConfigured: false,
      requiresOnboarding: false,
      pendingThinInviteText: null,
      modePreferenceStore: secureModePreferenceStore(
        nativeTransport,
        "Tauri secure storage for desktop local mode preference",
      ),
      sidecarStatus: () => nativeTransport.getSidecarStatus(),
      startSidecar: () => nativeTransport.startSidecar(),
      stopSidecar: () => nativeTransport.stopSidecar(),
      nativePermissionStatus: () => nativeTransport.getNativePermissionStatus(),
      trayStatus: () => nativeTransport.getTrayStatus(),
      notificationStatus: () => nativeTransport.getNotificationStatus(),
      iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
      iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
      iosLocalLightInferenceStatus: () =>
        nativeTransport.getIosLocalLightInferenceStatus(),
      iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
      dialogStatus: () => nativeTransport.getDialogStatus(),
      audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
      iosSecureStorageStatus: () => nativeTransport.getIosSecureStorageStatus(),
      iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
      androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
      androidForegroundStatus: async () => null,
      androidMediaPolicyStatus: async () => null,
      dispose: async () => undefined,
      ...tauriOverlayControls(),
      shutdown: () => invoke<void>("aurora_shutdown"),
    };
  }

  const gatewayUrl = configuredGatewayUrl;
  if (gatewayUrl || thinConnectionMode !== "http-only") {
    const thinRuntime = createTauriWebThinRuntime({
      mode: thinConnectionMode,
      gatewayUrl,
      signalingUrl: configuredProfile?.signalingUrl,
      webrtcProfile: configuredProfile?.webrtcProfile,
      inviteText: thinInviteText,
      runtimeMode: "desktop-thin",
      nodeName:
        configuredProfile?.nodeName ||
        "Aurora Tauri browser preview thin shell",
      localStablePeerId: configuredProfile?.localStablePeerId,
    });
    return {
      client: thinRuntime.client,
      mode: "desktop-thin",
      thinConnectionMode,
      thinPeer: thinRuntime.peer,
      thinDiagnostics: () =>
        explainTauriThinRuntime(
          thinConnectionMode,
          gatewayUrl,
          configuredProfile?.signalingUrl,
          thinInviteText,
      ),
      thinProfile: configuredProfile,
      thinProfileConfigured,
      requiresOnboarding: !thinProfileConfigured,
      pendingThinInviteText: thinInviteText,
      thinProfileController,
      modePreferenceStore: memoryOnlyModePreferenceStore(
        "browser thin mode preference is memory-only; no web storage persistence",
      ),
      sidecarStatus: async () => null,
      startSidecar: async () => null,
      stopSidecar: async () => null,
      nativePermissionStatus: async () => null,
      trayStatus: async () => null,
      notificationStatus: async () => null,
      iosVoiceStatus: async () => null,
      iosInvocationStatus: async () => null,
      iosLocalLightInferenceStatus: async () => null,
      iosBackgroundStatus: async () => null,
      dialogStatus: async () => null,
      audioBridgeStatus: async () => null,
      iosSecureStorageStatus: async () => null,
      iosBiometricStatus: async () => null,
      androidBaselineStatus: async () => null,
      androidForegroundStatus: async () => null,
      androidMediaPolicyStatus: async () => null,
      dispose: () => thinRuntime.close(),
      ...noopOverlayControls(),
      shutdown: () => thinRuntime.close(),
    };
  }

  return {
    client: new AuroraClient({ transport: new MockAuroraTransport() }),
    mode: "mock",
    thinConnectionMode: DEFAULT_THIN_CONNECTION_MODE,
    thinDiagnostics: () => [
      "mode=http-only",
      "mock/offline demo transport; no live Gateway, WebRTC peer, or sidecar",
    ],
    thinProfileConfigured: false,
    requiresOnboarding: false,
    pendingThinInviteText: null,
    modePreferenceStore: memoryOnlyModePreferenceStore(
      "mock/offline demo mode preference is memory-only fixture state",
    ),
    sidecarStatus: async () => null,
    startSidecar: async () => null,
    stopSidecar: async () => null,
    nativePermissionStatus: async () => null,
    trayStatus: async () => null,
    notificationStatus: async () => null,
    iosVoiceStatus: async () => null,
    iosInvocationStatus: async () => null,
    iosLocalLightInferenceStatus: async () => null,
    iosBackgroundStatus: async () => null,
    dialogStatus: async () => null,
    audioBridgeStatus: async () => null,
    iosSecureStorageStatus: async () => null,
    iosBiometricStatus: async () => null,
    androidBaselineStatus: async () => null,
    androidForegroundStatus: async () => null,
    androidMediaPolicyStatus: async () => null,
    dispose: async () => undefined,
    ...noopOverlayControls(),
    shutdown: async () => undefined,
  };
}


export type TauriInvokeFunction = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriPeerCredentialCommandInvoker(
  baseInvoke: TauriInvokeFunction = invoke,
): (command: string, payload?: Record<string, unknown>) => Promise<unknown> {
  return (command, payload) => baseInvoke(command, { request: payload ?? {} });
}

function createTauriNativePeerCredentialStore(): WebRtcPeerCredentialStore & {
  setRoomSecret(ref: string, value: string): void;
  getRoomSecret(ref: string): Promise<Uint8Array | null>;
} {
  return new TauriRoomSecretNativeCredentialStore(
    new NativePeerCredentialStore({ invoke: createTauriPeerCredentialCommandInvoker() }),
  );
}

class TauriRoomSecretNativeCredentialStore implements WebRtcPeerCredentialStore {
  private readonly roomSecrets = new Map<string, Uint8Array>();
  private pendingRoomSecretWrites: Promise<void> = Promise.resolve();

  constructor(private readonly nativeStore: NativePeerCredentialStore) {}

  setRoomSecret(ref: string, value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.roomSecrets.get(ref)?.fill(0);
    this.roomSecrets.set(ref, bytes);
    this.pendingRoomSecretWrites = this.pendingRoomSecretWrites
      .catch(() => undefined)
      .then(() => persistTauriRoomSecret(ref, value));
  }

  async getRoomSecret(ref: string): Promise<Uint8Array | null> {
    const value = this.roomSecrets.get(ref);
    if (value) return new Uint8Array(value);
    await this.pendingRoomSecretWrites.catch(() => undefined);
    const stored = await invoke<{ value?: string | null }>(
      "aurora_thin_room_secret_get",
      { request: { ref } },
    ).catch(() => null);
    const persisted = stored?.value;
    if (!persisted) return null;
    const bytes = new TextEncoder().encode(persisted);
    this.roomSecrets.set(ref, bytes);
    return new Uint8Array(bytes);
  }

  get(peerId: string): Promise<StoredPeerCredentialMetadata | undefined> {
    return this.nativeStore.get(peerId);
  }

  save(peerId: string, credential: MeshPeerCredentialRecord): Promise<StoredPeerCredentialMetadata> {
    return this.nativeStore.save(peerId, credential);
  }

  prove(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    return this.createReconnectProof(peerId, challenge);
  }

  createReconnectProof(peerId: string, challenge: MeshReconnectChallengeMessage): Promise<MeshReconnectProofMessage | undefined> {
    return this.nativeStore.createReconnectProof(peerId, challenge);
  }

  status(peerId: string): Promise<PeerCredentialStatus> {
    return this.nativeStore.status(peerId);
  }

  remove(peerId: string): Promise<void> {
    return this.nativeStore.remove(peerId);
  }

  async clear(): Promise<void> {
    await this.pendingRoomSecretWrites.catch(() => undefined);
    for (const value of this.roomSecrets.values()) value.fill(0);
    this.roomSecrets.clear();
  }

  async close(): Promise<void> {
    await this.clear();
    await this.nativeStore.close();
  }
}

async function persistTauriRoomSecret(
  ref: string,
  value: string,
): Promise<void> {
  const result = await invoke<{ ok?: boolean }>("aurora_thin_room_secret_set", {
    request: { ref, value },
  });
  if (!result.ok) {
    throw new Error("Thin-client room-secret persistence failed");
  }
}

function createTauriWebThinRuntime({
  mode,
  gatewayUrl,
  signalingUrl,
  webrtcProfile,
  inviteText,
  runtimeMode,
  nodeName,
  localStablePeerId,
}: {
  mode: AuroraThinConnectionMode;
  gatewayUrl?: string | undefined;
  signalingUrl?: string | undefined;
  webrtcProfile?: WebRtcPeerConnectionProfile | undefined;
  inviteText?: string | null | undefined;
  runtimeMode: string;
  nodeName: string;
  localStablePeerId?: string | undefined;
}): BrowserWebThinRuntime {
  let runtime: BrowserWebThinRuntime;
  runtime = createBrowserWebThinRuntime({
    mode,
    gatewayUrl,
    bearerToken: () => runtime.client.auth.bearerToken(),
    signalingUrl,
    profile: webrtcProfile,
    inviteText,
    rolloutFlags: tauriWebRtcRolloutFlags(),
    credentialStore:
      isDesktopTauriRuntime() ||
      isAndroidTauriRuntime() ||
      isIosTauriRuntime()
        ? createTauriNativePeerCredentialStore()
        : undefined,
    runtimeMode,
    nativePlatform: tauriNativePlatform(),
    nodeName,
    localStablePeerId,
    allowInsecureLoopback: truthy(
      import.meta.env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK,
    ),
    allowInsecureLoopbackSignaling: truthy(
      import.meta.env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK,
    ),
    visibilityDocument: typeof document === "undefined" ? undefined : document,
    windowLocation: typeof window === "undefined" ? undefined : window.location,
    createClient: (transport) => new AuroraClient({ transport }),
    createDemoClient: () =>
      new AuroraClient({ transport: new MockAuroraTransport() }),
  });
  if (webrtcProfile && mode !== "http-only") {
    queueMicrotask(() => {
      void runtime.peer.connect(webrtcProfile).catch(() => undefined);
    });
  }
  return runtime;
}

function explainTauriThinRuntime(
  mode: AuroraThinConnectionMode,
  gatewayUrl: string | undefined,
  signalingUrl: string | undefined,
  inviteText: string | null | undefined,
  runtimeMode = "desktop-thin",
  nativePlatform = tauriNativePlatform(),
): string[] {
  return explainBrowserThinRuntime({
    mode,
    gatewayUrl,
    signalingUrl,
    inviteText,
    rolloutFlags: tauriWebRtcRolloutFlags(),
    allowInsecureLoopback: truthy(
      import.meta.env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK,
    ),
    allowInsecureLoopbackSignaling: truthy(
      import.meta.env.VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK,
    ),
    runtimeMode,
    nativePlatform,
  });
}

function createDynamicHttpClient(baseUrl: string): AuroraClient {
  let client!: AuroraClient;
  const transport = new HttpGatewayTransport({
    baseUrl,
    bearerToken: () => client.auth.bearerToken(),
  });
  client = new AuroraClient({ transport });
  return client;
}

function tauriOverlayControls(): Pick<
  AuroraTauriRuntime,
  | "overlayShow"
  | "overlayHide"
  | "overlayStatus"
  | "overlaySetPassthrough"
  | "overlayStartDrag"
  | "overlayMoveBy"
  | "overlayRegisterHotkey"
  | "overlayUnregisterHotkey"
  | "listenOverlayMode"
> {
  return {
    overlayShow: (mode) =>
      invokeOverlayCommand("aurora_overlay_show", { mode }),
    overlayHide: () => invokeOverlayCommand("aurora_overlay_hide"),
    overlayStatus: () => invokeOverlayCommand("aurora_overlay_status"),
    overlaySetPassthrough: (enabled) =>
      invokeOverlayCommand("aurora_overlay_set_passthrough", { enabled }),
    overlayStartDrag: () => invokeOverlayCommand("aurora_overlay_start_drag"),
    overlayMoveBy: (dx, dy) =>
      invokeOverlayCommand("aurora_overlay_move_by", { dx, dy }),
    overlayRegisterHotkey: (accelerator) =>
      invokeOverlayCommand("aurora_overlay_register_hotkey", { accelerator }),
    overlayUnregisterHotkey: () =>
      invokeOverlayCommand("aurora_overlay_unregister_hotkey"),
    listenOverlayMode: (handler) =>
      listen<unknown>("aurora://overlay-mode", (event) =>
        handler(event.payload),
      ),
  };
}

function noopOverlayControls(
  reason = "not-tauri-runtime",
): Pick<
  AuroraTauriRuntime,
  | "overlayShow"
  | "overlayHide"
  | "overlayStatus"
  | "overlaySetPassthrough"
  | "overlayStartDrag"
  | "overlayMoveBy"
  | "overlayRegisterHotkey"
  | "overlayUnregisterHotkey"
  | "listenOverlayMode"
> {
  const unavailable = {
    ok: false,
    available: false,
    disabled: true,
    visible: false,
    hotkeyRegistered: false,
    reason,
  };

  return {
    overlayShow: async (mode) => ({ ...unavailable, mode, visible: false }),
    overlayHide: async () => ({
      ...unavailable,
      mode: "hidden",
      visible: false,
    }),
    overlayStatus: async () => ({
      ...unavailable,
      mode: "hidden",
      visible: false,
    }),
    overlaySetPassthrough: async (enabled) => ({
      ...unavailable,
      pointerPassthrough: enabled,
    }),
    overlayStartDrag: async () => ({ ...unavailable }),
    overlayMoveBy: async () => ({ ...unavailable }),
    overlayRegisterHotkey: async (accelerator) => ({
      ...unavailable,
      accelerator,
    }),
    overlayUnregisterHotkey: async () => ({ ...unavailable, mode: "hidden" }),
    listenOverlayMode: async () => () => undefined,
  };
}

async function invokeOverlayCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<AuroraOverlayCommandStatus | null> {
  try {
    return await invoke<AuroraOverlayCommandStatus | null>(command, args);
  } catch (error) {
    if (isUnavailableOverlayCommandError(error)) return null;
    console.warn(`Aurora overlay command failed: ${command}`, error);
    return null;
  }
}

function isUnavailableOverlayCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /command.+not found|unknown command|not allowed|permission denied|missing/i.test(
    message,
  );
}

function secureModePreferenceStore(
  transport: TauriLocalTransport,
  evidence: string,
): AuroraModePreferenceStore {
  return {
    evidence,
    readSelectedMode: async () => {
      const result = await transport.secureStorageGet(ONBOARDING_MODE_KEY);
      return result.value;
    },
    writeSelectedMode: async (modeId: string) => {
      const result = await transport.secureStorageSet(
        ONBOARDING_MODE_KEY,
        modeId,
      );
      return result.ok;
    },
  };
}

function memoryOnlyModePreferenceStore(
  evidence: string,
): AuroraModePreferenceStore {
  let selectedMode: string | null = null;
  return {
    evidence,
    readSelectedMode: async () => selectedMode,
    writeSelectedMode: async (modeId: string) => {
      selectedMode = modeId;
      return true;
    },
  };
}

function secureThinProfileStore(
  _transport: TauriLocalTransport,
): AuroraThinProfileStore {
  const fallback = defaultThinProfileDocument();
  return {
    evidence:
      "Tauri narrow nonsecret thin-client connection profile storage",
    load: async () => {
      const result = await invoke<{ value?: string | null }>(
        "aurora_thin_profile_get",
      );
      return parseThinProfileDocument(result.value) ?? fallback;
    },
    save: async (document) => {
      const result = await invoke<{ ok?: boolean }>("aurora_thin_profile_set", {
        value: serializeThinProfileDocument(document),
      });
      if (!result.ok)
        throw new Error("Thin-client connection profile save failed");
    },
  };
}

export function createMemoryThinProfileStore(
  initial = defaultThinProfileDocument(),
): AuroraThinProfileStore {
  let serialized = serializeThinProfileDocument(initial);
  return {
    evidence:
      "browser preview desktop-thin profiles are memory-only; no web storage persistence",
    load: async () => parseThinProfileDocument(serialized) ?? initial,
    save: async (document) => {
      serialized = serializeThinProfileDocument(document);
    },
  };
}

function createThinProfileController(
  store: AuroraThinProfileStore,
  document: AuroraThinProfileDocument,
): AuroraThinProfileController {
  return {
    evidence: store.evidence,
    document,
    saveProfile: async (profile, roomSecret) => {
      const sanitized = sanitizeThinConnectionProfile(profile);
      if (roomSecret) {
        if (
          sanitized.webrtcProfile?.roomSecretRef !== roomSecret.roomSecretRef
        ) {
          throw new Error(
            "Thin-client room secret does not match the saved WebRTC profile",
          );
        }
        await persistTauriRoomSecret(
          roomSecret.roomSecretRef,
          roomSecret.roomSecret,
        );
      }
      const profiles = document.profiles.filter(
        (candidate) => candidate.id !== sanitized.id,
      );
      const next: AuroraThinProfileDocument = {
        version: 1,
        activeProfileId: sanitized.id,
        profiles: [...profiles, sanitized],
      };
      await store.save(next);
      return next;
    },
    selectProfile: async (profileId) => {
      if (!document.profiles.some((profile) => profile.id === profileId))
        throw new Error("Desktop-thin connection profile does not exist");
      const next = { ...document, activeProfileId: profileId };
      await store.save(next);
      return next;
    },
    createRuntime: (next) =>
      createAuroraTauriRuntime({
        thinProfileStore: store,
        thinProfileDocument: next,
      }),
  };
}

export function serializeThinProfileDocument(
  document: AuroraThinProfileDocument,
): string {
  return serializeSharedThinProfileDocument(document);
}

export function parseThinProfileDocument(
  value: string | null | undefined,
): AuroraThinProfileDocument | null {
  return parseSharedThinProfileDocument(value);
}

function activeThinProfile(
  document: AuroraThinProfileDocument | undefined,
): AuroraThinConnectionProfile | undefined {
  return activeThinConnectionProfile(document);
}

function defaultThinProfileDocument(): AuroraThinProfileDocument {
  return emptyThinProfileDocument();
}

function thinSurfaceDefaults(): {
  label: string;
  nodeName: string;
  localStablePeerId: string;
} {
  const surface = currentAuroraSurfaceProfile();
  if (surface.isAndroid) {
    return {
      label: "Android thin",
      nodeName: "Aurora Android thin",
      localStablePeerId: "aurora-android-thin",
    };
  }
  if (surface.isIos) {
    return {
      label: "iOS thin",
      nodeName: "Aurora iOS thin",
      localStablePeerId: "aurora-ios-thin",
    };
  }
  return {
    label: "Desktop thin",
    nodeName: "Aurora desktop thin",
    localStablePeerId: "aurora-desktop-thin",
  };
}

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

function isPackagedDesktopThinRuntime(): boolean {
  return (
    isDesktopTauriRuntime() &&
    import.meta.env.VITE_AURORA_RUNTIME_MODE === "desktop-thin"
  );
}

function isDesktopTauriRuntime(): boolean {
  return isTauriRuntime() && !isMobileTauriRuntime();
}

function isMobileTauriRuntime(): boolean {
  return currentAuroraSurfaceProfile().isMobile;
}

function isAndroidTauriRuntime(): boolean {
  return currentAuroraSurfaceProfile().isAndroid;
}

function isIosTauriRuntime(): boolean {
  return currentAuroraSurfaceProfile().isIos;
}

function tauriNativePlatform(): string {
  const profile = currentAuroraSurfaceProfile();
  if (profile.isAndroid) return "android";
  if (profile.isIos) return "ios";
  return "desktop";
}

function currentAuroraSurfaceProfile() {
  return getAuroraSurfaceProfile({
    runtimeMode: import.meta.env.VITE_AURORA_RUNTIME_MODE,
    transportKind: DEFAULT_THIN_CONNECTION_MODE,
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
  });
}

async function androidForegroundStatus(): Promise<AndroidForegroundRuntimeStatus | null> {
  if (!isAndroidTauriRuntime()) return null;
  const native = await optionalInvoke<{
    platform?: string;
    foreground?: boolean;
    focused?: boolean;
    mustReleaseMicrophone?: boolean;
    reason?: string;
    evidenceSource?: string;
  }>("aurora_android_lifecycle_status", { request: {} });
  if (native) {
    const foreground = Boolean(native.foreground);
    const focused = Boolean(native.focused);
    return {
      platform: "android",
      foreground,
      visible: foreground,
      focused,
      source: typeof native.evidenceSource === "string" ? native.evidenceSource : "androidLifecycleStatus",
      ...(typeof native.reason === "string" ? { reason: native.reason } : {}),
    };
  }
  return {
    platform: "android",
    foreground: typeof document === "undefined" || document.visibilityState !== "hidden",
    visible: typeof document === "undefined" || document.visibilityState !== "hidden",
    focused: typeof document === "undefined" || document.hasFocus(),
    source: "webview-visibility-fallback; expected command aurora_android_lifecycle_status",
    reason: "Native lifecycle command unavailable; using WebView visibility only.",
  };
}

async function androidMediaPolicyStatus(): Promise<AndroidMediaPolicyStatus | null> {
  if (!isAndroidTauriRuntime()) return null;
  const foreground = await androidForegroundStatus();
  const origin = currentWebViewOrigin();
  const native = await optionalInvoke<{
    grant?: boolean;
    reason?: string;
    foreground?: boolean;
    focused?: boolean;
    evidenceSource?: string;
  }>("aurora_android_webview_microphone_permission_decision", {
    request: {
      origin,
      resources: ["android.webkit.resource.AUDIO_CAPTURE"],
      configuredHttpsOrigins: configuredHttpsOrigins(),
      foreground: foreground?.foreground ?? false,
      focused: foreground?.focused ?? false,
    },
  });
  if (native) {
    return {
      platform: "android",
      microphoneAllowedInForeground: Boolean(native.grant),
      backgroundWakewordAllowed: false,
      source: typeof native.evidenceSource === "string" ? native.evidenceSource : "aurora_android_webview_microphone_permission_decision",
      ...(typeof native.reason === "string" ? { reason: native.reason } : {}),
    };
  }
  const voice = await optionalInvoke<{
    startable?: boolean;
    reason?: string;
    evidenceSource?: string;
  }>("aurora_android_voice_foreground_service_status", { request: {} });
  if (voice) {
    return {
      platform: "android",
      microphoneAllowedInForeground: Boolean(voice.startable),
      backgroundWakewordAllowed: false,
      source: typeof voice.evidenceSource === "string" ? voice.evidenceSource : "aurora_android_voice_foreground_service_status",
      ...(typeof voice.reason === "string" ? { reason: voice.reason } : {}),
    };
  }
  return {
    platform: "android",
    microphoneAllowedInForeground: false,
    backgroundWakewordAllowed: false,
    source: "webview-media-policy-fallback; expected commands aurora_android_webview_microphone_permission_decision/aurora_android_voice_foreground_service_status",
    reason: "Native media policy commands unavailable; focused microphone is denied until native foreground policy is available.",
  };
}

function currentWebViewOrigin(): string {
  if (typeof window === "undefined") return "https://tauri.localhost";
  if (window.location.origin && window.location.origin !== "null") return window.location.origin;
  return "https://tauri.localhost";
}

function configuredHttpsOrigins(): string[] {
  return ["https://tauri.localhost"];
}

async function optionalInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isUnavailableOverlayCommandError(error)) return null;
    console.warn(`Aurora optional native command failed: ${command}`, error);
    return null;
  }
}

export function installAndroidLifecyclePolicy(
  _runtime: BrowserWebThinRuntime,
): () => Promise<void> {
  if (!isTauriRuntime() || !isAndroidTauriRuntime()) return async () => undefined;
  let closed = false;
  const listener = addPluginListener<AndroidLifecyclePluginPayload>(
    ANDROID_NATIVE_PLUGIN_NAME,
    ANDROID_LIFECYCLE_EVENT,
    (payload) => {
      if (closed) return;
      const mustRelease = payload.mustReleaseMicrophone === true || payload.foreground === false || payload.focused === false;
      if (mustRelease) {
        window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT));
      }
    },
  ).catch((error) => {
    if (!closed && !isUnavailableOverlayCommandError(error)) {
      console.warn("Android lifecycle plugin listener unavailable; relying on WebView visibility fallback", error);
    }
    return null;
  });
  return async () => {
    closed = true;
    try {
      await (await listener)?.unregister();
    } catch {
      // Native lifecycle listener support is optional in browser/test shells.
    }
  };
}

interface AndroidLifecyclePluginPayload {
  foreground?: boolean;
  focused?: boolean;
  mustReleaseMicrophone?: boolean;
  backgroundWakeword?: false;
  reason?: string;
}

function tauriWebRtcRolloutFlags(): AuroraWebRtcRolloutFlags {
  return {
    webrtc_thin_client: enabledUnlessExplicitlyFalse(
      import.meta.env.VITE_AURORA_WEBRTC_THIN_CLIENT,
    ),
    webrtc_scoped_subscriptions: enabledUnlessExplicitlyFalse(
      import.meta.env.VITE_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS,
    ),
    webrtc_fragmentation: enabledUnlessExplicitlyFalse(
      import.meta.env.VITE_AURORA_WEBRTC_FRAGMENTATION,
    ),
    webrtc_app_layer_e2ee: enabledUnlessExplicitlyFalse(
      import.meta.env.VITE_AURORA_WEBRTC_APP_LAYER_E2EE,
    ),
  };
}

function enabledUnlessExplicitlyFalse(value: string | undefined): boolean {
  return !["0", "false", "no", "off"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

function consumeFragmentInviteFromRuntime(): string | null {
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


function truthy(value: string | undefined): boolean {
  return (
    value === "1" ||
    value?.toLowerCase() === "true" ||
    value?.toLowerCase() === "yes"
  );
}
