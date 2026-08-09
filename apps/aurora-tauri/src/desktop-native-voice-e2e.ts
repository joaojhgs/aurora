import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const HOOK_NAME = "__AURORA_DESKTOP_NATIVE_VOICE_E2E__";
const HOOK_PAYLOAD_SCHEMA = "aurora.desktop_native_voice_e2e.hook_payload.v1";
const REPORT_SCHEMA = "aurora.desktop_native_voice_e2e.webview_report.v1";
const STATUS_EVENT = "aurora://native-voice-status";
const DESKTOP_RUNTIME_PROFILE_KEY = "aurora.session.desktop-thin-connection-profiles.v1";
const REMOTE_AUDIO_CONSENT_REASON = "remote_audio_consent_required";
const FORBIDDEN_TEXT_RE =
  /\b(?:transcript|rawAudio|audioData|audio_data|authorization|bearer|token|leaseId|lease_id|endpoint|gatewayUrl|modelPath|getUserMedia|Worker)\b/iu;
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

type DesktopNativeVoiceE2eWindow = Window & {
  __AURORA_DESKTOP_NATIVE_VOICE_E2E__?: (
    payload: unknown,
  ) => Promise<DesktopNativeVoiceE2eReport>;
  __AURORA_DESKTOP_NATIVE_VOICE_E2E_READY__?: true;
};

export type NativeVoicePhase =
  | "unavailable"
  | "idle"
  | "starting"
  | "listening"
  | "processing"
  | "speaking"
  | "stopping"
  | "faulted";

export type NativeVoiceStatus = {
  available: boolean;
  phase: NativeVoicePhase;
  generation: number | null;
  backgroundEligible: boolean;
  connection: "this_device" | "connected_device" | "unavailable";
  reasonCode: string | null;
  redacted: true;
};

export type NativeVoiceEvent = {
  sequence: number;
  status: NativeVoiceStatus;
};

type SidecarSession = { token: string };
type SidecarStatus = { running: boolean };
type SecureStorageGet = { value: string | null; secretsRedacted: true };
type SecureStorageWrite = { ok: true; secretsRedacted: true };

export type NativeVoiceTurnLabel = "completed" | "cancelled";
export type NativeVoiceRouteScenarioName =
  | "remote-console-without-sidecar"
  | "remote-console-with-running-sidecar"
  | "mesh-node-python-full-with-sidecar";

export type NativeVoiceRouteScenarioSummary = {
  name: NativeVoiceRouteScenarioName;
  persistedNodeMode: "remote-console" | "mesh-node";
  persistedRuntimeTier: "none" | "python-full";
  sidecarRunning: boolean;
  expectedScope: "remote-gateway" | "loopback-sidecar";
  observedConnection: NativeVoiceStatus["connection"];
  observedAvailable: boolean;
  observedReasonCode: string | null;
  startBlockedReasonCode: string | null;
  redacted: true;
};

export type NativeVoiceEventSummary = {
  sequence: number;
  phase: NativeVoicePhase;
  reasonCode: string | null;
  turn: NativeVoiceTurnLabel | "unknown";
  redacted: true;
};

export type NativeVoiceLifecycleSummary = {
  turn: NativeVoiceTurnLabel;
  startObserved: true;
  terminalObserved: true;
  eventCount: number;
  phases: NativeVoicePhase[];
};

export type DesktopNativeVoiceE2ePayload = {
  schema: typeof HOOK_PAYLOAD_SCHEMA;
  sessionNonce: string;
  tauriPid: string;
  expectedGatewayOrigin: string;
  reportPath?: string | undefined;
  donePath?: string | undefined;
  timeoutMs?: number | undefined;
};

