// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuroraTauriRuntime,
  type AuroraRuntimeProfileDocument,
  type AuroraThinConnectionProfile,
  type AuroraThinProfileDocument,
} from "./aurora-client";
import {
  AURORA_NATIVE_VOICE_STATUS_EVENT,
  createTauriNativeDesktopVoicePort,
  type TauriNativeVoiceBridge,
} from "./native-voice";

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(async (
    _command: string,
    _args?: Record<string, unknown>,
  ): Promise<unknown> => {
    throw new Error("Tauri invoke is not mocked in this test");
  }),
  addPluginListener: vi.fn(async () => ({
    unregister: vi.fn(async () => undefined),
  })),
}));

const tauriEventMock = vi.hoisted(() => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriCoreMock.invoke,
  addPluginListener: tauriCoreMock.addPluginListener,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriEventMock.listen,
}));

const validStatus = {
  available: true,
  phase: "idle",
  generation: 1,
  backgroundEligible: true,
  connection: "this_device",
  reasonCode: null,
  redacted: true,
} as const;

const profile: AuroraThinConnectionProfile = {
  id: "office",
  label: "Office",
  mode: "http-only",
  gatewayUrl: "https://gateway.example.invalid",
  signalingUrl: "",
  nodeName: "Aurora desktop",
  localStablePeerId: "desktop-peer-01",
};

const thinDocument: AuroraThinProfileDocument = {
  version: 1,
  activeProfileId: profile.id,
  profiles: [profile],
};

const mobileDocument: AuroraRuntimeProfileDocument = {
  version: 2,
  activeProfileId: "mobile",
  profiles: [
    {
      version: 2,
      id: "mobile",
      label: "Mobile",
      nodeMode: "remote-console",
      runtimeTier: "none",
      homeConnection: {
        mode: "http-only",
        gatewayUrl: "https://gateway.example.invalid",
      },
      localNode: {
        nodeName: "Aurora mobile",
        stablePeerId: "mobile-peer-01",
        enabledCapabilityPacks: [],
      },
    },
  ],
};

function bridge(
  overrides: Partial<TauriNativeVoiceBridge> = {},
): TauriNativeVoiceBridge & {
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  emit: (payload: unknown) => void;
  unlisten: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let handler: ((event: { payload: unknown }) => void) | null = null;
  const unlisten = vi.fn();
  return {
    calls,
    unlisten,
    emit: (payload) => handler?.({ payload }),
    invoke: (vi.fn(
      async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return validStatus as T;
      },
    ) as TauriNativeVoiceBridge["invoke"]),
    listen: vi.fn(async (event, nextHandler) => {
      expect(event).toBe(AURORA_NATIVE_VOICE_STATUS_EVENT);
      handler = nextHandler as (event: { payload: unknown }) => void;
      return unlisten;
    }),
    ...overrides,
  };
}

