import type { VoiceRuntimeEvent } from '@aurora/client'

import type { VoiceCaptureStatus, VoiceEventRow } from './assistant-voice-model'
import type { RouteAvailability } from './shell-data'

export function voiceEventRows(
  captureStatus: VoiceCaptureStatus,
  transcription: RouteAvailability,
  voiceEvents: VoiceRuntimeEvent[]
): VoiceEventRow[] {
  const captureFailure: VoiceEventRow | null = captureStatus === 'permission-denied'
    ? {
      id: 'permission-loss',
      label: 'Local permission loss',
      state: 'denied',
      detail: 'Microphone permission was lost or denied.'
    }
    : captureStatus === 'no-device' || captureStatus === 'error'
      ? {
        id: 'capture-error',
        label: 'Capture error',
        state: captureStatus === 'no-device' ? 'unsupported' : 'degraded',
        detail: 'Local capture failed before audio could be routed.'
      }
      : null
  const rows = [
    {
      id: 'partial',
      label: 'Partial speech text',
      state: transcription.disabled ? 'unsupported' : 'pending',
      detail: 'Aurora is listening for more speech.'
    },
    {
      id: 'final',
      label: 'Final speech text',
      state: transcription.disabled ? 'unsupported' : transcription.state,
      detail: 'Aurora is ready to use the final speech text.'
    },
    {
      id: 'tts-started',
      label: 'Speech started',
      state: 'pending',
      detail: 'Playback starts after Aurora confirms speech has begun.'
    },
    {
      id: 'tts-stopped',
      label: 'Speech stopped',
      state: 'pending',
      detail: 'Stop and cancel controls wait for Aurora to finish stopping speech.'
    },
    {
      id: 'timeout',
      label: 'Timeout',
      state: 'degraded',
      detail: 'Timeouts remain visible as retryable voice session outcomes.'
    },
    {
      id: 'cancelled',
      label: 'Cancelled',
      state: 'pending',
      detail: 'Cancellation must revoke or stop the current audio session.'
    },
    {
      id: 'remote-denied',
      label: 'Connected help denied',
      state: 'denied',
      detail: 'A privacy choice or connected device prevented voice help.'
    },
    {
      id: 'peer-disconnect',
      label: 'Connected device offline',
      state: 'stale',
      detail: 'A connected device stopped responding.'
    },
    ...(captureFailure ? [captureFailure] : [])
  ] satisfies VoiceEventRow[]
  return applyVoiceEvidenceRows(rows, voiceEvents)
}

export function applyVoiceEvidenceRows(rows: VoiceEventRow[], voiceEvents: VoiceRuntimeEvent[]): VoiceEventRow[] {
  if (voiceEvents.length === 0) return rows
  const latestByRow = new Map<string, VoiceRuntimeEvent>()
  for (const event of voiceEvents) {
    const rowId = voiceEventRowId(event)
    if (!rowId || latestByRow.has(rowId)) continue
    latestByRow.set(rowId, event)
  }
  return rows.map((row) => {
    const event = latestByRow.get(row.id)
    if (!event) return row
    return {
      ...row,
      state: availabilityForVoiceEvent(event, row.state),
      detail: voiceEvidenceDetail(event)
    }
  })
}

function voiceEventRowId(event: VoiceRuntimeEvent): string | null {
  if (event.kind === 'transcription_partial') return 'partial'
  if (event.kind === 'transcription_final') return 'final'
  if (event.kind === 'tts_started') return 'tts-started'
  if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') return 'tts-stopped'
  if (event.kind === 'stt_timeout') return 'timeout'
  if (event.kind === 'audio_cancelled' || event.kind === 'session_ended') return 'cancelled'
  if (event.kind === 'audio_denied' || event.kind === 'stt_error' || event.kind === 'tts_error') return 'remote-denied'
  if (event.kind === 'audio_disconnected') return 'peer-disconnect'
  return null
}

function availabilityForVoiceEvent(event: VoiceRuntimeEvent, fallback: VoiceEventRow['state']): VoiceEventRow['state'] {
  if (event.state === 'denied' || event.state === 'error') return 'denied'
  if (event.state === 'disconnected') return 'stale'
  if (event.state === 'timeout') return 'degraded'
  if (event.state === 'cancelled') return 'pending'
  if (
    event.state === 'listening'
    || event.state === 'processing'
    || event.state === 'speaking'
    || event.state === 'paused'
  ) {
    return 'available-local'
  }
  return fallback
}

function voiceEvidenceDetail(event: VoiceRuntimeEvent): string {
  if (event.state === 'denied' || event.state === 'error') return 'Voice needs attention before it can continue.'
  if (event.state === 'disconnected') return 'A connected device stopped responding.'
  if (event.state === 'timeout') return 'Voice took too long; try again.'
  if (event.state === 'cancelled') return 'Voice was cancelled for this session.'
  if (event.kind === 'transcription_partial') return 'Aurora is hearing speech.'
  if (event.kind === 'transcription_final') return 'Aurora received the final speech text.'
  if (event.kind === 'tts_started') return 'Aurora started speaking.'
  if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') return 'Speech playback changed.'
  if (event.kind === 'stt_timeout') return 'Voice took too long; try again.'
  if (event.kind === 'audio_cancelled' || event.kind === 'session_ended') return 'Voice stopped for this session.'
  if (event.kind === 'audio_denied' || event.kind === 'stt_error' || event.kind === 'tts_error') return 'Voice needs attention before it can continue.'
  if (event.kind === 'audio_disconnected') return 'A connected device stopped responding.'
  if (event.state === 'listening') return 'This device is listening.'
  if (event.state === 'processing') return 'Aurora is processing audio.'
  if (event.state === 'speaking') return 'Aurora is speaking.'
  if (event.state === 'paused') return 'Voice is paused.'
  return 'Voice status changed.'
}
