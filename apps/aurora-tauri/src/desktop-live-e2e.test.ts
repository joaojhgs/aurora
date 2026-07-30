// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  installDesktopLiveE2eHook,
  isDesktopLiveE2eHookEnabled,
  isDesktopLiveNativeWebRtcForced,
  resolveDesktopLivePeerConnectionPrimitive,
  validateDesktopLiveE2ePayload,
  type DesktopLiveE2ePayload,
  type DesktopLiveE2eReport,
} from "./desktop-live-e2e";

const liveEnv = {
  VITE_AURORA_DESKTOP_LIVE_E2E: "1",
  VITE_AURORA_RUNTIME_MODE: "desktop-thin",
  VITE_AURORA_CONNECTION_MODE: "webrtc-only",
  VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: "1",
};

describe("desktop live E2E WebView hook", () => {
  it("is gated to the explicit desktop live dev/test WebView environment", () => {
    expect(isDesktopLiveE2eHookEnabled(liveEnv)).toBe(true);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_DESKTOP_LIVE_E2E: "0" })).toBe(false);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_RUNTIME_MODE: "desktop-local" })).toBe(false);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_CONNECTION_MODE: "http-only" })).toBe(false);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: "0" })).toBe(false);
  });

  it("can force the Linux native WebRTC primitive for the live desktop gate", () => {
    expect(isDesktopLiveNativeWebRtcForced(liveEnv)).toBe(false);
    expect(isDesktopLiveNativeWebRtcForced({
      ...liveEnv,
      VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "1",
    })).toBe(true);
    expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, true)).toBe("browser-rtcpeerconnection");
    expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, false)).toBe("tauri-native-webrtc");
    expect(resolveDesktopLivePeerConnectionPrimitive({
      ...liveEnv,
      VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "1",
    }, true)).toBe("tauri-native-webrtc");
  });

  it("does not install outside the gated environment", () => {
    const target = {} as Window;
    expect(installDesktopLiveE2eHook({ target, env: { ...liveEnv, VITE_AURORA_DESKTOP_LIVE_E2E: "0" } })).toBe(false);
    expect((target as { __AURORA_DESKTOP_LIVE_E2E__?: unknown }).__AURORA_DESKTOP_LIVE_E2E__).toBeUndefined();
  });

  it("installs a nonce/PID-validating hook and returns only the runner report", async () => {
    const payload = samplePayload();
    const report: DesktopLiveE2eReport = {
      schema: "aurora.desktop_live_e2e.desktop_report.v1",
      status: "passed",
      sessionNonce: payload.sessionNonce,
      tauriPid: payload.tauriPid,
      secretsRedacted: true,
      noHttpFetchTransportUsed: true,
      roleSwitchEvidence: {
        passed: true,
        from: "remote-console",
        to: "mesh-node",
        remoteConsoleAuthorized: true,
        meshNodeAuthorized: true,
      },
      browserResult: { authorized: true },
      desktopResult: { inviteValidated: true },
      durationMs: 12,
    };
    const runDesktopLiveE2e = vi.fn(async () => report);
    const target = {} as Window & {
      __AURORA_DESKTOP_LIVE_E2E__?: (payload: unknown) => Promise<DesktopLiveE2eReport>;
    };
    expect(installDesktopLiveE2eHook({ target, env: liveEnv, runDesktopLiveE2e })).toBe(true);
    await expect(target.__AURORA_DESKTOP_LIVE_E2E__?.(payload)).resolves.toEqual(report);
    expect(runDesktopLiveE2e).toHaveBeenCalledWith(validateDesktopLiveE2ePayload(payload));
    await expect(target.__AURORA_DESKTOP_LIVE_E2E__?.({ ...payload, sessionNonce: "wrong" })).rejects.toThrow(/sessionNonce/u);
    await expect(target.__AURORA_DESKTOP_LIVE_E2E__?.({ ...payload, tauriPid: "0" })).rejects.toThrow(/tauriPid/u);
  });

  it("requires a mesh-node runtime profile and invite secret that matches the payload", () => {
    const payload = samplePayload();
    expect(validateDesktopLiveE2ePayload(payload).runtimeProfile.activeProfileId).toBe("desktop-live-direct");
    expect(() =>
      validateDesktopLiveE2ePayload({
        ...payload,
        runtimeProfile: {
          ...payload.runtimeProfile,
          profiles: [{
            ...payload.runtimeProfile.profiles[0],
            nodeMode: "remote-console",
            runtimeTier: "none",
            localNode: {
              ...payload.runtimeProfile.profiles[0].localNode,
              enabledCapabilityPacks: [],
              meshMembership: undefined,
            },
          }],
        },
      }),
    ).toThrow(/mesh-node/u);
    expect(() =>
      validateDesktopLiveE2ePayload({
        ...payload,
        invite: {
          ...payload.invite,
          signaling: {
            ...(payload.invite.signaling as Record<string, unknown>),
            room_password: "different-secret-value",
          },
        },
      }),
    ).toThrow(/room secret/u);
  });

  it("keeps hook implementation out of the shared Tauri app route module", async () => {
    const tauriApp = await readFile(resolve(import.meta.dirname, "tauri-app.tsx"), "utf8");
    const main = await readFile(resolve(import.meta.dirname, "main.tsx"), "utf8");
    expect(tauriApp).not.toContain("__AURORA_DESKTOP_LIVE_E2E__");
    expect(main).toContain("installDesktopLiveE2eHook");
  });
});

