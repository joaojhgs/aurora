import { describe, expect, it } from 'vitest'
import { allowMethods } from './helpers/authority-doubles.js'

import { AuroraClient, MeshP2PTransport } from '../src/index.js'
import type { AuroraEvent } from '../src/types.js'
import {
  CAP_FRAGMENTATION_V1,
  CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1,
  PeerHostContractRegistry,
  PeerProtocolLimits,
  WebRtcMeshPeerBridge,
  WebRtcPeerHost,
  buildProtocolHello,
  generatedPeerHostEventDescriptor,
  generatedPeerHostMethodDescriptor,
  type GeneratedPeerHostEventHandler,
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

function compatibleManifestAck(manifest: Record<string, unknown>): Record<string, unknown> {
  const services = (manifest.shared_services as Array<Record<string, unknown>>)
    .map((service) => String(service.module))
    .sort()
  const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
  return {
    type: 'manifest_ack',
    compatible_services: services,
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
    services: services.map((serviceId) => ({
      service_id: serviceId,
      service_label: '',
      status: 'compatible',
      reason_codes: [],
      reason: ''
    }))
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

  it('normalizes raw WebRTC TTS.AudioChunk topics and drains assistant audio through the final chunk', async () => {
    const { session, client } = makeClient(['sub-live-audio', 'call-live-audio'])
    client.auth.setUser({
      principalId: 'principal-a',
      permissions: ['Orchestrator.use', 'TTS.use'],
      effectivePermissions: ['Orchestrator.use', 'TTS.use']
    })
    const iterator = client.assistant.streamMessage({
      text: 'speak over webrtc',
      requestId: 'corr-live-audio',
      timeoutMs: 5_000,
      clientTtsPlayback: true
    })[Symbol.asyncIterator]()
    const completed = iterator.next()
    await tick()

    session.emit({
      type: 'subscribed',
      id: 'sub-live-audio',
      subscription_id: 'sub-live-audio',
      accepted: true,
      accepted_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      rejected_topics: [],
      correlation_ids: ['corr-live-audio'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await waitForSentCount(session, 2)
    session.emit({
      type: 'result',
      id: 'corr-live-audio',
      result: {
        text: 'Spoken response',
        request_id: 'corr-live-audio',
        correlation_id: 'corr-live-audio',
        metadata: { tts_status: 'streaming', tts_stream_id: 'tts-corr-live-audio' }
      }
    })
    session.emit({
      type: 'event',
      topic: 'Orchestrator.Response',
      correlation_id: 'corr-live-audio',
      params: {
        kind: 'assistant.completed',
        text: 'Spoken response',
        request_id: 'corr-live-audio',
        metadata: { tts_status: 'streaming', tts_stream_id: 'tts-corr-live-audio' }
      }
    })
    await expect(completed).resolves.toMatchObject({
      done: false,
      value: { kind: 'completed', text: 'Spoken response', textDelta: '' }
    })

    const audio = iterator.next()
    session.emit({
      type: 'event',
      topic: 'TTS.AudioChunk',
      correlation_id: 'corr-live-audio',
      params: {
        stream_id: 'tts-corr-live-audio',
        sequence: 0,
        audio_data: 'UklGRg==',
        format: 'wav',
        sample_rate: 22_050,
        channels: 1,
        duration_ms: 120,
        text: 'Spoken response',
        is_final: false
      }
    })
    await expect(audio).resolves.toMatchObject({
      done: false,
      value: {
        kind: 'tts_audio_chunk',
        textDelta: '',
        ttsAudio: { audioData: 'UklGRg==', encoding: 'wav', final: false }
      }
    })

    const finalAudio = iterator.next()
    session.emit({
      type: 'event',
      topic: 'TTS.AudioChunk',
      correlation_id: 'corr-live-audio',
      params: {
        stream_id: 'tts-corr-live-audio',
        sequence: 1,
        audio_data: '',
        format: 'wav',
        sample_rate: 22_050,
        channels: 1,
        duration_ms: 0,
        is_final: true
      }
    })
    await expect(finalAudio).resolves.toMatchObject({
      done: false,
      value: { kind: 'tts_audio_chunk', ttsAudio: { final: true } }
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('reassembles fragmented generated TTS events into one consumer audio chunk', async () => {
    const fragmentLimits = new PeerProtocolLimits({
      fragmentPayloadBytes: 1024,
      maxLogicalBytes: 128 * 1024,
      maxPeerAggregateBytes: 128 * 1024,
      incompleteTtlSeconds: 30,
      maxFragments: 256
    })
    const { session: consumerSession, bridge: consumerBridge, client } = makeClient(['sub-fragmented-audio'])
    consumerSession.emit(buildProtocolHello({
      role: 'provider',
      capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1],
      limits: fragmentLimits
    }))
    const consumerStream = client.events.streamAssistant<Record<string, unknown>, Record<string, unknown>>(
      { correlation_id: 'corr-fragmented-audio' },
      { correlationId: 'corr-fragmented-audio', reconnect: false }
    )
    const consumerIterator = consumerStream[Symbol.asyncIterator]()
    const nextAudio = consumerIterator.next()
    await waitForSentCount(consumerSession, 1)
    expect(consumerSession.sent[0]).toMatchObject({
      type: 'subscribe',
      id: 'sub-fragmented-audio'
    })
    consumerSession.emit({
      type: 'subscribed',
      id: 'sub-fragmented-audio',
      subscription_id: 'sub-fragmented-audio',
      accepted: true,
      accepted_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      rejected_topics: [],
      correlation_ids: ['corr-fragmented-audio'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await consumerStream.ready

    let providerContext: Parameters<GeneratedPeerHostEventHandler<'TTS.AudioChunk'>>[0] | undefined
    const providerRegistry = new PeerHostContractRegistry()
      .register(generatedPeerHostMethodDescriptor('TTS.Synthesize', async () => ({
        audio_data: '',
        channels: 1,
        duration_ms: 0,
        format: 'wav',
        sample_rate: 24_000,
        text: ''
      })))
      .registerEvent(generatedPeerHostEventDescriptor('TTS.AudioChunk', (context) => {
        providerContext = context
      }))
    const providerAuthority = allowMethods({
      claimantPeerId: 'peer-remote',
      methodIds: ['TTS.Synthesize', 'TTS.AudioChunk']
    })
    const providerHost = new WebRtcPeerHost({
      localPeerId: 'local-provider',
      nodeName: 'Provider',
      registry: providerRegistry,
      authorizationStore: providerAuthority,
      clock: () => 1000,
      randomId: () => 'provider-epoch'
    })
    const providerSession = new FakeAuthorizedSession()
    const providerBridge = new WebRtcMeshPeerBridge({
      session: providerSession,
      remotePeerId: 'peer-remote',
      localPeerRole: 'provider',
      peerHost: providerHost,
      fragmentationThresholdBytes: 256,
      randomId: () => 'fragmented-audio-message'
    })
    providerSession.emit(buildProtocolHello({
      role: 'consumer',
      capabilities: [CAP_FRAGMENTATION_V1, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1],
      limits: fragmentLimits
    }))
    const manifest = await providerHost.startEpoch('peer-remote')
    expect(providerHost.markManifestAcknowledged(compatibleManifestAck(manifest))).toBe(true)
    await providerHost.handleSubscribe({
      type: 'subscribe',
      id: 'provider-fragmented-audio',
      topics: ['TTS.AudioChunk'],
      correlation_ids: ['corr-fragmented-audio'],
      ttl_seconds: 60
    }, 'peer-remote')
    expect(providerContext).toBeDefined()
    providerSession.sent = []

    const audioData = Buffer.from('a'.repeat(4096), 'utf8').toString('base64')
    const context = providerContext as Parameters<GeneratedPeerHostEventHandler<'TTS.AudioChunk'>>[0]
    expect(await context.emit({
      stream_id: 'fragmented-stream',
      sequence: 0,
      audio_data: audioData,
      format: 'pcm_s16le',
      sample_rate: 24_000,
      channels: 1,
      duration_ms: 85,
      text: 'fragmented speech',
      source_sequence: 0,
      is_final: false,
      reason: null,
      correlation_id: 'corr-fragmented-audio'
    })).toBe(true)

    expect(providerSession.sent.length).toBeGreaterThan(1)
    expect(providerSession.sent.every((frame) => frame.type === 'fragment')).toBe(true)
    for (const fragment of providerSession.sent) consumerSession.emit(fragment)
    expect(consumerBridge.getDiagnostics().receivedFragmentCount).toBe(providerSession.sent.length)

    await expect(nextAudio).resolves.toMatchObject({
      done: false,
      value: {
        kind: 'tts.audio_chunk',
        topic: 'TTS.AudioChunk',
        payload: {
          stream_id: 'fragmented-stream',
          sequence: 0,
          audio_data: audioData,
          correlation_id: 'corr-fragmented-audio'
        }
      }
    })

    await consumerIterator.return?.()
    await providerHost.handleUnsubscribe('provider-fragmented-audio')
    consumerBridge.close()
    providerBridge.close()
  })

  it('closes a streaming TTS response when its final audio arrives before assistant completion', async () => {
    const { session, client } = makeClient(['sub-early-final-audio', 'call-early-final-audio'])
    client.auth.setUser({
      principalId: 'principal-a',
      permissions: ['Orchestrator.use', 'TTS.use'],
      effectivePermissions: ['Orchestrator.use', 'TTS.use']
    })
    const iterator = client.assistant.streamMessage({
      text: 'speak with early final audio',
      requestId: 'corr-early-final-audio',
      timeoutMs: 5_000,
      clientTtsPlayback: true
    })[Symbol.asyncIterator]()
    const finalAudio = iterator.next()
    await tick()

    session.emit({
      type: 'subscribed',
      id: 'sub-early-final-audio',
      subscription_id: 'sub-early-final-audio',
      accepted: true,
      accepted_topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
      rejected_topics: [],
      correlation_ids: ['corr-early-final-audio'],
      ttl_seconds: 60,
      reason: null,
      idempotent: false
    })
    await waitForSentCount(session, 2)
    session.emit({
      type: 'event',
      topic: 'TTS.AudioChunk',
      correlation_id: 'corr-early-final-audio',
      params: {
        stream_id: 'tts-corr-early-final-audio',
        sequence: 1,
        audio_data: '',
        format: 'wav',
        sample_rate: 22_050,
        channels: 1,
        duration_ms: 0,
        is_final: true
      }
    })
    await expect(finalAudio).resolves.toMatchObject({
      done: false,
      value: { kind: 'tts_audio_chunk', ttsAudio: { final: true } }
    })

    const completed = iterator.next()
    session.emit({
      type: 'event',
      topic: 'Orchestrator.Response',
      correlation_id: 'corr-early-final-audio',
      params: {
        kind: 'assistant.completed',
        text: 'Spoken response',
        request_id: 'corr-early-final-audio',
        metadata: {
          tts_status: 'streaming',
          tts_stream_id: 'tts-corr-early-final-audio'
        }
      }
    })
    await expect(completed).resolves.toMatchObject({
      done: false,
      value: { kind: 'completed', text: 'Spoken response', textDelta: '' }
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
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
