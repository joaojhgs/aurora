import { describe, expect, it } from 'vitest'

import { ProviderLeaseController } from '../src/webrtc/index.js'

describe('ProviderLeaseController', () => {
  it('uses bounded 20s renew and 60s expiry defaults with fake clock', () => {
    let now = 1000
    const lease = new ProviderLeaseController({ peerId: 'peer-local', clock: () => now, randomId: () => 'epoch-1' })
    expect(lease.renewMs).toBe(20_000)
    expect(lease.ttlMs).toBe(60_000)
    const first = lease.startEpoch()
    expect(first).toMatchObject({ connection_epoch: 'epoch-1', issued_at_ms: 1000, expires_at_ms: 61_000, available: true })
    now += 20_000
    const second = lease.renew()
    expect(second).toMatchObject({ issued_at_ms: 21_000, expires_at_ms: 81_000, availability_revision: 2 })
    now += 59_999
    expect(lease.isActive()).toBe(true)
    now += 1
    expect(lease.isActive()).toBe(false)
    expect(lease.snapshot()).toMatchObject({ available: false, reason_code: 'lease_expired' })
  })

  it('rejects out-of-range configuration', () => {
    expect(() => new ProviderLeaseController({ peerId: 'peer-local', ttlMs: 1000 })).toThrow('ttl')
    expect(() => new ProviderLeaseController({ peerId: 'peer-local', ttlMs: 60_000, renewMs: 60_000 })).toThrow('renew')
  })
})
