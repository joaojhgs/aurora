/** Per-session signaling allowlist for the browser/WebView WebRTC thin runtime.
 *
 * Presence in a room is discovery, not authority. A thin client observes every
 * peer that announces itself so a three-node room reports three devices, but an
 * established session must only ever be driven by the peer it belongs to.
 *
 * This is the control that replaces the flat `expectedStablePeerId` drop in the
 * signaling filter (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`, section 7). It is
 * consulted at the one chokepoint every inbound envelope passes through — after
 * the envelope has been opened and matched — so nothing reaches a session's
 * signaling handler without going past it.
 *
 * The rules, in order:
 *
 * 1. A configured signaling identity is absolute: nothing else is ever admitted.
 * 2. An envelope naming a stable identity that is not this session's is refused,
 *    whatever channel it arrived on.
 * 3. Before the session has a counterpart, the first envelope that names this
 *    session's stable identity binds it.
 * 4. Once bound, only the bound signaling identity is admitted.
 * 5. Presence is the only channel that may move a binding, and only while the
 *    session is not yet established. An established session is pinned, so a
 *    forged envelope claiming a peer's stable identity cannot drive,
 *    renegotiate, hijack or tear down that peer's session.
 *
 * Releasing the binding is an explicit act by the owner of the session — the
 * peer departed, or the transport dropped — never something an inbound envelope
 * can do on its own.
 */

import type { SignalingChannel } from './signaling-mqtt.js'

/** Machine-readable reason for a refused signaling envelope. */
export const SIGNALING_PEER_NOT_ALLOWLISTED_REASON = 'signaling_peer_not_allowlisted'

export interface SignalingAllowlistCandidate {
  readonly channel: SignalingChannel
  /** Signaling identity the envelope came from. */
  readonly from: string
  /** Stable identity the envelope claims, when it names one. */
  readonly stablePeerId?: string | undefined
}

export interface SignalingSessionAllowlistOptions {
  /** Stable identity this session belongs to, when the invite named one. */
  readonly expectedStablePeerId?: string | undefined
  /** Signaling identity this session is pinned to, when one was configured. */
  readonly expectedSignalingPeerId?: string | undefined
}

export interface SignalingSessionAllowlistSnapshot {
  readonly expectedStablePeerId?: string | undefined
  readonly expectedSignalingPeerId?: string | undefined
  readonly boundSignalingPeerId?: string | undefined
  readonly boundStablePeerId?: string | undefined
  readonly established: boolean
}

export class SignalingSessionAllowlist {
  private readonly expectedStablePeerId: string | undefined
  private readonly expectedSignalingPeerId: string | undefined
  private boundSignalingPeerId: string | undefined
  private boundStablePeerId: string | undefined
  private establishedBinding = false

  constructor(options: SignalingSessionAllowlistOptions = {}) {
    this.expectedStablePeerId = options.expectedStablePeerId
    this.expectedSignalingPeerId = options.expectedSignalingPeerId
    this.boundSignalingPeerId = options.expectedSignalingPeerId
  }

  snapshot(): SignalingSessionAllowlistSnapshot {
    return {
      ...(this.expectedStablePeerId !== undefined ? { expectedStablePeerId: this.expectedStablePeerId } : {}),
      ...(this.expectedSignalingPeerId !== undefined ? { expectedSignalingPeerId: this.expectedSignalingPeerId } : {}),
      ...(this.boundSignalingPeerId !== undefined ? { boundSignalingPeerId: this.boundSignalingPeerId } : {}),
      ...(this.boundStablePeerId !== undefined ? { boundStablePeerId: this.boundStablePeerId } : {}),
      established: this.establishedBinding
    }
  }

  /** The stable identity this session answers for, once anything named one. */
  get anchorStablePeerId(): string | undefined {
    return this.boundStablePeerId ?? this.expectedStablePeerId
  }

  get signalingPeerId(): string | undefined {
    return this.boundSignalingPeerId
  }

  get established(): boolean {
    return this.establishedBinding
  }

  /**
   * Pin the session to the counterpart it negotiated with. From here no other
   * signaling identity is admitted until the binding is released.
   */
  establish(signalingPeerId?: string): void {
    if (signalingPeerId !== undefined) this.boundSignalingPeerId = signalingPeerId
    if (this.boundSignalingPeerId !== undefined) this.establishedBinding = true
  }

  /** Drop the binding so discovery can bind a restarted peer's new identity. */
  release(): void {
    this.establishedBinding = false
    if (this.expectedSignalingPeerId !== undefined) return
    this.boundSignalingPeerId = undefined
  }

  /**
   * Decide whether an opened envelope may reach this session, binding the
   * session to its counterpart on first contact.
   */
  admits(candidate: SignalingAllowlistCandidate): boolean {
    if (this.expectedSignalingPeerId !== undefined && candidate.from !== this.expectedSignalingPeerId) return false
    const anchor = this.anchorStablePeerId
    const claimed = candidate.stablePeerId
    if (anchor !== undefined && claimed !== undefined && claimed !== anchor) return false
    if (this.boundSignalingPeerId === undefined) {
      // First contact. A session that knows which device it is waiting for only
      // binds to an envelope that names that device.
      if (anchor !== undefined && claimed === undefined) return false
      this.bind(candidate.from, claimed)
      return true
    }
    if (candidate.from === this.boundSignalingPeerId) {
      if (claimed !== undefined) this.boundStablePeerId = claimed
      return true
    }
    // A different signaling identity claiming this session's device. Only
    // discovery widens, and only before the session is established.
    if (this.establishedBinding) return false
    if (candidate.channel !== 'presence') return false
    if (claimed === undefined || claimed !== anchor) return false
    this.bind(candidate.from, claimed)
    return true
  }

  private bind(signalingPeerId: string, stablePeerId: string | undefined): void {
    this.boundSignalingPeerId = signalingPeerId
    if (stablePeerId !== undefined) this.boundStablePeerId = stablePeerId
  }
}
