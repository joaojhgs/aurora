/**
 * The webview's half of R3's native session dispatcher.
 *
 * Rust owns liveness and inbound call admission while this webview is frozen
 * (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`, sections 3 and 6). It needs two
 * things from here, both supplied from the foreground and neither of them a
 * decision:
 *
 * 1. which stable peer id a native data channel carries, once the session is
 *    authorized, so an inbound frame can be attributed to a peer and an
 *    inbound call can be authorized against that peer's own context;
 * 2. whether this surface is awake.
 *
 * Nothing here widens anything. Every authorization question still goes to the
 * mesh authority on every call, and the answer does not depend on which of the
 * two lifecycle states the surface is in. The lifecycle decides *dispatch* --
 * whether a frame goes to the webview now or waits in that peer's queue -- and
 * never which implementation runs.
 */

import { openNativeTransportHandles } from "./native-webrtc";

export type MeshSurfaceLifecycle = "foreground" | "background";

export interface MeshSessionInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface MeshSessionDrain {
  readonly peerId: string;
  readonly frames: readonly unknown[];
}

export interface MeshSessionLifecycleResult {
  readonly lifecycle: MeshSurfaceLifecycle;
  readonly drained: readonly MeshSessionDrain[];
}

export interface MeshSessionBindResult {
  readonly peerId: string;
  readonly sessions: number;
  readonly deviceLinkHeld: boolean;
}

/** Why a binding was not attempted. Machine-readable, never shown to anyone. */
export type MeshSessionBindRefusal =
  | "no_native_transport"
  | "ambiguous_native_transport";

export class MeshSessionBindError extends Error {
  constructor(readonly reasonCode: MeshSessionBindRefusal) {
    super(`mesh session binding refused: ${reasonCode}`);
    this.name = "MeshSessionBindError";
  }
}

/**
 * Tell Rust which stable peer a native data channel carries.
 *
 * Taking the first binding is what acquires the one Aurora foreground
 * service's connected-device reason, so the process stays alive long enough to
 * keep answering while this webview sleeps.
 *
 * With more than one open channel this refuses rather than choosing. Choosing
 * wrongly would bind one peer's session to another peer's identity, which is
 * the one mistake the whole per-peer split exists to prevent. A surface that
 * holds several device connections must pass the handles it means.
 */
export async function bindMeshSessionPeer(
  invoke: MeshSessionInvoke,
  peerId: string,
  options: {
    readonly authenticatedPeerContext?: unknown;
    readonly handles?: { peerConnectionId: number; dataChannelId: number };
    readonly localPeerId?: string;
    readonly providerServiceInstanceId?: string;
    readonly advertisedMethodIds?: readonly string[];
    readonly primary?: boolean;
  } = {},
): Promise<MeshSessionBindResult> {
  const handles = options.handles ?? soleNativeTransportHandle();
  return await invoke<MeshSessionBindResult>("aurora_mesh_session_bind", {
    request: {
      peerId,
      peerConnectionId: handles.peerConnectionId,
      dataChannelId: handles.dataChannelId,
      authenticatedPeerContext: options.authenticatedPeerContext ?? null,
      localPeerId: options.localPeerId ?? null,
      providerServiceInstanceId: options.providerServiceInstanceId ?? null,
      advertisedMethodIds: [...(options.advertisedMethodIds ?? [])],
      primary: options.primary ?? false,
    },
  });
}

/**
 * Drop a peer's native session.
 *
 * Releasing the last one releases the connected-device reason. Voice may still
 * be holding the one service for its own reason, and the ledger is
 * reference-counted so this cannot end a voice session.
 */
export async function unbindMeshSessionPeer(
  invoke: MeshSessionInvoke,
  peerId: string,
): Promise<void> {
  await invoke("aurora_mesh_session_unbind", { request: { peerId } });
}

/**
 * Move the dispatcher between foreground and background.
 *
 * Coming back returns everything parked while this webview slept, per peer, in
 * arrival order. The backlog arrives in the same call as the state change, so
 * a caller physically cannot dispatch a newly arrived frame ahead of it.
 */
export async function setMeshSurfaceLifecycle(
  invoke: MeshSessionInvoke,
  lifecycle: MeshSurfaceLifecycle,
): Promise<MeshSessionLifecycleResult> {
  return await invoke<MeshSessionLifecycleResult>(
    "aurora_mesh_session_set_lifecycle",
    { request: { lifecycle } },
  );
}

export interface ObserveMeshSurfaceLifecycleOptions {
  readonly invoke: MeshSessionInvoke;
  /** Receives frames that were parked while this surface slept, in order. */
  readonly onDrained?: (drained: readonly MeshSessionDrain[]) => void;
  /** Injected for tests; defaults to the document. */
  readonly target?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
}

/**
 * Follow this surface's visibility and keep the dispatcher in step with it.
 *
 * Returns a function that stops observing. Failures are swallowed on purpose:
 * losing the lifecycle signal degrades the dispatcher to treating the surface
 * as awake, which is the safe direction -- frames go to a webview that may be
 * slow rather than being parked for a webview that is actually running.
 */
