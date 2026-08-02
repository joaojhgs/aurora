import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'

import { AuroraClient } from '../src/client.js'
import { MeshP2PTransport } from '../src/mesh.js'
import {
  CAP_BACKPRESSURE_V1,
  CAP_CONSUMER_ONLY_V1,
  CAP_FRAGMENTATION_V1,
  CAP_PROVIDER_LEASE_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  PeerHostContractRegistry,
  PeerProtocolLimits,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  WebRtcMeshPeerBridge,
  buildProtocolHello,
  createToolingPeerHostRegistry,
  createWebRtcMeshTransport,
  fragmentMessage,
  type LocalPeerGrantV1,
  type PeerHostCallContext,
  type PeerSessionSnapshot
} from '../src/webrtc/index.js'
import type { AuthenticatedPeerContext } from '../src/peer-host/authority.js'

class FakeSession {
  sent: unknown[] = []
  sendFailure: Error | null = null
  sendFrameGate: ((frame: unknown) => Promise<void> | void) | null = null
  frameListeners = new Set<(frame: unknown) => void>()
  snapshotListeners = new Set<(snapshot: PeerSessionSnapshot) => void>()
  snapshot: PeerSessionSnapshot = {
    state: 'authorized', role: 'answerer', closed: false, failed: false, authorized: true,
    localSignalingId: 'local', remoteSignalingId: 'sig-peer-a', expectedRemoteStableId: 'peer-a', icePath: 'host', reconnectAttempts: 0
  }
  async sendFrame(frame: unknown): Promise<void> {
    if (this.sendFailure) throw this.sendFailure
    if (this.sendFrameGate) await this.sendFrameGate(frame)
    this.sent.push(frame)
  }
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

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await flush()
  return settled
}

function hello(): unknown {
  return buildProtocolHello({
    role: 'provider',
    capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_CONSUMER_ONLY_V1],
    limits: new PeerProtocolLimits()
  })
}

function localGrant(patch: Partial<LocalPeerGrantV1> = {}): LocalPeerGrantV1 {
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
    grantRevision: 1,
    ...patch
  }
}

function authenticatedContext(patch: Partial<AuthenticatedPeerContext> = {}): AuthenticatedPeerContext {
  return {
    selector: {
      tokenId: 'token-1',
      claimantPeerId: 'peer-a',
      verifierPeerId: 'local-peer',
      roomName: 'room-a'
    },
    transport: {
      channelBinding: 'a'.repeat(64),
      claimantSignalingPeerId: 'sig-peer-a',
      verifierSignalingPeerId: 'local'
    },
    credentialRevision: 4,
    authenticatedAtMs: 123,
    ...patch
  }
}

function ackFromSentManifest(session: FakeSession): Record<string, unknown> {
  const manifest = session.sent.find((frame) => (frame as any).type === 'manifest') as Record<string, unknown> | undefined
  if (!manifest) throw new Error('manifest not sent')
  return ackFromManifest(manifest)
}

function ackFromLatestSentManifest(session: FakeSession): Record<string, unknown> {
  const manifest = session.sent.filter((frame) => (frame as any).type === 'manifest').at(-1) as Record<string, unknown> | undefined
  if (!manifest) throw new Error('manifest not sent')
  return ackFromManifest(manifest)
}

function ackFromManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
  return {
    type: 'manifest_ack',
    compatible_services: Array.isArray(manifest.shared_services) && manifest.shared_services.length > 0 ? ['Tooling'] : [],
    incompatible_services: [],
    unused_services: [],
    active_protocol: 'projection-v1',
    active_version: 'v1',
    active_tier: 'projection',
    protocol_revision: 'v1',
    registry_revision: evidence.registry_revision,
    export_policy_revision: evidence.policy_revision,
    auth_grant_revision: evidence.auth_grant_revision,
    projection_digest: evidence.projection_digest,
    services: [
      { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
    ]
  }
}

