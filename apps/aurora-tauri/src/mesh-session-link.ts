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
  } = {},
): Promise<MeshSessionBindResult> {
  const handles = options.handles ?? soleNativeTransportHandle();
  return await invoke<MeshSessionBindResult>("aurora_mesh_session_bind", {
    request: {
      peerId,
      peerConnectionId: handles.peerConnectionId,
      dataChannelId: handles.dataChannelId,
      authenticatedPeerContext: options.authenticatedPeerContext ?? null,
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
