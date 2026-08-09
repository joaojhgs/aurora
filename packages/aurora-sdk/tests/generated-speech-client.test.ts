import { describe, expect, it } from 'vitest'

import { AuroraClient } from '../src/client.js'
import { MockAuroraTransport } from '../src/mock.js'
import type { AuroraTransportRequest } from '../src/transport.js'

describe('generated speech client', () => {
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