export type DesktopNativeVoiceE2eReport = {
  schema: typeof REPORT_SCHEMA;
  status: "passed";
  sessionNonceDigest: string;
  tauriPidDigest: string;
  secretsRedacted: true;
  noWebViewMicrophone: true;
  noWebViewModelLoads: true;
  noBrowserWorkers: true;
  desktopResult: {
    completedTurn: NativeVoiceLifecycleSummary;
    cancelledTurn: NativeVoiceLifecycleSummary;
    statusSequence: NativeVoiceEventSummary[];
    monotonicStatuses: true;
    distinctGenerations: true;
    commands: string[];
    windowHidden: boolean;
    sidecarLoopback: true;
    routeScenarios: NativeVoiceRouteScenarioSummary[];
    persistedRoleSource: "runtime-profile";
    forbiddenWebViewCalls: [];
    reportHash: string;
  };
  durationMs: number;
};

type NativeVoiceInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeVoiceListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<UnlistenFn>;

type HookInstallOptions = {
  target?: DesktopNativeVoiceE2eWindow | undefined;
  env?: Record<string, unknown> | undefined;
  bridge?: {
    invoke?: NativeVoiceInvoke | undefined;
    listen?: NativeVoiceListen | undefined;
    hideWindow?: (() => Promise<void>) | undefined;
    now?: (() => number) | undefined;
    hash?: ((value: string) => Promise<string>) | undefined;
  } | undefined;
};

type WebViewGuards = {
  calls: string[];
  restore(): void;
};
type GuardedWindow = Window & {
  Worker: typeof Worker;
  SharedWorker: typeof SharedWorker;
};

export function isDesktopNativeVoiceE2eHookEnabled(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return Boolean(
    env.VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E === "1" &&
      env.VITE_AURORA_TAURI_DEV_AUTOSIDECAR === "0",
  );
}

export function installDesktopNativeVoiceE2eHook(
  options: HookInstallOptions = {},
): boolean {
  const target = options.target ?? (window as DesktopNativeVoiceE2eWindow);
  if (!isDesktopNativeVoiceE2eHookEnabled(options.env)) return false;
  const bridge = {
    invoke: options.bridge?.invoke ?? invoke,
    listen: options.bridge?.listen ?? listen,
    hideWindow: options.bridge?.hideWindow ?? (() => getCurrentWindow().hide()),
    now: options.bridge?.now ?? (() => Date.now()),
    hash: options.bridge?.hash ?? sha256Hex,
  };
  target[HOOK_NAME] = async (payload: unknown) =>
    runDesktopNativeVoiceE2e(validateDesktopNativeVoiceE2ePayload(payload), bridge, target);
  target.__AURORA_DESKTOP_NATIVE_VOICE_E2E_READY__ = true;
  return true;
}

export function validateDesktopNativeVoiceE2ePayload(
  payload: unknown,
): DesktopNativeVoiceE2ePayload {
  if (!payload || typeof payload !== "object") throw new Error("payload is required");
  const value = payload as Record<string, unknown>;
  if (value.schema !== HOOK_PAYLOAD_SCHEMA) throw new Error("schema is invalid");
  const sessionNonce = requireBoundedString(value.sessionNonce, "sessionNonce", 8, 256);
  const tauriPid = requireBoundedString(value.tauriPid, "tauriPid", 1, 20);
  if (!/^[1-9]\d{0,19}$/u.test(tauriPid)) throw new Error("tauriPid is invalid");
  const expectedGatewayOrigin = requireLoopbackOrigin(value.expectedGatewayOrigin);
  const timeoutMs = value.timeoutMs === undefined
    ? undefined
    : requirePositiveInteger(value.timeoutMs, "timeoutMs", 1_000, 180_000);
  return {
    schema: HOOK_PAYLOAD_SCHEMA,
    sessionNonce,
    tauriPid,
    expectedGatewayOrigin,
    reportPath: optionalBoundedPath(value.reportPath, "reportPath"),
    donePath: optionalBoundedPath(value.donePath, "donePath"),
    timeoutMs,
  };
}

