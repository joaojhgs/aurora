import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MeshSessionBindError,
  MeshSessionCleanupError,
  bindMeshSessionPeer,
  installMeshSessionRuntimeLink,
  observeMeshSurfaceLifecycle,
  setMeshSurfaceLifecycle,
  unbindMeshSessionPeer,
  type MeshSessionInvoke,
} from "./mesh-session-link";

function recordingInvoke(result: unknown = {}): {
  invoke: MeshSessionInvoke;
  calls: { command: string; args: Record<string, unknown> | undefined }[];
} {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return result;
  }) as MeshSessionInvoke;
  return { invoke, calls };
}

function fakeDocument(visibilityState: DocumentVisibilityState = "visible") {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener as () => void);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener as () => void);
    },
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function jsonDrain(frame: unknown) {
  return { kind: "json" as const, frame };
}

describe("mesh session link", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds a peer to the transport handles it was given", async () => {
    const { invoke, calls } = recordingInvoke({
      peerId: "peer-a",
      sessions: 1,
      deviceLinkHeld: true,
    });

    const result = await bindMeshSessionPeer(invoke, "peer-a", {
      handles: { peerConnectionId: 7, dataChannelId: 9 },
      authenticatedPeerContext: { selector: { claimantPeerId: "peer-a" } },
    });

    expect(calls).toEqual([
      {
        command: "aurora_mesh_session_bind",
        args: {
          request: {
            peerId: "peer-a",
            peerConnectionId: 7,
            dataChannelId: 9,
            authenticatedPeerContext: { selector: { claimantPeerId: "peer-a" } },
            localPeerId: null,
            providerServiceInstanceId: null,
            nativeDataChannelCodec: null,
            advertisedMethodIds: [],
            manifestMethodsReady: true,
            primary: false,
          },
        },
      },
    ]);
    // Holding a session is what takes the one Aurora foreground service's
    // connected-device reason. R4 built the ledger; this is its first caller.
    expect(result.deviceLinkHeld).toBe(true);
  });

  it("refuses to guess which channel a peer is on", async () => {
    const { invoke, calls } = recordingInvoke();

    // No handles passed and no native transport open in this test process.
    await expect(bindMeshSessionPeer(invoke, "peer-a")).rejects.toBeInstanceOf(
      MeshSessionBindError,
    );
    expect(calls).toHaveLength(0);
  });

  it("carries a null context rather than omitting it", async () => {
    const { invoke, calls } = recordingInvoke();

    await bindMeshSessionPeer(invoke, "peer-a", {
      handles: { peerConnectionId: 1, dataChannelId: 2 },
    });

    const [call] = calls;
    expect(call).toBeDefined();
    const request = (call?.args as { request: Record<string, unknown> }).request;
    expect(request.authenticatedPeerContext).toBeNull();
  });

  it("unbinds by peer id alone", async () => {
    const { invoke, calls } = recordingInvoke();
    await unbindMeshSessionPeer(invoke, "peer-b");
    expect(calls).toEqual([
      { command: "aurora_mesh_session_unbind", args: { request: { peerId: "peer-b" } } },
    ]);
  });

  it("hands Rust a short-lived clone of the active native data-channel key", async () => {
    const transmitted: Record<string, unknown>[] = [];
    const keyClones: Uint8Array[] = [];
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      if (command === "aurora_mesh_session_bind") {
        transmitted.push(structuredClone(args?.request as Record<string, unknown>));
      }
      return command === "aurora_mesh_session_set_lifecycle"
        ? { lifecycle: "foreground", drained: [] }
        : { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const peer = {
      subscribeRoster(listener: (roster: {
        peers: Array<{
          peerId: string;
          primary: boolean;
          snapshot: { state: string; connectedSignalingPeerId: string };
        }>;
      }) => void) {
        listener({
          peers: [{
            peerId: "peer-a",
            primary: true,
            snapshot: {
              state: "authorized",
              connectedSignalingPeerId: "signal-a",
            },
          }],
        });
        return () => undefined;
      },
      nativeDataChannelCodec() {
        const key = new Uint8Array(32).fill(7);
        keyClones.push(key);
        return { version: "aes-256-gcm-nonce-prefix-v1" as const, key };
      },
      async getManifest() {
        return { services: [{ methods: ["Tooling.ExecuteTool"] }] };
      },
    };

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 4,
        dataChannelId: 12,
      }),
      deliverFrame: () => true,
    });

    await vi.waitFor(() => expect(transmitted.length).toBeGreaterThanOrEqual(1));
    expect(transmitted.at(-1)).toMatchObject({
      nativeDataChannelCodec: {
        version: "aes-256-gcm-nonce-prefix-v1",
        keyEpoch: 12,
        keyBytes: new Array(32).fill(7),
      },
    });
    expect(keyClones.length).toBeGreaterThanOrEqual(1);
    expect(keyClones.every((key) => key.every((byte) => byte === 0))).toBe(true);

    await link.close();
  });

  it("sends the lifecycle the dispatcher understands", async () => {
    const { invoke, calls } = recordingInvoke({ lifecycle: "background", drained: [] });
    await setMeshSurfaceLifecycle(invoke, "background");
    expect(calls).toEqual([
      {
        command: "aurora_mesh_session_set_lifecycle",
        args: { request: { lifecycle: "background" } },
      },
    ]);
  });

  it("follows visibility into the background and back", async () => {
    const target = fakeDocument("visible");
    const { invoke, calls } = recordingInvoke({ lifecycle: "foreground", drained: [] });

    const stop = observeMeshSurfaceLifecycle({ invoke, target });
    await Promise.resolve();
    expect(calls.map((call) => call.args)).toEqual([
      { request: { lifecycle: "foreground" } },
    ]);

    target.visibilityState = "hidden";
    target.emit("visibilitychange");
    await Promise.resolve();

    target.visibilityState = "visible";
    target.emit("visibilitychange");
    await vi.waitFor(() => {
      expect(
        calls.map(
          (call) =>
            (call.args as { request: { lifecycle: string } }).request.lifecycle,
        ),
      ).toEqual(["foreground", "background", "foreground"]);
    });
    stop();
    expect(target.listenerCount("visibilitychange")).toBe(0);
  });

  it("does not re-announce a lifecycle it is already in", async () => {
    const target = fakeDocument("visible");
    const { invoke, calls } = recordingInvoke({ lifecycle: "foreground", drained: [] });

    observeMeshSurfaceLifecycle({ invoke, target });
    target.emit("visibilitychange");
    target.emit("visibilitychange");
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  it("re-announces foreground after a native mobile resume", async () => {
    const target = fakeDocument("visible");
    const { invoke, calls } = recordingInvoke({
      lifecycle: "foreground",
      drained: [],
    });

    const stop = observeMeshSurfaceLifecycle({ invoke, target });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    stop.nativeResume();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(
      calls.map(
        (call) =>
          (call.args as { request: { lifecycle: string } }).request.lifecycle,
      ),
    ).toEqual(["foreground", "foreground"]);
    stop();
  });

  it("hands back frames parked while the surface slept, in order", async () => {
    const target = fakeDocument("visible");
    const drained = [
      {
        peerId: "peer-a",
        frames: [jsonDrain({ id: "e-1" }), jsonDrain({ id: "e-2" })],
      },
    ];
    const { invoke } = recordingInvoke({ lifecycle: "foreground", drained });
    const onDrained = vi.fn();

    observeMeshSurfaceLifecycle({ invoke, target, onDrained });
    await vi.waitFor(() => expect(onDrained).toHaveBeenCalledWith(drained));
  });

  it("acknowledges every resume batch before Rust returns to foreground", async () => {
    const target = fakeDocument("visible");
    const calls: string[] = [];
    let finishCount = 0;
    const invoke = (async (command: string) => {
      calls.push(command);
      if (command === "aurora_mesh_session_set_lifecycle") {
        return {
          lifecycle: "resuming",
          drained: [{ peerId: "peer-a", frames: [jsonDrain({ id: "a-1" })] }],
        };
      }
      finishCount += 1;
      return finishCount === 1
        ? {
            lifecycle: "resuming",
            drained: [{ peerId: "peer-a", frames: [jsonDrain({ id: "a-2" })] }],
          }
        : { lifecycle: "foreground", drained: [] };
    }) as MeshSessionInvoke;
    const delivered: unknown[] = [];

    const stop = observeMeshSurfaceLifecycle({
      invoke,
      target,
      onDrained: (drained) => {
        delivered.push(...drained.flatMap((item) => item.frames));
        return true;
      },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls).toEqual([
      "aurora_mesh_session_set_lifecycle",
      "aurora_mesh_session_finish_resume",
      "aurora_mesh_session_finish_resume",
    ]);
    expect(delivered).toEqual([
      jsonDrain({ id: "a-1" }),
      jsonDrain({ id: "a-2" }),
    ]);
    stop();
  });

  it("does not acknowledge a resume batch until its exact channel is ready", async () => {
    const target = fakeDocument("visible");
    const calls: string[] = [];
    let canDeliver = false;
    const invoke = (async (command: string) => {
      calls.push(command);
      return command === "aurora_mesh_session_set_lifecycle"
        ? {
            lifecycle: "resuming",
            drained: [{ peerId: "peer-a", frames: [jsonDrain({ id: "a-1" })] }],
          }
        : { lifecycle: "foreground", drained: [] };
    }) as MeshSessionInvoke;

    const stop = observeMeshSurfaceLifecycle({
      invoke,
      target,
      onDrained: () => canDeliver,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual(["aurora_mesh_session_set_lifecycle"]);

    canDeliver = true;
    stop.retryResume();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe("aurora_mesh_session_finish_resume");
    stop();
  });

  it("reports a failing lifecycle command without changing the safe-direction behavior", async () => {
    const target = fakeDocument("hidden");
    const error = new Error("command unavailable");
    const onLifecycleFailure = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const invoke = (async () => {
      throw error;
    }) as MeshSessionInvoke;

    expect(() => observeMeshSurfaceLifecycle({
      invoke,
      target,
      onLifecycleFailure,
    })).not.toThrow();
    await vi.waitFor(() => {
      expect(onLifecycleFailure).toHaveBeenCalledWith({
        phase: "set_lifecycle",
        requestedLifecycle: "background",
        error,
      });
    });
  });

  it("binds multiple authorized peers to exact signaling channels and replays per peer", async () => {
    const target = fakeDocument("hidden");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        const lifecycle = (
          args as { request: { lifecycle: string } }
        ).request.lifecycle;
        return {
          lifecycle,
          drained:
            lifecycle === "foreground"
              ? [
                  {
                    peerId: "peer-a",
                    frames: [jsonDrain({ id: "a-1" }), jsonDrain({ id: "a-2" })],
                  },
                  { peerId: "peer-b", frames: [jsonDrain({ id: "b-1" })] },
                ]
              : [],
        };
      }
      return { peerId: "ok", sessions: 2, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const roster: {
      peers: Array<{
        peerId: string;
        primary: boolean;
        authenticatedPeerContext: { claimant: string };
        snapshot: {
          state: string;
          connectedSignalingPeerId: string;
        };
      }>;
    } = {
      peers: [
        {
          peerId: "peer-a",
          primary: true,
          authenticatedPeerContext: { claimant: "peer-a" },
          snapshot: {
            state: "authorized",
            connectedSignalingPeerId: "signal-a",
          },
        },
        {
          peerId: "peer-b",
          primary: false,
          authenticatedPeerContext: { claimant: "peer-b" },
          snapshot: {
            state: "authorized",
            connectedSignalingPeerId: "signal-b",
          },
        },
      ],
    };
    let rosterListener: ((value: typeof roster) => void) | undefined;
    const peer = {
      subscribeRoster(listener: (value: typeof roster) => void) {
        rosterListener = listener;
        listener(roster);
        return () => {
          rosterListener = undefined;
        };
      },
      async getManifest(peerId: string) {
        return {
          services: [
            {
              methods:
                peerId === "peer-a"
                  ? ["Orchestrator.ExternalUserInput"]
                  : ["Tooling.GetTools"],
            },
          ],
        };
      },
    };
    const delivered: Array<{ dataChannelId: number; frame: unknown }> = [];
    const handles = new Map([
      ["signal-a", { peerConnectionId: 1, dataChannelId: 11 }],
      ["signal-b", { peerConnectionId: 2, dataChannelId: 22 }],
    ]);

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      localPeerId: "local-peer",
      providerServiceInstanceId: "local:local-peer:Tooling",
      handleForRemoteSignalingId: (peerId) => handles.get(peerId) ?? null,
      deliverFrame: (dataChannelId, frame) => {
        delivered.push({ dataChannelId, frame });
        return true;
      },
      lifecycleTarget: target,
    });
    await vi.waitFor(() => {
      const binds = calls.filter(
        ({ command }) => command === "aurora_mesh_session_bind",
      );
      expect(binds.length).toBeGreaterThanOrEqual(4);
    });

    const latestBindByPeer = new Map<string, Record<string, unknown>>();
    for (const call of calls.filter(
      ({ command }) => command === "aurora_mesh_session_bind",
    )) {
      const request = (call.args as { request: Record<string, unknown> }).request;
      latestBindByPeer.set(String(request.peerId), request);
    }
    expect(latestBindByPeer.get("peer-a")).toMatchObject({
      peerConnectionId: 1,
      dataChannelId: 11,
      advertisedMethodIds: ["Orchestrator.ExternalUserInput"],
      primary: true,
    });
    expect(latestBindByPeer.get("peer-b")).toMatchObject({
      peerConnectionId: 2,
      dataChannelId: 22,
      advertisedMethodIds: ["Tooling.GetTools"],
      primary: false,
    });

    target.visibilityState = "visible";
    target.emit("visibilitychange");
    await vi.waitFor(() => expect(delivered).toHaveLength(3));
    expect(delivered).toEqual([
      { dataChannelId: 11, frame: jsonDrain({ id: "a-1" }) },
      { dataChannelId: 11, frame: jsonDrain({ id: "a-2" }) },
      { dataChannelId: 22, frame: jsonDrain({ id: "b-1" }) },
    ]);

    handles.set("signal-a-2", { peerConnectionId: 3, dataChannelId: 33 });
    rosterListener?.({
      peers: [
        {
          ...roster.peers[0],
          snapshot: {
            state: "authorized",
            connectedSignalingPeerId: "signal-a-2",
          },
        },
        roster.peers[1],
      ],
    });
    await vi.waitFor(() => {
      const peerABinds = calls.filter(
        ({ command, args }) =>
          command === "aurora_mesh_session_bind" &&
          (args as { request: { peerId: string; dataChannelId: number } })
            .request.peerId === "peer-a" &&
          (args as { request: { peerId: string; dataChannelId: number } })
            .request.dataChannelId === 33,
      );
      expect(peerABinds.length).toBeGreaterThanOrEqual(1);
    });

    await link.close();
    expect(rosterListener).toBeUndefined();
    expect(
      calls.filter(
        ({ command }) => command === "aurora_mesh_session_unbind",
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("does not let stale manifest reads rebind a moved peer", async () => {
    const target = fakeDocument("visible");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      return { peerId: "ok", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    let resolveFirstManifest:
      | ((manifest: { services: { methods: string[] }[] }) => void)
      | undefined;
    let rosterListener:
      | ((value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: {
              state: string;
              connectedSignalingPeerId: string;
            };
          }>;
        }) => void)
      | undefined;
    const peer = {
      subscribeRoster(
        listener: NonNullable<typeof rosterListener>,
      ) {
        rosterListener = listener;
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-old",
              },
            },
          ],
        });
        return () => undefined;
      },
      async getManifest(peerId: string) {
        if (peerId !== "peer-a") return null;
        if (!resolveFirstManifest) {
          return await new Promise<{ services: { methods: string[] }[] }>(
            (resolve) => {
              resolveFirstManifest = resolve;
            },
          );
        }
        return { services: [{ methods: ["Tooling.GetTools"] }] };
      },
    };
    const handles = new Map([
      ["signal-old", { peerConnectionId: 1, dataChannelId: 11 }],
      ["signal-new", { peerConnectionId: 2, dataChannelId: 22 }],
    ]);

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: (peerId) => handles.get(peerId) ?? null,
      deliverFrame: () => true,
      lifecycleTarget: target,
    });
    await vi.waitFor(() => {
      expect(resolveFirstManifest).toBeTypeOf("function");
      expect(
        calls.filter(
          ({ command }) => command === "aurora_mesh_session_bind",
        ),
      ).toHaveLength(1);
    });
    rosterListener?.({
      peers: [
        {
          peerId: "peer-a",
          primary: true,
          snapshot: {
            state: "authorized",
            connectedSignalingPeerId: "signal-new",
          },
        },
      ],
    });
    await vi.waitFor(() => {
      const peerABinds = calls.filter(
        ({ command }) => command === "aurora_mesh_session_bind",
      );
      expect(peerABinds.length).toBeGreaterThanOrEqual(2);
    });
    resolveFirstManifest?.({
      services: [{ methods: ["Orchestrator.ExternalUserInput"] }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const staleMethodBinds = calls.filter(({ command, args }) => {
      if (command !== "aurora_mesh_session_bind") return false;
      const request = (args as { request: Record<string, unknown> }).request;
      return (
        request.dataChannelId === 11 &&
        Array.isArray(request.advertisedMethodIds) &&
        request.advertisedMethodIds.includes("Orchestrator.ExternalUserInput")
      );
    });
    expect(staleMethodBinds).toHaveLength(0);
    await link.close();
  });

  it("marks native methods unresolved until delayed manifest hydration finishes", async () => {
    const target = fakeDocument("visible");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    let resolveManifest:
      | ((manifest: { services: { methods: string[] }[] }) => void)
      | undefined;
    const peer = {
      subscribeRoster(
        listener: (value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: { state: string; connectedSignalingPeerId: string };
          }>;
        }) => void,
      ) {
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-a",
              },
            },
          ],
        });
        return () => undefined;
      },
      async getManifest() {
        return await new Promise<{ services: { methods: string[] }[] }>(
          (resolve) => {
            resolveManifest = resolve;
          },
        );
      },
    };

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: target,
    });

    await vi.waitFor(() => {
      const binds = calls.filter(
        ({ command }) => command === "aurora_mesh_session_bind",
      );
      expect(binds).toHaveLength(1);
    });
    const firstBind = calls.find(
      ({ command }) => command === "aurora_mesh_session_bind",
    );
    expect(
      (firstBind?.args as { request: Record<string, unknown> }).request,
    ).toMatchObject({
      peerId: "peer-a",
      dataChannelId: 11,
      advertisedMethodIds: [],
      manifestMethodsReady: false,
      primary: true,
    });

    resolveManifest?.({
      services: [{ methods: ["Orchestrator.ExternalUserInput"] }],
    });
    await vi.waitFor(() => {
      const binds = calls.filter(
        ({ command }) => command === "aurora_mesh_session_bind",
      );
      expect(binds).toHaveLength(2);
    });
    const secondBind = calls.filter(
      ({ command }) => command === "aurora_mesh_session_bind",
    )[1];
    expect(
      (secondBind?.args as { request: Record<string, unknown> }).request,
    ).toMatchObject({
      peerId: "peer-a",
      dataChannelId: 11,
      advertisedMethodIds: ["Orchestrator.ExternalUserInput"],
      manifestMethodsReady: true,
      primary: true,
    });

    await link.close();
  });

  it.each(["rejection", "missing manifest"] as const)(
    "keeps native methods unresolved and retries after a transient manifest %s",
    async (failureMode) => {
      vi.useFakeTimers();
      const target = fakeDocument("visible");
      const calls: { command: string; args?: Record<string, unknown> }[] = [];
      let manifestAttempts = 0;
      const invoke = (async (
        command: string,
        args?: Record<string, unknown>,
      ) => {
        calls.push({ command, args });
        if (command === "aurora_mesh_session_set_lifecycle") {
          return { lifecycle: "foreground", drained: [] };
        }
        return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
      }) as MeshSessionInvoke;
      const peer = {
        subscribeRoster(
          listener: (value: {
            peers: Array<{
              peerId: string;
              primary: boolean;
              snapshot: { state: string; connectedSignalingPeerId: string };
            }>;
          }) => void,
        ) {
          listener({
            peers: [
              {
                peerId: "peer-a",
                primary: true,
                snapshot: {
                  state: "authorized",
                  connectedSignalingPeerId: "signal-a",
                },
              },
            ],
          });
          return () => undefined;
        },
        async getManifest() {
          manifestAttempts += 1;
          if (manifestAttempts === 1) {
            if (failureMode === "rejection") {
              throw new Error("manifest temporarily unavailable");
            }
            return null;
          }
          return {
            services: [{ methods: ["Orchestrator.ExternalUserInput"] }],
          };
        },
      };

      const link = installMeshSessionRuntimeLink({
        invoke,
        peer,
        handleForRemoteSignalingId: () => ({
          peerConnectionId: 1,
          dataChannelId: 11,
        }),
        deliverFrame: () => true,
        lifecycleTarget: target,
        manifestRetryDelaysMs: [25],
      });

      await vi.waitFor(() => expect(manifestAttempts).toBe(1));
      const initialBinds = calls.filter(
        ({ command }) => command === "aurora_mesh_session_bind",
      );
      expect(initialBinds).toHaveLength(1);
      expect(
        (initialBinds[0]?.args as { request: Record<string, unknown> }).request,
      ).toMatchObject({
        advertisedMethodIds: [],
        manifestMethodsReady: false,
      });

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(manifestAttempts).toBe(2));
      await vi.waitFor(() => {
        const binds = calls.filter(
          ({ command }) => command === "aurora_mesh_session_bind",
        );
        expect(binds).toHaveLength(2);
        expect(
          (binds[1]?.args as { request: Record<string, unknown> }).request,
        ).toMatchObject({
          advertisedMethodIds: ["Orchestrator.ExternalUserInput"],
          manifestMethodsReady: true,
        });
      });

      await link.close();
    },
  );

  it("bounds manifest retries without marking methods ready", async () => {
    vi.useFakeTimers();
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let manifestAttempts = 0;
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const link = installMeshSessionRuntimeLink({
      invoke,
      peer: {
        subscribeRoster(listener) {
          listener({
            peers: [
              {
                peerId: "peer-a",
                primary: true,
                snapshot: {
                  state: "authorized",
                  connectedSignalingPeerId: "signal-a",
                },
              },
            ],
          });
          return () => undefined;
        },
        async getManifest() {
          manifestAttempts += 1;
          return null;
        },
      },
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: fakeDocument("visible"),
      manifestRetryDelaysMs: [25],
    });

    await vi.waitFor(() => expect(manifestAttempts).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(manifestAttempts).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manifestAttempts).toBe(2);
    expect(
      calls.filter(({ command, args }) => {
        if (command !== "aurora_mesh_session_bind") return false;
        return (args as { request: { manifestMethodsReady: boolean } }).request
          .manifestMethodsReady;
      }),
    ).toHaveLength(0);

    await link.close();
  });

  it("cancels a pending manifest retry when the link closes", async () => {
    vi.useFakeTimers();
    let manifestAttempts = 0;
    const invoke = (async (command: string) => {
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const link = installMeshSessionRuntimeLink({
      invoke,
      peer: {
        subscribeRoster(listener) {
          listener({
            peers: [
              {
                peerId: "peer-a",
                primary: true,
                snapshot: {
                  state: "authorized",
                  connectedSignalingPeerId: "signal-a",
                },
              },
            ],
          });
          return () => undefined;
        },
        async getManifest() {
          manifestAttempts += 1;
          return null;
        },
      },
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: fakeDocument("visible"),
      manifestRetryDelaysMs: [25],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(manifestAttempts).toBe(1);
    await link.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manifestAttempts).toBe(1);
  });

  it("retries a rejected native unbind without serving a removed peer", async () => {
    vi.useFakeTimers();
    const target = fakeDocument("hidden");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let rosterListener:
      | ((value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: { state: string; connectedSignalingPeerId: string };
          }>;
        }) => void)
      | undefined;
    let unbindAttempts = 0;
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        const lifecycle = (
          args as { request: { lifecycle: string } }
        ).request.lifecycle;
        return {
          lifecycle,
          drained:
            lifecycle === "foreground"
              ? [{ peerId: "peer-a", frames: [jsonDrain({ id: "stale-frame" })] }]
              : [],
        };
      }
      if (command === "aurora_mesh_session_unbind") {
        unbindAttempts += 1;
        if (unbindAttempts === 1) throw new Error("native rejected unbind");
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const peer = {
      subscribeRoster(
        listener: NonNullable<typeof rosterListener>,
      ) {
        rosterListener = listener;
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-a",
              },
            },
          ],
        });
        return () => {
          rosterListener = undefined;
        };
      },
      async getManifest() {
        return { services: [{ methods: ["Tooling.GetTools"] }] };
      },
    };
    const delivered: unknown[] = [];

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: (_dataChannelId, frame) => {
        delivered.push(frame);
        return true;
      },
      lifecycleTarget: target,
      unbindRetryDelaysMs: [25],
    });
    await vi.waitFor(() => {
      expect(
        calls.some(({ command }) => command === "aurora_mesh_session_bind"),
      ).toBe(true);
    });

    rosterListener?.({ peers: [] });
    await vi.waitFor(() => expect(unbindAttempts).toBe(1));

    target.visibilityState = "visible";
    target.emit("visibilitychange");
    await Promise.resolve();
    expect(delivered).toEqual([]);

    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(unbindAttempts).toBe(2));
    expect(delivered).toEqual([]);
    expect(
      calls.filter(({ command }) => command === "aurora_mesh_session_unbind"),
    ).toHaveLength(2);

    await link.close();
  });

  it("retries native cleanup during close before releasing ownership", async () => {
    vi.useFakeTimers();
    const target = fakeDocument("visible");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let unbindAttempts = 0;
    const failures: unknown[] = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      if (command === "aurora_mesh_session_unbind") {
        unbindAttempts += 1;
        if (unbindAttempts === 1) throw new Error("close cleanup rejected");
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const peer = {
      subscribeRoster(
        listener: (value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: { state: string; connectedSignalingPeerId: string };
          }>;
        }) => void,
      ) {
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-a",
              },
            },
          ],
        });
        return () => undefined;
      },
      async getManifest() {
        return { services: [] };
      },
    };

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: target,
      unbindRetryDelaysMs: [25],
      onCleanupFailure: (failure) => failures.push(failure),
    });
    await vi.waitFor(() => {
      expect(
        calls.some(({ command }) => command === "aurora_mesh_session_bind"),
      ).toBe(true);
    });

    const closePromise = link.close();
    await vi.waitFor(() => expect(unbindAttempts).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    await expect(closePromise).resolves.toBeUndefined();

    expect(unbindAttempts).toBe(2);
    expect(failures).toMatchObject([
      {
        peerId: "peer-a",
        command: "aurora_mesh_session_unbind",
        phase: "close",
        attempt: 1,
        final: false,
      },
    ]);
    await expect(link.close()).resolves.toBeUndefined();
  });

  it("reports final unbind exhaustion and does not rebind that peer", async () => {
    vi.useFakeTimers();
    const target = fakeDocument("visible");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const failures: unknown[] = [];
    let rosterListener:
      | ((value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: { state: string; connectedSignalingPeerId: string };
          }>;
        }) => void)
      | undefined;
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      if (command === "aurora_mesh_session_unbind") {
        throw new Error("native cleanup unavailable");
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const peer = {
      subscribeRoster(listener: NonNullable<typeof rosterListener>) {
        rosterListener = listener;
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-a",
              },
            },
          ],
        });
        return () => {
          rosterListener = undefined;
        };
      },
      async getManifest() {
        return { services: [] };
      },
    };

    installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: target,
      unbindRetryDelaysMs: [25],
      onCleanupFailure: (failure) => failures.push(failure),
    });
    await vi.waitFor(() => {
      expect(
        calls.filter(({ command }) => command === "aurora_mesh_session_bind"),
      ).toHaveLength(2);
    });
    const bindsBeforeRetiredPeerReturns = calls.filter(
      ({ command }) => command === "aurora_mesh_session_bind",
    ).length;

    rosterListener?.({ peers: [] });
    await vi.waitFor(() => {
      expect(
        calls.filter(({ command }) => command === "aurora_mesh_session_unbind"),
      ).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(
        calls.filter(({ command }) => command === "aurora_mesh_session_unbind"),
      ).toHaveLength(2);
    });

    rosterListener?.({
      peers: [
        {
          peerId: "peer-a",
          primary: true,
          snapshot: {
            state: "authorized",
            connectedSignalingPeerId: "signal-a",
          },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      calls.filter(({ command }) => command === "aurora_mesh_session_bind"),
    ).toHaveLength(bindsBeforeRetiredPeerReturns);
    expect(failures).toMatchObject([
      {
        peerId: "peer-a",
        phase: "roster",
        attempt: 1,
        final: false,
      },
      {
        peerId: "peer-a",
        phase: "retry",
        attempt: 2,
        final: true,
      },
    ]);
  });

  it("rejects close when native cleanup exhausts its retry budget", async () => {
    vi.useFakeTimers();
    const target = fakeDocument("visible");
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === "aurora_mesh_session_set_lifecycle") {
        return { lifecycle: "foreground", drained: [] };
      }
      if (command === "aurora_mesh_session_unbind") {
        throw new Error("close cleanup unavailable");
      }
      return { peerId: "peer-a", sessions: 1, deviceLinkHeld: true };
    }) as MeshSessionInvoke;
    const peer = {
      subscribeRoster(
        listener: (value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: { state: string; connectedSignalingPeerId: string };
          }>;
        }) => void,
      ) {
        listener({
          peers: [
            {
              peerId: "peer-a",
              primary: true,
              snapshot: {
                state: "authorized",
                connectedSignalingPeerId: "signal-a",
              },
            },
          ],
        });
        return () => undefined;
      },
      async getManifest() {
        return { services: [] };
      },
    };

    const link = installMeshSessionRuntimeLink({
      invoke,
      peer,
      handleForRemoteSignalingId: () => ({
        peerConnectionId: 1,
        dataChannelId: 11,
      }),
      deliverFrame: () => true,
      lifecycleTarget: target,
      unbindRetryDelaysMs: [25],
    });
    await vi.waitFor(() => {
      expect(
        calls.some(({ command }) => command === "aurora_mesh_session_bind"),
      ).toBe(true);
    });
    const closeExpectation = expect(link.close()).rejects.toBeInstanceOf(
      MeshSessionCleanupError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await closeExpectation;
  });
});
