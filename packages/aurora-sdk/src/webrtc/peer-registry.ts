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
import type { AuthenticatedPeerContext } from '../peer-host/authority-types.js'
import type { RoomKeys } from './crypto.js'
import type { WebRtcMeshPeerBridge } from './mesh-peer-bridge.js'
import type { PairingSasResult } from './pairing.js'
import type { WebRtcPeerSession } from './peer-session.js'
import type { MeshPeerStandbyReason } from './protocol.js'
import type { SignalingSessionAllowlist } from './signaling-allowlist.js'
import type { MqttWebSocketSignalingClient } from './signaling-mqtt.js'
import type { PeerConnectionSnapshot, WebRtcPeerConnectionProfile } from './types.js'

/** Machine-readable reason for the one-stable-id-one-session refusal. */
export const PEER_ALREADY_REGISTERED_REASON = 'peer_already_registered'

/** Machine-readable reason for the single-device Connect refusal. */
export const CONNECT_IS_SINGLE_PEER_REASON = 'connect_is_single_peer'

/** Wire codec the trusted native shell may install for one live data channel. */
export const NATIVE_DATA_CHANNEL_CODEC_V1 = 'aes-256-gcm-nonce-prefix-v1' as const

/**
 * A short-lived clone of the payload key for native background dispatch.
 *
 * This object is deliberately absent from roster/snapshot serialization. The
 * caller owns the clone and must zero it immediately after the native bind
 * command has copied it into zeroizing Rust storage.
 */
export interface NativeDataChannelCodec {
  readonly version: typeof NATIVE_DATA_CHANNEL_CODEC_V1
  readonly key: Uint8Array
}

/**
 * How many devices this surface is allowed to hold at once.
 *
 * `connect` is the deliberate single-device restriction: a Connect surface
 * talks to one Aurora at a time. `mesh` lets a surface hold several. It is a
 * policy the registry applies, not a limit of the registry: the map holds as
 * many sessions as it is told to, and this decides how many it is told to.
 * Sizing that policy to a device's budget is a separate decision and does not
 * live here.
 */
export type MeshPeerConnectionPolicy = 'connect' | 'mesh'

export type MeshPeerLifecycleState = 'foreground' | 'background'

export interface MeshPeerConnectionBudget {
  readonly foregroundPeerLimit: number | null
  readonly backgroundPeerLimit: number | null
  /** iOS suspends the whole surface; other mobile surfaces shed by budget. */
  readonly backgroundStandbyReason?: Extract<MeshPeerStandbyReason, 'connection_budget' | 'surface_suspended'> | undefined
}

export interface MeshPeerPriorityUpdate {
  readonly userPinned?: boolean | undefined
  readonly dependedUpon?: boolean | undefined
}

export interface MeshPeerBudgetState {
  userPinned: boolean
  dependedUpon: boolean
  /** Number of RPC/stream/subscription routes currently using this peer. */
  activeRouteCount: number
  lastUsedAtMs: number
  connectedAtMs: number
}

/** Deliberate, credential-preserving absence; distinct from transport loss. */
export interface MeshPeerStandbyState {
  readonly reasonCode: MeshPeerStandbyReason
  readonly resumeExpected: boolean
  readonly sinceMs: number
}

export function connectIsSinglePeerError(peerId: string): AuroraError {
  return new AuroraError({
    code: 'validation',
    message: 'This device connects to one Aurora at a time. Disconnect the current one first.',
    detail: { reason_code: CONNECT_IS_SINGLE_PEER_REASON, peer_id: peerId }
  })
}

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
  /** Which peer may drive this session. Presence widens; the session pins. */
  readonly allowlist: SignalingSessionAllowlist
  bridge: WebRtcMeshPeerBridge | null
  keyMaterial: RoomKeys | null
  localProtocolHello: Record<string, unknown> | null
  pendingPairing: PairingSasResult | null
  /** Local retention metadata only; authorization state stays in the authority store. */
  budget: MeshPeerBudgetState
  /** Present while the connection is intentionally shed or suspended. */
  standby: MeshPeerStandbyState | null
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
  readonly standby?: MeshPeerStandbyState | undefined
  readonly snapshot: PeerConnectionSnapshot
}

/**
 * A device seen announcing itself in the room. Discovery only: a discovered
 * peer is a candidate to connect to, never an authorized one. Every peer still
 * needs its own pairing and explicit approval before it can do anything.
 */
export interface MeshDiscoveredPeer {
  /** Stable identity when the peer named one, otherwise its signaling identity. */
  readonly peerId: string
  readonly stablePeerId?: string | undefined
  readonly signalingPeerId: string
  readonly nodeName?: string | undefined
  /** True when this device already holds a session with the peer. */
  readonly connected: boolean
  readonly lastSeenAt: string
}

export interface MeshPeerRosterSnapshot {
  readonly peers: readonly MeshPeerRosterEntry[]
  /** Everyone observed in the room, whether or not this device connected to them. */
  readonly discovered: readonly MeshDiscoveredPeer[]
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
  /** How many devices this surface may hold at once. */
  connectionPolicy(): MeshPeerConnectionPolicy
  setPeerPriority(peerId: string, priority: MeshPeerPriorityUpdate): void
  notePeerUsed(peerId: string): void
  applyConnectionBudget(): Promise<void>
  /** Trusted native-composition seam; never include its result in diagnostics. */
  nativeDataChannelCodec(peerId: string): NativeDataChannelCodec | null
}

export class MeshPeerSessionRegistry {
  private readonly entries = new Map<string, MeshPeerSessionEntry>()
  private policy: MeshPeerConnectionPolicy
  private budget: MeshPeerConnectionBudget

