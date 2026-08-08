// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  assertNativeVoiceStatusRedacted,
  installDesktopNativeVoiceE2eHook,
  isDesktopNativeVoiceE2eHookEnabled,
  summarizeNativeVoiceEvents,
  validateDesktopNativeVoiceE2ePayload,
  type DesktopNativeVoiceE2ePayload,
  type DesktopNativeVoiceE2eReport,
  type NativeVoiceEvent,
  type NativeVoiceStatus,
} from "./desktop-native-voice-e2e";

const liveEnv = {
  VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E: "1",
  VITE_AURORA_RUNTIME_MODE: "desktop-local",
  VITE_AURORA_TAURI_DEV_AUTOSIDECAR: "0",
};

describe("desktop native voice E2E hook", () => {
  it("is gated to the explicit installed desktop local E2E environment", () => {
    expect(isDesktopNativeVoiceE2eHookEnabled(liveEnv)).toBe(true);
    expect(isDesktopNativeVoiceE2eHookEnabled({
      ...liveEnv,
      VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E: "0",
    })).toBe(false);
    expect(isDesktopNativeVoiceE2eHookEnabled({
      ...liveEnv,
      VITE_AURORA_RUNTIME_MODE: "desktop-thin",
    })).toBe(false);
    expect(isDesktopNativeVoiceE2eHookEnabled({
      ...liveEnv,
      VITE_AURORA_TAURI_DEV_AUTOSIDECAR: "1",
    })).toBe(false);
  });

  it("validates the driver payload and rejects non-loopback gateway origins", () => {
    const payload = samplePayload();
    expect(validateDesktopNativeVoiceE2ePayload(payload)).toEqual(payload);
    expect(() => validateDesktopNativeVoiceE2ePayload({
      ...payload,
      tauriPid: "0",
    })).toThrow(/tauriPid/u);
    expect(() => validateDesktopNativeVoiceE2ePayload({
      ...payload,
      expectedGatewayOrigin: "https://example.invalid",
    })).toThrow(/loopback/u);
  });

  it("accepts only the redacted bounded native status shape", () => {
    expect(() => assertNativeVoiceStatusRedacted(status("idle", null))).not.toThrow();
    expect(() => assertNativeVoiceStatusRedacted({
      ...status("idle", null),
      transcript: "secret words",
    } as unknown as NativeVoiceStatus)).toThrow(/unexpected fields/u);
    expect(() => assertNativeVoiceStatusRedacted({
      ...status("idle", null),
      reasonCode: "token",
    })).toThrow(/sensitive/u);
  });

  it("summarizes monotonic redacted native status events", () => {
    const events: NativeVoiceEvent[] = [
      { sequence: 1, status: status("idle", null) },
      { sequence: 2, status: status("starting", 1) },
      { sequence: 3, status: status("stopping", 1) },
    ];
    expect(summarizeNativeVoiceEvents(events, new Map([[1, "completed"]]))).toEqual([
      { sequence: 1, phase: "idle", reasonCode: null, turn: "unknown", redacted: true },
      { sequence: 2, phase: "starting", reasonCode: null, turn: "completed", redacted: true },
      { sequence: 3, phase: "stopping", reasonCode: null, turn: "completed", redacted: true },
    ]);
    expect(() => summarizeNativeVoiceEvents([events[1], events[0]])).toThrow(/monotonic/u);
    expect(() => summarizeNativeVoiceEvents([])).toThrow(/required/u);
  });

  it("installs a hook that hides the WebView and proves completed plus cancelled native turns", async () => {
    const payload = samplePayload();
    const listeners: Array<(event: { payload: NativeVoiceEvent }) => void> = [];
    const commands: string[] = [];
    let nextSequence = 1;
    let activeGeneration: number | null = null;
    let startCount = 0;
    let clock = 0;
    const emit = (phase: NativeVoiceStatus["phase"], generation: number | null) => {
      listeners.forEach((listener) => listener({
        payload: { sequence: nextSequence++, status: status(phase, generation) },
      }));
    };
    const invoke = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === "aurora_sidecar_session") return { token: "sidecar-session-token" };
      if (command === "aurora_sidecar_start") return { running: true };
      if (command === "aurora_sidecar_stop") return { running: false };
      if (command === "aurora_native_voice_status") {
        return activeGeneration === null ? status("idle", null) : status("processing", activeGeneration);
      }
      if (command === "aurora_native_voice_start") {
        startCount += 1;
        activeGeneration = startCount === 1 ? 7 : 8;
        emit("starting", activeGeneration);
        emit("listening", activeGeneration);
        return status("starting", activeGeneration);
      }
      if (command === "aurora_native_voice_finish") {
        const generation = activeGeneration;
        emit("stopping", generation);
        if (generation === 8) {
          emit("processing", generation);
        } else {
          activeGeneration = null;
        }
        return status("stopping", generation);
      }
      if (command === "aurora_native_voice_cancel") {
        const generation = activeGeneration;
        emit("stopping", generation);
        activeGeneration = null;
        return status("stopping", generation);
      }
      throw new Error(`unexpected command ${command}`);
    });
    const listen = vi.fn(async <T,>(_event: string, handler: (event: { payload: T }) => void) => {
      const typedHandler = handler as (event: { payload: NativeVoiceEvent }) => void;
      listeners.push(typedHandler);
      return () => undefined;
    });
    const target = {
      navigator: {
        mediaDevices: {
          getUserMedia: vi.fn(),
        },
      },
      Worker: vi.fn(),
      SharedWorker: vi.fn(),
    } as unknown as Window;
    expect(installDesktopNativeVoiceE2eHook({
      target,
      env: liveEnv,
      bridge: {
        invoke: invoke as never,
        listen: listen as never,
        hideWindow: vi.fn(async () => undefined),
        now: () => {
          clock += 10;
          return clock;
        },
        hash: async () => "0".repeat(64),
      },
    })).toBe(true);
    const report = await windowHook(target)(payload);
    expect(report.status).toBe("passed");
    expect(report.sessionNonceDigest).toBe("0".repeat(64));
    expect(report.tauriPidDigest).toBe("0".repeat(64));
    expect(report.noWebViewMicrophone).toBe(true);
    expect(report.desktopResult.windowHidden).toBe(true);
    expect(report.desktopResult.sidecarLoopback).toBe(true);
    expect(report.desktopResult.distinctGenerations).toBe(true);
    expect(report.desktopResult.completedTurn).toMatchObject({
      turn: "completed",
      startObserved: true,
      terminalObserved: true,
    });
    expect(report.desktopResult.cancelledTurn).toMatchObject({
      turn: "cancelled",
      startObserved: true,
      terminalObserved: true,
    });
    expect(report.desktopResult.statusSequence.map((event) => event.turn)).toContain("completed");
    expect(report.desktopResult.statusSequence.map((event) => event.turn)).toContain("cancelled");
    expect(report.desktopResult.commands).toEqual([
      "aurora_native_voice_status",
      "aurora_native_voice_start",
      "aurora_native_voice_finish",
      "aurora_native_voice_cancel",
    ]);
    expect(commands).toContain("aurora_native_voice_finish");
    expect(commands).toContain("aurora_native_voice_cancel");
    expect(commands).toContain("aurora_sidecar_start");
    expect(commands).toContain("aurora_sidecar_stop");
  });

  it("fails when native status events are absent", async () => {
    const payload = { ...samplePayload(), timeoutMs: 1_000 };
    let clock = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "aurora_sidecar_session") return { token: "sidecar-session-token" };
      if (command === "aurora_sidecar_start") return { running: true };
      if (command === "aurora_sidecar_stop") return { running: false };
      if (command === "aurora_native_voice_status") return status("idle", null);
      if (command === "aurora_native_voice_start") return status("starting", 7);
      if (command === "aurora_native_voice_finish") return status("stopping", 7);
      if (command === "aurora_native_voice_cancel") return status("stopping", 8);
      throw new Error(`unexpected command ${command}`);
    });
    const target = {
      navigator: {},
      Worker: vi.fn(),
      SharedWorker: vi.fn(),
    } as unknown as Window;
    installDesktopNativeVoiceE2eHook({
      target,
      env: liveEnv,
      bridge: {
        invoke: invoke as never,
        listen: (async () => () => undefined) as never,
        hideWindow: vi.fn(async () => undefined),
        now: () => {
          clock += 250;
          return clock;
        },
        hash: async () => "0".repeat(64),
      },
    });
    await expect(windowHook(target)(payload)).rejects.toThrow(/event did not reach|events are required/u);
  });

  it("does not install outside the gated environment", () => {
    const target = {} as Window;
    expect(installDesktopNativeVoiceE2eHook({
      target,
      env: { ...liveEnv, VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E: "0" },
    })).toBe(false);
    expect((target as { __AURORA_DESKTOP_NATIVE_VOICE_E2E__?: unknown }).__AURORA_DESKTOP_NATIVE_VOICE_E2E__).toBeUndefined();
  });
});

function samplePayload(): DesktopNativeVoiceE2ePayload {
  return {
    schema: "aurora.desktop_native_voice_e2e.hook_payload.v1",
    sessionNonce: "nonce_abcdefghijklmnopqrstuvwxyz",
    tauriPid: "12345",
    expectedGatewayOrigin: "http://127.0.0.1:8123",
    reportPath: "/tmp/native-report.json",
    donePath: "/tmp/native-done.json",
    timeoutMs: 30_000,
  };
}

function status(phase: NativeVoiceStatus["phase"], generation: number | null): NativeVoiceStatus {
  return {
    available: phase !== "unavailable",
    phase,
    generation,
    backgroundEligible: true,
    connection: phase === "unavailable" ? "unavailable" : "this_device",
    reasonCode: null,
    redacted: true,
  };
}

function windowHook(target: Window): (payload: unknown) => Promise<DesktopNativeVoiceE2eReport> {
  const hook = (target as { __AURORA_DESKTOP_NATIVE_VOICE_E2E__?: unknown })
    .__AURORA_DESKTOP_NATIVE_VOICE_E2E__;
  if (typeof hook !== "function") throw new Error("hook missing");
  return hook as (payload: unknown) => Promise<DesktopNativeVoiceE2eReport>;
}
