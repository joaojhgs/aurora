import type {
  NativeMobileVoicePhase,
  NativeMobileVoicePort,
  NativeMobileVoiceStatus,
} from "@aurora/ui";

type NativeCommand = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Adapts the iOS Rust-session Tauri commands to the shared mobile PTT port.
 *
 * The capture payload alone reports audio plumbing, so availability is
 * intentionally gated by the separate iOS voice capability status. This
 * prevents a wired-but-unverified native session from being advertised as
 * usable.
 */
export function createTauriNativeIosVoicePort(
  callNative: NativeCommand,
): NativeMobileVoicePort {
  return {
    status: async () => {
      const [capability, capture] = await Promise.all([
        callNative("aurora_ios_voice_status"),
        callNative("aurora_ios_voice_foreground_capture_status"),
      ]);
      return parseStatus(capability, capture);
    },
    start: async () => parseStatus(
      await callNative("aurora_ios_voice_foreground_capture_start"),
      await callNative("aurora_ios_voice_foreground_capture_status"),
    ),
    finish: async () => parseStatus(
      await callNative("aurora_ios_voice_foreground_capture_finish"),
      await callNative("aurora_ios_voice_foreground_capture_status"),
    ),
    cancel: async () => parseStatus(
      await callNative("aurora_ios_voice_foreground_capture_stop"),
      await callNative("aurora_ios_voice_foreground_capture_status"),
    ),
  };
}

function parseStatus(
  capabilityValue: unknown,
  captureValue: unknown,
): NativeMobileVoiceStatus {
  const capability = isRecord(capabilityValue) ? capabilityValue : {};
  const capture = isRecord(captureValue) ? captureValue : {};
  const available = capability.available === true;
  const running = capture.running === true;
  const captureActive = running;
  const reasonCode = typeof capability.reason === "string"
    ? capability.reason
    : typeof capture.reason === "string"
      ? capture.reason
      : null;
  const phase: NativeMobileVoicePhase = !available
    ? "unavailable"
    : reasonCode && !running
      ? "faulted"
      : captureActive
        ? "listening"
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
