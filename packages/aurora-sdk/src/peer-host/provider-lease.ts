import type { ProviderLeaseRecord } from './types.js'

export const PROVIDER_LEASE_CAPABILITY = 'provider_lease_v1' as const
export const DEFAULT_PROVIDER_LEASE_TTL_MS = 60_000
export const DEFAULT_PROVIDER_LEASE_RENEW_MS = 20_000

export interface ProviderLeaseOptions {
  readonly peerId: string
  readonly clock?: () => number
  readonly randomId?: () => string
  readonly ttlMs?: number
  readonly renewMs?: number
}

export class ProviderLeaseController {
  readonly ttlMs: number
  readonly renewMs: number
  private readonly peerId: string
  private readonly clock: () => number
  private readonly randomId: () => string
  private epoch: string
  private revision = 0
  private current: ProviderLeaseRecord | null = null

  constructor(options: ProviderLeaseOptions) {
    this.peerId = requireNonEmpty(options.peerId, 'peerId')
    this.ttlMs = options.ttlMs ?? DEFAULT_PROVIDER_LEASE_TTL_MS
    this.renewMs = options.renewMs ?? DEFAULT_PROVIDER_LEASE_RENEW_MS
    if (this.ttlMs < 10_000 || this.ttlMs > 5 * 60_000) throw new Error('provider lease ttl must be in 10000..300000ms')
    if (this.renewMs < 1_000 || this.renewMs >= this.ttlMs) throw new Error('provider lease renew interval must be in 1000ms..ttl')
    this.clock = options.clock ?? (() => Date.now())
    this.randomId = options.randomId ?? (() => `epoch-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
    this.epoch = this.randomId()
  }

  startEpoch(): ProviderLeaseRecord {
    this.epoch = this.randomId()
    return this.renew()
  }

  renew(): ProviderLeaseRecord {
    const issuedAtMs = Math.floor(this.clock())
    this.revision += 1
    this.current = {
      type: 'provider_lease',
      peer_id: this.peerId,
      connection_epoch: this.epoch,
      availability_revision: this.revision,
      issued_at_ms: issuedAtMs,
      expires_at_ms: issuedAtMs + this.ttlMs,
      available: true
    }
    return this.current
  }

  tombstone(reasonCode = 'provider_unavailable'): ProviderLeaseRecord {
    const issuedAtMs = Math.floor(this.clock())
    this.revision += 1
    this.current = {
      type: 'provider_unavailable',
      peer_id: this.peerId,
      connection_epoch: this.epoch,
      availability_revision: this.revision,
      issued_at_ms: issuedAtMs,
      expires_at_ms: issuedAtMs,
      available: false,
      reason_code: reasonCode
    }
    return this.current
  }

  snapshot(): ProviderLeaseRecord | null {
    if (!this.current) return null
    if (this.current.available && this.current.expires_at_ms <= this.clock()) {
      return { ...this.current, available: false, reason_code: 'lease_expired' }
    }
    return this.current
  }

  isActive(): boolean {
    const lease = this.snapshot()
    return Boolean(lease?.available)
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`${label} must be a bounded string`)
  return value
}
