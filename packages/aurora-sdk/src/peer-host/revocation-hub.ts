import type { PeerRevocationBroadcaster, PeerRevocationEvent } from './authority-types.js'

/**
 * Fan-out for peer revocations.
 *
 * Deliberately still TypeScript after R2: this decides nothing. The Rust
 * authority decides that a relationship's authority is withdrawn and returns
 * the event; this delivers that event to whoever is listening, so a live
 * request can be cancelled and the UI can update. Moving a pub/sub hub across
 * the seam would buy nothing and cost a round trip per subscriber.
 */
export class PeerRevocationHub implements PeerRevocationBroadcaster {
  private readonly listeners = new Set<(event: PeerRevocationEvent) => void>()

  async publish(event: PeerRevocationEvent): Promise<void> {
    for (const listener of [...this.listeners]) listener(event)
  }

  subscribe(listener: (event: PeerRevocationEvent) => void): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }
}
