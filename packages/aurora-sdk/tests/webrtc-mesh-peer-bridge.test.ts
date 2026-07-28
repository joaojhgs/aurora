import { describe, expect, it, vi } from 'vitest'

import { AuroraClient } from '../src/client.js'
import { MeshP2PTransport } from '../src/mesh.js'
import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_PROVIDER_LEASE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  PeerProtocolLimits,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  WebRtcMeshPeerBridge,
  buildProtocolHello,
  createToolingPeerHostRegistry,
  createWebRtcMeshTransport,
  fragmentMessage,
  type LocalPeerGrantV1,
  type PeerSessionSnapshot
} from '../src/webrtc/index.js'

class FakeSession {
  sent: unknown[] = []
  frameListeners = new Set<(frame: unknown) => void>()
  snapshotListeners = new Set<(snapshot: PeerSessionSnapshot) => void>()
  snapshot: PeerSessionSnapshot = {
    state: 'authorized', role: 'answerer', closed: false, failed: false, authorized: true,
    localSignalingId: 'local', remoteSignalingId: 'sig-peer-a', expectedRemoteStableId: 'peer-a', icePath: 'host', reconnectAttempts: 0
  }
  async sendFrame(frame: unknown): Promise<void> { this.sent.push(frame) }
  subscribeFrames(listener: (frame: unknown) => void): () => void { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener) }
  subscribe(listener: (snapshot: PeerSessionSnapshot) => void): () => void { this.snapshotListeners.add(listener); listener(this.snapshot); return () => this.snapshotListeners.delete(listener) }
  getSnapshot(): PeerSessionSnapshot { return this.snapshot }
  emit(frame: unknown): void { for (const listener of [...this.frameListeners]) listener(frame) }
  setSnapshot(patch: Partial<PeerSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.snapshotListeners]) listener(this.snapshot)
  }
  disconnect(): void {
    this.setSnapshot({ state: 'failed', failed: true, authorized: false })
  }
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}

function hello(): unknown {
  return buildProtocolHello({
    role: 'provider',
    capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_CONSUMER_ONLY_V1],
    limits: new PeerProtocolLimits()
  })
}

function localGrant(): LocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    tokenId: 'token-1',
    claimantPeerId: 'peer-a',
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: [],
    capabilityPackIds: [],
    resourceScopes: [],
    createdAtMs: 1,
    grantRevision: 1
  }
}