export function assertNativeVoiceStatusRedacted(status: NativeVoiceStatus): void {
  const keys = Object.keys(status).sort();
  const allowed = [
    "available",
    "backgroundEligible",
    "connection",
    "generation",
    "phase",
    "reasonCode",
    "redacted",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
    throw new Error("native voice status contains unexpected fields");
  }
  if (status.redacted !== true) throw new Error("native voice status must be redacted");
  if (FORBIDDEN_TEXT_RE.test(JSON.stringify(status))) {
    throw new Error("native voice status contains sensitive material");
  }
}

export function summarizeNativeVoiceEvents(
  events: NativeVoiceEvent[],
  generationLabels = new Map<number, NativeVoiceTurnLabel>(),
): NativeVoiceEventSummary[] {
  if (events.length === 0) throw new Error("native voice status events are required");
  let lastSequence = 0;
  return events.map((event) => {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
      throw new Error("native voice status events are not monotonic");
    }
    lastSequence = event.sequence;
    assertNativeVoiceStatusRedacted(event.status);
    return {
      sequence: event.sequence,
      phase: event.status.phase,
      reasonCode: event.status.reasonCode,
      turn: event.status.generation === null
        ? "unknown"
        : generationLabels.get(event.status.generation) ?? "unknown",
      redacted: true,
    };
  });
}

