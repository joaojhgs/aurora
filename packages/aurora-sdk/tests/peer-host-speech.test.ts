import { describe, expect, it } from 'vitest'
import { PeerHostContractRegistry } from '../src/peer-host/contract-registry.js'
import {
  createPeerHostLocalSpeechSource,
  type PeerHostLocalSpeechRuntimePort,
} from '../src/peer-host/speech-host.js'

function context(methodId: string, signal = new AbortController().signal) {
  return {
    id: 'call-1',
    methodId,
    remotePeerId: 'peer-a',
    identity: { callerPeerId: 'peer-a', effectivePermissions: [methodId] },
    signal,
    receivedAtMs: 1,
    deadlineAtMs: 60_001,
  }
}

describe('local speech peer-host methods', () => {
  it('decodes bounded selected-model PCM through the local recognizer and withdraws it when hidden', async () => {
    const transcribed: Int16Array[] = []
    const runtime: PeerHostLocalSpeechRuntimePort = {
      async transcribeSpeech(request) {
        transcribed.push(request.pcm)
        return { text: 'recognized locally' }
      },
      async synthesizeSpeech() { throw new Error('not used') },
      async cancel() {},
    }
    const registry = new PeerHostContractRegistry()
    const host = createPeerHostLocalSpeechSource({
      peerId: 'peer-local',
      revision: 4,
      runtime,
      stt: { enabled: true, modelId: 'moonshine', language: 'en' },
    })
    host.register(registry)
    const method = registry.get('Transcription.Transcribe')!
    const result = await registry.dispatch(method, {
      audio_data: btoa('\x01\x00\xff\x7f'),
      format: 'raw',
      sample_rate: 16_000,
      channels: 1,
      language: 'en',
      model: 'moonshine',
      mesh_selector: { peer_id: 'peer-local', service_instance_id: 'remote:peer-local:Transcription' },
    }, context('Transcription.Transcribe'))

    expect(result).toMatchObject({ text: 'recognized locally', model_used: 'moonshine', language: 'en' })
    expect([...transcribed[0]!]).toEqual([1, 32767])
    expect(host.capabilities()[0]?.capability).toMatchObject({
      stage: 'stt', method_ids: ['Transcription.Transcribe'], readiness: 'ready', exported: true,
    })

    host.setVisible(false)
    expect(host.capabilities()).toEqual([])
    await expect(registry.dispatch(method, {
      audio_data: btoa('\x01\x00'), format: 'raw', sample_rate: 16_000, channels: 1, model: 'moonshine',
    }, context('Transcription.Transcribe'))).rejects.toThrow('unavailable')
  })

  it('rejects a request that selects a different STT model without invoking the local engine', async () => {
    let calls = 0
    const runtime: PeerHostLocalSpeechRuntimePort = {
      async transcribeSpeech() { calls += 1; return { text: 'unexpected' } },
      async synthesizeSpeech() { throw new Error('not used') },
      async cancel() {},
    }
    const registry = new PeerHostContractRegistry()
    const host = createPeerHostLocalSpeechSource({
      peerId: 'peer-local', revision: 1, runtime,
      stt: { enabled: true, modelId: 'moonshine', language: null },
    })
    host.register(registry)

    const method = registry.get('Transcription.Transcribe')!
    await expect(registry.dispatch(method, {
      audio_data: btoa('\x01\x00'), format: 'raw', sample_rate: 16_000, channels: 1, model: 'realtime',
    }, context('Transcription.Transcribe'))).rejects.toThrow('selected local model')
    await expect(registry.dispatch(method, {
      audio_data: btoa('\x01\x00'), format: 'raw', sample_rate: 16_000, channels: 1, model: 'moonshine',
      mesh_selector: { peer_id: 'peer-other', service_instance_id: 'remote:peer-other:Transcription' },
    }, context('Transcription.Transcribe'))).rejects.toThrow('selected local model')
    expect(calls).toBe(0)
  })

  it('advertises a verified local voice without inventing a model identity', async () => {
    let calls = 0
    const runtime: PeerHostLocalSpeechRuntimePort = {
      async transcribeSpeech() { throw new Error('not used') },
      async synthesizeSpeech() {
        calls += 1
        return { pcm: new Int16Array([1]), sampleRateHz: 16_000, durationMs: 0.0625 }
      },
      async cancel() {},
    }
    const registry = new PeerHostContractRegistry()
    const host = createPeerHostLocalSpeechSource({
      peerId: 'peer-local', revision: 2, runtime,
      tts: { enabled: true, modelId: null, language: 'en', voiceId: 'standard:browser:en' },
    })
    host.register(registry)
    expect(host.capabilities()[0]?.capability.model_ids).toEqual([])
    expect(host.capabilities()[0]?.voice_ids).toEqual(['standard:browser:en'])

    const method = registry.get('TTS.Synthesize')!
    await registry.dispatch(method, {
      text: 'hello', format: 'wav', voice: null, model_id: null, language: 'en',
    }, context('TTS.Synthesize'))
    await expect(registry.dispatch(method, {
      text: 'wrong model', format: 'wav', voice: null, model_id: 'unverified-model', language: 'en',
    }, context('TTS.Synthesize'))).rejects.toThrow('selected local voice')
    expect(calls).toBe(1)
  })

  it('returns local TTS as a WAV payload without a playback side effect', async () => {
    const synthesized: string[] = []
    const voices: string[] = []
    const runtime: PeerHostLocalSpeechRuntimePort = {
      async transcribeSpeech() { throw new Error('not used') },
      async synthesizeSpeech(request) {
        synthesized.push(request.text)
        voices.push(request.voiceId)
        return { pcm: new Int16Array(2_205).fill(1_000), sampleRateHz: 22_050, durationMs: 100 }
      },
      async cancel() {},
    }
    const registry = new PeerHostContractRegistry()
    const host = createPeerHostLocalSpeechSource({
      peerId: 'peer-local', revision: 2, runtime,
      tts: { enabled: true, modelId: 'piper', language: 'en', voiceId: 'standard:browser:en' },
    })
    host.register(registry)
    const result = await registry.dispatch(registry.get('TTS.Synthesize')!, {
      text: 'hello', format: 'wav', voice: null, model_id: 'piper', language: 'en',
      sample_rate: 16_000,
      mesh_selector: { peer_id: 'peer-local', service_instance_id: 'remote:peer-local:TTS' },
    }, context('TTS.Synthesize')) as { audio_data: string; format: string; sample_rate: number; duration_ms: number }
    const bytes = Uint8Array.from(atob(result.audio_data), (value) => value.charCodeAt(0))
    const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(result.format).toBe('wav')
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF')
    expect(result.sample_rate).toBe(16_000)
    expect(wav.getUint32(24, true)).toBe(16_000)
    expect(wav.getUint32(40, true)).toBe(1_600 * 2)
    expect(result.duration_ms).toBe(100)
    expect(synthesized).toEqual(['hello'])
    expect(voices).toEqual(['standard:browser:en'])

    await expect(registry.dispatch(registry.get('TTS.Synthesize')!, {
      text: 'wrong target', format: 'wav', voice: null, model_id: 'piper', language: 'en',
      mesh_selector: { peer_id: 'remote:peer-local:TTS', service_instance_id: 'peer-local' },
    }, context('TTS.Synthesize'))).rejects.toThrow('selected local voice')
    await expect(registry.dispatch(registry.get('TTS.Synthesize')!, {
      text: 'wrong model', format: 'wav', voice: null, model_id: 'other', language: 'en',
      mesh_selector: { peer_id: 'peer-local', service_instance_id: 'remote:peer-local:TTS' },
    }, context('TTS.Synthesize'))).rejects.toThrow('selected local voice')
    expect(synthesized).toEqual(['hello'])
  })

  it('does not let an aborted concurrent request cancel the active local speech operation', async () => {
    let signalSynthesisStarted: (() => void) | undefined
    let finishSynthesis: ((audio: { pcm: Int16Array; sampleRateHz: number; durationMs: number }) => void) | undefined
    const synthesisStarted = new Promise<void>((resolve) => { signalSynthesisStarted = resolve })
    const synthesis = new Promise<{ pcm: Int16Array; sampleRateHz: number; durationMs: number }>((resolve) => { finishSynthesis = resolve })
    let cancels = 0
    const runtime: PeerHostLocalSpeechRuntimePort = {
      async transcribeSpeech() { return { text: 'unexpected' } },
      async synthesizeSpeech() {
        signalSynthesisStarted?.()
        return await synthesis
      },
      async cancel() { cancels += 1 },
    }
    const registry = new PeerHostContractRegistry()
    const host = createPeerHostLocalSpeechSource({
      peerId: 'peer-local', revision: 1, runtime,
      stt: { enabled: true, modelId: 'whisper-mini', language: null },
      tts: { enabled: true, modelId: 'piper', language: null, voiceId: 'standard:browser:en' },
    })
    host.register(registry)

    const activeTts = registry.dispatch(registry.get('TTS.Synthesize')!, {
      text: 'hello', format: 'wav', voice: null, model_id: 'piper', language: null,
    }, context('TTS.Synthesize'))
    await synthesisStarted
    const rejectedSttController = new AbortController()
    const rejectedStt = registry.dispatch(registry.get('Transcription.Transcribe')!, {
      audio_data: btoa('\x01\x00'), format: 'raw', sample_rate: 16_000, channels: 1, model: 'whisper-mini', language: null,
    }, context('Transcription.Transcribe', rejectedSttController.signal))
    await expect(rejectedStt).rejects.toThrow('busy')
    rejectedSttController.abort()
    expect(cancels).toBe(0)

    finishSynthesis?.({ pcm: new Int16Array([1]), sampleRateHz: 16_000, durationMs: 1 })
    await expect(activeTts).resolves.toMatchObject({ format: 'wav', sample_rate: 16_000 })
    await host.close()
  })
})