function samplePayload(): DesktopLiveE2ePayload {
  const roomSecret = "abcdefghijklmnopqrstuvwxyz012345";
  const ready: DesktopLiveE2ePayload["ready"] = {
    lane: "direct",
    appId: "aurora",
    room: "desktop-live-test",
    brokerUrl: "ws://127.0.0.1:9001/mqtt",
    expectedStablePeerId: "python-gateway-g009",
    localStablePeerId: "browser-g009",
    localSignalingId: "desktop-browser-g009",
    expectedNegotiationRole: "offerer",
    nodeName: "G009 Python Gateway",
    stunServers: [],
    turnServers: [],
    forceRelay: false,
    suppressHostCandidates: false,
    eventTopic: "Interop.SafeEvent",
    eventCorrelationId: "g009-corr-direct",
    ttsEventTopic: "TTS.AudioChunk",
    ttsCorrelationId: "g009-tts-direct",
    wrongCorrelationId: "g009-wrong-direct",
    mutationTopic: "Interop.Mutate",
    mutationCountTopic: "Interop.MutationCount",
    mutationStartedTopic: "Interop.MutationStarted",
    revokeTopic: "Auth.Revoke",
    largeEchoTopic: "Interop.LargeEcho",
    errorTopic: "Interop.Error",
    streamTopic: "Orchestrator.StreamInferChat",
    streamStatusTopic: "Interop.StreamStatus",
    ac18LocalToolProvider: true,
    ac18ToolContractId: "interop.browser.echo",
    ac18ToolLocalName: "interop.browser.echo",
    ac18ProbeId: "ac18-browser-tool-direct",
    ac18ForgedFramePeerId: "forged-ac18-frame-peer",
    timeoutMs: 30_000,
  };
  return {
    schema: "aurora.desktop_live_e2e.hook_payload.v1",
    sessionNonce: "nonce_abcdefghijklmnopqrstuvwxyz",
    tauriPid: "12345",
    ready,
    roomSecret,
    readyPath: "/tmp/ready.json",
    runtimeProfilePath: "/tmp/runtime.json",
    invitePath: "/tmp/invite.json",
    reportPath: "/tmp/report.json",
    donePath: "/tmp/done.json",
    runtimeProfile: {
      version: 2,
      activeProfileId: "desktop-live-direct",
      profiles: [{
        version: 2,
        id: "desktop-live-direct",
        label: "Desktop live peer",
        nodeMode: "mesh-node",
        runtimeTier: "lightweight-ts",
        homeConnection: {
          mode: "webrtc-only",
          signalingUrl: ready.brokerUrl,
          homePeerId: ready.expectedStablePeerId,
          webrtcProfile: {
            mode: "webrtc-only",
            appId: ready.appId,
            room: ready.room,
            roomSecretRef: "desktop-live-direct.room",
            signalingBrokers: [ready.brokerUrl],
            expectedStablePeerId: ready.expectedStablePeerId,
            expectedSignalingPeerId: ready.expectedStablePeerId,
            nodeName: ready.nodeName,
            production: false,
            allowInsecureLoopbackSignaling: true,
            stunServers: [],
            turnServers: [],
            requireAppLayerE2ee: true,
          },
        },
        localNode: {
          nodeName: "Aurora desktop live E2E",
          stablePeerId: ready.localStablePeerId,
          enabledCapabilityPacks: ["native-actions", "local-tools"],
          meshMembership: {
            signalingUrl: ready.brokerUrl,
            webrtcProfile: {
              mode: "webrtc-only",
              appId: ready.appId,
              room: ready.room,
              roomSecretRef: "desktop-live-direct.room",
              signalingBrokers: [ready.brokerUrl],
              expectedStablePeerId: ready.expectedStablePeerId,
              expectedSignalingPeerId: ready.expectedStablePeerId,
              nodeName: ready.nodeName,
              production: false,
              allowInsecureLoopbackSignaling: true,
              stunServers: [],
              turnServers: [],
              requireAppLayerE2ee: true,
            },
          },
        },
      }],
    },
    invite: {
      kind: "aurora.mesh.invite",
      version: 1,
      node: {
        peer_id: ready.expectedStablePeerId,
        node_name: ready.nodeName,
      },
      signaling: {
        provider: "mqtt",
        app_id: ready.appId,
        room: ready.room,
        room_password: roomSecret,
        encrypt_signaling: true,
        mqtt_brokers: [ready.brokerUrl],
        mqtt_topic_root: "aurora",
      },
    },
  };
}