async function runDesktopNativeVoiceE2e(
  payload: DesktopNativeVoiceE2ePayload,
  bridge: Required<NonNullable<HookInstallOptions["bridge"]>>,
  target: DesktopNativeVoiceE2eWindow,
): Promise<DesktopNativeVoiceE2eReport> {
  const startedAt = bridge.now();
  const guards = installWebViewGuards(target);
  const events: NativeVoiceEvent[] = [];
  let unlisten: UnlistenFn | undefined;
  let sidecarCommandToken: { token: string } | undefined;
  let sidecarStopped = false;
  let savedProfile: string | null | undefined;
  const invokeNative = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await bridge.invoke<T>(command, args);
    } catch (error) {
      const detail = typeof error === "object" && error !== null
        ? JSON.stringify(Object.fromEntries(
          ["code", "reasonCode", "kind", "status"].flatMap((key) => {
            const value = (error as Record<string, unknown>)[key];
            return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? [[key, value]]
              : [];
          }),
        ))
        : String(error);
      throw new Error(`native voice command ${command} failed: ${detail}`);
    }
  };
  try {
    await bridge.hideWindow();
    const stepTimeoutMs = payload.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    unlisten = await bridge.listen<NativeVoiceEvent>(STATUS_EVENT, (event) => {
      const parsed = parseNativeVoiceEvent(event.payload);
      events.push(parsed);
    });
    savedProfile = await readPersistedRuntimeProfile(bridge.invoke);
    await persistRuntimeProfile(
      bridge.invoke,
      remoteConsoleProfileDocument("remote-no-sidecar", "home-peer-remote"),
    );
    const remoteWithoutSidecar = await summarizeBlockedRemoteScenario(
      bridge.invoke,
      "remote-console-without-sidecar",
      false,
    );
    const sidecarSession = await bridge.invoke<SidecarSession>("aurora_sidecar_session");
    sidecarCommandToken = {
      token: requireBoundedString(sidecarSession.token, "sidecar session", 16, 512),
    };
    const sidecarStarted = await bridge.invoke<SidecarStatus>("aurora_sidecar_start", {
      commandToken: sidecarCommandToken,
    });
    if (sidecarStarted.running !== true) throw new Error("managed sidecar did not start");
    await persistRuntimeProfile(
      bridge.invoke,
      remoteConsoleProfileDocument("remote-with-sidecar", "home-peer-running-sidecar"),
    );
    const remoteWithSidecar = await summarizeBlockedRemoteScenario(
      bridge.invoke,
      "remote-console-with-running-sidecar",
      true,
    );
    await persistRuntimeProfile(
      bridge.invoke,
      meshNodePythonFullProfileDocument(payload.expectedGatewayOrigin),
    );
    const initial = await commandStatus(bridge.invoke);
    assertNativeVoiceStatusRedacted(initial);
    if (initial.connection !== "this_device" || initial.available !== true) {
      throw new Error("persisted mesh-node python-full profile did not select local native voice");
    }
    const completedStart = await invokeNative<NativeVoiceStatus>("aurora_native_voice_start", {
      request: {
        trigger: "focused_push_to_talk",
        remoteAudioConsent: false,
      },
    });
    assertNativeVoiceStatusRedacted(completedStart);
    if (typeof completedStart.generation !== "number") {
      throw new Error("completed native voice start did not return a generation");
    }
    await waitForEvent(events, completedStart.generation, ["starting"], stepTimeoutMs, bridge.now);
    await sleep(750);
    const completedTerminal = await invokeNative<NativeVoiceStatus>("aurora_native_voice_finish", {
      request: {
        generation: completedStart.generation,
        reason: "user_request",
      },
    });
    assertNativeVoiceStatusRedacted(completedTerminal);
    await waitForEvent(events, completedStart.generation, ["stopping"], stepTimeoutMs, bridge.now);
    await waitForIdle(bridge.invoke, stepTimeoutMs, bridge.now);

    const cancelledStart = await invokeNative<NativeVoiceStatus>("aurora_native_voice_start", {
      request: {
        trigger: "focused_push_to_talk",
        remoteAudioConsent: false,
      },
    });
    assertNativeVoiceStatusRedacted(cancelledStart);
    if (typeof cancelledStart.generation !== "number") {
      throw new Error("cancelled native voice start did not return a generation");
    }
    if (cancelledStart.generation === completedStart.generation) {
      throw new Error("native voice cancel lifecycle did not use a distinct generation");
    }
    await waitForEvent(events, cancelledStart.generation, ["starting"], stepTimeoutMs, bridge.now);
    await waitForEvent(events, cancelledStart.generation, ["listening"], stepTimeoutMs, bridge.now);
    await sleep(750);
    const cancelledFinish = await invokeNative<NativeVoiceStatus>("aurora_native_voice_finish", {
      request: {
        generation: cancelledStart.generation,
        reason: "user_request",
      },
    });
    assertNativeVoiceStatusRedacted(cancelledFinish);
    await waitForEvent(events, cancelledStart.generation, ["processing"], stepTimeoutMs, bridge.now);
    const beforeCancel = await commandStatus(bridge.invoke);
    if (beforeCancel.generation !== cancelledStart.generation ||
        !["processing", "speaking"].includes(beforeCancel.phase)) {
      throw new Error(`native voice cancellation precondition failed: ${JSON.stringify({
        phase: beforeCancel.phase,
        generation: beforeCancel.generation,
        expectedGeneration: cancelledStart.generation,
        recentEvents: events.slice(-12).map((event) => ({
          sequence: event.sequence,
          phase: event.status.phase,
          generation: event.status.generation,
          reasonCode: event.status.reasonCode,
        })),
      })}`);
    }
    const cancelledTerminal = await invokeNative<NativeVoiceStatus>("aurora_native_voice_cancel", {
      request: {
        generation: cancelledStart.generation,
        reason: "window_hidden",
      },
    });
    assertNativeVoiceStatusRedacted(cancelledTerminal);
    await waitForEvent(events, cancelledStart.generation, ["stopping"], stepTimeoutMs, bridge.now);
    await waitForIdle(bridge.invoke, stepTimeoutMs, bridge.now);
    const sidecarStoppedStatus = await bridge.invoke<SidecarStatus>("aurora_sidecar_stop", {
      commandToken: sidecarCommandToken,
    });
    if (sidecarStoppedStatus.running !== false) throw new Error("managed sidecar did not stop");
    sidecarStopped = true;
    if (guards.calls.length > 0) throw new Error("WebView voice/model path was used");
    const generationLabels = new Map<number, NativeVoiceTurnLabel>([
      [completedStart.generation, "completed"],
      [cancelledStart.generation, "cancelled"],
    ]);
    const statusSequence = summarizeNativeVoiceEvents(events, generationLabels);
    const completedTurn = summarizeLifecycle(statusSequence, "completed");
    const cancelledTurn = summarizeLifecycle(statusSequence, "cancelled");
    const routeScenarios: NativeVoiceRouteScenarioSummary[] = [
      remoteWithoutSidecar,
      remoteWithSidecar,
      {
        name: "mesh-node-python-full-with-sidecar",
        persistedNodeMode: "mesh-node",
        persistedRuntimeTier: "python-full",
        sidecarRunning: true,
        expectedScope: "loopback-sidecar",
        observedConnection: initial.connection,
        observedAvailable: initial.available,
        observedReasonCode: initial.reasonCode,
        startBlockedReasonCode: null,
        redacted: true,
      },
    ];
    assertRouteScenarios(routeScenarios);
    const reportWithoutHash: Omit<DesktopNativeVoiceE2eReport, "desktopResult"> & {
      desktopResult: Omit<DesktopNativeVoiceE2eReport["desktopResult"], "reportHash"> & {
        reportHash: "";
      };
    } = {
      schema: REPORT_SCHEMA,
      status: "passed" as const,
      sessionNonceDigest: await bridge.hash(payload.sessionNonce),
      tauriPidDigest: await bridge.hash(payload.tauriPid),
      secretsRedacted: true as const,
      noWebViewMicrophone: true as const,
      noWebViewModelLoads: true as const,
      noBrowserWorkers: true as const,
      durationMs: Math.max(0, bridge.now() - startedAt),
      desktopResult: {
        completedTurn,
        cancelledTurn,
        statusSequence,
        monotonicStatuses: true as const,
        distinctGenerations: true as const,
        commands: [
          "aurora_secure_storage_get",
          "aurora_secure_storage_set",
          "aurora_secure_storage_delete",
          "aurora_native_voice_status",
          "aurora_native_voice_start",
          "aurora_native_voice_finish",
          "aurora_native_voice_cancel",
        ],
        windowHidden: true,
        sidecarLoopback: true,
        routeScenarios,
        persistedRoleSource: "runtime-profile",
        forbiddenWebViewCalls: [] as [],
        reportHash: "",
      },
    };
    const reportHash = await bridge.hash(JSON.stringify(reportWithoutHash));
    const report = {
      ...reportWithoutHash,
      desktopResult: {
        ...reportWithoutHash.desktopResult,
        reportHash,
      },
    };
    assertReportHasNoSensitiveMaterial(report);
    return report;
  } finally {
    if (sidecarCommandToken && !sidecarStopped) {
      await bridge.invoke<SidecarStatus>("aurora_sidecar_stop", {
        commandToken: sidecarCommandToken,
      }).catch(() => undefined);
    }
    if (savedProfile !== undefined) {
      await restorePersistedRuntimeProfile(bridge.invoke, savedProfile).catch(() => undefined);
    }
    guards.restore();
    unlisten?.();
  }
}

