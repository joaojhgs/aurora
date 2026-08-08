import { describe, expect, it, vi } from "vitest";
import { createTauriNativeAndroidVoicePort } from "./native-android-voice";

describe("native Android voice port", () => {
  it("routes status and turn controls through the foreground service commands", async () => {
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
      if (command.endsWith("status")) {
        return { startable: true, running: true, captureActive: true };
      }
      return { status: { startable: true, running: false, captureActive: false } };
    });
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.status()).resolves.toMatchObject({ phase: "listening", available: true });
    await expect(port.start({ remoteAudioConsent: false })).resolves.toMatchObject({ phase: "idle" });
    await expect(port.startBackground({ remoteAudioConsent: true })).resolves.toMatchObject({ phase: "idle" });
    await expect(port.finish()).resolves.toMatchObject({ phase: "idle" });
    await expect(port.cancel()).resolves.toMatchObject({ phase: "idle" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_finish",
      "aurora_android_voice_foreground_service_cancel",
    ]);
    expect(invoke.mock.calls[1]?.[1]).toEqual({ request: { remoteAudioConsent: false } });
    expect(invoke.mock.calls[2]?.[1]).toEqual({ request: { remoteAudioConsent: true, backgroundSession: true } });
  });
});
