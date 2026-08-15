import { describe, expect, it, vi } from "vitest";
import { createTauriNativeAndroidVoicePort } from "./native-android-voice";

describe("native Android voice port", () => {
  it("routes status and turn controls through the foreground service commands", async () => {
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
      if (command.endsWith("status")) {
        return { startable: true, backgroundStartable: true, running: true, captureActive: true, backgroundSessionActive: true };
      }
      return { status: { startable: true, backgroundStartable: true, running: false, captureActive: false } };
    });
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.status()).resolves.toMatchObject({ phase: "listening", available: true });
    await expect(port.start({ remoteAudioConsent: false })).resolves.toMatchObject({ phase: "idle" });
    await expect(port.finish()).resolves.toMatchObject({ phase: "idle" });
    await expect(port.cancel()).resolves.toMatchObject({ phase: "idle" });
    await expect(port.backgroundStatus?.()).resolves.toMatchObject({ available: true, backgroundActive: true });
    await expect(port.startBackground?.({ remoteAudioConsent: true })).resolves.toMatchObject({ phase: "idle" });
    await expect(port.stopBackground?.()).resolves.toMatchObject({ phase: "idle" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_finish",
      "aurora_android_voice_foreground_service_cancel",
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_cancel",
    ]);
    expect(invoke.mock.calls[1]?.[1]).toEqual({ request: { remoteAudioConsent: false } });
    expect(invoke.mock.calls[5]?.[1]).toEqual({ request: { remoteAudioConsent: true, backgroundSession: true } });
  });

  it("does not report foreground push-to-talk as an active background session", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      startable: true,
      backgroundStartable: true,
      running: true,
      captureActive: true,
      backgroundSessionActive: false,
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.backgroundStatus?.()).resolves.toMatchObject({
      available: true,
      backgroundActive: false,
    });
  });

  it("keeps an asynchronous start request available when Android reports an informational reason", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      started: true,
      reason: "foreground_service_start_requested",
      status: {
        startable: true,
        backgroundStartable: true,
        running: false,
        captureActive: false,
        runtimePhase: "idle",
        state: "available",
        reason: "foreground_service_startable",
      },
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.start({ remoteAudioConsent: false })).resolves.toMatchObject({
      available: true,
      phase: "idle",
      reasonCode: "foreground_service_startable",
    });
  });
});
