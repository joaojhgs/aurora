import { describe, expect, it, vi } from "vitest";
import { createTauriNativeIosVoicePort } from "./native-ios-voice";

type NativeCommand = Parameters<typeof createTauriNativeIosVoicePort>[0];

describe("createTauriNativeIosVoicePort", () => {
  it("gates capture plumbing behind the native iOS capability", async () => {
    const callNative = vi.fn<NativeCommand>(async (command) =>
      command === "aurora_ios_voice_status"
        ? { available: false, reason: "native_voice_transport_unavailable" }
        : { available: true, running: true },
    );
    const port = createTauriNativeIosVoicePort(callNative);

    await expect(port.status()).resolves.toEqual({
      available: false,
      phase: "unavailable",
      running: true,
      captureActive: true,
      reasonCode: "native_voice_transport_unavailable",
      redacted: true,
    });
    expect(callNative).toHaveBeenNthCalledWith(1, "aurora_ios_voice_status");
    expect(callNative).toHaveBeenNthCalledWith(2, "aurora_ios_voice_foreground_capture_status");
  });

  it("routes PTT lifecycle commands through the Rust-backed iOS session", async () => {
    const callNative = vi.fn<NativeCommand>(async (command) => {
      if (command === "aurora_ios_voice_foreground_capture_status") {
        return { available: true, running: false };
      }
      return { available: true };
    });
    const port = createTauriNativeIosVoicePort(callNative);

    await port.start({ remoteAudioConsent: true });
    await port.finish();
    await port.cancel();

    expect(callNative.mock.calls.map(([command]) => command)).toEqual([
      "aurora_ios_voice_foreground_capture_start",
      "aurora_ios_voice_foreground_capture_status",
      "aurora_ios_voice_foreground_capture_finish",
      "aurora_ios_voice_foreground_capture_status",
      "aurora_ios_voice_foreground_capture_stop",
      "aurora_ios_voice_foreground_capture_status",
    ]);
    expect(callNative.mock.calls[0]?.[1]).toEqual({
      request: { remoteAudioConsent: true },
    });
    expect(callNative.mock.calls[2]?.[1]).toBeUndefined();
  });

  it("rejects malformed start requests before crossing the native boundary", async () => {
    const callNative = vi.fn<NativeCommand>(async () => ({ available: true }));
    const port = createTauriNativeIosVoicePort(callNative);

    await expect(port.start({ remoteAudioConsent: "yes" } as never)).rejects.toThrow(
      "Native iOS voice start request is invalid.",
    );
    await expect(
      port.start({ remoteAudioConsent: true, mode: "background" } as never),
    ).rejects.toThrow("Native iOS voice start request is invalid.");
    expect(callNative).not.toHaveBeenCalled();
  });
});
