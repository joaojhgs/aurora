// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopLiveE2eCredentialStore,
  desktopLivePairingConfirmationMode,
  desktopLiveSignalingId,
  drainRemoteConsoleManifestHandshake,
  installDesktopLiveE2eHook,
  isDesktopLiveE2eHookEnabled,
  isDesktopLiveNativeWebRtcForced,
  resolveDesktopLivePeerConnectionPrimitive,
  retryDesktopProviderReadiness,
  validateDesktopLiveE2ePayload,
  waitForAc18BrowserProbe,
  waitForPostRevocationPairingObservation,
  type DesktopLiveRevocationSnapshot,
  type DesktopLiveE2ePayload,
  type DesktopLiveE2eReport,
} from "./desktop-live-e2e";

const liveEnv = {
  VITE_AURORA_DESKTOP_LIVE_E2E: "1",
  VITE_AURORA_CONNECTION_MODE: "webrtc-only",
  VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: "1",
};

describe("desktop live E2E WebView hook", () => {
  it("is gated to the explicit desktop live dev/test WebView environment", () => {
    expect(isDesktopLiveE2eHookEnabled(liveEnv)).toBe(true);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_DESKTOP_LIVE_E2E: "0" })).toBe(false);
    expect(isDesktopLiveE2eHookEnabled({ ...liveEnv, VITE_AURORA_DESKTOP_LIVE_E2E: "0" })).toBe(false);
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
    expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, false, true)).toBe("tauri-native-webrtc");
    expect(resolveDesktopLivePeerConnectionPrimitive({
      ...liveEnv,
      VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "1",
    }, true, true)).toBe("tauri-native-webrtc");
  });

  it("selects the Linux Tauri native WebRTC bridge when browser RTCPeerConnection is absent", () => {
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 AuroraTauri/1.0",
    );
    try {
      expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, false)).toBe("tauri-native-webrtc");
      expect(resolveDesktopLivePeerConnectionPrimitive({
        ...liveEnv,
        VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "1",
      }, true)).toBe("tauri-native-webrtc");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("falls back to the browser primitive only where the native transport is unavailable", () => {
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    try {
      // A surface with no native transport behind it still has to use the
      // WebView primitive, and has nothing to fall back to without one.
      expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, true, false)).toBe("browser-rtcpeerconnection");
      expect(() => resolveDesktopLivePeerConnectionPrimitive(liveEnv, false, false)).toThrow(
        "requires browser RTCPeerConnection where the native transport is unavailable",
      );
      expect(() => resolveDesktopLivePeerConnectionPrimitive({
        ...liveEnv,
        VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "1",
      }, true, false)).toThrow(
        "requires browser RTCPeerConnection where the native transport is unavailable",
      );
      // macOS reaches the native transport now that it is no longer Linux-only,
      // so the derived surface no longer refuses it.
      expect(resolveDesktopLivePeerConnectionPrimitive(liveEnv, false)).toBe("tauri-native-webrtc");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("uses a fresh transient signaling identity after switching roles", () => {
    const baseSignalingId = "desktop-browser-g009";
    const remoteConsoleId = desktopLiveSignalingId(baseSignalingId, "remote-console");
    const meshNodeId = desktopLiveSignalingId(baseSignalingId, "mesh-node");

    expect(remoteConsoleId).toBe(baseSignalingId);
    expect(meshNodeId).toBe(`${baseSignalingId}-mesh`);
    expect(meshNodeId).not.toBe(remoteConsoleId);
  });

  it("hands mesh-node pairing control to the revocation-aware contract", () => {
    expect(desktopLivePairingConfirmationMode("remote-console")).toBe("automatic");
    expect(desktopLivePairingConfirmationMode("mesh-node")).toBe("managed");
  });

  it("keeps shared credentials alive until both role runtimes are finished", async () => {
    const store = new DesktopLiveE2eCredentialStore();
    const roomSecret = "abcdefghijklmnopqrstuvwxyz012345";
    store.setRoomSecret("desktop-live.room", roomSecret);

    await store.close();
    const borrowedSecret = await store.getRoomSecret("desktop-live.room");
    expect(new TextDecoder().decode(borrowedSecret ?? new Uint8Array())).toBe(roomSecret);

    await store.destroy();
    await expect(store.getRoomSecret("desktop-live.room")).resolves.toBeNull();
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

  it("drains the remote-console manifest ACK path before role switching", async () => {
    const calls: string[] = [];
    let pendingCallCount = 1;
    const runtime = {
      meshTransport: {
        getManifest: vi.fn(async (peerId: string) => {
          calls.push(`manifest:${peerId}`);
          return { peerId, services: [] };
        }),
      },
      client: {
        registry: {
          getRegistry: vi.fn(async () => {
            calls.push("registry");
            pendingCallCount = 0;
            return { modules: [] };
          }),
        },
      },
      peer: {
        snapshot: vi.fn(() => ({ pendingCallCount })),
      },
    };

    await drainRemoteConsoleManifestHandshake(runtime, {
      expectedStablePeerId: "python-gateway-g009",
      timeoutMs: 30_000,
    });

    expect(calls).toEqual(["manifest:python-gateway-g009", "registry"]);
    expect(runtime.meshTransport.getManifest).toHaveBeenCalledOnce();
    expect(runtime.client.registry.getRegistry).toHaveBeenCalledOnce();
  });

  it("retries transient provider readiness after WebRTC authorization", async () => {
    let attempts = 0;
    const result = await retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Provider is not ready"), {
            status: 425,
            detail: { reason_code: "provider_not_ready" },
          });
        }
        return { modules: [] };
      },
      "registry readiness test",
      1000,
      1,
    );

    expect(result).toEqual({ modules: [] });
    expect(attempts).toBe(2);
  });

  it("retries normalized mesh provider readiness errors with a semantic SDK code", async () => {
    let attempts = 0;
    const result = await retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Provider is not ready"), {
            code: "unavailable_service",
            status: 425,
            detail: { reason_code: "provider_not_ready" },
          });
        }
        return { modules: [] };
      },
      "registry readiness test",
      1000,
      1,
    );

    expect(result).toEqual({ modules: [] });
    expect(attempts).toBe(2);
  });

  it("retries provider readiness errors nested by mesh normalization", async () => {
    let attempts = 0;
    const result = await retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Provider is not ready"), {
            code: "unknown",
            detail: {
              code: 425,
              message: "Provider is not ready",
              reason_code: "provider_not_ready",
            },
          });
        }
        return { modules: [] };
      },
      "registry readiness test",
      1000,
      1,
    );

    expect(result).toEqual({ modules: [] });
    expect(attempts).toBe(2);
  });

  it("does not retry non-transient provider failures", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("permission denied"), {
      status: 403,
      detail: { reason_code: "peer_authority_revoked" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry unrelated 425 failures without the provider readiness reason", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("request is already active"), {
      status: 425,
      detail: { reason_code: "request_in_progress" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry conflicting status 403 and code 425 provider readiness failures", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("forbidden"), {
      status: 403,
      code: 425,
      detail: { reason_code: "provider_not_ready" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry conflicting status 425 and code 403 provider readiness failures", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("forbidden"), {
      status: 425,
      code: 403,
      detail: { reason_code: "provider_not_ready" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry provider readiness reasons normalized to a non-transient SDK code", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("permission denied"), {
      code: "permission",
      status: 425,
      detail: { reason_code: "provider_not_ready" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry message-only provider readiness text", async () => {
    let attempts = 0;
    const failure = new Error("Provider is not ready");

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("keeps the authorized mesh epoch alive until the reverse browser-tool probe finishes", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        probeId: "ac18-browser-tool-direct",
        invocationRecords: [] as Array<Record<string, unknown>>,
        auditRecords: [] as Array<Record<string, unknown>>,
      };
      const waiting = waitForAc18BrowserProbe(
        probe as unknown as Parameters<typeof waitForAc18BrowserProbe>[0],
        1_000,
      );
      setTimeout(() => {
        probe.invocationRecords.push({ probe_id: probe.probeId });
        probe.auditRecords.push({
          action: "execute",
          result: "not_found",
          correlation_id: `${probe.probeId}-negative`,
        });
      }, 200);

      await vi.advanceTimersByTimeAsync(300);

      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits past the old fixed revocation window until a new pairing prompt is observed", async () => {
    vi.useFakeTimers();
    try {
      const snapshots: DesktopLiveRevocationSnapshot[] = [];
      let current: DesktopLiveRevocationSnapshot = { state: "discovering-peer" };
      setTimeout(() => {
        current = { state: "awaiting-sas-confirmation", pendingPairing: { peerId: "python-gateway-g009" } };
        snapshots.push(current);
      }, 3_000);

      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => current,
        snapshots,
        startIndex: 0,
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(600);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "awaiting-sas-confirmation" },
        pendingPairingPrompts: 1,
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a transient post-revocation pairing prompt sticky until SAS confirmation is observed", async () => {
    vi.useFakeTimers();
    try {
      let current: DesktopLiveRevocationSnapshot = { state: "discovering-peer" };
      setTimeout(() => {
        current = { state: "discovering-peer", pendingPairing: { peerId: "python-gateway-g009" } };
      }, 100);
      setTimeout(() => {
        current = { state: "awaiting-sas-confirmation" };
      }, 200);

      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => current,
        snapshots: [],
        startIndex: 0,
        timeoutMs: 1_000,
        intervalMs: 50,
      });
      await vi.advanceTimersByTimeAsync(250);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "awaiting-sas-confirmation" },
        pendingPairingPrompts: 1,
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat awaiting SAS confirmation as success without an observed post-revocation prompt", async () => {
    vi.useFakeTimers();
    try {
      let current: DesktopLiveRevocationSnapshot = { state: "discovering-peer" };
      setTimeout(() => {
        current = { state: "awaiting-sas-confirmation" };
      }, 100);

      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => current,
        snapshots: [],
        startIndex: 0,
        timeoutMs: 500,
        intervalMs: 50,
      });
      await vi.advanceTimersByTimeAsync(600);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "awaiting-sas-confirmation" },
        pendingPairingPrompts: 0,
        elapsedMs: 500,
        timeoutMs: 500,
        timedOut: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately if a revoked credential becomes authorized", async () => {
    vi.useFakeTimers();
    try {
      let current: DesktopLiveRevocationSnapshot = { state: "discovering-peer" };
      setTimeout(() => {
        current = { state: "authorized" };
      }, 300);

      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => current,
        snapshots: [],
        startIndex: 0,
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(400);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "authorized" },
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately when revoked reconnect reaches terminal failure", async () => {
    vi.useFakeTimers();
    try {
      let current: DesktopLiveRevocationSnapshot = { state: "discovering-peer" };
      setTimeout(() => {
        current = { state: "failed" };
      }, 300);

      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => current,
        snapshots: [],
        startIndex: 0,
        timeoutMs: 5_000,
        intervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(400);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "failed" },
        elapsedMs: 300,
        timeoutMs: 5_000,
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a full bounded window when revocation remains fail-closed while discovering", async () => {
    vi.useFakeTimers();
    try {
      const observing = waitForPostRevocationPairingObservation({
        snapshot: () => ({ state: "discovering-peer" }),
        snapshots: [],
        startIndex: 0,
        timeoutMs: 1_000,
        intervalMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(observing).resolves.toMatchObject({
        snapshot: { state: "discovering-peer" },
        pendingPairingPrompts: 0,
        elapsedMs: 1_000,
        timeoutMs: 1_000,
        timedOut: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry conflicting 403 failures with nested provider readiness text", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("forbidden"), {
      status: 403,
      detail: { message: "Provider is not ready", reason_code: "peer_authority_revoked" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry conflicting 500 failures with nested provider readiness reason", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("gateway failed"), {
      status: 500,
      error: { reason_code: "provider_not_ready" },
    });

    await expect(retryDesktopProviderReadiness(
      async () => {
        attempts += 1;
        throw failure;
      },
      "registry readiness test",
      1000,
      1,
    )).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("keeps hook implementation out of the shared Tauri app route module", async () => {
    const tauriApp = await readFile(resolve(import.meta.dirname, "tauri-app.tsx"), "utf8");
    const main = await readFile(resolve(import.meta.dirname, "main.tsx"), "utf8");
    expect(tauriApp).not.toContain("__AURORA_DESKTOP_LIVE_E2E__");
    expect(main).toContain("installDesktopLiveE2eHook");
  });

  it("uses the supported Tauri API instead of requiring the optional global bridge", async () => {
    const source = await readFile(resolve(import.meta.dirname, "desktop-live-e2e.ts"), "utf8");

    expect(source).toContain('import { invoke as tauriInvoke } from "@tauri-apps/api/core";');
    expect(source).toContain("tauriInvoke(command, args)");
    expect(source).not.toContain("Desktop live E2E requires the Tauri invoke bridge");
  });

  it("binds the reverse provider grant to the credential issued by native Rust", async () => {
    const source = await readFile(resolve(import.meta.dirname, "desktop-live-e2e.ts"), "utf8");

    expect(source).toContain("const authorityPairingIssuer = authorizationStore.asPairingIssuerPort()");
    expect(source).toContain("tokenId: issued.verifier.tokenId");
    expect(source).toContain("peerAuthorityResolver: authorizationStore.asResolverPort()");
    expect(source).toContain("peerPairingIssuer: ac18.peerPairingIssuer");
    expect(source).not.toContain('tokenId: "interop-token-row"');
  });

  it("fails a stalled fragmented RPC before the WebDriver deadline with stage diagnostics", async () => {
    const source = await readFile(resolve(import.meta.dirname, "desktop-live-e2e.ts"), "utf8");

    expect(source).toContain('stage = "fragmented-large-rpc";');
    expect(source).toContain("Math.min(30_000, ready.timeoutMs)");
    expect(source).toContain("const operationTimeoutMs = Math.min(20_000, ready.timeoutMs)");
    expect(source).toContain("timeoutMs: operationTimeoutMs");
    expect(source).toContain("pendingCallCount: snapshot.pendingCallCount");
    expect(source).toContain("sentFragmentCount: snapshot.sentFragmentCount");
    expect(source).toContain('stage = "wrong-correlation-event";');
    expect(source).toContain('"remote-console authorization"');
    expect(source).toContain("negotiationRole: snapshot.negotiationRole");
    const postReconnectRegistryDrain = source.indexOf(
      '"desktop live registry after uncertain mutation WebRTC reconnect"',
    );
    const mutationCountRead = source.indexOf(
      '"desktop live mutation count after WebRTC reconnect"',
    );
    expect(postReconnectRegistryDrain).toBeGreaterThan(-1);
    expect(mutationCountRead).toBeGreaterThan(postReconnectRegistryDrain);
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
