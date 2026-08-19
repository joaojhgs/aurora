/** Routes mesh RPC to the per-peer bridge named on the request.
 *
 * `WebRtcMeshPeerBridge` is already bound to exactly one `remotePeerId` and
 * refuses cross-peer routing. This router sits above a registry of those
 * bridges and dispatches `call`, `streamCall`, `subscribe` and `getManifest`
 * on the peer id the caller asked for, so one `MeshP2PTransport` can reach
 * every peer the session registry holds instead of a single `defaultPeerId`.
 */

import { AuroraError } from '../errors.js'
import type {
  AsyncMeshEventSource,
  MeshEventSource,
  MeshPeerBridge,
  MeshPeerManifest,
  MeshRpcRequest,
  MeshRpcResponse,
  MeshStreamRpcRequest
} from '../mesh.js'

/** Machine-readable reason for a peer id with no session in the registry. */
export const PEER_NOT_REGISTERED_REASON = 'peer_not_registered'

export interface MeshPeerBridgeRouterOptions {
  /** Resolve the live bridge for a stable peer id, or undefined when unrouteable. */
  resolve(peerId: string): MeshPeerBridge | undefined
  /** Stable peer ids currently reachable, reported in the unroutable error detail. */
  reachablePeerIds?: () => readonly string[]
}

export function peerNotRegisteredError(peerId: string, reachablePeerIds: readonly string[]): AuroraError {
  return new AuroraError({
    code: 'unavailable_service',
    message: `No connected device answers to ${peerId}.`,
    detail: {
      reason_code: PEER_NOT_REGISTERED_REASON,
      peer_id: peerId,
      reachable_peer_ids: [...reachablePeerIds]
    }
  })
}

export class MeshPeerBridgeRouter implements MeshPeerBridge {
  constructor(private readonly options: MeshPeerBridgeRouterOptions) {}

  async call<TPayload = unknown>(request: MeshRpcRequest<TPayload>): Promise<MeshRpcResponse<unknown>> {
    return await this.route(request.peerId).call<TPayload>(request) as MeshRpcResponse<unknown>
  }

  streamCall<TChunk = unknown, TPayload = unknown>(request: MeshRpcRequest<TPayload>): AsyncIterable<TChunk> {
    const bridge = this.route(request.peerId)
    if (!bridge.streamCall) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Mesh peer streaming RPC is not supported by this bridge.',
        method: request.method,
        busTopic: request.busTopic
      })
    }
    return bridge.streamCall<TChunk, TPayload>(request)
  }

  subscribe<TEventPayload = unknown>(request: MeshStreamRpcRequest): MeshEventSource<TEventPayload> {
    const bridge = this.route(request.peerId)
    if (!bridge.subscribe) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Mesh event subscriptions are not supported by this bridge.',
        detail: { stream: request.stream, topics: request.topics }
      })
    }
    return bridge.subscribe<TEventPayload>(request) as AsyncMeshEventSource<TEventPayload>
  }

  async getManifest(peerId: string): Promise<MeshPeerManifest | null> {
    const bridge = this.route(peerId)
    if (!bridge.getManifest) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: 'Mesh peer manifest lookup is not supported by this bridge.'
      })
    }
    return await bridge.getManifest(peerId)
  }

  private route(peerId: string): MeshPeerBridge {
    const bridge = peerId ? this.options.resolve(peerId) : undefined
    if (!bridge) throw peerNotRegisteredError(peerId, this.options.reachablePeerIds?.() ?? [])
    return bridge
  }
}