  constructor(options: { policy?: MeshPeerConnectionPolicy; budget?: MeshPeerConnectionBudget } = {}) {
    this.policy = options.policy ?? 'mesh'
    this.budget = options.budget ?? {
      foregroundPeerLimit: null,
      backgroundPeerLimit: null,
      backgroundStandbyReason: 'connection_budget'
    }
  }

  get size(): number {
    return this.entries.size
  }

  get connectionPolicy(): MeshPeerConnectionPolicy {
    return this.policy
  }

  /** Change how many devices this surface may hold. Registers nothing. */
  setConnectionPolicy(policy: MeshPeerConnectionPolicy): void {
    this.policy = policy
  }

  setConnectionBudget(budget: MeshPeerConnectionBudget): void {
    this.budget = budget
  }

  list(): MeshPeerSessionEntry[] {
    return [...this.entries.values()]
  }

  activeEntries(): MeshPeerSessionEntry[] {
    return this.list().filter((entry) => entry.standby === null)
  }

  standbyEntries(): MeshPeerSessionEntry[] {
    return this.list().filter((entry) => entry.standby !== null)
  }

  backgroundStandbyReason(): Extract<MeshPeerStandbyReason, 'connection_budget' | 'surface_suspended'> {
    return this.budget.backgroundStandbyReason ?? 'connection_budget'
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

  /**
   * Register a new session, refusing a stable id that already holds one, and
   * refusing a second device on a surface whose policy is one at a time.
   */
  add(entry: MeshPeerSessionEntry): MeshPeerSessionEntry {
    if (this.policy === 'connect' && this.activeEntries().length > 0) {
      throw connectIsSinglePeerError(entry.peerId ?? entry.key)
    }
    if (entry.peerId !== undefined && this.findByPeerId(entry.peerId) !== undefined) {
      throw peerAlreadyRegisteredError(entry.peerId)
    }
    if (this.entries.has(entry.key)) throw peerAlreadyRegisteredError(entry.key)
    const now = Date.now()
    entry.budget = {
      userPinned: entry.budget?.userPinned ?? false,
      dependedUpon: entry.budget?.dependedUpon ?? false,
      activeRouteCount: entry.budget?.activeRouteCount ?? 0,
      lastUsedAtMs: entry.budget?.lastUsedAtMs ?? now,
      connectedAtMs: entry.budget?.connectedAtMs ?? now
    }
    this.entries.set(entry.key, entry)
    return entry
  }

  setPeerPriority(peerId: string, priority: MeshPeerPriorityUpdate): void {
    const entry = this.findByPeerId(peerId) ?? this.entries.get(peerId)
    if (!entry) return
    if (priority.userPinned !== undefined) entry.budget.userPinned = priority.userPinned
    if (priority.dependedUpon !== undefined) entry.budget.dependedUpon = priority.dependedUpon
    entry.budget.lastUsedAtMs = Date.now()
  }

  notePeerUsed(peerId: string): void {
    const entry = this.findByPeerId(peerId) ?? this.entries.get(peerId)
    if (entry) entry.budget.lastUsedAtMs = Date.now()
  }

  beginPeerRoute(peerId: string): void {
    const entry = this.findByPeerId(peerId) ?? this.entries.get(peerId)
    if (!entry) return
    entry.budget.activeRouteCount += 1
    entry.budget.lastUsedAtMs = Date.now()
  }

  endPeerRoute(peerId: string): void {
    const entry = this.findByPeerId(peerId) ?? this.entries.get(peerId)
    if (!entry) return
    entry.budget.activeRouteCount = Math.max(0, entry.budget.activeRouteCount - 1)
    entry.budget.lastUsedAtMs = Date.now()
  }

  markStandby(entry: MeshPeerSessionEntry, standby: MeshPeerStandbyState): boolean {
    if (!this.has(entry)) return false
    entry.standby = standby
    return true
  }

  /** Remove and return a dormant row so the same credential can reconnect. */
  takeStandby(peerId: string): MeshPeerSessionEntry | undefined {
    const entry = this.findByPeerId(peerId)
    if (!entry?.standby || !this.remove(entry)) return undefined
    return entry
  }

  overBudgetEntries(lifecycle: MeshPeerLifecycleState): MeshPeerSessionEntry[] {
    if (this.policy === 'connect') return []
    const limit = lifecycle === 'background'
      ? this.budget.backgroundPeerLimit
      : this.budget.foregroundPeerLimit
    const candidates = this.activeEntries().filter((entry) => entry.bridge !== null)
    if (limit === null || candidates.length <= limit) return []
    const sorted = candidates.sort(compareRetentionPriority)
    return sorted.slice(0, Math.max(0, sorted.length - limit))
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

function compareRetentionPriority(left: MeshPeerSessionEntry, right: MeshPeerSessionEntry): number {
  // Lowest priority sorts first and is shed first. Keep the comparison
  // lexicographic: no timestamp can outrank a dependency or a user pin.
  if (left.budget.userPinned !== right.budget.userPinned) return left.budget.userPinned ? 1 : -1
  const leftDependedUpon = left.budget.dependedUpon || left.budget.activeRouteCount > 0
  const rightDependedUpon = right.budget.dependedUpon || right.budget.activeRouteCount > 0
  if (leftDependedUpon !== rightDependedUpon) return leftDependedUpon ? 1 : -1
  if (left.budget.lastUsedAtMs !== right.budget.lastUsedAtMs) {
    return left.budget.lastUsedAtMs - right.budget.lastUsedAtMs
  }
  if (left.budget.connectedAtMs !== right.budget.connectedAtMs) {
    return left.budget.connectedAtMs - right.budget.connectedAtMs
  }
  return left.key.localeCompare(right.key)
}
