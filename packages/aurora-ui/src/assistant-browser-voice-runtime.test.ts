import { describe, expect, it } from 'vitest'
import {
  browserVoiceRuntimeEventToVoiceEvent,
  int16PcmToLittleEndianBase64,
  productAudioCaptureErrorCopy,
  voiceCaptureStatusForStartError,
  voiceRuntimeEventKey,
  type BrowserVoiceRuntimeEventSnapshot,
} from './assistant-browser-voice-runtime'

describe('assistant browser voice runtime helpers', () => {
  it('maps redacted browser runtime snapshots to voice events without audio payloads', () => {
    const event = browserVoiceRuntimeEventToVoiceEvent(browserSnapshot({
      kind: 'session_started',
      sessionId: 'browser-session',
      sequence: 3,
      sampleCount: 128,
      byteLength: 256,
    }))

    expect(event.kind).toBe('session_started')
    expect(event.state).toBe('listening')
    expect(event.sessionId).toBe('browser-session')
    expect(event.id).toBe(`browser-session_started-1-3-${Date.UTC(2026, 8, 16)}`)
    expect(event.topic).toBeNull()
    expect(event.privacyClass).toBe('microphone')
    expect(event.redacted).toBe(true)
    expect(event.raw).toMatchObject({
      kind: 'session_started',
      sequence: 3,
      sampleCount: 128,
      byteLength: 256,
      redacted: true,
    })
    expect(event.audit?.transport).toBe('browser')
    expect(event.audit?.redaction.secretsRedacted).toBe(true)
  })

  it('preserves the original voice event dedupe identity', () => {
    const withId = browserVoiceRuntimeEventToVoiceEvent(browserSnapshot({ kind: 'frame_dropped', sequence: 5 }))
    const withoutId = { ...withId, id: null, text: 'partial transcript' }
    const keyedById = { ...withId, id: 'voice-event-id', text: 'changed text' }

    expect(voiceRuntimeEventKey(keyedById)).toBe('voice-event-id')
    expect(voiceRuntimeEventKey(withoutId)).toBe(`stt_error:session:5:${withoutId.occurredAt}`)
  })

  it('keeps microphone start error copy and capture status aligned', () => {
    const permissionError = { code: 'audio_source_permission_denied' }
    const missingDevice = { name: 'NotFoundError' }
    const cancelled = { code: 'start_cancelled' }

    expect(productAudioCaptureErrorCopy(permissionError)).toBe('Microphone permission was denied.')
    expect(voiceCaptureStatusForStartError(permissionError)).toBe('permission-denied')
    expect(productAudioCaptureErrorCopy(missingDevice)).toBe('No microphone was found on this device.')
    expect(voiceCaptureStatusForStartError(missingDevice)).toBe('no-device')
    expect(voiceCaptureStatusForStartError(cancelled)).toBe('idle')
  })

  it('encodes signed 16-bit PCM as little-endian base64 for transcription', () => {
    expect(int16PcmToLittleEndianBase64(new Int16Array([1, -2, 0x1234]))).toBe('AQD+/zQS')
  })
})

function browserSnapshot(overrides: Partial<BrowserVoiceRuntimeEventSnapshot>): BrowserVoiceRuntimeEventSnapshot {
  return {
    kind: 'session_started',
    sessionId: null,
    generation: 1,
    sequence: null,
    sampleCount: 0,
    byteLength: 0,
    queuedBytes: 0,
    reason: null,
    redacted: true,
    occurredAtMs: Date.UTC(2026, 8, 16),
    ...overrides,
  }
}
