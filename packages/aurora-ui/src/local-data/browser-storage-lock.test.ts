import { describe, expect, it } from 'vitest'

import {
  BrowserStorageLockCoordinator,
  deriveBrowserStorageOwnerKey
} from './browser-storage-lock'
import {
  FakeWebLocks,
  MapBrowserStorageLeaseStore
} from './__tests__/local-data-test-helpers'

describe('BrowserStorageLockCoordinator', () => {
  it('uses Web Locks as the preferred owner and rejects same-node contenders', async () => {
    const locks = new FakeWebLocks()
    const first = await new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-1',
      ownerId: 'owner-1',
      locks
    }).acquire()

    await expect(new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test/ignored-path',
      localNodeId: 'node-1',
      ownerId: 'owner-2',
      locks
    }).acquire()).rejects.toMatchObject({
      code: 'unsupported_backend',
      metadata: { reason: 'owner_exists' }
    })

    await first.release()
    await expect(new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-1',
      ownerId: 'owner-2',
      locks
    }).acquire()).resolves.toMatchObject({
      status: { mode: 'web-locks' }
    })
  })

  it('isolates distinct local-node identities even under the same origin', async () => {
    const leases = new MapBrowserStorageLeaseStore()
    const first = await new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-1',
      ownerId: 'owner-1',
      locks: null,
      leaseStore: leases
    }).acquire()
    const second = await new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-2',
      ownerId: 'owner-2',
      locks: null,
      leaseStore: leases
    }).acquire()

    expect(first.status.lockKey).not.toBe(second.status.lockKey)
    await first.release()
    await second.release()
  })

  it('recovers expired leases and makes the losing writer fail future writes', async () => {
    let now = 1_000
    const leases = new MapBrowserStorageLeaseStore()
    const first = await new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-1',
      ownerId: 'owner-1',
      locks: null,
      leaseStore: leases,
      nowMs: () => now,
      leaseDurationMs: 100
    }).acquire()
    now = 1_200
    const second = await new BrowserStorageLockCoordinator({
      origin: 'https://aurora.example.test',
      localNodeId: 'node-1',
      ownerId: 'owner-2',
      locks: null,
      leaseStore: leases,
      nowMs: () => now,
      leaseDurationMs: 100
    }).acquire()

    expect(second.status.ownerId).toBe('owner-2')
    expect(() => first.assertWritable()).toThrow(/Browser local data is already open/u)
    await expect(first.renew()).rejects.toMatchObject({
      metadata: { reason: 'lease_lost' }
    })
    await second.release()
  })

  it('derives ownership from origin and stable local-node identity only', () => {
    expect(deriveBrowserStorageOwnerKey('https://aurora.example.test/a', 'node-1'))
      .toBe(deriveBrowserStorageOwnerKey('https://aurora.example.test/b', 'node-1'))
    expect(deriveBrowserStorageOwnerKey('https://aurora.example.test', 'node-1'))
      .not.toBe(deriveBrowserStorageOwnerKey('https://aurora.example.test', 'node-2'))
  })
})
