import type {
  NativeMobileVoicePhase,
  NativeMobileVoicePort,
  NativeMobileVoiceStatus,
} from "@aurora/ui";

type NativeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createTauriNativeAndroidVoicePort(
  callNative: NativeCommand,
): NativeMobileVoicePort {
  return {
    status: async () => parseStatus(await callNative("aurora_android_voice_foreground_service_status")),
    start: async ({ remoteAudioConsent }) => parseStatus(
      await callNative("aurora_android_voice_foreground_service_start", {
        request: { remoteAudioConsent },
      }),
    ),
    finish: async () => parseStatus(
      await callNative("aurora_android_voice_foreground_service_finish"),
    ),
    cancel: async () => parseStatus(
      await callNative("aurora_android_voice_foreground_service_cancel"),
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
      await callNative("aurora_android_voice_foreground_service_cancel"),
      { background: true },
    ),
  };
}

function parseStatus(
  value: unknown,
  options: { background?: boolean } = {},
): NativeMobileVoiceStatus {
  const record = isRecord(value) ? value : {};
  const nested = isRecord(record.status) ? record.status : record;
  const running = nested.running === true;
  const captureActive = nested.captureActive === true;
  const backgroundSessionActive = nested.backgroundSessionActive === true;
  const captureError = typeof nested.captureError === "string" && nested.captureError.trim()
    ? nested.captureError
    : null;
  const reasonCode = captureError
    ? captureError
    : typeof nested.reason === "string"
      ? nested.reason
      : null;
  const faulted = captureError !== null
    || nested.runtimePhase === "faulted"
    || nested.state === "faulted";
  const background = options.background === true;
  const active = background ? backgroundSessionActive : running;
  const statusCaptureActive = background
    ? backgroundSessionActive && captureActive
    : captureActive;
  const available = background
    ? nested.backgroundStartable === true || backgroundSessionActive
    : nested.startable === true || running;
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
    backgroundActive: background && backgroundSessionActive,
    reasonCode,
    redacted: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