describe("Tauri native desktop voice port", () => {
  beforeEach(() => {
    tauriCoreMock.invoke.mockImplementation(async () => validStatus);
    tauriEventMock.listen.mockImplementation(async () => vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    tauriCoreMock.invoke.mockReset();
    tauriEventMock.listen.mockReset();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    delete (window as typeof window & {
      __TAURI_INTERNALS__?: unknown;
    }).__TAURI_INTERNALS__;
  });

  it("uses exact native voice commands with typed bounded request payloads", async () => {
    const native = bridge();
    const port = createTauriNativeDesktopVoicePort(native);

    await expect(port.status()).resolves.toEqual(validStatus);
    await expect(
      port.start({
        trigger: "focused_push_to_talk",
        remoteAudioConsent: false,
      }),
    ).resolves.toEqual(validStatus);
    await expect(
      port.finish({
        generation: 2,
        reason: "user_request",
      }),
    ).resolves.toEqual(validStatus);
    await expect(
      port.cancel({
        generation: 3,
        reason: "shutdown",
      }),
    ).resolves.toEqual(validStatus);

    expect(native.calls).toEqual([
      { command: "aurora_native_voice_status", args: { request: {} } },
      {
        command: "aurora_native_voice_start",
        args: {
          request: {
            trigger: "focused_push_to_talk",
            remoteAudioConsent: false,
          },
        },
      },
      {
        command: "aurora_native_voice_finish",
        args: {
          request: {
            generation: 2,
            reason: "user_request",
          },
        },
      },
      {
        command: "aurora_native_voice_cancel",
        args: {
          request: {
            generation: 3,
            reason: "shutdown",
          },
        },
      },
    ]);
  });

  it("rejects malformed command responses without echoing sensitive fields", async () => {
    const native = bridge({
      invoke: (vi.fn(
        async <T,>() =>
          ({
            ...validStatus,
            transcript: "do not echo this",
          }) as T,
      ) as TauriNativeVoiceBridge["invoke"]),
    });
    const port = createTauriNativeDesktopVoicePort(native);

    await expect(port.status()).rejects.toThrow(
      "Native voice status payload is invalid.",
    );
    await expect(port.status()).rejects.not.toThrow("do not echo this");
  });

  it("rejects invalid outgoing controls before invoking native commands", async () => {
    const native = bridge();
    const port = createTauriNativeDesktopVoicePort(native);

    await expect(
      port.start({
        trigger: "focused_push_to_talk",
        remoteAudioConsent: "yes",
      } as never),
    ).rejects.toThrow("Native voice start request is invalid.");
    await expect(
      port.cancel({
        generation: 0,
        reason: "user_request",
      }),
    ).rejects.toThrow("Native voice control request is invalid.");
    expect(native.calls).toEqual([]);
  });

  it("drops malformed events and cleans up a subscription exactly once", async () => {
    const native = bridge();
    const port = createTauriNativeDesktopVoicePort(native);
    const listener = vi.fn();

    const unsubscribe = await port.subscribe(listener);
    native.emit({
      sequence: 1,
      status: {
        ...validStatus,
        endpoint: "https://sensitive.example.invalid",
      },
    });
    native.emit({
      sequence: 2,
      status: validStatus,
    });
    unsubscribe();
    unsubscribe();
    native.emit({
      sequence: 3,
      status: validStatus,
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      sequence: 2,
      status: validStatus,
    });
    expect(native.unlisten).toHaveBeenCalledOnce();
  });

  it("exposes native voice only for real desktop Tauri surfaces", () => {
    expect(createAuroraTauriRuntime().nativeVoice).toBeUndefined();

    Object.defineProperty(window, "__TAURI__", {
      value: {},
      configurable: true,
    });
    const desktopLocal = createAuroraTauriRuntime();
    expect(desktopLocal.mode).toBe("desktop-local");
    expect(desktopLocal.nativeVoice).toBeDefined();

    const desktopThin = createAuroraTauriRuntime({
      thinProfileDocument: thinDocument,
    });
    expect(desktopThin.mode).toBe("desktop-thin");
    expect(desktopThin.nativeVoice).toBeDefined();

    vi.stubEnv("VITE_AURORA_RUNTIME_MODE", "android");
    const mobile = createAuroraTauriRuntime({
      runtimeProfileDocument: mobileDocument,
    });
    expect(mobile.mode).toBe("mobile-native");
    expect(mobile.nativeVoice).toBeUndefined();
  });

  it("carries native voice through NativeContext and into the assistant route", () => {
    const source = readFileSync(
      join(process.cwd(), "src/tauri-app.tsx"),
      "utf8",
    );

    expect(source).toContain("nativeVoice: runtime.nativeVoice");
    expect(source).toContain(
      "nativeVoice?: AuroraTauriRuntime[\"nativeVoice\"]",
    );
    expect(source).toContain("nativeVoice={nativeContext.nativeVoice}");
  });
});
