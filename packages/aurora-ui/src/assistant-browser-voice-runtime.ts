import type { VoiceRuntimeEvent } from '@aurora/client'
import type {
  createAuroraBrowserVoiceRuntime as createAuroraBrowserVoiceRuntimeType,
} from '@aurora/voice-web/browser'
import type { AuroraVoiceInferenceOutput } from '@aurora/voice-web'
import type { VoiceCaptureStatus } from './assistant-view'

export type AuroraBrowserVoiceRuntimeFactory = typeof createAuroraBrowserVoiceRuntimeType
export type AuroraBrowserVoiceRuntimeInstance = ReturnType<AuroraBrowserVoiceRuntimeFactory>
export type AuroraBrowserCapturedAudio = Awaited<ReturnType<AuroraBrowserVoiceRuntimeInstance['stop']>>

let auroraBrowserVoiceRuntimeFactoryPromise: Promise<AuroraBrowserVoiceRuntimeFactory> | null = null

export interface BrowserVoiceRuntimeEventSnapshot {
  readonly kind: string
  readonly sessionId: string | null
  readonly generation: number
  readonly sequence: number | null
  readonly sampleCount: number
  readonly byteLength: number
  readonly queuedBytes: number
  readonly reason: string | null
  readonly inference?: AuroraVoiceInferenceOutput
  readonly redacted: true
  readonly occurredAtMs: number
}

export function voiceRuntimeEventKey(event: VoiceRuntimeEvent): string {
  const sequence = typeof event.raw.sequence === 'number' || typeof event.raw.sequence === 'string'
    ? String(event.raw.sequence)
    : null
  return event.id ?? `${event.kind}:${event.sessionId ?? 'session'}:${sequence ?? event.text ?? ''}:${event.occurredAt}`
}

export function browserVoiceRuntimeEventToVoiceEvent(event: BrowserVoiceRuntimeEventSnapshot): VoiceRuntimeEvent {
  const kind = browserVoiceRuntimeEventKind(event.kind)
  return {
    id: `browser-${event.kind}-${event.generation}-${event.sequence ?? 'session'}-${event.occurredAtMs}`,
    kind,
    state: browserVoiceRuntimeEventState(event.kind),
    topic: null,
    sessionId: event.sessionId,
    correlationId: null,
    sourcePeerId: null,
    targetPeerId: null,
    targetDeviceId: null,
    consentDecision: null,
    policyDecisionId: null,
    privacyClass: 'microphone',
    text: null,
    level: null,
    peak: null,
    bars: null,
    reason: event.reason,
    redacted: event.redacted,
    occurredAt: new Date(event.occurredAtMs).toISOString(),
    audit: browserVoiceRuntimeEventAudit(event.kind),
    raw: {
      kind: event.kind,
      sequence: event.sequence,
      generation: event.generation,
      sampleCount: event.sampleCount,
      byteLength: event.byteLength,
      queuedBytes: event.queuedBytes,
      redacted: event.redacted
    }
  }
}

export function productAudioCaptureErrorCopy(error: unknown): string {
  const code = voiceCaptureErrorCode(error)
  if (code === 'audio_source_permission_denied') {
    return 'Microphone permission was denied.'
  }
  if (code === 'audio_source_no_input_device') {
    return 'No microphone was found on this device.'
  }
  if (code === 'start_cancelled' || code === 'audio_source_start_cancelled') {
    return 'Microphone start was cancelled. Try again.'
  }
  if (
    code === 'audio_source_unavailable' ||
    code === 'audio_source_start_timeout' ||
    code === 'audio_source_suspended' ||
    code === 'audio_source_start_failed' ||
    code === 'start_failed'
  ) {
    return 'Microphone capture failed. Try again.'
  }
  const name = browserErrorName(error)
  if (name) {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone permission was denied.'
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.'
    }
    return 'Microphone capture failed. Try again.'
  }
  return 'Microphone capture failed. Try again.'
}

export function voiceCaptureStatusForStartError(error: unknown): VoiceCaptureStatus {
  const code = voiceCaptureErrorCode(error)
  if (code === 'audio_source_permission_denied') return 'permission-denied'
  if (code === 'audio_source_no_input_device') return 'no-device'
  if (code === 'start_cancelled' || code === 'audio_source_start_cancelled') return 'idle'
  const name = browserErrorName(error)
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-device'
  return 'error'
}

export function browserErrorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

export function int16PcmToLittleEndianBase64(samples: Int16Array): string {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }
  return arrayBufferToBase64(buffer)
}

export function defaultSameOriginSherpaAssetUrls(): NonNullable<Parameters<AuroraBrowserVoiceRuntimeFactory>[0]['sherpaAssets']> {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost'
  return {
    vadAsrModuleUrl: new URL('/voice/sherpa/sherpa-onnx-wasm-main-vad-asr.js', origin),
    kwsModuleUrl: new URL('/voice/sherpa/sherpa-onnx-wasm-kws-main.js', origin),
    ttsModuleUrl: new URL('/voice/sherpa/sherpa-onnx-wasm-main-tts.js', origin),
  }
}

export async function loadAuroraBrowserVoiceRuntimeFactory(): Promise<AuroraBrowserVoiceRuntimeFactory> {
  auroraBrowserVoiceRuntimeFactoryPromise ??= import('@aurora/voice-web/browser')
    .then((module) => module.createAuroraBrowserVoiceRuntime)
  return await auroraBrowserVoiceRuntimeFactoryPromise
}

function browserVoiceRuntimeEventKind(kind: string): VoiceRuntimeEvent['kind'] {
  if (kind === 'session_started') return 'session_started'
  if (kind === 'session_stopped' || kind === 'session_cancelled') return 'audio_cancelled'
  if (kind === 'lifecycle_lost') return 'audio_disconnected'
  if (kind === 'frame_dropped' || kind === 'error') return 'stt_error'
  return 'audio_started'
}

function browserVoiceRuntimeEventState(kind: string): VoiceRuntimeEvent['state'] {
  if (kind === 'session_started' || kind === 'frame_accepted' || kind === 'frame_dropped') return 'listening'
  if (kind === 'session_stopped') return 'processing'
  if (kind === 'session_cancelled') return 'cancelled'
  if (kind === 'lifecycle_lost') return 'disconnected'
  if (kind === 'error') return 'error'
  return 'idle'
}

function browserVoiceRuntimeEventAudit(kind: string): VoiceRuntimeEvent['audit'] {
  return {
    correlationId: null,
    eventKind: kind,
    peerId: null,
    principalId: null,
    targetPeerId: null,
    method: null,
    busTopic: null,
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'browser',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'sdk',
      warnings: []
    }
  }
}

function voiceCaptureErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
