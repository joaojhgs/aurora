import type {
  NativeMobileVoicePhase,
  NativeMobileVoicePort,
  NativeMobileVoiceStatus,
} from "@aurora/ui";

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createTauriNativeAndroidVoicePort(
  invoke: NativeInvoke,
): NativeMobileVoicePort {
  return {
    status: async () => parseStatus(await invoke("aurora_android_voice_foreground_service_status")),
    start: async ({ remoteAudioConsent }) => parseStatus(
      await invoke("aurora_android_voice_foreground_service_start", {
        request: { remoteAudioConsent },
      }),
    ),
    finish: async () => parseStatus(
      await invoke("aurora_android_voice_foreground_service_finish"),
    ),
    cancel: async () => parseStatus(
      await invoke("aurora_android_voice_foreground_service_cancel"),
    ),
  };
}

function parseStatus(value: unknown): NativeMobileVoiceStatus {
  const record = isRecord(value) ? value : {};
  const nested = isRecord(record.status) ? record.status : record;
  const running = nested.running === true;
  const captureActive = nested.captureActive === true;
  const reasonCode = typeof nested.captureError === "string"
    ? nested.captureError
    : typeof nested.reason === "string"
      ? nested.reason
      : null;
  const available = nested.startable === true || running;
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
    reasonCode,
    redacted: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
