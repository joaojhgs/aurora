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

import {
  openNativeTransportHandles,
  type NativeTransportDrainFrame,
} from "./native-webrtc";

export type MeshSurfaceLifecycle = "foreground" | "background";
export type MeshSessionDispatcherLifecycle =
  | MeshSurfaceLifecycle
  | "resuming";

export interface MeshSessionInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface MeshSessionDrain {
  readonly peerId: string;
  readonly frames: readonly NativeTransportDrainFrame[];
}

export interface MeshSessionLifecycleResult {
  readonly lifecycle: MeshSessionDispatcherLifecycle;
  readonly drained: readonly MeshSessionDrain[];
  readonly nativeBackgroundHeld?: boolean;
}

export interface MeshSessionBindResult {
  readonly peerId: string;
  readonly sessions: number;
  readonly deviceLinkHeld: boolean;
}

export interface MeshSessionNativeDataChannelCodec {
  readonly version: "aes-256-gcm-nonce-prefix-v1";
  /** Monotonic native data-channel id; prevents stale bind rollback. */
  readonly keyEpoch: number;
  /** Mutable only so the trusted composition caller can wipe the IPC clone. */
  readonly keyBytes: number[];
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
    readonly nodeName?: string;
    readonly localPeerId?: string;
    readonly providerServiceInstanceId?: string;
    readonly advertisedMethodIds?: readonly string[];
    readonly manifestMethodsReady?: boolean;
    readonly primary?: boolean;
    readonly nativeDataChannelCodec?: MeshSessionNativeDataChannelCodec;
  } = {},
): Promise<MeshSessionBindResult> {
  const handles = options.handles ?? soleNativeTransportHandle();
  return await invoke<MeshSessionBindResult>("aurora_mesh_session_bind", {
    request: {
      peerId,
      peerConnectionId: handles.peerConnectionId,
      dataChannelId: handles.dataChannelId,
      authenticatedPeerContext: options.authenticatedPeerContext ?? null,
      nodeName: options.nodeName ?? null,
      localPeerId: options.localPeerId ?? null,
      providerServiceInstanceId: options.providerServiceInstanceId ?? null,
      nativeDataChannelCodec: options.nativeDataChannelCodec ?? null,
      advertisedMethodIds: [...(options.advertisedMethodIds ?? [])],
      manifestMethodsReady: options.manifestMethodsReady ?? true,
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

/** Acknowledge one delivered resume batch and fetch arrivals queued behind it. */
export async function finishMeshSurfaceResume(
  invoke: MeshSessionInvoke,
): Promise<MeshSessionLifecycleResult> {
  return await invoke<MeshSessionLifecycleResult>(
    "aurora_mesh_session_finish_resume",
  );
}

export interface ObserveMeshSurfaceLifecycleOptions {
  readonly invoke: MeshSessionInvoke;
  /** Receives a redacted, non-throwing diagnostic when lifecycle IPC fails. */
  readonly onLifecycleFailure?: (failure: MeshSurfaceLifecycleFailure) => void;
  /**
   * Receives frames that were parked while this surface slept, in order.
   * Return false until every frame is safely back on its exact channel.
   */
  readonly onDrained?: (
    drained: readonly MeshSessionDrain[],
  ) => boolean | void | Promise<boolean | void>;
  /** Injected for tests; defaults to the document. */
  readonly target?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
}

export interface MeshSurfaceLifecycleFailure {
  readonly phase: "set_lifecycle" | "finish_resume" | "deliver_drained";
  readonly requestedLifecycle: MeshSurfaceLifecycle;
  readonly error: unknown;
}

export interface MeshSurfaceLifecycleStop {
  (): void;
  /** Retry a resume batch that the consumer previously could not deliver. */
  retryResume(): void;
  /** Re-announce foreground after a native mobile resume releases its hold. */
  nativeResume(): void;
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
): MeshSurfaceLifecycleStop {
  const target = options.target ?? globalThis.document;
  if (!target) {
    return Object.assign(() => undefined, {
      retryResume: () => undefined,
      nativeResume: () => undefined,
    });
  }

  let last: MeshSurfaceLifecycle | null = null;
  let stopped = false;
  let resumeBlocked = false;
  let operationQueue: Promise<void> = Promise.resolve();

  const reportFailure = (failure: MeshSurfaceLifecycleFailure): void => {
    try {
      options.onLifecycleFailure?.(failure);
    } catch {
      // Diagnostics must never change the safe-direction lifecycle behavior.
    }
  };

  const enqueue = (operation: () => Promise<void>): void => {
    operationQueue = operationQueue.then(operation).catch(() => undefined);
  };

  const invokeLifecycle = async <T>(
    phase: "set_lifecycle" | "finish_resume",
    requestedLifecycle: MeshSurfaceLifecycle,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      reportFailure({ phase, requestedLifecycle, error });
      throw error;
    }
  };

  const drainResume = async (
    initial: MeshSessionLifecycleResult,
  ): Promise<void> => {
    let result = initial;
    while (!stopped) {
      if (result.drained.length > 0) {
        resumeBlocked = true;
        let accepted: boolean | void;
        try {
          accepted = await options.onDrained?.(result.drained);
        } catch (error) {
          reportFailure({
            phase: "deliver_drained",
            requestedLifecycle: "foreground",
            error,
          });
          throw error;
        }
        if (accepted === false) return;
        resumeBlocked = false;
      }
      if (result.lifecycle !== "resuming") return;
      result = await invokeLifecycle(
        "finish_resume",
        "foreground",
        () => finishMeshSurfaceResume(options.invoke),
      );
    }
  };

  const apply = (
    lifecycle: MeshSurfaceLifecycle,
    force = false,
  ): void => {
    if (!force && lifecycle === last) return;
    last = lifecycle;
    enqueue(async () => {
      const result = await invokeLifecycle(
        "set_lifecycle",
        lifecycle,
        () => setMeshSurfaceLifecycle(options.invoke, lifecycle),
      );
      if (lifecycle === "foreground") await drainResume(result);
    });
  };

  const onVisibilityChange = (): void => {
    apply(target.visibilityState === "hidden" ? "background" : "foreground");
  };

  target.addEventListener("visibilitychange", onVisibilityChange);
  onVisibilityChange();
  const stop = (() => {
    stopped = true;
    target.removeEventListener("visibilitychange", onVisibilityChange);
  }) as MeshSurfaceLifecycleStop;
  stop.retryResume = (): void => {
    if (stopped || last !== "foreground" || !resumeBlocked) return;
    enqueue(async () => {
      if (!resumeBlocked || stopped || last !== "foreground") return;
      resumeBlocked = false;
      await drainResume(await invokeLifecycle(
        "finish_resume",
        "foreground",
        () => finishMeshSurfaceResume(options.invoke),
      ));
    });
  };
  stop.nativeResume = (): void => {
    if (stopped) return;
    apply("foreground", true);
  };
  return stop;
}

export interface MeshSessionRosterPeer {
  readonly peerId: string;
  readonly primary: boolean;
  readonly nodeName?: string;
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

export interface MeshSessionCleanupFailure {
  readonly peerId: string;
  readonly command: "aurora_mesh_session_unbind";
  readonly phase: "roster" | "retry" | "close";
  readonly attempt: number;
  readonly final: boolean;
  readonly error: unknown;
}

export class MeshSessionCleanupError extends Error {
  constructor(readonly failures: readonly MeshSessionCleanupFailure[]) {
    super(
      `mesh session cleanup failed for ${failures
        .map((failure) => failure.peerId)
        .join(", ")}`,
    );
    this.name = "MeshSessionCleanupError";
  }
}

export interface MeshSessionRuntimePeer {
  subscribeRoster(listener: (roster: MeshSessionRoster) => void): () => void;
  getManifest(peerId: string): Promise<{
    readonly services?: readonly {
      readonly methods?: readonly string[];
    }[];
  } | null>;
  /**
   * Trusted native-composition seam. Older/non-native controllers may omit it;
   * production native WebRTC controllers implement it and tests cover the
   * encrypted path. The returned clone is wiped after the bind IPC completes.
   */
  nativeDataChannelCodec?(peerId: string): {
    readonly version: "aes-256-gcm-nonce-prefix-v1";
    readonly key: Uint8Array;
  } | null;
}

export interface MeshSessionRuntimeLinkOptions {
  readonly invoke: MeshSessionInvoke;
  readonly peer: MeshSessionRuntimePeer;
  readonly localPeerId?: string;
  readonly providerServiceInstanceId?: string;
  readonly handleForRemoteSignalingId: (
    remoteSignalingId: string,
  ) => { peerConnectionId: number; dataChannelId: number } | null;
  readonly deliverFrame: (
    dataChannelId: number,
    frame: NativeTransportDrainFrame,
  ) => boolean;
  readonly lifecycleTarget?: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  readonly subscribeNativeResume?: (
    listener: () => void,
  ) => Promise<() => void>;
  readonly subscribeNativeTransportHandles?: (
    listener: () => void,
  ) => () => void;
  readonly unbindRetryDelaysMs?: readonly number[];
  /** Delays between manifest hydration retries; injected for deterministic tests. */
  readonly manifestRetryDelaysMs?: readonly number[];
  readonly onCleanupFailure?: (failure: MeshSessionCleanupFailure) => void;
  readonly onLifecycleFailure?: (failure: MeshSurfaceLifecycleFailure) => void;
}

export interface MeshSessionRuntimeLink {
  close(): Promise<void>;
}

type ActiveMeshSessionBinding = {
  readonly signature: string;
  readonly dataChannelId: number;
};

type RetiringMeshSessionBinding = ActiveMeshSessionBinding & {
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  exhausted: boolean;
};

type ManifestHydration = {
  readonly remoteSignalingId: string;
  readonly peerConnectionId: number;
  readonly dataChannelId: number;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  exhausted: boolean;
};

type PendingHandleBinding = {
  readonly remoteSignalingId: string;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  exhausted: boolean;
};

const DEFAULT_UNBIND_RETRY_DELAYS_MS = [100, 500, 2_000] as const;
const DEFAULT_MANIFEST_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

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
  const retiringBindings = new Map<string, RetiringMeshSessionBinding>();
  const manifestHydrations = new Map<string, ManifestHydration>();
  const pendingHandleBindings = new Map<string, PendingHandleBinding>();
  const lastCleanupFailures = new Map<string, MeshSessionCleanupFailure>();
  const pendingDrains = new Map<string, NativeTransportDrainFrame[]>();
  let closed = false;
  let latestRoster: MeshSessionRoster = { peers: [] };
  let reconcileQueue: Promise<void> = Promise.resolve();
  let lifecycleStop: MeshSurfaceLifecycleStop | null = null;
  let nativeResumeUnlisten: (() => void) | null = null;
  let nativeTransportHandlesUnlisten: (() => void) | null = null;
  let nativeResumeSubscription: Promise<void> = Promise.resolve();
  const unbindRetryDelaysMs =
    options.unbindRetryDelaysMs ?? DEFAULT_UNBIND_RETRY_DELAYS_MS;
  const manifestRetryDelaysMs =
    options.manifestRetryDelaysMs ?? DEFAULT_MANIFEST_RETRY_DELAYS_MS;

  const cancelManifestHydration = (peerId: string): void => {
    const hydration = manifestHydrations.get(peerId);
    if (hydration?.retryTimer) clearTimeout(hydration.retryTimer);
    manifestHydrations.delete(peerId);
  };

  const cancelPendingHandleBinding = (peerId: string): void => {
    const pending = pendingHandleBindings.get(peerId);
    if (pending?.retryTimer) clearTimeout(pending.retryTimer);
    pendingHandleBindings.delete(peerId);
  };

  const reportCleanupFailure = (
    failure: MeshSessionCleanupFailure,
  ): MeshSessionCleanupFailure => {
    lastCleanupFailures.set(failure.peerId, failure);
    options.onCleanupFailure?.(failure);
    return failure;
  };

  const flushPeer = (peerId: string): void => {
    if (retiringBindings.has(peerId)) return;
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
    if (pendingDrains.size === 0) lifecycleStop?.retryResume();
  };

  const retainDrains = (drained: readonly MeshSessionDrain[]): boolean => {
    for (const item of drained) {
      const pending = pendingDrains.get(item.peerId) ?? [];
      pending.push(...item.frames);
      pendingDrains.set(item.peerId, pending);
      flushPeer(item.peerId);
    }
    return pendingDrains.size === 0;
  };

  const attemptRetiredUnbind = async (
    peerId: string,
    phase: MeshSessionCleanupFailure["phase"],
  ): Promise<boolean> => {
    const retiring = retiringBindings.get(peerId);
    if (!retiring || retiring.inFlight) return !retiring;
    retiring.inFlight = true;
    if (retiring.retryTimer) {
      clearTimeout(retiring.retryTimer);
      retiring.retryTimer = null;
    }
    try {
      await unbindMeshSessionPeer(options.invoke, peerId);
      retiringBindings.delete(peerId);
      lastCleanupFailures.delete(peerId);
      pendingDrains.delete(peerId);
      return true;
    } catch (error) {
      retiring.attempts += 1;
      const final =
        unbindRetryDelaysMs[Math.max(0, retiring.attempts - 1)] === undefined;
      retiring.exhausted = final;
      reportCleanupFailure({
        peerId,
        command: "aurora_mesh_session_unbind",
        phase,
        attempt: retiring.attempts,
        final,
        error,
      });
      return false;
    } finally {
      const current = retiringBindings.get(peerId);
      if (current) current.inFlight = false;
    }
  };

  const scheduleRetiredUnbindRetry = (peerId: string): void => {
    const retiring = retiringBindings.get(peerId);
    if (!retiring || retiring.retryTimer || retiring.inFlight || retiring.exhausted) {
      return;
    }
    const delayMs = unbindRetryDelaysMs[Math.max(0, retiring.attempts - 1)];
    if (delayMs === undefined) return;
    retiring.retryTimer = setTimeout(() => {
      const current = retiringBindings.get(peerId);
      if (!current) return;
      current.retryTimer = null;
      reconcileQueue = reconcileQueue
        .then(async () => {
          if (closed) return;
          const removed = await attemptRetiredUnbind(peerId, "retry");
          if (!removed) scheduleRetiredUnbindRetry(peerId);
        })
        .catch(() => undefined);
    }, delayMs);
  };

  const retirePeer = async (peerId: string): Promise<void> => {
    cancelManifestHydration(peerId);
    cancelPendingHandleBinding(peerId);
    const existing = bindings.get(peerId);
    if (existing) {
      bindings.delete(peerId);
      const current = retiringBindings.get(peerId);
      if (!current) {
        retiringBindings.set(peerId, {
          ...existing,
          attempts: 0,
          retryTimer: null,
          inFlight: false,
          exhausted: false,
        });
      }
    }
    const removed = await attemptRetiredUnbind(peerId, "roster");
    if (!removed) scheduleRetiredUnbindRetry(peerId);
  };

  const moveActiveBindingToRetiring = (peerId: string): void => {
    const existing = bindings.get(peerId);
    if (!existing || retiringBindings.has(peerId)) return;
    bindings.delete(peerId);
    retiringBindings.set(peerId, {
      ...existing,
      attempts: 0,
      retryTimer: null,
      inFlight: false,
      exhausted: false,
    });
  };

  const cleanupRetiringBindingsForClose = async (): Promise<void> => {
    const failures: MeshSessionCleanupFailure[] = [];
    for (const retiring of retiringBindings.values()) {
      if (retiring.retryTimer) {
        clearTimeout(retiring.retryTimer);
        retiring.retryTimer = null;
      }
      retiring.exhausted = false;
    }
    for (const peerId of [...retiringBindings.keys()]) {
      while (retiringBindings.has(peerId)) {
        const removed = await attemptRetiredUnbind(peerId, "close");
        if (removed) break;
        const retiring = retiringBindings.get(peerId);
        if (!retiring) break;
        const delayMs =
          unbindRetryDelaysMs[Math.max(0, retiring.attempts - 1)];
        if (delayMs === undefined) {
          failures.push(
            lastCleanupFailures.get(peerId) ??
              reportCleanupFailure({
                peerId,
                command: "aurora_mesh_session_unbind",
                phase: "close",
                attempt: retiring.attempts,
                final: true,
                error: new Error("native unbind retry budget exhausted"),
              }),
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (failures.length > 0) throw new MeshSessionCleanupError(failures);
  };

  const bindRosterPeer = async (
    rosterPeer: MeshSessionRosterPeer,
    handles: { peerConnectionId: number; dataChannelId: number },
    advertisedMethodIds: readonly string[],
    manifestMethodsReady: boolean,
  ): Promise<void> => {
    const nativeCodec = options.peer.nativeDataChannelCodec?.(rosterPeer.peerId) ?? null;
    const keyBytes = nativeCodec ? Array.from(nativeCodec.key) : null;
    try {
      const signature = JSON.stringify({
        peerConnectionId: handles.peerConnectionId,
        dataChannelId: handles.dataChannelId,
        authenticatedPeerContext: rosterPeer.authenticatedPeerContext ?? null,
        nodeName: rosterPeer.nodeName ?? null,
        localPeerId: options.localPeerId ?? null,
        providerServiceInstanceId: options.providerServiceInstanceId ?? null,
        nativeDataChannelCodecVersion: nativeCodec?.version ?? null,
        nativeDataChannelCodecEpoch: nativeCodec ? handles.dataChannelId : null,
        advertisedMethodIds,
        manifestMethodsReady,
        primary: rosterPeer.primary,
      });
      const existing = bindings.get(rosterPeer.peerId);
      if (existing?.signature === signature) return;
      if (existing && existing.dataChannelId !== handles.dataChannelId) {
        await retirePeer(rosterPeer.peerId);
        if (retiringBindings.has(rosterPeer.peerId)) return;
      }
      await bindMeshSessionPeer(options.invoke, rosterPeer.peerId, {
        handles,
        authenticatedPeerContext: rosterPeer.authenticatedPeerContext,
        ...(rosterPeer.nodeName !== undefined
          ? { nodeName: rosterPeer.nodeName }
          : {}),
        ...(options.localPeerId !== undefined
          ? { localPeerId: options.localPeerId }
          : {}),
        ...(options.providerServiceInstanceId !== undefined
          ? { providerServiceInstanceId: options.providerServiceInstanceId }
          : {}),
        ...(nativeCodec && keyBytes
          ? {
              nativeDataChannelCodec: {
                version: nativeCodec.version,
                keyEpoch: handles.dataChannelId,
                keyBytes,
              },
            }
          : {}),
        advertisedMethodIds,
        manifestMethodsReady,
        primary: rosterPeer.primary,
      });
      bindings.set(rosterPeer.peerId, {
        signature,
        dataChannelId: handles.dataChannelId,
      });
      flushPeer(rosterPeer.peerId);
    } finally {
      nativeCodec?.key.fill(0);
      keyBytes?.fill(0);
    }
  };

  const currentManifestTarget = (
    peerId: string,
    hydration: ManifestHydration,
  ):
    | {
        rosterPeer: MeshSessionRosterPeer;
        handles: { peerConnectionId: number; dataChannelId: number };
      }
    | null => {
    if (
      closed ||
      manifestHydrations.get(peerId) !== hydration ||
      retiringBindings.has(peerId) ||
      !bindings.has(peerId)
    ) {
      return null;
    }
    const rosterPeer = bindableRosterPeer(latestRoster, peerId);
    if (
      !rosterPeer ||
      rosterPeer.snapshot.connectedSignalingPeerId !==
        hydration.remoteSignalingId
    ) {
      return null;
    }
    let handles: { peerConnectionId: number; dataChannelId: number } | null;
    try {
      handles = options.handleForRemoteSignalingId(
        hydration.remoteSignalingId,
      );
    } catch {
      handles = null;
    }
    if (
      !handles ||
      handles.peerConnectionId !== hydration.peerConnectionId ||
      handles.dataChannelId !== hydration.dataChannelId
    ) {
      return null;
    }
    return { rosterPeer, handles };
  };

  const scheduleManifestRetry = (
    peerId: string,
    hydration: ManifestHydration,
  ): void => {
    if (
      manifestHydrations.get(peerId) !== hydration ||
      hydration.retryTimer ||
      hydration.inFlight ||
      hydration.exhausted
    ) {
      return;
    }
    const delayMs =
      manifestRetryDelaysMs[Math.max(0, hydration.attempts - 1)];
    if (delayMs === undefined) {
      hydration.exhausted = true;
      return;
    }
    hydration.retryTimer = setTimeout(() => {
      if (manifestHydrations.get(peerId) !== hydration) return;
      hydration.retryTimer = null;
      reconcileQueue = reconcileQueue
        .then(() => {
          if (!currentManifestTarget(peerId, hydration)) {
            cancelManifestHydration(peerId);
            return;
          }
          requestManifestHydration(peerId, hydration);
        })
        .catch(() => undefined);
    }, delayMs);
  };

  const requestManifestHydration = (
    peerId: string,
    hydration: ManifestHydration,
  ): void => {
    if (
      hydration.inFlight ||
      hydration.retryTimer ||
      hydration.exhausted ||
      !currentManifestTarget(peerId, hydration)
    ) {
      return;
    }
    hydration.inFlight = true;
    hydration.attempts += 1;
    void Promise.resolve()
      .then(() => options.peer.getManifest(peerId))
      .then(
        (manifest) => {
          reconcileQueue = reconcileQueue
            .then(async () => {
              if (manifestHydrations.get(peerId) !== hydration) return;
              hydration.inFlight = false;
              const target = currentManifestTarget(peerId, hydration);
              if (!target) {
                cancelManifestHydration(peerId);
                return;
              }
              if (manifest === null) {
                scheduleManifestRetry(peerId, hydration);
                return;
              }
              const methodIds = [
                ...new Set(
                  (manifest.services ?? []).flatMap((service) => [
                    ...(service.methods ?? []),
                  ]),
                ),
              ].sort();
              try {
                await bindRosterPeer(
                  target.rosterPeer,
                  target.handles,
                  methodIds,
                  true,
                );
              } catch {
                scheduleManifestRetry(peerId, hydration);
                return;
              }
              cancelManifestHydration(peerId);
            })
            .catch(() => undefined);
        },
        () => {
          reconcileQueue = reconcileQueue
            .then(() => {
              if (manifestHydrations.get(peerId) !== hydration) return;
              hydration.inFlight = false;
              if (!currentManifestTarget(peerId, hydration)) {
                cancelManifestHydration(peerId);
                return;
              }
              scheduleManifestRetry(peerId, hydration);
            })
            .catch(() => undefined);
        },
      );
  };

  const hydrateManifest = (
    rosterPeer: MeshSessionRosterPeer,
    handles: { peerConnectionId: number; dataChannelId: number },
  ): void => {
    const remoteSignalingId = rosterPeer.snapshot.connectedSignalingPeerId;
    if (!remoteSignalingId) return;
    const existing = manifestHydrations.get(rosterPeer.peerId);
    if (
      existing?.remoteSignalingId === remoteSignalingId &&
      existing.peerConnectionId === handles.peerConnectionId &&
      existing.dataChannelId === handles.dataChannelId
    ) {
      requestManifestHydration(rosterPeer.peerId, existing);
      return;
    }
    cancelManifestHydration(rosterPeer.peerId);
    const hydration: ManifestHydration = {
      remoteSignalingId,
      peerConnectionId: handles.peerConnectionId,
      dataChannelId: handles.dataChannelId,
      attempts: 0,
      retryTimer: null,
      inFlight: false,
      exhausted: false,
    };
    manifestHydrations.set(rosterPeer.peerId, hydration);
    requestManifestHydration(rosterPeer.peerId, hydration);
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
      await retirePeer(peerId);
    }
    for (const rosterPeer of desired.values()) {
      const retiring = retiringBindings.get(rosterPeer.peerId);
      if (retiring) {
        if (retiring.exhausted) continue;
        const removed = await attemptRetiredUnbind(rosterPeer.peerId, "roster");
        if (!removed) {
          scheduleRetiredUnbindRetry(rosterPeer.peerId);
          continue;
        }
      }
      const remoteSignalingId = rosterPeer.snapshot.connectedSignalingPeerId;
      if (!remoteSignalingId) continue;
      let handles: { peerConnectionId: number; dataChannelId: number } | null;
      try {
        handles = options.handleForRemoteSignalingId(remoteSignalingId);
      } catch {
        handles = null;
      }
      if (!handles) {
        // The roster remains the authority for whether this peer is still
        // authorized. Native handle lookup can be briefly empty while the
        // WebRTC wrapper publishes a channel replacement; unbinding here
        // drops Rust-owned RTT and background assistant routing even though
        // the authenticated session is still live. Keep the last binding
        // until a replacement can be bound or the roster explicitly retires
        // the peer.
        scheduleHandleBindingRetry(rosterPeer);
        continue;
      }
      cancelPendingHandleBinding(rosterPeer.peerId);
      await bindRosterPeer(rosterPeer, handles, [], false);
      hydrateManifest(rosterPeer, handles);
    }
  };

  const scheduleHandleBindingRetry = (
    rosterPeer: MeshSessionRosterPeer,
  ): void => {
    const remoteSignalingId = rosterPeer.snapshot.connectedSignalingPeerId;
    if (!remoteSignalingId || retiringBindings.has(rosterPeer.peerId)) return;
    const existing = pendingHandleBindings.get(rosterPeer.peerId);
    const pending =
      existing?.remoteSignalingId === remoteSignalingId
        ? existing
        : {
            remoteSignalingId,
            attempts: 0,
            retryTimer: null,
            exhausted: false,
          };
    pendingHandleBindings.set(rosterPeer.peerId, pending);
    if (pending.retryTimer || pending.exhausted) return;
    const delayMs = manifestRetryDelaysMs[Math.max(0, pending.attempts)];
    if (delayMs === undefined) {
      pending.exhausted = true;
      return;
    }
    pending.attempts += 1;
    pending.retryTimer = setTimeout(() => {
      if (pendingHandleBindings.get(rosterPeer.peerId) !== pending) return;
      pending.retryTimer = null;
      reconcileQueue = reconcileQueue.then(reconcile).catch(() => undefined);
    }, delayMs);
  };

  const scheduleReconcile = (roster: MeshSessionRoster): void => {
    latestRoster = roster;
    // The SDK emits a fresh roster snapshot when a peer manifest changes. A
    // completed retry budget therefore applies only until that next peer
    // event; keeping it terminal would leave Rust on the provisional empty
    // method set even after the authorized manifest becomes available.
    for (const hydration of manifestHydrations.values()) {
      if (!hydration.exhausted) continue;
      hydration.attempts = 0;
      hydration.exhausted = false;
    }
    for (const pending of pendingHandleBindings.values()) {
      if (!pending.exhausted) continue;
      pending.attempts = 0;
      pending.exhausted = false;
    }
    reconcileQueue = reconcileQueue.then(reconcile).catch(() => undefined);
  };
  const unsubscribeRoster = options.peer.subscribeRoster(scheduleReconcile);
  if (options.subscribeNativeTransportHandles) {
    nativeTransportHandlesUnlisten = options.subscribeNativeTransportHandles(
      () => {
        if (closed) return;
        for (const pending of pendingHandleBindings.values()) {
          if (!pending.exhausted) continue;
          pending.attempts = 0;
          pending.exhausted = false;
        }
        reconcileQueue = reconcileQueue.then(reconcile).catch(() => undefined);
      },
    );
  }
  lifecycleStop = observeMeshSurfaceLifecycle({
    invoke: options.invoke,
    onDrained: retainDrains,
    ...(options.onLifecycleFailure
      ? { onLifecycleFailure: options.onLifecycleFailure }
      : {}),
    ...(options.lifecycleTarget !== undefined
      ? { target: options.lifecycleTarget }
      : {}),
  });
  if (options.subscribeNativeResume) {
    nativeResumeSubscription = options
      .subscribeNativeResume(() => lifecycleStop?.nativeResume())
      .then((unlisten) => {
        if (closed) unlisten();
        else nativeResumeUnlisten = unlisten;
      })
      .catch(() => undefined);
  }

  return {
    async close(): Promise<void> {
      if (closed && bindings.size === 0 && retiringBindings.size === 0) return;
      if (!closed) {
        closed = true;
        unsubscribeRoster();
        nativeTransportHandlesUnlisten?.();
        nativeTransportHandlesUnlisten = null;
        lifecycleStop?.();
        lifecycleStop = null;
        await nativeResumeSubscription;
        nativeResumeUnlisten?.();
        nativeResumeUnlisten = null;
        for (const peerId of [...manifestHydrations.keys()]) {
          cancelManifestHydration(peerId);
        }
        for (const peerId of [...pendingHandleBindings.keys()]) {
          cancelPendingHandleBinding(peerId);
        }
        await reconcileQueue;
      }
      for (const peerId of [...bindings.keys()]) {
        moveActiveBindingToRetiring(peerId);
      }
      await cleanupRetiringBindingsForClose();
      bindings.clear();
      lastCleanupFailures.clear();
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
