import { describe, expect, it } from 'vitest'

import { AuroraClient, MeshP2PTransport } from '../src/index.js'
import type { AuroraEvent } from '../src/types.js'
import {
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  PeerProtocolLimits,
  WebRtcMeshPeerBridge,
  buildProtocolHello,
  type PeerSessionSnapshot
} from '../src/webrtc/index.js'

type FrameListener = (frame: unknown) => void

type SentFrame = Record<string, unknown>

class FakeAuthorizedSession {
  sent: SentFrame[] = []
  frameListeners = new Set<FrameListener>()
  snapshotListeners = new Set<(snapshot: PeerSessionSnapshot) => void>()
  snapshot: PeerSessionSnapshot = {
    state: 'authorized',
    role: 'offerer',
    closed: false,
    failed: false,
    authorized: true,
    localSignalingId: 'sig-local',
    remoteSignalingId: 'sig-remote',
    expectedRemoteStableId: 'peer-remote',
    icePath: 'relay',
    reconnectAttempts: 0
  }

  async sendFrame(frame: unknown): Promise<void> {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) throw new Error('expected object frame')
    this.sent.push(frame as SentFrame)
  }

  subscribeFrames(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  subscribe(listener: (snapshot: PeerSessionSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    listener(this.snapshot)
    return () => this.snapshotListeners.delete(listener)
  }

  getSnapshot(): PeerSessionSnapshot {
    return this.snapshot
  }

  emit(frame: unknown): void {
    for (const listener of [...this.frameListeners]) listener(frame)
  }

  closeAsTransportLoss(): void {
    this.snapshot = { ...this.snapshot, state: 'failed', failed: true, authorized: false }
    for (const listener of [...this.snapshotListeners]) listener(this.snapshot)
  }
}

function makeClient(ids: string[]) {
  const session = new FakeAuthorizedSession()
  const bridge = new WebRtcMeshPeerBridge({
    session,
    remotePeerId: 'peer-remote',
    randomId: () => {
      const next = ids.shift()
      if (!next) throw new Error('test ran out of deterministic ids')
      return next
    },
    timeoutMs: 1_000
  })
  const transport = new MeshP2PTransport({ bridge, defaultPeerId: 'peer-remote' })
  session.emit(buildProtocolHello({ role: 'provider', capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1], limits: new PeerProtocolLimits() }))
  const client = new AuroraClient({ transport, defaultTimeoutMs: 1_000 })
  return { session, bridge, transport, client }
}

