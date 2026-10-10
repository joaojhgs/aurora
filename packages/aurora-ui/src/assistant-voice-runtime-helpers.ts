import type { VoiceRuntimeEvent } from '@aurora/client'
import type { NativeDesktopVoicePhase } from './native-desktop-voice'
import type { VoiceCaptureStatus } from './assistant-voice-model'
import { voiceRuntimeEventKey } from './assistant-browser-voice-runtime'

export function mergeTranscriptText(
  previous: string,
  incoming: string,
  options: { appendOnMiss: boolean }
): string {
  const previousWords = transcriptWords(previous)
  const incomingWords = transcriptWords(incoming)
  if (previousWords.length === 0) return incomingWords.join(' ')
  if (incomingWords.length === 0) return previousWords.join(' ')

  const previousKeys = previousWords.map(transcriptWordKey)
  const incomingKeys = incomingWords.map(transcriptWordKey)
  if (incomingKeys.slice(0, previousKeys.length).every((word, index) => word === previousKeys[index])) {
    return incomingWords.join(' ')
  }
  if (previousKeys.length === incomingKeys.length && previousKeys.every((word, index) => word === incomingKeys[index])) {
    return incomingWords.join(' ')
  }

  let bestPreviousIndex = -1
  let bestLength = 0
  for (let previousIndex = 0; previousIndex < previousKeys.length; previousIndex += 1) {
    let length = 0
    while (
      previousIndex + length < previousKeys.length &&
      length < incomingKeys.length &&
      previousKeys[previousIndex + length] === incomingKeys[length]
    ) {
      length += 1
    }
    if (length > bestLength) {
      bestPreviousIndex = previousIndex
      bestLength = length
    }
  }

  const minOverlap = Math.min(previousKeys.length, incomingKeys.length) <= 5 ? 2 : 3
  if (bestPreviousIndex >= 0 && bestLength >= minOverlap) {
    return [...previousWords.slice(0, bestPreviousIndex), ...incomingWords].join(' ')
  }

  return options.appendOnMiss
    ? [...previousWords, ...incomingWords].join(' ')
    : incomingWords.join(' ')
}

export function isAuthoritativeVoiceTranscriptEvent(event: Pick<VoiceRuntimeEvent, 'kind' | 'topic'>): boolean {
  if (event.kind !== 'transcription_partial' && event.kind !== 'transcription_final') return true
  const topic = event.topic ?? ''
  if (topic === 'Transcription.Result') return false
  return true
}

export function isAuthoritativeCoordinatorSessionStart(
  event: Pick<VoiceRuntimeEvent, 'kind' | 'topic' | 'sourcePeerId' | 'targetPeerId' | 'targetDeviceId'>
): boolean {
  return event.kind === 'session_started'
    && event.topic === 'STTCoordinator.SessionStarted'
    && isLocalVoiceEventSource(event)
}

function transcriptWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function transcriptWordKey(word: string): string {
  return word.replace(/[^\p{L}\p{N}_]+/gu, '').toLocaleLowerCase()
}

export function nativeDesktopVoiceCaptureStatus(phase: NativeDesktopVoicePhase): VoiceCaptureStatus {
  switch (phase) {
    case 'unavailable':
      return 'no-device'
    case 'starting':
    case 'listening':
      return 'listening'
    case 'processing':
      return 'processing'
    case 'speaking':
      return 'speaking'
    case 'faulted':
      return 'error'
    case 'idle':
    case 'stopping':
      return 'idle'
  }
}

export function idleWaveformBars(): number[] {
  return Array.from({ length: 24 }, () => 8)
}

function isOwnedVoiceRuntimeEvent(event: VoiceRuntimeEvent, activeSessionId: string | null): boolean {
  if (!activeSessionId) return false
  return event.sessionId === activeSessionId
}

export function shouldApplyVoiceRuntimeEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (isOwnedVoiceRuntimeEvent(event, activeSessionId)) return true
  const local = isLocalVoiceEventSource(event)
  if (event.kind === 'session_started') return local && !shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)
  if (event.kind === 'transcription_partial' || event.kind === 'transcription_final') {
    if (activeSessionId && !event.sessionId) return false
    if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)) return false
    return local
  }
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking'
  if (!activeCapture) return false
  if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)) return false
  return local
}

export function shouldIgnoreForeignVoiceSessionEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (!activeSessionId || !event.sessionId || event.sessionId === activeSessionId) return false
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing'
  return activeCapture && activeSessionId.startsWith('voice-')
}

export function shouldApplyVoiceSessionEndEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (event.kind !== 'session_ended') return false
  if (isOwnedVoiceRuntimeEvent(event, activeSessionId)) return true
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing'
  if (activeCapture && activeSessionId) return false
  return isLocalVoiceEventSource(event)
}

export function isLocalVoiceEventSource(
  event: Pick<VoiceRuntimeEvent, 'sourcePeerId' | 'targetPeerId' | 'targetDeviceId'>
): boolean {
  const provenance = [event.sourcePeerId, event.targetPeerId, event.targetDeviceId].filter(Boolean)
  if (provenance.length === 0) return true
  return provenance.every((value) => /^(local|localhost|internal|self|system|gateway|aurora)$/i.test(value ?? ''))
}

export function mergeVoiceRuntimeEvents(...groups: VoiceRuntimeEvent[][]): VoiceRuntimeEvent[] {
  const seen = new Set<string>()
  const merged: VoiceRuntimeEvent[] = []
  for (const event of groups.flat()) {
    const key = voiceRuntimeEventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  return merged
}

export function waveformBarsFromLevel(level: number, peak: number): number[] {
  const safeLevel = Math.max(0, Math.min(100, level))
  const safePeak = Math.max(safeLevel, Math.min(100, peak))
  const shape = [0.38, 0.72, 0.54, 0.9, 0.62, 1, 0.76, 0.46, 0.84, 0.58, 0.68, 0.42, 0.94, 0.64, 0.5, 0.8, 0.56, 0.72, 0.44, 0.88, 0.6, 0.78, 0.48, 0.7]
  return shape.map((weight, index) => {
    const peakAccent = index % 5 === 0 ? safePeak * 0.28 : 0
    return Math.max(6, Math.min(100, Math.round(6 + safeLevel * weight + peakAccent)))
  })
}