async function readPersistedRuntimeProfile(invokeCommand: NativeVoiceInvoke): Promise<string | null> {
  const result = await invokeCommand<SecureStorageGet>("aurora_secure_storage_get", {
    key: DESKTOP_RUNTIME_PROFILE_KEY,
  });
  if (result.secretsRedacted !== true) throw new Error("profile storage read was not redacted");
  return result.value ?? null;
}

async function persistRuntimeProfile(
  invokeCommand: NativeVoiceInvoke,
  document: Record<string, unknown>,
): Promise<void> {
  const serialized = JSON.stringify(document);
  if (serialized.includes("VITE_AURORA_RUNTIME_MODE")) {
    throw new Error("runtime profile must not use an environment-selected role");
  }
  const result = await invokeCommand<SecureStorageWrite>("aurora_secure_storage_set", {
    key: DESKTOP_RUNTIME_PROFILE_KEY,
    value: serialized,
  });
  if (result.secretsRedacted !== true) throw new Error("profile storage write was not redacted");
}

async function restorePersistedRuntimeProfile(
  invokeCommand: NativeVoiceInvoke,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await invokeCommand<SecureStorageWrite>("aurora_secure_storage_delete", {
      key: DESKTOP_RUNTIME_PROFILE_KEY,
    });
    return;
  }
  await invokeCommand<SecureStorageWrite>("aurora_secure_storage_set", {
    key: DESKTOP_RUNTIME_PROFILE_KEY,
    value,
  });
}

