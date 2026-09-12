import type {
  NativeMobileVoiceBackgroundResult,
  NativeMobileVoicePhase,
  NativeMobileVoicePort,
  NativeMobileVoiceStatus,
} from "@aurora/ui";

type NativeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const FOCUSED_TURN_SETTLEMENT_TIMEOUT_MS = 120_000;
const FOCUSED_CAPTURE_START_TIMEOUT_MS = 30_000;
const FOCUSED_TURN_STATUS_POLL_MS = 100;

export function createTauriNativeAndroidVoicePort(
  callNative: NativeCommand,
): NativeMobileVoicePort {
  return {
    status: async () => parseStatus(await callNative("aurora_android_voice_foreground_service_status")),
    start: async ({ remoteAudioConsent }) => waitForFocusedCaptureStart(
      callNative,
      await callNative("aurora_android_voice_foreground_service_start", {
        request: { remoteAudioConsent },
      }),
    ),
    finish: async () => waitForFocusedTurnSettlement(
      callNative,
      await callNative("aurora_android_voice_foreground_service_finish"),
    ),
    takeTranscript: async () => takeFocusedTranscript(callNative),
    takeBackgroundResult: async () => takeBackgroundResult(callNative),
    cancel: async () => parseStatus(
      await callNative("aurora_android_voice_foreground_service_cancel", {
        request: { backgroundSession: false },
      }),
    ),
    backgroundStatus: async () => parseStatus(
      await callNative("aurora_android_voice_foreground_service_status"),
      { background: true },
    ),
    startBackground: async ({ remoteAudioConsent }) => parseStatus(
      await callNative("aurora_android_voice_foreground_service_start", {
        request: { remoteAudioConsent, backgroundSession: true },
      }),
      { background: true },
    ),
    stopBackground: async () => parseStatus(
      await callNative("aurora_android_voice_foreground_service_cancel", {
        request: { backgroundSession: true },
      }),
      { background: true },
    ),
  };
}

async function waitForFocusedCaptureStart(
  callNative: NativeCommand,
  initialValue: unknown,
): Promise<NativeMobileVoiceStatus> {
  let status = parseStatus(initialValue);
  const deadline = Date.now() + FOCUSED_CAPTURE_START_TIMEOUT_MS;
  while (
    status.available
    && status.phase !== "faulted"
    && !(status.running && status.captureActive)
    && Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, FOCUSED_TURN_STATUS_POLL_MS));
    status = parseStatus(
      await callNative("aurora_android_voice_foreground_service_status"),
    );
  }
  if (status.available && status.phase !== "faulted" && !(status.running && status.captureActive)) {
    return {
      ...status,
      phase: "faulted",
      reasonCode: "focused_voice_start_timeout",
    };
  }
  return status;
}

async function waitForFocusedTurnSettlement(
  callNative: NativeCommand,
  initialValue: unknown,
): Promise<NativeMobileVoiceStatus> {
  let status = parseStatus(initialValue);
  const deadline = Date.now() + FOCUSED_TURN_SETTLEMENT_TIMEOUT_MS;
  while (status.running && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, FOCUSED_TURN_STATUS_POLL_MS));
    status = parseStatus(
      await callNative("aurora_android_voice_foreground_service_status"),
    );
  }
  if (status.running) {
    return {
      ...status,
      phase: "faulted",
      reasonCode: "focused_voice_timeout",
    };
  }
  return status;
}

async function takeFocusedTranscript(callNative: NativeCommand): Promise<string | null> {
  const value = await callNative("aurora_android_voice_foreground_service_status", {
    request: { takeFocusedResult: true },
  });
  const record = isRecord(value) ? value : {};
  return typeof record.focusedTranscript === "string" && record.focusedTranscript.trim()
    ? record.focusedTranscript.trim()
    : null;
}

async function takeBackgroundResult(callNative: NativeCommand): Promise<NativeMobileVoiceBackgroundResult | null> {
  const value = await callNative("aurora_android_voice_foreground_service_status", {
    request: { takeBackgroundResult: true },
  });
  const record = isRecord(value) ? value : {};
  const raw = record.backgroundTurnResult;
  if (!isRecord(raw)) return null;
  const generation = typeof raw.generation === "number" && Number.isFinite(raw.generation)
    ? raw.generation
    : null;
  const transcript = typeof raw.transcript === "string" ? raw.transcript.trim() : "";
  if (generation === null || !transcript) return null;
  return {
    generation,
    transcript,
    assistantText: typeof raw.assistantText === "string" && raw.assistantText.trim()
      ? raw.assistantText.trim()
      : null,
    errorCode: typeof raw.errorCode === "string" && raw.errorCode.trim()
      ? raw.errorCode.trim()
      : null,
    persisted: raw.persisted === true,
    conversationId: typeof raw.conversationId === "string" && raw.conversationId.trim()
      ? raw.conversationId.trim()
      : null,
    persistenceErrorCode: typeof raw.persistenceErrorCode === "string" && raw.persistenceErrorCode.trim()
      ? raw.persistenceErrorCode.trim()
      : null,
  };
}

function parseStatus(
  value: unknown,
  options: { background?: boolean } = {},
): NativeMobileVoiceStatus {
  const record = isRecord(value) ? value : {};
  const nested = isRecord(record.status) ? record.status : record;
  const captureActive = nested.captureActive === true;
  const backgroundSessionActive = nested.backgroundSessionActive === true;
  const focusedVoiceActive = nested.focusedVoiceActive === true;
  const captureError = typeof nested.captureError === "string" && nested.captureError.trim()
    ? nested.captureError
    : null;
  const reasonCode = captureError
    ? captureError
    : nested.microphoneSilenced === true
      ? "microphone_in_use"
    : typeof nested.reason === "string"
      ? nested.reason
      : typeof nested.nativeRouteReason === "string" && nested.nativeRouteReason.trim()
        ? nested.nativeRouteReason
      : null;
  const faulted = captureError !== null
    || nested.runtimePhase === "faulted"
    || nested.state === "faulted";
  const background = options.background === true;
  const active = background ? backgroundSessionActive : focusedVoiceActive;
  const statusCaptureActive = background
    ? backgroundSessionActive && captureActive
    : focusedVoiceActive && captureActive;
  const available = background
    ? nested.backgroundStartable === true || backgroundSessionActive
    : nested.startable === true || focusedVoiceActive || backgroundSessionActive;
  const phase: NativeMobileVoicePhase = !available
    ? "unavailable"
    : faulted
      ? "faulted"
      : statusCaptureActive
        ? "listening"
        : active
          ? "processing"
          : "idle";
  return {
    available,
    phase,
    running: active,
    captureActive: statusCaptureActive,
    backgroundActive: backgroundSessionActive,
    reasonCode,
    redacted: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
