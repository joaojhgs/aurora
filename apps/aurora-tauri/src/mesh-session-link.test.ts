import { describe, expect, it, vi } from "vitest";

import {
  MeshSessionBindError,
  bindMeshSessionPeer,
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
});