async function summarizeBlockedRemoteScenario(
  invokeCommand: NativeVoiceInvoke,
  name: Extract<NativeVoiceRouteScenarioName, "remote-console-without-sidecar" | "remote-console-with-running-sidecar">,
  sidecarRunning: boolean,
): Promise<NativeVoiceRouteScenarioSummary> {
  const observed = await commandStatus(invokeCommand);
  assertNativeVoiceStatusRedacted(observed);
  const startBlockedReasonCode = await expectNativeVoiceStartBlocked(invokeCommand);
  return {
    name,
    persistedNodeMode: "remote-console",
    persistedRuntimeTier: "none",
    sidecarRunning,
    expectedScope: "remote-gateway",
    observedConnection: observed.connection,
    observedAvailable: observed.available,
    observedReasonCode: observed.reasonCode,
    startBlockedReasonCode,
    redacted: true,
  };
}

async function expectNativeVoiceStartBlocked(
  invokeCommand: NativeVoiceInvoke,
): Promise<string | null> {
  try {
    await invokeCommand<NativeVoiceStatus>("aurora_native_voice_start", {
      request: {
        trigger: "focused_push_to_talk",
        remoteAudioConsent: false,
      },
    });
  } catch (error) {
    return boundedReasonCodeFromError(error);
  }
  throw new Error("remote-console native voice start was not blocked without explicit consent");
}

function boundedReasonCodeFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  for (const key of ["reasonCode", "reason", "code", "status"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && /^[a-z0-9_]{1,128}$/u.test(value)) return value;
  }
  return null;
}

function assertRouteScenarios(scenarios: NativeVoiceRouteScenarioSummary[]): void {
  const names = scenarios.map((scenario) => scenario.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([
    "mesh-node-python-full-with-sidecar",
    "remote-console-with-running-sidecar",
    "remote-console-without-sidecar",
  ].sort())) {
    throw new Error("native voice route matrix is incomplete");
  }
  for (const scenario of scenarios) {
    if (scenario.redacted !== true) throw new Error("route scenario is not redacted");
    if (FORBIDDEN_TEXT_RE.test(JSON.stringify(scenario))) {
      throw new Error("route scenario contains sensitive material");
    }
    if (scenario.name.startsWith("remote-console")) {
      if (scenario.persistedNodeMode !== "remote-console" || scenario.persistedRuntimeTier !== "none") {
        throw new Error("remote route scenario is not profile-selected");
      }
      if (scenario.startBlockedReasonCode !== REMOTE_AUDIO_CONSENT_REASON) {
        throw new Error("remote route did not fail closed before local capture");
      }
      if (scenario.observedConnection === "this_device") {
        throw new Error("remote route was shadowed by a local sidecar");
      }
    }
    if (scenario.name === "mesh-node-python-full-with-sidecar") {
      if (
        scenario.persistedNodeMode !== "mesh-node" ||
        scenario.persistedRuntimeTier !== "python-full" ||
        scenario.observedConnection !== "this_device" ||
        scenario.observedAvailable !== true ||
        scenario.startBlockedReasonCode !== null
      ) {
        throw new Error("local route scenario is not profile-selected");
      }
    }
  }
}

