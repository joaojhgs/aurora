import { describe, expect, it } from 'vitest'

import { MeshEventSubscriptionRegistry } from '../src/webrtc/index.js'

describe('Mesh event subscriptions', () => {
  it('accepts exact topic subscriptions and expires them', () => {
    const registry = new MeshEventSubscriptionRegistry({ clock: () => 10 })
    const result = registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-001',
      topics: ['Tooling.ProjectionInvalidated'],
      correlationIds: ['corr-event-001'],
      ttlSeconds: 60
    })

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        acceptedTopics: ['Tooling.ProjectionInvalidated'],
        idempotent: false
      })
    )
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Tooling.ProjectionInvalidated', correlationId: 'corr-event-001', now: 20 })).toBe(true)
    expect(registry.isInterested({ peerId: 'peer-a', topic: 'Tooling.ProjectionInvalidated', correlationId: 'nope', now: 20 })).toBe(false)
    expect(registry.unsubscribe('peer-a', 'sub-001')).toBe(true)
    expect(registry.snapshot()).toEqual([])
  })

  it('rejects wildcard topics and enforces peer quotas', () => {
    const registry = new MeshEventSubscriptionRegistry({ maxSubscriptionsPerPeer: 1, clock: () => 10 })
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-001',
        topics: ['Tooling.*'],
        ttlSeconds: 60
      })
    ).toThrow()
    registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-001',
      topics: ['Tooling.ProjectionInvalidated'],
      ttlSeconds: 60
    })
    const second = registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-002',
      topics: ['Orchestrator.Response'],
      correlationIds: ['corr-quota'],
      ttlSeconds: 60
    })
    expect(second.accepted).toBe(false)
  })

  it('requires correlation IDs for Orchestrator.Response and TTS.AudioChunk', () => {
    const registry = new MeshEventSubscriptionRegistry({ clock: () => 10 })
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-required',
        topics: ['Orchestrator.Response'],
        ttlSeconds: 60
      })
    ).toThrow(/correlation_id is required/)
    expect(() =>
      registry.subscribe({
        peerId: 'peer-a',
        id: 'sub-tts',
        topics: ['TTS.AudioChunk'],
        ttlSeconds: 60
      })
    ).toThrow(/correlation_id is required/)

    registry.subscribe({
      peerId: 'peer-a',
      id: 'sub-scoped',
      topics: ['Orchestrator.Response'],
      correlationIds: ['corr-event-001'],
      ttlSeconds: 60
    })
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      correlationId: 'corr-event-001',
      now: 20
    })).toBe(true)
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      now: 20
    })).toBe(false)
    expect(registry.isInterested({
      peerId: 'peer-a',
      topic: 'Orchestrator.Response',
      correlationId: '',
      now: 20
    })).toBe(false)
  })
})
