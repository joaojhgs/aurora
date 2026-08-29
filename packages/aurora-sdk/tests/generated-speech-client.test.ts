import { describe, expect, it } from 'vitest'

import { AuroraClient } from '../src/client.js'
import { MockAuroraTransport } from '../src/mock.js'
import type { AuroraTransportRequest } from '../src/transport.js'

describe('generated speech client', () => {
  it('provides the explicit demo transport with a redacted focused-transcription route', async () => {
    const privateAudio = 'cHJpdmF0ZS1kZW1vLWF1ZGlv'
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const catalog = await client.capabilities.listCatalog({ include_unavailable: true })
    const result = await client.assistant.transcribeVoiceAudio({
      audio_data: privateAudio,
      channels: 1,
      format: 'raw',
      model: 'accurate',
      sample_rate: 16_000
    })

    expect(catalog.action_index['Transcription.Transcribe']).toEqual([
      'transcription-demo-focused'
    ])
    expect(catalog.action_index['Tooling.ExecuteTool'] ?? []).not.toContain(
      'transcription-demo-focused'
    )
    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action_id: 'transcription-demo-focused',
        module: 'Transcription',
        method: 'Transcribe',
        provider_kind: 'remote',
        provider_id: 'remote:demo-home:Transcription',
        policy: expect.objectContaining({ resource_scope: 'raw-audio' }),
        topic: 'Transcription.Transcribe'
      })
    )
    expect(result).toMatchObject({
      ok: true,
      data: {
        confidence: null,
        duration_ms: 500,
        language: 'en',
        model_used: 'demo-focused',
        text: 'hello Aurora'
      }
    })
    expect(JSON.stringify(result)).not.toContain(privateAudio)
  })

  it('normalizes generated input and uses generated route metadata', async () => {
    let observed: AuroraTransportRequest | undefined
    const transport = MockAuroraTransport.empty().register(
      'Transcription.Transcribe',
      (request) => {
        observed = request
        return {
          confidence: 0.9,
          duration_ms: 125,
          language: 'en',
          model_used: 'realtime',
          text: 'hello'
        }
      }
    )
    const client = new AuroraClient({ transport })

    const result = await client.speech.transcription.transcribe({
      audio_data: 'c2FtcGxl',
      language: ' EN '
    })

    expect(result).toMatchObject({
      ok: true,
      data: { language: 'en', model_used: 'realtime', text: 'hello' }
    })
    expect(observed).toMatchObject({
      method: 'Transcription.Transcribe',
      busTopic: 'Transcription.Transcribe',
      path: '/api/Transcription/Transcribe',
      payload: {
        audio_data: 'c2FtcGxl',
        language: 'en'
      }
    })
  })

  it('rejects invalid requests before transport without exposing raw values', async () => {
    let calls = 0
    const transport = MockAuroraTransport.empty().register('Transcription.Transcribe', () => {
      calls += 1
      return { duration_ms: 0, model_used: 'realtime', text: '' }
    })
    const client = new AuroraClient({ transport })
    const privateValue = 'private-audio-value'

    const result = await client.speech.transcription.transcribe({
      audio_data: privateValue,
      channels: 0
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid request')
    expect(result.error).toMatchObject({
      code: 'validation',
      message: 'The request contains invalid values.'
    })
    expect(JSON.stringify(result.error.detail)).not.toContain(privateValue)
    expect(calls).toBe(0)
  })

  it('rejects invalid backend responses at the generated boundary', async () => {
    const transport = MockAuroraTransport.empty().register(
      'Transcription.Transcribe',
      () => ({ duration_ms: 'invalid', model_used: 'realtime', text: 'private transcript' })
    )
    const client = new AuroraClient({ transport })

    const result = await client.speech.transcription.transcribe({ audio_data: 'c2FtcGxl' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected invalid response')
    expect(result.error).toMatchObject({
      code: 'validation',
      message: 'Aurora returned an invalid response.'
    })
    expect(JSON.stringify(result.error.detail)).not.toContain('private transcript')
  })

  it('routes cloned voice state export and import through generated contracts', async () => {
    const voiceId = 'clone:123e4567-e89b-42d3-a456-426614174000'
    const artifactData = 'ZGVyaXZlZC1zdGF0ZQ=='
    const bundle = {
      artifact_data_base64: artifactData,
      artifact_format: 'safetensors' as const,
      artifact_revision: 'clone-rev-a',
      artifact_sha256: '2f6b3cf0253d17cf2fb3161e0ff8c98bc0789ec0ff7d9f4880568e680883d1ec',
      artifact_size_bytes: 13,
      bundle_type: 'aurora-cloned-tts-voice-state' as const,
      compatibility_group: 'pockettts-base',
      display_name: 'Private voice',
      language_bundle: 'english_2026-04',
      runtime_target: 'pockettts-python',
      schema_version: 1 as const,
      voice_id: voiceId
    }
    const observed: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty()
      .register('TTS.ExportVoiceProfile', (request) => {
        observed.push(request)
        return {
          bundle,
          idempotent: false,
          revision: 'voice-rev-a',
          status: 'exported',
          voice_id: voiceId
        }
      })
      .register('TTS.ImportVoiceProfile', (request) => {
        observed.push(request)
        return {
          idempotent: false,
          revision: 'clone-rev-a',
          status: 'imported',
          voice_id: voiceId
        }
      })
    const client = new AuroraClient({ transport })

    const exported = await client.speech.tts.exportVoiceProfile({
      operation_id: 'export-a',
      voice_id: voiceId
    })
    const imported = await client.speech.tts.importVoiceProfile({
      bundle,
      operation_id: 'import-a'
    })

    expect(exported).toMatchObject({ ok: true, data: { status: 'exported', bundle } })
    expect(imported).toMatchObject({ ok: true, data: { status: 'imported' } })
    expect(observed.map((request) => request.method)).toEqual([
      'TTS.ExportVoiceProfile',
      'TTS.ImportVoiceProfile'
    ])
    expect(observed[1]?.payload).toMatchObject({ bundle })
  })

  it.each([
    ['WakeWord.ProcessAudio', 'wakeWord'],
    ['Transcription.ProcessAudio', 'transcription']
  ] as const)('does not expose or dispatch continuous audio through %s', async (methodId, namespace) => {
    let calls = 0
    const transport = MockAuroraTransport.empty().register(methodId, () => {
      calls += 1
      return {}
    })
    const client = new AuroraClient({ transport })

    expect('processAudio' in client.speech[namespace]).toBe(false)
    const unsafeContracts = client.contracts as unknown as {
      requestResult(methodId: string, input: unknown): Promise<{
        ok: boolean
        error?: { code?: string; message?: string }
      }>
    }
    const result = await unsafeContracts.requestResult(methodId, {
      channels: 1,
      data: 'c2FtcGxl',
      sample_rate: 16_000
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'privacy_blocked',
        message: 'Continuous audio capture cannot be sent to another device.'
      }
    })
    expect(calls).toBe(0)
  })
})