export function meshNodePythonFullProfileDocument(expectedGatewayOrigin: string): Record<string, unknown> {
  requireLoopbackOrigin(expectedGatewayOrigin);
  return {
    version: 2,
    activeProfileId: "rac27-local-python-full",
    profiles: [{
      version: 2,
      id: "rac27-local-python-full",
      label: "RAC27 local Python full",
      nodeMode: "mesh-node",
      runtimeTier: "python-full",
      localNode: {
        nodeName: "RAC27 desktop node",
        stablePeerId: "rac27-desktop-local",
        enabledCapabilityPacks: ["foreground-voice"],
        meshMembership: {
          signalingUrl: "wss://broker.example.invalid",
          webrtcProfile: webRtcProfile("rac27-local-room", "rac27-desktop-local"),
        },
      },
    }],
  };
}

export function remoteConsoleProfileDocument(
  id: string,
  homePeerId: string,
): Record<string, unknown> {
  return {
    version: 2,
    activeProfileId: id,
    profiles: [{
      version: 2,
      id,
      label: "RAC27 remote console",
      nodeMode: "remote-console",
      runtimeTier: "none",
      homeConnection: {
        mode: "http-only",
        gatewayUrl: "https://gateway.example.invalid",
        homePeerId,
      },
      localNode: {
        nodeName: "RAC27 desktop console",
        stablePeerId: `rac27-console-${homePeerId}`,
        enabledCapabilityPacks: [],
      },
    }],
  };
}

function webRtcProfile(room: string, expectedStablePeerId: string): Record<string, unknown> {
  return {
    mode: "webrtc-only",
    appId: "aurora",
    room,
    roomSecretRef: `ref:memory:${room}`,
    signalingBrokers: ["wss://broker.example.invalid"],
    expectedStablePeerId,
    nodeName: "RAC27 desktop node",
    requireAppLayerE2ee: true,
  };
}

async function waitForEvent(
  events: NativeVoiceEvent[],
  generation: number,
  phases: NativeVoicePhase[],
  timeoutMs: number,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (events.some((event) =>
      event.status.generation === generation && phases.includes(event.status.phase)
    )) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`native voice event did not reach ${phases.join("|")}`);
}

async function waitForIdle(
  invokeCommand: NativeVoiceInvoke,
  timeoutMs: number,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await commandStatus(invokeCommand);
    if (status.phase === "idle" && status.generation === null) return;
    await sleep(50);
  }
  throw new Error("native voice did not return to idle");
}

function summarizeLifecycle(
  statusSequence: NativeVoiceEventSummary[],
  turn: NativeVoiceTurnLabel,
): NativeVoiceLifecycleSummary {
  const turnEvents = statusSequence.filter((event) => event.turn === turn);
  const phases = [...new Set(turnEvents.map((event) => event.phase))];
  if (!phases.includes("starting")) throw new Error(`${turn} lifecycle did not start`);
  if (!phases.includes("stopping")) throw new Error(`${turn} lifecycle did not stop`);
  return {
    turn,
    startObserved: true,
    terminalObserved: true,
    eventCount: turnEvents.length,
    phases,
  };
}

function installWebViewGuards(target: Window): WebViewGuards {
  const calls: string[] = [];
  const guardedTarget = target as GuardedWindow;
  const navigatorValue = target.navigator as Navigator & {
    mediaDevices?: MediaDevices | undefined;
  };
  const originalGetUserMedia = navigatorValue.mediaDevices?.getUserMedia;
  const originalWorker = guardedTarget.Worker;
  const originalSharedWorker = guardedTarget.SharedWorker;
  if (navigatorValue.mediaDevices) {
    navigatorValue.mediaDevices.getUserMedia = (() => {
      calls.push("getUserMedia");
      throw new Error("WebView microphone capture is forbidden in native voice E2E");
    }) as MediaDevices["getUserMedia"];
  }
  guardedTarget.Worker = (function blockedWorker() {
    calls.push("Worker");
    throw new Error("WebView worker model loads are forbidden in native voice E2E");
  }) as unknown as typeof Worker;
  guardedTarget.SharedWorker = (function blockedSharedWorker() {
    calls.push("SharedWorker");
    throw new Error("WebView shared worker model loads are forbidden in native voice E2E");
  }) as unknown as typeof SharedWorker;
  return {
    calls,
    restore() {
      if (navigatorValue.mediaDevices && originalGetUserMedia) {
        navigatorValue.mediaDevices.getUserMedia = originalGetUserMedia;
      }
      guardedTarget.Worker = originalWorker;
      guardedTarget.SharedWorker = originalSharedWorker;
    },
  };
}