describe('WebRtcMeshPeerBridge', () => {
  it('answers heartbeat pings before any provider manifest is negotiated', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a' })

    session.emit({ type: 'ping', id: 'heartbeat-1', ts: 123.5 })
    await flush()

    expect(session.sent).toContainEqual({ type: 'pong', id: 'heartbeat-1' })
    bridge.close()
  })

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

  it('resolves manifest waiters only after the manifest ACK frame is sent', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 1000 })
    const manifestPromise = bridge.getManifest('peer-a')
    await flush()
    expect(session.sent.some((frame) => JSON.stringify(frame) === JSON.stringify({ type: 'manifest_request' }))).toBe(true)

    const ackRelease: { current: (() => void) | null } = { current: null }
    session.sendFrameGate = (frame) => {
      if ((frame as any).type !== 'manifest_ack') return
      return new Promise<void>((resolve) => {
        ackRelease.current = resolve
      })
    }

    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer A',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await flush()

    expect(await isSettled(manifestPromise)).toBe(false)
    expect(session.sent.some((frame) => (frame as any).type === 'manifest_ack')).toBe(false)

    const releaseAck = ackRelease.current
    if (!releaseAck) throw new Error('manifest ACK send was not held')
    releaseAck()
    await expect(manifestPromise).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A', authenticated: true })
    expect(session.sent.some((frame) => (frame as any).type === 'manifest_ack')).toBe(true)
  })

  it('does not return a cached manifest while a newer manifest ACK is pending', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 1000 })
    const first = bridge.getManifest('peer-a')
    await flush()
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer A',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await expect(first).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A' })
    await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ nodeName: 'Peer A' })

    const ackRelease: { current: (() => void) | null } = { current: null }
    session.sendFrameGate = (frame) => {
      if ((frame as any).type !== 'manifest_ack') return
      return new Promise<void>((resolve) => {
        ackRelease.current = resolve
      })
    }
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer B',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await flush()

    const second = bridge.getManifest('peer-a')
    expect(await isSettled(second)).toBe(false)

    const releaseAck = ackRelease.current
    if (!releaseAck) throw new Error('manifest ACK send was not held')
    releaseAck()
    await expect(second).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer B' })
  })

  it('does not resolve provider-lease manifest waiters from a stale cache during a newer manifest ACK', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 1000 })
    session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
    const first = bridge.getManifest('peer-a')
    await flush()
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer A',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 1, issued_at_ms: 1000, expires_at_ms: 61_000, available: true })
    await expect(first).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A' })

    const ackRelease: { current: (() => void) | null } = { current: null }
    session.sendFrameGate = (frame) => {
      if ((frame as any).type !== 'manifest_ack') return
      return new Promise<void>((resolve) => {
        ackRelease.current = resolve
      })
    }
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer B',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await flush()

    const second = bridge.getManifest('peer-a')
    session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 2, issued_at_ms: 2000, expires_at_ms: 62_000, available: true })
    await flush()
    expect(await isSettled(second)).toBe(false)

    const releaseAck = ackRelease.current
    if (!releaseAck) throw new Error('manifest ACK send was not held')
    releaseAck()
    await expect(second).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer B' })
  })

  it('does not promote a delayed manifest ACK after an epoch reset and fresh auth', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 1000 })
    const ackRelease: { current: (() => void) | null } = { current: null }
    session.sendFrameGate = (frame) => {
      if ((frame as any).type !== 'manifest_ack') return
      return new Promise<void>((resolve) => {
        ackRelease.current = resolve
      })
    }

    const stale = bridge.getManifest('peer-a')
    await flush()
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Stale Peer',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await flush()
    expect(await isSettled(stale)).toBe(false)

    session.setSnapshot({ state: 'reconnecting', authorized: false })
    await expect(stale).rejects.toThrow('epoch reset')

    const releaseAck = ackRelease.current
    if (!releaseAck) throw new Error('manifest ACK send was not held')
    releaseAck()
    await flush()

    session.sendFrameGate = null
    session.setSnapshot({ state: 'authorized', authorized: true })
    session.emit(hello())
    const fresh = bridge.getManifest('peer-a')
    await flush()
    expect(session.sent.filter((frame) => JSON.stringify(frame) === JSON.stringify({ type: 'manifest_request' }))).toHaveLength(2)
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Fresh Peer',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await expect(fresh).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Fresh Peer' })
  })

  it('defers provider-unavailable manifest waiter settlement until the matching manifest ACK completes', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 1000 })
    session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
    const first = bridge.getManifest('peer-a')
    await flush()
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer A',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 1, issued_at_ms: 1000, expires_at_ms: 61_000, available: true })
    await expect(first).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A' })

    const ackRelease: { current: (() => void) | null } = { current: null }
    session.sendFrameGate = (frame) => {
      if ((frame as any).type !== 'manifest_ack') return
      return new Promise<void>((resolve) => {
        ackRelease.current = resolve
      })
    }
    session.emit({
      type: 'manifest',
      peer_id: 'peer-a',
      node_name: 'Peer B',
      shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
    })
    await flush()

    const unavailable = bridge.getManifest('peer-a')
    session.emit({ type: 'provider_unavailable', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 2, issued_at_ms: 2000, expires_at_ms: 2000, available: false })
    await flush()
    expect(await isSettled(unavailable)).toBe(false)

    const releaseAck = ackRelease.current
    if (!releaseAck) throw new Error('manifest ACK send was not held')
    releaseAck()
    await expect(unavailable).resolves.toBeNull()
    await expect(bridge.getManifest('peer-a')).resolves.toBeNull()
  })

  it('defers provider lease TTL manifest waiter settlement until the matching manifest ACK completes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      const session = new FakeSession()
      const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', timeoutMs: 5000 })
      session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
      const first = bridge.getManifest('peer-a')
      await flush()
      session.emit({
        type: 'manifest',
        peer_id: 'peer-a',
        node_name: 'Peer A',
        shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
      })
      session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 1, issued_at_ms: 1000, expires_at_ms: 2000, available: true })
      await expect(first).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A' })

      const ackRelease: { current: (() => void) | null } = { current: null }
      session.sendFrameGate = (frame) => {
        if ((frame as any).type !== 'manifest_ack') return
        return new Promise<void>((resolve) => {
          ackRelease.current = resolve
        })
      }
      session.emit({
        type: 'manifest',
        peer_id: 'peer-a',
        node_name: 'Peer B',
        shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }]
      })
      await flush()

      const expired = bridge.getManifest('peer-a')
      vi.advanceTimersByTime(1000)
      await flush()
      expect(await isSettled(expired)).toBe(false)

      const releaseAck = ackRelease.current
      if (!releaseAck) throw new Error('manifest ACK send was not held')
      releaseAck()
      await expect(expired).resolves.toBeNull()
      await expect(bridge.getManifest('peer-a')).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
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
    await flush()
    session.emit(ackFromSentManifest(session))
    session.emit({ type: 'call', id: 'host-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush()
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(session.sent.at(-1)).toEqual({ type: 'result', id: 'host-call', result: { count: 0, tools: [] } })
    bridge.close()
  })

  it('forwards authenticated session context to provider calls and ignores forged frame identity', async () => {
    const session = new FakeSession()
    session.setSnapshot({ authenticatedPeerContext: authenticatedContext() })
    const handler = vi.fn(async (_input: unknown, context: PeerHostCallContext) => {
      expect(context.identity.callerPeerId).toBe('peer-a')
      expect(context.identity.effectivePermissions).toEqual(['Tooling.GetTools'])
      expect(context.authenticatedPeerContext?.selector.tokenId).toBe('token-1')
      return { count: 0, tools: [] }
    })
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
      randomId: () => 'epoch-auth'
    })
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_PROVIDER_LEASE_V1] })
    })
    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    session.emit(ackFromSentManifest(session))
    session.emit({
      type: 'call',
      id: 'inbound-authority',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-b', effective_perms: ['*'] }
    })
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(session.sent.at(-1)).toMatchObject({ type: 'result', id: 'inbound-authority' })
    bridge.close()
  })

  it('starts provider epochs once per authority-context key and keeps pre-context calls denied', async () => {
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
      randomId: (() => { let index = 0; return () => `epoch-auth-${++index}` })()
    })
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] })
    })

    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(1)
    session.emit({ type: 'call', id: 'pre-context', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush()
    expect(handler).not.toHaveBeenCalled()
    expect(session.sent.find((frame) => (frame as any).type === 'error' && (frame as any).id === 'pre-context')).toMatchObject({ error: { code: 425 } })

    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(1)

    session.setSnapshot({ authenticatedPeerContext: authenticatedContext() })
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(2)
    expect(session.sent.at(-1)).toMatchObject({ type: 'manifest' })

    session.setSnapshot({ authenticatedPeerContext: authenticatedContext() })
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(2)

    session.setSnapshot({ authenticatedPeerContext: authenticatedContext({ credentialRevision: 5 }) })
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(3)
    expect(session.sent.at(-1)).toMatchObject({ type: 'manifest' })
    bridge.close()
  })

  it('retries authority-context provider epoch start after send failure and deduplicates success', async () => {
    const session = new FakeSession()
    session.setSnapshot({ authenticatedPeerContext: authenticatedContext() })
    const peerHost = {
      attach: vi.fn(),
      startEpoch: vi.fn(async () => ({
        type: 'manifest',
        peer_id: 'local-peer',
        node_name: 'Local',
        shared_services: []
      })),
      handleDisconnect: vi.fn(),
      buildManifest: vi.fn(),
      handleCall: vi.fn(),
      handleSubscribe: vi.fn(),
      markManifestAcknowledged: vi.fn()
    }
    new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost: peerHost as any,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] })
    })

    session.sendFailure = new Error('first manifest send fails')
    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(peerHost.startEpoch).toHaveBeenCalledTimes(1)
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(0)

    session.sendFailure = null
    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(peerHost.startEpoch).toHaveBeenCalledTimes(2)
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(1)

    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(peerHost.startEpoch).toHaveBeenCalledTimes(2)
    expect(session.sent.filter((frame) => (frame as any).type === 'manifest')).toHaveLength(1)
  })

  it('closes provider epoch and clears stale authority when authenticated snapshot assertion fails', async () => {
    const session = new FakeSession()
    session.setSnapshot({ authenticatedPeerContext: authenticatedContext() })
    const handler = vi.fn(async (_input: unknown, context: PeerHostCallContext) => {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { count: 0, tools: [] }
    })
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
      randomId: () => 'epoch-stale'
    })
    new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_PROVIDER_LEASE_V1] })
    })
    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    session.emit(ackFromSentManifest(session))
    session.emit({ type: 'call', id: 'before-stale', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-b', effective_perms: ['*'] } })
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(peerHost.getActiveWorkCount()).toBe(1)

    session.setSnapshot({ authenticatedPeerContext: authenticatedContext({ selector: { ...authenticatedContext().selector, claimantPeerId: 'peer-b' } }) })
    await flush()
    expect(peerHost.getActiveWorkCount()).toBe(0)

    session.emit({ type: 'call', id: 'after-stale-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['*'] } })
    session.emit({ type: 'subscribe', id: 'after-stale-sub', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 10 })
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(session.sent.some((frame) => (frame as any).id === 'after-stale-call')).toBe(false)
    expect(session.sent.some((frame) => (frame as any).id === 'after-stale-sub')).toBe(false)
    expect(session.frameListeners.size).toBe(0)
    expect(session.snapshotListeners.size).toBe(0)
  })

  it('rejects forged or stale manifest ACKs and does not send lease-bearing manifests to older peers', async () => {
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
      randomId: (() => { let i = 0; return () => `epoch-${++i}` })()
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
    await flush()
    await flush()
    expect(session.sent.filter((frame) => ['manifest', 'provider_lease'].includes(String((frame as any).type))).map((frame) => (frame as any).type)).toEqual(['manifest'])
    const ack = ackFromSentManifest(session)
    session.emit({ ...ack, projection_digest: '1'.repeat(64) })
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(0)
    session.emit({ type: 'call', id: 'forged-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush()
    expect(handler).not.toHaveBeenCalled()
    expect(session.sent.find((frame) => (frame as any).type === 'error' && (frame as any).id === 'forged-call')).toMatchObject({ type: 'error', id: 'forged-call', error: { code: 425 } })
    session.emit(ack)
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(1)
    session.emit({ type: 'call', id: 'valid-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush(); await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    bridge.close()

    const oldSession = new FakeSession()
    const oldHost = new WebRtcPeerHost({
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
      randomId: () => 'epoch-old'
    })
    new WebRtcMeshPeerBridge({
      session: oldSession,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost: oldHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] })
    })
    oldSession.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1] }))
    oldSession.emit({ type: 'manifest_request' })
    void oldHost.resume()
    oldHost.renewLease()
    await flush()
    expect(oldSession.sent.some((frame) => ['manifest', 'provider_lease', 'provider_unavailable'].includes((frame as any).type))).toBe(false)
  })

  it('routes provider lifecycle frames through the bridge after ACK gating', async () => {
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: createToolingPeerHostRegistry({
        getTools: async () => ({ count: 0, tools: [] }),
        getExportCatalog: async () => { throw new Error('not implemented') },
        prepareExecution: async () => { throw new Error('not implemented') },
        executeTool: async () => { throw new Error('not implemented') }
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
      clock: (() => { let now = 1000; return () => now += 20_000 })(),
      randomId: (() => { let i = 0; return () => `epoch-${++i}` })()
    })
    const session = new FakeSession()
    new WebRtcMeshPeerBridge({
      session,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] })
    })

    session.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    expect(session.sent.map((frame) => (frame as any).type)).toEqual(['manifest'])

    session.emit(ackFromLatestSentManifest(session))
    await flush()
    expect(session.sent.map((frame) => (frame as any).type)).toEqual(['manifest', 'provider_lease'])

    await peerHost.renewLocalProvider()
    expect(session.sent.map((frame) => (frame as any).type)).toEqual(['manifest', 'provider_lease', 'provider_lease'])

    await peerHost.suspendLocalProvider('page_hidden')
    expect(session.sent.at(-1)).toMatchObject({ type: 'provider_unavailable', reason_code: 'page_hidden' })

    await peerHost.resumeLocalProvider()
    expect(session.sent.at(-1)).toMatchObject({ type: 'manifest' })
    expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(2)

    session.emit(ackFromLatestSentManifest(session))
    await flush()
    expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(3)
  })

  it('renews local provider leases automatically, pauses during reconnect, and stops after close', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const peerHost = new WebRtcPeerHost({
        localPeerId: 'local-peer',
        nodeName: 'Local',
        registry: createToolingPeerHostRegistry({
          getTools: async () => ({ count: 0, tools: [] }),
          getExportCatalog: async () => { throw new Error('not implemented') },
          prepareExecution: async () => { throw new Error('not implemented') },
          executeTool: async () => { throw new Error('not implemented') }
        }),
        authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
        clock: () => Date.now(),
        randomId: (() => { let epoch = 0; return () => `epoch-${++epoch}` })()
      })
      const session = new FakeSession()
      const bridge = new WebRtcMeshPeerBridge({
        session,
        remotePeerId: 'peer-a',
        localPeerRole: 'hybrid',
        peerHost,
        localProtocolHello: buildProtocolHello({
          role: 'hybrid',
          capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1]
        })
      })

      session.emit(buildProtocolHello({
        role: 'hybrid',
        capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1]
      }))
      await flush()
      session.emit(ackFromLatestSentManifest(session))
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(peerHost.lease.renewMs)
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(2)

      session.setSnapshot({ state: 'reconnecting', authorized: false })
      await vi.advanceTimersByTimeAsync(peerHost.lease.renewMs * 2)
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(2)

      session.setSnapshot({ state: 'authorized', authorized: true, failed: false })
      session.emit(buildProtocolHello({
        role: 'hybrid',
        capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1]
      }))
      await flush()
      session.emit(ackFromLatestSentManifest(session))
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(3)

      await vi.advanceTimersByTimeAsync(peerHost.lease.renewMs)
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(4)

      bridge.close()
      await vi.advanceTimersByTimeAsync(peerHost.lease.renewMs * 2)
      await flush()
      expect(session.sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires a fresh lease after each negotiated provider manifest generation', async () => {
    const session = new FakeSession()
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'manifest-generation' })
    session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))

    const manifestA = { type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] }
    const manifestB = { ...manifestA, node_name: 'Peer B' }
    const leaseA = { type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-a', availability_revision: 1, issued_at_ms: 1000, expires_at_ms: 61_000, available: true }
    const leaseB = { ...leaseA, availability_revision: 2, issued_at_ms: 21_000, expires_at_ms: 81_000 }
    const staleTombstoneA = { ...leaseA, type: 'provider_unavailable', available: false, reason_code: 'stale' }
    const tombstoneB = { ...leaseB, type: 'provider_unavailable', availability_revision: 3, available: false, reason_code: 'current' }

    const first = bridge.getManifest('peer-a')
    await flush()
    session.emit(manifestA)
    await flush()
    session.emit(leaseA)
    await expect(first).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer A' })
    await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ nodeName: 'Peer A' })

    session.emit(manifestB)
    await flush()
    const second = bridge.getManifest('peer-a')
    let settled = false
    second.finally(() => { settled = true }).catch(() => undefined)
    await flush()
    expect(settled).toBe(false)

    session.emit(leaseA)
    session.emit(staleTombstoneA)
    await flush()
    expect(settled).toBe(false)

    session.emit(leaseB)
    await expect(second).resolves.toMatchObject({ peerId: 'peer-a', nodeName: 'Peer B' })
    await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ nodeName: 'Peer B' })

    session.emit(staleTombstoneA)
    await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ nodeName: 'Peer B' })

    session.emit(tombstoneB)
    await expect(bridge.getManifest('peer-a')).resolves.toBeNull()
  })

  it('expires consumer provider leases by TTL, re-arms renewal, and tombstones manifest routes', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      const session = new FakeSession()
      const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'manifest-lease' })
      session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
      const manifestPromise = bridge.getManifest('peer-a')
      await flush()
      session.emit({ type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] })
      await flush()
      let settled = false
      manifestPromise.finally(() => { settled = true }).catch(() => undefined)
      await flush()
      expect(settled).toBe(false)
      session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 1, issued_at_ms: 1000, expires_at_ms: 61_000, available: true })
      await expect(manifestPromise).resolves.toMatchObject({ peerId: 'peer-a' })
      vi.advanceTimersByTime(20_000)
      session.emit({ type: 'provider_lease', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 2, issued_at_ms: 21_000, expires_at_ms: 81_000, available: true })
      vi.advanceTimersByTime(59_999)
      await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ peerId: 'peer-a' })
      vi.advanceTimersByTime(1)
      await expect(bridge.getManifest('peer-a')).resolves.toBeNull()

      const tombstoneSession = new FakeSession()
      const tombstoneBridge = new WebRtcMeshPeerBridge({ session: tombstoneSession, remotePeerId: 'peer-a', randomId: () => 'manifest-tombstone' })
      tombstoneSession.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
      const manifestAgain = tombstoneBridge.getManifest('peer-a')
      await flush()
      tombstoneSession.emit({ type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] })
      tombstoneSession.emit({ type: 'provider_unavailable', peer_id: 'peer-a', connection_epoch: 'epoch-1', availability_revision: 3, issued_at_ms: 81_000, expires_at_ms: 81_000, available: false })
      await expect(manifestAgain).resolves.toBeNull()
      await expect(tombstoneBridge.getManifest('peer-a')).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps consumer availability active for real peer-host renewals until TTL and clears tombstones immediately', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      const host = new WebRtcPeerHost({
        localPeerId: 'peer-a',
        nodeName: 'Peer A',
        registry: createToolingPeerHostRegistry({
          getTools: async () => ({ count: 0, tools: [] }),
          getExportCatalog: async () => { throw new Error('not implemented') },
          prepareExecution: async () => { throw new Error('not implemented') },
          executeTool: async () => { throw new Error('not implemented') }
        }),
        authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
        clock: () => Date.now(),
        randomId: () => 'epoch-real'
      })
      const session = new FakeSession()
      const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a', randomId: () => 'real-lease' })
      session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1, CAP_PROVIDER_LEASE_V1] }))
      const manifestPromise = bridge.getManifest('peer-a')
      await flush()
      session.emit({ type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] })

      const renewal = host.renewLease()
      expect(renewal).toMatchObject({ type: 'provider_lease', available: true })
      session.emit(renewal)
      await expect(manifestPromise).resolves.toMatchObject({ peerId: 'peer-a' })
      vi.advanceTimersByTime(59_999)
      await expect(bridge.getManifest('peer-a')).resolves.toMatchObject({ peerId: 'peer-a' })
      vi.advanceTimersByTime(1)
      await expect(bridge.getManifest('peer-a')).resolves.toBeNull()

      const tombstoneSession = new FakeSession()
      const tombstoneBridge = new WebRtcMeshPeerBridge({ session: tombstoneSession, remotePeerId: 'peer-a', randomId: () => 'real-tombstone' })
      tombstoneSession.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_BACKPRESSURE_V1, CAP_PROVIDER_LEASE_V1] }))
      const tombstoneManifest = tombstoneBridge.getManifest('peer-a')
      await flush()
      tombstoneSession.emit({ type: 'manifest', peer_id: 'peer-a', node_name: 'Peer A', shared_services: [{ module: 'gateway', methods: ['Gateway.GetRegistry'], capabilities: [] }] })
      const tombstone = host.suspend('manual_pause')
      expect(tombstone).toMatchObject({ type: 'provider_unavailable', available: false, reason_code: 'manual_pause' })
      tombstoneSession.emit(tombstone)
      await expect(tombstoneManifest).resolves.toBeNull()
      await expect(tombstoneBridge.getManifest('peer-a')).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds async inbound dispatch rejections and keeps handler errors redacted', async () => {
    const sendFailure = new Error('send failed: raw socket secret')
    const session = new FakeSession()
    session.sendFailure = sendFailure
    const bridge = new WebRtcMeshPeerBridge({ session, remotePeerId: 'peer-a' })
    session.emit({ type: 'call', id: 'send-call', method: 'Tooling.GetTools', params: {} })
    session.emit({ type: 'subscribe', id: 'send-sub', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 10 })
    await flush()
    expect(bridge.getDiagnostics()).toMatchObject({
      asyncDispatchFailureCount: 2,
      lastAsyncDispatchFailure: { operation: 'inbound_subscribe', reason: 'send_failed' }
    })
    expect(JSON.stringify(bridge.getDiagnostics())).not.toContain('raw socket secret')

    const manifestSession = new FakeSession()
    const manifestHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: createToolingPeerHostRegistry({
        getTools: async () => ({ count: 0, tools: [] }),
        getExportCatalog: async () => { throw new Error('not implemented') },
        prepareExecution: async () => { throw new Error('not implemented') },
        executeTool: async () => { throw new Error('not implemented') }
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
      clock: () => 1000,
      randomId: () => 'epoch-manifest-reject'
    })
    const manifestBridge = new WebRtcMeshPeerBridge({
      session: manifestSession,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost: manifestHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] })
    })
    manifestSession.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    manifestSession.sent = []
    manifestSession.sendFailure = sendFailure
    manifestSession.emit({ type: 'manifest_request' })
    await flush()
    await flush()
    expect(manifestBridge.getDiagnostics()).toMatchObject({
      asyncDispatchFailureCount: 1,
      lastAsyncDispatchFailure: { operation: 'manifest_response', reason: 'send_failed' }
    })
    expect(JSON.stringify(manifestBridge.getDiagnostics())).not.toContain('raw socket secret')

    const rawHandler = new Error('raw handler secret should stay local')
    const providerSession = new FakeSession()
    const providerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: createToolingPeerHostRegistry({
        getTools: async () => { throw rawHandler },
        getExportCatalog: async () => { throw new Error('not implemented') },
        prepareExecution: async () => { throw new Error('not implemented') },
        executeTool: async () => { throw new Error('not implemented') }
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([localGrant()]),
      clock: () => 1000,
      randomId: () => 'redacted-ref'
    })
    new WebRtcMeshPeerBridge({
      session: providerSession,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost: providerHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] })
    })
    providerSession.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    providerSession.emit(ackFromSentManifest(providerSession))
    providerSession.emit({ type: 'call', id: 'raw-error-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } })
    await flush(); await flush()
    const errorFrame = providerSession.sent.find((frame) => (frame as any).type === 'error' && (frame as any).id === 'raw-error-call')
    expect(errorFrame).toMatchObject({ error: { code: 500, message: 'handler failed', reason_code: 'handler_failed', error_ref: 'redacted-ref' } })
    expect(JSON.stringify(errorFrame)).not.toContain('raw handler secret')

    const subscriptionRegistry = new PeerHostContractRegistry().register({
      methodId: 'Tooling.ProjectionInvalidated',
      methodType: 'unary',
      inputSchemaId: 'Tooling.ProjectionInvalidated.input',
      outputSchemaId: 'Tooling.ProjectionInvalidated.output',
      inputSchema: z.any(),
      outputSchema: z.any(),
      requiredPermissions: [],
      handler: async () => ({ ok: true })
    }).registerEvent({
      topic: 'Tooling.ProjectionInvalidated',
      outputSchemaId: 'Tooling.ProjectionInvalidated.output',
      outputSchema: z.object({ ok: z.boolean() }),
      requiredPermissions: [],
      handler: async () => { throw new Error('raw subscription secret should stay local') }
    })
    const subscriptionSession = new FakeSession()
    const subscriptionHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: subscriptionRegistry,
      authorizationStore: new SessionPeerHostAuthorizationStore([localGrant({ allowedMethodIds: ['Tooling.ProjectionInvalidated'] })]),
      clock: () => 1000,
      randomId: () => 'sub-ref'
    })
    new WebRtcMeshPeerBridge({
      session: subscriptionSession,
      remotePeerId: 'peer-a',
      localPeerRole: 'hybrid',
      peerHost: subscriptionHost,
      localProtocolHello: buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] })
    })
    subscriptionSession.emit(buildProtocolHello({ role: 'hybrid', capabilities: [CAP_FRAGMENTATION_V1, CAP_PROVIDER_LEASE_V1] }))
    await flush()
    subscriptionSession.emit(ackFromSentManifest(subscriptionSession))
    subscriptionSession.emit({ type: 'subscribe', id: 'raw-subscribe', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 10 })
    await flush(); await flush()
    const rejected = subscriptionSession.sent.find((frame) => (frame as any).type === 'subscribe_rejected' && (frame as any).id === 'raw-subscribe')
    expect(rejected).toMatchObject({ reason: 'handler_failed' })
    expect(JSON.stringify(rejected)).not.toContain('raw subscription secret')
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
