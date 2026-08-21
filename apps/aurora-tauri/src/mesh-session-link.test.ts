import { describe, expect, it, vi } from "vitest";

import {
  MeshSessionBindError,
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

describe("mesh session link", () => {
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
            advertisedMethodIds: [],
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
    await Promise.resolve();

    expect(calls.map((call) => (call.args as { request: { lifecycle: string } }).request.lifecycle))
      .toEqual(["foreground", "background", "foreground"]);
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

  it("hands back frames parked while the surface slept, in order", async () => {
    const target = fakeDocument("hidden");
    const drained = [
      { peerId: "peer-a", frames: [{ id: "e-1" }, { id: "e-2" }] },
    ];
    const { invoke } = recordingInvoke({ lifecycle: "foreground", drained });
    const onDrained = vi.fn();

    observeMeshSurfaceLifecycle({ invoke, target, onDrained });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDrained).toHaveBeenCalledWith(drained);
  });

  it("treats a failing dispatcher as an awake surface rather than throwing", async () => {
    const target = fakeDocument("hidden");
    const invoke = (async () => {
      throw new Error("command unavailable");
    }) as MeshSessionInvoke;

    expect(() => observeMeshSurfaceLifecycle({ invoke, target })).not.toThrow();
    await Promise.resolve();
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
                    frames: [{ id: "a-1" }, { id: "a-2" }],
                  },
                  { peerId: "peer-b", frames: [{ id: "b-1" }] },
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
      { dataChannelId: 11, frame: { id: "a-1" } },
      { dataChannelId: 11, frame: { id: "a-2" } },
      { dataChannelId: 22, frame: { id: "b-1" } },
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
    const peer = {
      subscribeRoster(
        listener: (value: {
          peers: Array<{
            peerId: string;
            primary: boolean;
            snapshot: {
              state: string;
              connectedSignalingPeerId: string;
            };
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
                connectedSignalingPeerId: "signal-old",
              },
            },
          ],
        });
        listener({
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
});