async function commandStatus(invokeCommand: NativeVoiceInvoke): Promise<NativeVoiceStatus> {
  return await invokeCommand<NativeVoiceStatus>("aurora_native_voice_status");
}

function parseNativeVoiceEvent(payload: unknown): NativeVoiceEvent {
  if (!payload || typeof payload !== "object") throw new Error("native voice event is invalid");
  const value = payload as Record<string, unknown>;
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0) {
    throw new Error("native voice event sequence is invalid");
  }
  return {
    sequence: Number(value.sequence),
    status: parseNativeVoiceStatus(value.status),
  };
}

function parseNativeVoiceStatus(payload: unknown): NativeVoiceStatus {
  if (!payload || typeof payload !== "object") throw new Error("native voice status is invalid");
  const value = payload as Record<string, unknown>;
  const phase = requirePhase(value.phase);
  const generation = value.generation === null ? null : requireOptionalGeneration(value.generation);
  const status: NativeVoiceStatus = {
    available: value.available === true,
    phase,
    generation,
    backgroundEligible: value.backgroundEligible === true,
    connection: requireConnection(value.connection),
    reasonCode: value.reasonCode === null ? null : requireBoundedString(value.reasonCode, "reasonCode", 1, 128),
    redacted: value.redacted === true ? true : (() => {
      throw new Error("native voice status redaction flag is invalid");
    })(),
  };
  assertNativeVoiceStatusRedacted(status);
  return status;
}

function requirePhase(value: unknown): NativeVoicePhase {
  if (
    value === "unavailable" ||
    value === "idle" ||
    value === "starting" ||
    value === "listening" ||
    value === "processing" ||
    value === "speaking" ||
    value === "stopping" ||
    value === "faulted"
  ) return value;
  throw new Error("native voice status phase is invalid");
}

function requireConnection(value: unknown): NativeVoiceStatus["connection"] {
  if (value === "this_device" || value === "connected_device" || value === "unavailable") {
    return value;
  }
  throw new Error("native voice status connection is invalid");
}

function requireOptionalGeneration(value: unknown): number | null {
  if (value === undefined) return null;
  const generation = requirePositiveInteger(value, "generation", 1, Number.MAX_SAFE_INTEGER);
  return generation;
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} is invalid`);
  }
  return Number(value);
}

function requireBoundedString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw new Error(`${field} is invalid`);
  }
  return trimmed;
}

function optionalBoundedPath(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireBoundedString(value, field, 1, 4096);
}

function requireLoopbackOrigin(value: unknown): string {
  const origin = requireBoundedString(value, "expectedGatewayOrigin", 1, 256);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("expectedGatewayOrigin is invalid");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.origin !== origin ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]")
  ) {
    throw new Error("expectedGatewayOrigin must be a loopback origin");
  }
  return origin;
}

function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertReportHasNoSensitiveMaterial(report: DesktopNativeVoiceE2eReport): void {
  const encoded = JSON.stringify(report);
  if (FORBIDDEN_TEXT_RE.test(encoded)) throw new Error("report contains sensitive material");
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

declare global {
  interface Window {
    __AURORA_DESKTOP_NATIVE_VOICE_E2E__?: (
      payload: unknown,
    ) => Promise<DesktopNativeVoiceE2eReport>;
    __AURORA_DESKTOP_NATIVE_VOICE_E2E_READY__?: true;
  }
}
