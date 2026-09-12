import { describe, expect, it, vi } from "vitest";
import { createTauriNativeAndroidVoicePort } from "./native-android-voice";

describe("native Android voice port", () => {
  it("routes status and turn controls through the foreground service commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (isTakeFocusedResult(args)) {
        return { focusedTranscript: "hello aurora" };
      }
      if (command.endsWith("status")) {
        return { startable: true, backgroundStartable: true, running: true, captureActive: true, backgroundSessionActive: true, focusedVoiceActive: false };
      }
      if (command.endsWith("start")) {
        return { status: { startable: true, backgroundStartable: true, running: true, captureActive: true, backgroundSessionActive: false, focusedVoiceActive: true } };
      }
      return { status: { startable: true, backgroundStartable: true, running: false, captureActive: false, focusedVoiceActive: false } };
    });
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.status()).resolves.toMatchObject({ phase: "idle", available: true, backgroundActive: true });
    await expect(port.start({ remoteAudioConsent: false })).resolves.toMatchObject({ phase: "listening" });
    await expect(port.finish()).resolves.toMatchObject({ phase: "idle" });
    await expect(port.takeTranscript?.()).resolves.toBe("hello aurora");
    await expect(port.cancel()).resolves.toMatchObject({ phase: "idle" });
    await expect(port.backgroundStatus?.()).resolves.toMatchObject({ available: true, backgroundActive: true });
    await expect(port.startBackground?.({ remoteAudioConsent: true })).resolves.toMatchObject({ phase: "idle" });
    await expect(port.stopBackground?.()).resolves.toMatchObject({ phase: "idle" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_finish",
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_cancel",
      "aurora_android_voice_foreground_service_status",
      "aurora_android_voice_foreground_service_start",
      "aurora_android_voice_foreground_service_cancel",
    ]);
    expect(invoke.mock.calls[1]?.[1]).toEqual({ request: { remoteAudioConsent: false } });
    expect(invoke.mock.calls[3]?.[1]).toEqual({ request: { takeFocusedResult: true } });
    expect(invoke.mock.calls[4]?.[1]).toEqual({ request: { backgroundSession: false } });
    expect(invoke.mock.calls[6]?.[1]).toEqual({ request: { remoteAudioConsent: true, backgroundSession: true } });
    expect(invoke.mock.calls[7]?.[1]).toEqual({ request: { backgroundSession: true } });
  });

  it("does not report foreground push-to-talk as an active background session", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      startable: true,
      backgroundStartable: false,
      running: true,
      captureActive: true,
      backgroundSessionActive: false,
      focusedVoiceActive: true,
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.backgroundStatus?.()).resolves.toMatchObject({
      available: false,
      phase: "unavailable",
      running: false,
      captureActive: false,
      backgroundActive: false,
    });
    await expect(port.status()).resolves.toMatchObject({
      available: true,
      phase: "listening",
      running: true,
      captureActive: true,
    });
  });

  it("preserves an active background session when new background starts are unavailable", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      startable: true,
      backgroundStartable: false,
      running: true,
      captureActive: true,
      backgroundSessionActive: true,
      focusedVoiceActive: false,
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.backgroundStatus?.()).resolves.toMatchObject({
      available: true,
      phase: "listening",
      running: true,
      captureActive: true,
      backgroundActive: true,
    });
  });

  it("does not treat a device-link-only foreground service as focused voice capture", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      startable: true,
      backgroundStartable: true,
      running: true,
      captureActive: false,
      runtimeActive: false,
      backgroundSessionActive: false,
      foregroundReasons: ["device_link"],
      focusedVoiceActive: false,
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.status()).resolves.toMatchObject({
      available: true,
      phase: "idle",
      running: false,
      captureActive: false,
      backgroundActive: false,
    });
  });

  it("reports externally started background assistant capture on the normal status path", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      startable: false,
      backgroundStartable: false,
      running: true,
      captureActive: true,
      runtimeActive: true,
      backgroundSessionActive: true,
      foregroundReasons: ["device_link", "voice"],
      focusedVoiceActive: false,
    }));
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.status()).resolves.toMatchObject({
      available: true,
      phase: "idle",
      running: false,
      captureActive: false,
      backgroundActive: true,
    });
  });

  it("keeps an asynchronous start request available when Android reports an informational reason", async () => {
    let requested = false;
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command.endsWith("start")) {
        requested = true;
        return {
          started: true,
          reason: "foreground_service_start_requested",
          status: {
            startable: true,
            backgroundStartable: true,
            running: false,
            captureActive: false,
            focusedVoiceActive: false,
            runtimePhase: "idle",
            state: "available",
            reason: "foreground_service_startable",
          },
        };
      }
      return {
        startable: true,
        backgroundStartable: true,
        running: requested,
        captureActive: requested,
        focusedVoiceActive: requested,
        runtimePhase: requested ? "listening" : "idle",
        state: "available",
        reason: "foreground_service_startable",
      };
    });
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.start({ remoteAudioConsent: false })).resolves.toMatchObject({
      available: true,
      phase: "listening",
      reasonCode: "foreground_service_startable",
    });
  });

  it("drains one completed background turn result through the status command", async () => {
    let drained = false;
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (isTakeBackgroundResult(args)) {
        if (drained) return { backgroundTurnResult: null };
        drained = true;
        return {
          backgroundTurnResult: {
            generation: 7,
            transcript: "what is the meaning of life",
            assistantText: null,
            errorCode: "assistant_unavailable",
            persisted: true,
            conversationId: "voice-conversation-1",
            persistenceErrorCode: null,
          },
        };
      }
      return {
        startable: true,
        backgroundStartable: true,
        running: true,
        captureActive: false,
        backgroundSessionActive: true,
        focusedVoiceActive: false,
      };
    });
    const port = createTauriNativeAndroidVoicePort(invoke);

    await expect(port.takeBackgroundResult?.()).resolves.toEqual({
      generation: 7,
      transcript: "what is the meaning of life",
      assistantText: null,
      errorCode: "assistant_unavailable",
      persisted: true,
      conversationId: "voice-conversation-1",
      persistenceErrorCode: null,
    });
    await expect(port.takeBackgroundResult?.()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      "aurora_android_voice_foreground_service_status",
      { request: { takeBackgroundResult: true } },
    );
  });
});

function isTakeFocusedResult(args: Record<string, unknown> | undefined): boolean {
  const request = args?.request;
  return typeof request === "object"
    && request !== null
    && "takeFocusedResult" in request
    && request.takeFocusedResult === true;
}

function isTakeBackgroundResult(args: Record<string, unknown> | undefined): boolean {
  const request = args?.request;
  return typeof request === "object"
    && request !== null
    && "takeBackgroundResult" in request
    && request.takeBackgroundResult === true;
}