describe('WebRtcMeshPeerBridge', () => {
  it('sends exact call frames and resolves result/errors while ignoring unknown duplicates', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'rpc-1', timeoutMs: 1000 })
    const promise = bridge.call({ peerId: 'peer-a', method: 'Gateway.GetRegistry', busTopic: 'Gateway.GetRegistry', payload: { include: true, mesh_selector: { peer_id: 'peer-a' } }, timeoutMs: 1000, candidates: [], correlationId: 'corr-1' })
    expect(session.sent[0]).toEqual({ type: 'call', id: 'corr-1', method: 'Gateway.GetRegistry', params: { include: true }, correlation_id: 'corr-1', identity: { principal_id: null, effective_perms: null, source: null, method_type: null, caller_peer_id: null, auth_grant_revision: null, manifest_revision: null } })
    session.emit({ type: 'result', id: 'unknown', result: 'ignored' })
    session.emit({ type: 'result', id: 'corr-1', result: { ok: true } })
    session.emit({ type: 'result', id: 'corr-1', result: { duplicate: true } })
    await expect(promise).resolves.toMatchObject({ data: { ok: true }, peerId: 'peer-a', targetPeerId: 'peer-a' })

    const errorPromise = bridge.call({ peerId: 'peer-a', method: 'Bad', busTopic: 'Bad', timeoutMs: 1000, candidates: [] })
    session.emit({ type: 'error', id: 'rpc-1', correlation_id: 'rpc-1', error: { code: 403, message: 'forbidden' } })
    await expect(errorPromise).resolves.toMatchObject({ error: { code: 403, message: 'forbidden' }, status: 403, correlationId: 'rpc-1' })
  })

  it('times out and aborts pending calls on disconnect cleanup', async () => {
    vi.useFakeTimers()
    try {
      const session = new FakeSession()
      const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'timeout-1', timeoutMs: 10 })
      const timeout = bridge.call({ peerId: 'peer-a', method: 'Slow', busTopic: 'Slow', timeoutMs: 10, candidates: [] })
      vi.advanceTimersByTime(11)
      await expect(timeout).rejects.toThrow('timed out')
      await flush()
      expect(session.sent.some((frame) => (frame as any).type === 'cancel' && (frame as any).id === 'timeout-1')).toBe(true)

      const pending = bridge.call({ peerId: 'peer-a', method: 'Slow2', busTopic: 'Slow2', timeoutMs: 1000, candidates: [] })
      session.disconnect()
      await expect(pending).rejects.toThrow('session failed')
      expect(session.frameListeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fragments large outbound frames and reassembles inbound fragments exactly once', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'large-1', fragmentationThresholdBytes: 1024 })
    session.emit(hello())
    const payload = { blob: 'x'.repeat(512 * 1024) }
    const promise = bridge.call({ peerId: 'peer-a', method: 'Large', busTopic: 'Large', payload, timeoutMs: 1000, candidates: [] })
    await flush()
    expect(session.sent.length).toBeGreaterThan(1)
    expect((session.sent[0] as any).type).toBe('fragment')

    const resultJson = JSON.stringify({ type: 'result', id: 'large-1', result: { blob: 'y'.repeat(512 * 1024) } })
    const fragments = fragmentMessage(resultJson, { messageId: 'in-large' })
    for (const fragment of fragments) session.emit(fragment)
    for (const fragment of fragments) session.emit(fragment)
    await expect(promise).resolves.toMatchObject({ data: { blob: 'y'.repeat(512 * 1024) } })
  })

  it('streams scoped events with correlation isolation and rejects wildcard subscriptions', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'sub-1' })
    expect(() => bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Assistant.*'], candidates: [] } as any)).toThrow('wildcard')
    expect(() => bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Orchestrator.Response'], candidates: [] } as any)).toThrow('unsupported')
    session.emit(hello())

    const stream = bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Orchestrator.Response'], payload: { correlation_id: 'corr-1' }, candidates: [] } as any)
    expect(session.sent[0]).toMatchObject({ type: 'subscribe', id: 'sub-1', topics: ['Orchestrator.Response'], correlation_ids: ['corr-1'] })
    session.emit({ type: 'subscribed', id: 'sub-1', subscription_id: 'sub-1', accepted: true, accepted_topics: ['Orchestrator.Response'], rejected_topics: [], correlation_ids: ['corr-1'], ttl_seconds: 60, reason: null, idempotent: false })
    await flush()
    session.emit({ type: 'event', topic: 'Orchestrator.Response', params: { text: 'wrong' }, correlation_id: 'other' })
    session.emit({ type: 'event', topic: 'Orchestrator.Response', params: { text: 'ok' }, correlation_id: 'corr-1' })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'Orchestrator.Response', topic: 'Orchestrator.Response', payload: { text: 'ok' }, correlation_id: 'corr-1' }, done: false })
    await iterator.return?.()
    expect(session.sent.some((frame) => (frame as any).type === 'unsubscribe' && (frame as any).id === 'sub-1')).toBe(true)
  })

  it('streams RPC chunks through the mesh transport and cancels exactly once on abort', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      randomId: (() => {
        let index = 0
        return () => `stream-${++index}`
      })()
    })
    session.emit(hello())
    const transport = new MeshP2PTransport({
      bridge,
      defaultPeerId: 'peer-a'
    })

    const stream = transport.streamRequest<{ delta: string }>({
      method: 'Orchestrator.StreamInferChat',
      busTopic: 'Orchestrator.StreamInferChat',
      payload: { message: 'hello' },
      timeoutMs: 1000
    })
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    await flush()
    expect(session.sent[0]).toMatchObject({
      type: 'call',
      id: 'stream-1',
      correlation_id: 'stream-1',
      method: 'Orchestrator.StreamInferChat'
    })
    session.emit({ type: 'chunk', id: 'stream-1', data: { delta: 'one' } })
    await expect(first).resolves.toEqual({ value: { delta: 'one' }, done: false })
    const second = iterator.next()
    session.emit({ type: 'chunk', id: 'stream-1', data: { delta: 'two' } })
    session.emit({ type: 'eof', id: 'stream-1' })
    await expect(second).resolves.toEqual({ value: { delta: 'two' }, done: false })
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
    expect(session.sent.filter((frame) => (frame as any).type === 'cancel' && (frame as any).id === 'stream-1')).toHaveLength(0)

    const abortController = new AbortController()
    const cancelled = transport.streamRequest<{ delta: string }>({
      method: 'Orchestrator.StreamInferChat',
      busTopic: 'Orchestrator.StreamInferChat',
      payload: { message: 'cancel me' },
      timeoutMs: 1000,
      signal: abortController.signal
    })
    const cancelledIterator = cancelled[Symbol.asyncIterator]()
    const cancelledFirst = cancelledIterator.next()
    await flush()
    session.emit({ type: 'chunk', id: 'stream-2', data: { delta: 'started' } })
    await expect(cancelledFirst).resolves.toEqual({ value: { delta: 'started' }, done: false })
    abortController.abort()
    await expect(cancelledIterator.next()).rejects.toThrow('timed out')
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'cancel' && (frame as any).id === 'stream-2')).toHaveLength(1)
    session.emit({ type: 'chunk', id: 'stream-2', data: { delta: 'late' } })
    session.emit({ type: 'eof', id: 'stream-2', cancelled: true })
    expect(bridge.getDiagnostics().pendingStreamCount).toBe(0)
  })

  it('surfaces streamed RPC errors without resolving an ordinary call', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      randomId: () => 'stream-error'
    })
    const stream = bridge.streamCall({
      peerId: 'peer-a',
      method: 'Orchestrator.StreamInferChat',
      busTopic: 'Orchestrator.StreamInferChat',
      payload: {},
      timeoutMs: 1000,
      candidates: []
    })
    const next = stream[Symbol.asyncIterator]().next()
    await flush()
    session.emit({
      type: 'error',
      id: 'stream-error',
      correlation_id: 'stream-error',
      error: { code: 500, message: 'stream exploded' }
    })

    await expect(next).rejects.toThrow('stream exploded')
  })

  it('handles subscribe rejection, stream overflow/cancel, inbound consumer call rejection, manifest, and transport smoke', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      randomId: (() => { let i = 0; return () => `id-${++i}` })(),
      streamQueueLimit: 1
    })

    session.emit(hello())

    const rejected = bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['A.Topic'], candidates: [] } as any)
    await flush()
    session.emit({ type: 'subscribe_rejected', id: 'id-1', reason: 'nope' })
    await expect(rejected[Symbol.asyncIterator]().next()).rejects.toThrow('nope')

    const stream = bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['B.Topic'], candidates: [] } as any)
    session.emit({ type: 'subscribed', id: 'id-2', subscription_id: 'id-2', accepted: true, accepted_topics: ['B.Topic'], rejected_topics: [], correlation_ids: [], ttl_seconds: 60, reason: null, idempotent: false })
    await flush()
    session.emit({ type: 'chunk', id: 'id-2', data: { one: true } })
    session.emit({ type: 'chunk', id: 'id-2', data: { two: true } })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('overflow')
    expect(session.sent.some((frame) => (frame as any).type === 'cancel' && (frame as any).id === 'id-2')).toBe(true)

    session.emit({ type: 'call', id: 'remote-call', method: 'Gateway.GetRegistry' })
    expect(session.sent.some((frame) => (frame as any).type === 'error' && (frame as any).id === 'remote-call' && (frame as any).error.code === 405)).toBe(true)

    const manifestPromise = bridge.getManifest('peer-a')
    await flush()
    expect(session.sent.some((frame) => JSON.stringify(frame) === JSON.stringify({ type: 'manifest_request' }))).toBe(true)
    session.emit({ type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] })
    await expect(manifestPromise).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A', authenticated: true })
    await flush()
    expect(session.sent.some((frame) => (frame as any).type === 'manifest_ack' && Array.isArray((frame as any).compatible_services))).toBe(true)

    const transport = createWebRtcMeshTransport({ session, remotePeerId: 'peer-a', defaultPeerId: 'peer-a', bridge: { randomId: () => 'transport-1' } })
    const client = new AuroraClient({ transport })
    const resultPromise = client.requestResult('Gateway.GetRegistry')
    await flush()
    session.emit({ type: 'result', id: 'transport-1', result: { registry: true } })
    await expect(resultPromise).resolves.toMatchObject({ ok: true, data: { registry: true } })
  })

  it('preserves consumer-only 405 and dispatches authorized hybrid inbound calls through peer host', async () => {
    const consumerSession = new FakeSession()
    const consumerBridge = new WebRtcMeshPeerBridge({ session: consumerSession, remotePeerId: 'peer-a' })
    consumerSession.emit({ type: 'call', id: 'remote-call', method: 'Tooling.GetTools', params: {} })
    await flush()
    expect(consumerSession.sent.at(-1)).toMatchObject({ type: 'error', id: 'remote-call', error: { code: 405, message: 'Local peer is consumer-only' } })
    consumerBridge.close()

    const handler = vi.fn(async () => ({ count: 0, tools: [] }))
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: createToolingPeerHostRegistry({
        getTools: handler,
        getExportCatalog: async () => { throw new Error('not implemented') },
        prepareExecution: async () => { throw new Error('not implemented') },
        executeTool: async () => { throw new Error('not implemented') }
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] })
    })
    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
    session.emit({ type: 'manifest_ack', compatible_services: ['Tooling'] })
    session.emit({ type: 'call', id: 'host-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush()
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(session.sent.at(-1)).toEqual({ type: 'result', id: 'host-call', result: { count: 0, tools: [] } })
    bridge.close()
  })

  it('enforces stable identity, abort cancellation, and negotiated fragmentation only', async () => {
    const mismatched = new FakeSession()
    mismatched.snapshot = { ...mismatched.snapshot, expectedRemoteStableId: 'other-peer' }
    expect(() => new WebRtcMeshPeerBridge({ session: mismatched, remotePeerId: 'peer-a' })).toThrow('stable identity mismatch')

    const preAbortSession = new FakeSession()
    const preAbortBridge = new WebRtcMeshPeerBridge({ session: preAbortSession, remotePeerId: 'peer-a', randomId: () => 'pre-abort' })
    const preAbort = new AbortController()
    preAbort.abort()
    await expect(preAbortBridge.call({ peerId: 'peer-a', method: 'Slow', busTopic: 'Slow', timeoutMs: 1000, signal: preAbort.signal, candidates: [] })).rejects.toThrow('aborted')
    expect(preAbortSession.sent).toEqual([])

    const postAbortSession = new FakeSession()
    const postAbortBridge = new WebRtcMeshPeerBridge({ session: postAbortSession, remotePeerId: 'peer-a', randomId: () => 'post-abort' })
    const postAbort = new AbortController()
    const promise = postAbortBridge.call({ peerId: 'peer-a', method: 'Slow', busTopic: 'Slow', timeoutMs: 1000, signal: postAbort.signal, candidates: [] })
    await flush()
    expect(postAbortSession.sent[0]).toMatchObject({ type: 'call', id: 'post-abort', correlation_id: 'post-abort' })
    postAbort.abort()
    await expect(promise).rejects.toThrow('aborted')
    await flush()
    expect(postAbortSession.sent.some((frame) => (frame as any).type === 'cancel' && (frame as any).id === 'post-abort')).toBe(true)
    postAbortSession.emit({ type: 'result', id: 'post-abort', result: { late: true } })

    const noFragmentSession = new FakeSession()
    const noFragmentBridge = new WebRtcMeshPeerBridge({ session: noFragmentSession, remotePeerId: 'peer-a', randomId: () => 'no-frag', fragmentationThresholdBytes: 64 })
    noFragmentSession.emit(buildProtocolHello({ role: 'provider', capabilities: [], limits: new PeerProtocolLimits() }))
    const noFragment = noFragmentBridge.call({ peerId: 'peer-a', method: 'Large', busTopic: 'Large', payload: { blob: 'x'.repeat(512) }, timeoutMs: 1000, candidates: [] })
    await expect(noFragment).rejects.toThrow('fragmentation_v1')
    expect(noFragmentSession.sent).toEqual([])
  })


  it('resets recoverable epoch without permanent close and requires fresh protocol state', async () => {
    const session = new FakeSession()
    const ids = ['call-1', 'sub-active', 'sub-pending', 'call-2']
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => ids.shift() ?? 'extra' })
    session.emit(hello())

    const pending = bridge.call({ peerId: 'peer-a', method: 'Slow', busTopic: 'Slow', timeoutMs: 1000, candidates: [] })
    const activeStream = bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Orchestrator.Response'], payload: { correlation_id: 'corr-stale' }, candidates: [] } as any)
    const activeIterator = activeStream[Symbol.asyncIterator]()
    await flush()
    session.emit({ type: 'subscribed', id: 'sub-active', subscription_id: 'sub-active', accepted: true, accepted_topics: ['Orchestrator.Response'], rejected_topics: [], correlation_ids: ['corr-stale'], ttl_seconds: 60, reason: null, idempotent: false })
    await flush()
    const pendingStream = bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Pending.Topic'], candidates: [] } as any)
    const pendingIterator = pendingStream[Symbol.asyncIterator]()
    const activeNext = activeIterator.next()
    const pendingNext = pendingIterator.next()
    const manifest = bridge.getManifest('peer-a')
    await flush()

    session.setSnapshot({ state: 'reconnecting', authorized: false })
    await expect(pending).rejects.toThrow('transport lost during epoch reset: session reconnecting')
    await expect(activeNext).rejects.toThrow('transport lost during epoch reset: session reconnecting')
    await expect(pendingNext).rejects.toThrow('transport lost during epoch reset: session reconnecting')
    await expect(manifest).rejects.toThrow('transport lost during epoch reset: session reconnecting')
    expect(bridge.getDiagnostics()).toMatchObject({
      pendingCallCount: 0,
      pendingStreamCount: 0,
      pendingSubscriptionCount: 0
    })
    await expect(bridge.call({ peerId: 'peer-a', method: 'DuringReconnect', busTopic: 'DuringReconnect', timeoutMs: 1000, candidates: [] })).rejects.toThrow('not connected')
    session.emit({ type: 'result', id: 'call-1', result: { stale: true } })
    session.emit({ type: 'event', topic: 'Orchestrator.Response', params: { kind: 'assistant.delta', delta: 'stale' }, correlation_id: 'corr-stale' })
    expect(session.sent.filter((frame) => (frame as any).type === 'call' && (frame as any).id === 'call-1')).toHaveLength(1)

    session.setSnapshot({ state: 'authorized', authorized: true, failed: false })
    expect(() => bridge.subscribe({ peerId: 'peer-a', stream: 'assistant', topics: ['Orchestrator.Response'], candidates: [] } as any)).toThrow('unsupported')
    session.emit(hello())
    const fresh = bridge.call({ peerId: 'peer-a', method: 'Fresh', busTopic: 'Fresh', timeoutMs: 1000, candidates: [] })
    await flush()
    expect(session.sent.some((frame) => (frame as any).type === 'call' && (frame as any).id === 'call-2')).toBe(true)
    session.emit({ type: 'result', id: 'call-2', result: { fresh: true } })
    await expect(fresh).resolves.toMatchObject({ data: { fresh: true } })
  })

  it('classifies an epoch reset as transport loss and never replays the in-flight call', async () => {
    const session = new FakeSession()
    const transport = createWebRtcMeshTransport({
      session,
      remotePeerId: 'peer-a',
      defaultPeerId: 'peer-a',
      bridge: { randomId: () => 'transport-reset' }
    })
    const client = new AuroraClient({ transport })
    const request = client.registry.getRegistry()
    await flush()

    expect(session.sent.filter((frame) => (frame as any).type === 'call' && (frame as any).id === 'transport-reset')).toHaveLength(1)
    session.setSnapshot({ state: 'reconnecting', authorized: false })

    await expect(request).rejects.toMatchObject({ code: 'transport_loss' })
    session.setSnapshot({ state: 'authorized', authorized: true, failed: false })
    session.emit(hello())
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'call' && (frame as any).id === 'transport-reset')).toHaveLength(1)
  })

  it('does not accept signaling id as stable binding and fragments at negotiated payload size', async () => {
    const noStable = new FakeSession()
    noStable.snapshot = { ...noStable.snapshot, expectedRemoteStableId: undefined, remoteSignalingId: 'peer-a' }
    expect(() => new WebRtcMeshPeerBridge({ session: noStable, remotePeerId: 'peer-a' })).toThrow('stable identity mismatch')

    const session = new FakeSession()
    const limits = new PeerProtocolLimits({ fragmentPayloadBytes: 1024, maxLogicalBytes: 8 * 1024 * 1024, maxPeerAggregateBytes: 8 * 1024 * 1024, incompleteTtlSeconds: 30, maxFragments: 4096 })
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: (() => { let i = 0; return () => i++ === 0 ? 'call-8k' : `frag-${i}` })(), fragmentationThresholdBytes: 64 * 1024 })
    session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1], limits }))
    void bridge.call({ peerId: 'peer-a', method: 'LargeUtf8', busTopic: 'LargeUtf8', payload: { blob: 'é'.repeat(4096) }, timeoutMs: 1000, candidates: [] }).catch(() => undefined)
    await flush()
    expect(session.sent.length).toBeGreaterThan(1)
    expect(session.sent.every((frame) => (frame as any).type === 'fragment')).toBe(true)
    expect((session.sent[0] as any).payload_b64.length).toBeGreaterThan(0)
  })

})
