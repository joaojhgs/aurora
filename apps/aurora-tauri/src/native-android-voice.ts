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
  const reasonCode = typeof nested.captureError === "string"
    ? nested.captureError
    : typeof nested.reason === "string"
      ? nested.reason
      : null;
  const available = (options.background ? nested.backgroundStartable === true : nested.startable === true) || running;
  const phase: NativeMobileVoicePhase = !available
    ? "unavailable"
    : reasonCode && !running
      ? "faulted"
      : captureActive
        ? "listening"
        : running
          ? "processing"
          : "idle";
  return {
    available,
    phase,
    running,
    captureActive,
    backgroundActive: options.background === true && running,
    reasonCode,
    redacted: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
