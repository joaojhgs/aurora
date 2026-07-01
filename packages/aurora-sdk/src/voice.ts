import type { AuroraEvent, AuditReceipt, JsonObject, PrivacyClass } from './types.js'

export type VoiceRuntimeEventKind =
  | 'session_started'
  | 'session_ended'
  | 'transcription_partial'
  | 'transcription_final'
  | 'stt_timeout'
  | 'stt_error'
  | 'tts_started'
  | 'tts_stopped'
  | 'tts_paused'
  | 'tts_resumed'
  | 'tts_error'
  | 'audio_consent_requested'
  | 'audio_denied'
  | 'audio_started'
  | 'audio_stopped'
  | 'audio_disconnected'
  | 'audio_cancelled'

export type VoiceRuntimeState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'paused'
  | 'cancelled'
  | 'timeout'
  | 'denied'
  | 'disconnected'
  | 'error'

export interface VoiceRuntimeEvent {
  id: string | null
  kind: VoiceRuntimeEventKind
  topic: string | null
  sessionId: string | null
  correlationId: string | null
  sourcePeerId: string | null
  targetPeerId: string | null
  targetDeviceId: string | null
  consentDecision: string | null
  policyDecisionId: string | null
  privacyClass: PrivacyClass | 'raw-audio' | 'microphone' | string
  state: VoiceRuntimeState
  text: string | null
  reason: string | null
  redacted: boolean
  occurredAt: string
  audit: AuditReceipt
  raw: JsonObject
}

export const VOICE_EVENT_TOPICS = [
  'STTCoordinator.SessionStarted',
  'STTCoordinator.SessionEnded',
  'STTCoordinator.Partial',
  'STTCoordinator.Final',
  'STTCoordinator.Error',
  'STTCoordinator.Timeout',
  'Transcription.Result',
  'Transcription.Error',
  'TTS.Started',
  'TTS.Stopped',
  'TTS.Paused',
  'TTS.Resumed',
  'TTS.Error',
  'AudioSession.Events'
] as const

export const VOICE_EVENT_KINDS = [
  'voice.session.started',
  'voice.session.ended',
  'voice.transcription.partial',
  'voice.transcription.final',
  'voice.timeout',
  'voice.cancelled',
  'voice.denied',
  'voice.disconnected',
  'tts.started',
  'tts.stopped',
  'tts.paused',
  'tts.resumed',
  'tts.error',
  'audio.consent.requested',
  'audio.denied',
  'audio.started',
  'audio.stopped',
  'audio.disconnected',
  'audio.cancelled'
] as const

export function normalizeVoiceRuntimeEvent(event: AuroraEvent<unknown>): VoiceRuntimeEvent | null {
  const raw = objectPayload(event.payload)
  const topic = event.topic ?? event.busTopic ?? event.method
  const source = event.kind || topic || readString(raw, 'event_type', 'type', 'kind') || ''
  const audioEventType = readString(raw, 'event_type', 'type', 'status')
  const kind = runtimeKindFor(source, topic, audioEventType)
  if (!kind) return null
  const text = readString(raw, 'text', 'transcript', 'partial', 'final', 'current_text')
  const reason = readString(raw, 'reason', 'error', 'message', 'status')
  const privacyClass = readString(raw, 'privacy_class', 'privacyClass') ?? inferPrivacyClass(kind)
  const correlationId = readString(raw, 'correlation_id', 'correlationId') ?? event.audit.correlationId
  return {
    id: event.id,
    kind,
    topic,
    sessionId: readString(raw, 'session_id', 'sessionId') ?? null,
    correlationId,
    sourcePeerId: readString(raw, 'source_peer_id', 'sourcePeerId', 'caller_peer_id', 'callerPeerId') ?? event.audit.peerId,
    targetPeerId: readString(raw, 'target_peer_id', 'targetPeerId') ?? event.audit.targetPeerId,
    targetDeviceId: readString(raw, 'target_device_id', 'targetDeviceId') ?? null,
    consentDecision: readString(raw, 'consent_decision', 'consentDecision', 'consent_status', 'status') ?? null,
    policyDecisionId: readString(raw, 'policy_decision_id', 'policyDecisionId') ?? null,
    privacyClass,
    state: runtimeStateFor(kind, readString(raw, 'status', 'state')),
    text: text ?? null,
    reason: reason ?? null,
    redacted: readBoolean(raw, 'redacted', 'secrets_redacted', 'secretsRedacted') ?? event.redaction.secretsRedacted,
    occurredAt: readString(raw, 'occurred_at', 'timestamp', 'created_at') ?? event.receivedAt,
    audit: event.audit,
    raw
  }
}

function runtimeKindFor(source: string, topic: string | null, audioEventType: string | null): VoiceRuntimeEventKind | null {
  const key = `${source} ${topic ?? ''} ${audioEventType ?? ''}`.toLowerCase()
  if (key.includes('sessionstarted') || key.includes('session.started')) return 'session_started'
  if (key.includes('sessionended') || key.includes('session.ended')) return 'session_ended'
  if (key.includes('partial')) return 'transcription_partial'
  if (key.includes('final') || key.includes('transcription.result')) return 'transcription_final'
  if (key.includes('timeout')) return 'stt_timeout'
  if (key.includes('tts.started')) return 'tts_started'
  if (key.includes('tts.stopped')) return 'tts_stopped'
  if (key.includes('tts.paused')) return 'tts_paused'
  if (key.includes('tts.resumed')) return 'tts_resumed'
  if (key.includes('tts.error')) return 'tts_error'
  if (key.includes('consent') && key.includes('request')) return 'audio_consent_requested'
  if (key.includes('denied')) return 'audio_denied'
  if (key.includes('disconnected') || key.includes('disconnect')) return 'audio_disconnected'
  if (key.includes('cancelled') || key.includes('canceled')) return 'audio_cancelled'
  if (key.includes('audio') && key.includes('started')) return 'audio_started'
  if (key.includes('audio') && (key.includes('stopped') || key.includes('ended'))) return 'audio_stopped'
  if (key.includes('sttcoordinator.error') || key.includes('transcription.error')) return 'stt_error'
  return null
}

function runtimeStateFor(kind: VoiceRuntimeEventKind, status: string | null): VoiceRuntimeState {
  const normalized = status?.toLowerCase()
  if (normalized === 'denied') return 'denied'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  if (normalized === 'disconnected') return 'disconnected'
  if (kind === 'session_started' || kind === 'audio_started') return 'listening'
  if (kind === 'transcription_partial' || kind === 'transcription_final') return 'processing'
  if (kind === 'tts_started') return 'speaking'
  if (kind === 'tts_paused') return 'paused'
  if (kind === 'stt_timeout') return 'timeout'
  if (kind === 'audio_denied') return 'denied'
  if (kind === 'audio_disconnected') return 'disconnected'
  if (kind === 'audio_cancelled') return 'cancelled'
  if (kind === 'stt_error' || kind === 'tts_error') return 'error'
  return 'idle'
}

function inferPrivacyClass(kind: VoiceRuntimeEventKind): string {
  if (kind.startsWith('tts_')) return 'personal'
  return 'raw-audio'
}

function objectPayload(value: unknown): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject
  return {}
}

function readString(source: JsonObject, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return null
}

function readBoolean(source: JsonObject, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return null
}
