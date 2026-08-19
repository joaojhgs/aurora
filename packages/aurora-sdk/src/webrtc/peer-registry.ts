/** Per-peer session registry for the browser/WebView WebRTC thin runtime.
 *
 * This is the *session registry* from the native/TypeScript boundary note
 * (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`, section 1). It answers one
 * question — "who am I connected to, and how is that connection doing?" — and
 * TypeScript owns it permanently.
 *
 * An entry carries transport state and may carry a *reference* to the
 * authenticated peer context so a roster can render pairing and approval state.
 * It never holds, caches, derives or evaluates a grant or a permission set:
 * every authorization question goes through `PeerHostAuthorizationStore`, which
 * the Rust authority core reimplements behind Tauri IPC and WebAssembly.
 */

import { AuroraError } from '../errors.js'
import type { AuthenticatedPeerContext } from '../peer-host/authority.js'
import type { RoomKeys } from './crypto.js'
import type { WebRtcMeshPeerBridge } from './mesh-peer-bridge.js'
import type { PairingSasResult } from './pairing.js'
import type { WebRtcPeerSession } from './peer-session.js'
import type { MqttWebSocketSignalingClient } from './signaling-mqtt.js'
import type { PeerConnectionSnapshot, WebRtcPeerConnectionProfile } from './types.js'

/** Machine-readable reason for the one-stable-id-one-session refusal. */
export const PEER_ALREADY_REGISTERED_REASON = 'peer_already_registered'

export function peerAlreadyRegisteredError(peerId: string): AuroraError {
  return new AuroraError({
    code: 'validation',
    message: 'That device already holds a live session; one stable peer id holds one session.',
    detail: { reason_code: PEER_ALREADY_REGISTERED_REASON, peer_id: peerId }
  })
}

/** Everything one peer's connection owns. Transport state only — never authority. */
export interface MeshPeerSessionEntry {
  /** Registry key. Equals `peerId` once the stable identity is known. */
  key: string
  /** Stable peer id, once the invite supplied one or the session reported one. */
  peerId: string | undefined
  readonly profile: WebRtcPeerConnectionProfile
  session: WebRtcPeerSession | null
  signaling: MqttWebSocketSignalingClient | null
  bridge: WebRtcMeshPeerBridge | null
  keyMaterial: RoomKeys | null
  localProtocolHello: Record<string, unknown> | null
  pendingPairing: PairingSasResult | null
}

export interface MeshPeerRosterEntry {
  readonly peerId: string
  /** True for the entry the single-peer snapshot and the default route derive from. */
  readonly primary: boolean
  readonly nodeName?: string | undefined
  /**
   * Reference only, so a roster can render "paired / approved / needs attention".
   * Authorization decisions stay with `PeerHostAuthorizationStore`.
   */
  readonly authenticatedPeerContext?: AuthenticatedPeerContext | undefined
  readonly snapshot: PeerConnectionSnapshot
}

export interface MeshPeerRosterSnapshot {
  readonly peers: readonly MeshPeerRosterEntry[]
  readonly primaryPeerId?: string | undefined
  readonly updatedAt: string
}

/** Multi-peer surface of the thin runtime peer controller. */
export interface MeshPeerRegistryController {
  roster(): MeshPeerRosterSnapshot
  subscribeRoster(listener: (roster: MeshPeerRosterSnapshot) => void): () => void
  /** Add a peer without disturbing the sessions already in the registry. */
  connectPeer(profile: WebRtcPeerConnectionProfile): Promise<void>
  /** Drop one peer, leaving the rest of the registry connected. */
  disconnectPeer(peerId: string, reason?: string): Promise<void>
}

export class MeshPeerSessionRegistry {
  private readonly entries = new Map<string, MeshPeerSessionEntry>()

  get size(): number {
    return this.entries.size
  }

  list(): MeshPeerSessionEntry[] {
    return [...this.entries.values()]
  }

  has(entry: MeshPeerSessionEntry): boolean {
    return this.entries.get(entry.key) === entry
  }

  findByPeerId(peerId: string): MeshPeerSessionEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.peerId === peerId) return entry
    }
    return undefined
  }

  /** Register a new session, refusing a stable id that already holds one. */
  add(entry: MeshPeerSessionEntry): MeshPeerSessionEntry {
    if (entry.peerId !== undefined && this.findByPeerId(entry.peerId) !== undefined) {
      throw peerAlreadyRegisteredError(entry.peerId)
    }
    if (this.entries.has(entry.key)) throw peerAlreadyRegisteredError(entry.key)
    this.entries.set(entry.key, entry)
    return entry
  }

  /**
   * Bind the stable id a live session reported. A stable identity presenting on
   * a second transport is refused, matching what the Python node already does.
   */
  bindPeerId(entry: MeshPeerSessionEntry, peerId: string): void {
    if (entry.peerId === peerId) return
    const holder = this.findByPeerId(peerId)
    if (holder !== undefined && holder !== entry) throw peerAlreadyRegisteredError(peerId)
    if (entry.peerId !== undefined) throw peerAlreadyRegisteredError(entry.peerId)
    if (!this.has(entry)) {
      entry.key = peerId
      entry.peerId = peerId
      return
    }
    this.entries.delete(entry.key)
    entry.key = peerId
    entry.peerId = peerId
    this.entries.set(peerId, entry)
  }

  remove(entry: MeshPeerSessionEntry): boolean {
    if (!this.has(entry)) return false
    this.entries.delete(entry.key)
    return true
  }

  clear(): MeshPeerSessionEntry[] {
    const entries = this.list()
    this.entries.clear()
    return entries
  }
}