async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForSentCount(session: FakeAuthorizedSession, count: number): Promise<void> {
  const deadline = Date.now() + 250
  while (session.sent.length < count) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} sent frames`)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('WebRtcMeshPeerBridge with MeshP2PTransport and AuroraClient', () => {
  it('preserves requestResult peer/audit normalization over WebRTC bridge calls', async () => {
    const { session, client } = makeClient(['call-1'])

    const resultPromise = client.requestResult<{ ok: true }, { include_internal: false }>(
      'Gateway.GetRegistry',
      { include_internal: false },
      { busTopic: 'Gateway.GetRegistry' }
    )
    await tick()

    expect(session.sent).toEqual([
      {
        type: 'call',
        id: 'call-1',
        correlation_id: 'call-1',
        method: 'Gateway.GetRegistry',
        params: { include_internal: false },
        identity: { principal_id: null, effective_perms: null, source: null, method_type: null, caller_peer_id: null, auth_grant_revision: null, manifest_revision: null }
      }
    ])

    session.emit({ type: 'result', id: 'call-1', result: { ok: true } })
    const result = await resultPromise

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.data).toEqual({ ok: true })
    expect(result.audit).toEqual(expect.objectContaining({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry',
      transport: 'mesh',
      targetPeerId: 'peer-remote',
      peerId: 'peer-remote',
      status: '200'
    }))
  })

  it('normalizes remote errors through AuroraClient requestResult', async () => {
    const { session, client } = makeClient(['call-auth'])

    const resultPromise = client.requestResult('Gateway.GetRegistry', {}, { busTopic: 'Gateway.GetRegistry' })
    await tick()
    session.emit({
      type: 'error',
      id: 'call-auth',
      correlation_id: 'call-auth',
      error: { code: 401, message: 'Authentication required' }
    })
    const result = await resultPromise

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error result')
    expect(result.error.code).toBe('auth')
    expect(result.audit).toEqual(expect.objectContaining({
      method: 'Gateway.GetRegistry',
      busTopic: 'Gateway.GetRegistry',
      transport: 'mesh',
      status: 'auth'
    }))
  })

  it('opens exact scoped assistant subscription before request and isolates topic/correlation events', async () => {
    const { session, client } = makeClient(['sub-1', 'call-1'])
    const subscription = client.events.streamAssistant<Record<string, unknown>, Record<string, unknown>>(
      { text: 'hello', correlation_id: 'corr-1' },
      { correlationId: 'corr-1', reconnect: false }
    )
    const iterator = subscription[Symbol.asyncIterator]()
    const firstEvent = iterator.next()
    await tick()

    expect(session.sent[0]).toEqual({
      type: 'subscribe',
      id: 'sub-1',
      topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      correlation_ids: ['corr-1'],
      ttl_seconds: 60
    })

    session.emit({
      type: 'subscribed',
      id: 'sub-1',
      subscription_id: 'sub-1',
      accepted: true,
      accepted_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      rejected_topics: [],
      correlation_ids: ['corr-1'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await tick()

    const requestPromise = client.requestResult('Orchestrator.ExternalUserInput', { text: 'hello', correlation_id: 'corr-1' }, { busTopic: 'Orchestrator.ExternalUserInput' })
    await tick()
    expect(session.sent[1]).toEqual(expect.objectContaining({
      type: 'call',
      id: 'corr-1',
      method: 'Orchestrator.ExternalUserInput',
      correlation_id: 'corr-1',
      params: { text: 'hello', correlation_id: 'corr-1' },
      identity: { principal_id: null, effective_perms: null, source: null, method_type: null, caller_peer_id: null, auth_grant_revision: null, manifest_revision: null }
    }))

    session.emit({ type: 'event', topic: 'TTS.AudioChunk', correlation_id: 'wrong', params: { marker: 'wrong-corr' } })
    session.emit({ type: 'event', topic: 'Config.Updated', correlation_id: 'corr-1', params: { marker: 'wrong-topic' } })
    await tick()

    session.emit({ type: 'event', topic: 'Orchestrator.Response', correlation_id: 'corr-1', params: { text: 'delta' } })
    const yielded = await firstEvent
    expect(yielded.done).toBe(false)
    const event = yielded.value as AuroraEvent<Record<string, unknown>>
    expect(event.kind).toBe('Orchestrator.Response')
    expect(event.topic).toBe('Orchestrator.Response')
    expect(event.payload).toEqual({ text: 'delta' })
    expect(event.audit).toEqual(expect.objectContaining({ targetPeerId: 'peer-remote', transport: 'mesh' }))

    await iterator.return?.()
    await tick()
    expect(session.sent.at(-1)).toEqual({ type: 'unsubscribe', id: 'sub-1' })

    session.emit({ type: 'result', id: 'corr-1', result: { accepted: true } })
    const response = await requestPromise
    expect(response.ok).toBe(true)
  })


  it('streams assistant updates over mesh and reports transport_lost after partial event without fallback', async () => {
    const { session, client } = makeClient(['sub-stream', 'call-stream'])
    const iterator = client.assistant.streamMessage({
      text: 'hello',
      requestId: 'corr-stream',
      timeoutMs: 5_000,
      clientTtsPlayback: true
    })[Symbol.asyncIterator]()
    const first = iterator.next()
    await tick()

    expect(session.sent[0]).toEqual({
      type: 'subscribe',
      id: 'sub-stream',
      topics: ['Orchestrator.Response'],
      correlation_ids: ['corr-stream'],
      ttl_seconds: 60
    })
    expect(session.sent).toHaveLength(1)
    session.emit({
      type: 'subscribed',
      id: 'sub-stream',
      subscription_id: 'sub-stream',
      accepted: true,
      accepted_topics: ['Orchestrator.Response'],
      rejected_topics: [],
      correlation_ids: ['corr-stream'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await waitForSentCount(session, 2)
    expect(session.sent[1]).toMatchObject({
      type: 'call',
      id: 'corr-stream',
      correlation_id: 'corr-stream',
      method: 'Orchestrator.ExternalUserInput',
      params: expect.objectContaining({ client_tts_playback: false })
    })

    session.emit({ type: 'event', topic: 'Orchestrator.Response', correlation_id: 'corr-stream', params: { kind: 'assistant.delta', delta: 'hel', request_id: 'corr-stream', session_id: 'corr-stream' } })
    await expect(first).resolves.toMatchObject({ value: { kind: 'delta', textDelta: 'hel' }, done: false })

    const second = iterator.next()
    session.closeAsTransportLoss()
    await expect(second).resolves.toMatchObject({ value: { kind: 'transport_lost' }, done: false })
  })

  it('requests optional assistant audio only when the authenticated session grants TTS use', async () => {
    const { session, client } = makeClient(['sub-audio', 'call-audio'])
    client.auth.setUser({
      principalId: 'principal-a',
      permissions: ['Orchestrator.use', 'TTS.use'],
      effectivePermissions: ['Orchestrator.use', 'TTS.use']
    })
    const iterator = client.assistant.streamMessage({
      text: 'hello with audio',
      requestId: 'corr-audio',
      timeoutMs: 5_000,
      clientTtsPlayback: true
    })[Symbol.asyncIterator]()
    const first = iterator.next()
    await tick()

    expect(session.sent[0]).toEqual({
      type: 'subscribe',
      id: 'sub-audio',
      topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      correlation_ids: ['corr-audio'],
      ttl_seconds: 60
    })
    session.emit({
      type: 'subscribed',
      id: 'sub-audio',
      subscription_id: 'sub-audio',
      accepted: true,
      accepted_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      rejected_topics: [],
      correlation_ids: ['corr-audio'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await waitForSentCount(session, 2)
    expect(session.sent[1]).toMatchObject({
      type: 'call',
      id: 'corr-audio',
      params: expect.objectContaining({ client_tts_playback: true })
    })
    session.emit({
      type: 'event',
      topic: 'Orchestrator.Response',
      correlation_id: 'corr-audio',
      params: { kind: 'assistant.completed', text: 'done', request_id: 'corr-audio' }
    })
    await expect(first).resolves.toMatchObject({ value: { kind: 'completed', text: 'done' } })
    await iterator.return?.()
  })

  it('carries browser-captured STT and client-playback TTS requests over the authorized DataChannel', async () => {
    const { session, client } = makeClient(['stt-call', 'tts-call'])

    const transcriptionPromise = client.assistant.transcribeVoiceAudio({
      audio_data: 'AAAA',
      format: 'raw',
      sample_rate: 16_000,
      channels: 1,
      model: 'accurate',
      routePolicy: {
        peerId: 'downstream-stt-peer',
        providerId: 'remote:downstream-stt-peer:Transcription',
        routeState: 'available-remote',
      },
      mesh_selector: { peer_id: 'legacy-downstream-stt-peer' },
      selector: { peer_id: 'legacy-downstream-stt-peer' },
    })
    await waitForSentCount(session, 1)
    expect(session.sent[0]).toMatchObject({
      type: 'call',
      id: 'stt-call',
      method: 'Transcription.Transcribe',
      params: {
        audio_data: 'AAAA',
        format: 'raw',
        sample_rate: 16_000,
        channels: 1,
        model: 'accurate'
      }
    })
    expect(JSON.stringify(session.sent[0])).not.toContain('downstream-stt-peer')
    expect(JSON.stringify(session.sent[0])).not.toContain('mesh_selector')
    session.emit({
      type: 'result',
      id: 'stt-call',
      result: {
        text: 'hello',
        confidence: null,
        language: 'en',
        duration_ms: 120,
        model_used: 'accurate'
      }
    })
    await expect(transcriptionPromise).resolves.toMatchObject({ ok: true, data: { text: 'hello' } })

    const synthesisPromise = client.assistant.synthesizeReadAloud({
      text: 'hello',
      routePolicy: {
        peerId: 'downstream-tts-peer',
        providerId: 'remote:downstream-tts-peer:TTS',
        routeState: 'available-remote',
      },
    })
    await waitForSentCount(session, 2)
    expect(session.sent[1]).toMatchObject({
      type: 'call',
      id: 'tts-call',
      method: 'TTS.Synthesize',
      params: {
        text: 'hello',
        voice: null,
        speed: 1,
        format: 'wav'
      }
    })
    expect(JSON.stringify(session.sent[1])).not.toContain('downstream-tts-peer')
    expect(JSON.stringify(session.sent[1])).not.toContain('mesh_selector')
    session.emit({
      type: 'result',
      id: 'tts-call',
      result: {
        audio_data: 'UklGRg==',
        format: 'wav',
        sample_rate: 22_050,
        channels: 1,
        duration_ms: 240,
        text: 'hello'
      }
    })
    await expect(synthesisPromise).resolves.toMatchObject({
      ok: true,
      data: { audio_data: 'UklGRg==', format: 'wav' }
    })
  })


})