export function observeMeshSurfaceLifecycle(
  options: ObserveMeshSurfaceLifecycleOptions,
): () => void {
  const target = options.target ?? globalThis.document;
  if (!target) return () => undefined;

  let last: MeshSurfaceLifecycle | null = null;
  const apply = (lifecycle: MeshSurfaceLifecycle): void => {
    if (lifecycle === last) return;
    last = lifecycle;
    void setMeshSurfaceLifecycle(options.invoke, lifecycle)
      .then((result) => {
        if (result.drained.length > 0) options.onDrained?.(result.drained);
      })
      .catch(() => undefined);
  };

  const onVisibilityChange = (): void => {
    apply(target.visibilityState === "hidden" ? "background" : "foreground");
  };

  target.addEventListener("visibilitychange", onVisibilityChange);
  onVisibilityChange();
  return () => {
    target.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export interface MeshSessionRosterPeer {
  readonly peerId: string;
  readonly primary: boolean;
  readonly authenticatedPeerContext?: unknown;
  readonly standby?: unknown;
  readonly snapshot: {
    readonly state: string;
    readonly connectedSignalingPeerId?: string;
  };
}

export interface MeshSessionRoster {
  readonly peers: readonly MeshSessionRosterPeer[];
}

export interface MeshSessionRuntimePeer {
  subscribeRoster(listener: (roster: MeshSessionRoster) => void): () => void;
  getManifest(peerId: string): Promise<{
    readonly services?: readonly {
      readonly methods?: readonly string[];
    }[];
  } | null>;
}

export interface MeshSessionRuntimeLinkOptions {
  readonly invoke: MeshSessionInvoke;
  readonly peer: MeshSessionRuntimePeer;
  readonly localPeerId?: string;
  readonly providerServiceInstanceId?: string;
  readonly handleForRemoteSignalingId: (
    remoteSignalingId: string,
  ) => { peerConnectionId: number; dataChannelId: number } | null;
  readonly deliverFrame: (dataChannelId: number, frame: unknown) => boolean;
  readonly lifecycleTarget?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
}

export interface MeshSessionRuntimeLink {
  close(): Promise<void>;
}

type ActiveMeshSessionBinding = {
  readonly signature: string;
  readonly dataChannelId: number;
};

function bindableRosterPeer(
  roster: MeshSessionRoster,
  peerId: string,
): MeshSessionRosterPeer | null {
  const peer = roster.peers.find((candidate) => candidate.peerId === peerId);
  if (!peer) return null;
  if (peer.snapshot.state !== "authorized") return null;
  if (peer.standby !== undefined) return null;
  if (peer.snapshot.connectedSignalingPeerId === undefined) return null;
  return peer;
}

/**
 * Bind every authorized native channel to its exact stable peer identity.
 *
 * Roster changes are serialized so reconnects cannot interleave unbind/bind
 * operations. The signaling identity is the lookup key for transport handles;
 * a sole-channel guess is never used on this production path.
 */
export function installMeshSessionRuntimeLink(
  options: MeshSessionRuntimeLinkOptions,
): MeshSessionRuntimeLink {
  const bindings = new Map<string, ActiveMeshSessionBinding>();
  const pendingDrains = new Map<string, unknown[]>();
  let closed = false;
  let latestRoster: MeshSessionRoster = { peers: [] };
  let reconcileQueue: Promise<void> = Promise.resolve();

  const flushPeer = (peerId: string): void => {
    const binding = bindings.get(peerId);
    const pending = pendingDrains.get(peerId);
    if (!binding || !pending || pending.length === 0) return;
    let delivered = 0;
    for (const frame of pending) {
      if (!options.deliverFrame(binding.dataChannelId, frame)) break;
      delivered += 1;
    }
    if (delivered === pending.length) pendingDrains.delete(peerId);
    else if (delivered > 0) pending.splice(0, delivered);
  };

  const retainDrains = (drained: readonly MeshSessionDrain[]): void => {
    for (const item of drained) {
      const pending = pendingDrains.get(item.peerId) ?? [];
      pending.push(...item.frames);
      pendingDrains.set(item.peerId, pending);
      flushPeer(item.peerId);
    }
  };

  const bindRosterPeer = async (
    rosterPeer: MeshSessionRosterPeer,
    handles: { peerConnectionId: number; dataChannelId: number },
    advertisedMethodIds: readonly string[],
  ): Promise<void> => {
    const signature = JSON.stringify({
      peerConnectionId: handles.peerConnectionId,
      dataChannelId: handles.dataChannelId,
      authenticatedPeerContext: rosterPeer.authenticatedPeerContext ?? null,
      localPeerId: options.localPeerId ?? null,
      providerServiceInstanceId: options.providerServiceInstanceId ?? null,
      advertisedMethodIds,
      primary: rosterPeer.primary,
    });
    const existing = bindings.get(rosterPeer.peerId);
    if (existing?.signature === signature) return;
    if (existing && existing.dataChannelId !== handles.dataChannelId) {
      await unbindMeshSessionPeer(options.invoke, rosterPeer.peerId);
      bindings.delete(rosterPeer.peerId);
    }
    await bindMeshSessionPeer(options.invoke, rosterPeer.peerId, {
      handles,
      authenticatedPeerContext: rosterPeer.authenticatedPeerContext,
      ...(options.localPeerId !== undefined
        ? { localPeerId: options.localPeerId }
        : {}),
      ...(options.providerServiceInstanceId !== undefined
        ? { providerServiceInstanceId: options.providerServiceInstanceId }
        : {}),
      advertisedMethodIds,
      primary: rosterPeer.primary,
    });
    bindings.set(rosterPeer.peerId, {
      signature,
      dataChannelId: handles.dataChannelId,
    });
    flushPeer(rosterPeer.peerId);
  };

  const reconcile = async (): Promise<void> => {
    if (closed) return;
    const desired = new Map(
      latestRoster.peers
        .flatMap((peer) => {
          const bindable = bindableRosterPeer(latestRoster, peer.peerId);
          return bindable ? [bindable] : [];
        })
        .map((peer) => [peer.peerId, peer] as const),
    );
    for (const peerId of [...bindings.keys()]) {
      if (desired.has(peerId)) continue;
      await unbindMeshSessionPeer(options.invoke, peerId).catch(() => undefined);
      bindings.delete(peerId);
      pendingDrains.delete(peerId);
    }
    for (const rosterPeer of desired.values()) {
      const remoteSignalingId = rosterPeer.snapshot.connectedSignalingPeerId;
      if (!remoteSignalingId) continue;
      let handles: { peerConnectionId: number; dataChannelId: number } | null;
      try {
        handles = options.handleForRemoteSignalingId(remoteSignalingId);
      } catch {
        handles = null;
      }
      if (!handles) {
        if (bindings.has(rosterPeer.peerId)) {
          await unbindMeshSessionPeer(options.invoke, rosterPeer.peerId).catch(
            () => undefined,
          );
          bindings.delete(rosterPeer.peerId);
        }
        continue;
      }
      await bindRosterPeer(rosterPeer, handles, []);
      void options.peer
        .getManifest(rosterPeer.peerId)
        .then((manifest) => {
          reconcileQueue = reconcileQueue.then(async () => {
            if (closed || !manifest) return;
            const currentPeer = bindableRosterPeer(
              latestRoster,
              rosterPeer.peerId,
            );
            if (!currentPeer) return;
            const currentRemoteSignalingId =
              currentPeer.snapshot.connectedSignalingPeerId;
            if (currentRemoteSignalingId === undefined) return;
            if (
              currentRemoteSignalingId !==
              rosterPeer.snapshot.connectedSignalingPeerId
            ) {
              return;
            }
            let currentHandles: {
              peerConnectionId: number;
              dataChannelId: number;
            } | null;
            try {
              currentHandles = options.handleForRemoteSignalingId(
                currentRemoteSignalingId,
              );
            } catch {
              currentHandles = null;
            }
            if (
              !currentHandles ||
              currentHandles.peerConnectionId !== handles.peerConnectionId ||
              currentHandles.dataChannelId !== handles.dataChannelId
            ) {
              return;
            }
            const methodIds = [
              ...new Set(
                (manifest.services ?? []).flatMap((service) => [
                  ...(service.methods ?? []),
                ]),
              ),
            ].sort();
            await bindRosterPeer(currentPeer, currentHandles, methodIds);
          });
        })
        .catch(() => undefined);
    }
  };

  const scheduleReconcile = (roster: MeshSessionRoster): void => {
    latestRoster = roster;
    reconcileQueue = reconcileQueue.then(reconcile).catch(() => undefined);
  };
  const unsubscribeRoster = options.peer.subscribeRoster(scheduleReconcile);
  const stopLifecycle = observeMeshSurfaceLifecycle({
    invoke: options.invoke,
    onDrained: retainDrains,
    ...(options.lifecycleTarget !== undefined
      ? { target: options.lifecycleTarget }
      : {}),
  });

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeRoster();
      stopLifecycle();
      await reconcileQueue;
      for (const peerId of [...bindings.keys()]) {
        await unbindMeshSessionPeer(options.invoke, peerId).catch(() => undefined);
      }
      bindings.clear();
      pendingDrains.clear();
    },
  };
}

function soleNativeTransportHandle(): {
  peerConnectionId: number;
  dataChannelId: number;
} {
  const handles = openNativeTransportHandles();
  const [only] = handles;
  if (handles.length === 0 || !only) {
    throw new MeshSessionBindError("no_native_transport");
  }
  if (handles.length > 1) {
    throw new MeshSessionBindError("ambiguous_native_transport");
  }
  return only;
}
