import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssistantStreamUpdate, AuroraEvent, VoiceRuntimeEvent } from '@aurora/client'
import type { AuroraOverlayLevel, AuroraVoiceOverlayState } from '@aurora/ui'
import { describe, expect, it } from 'vitest'
import { applyDirectTtsEvent, applyVoiceAssistantUpdate, applyVoiceRuntimeEvent, shouldInitializeVoiceListeningFallback, TTS_CHUNK_EVENT_KINDS, TTS_CHUNK_EVENT_TOPICS, TTS_EVENT_KINDS, TTS_EVENT_TOPICS } from './overlay-app'

type Recorder = {
  shown: string[]
  hidden: number[]
  states: AuroraVoiceOverlayState[]
  levels: Array<AuroraOverlayLevel | null>
}

function recorder() {
  const events: Recorder = { shown: [], hidden: [], states: [], levels: [] }
  return {
    events,
    sinks: {
      showOverlay: (mode: 'voice' | 'text') => events.shown.push(mode),
      hideLater: (delayMs?: number) => events.hidden.push(delayMs ?? -1),
      setVoiceState: (state: AuroraVoiceOverlayState) => events.states.push(state),
      setLevel: (level: AuroraOverlayLevel | null) => events.levels.push(level),
    }
  }
}

function event(overrides: Partial<AuroraEvent<Record<string, unknown>>>): AuroraEvent<Record<string, unknown>> {
  return {
    id: 'evt-1',
    kind: 'tts.started',
    topic: 'TTS.Started',
    method: null,
    busTopic: 'TTS.Started',
    payload: {},
    audit: {} as AuroraEvent['audit'],
    redaction: {} as AuroraEvent['redaction'],
    receivedAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

function assistantUpdate(overrides: Partial<AssistantStreamUpdate>): AssistantStreamUpdate {
  return {
    kind: 'delta',
    eventId: 'evt-1',
    messageId: 'msg-1',
    sessionId: 'session-1',
    text: '',
    textDelta: 'hello',
    modelLabel: null,
    error: null,
    audit: {} as AssistantStreamUpdate['audit'],
    metadata: {},
    tool: null,
    ttsAudio: null,
    ...overrides,
  }
}

function voiceEvent(overrides: Partial<VoiceRuntimeEvent>): VoiceRuntimeEvent {
  return {
    id: 'evt-1',
    kind: 'transcription_final',
    occurredAt: '2026-07-08T00:00:00.000Z',
    sessionId: 'session-1',
    correlationId: null,
    text: null,
    level: null,
    peak: null,
    bars: null,
    source: null,
    error: null,
    raw: {},
    ...overrides,
  } as VoiceRuntimeEvent
}

describe('Aurora overlay TTS speaking lifecycle', () => {
  it('loads overlay settings from this device instead of server config', () => {
    const source = readFileSync(join(process.cwd(), 'src/overlay-app.tsx'), 'utf8')
    expect(source).toContain('loadAuroraDesktopOverlayPreferences')
    expect(source).toContain('listenDesktopOverlaySettings')
    expect(source).not.toContain('config.get')
    expect(source).not.toContain('watchConfig')
    expect(source).not.toContain('ui.desktop_overlay')
  })
  it('subscribes to direct TTS lifecycle and audio chunk selectors', () => {
    expect(TTS_EVENT_TOPICS).toContain('TTS.Started')
    expect(TTS_EVENT_TOPICS).toContain('TTS.Resumed')
    expect(TTS_EVENT_TOPICS).toContain('TTS.AudioChunk')
    expect(TTS_EVENT_KINDS).toContain('tts.audio_chunk')
    expect(TTS_EVENT_KINDS).toContain('tts.audio.chunk')
    expect(TTS_EVENT_KINDS).toContain('tts.chunk')
    expect(TTS_CHUNK_EVENT_TOPICS).toEqual(['TTS.AudioChunk'])
    expect(TTS_CHUNK_EVENT_KINDS).toEqual(['tts.audio_chunk', 'tts.audio.chunk', 'tts.chunk'])
  })

  it('treats direct TTS started and chunks as authoritative speaking regardless payload source', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: false }

    applyDirectTtsEvent(event({ payload: { source: 'ui', metadata: { source: 'not-stt' } } }), { ...sinks, activeTtsPlayback })
    expect(activeTtsPlayback.active).toBe(true)
    expect(events.shown).toEqual(['voice'])
    expect(events.states).toEqual(['speaking'])
    expect(events.levels.at(-1)?.source).toBe('synthetic')
    expect(events.levels.at(-1)?.level).toBeGreaterThanOrEqual(0.48)

    applyDirectTtsEvent(event({ kind: 'tts.audio_chunk', topic: 'TTS.AudioChunk', busTopic: 'TTS.AudioChunk', payload: { source: 'assistant' } }), { ...sinks, activeTtsPlayback })
    expect(activeTtsPlayback.active).toBe(true)
    expect(events.states.at(-1)).toBe('speaking')
  })

  it('prevents assistant text updates from downgrading active TTS speaking', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: true }

    applyVoiceAssistantUpdate(assistantUpdate({ kind: 'delta', textDelta: 'text while speaking' }), { ...sinks, activeTtsPlayback })
    applyVoiceAssistantUpdate(assistantUpdate({ kind: 'completed', text: 'done' }), { ...sinks, activeTtsPlayback })

    expect(activeTtsPlayback.active).toBe(true)
    expect(events.shown).toEqual([])
    expect(events.states).toEqual([])
    expect(events.levels).toEqual([])
    expect(events.hidden).toEqual([])
  })

  it('does not initialize listening fallback for a generic voice overlay-mode while already speaking', () => {
    expect(shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice' },
      activeTtsPlayback: { active: true },
      voiceState: 'speaking',
    })).toBe(false)

    expect(shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice' },
      activeTtsPlayback: { active: false },
      voiceState: 'speaking',
    })).toBe(false)
  })

  it('keeps TTS started and audio chunk state authoritative when a generic voice overlay-mode follows', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: false }

    applyDirectTtsEvent(event({ kind: 'tts.started', topic: 'TTS.Started', busTopic: 'TTS.Started' }), { ...sinks, activeTtsPlayback })
    applyDirectTtsEvent(event({ kind: 'tts.audio_chunk', topic: 'TTS.AudioChunk', busTopic: 'TTS.AudioChunk', payload: { audioData: 'AAAA' } }), { ...sinks, activeTtsPlayback })

    const lastLevel = events.levels.at(-1)
    const shouldInitialize = shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice' },
      activeTtsPlayback,
      voiceState: events.states.at(-1) ?? 'listening',
    })

    if (shouldInitialize) {
      sinks.setVoiceState('listening')
      sinks.setLevel({ level: 0.16, peak: 0.216, source: 'synthetic' })
    }

    expect(shouldInitialize).toBe(false)
    expect(events.states.at(-1)).toBe('speaking')
    expect(events.levels.at(-1)).toBe(lastLevel)
  })

  it('keeps direct TTS speaking authoritative across user voice startup and generic fallback', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: false }
    const activeVoiceSession = { active: true, sessionId: 'session-1', correlationId: null }
    const runtimeSinks = {
      ...sinks,
      getVoiceState: () => events.states.at(-1) ?? 'listening' as AuroraVoiceOverlayState,
      activeVoiceSession,
      activeTtsPlayback,
    }

    applyDirectTtsEvent(event({ kind: 'tts.started', topic: 'TTS.Started', busTopic: 'TTS.Started' }), { ...sinks, activeTtsPlayback })
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'session_started', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'audio_started', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'wakeword_detected', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'audio_level', sessionId: 'session-1', level: 0.72 }), runtimeSinks)

    const shouldInitialize = shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice' },
      activeTtsPlayback,
      voiceState: events.states.at(-1) ?? 'listening',
    })

    if (shouldInitialize) {
      sinks.setVoiceState('listening')
      sinks.setLevel({ level: 0.16, peak: 0.216, source: 'synthetic' })
    }

    expect(shouldInitialize).toBe(false)
    expect(activeTtsPlayback.active).toBe(true)
    expect(activeVoiceSession).toEqual({ active: true, sessionId: 'session-1', correlationId: null })
    expect(events.shown).toEqual(['voice'])
    expect(events.states).toEqual(['speaking'])
    expect(events.states).not.toContain('listening')
    expect(events.levels.at(-1)?.source).toBe('synthetic')
  })

  it('keeps current speaking state authoritative even when active TTS flag is absent', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: false }
    const activeVoiceSession = { active: true, sessionId: 'session-1', correlationId: null }
    const runtimeSinks = {
      ...sinks,
      getVoiceState: () => 'speaking' as AuroraVoiceOverlayState,
      activeVoiceSession,
      activeTtsPlayback,
    }

    applyVoiceRuntimeEvent(voiceEvent({ kind: 'session_started', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'audio_started', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'wakeword_detected', sessionId: 'session-2' }), runtimeSinks)
    applyVoiceRuntimeEvent(voiceEvent({ kind: 'audio_level', sessionId: 'session-1', level: 0.72 }), runtimeSinks)

    expect(activeTtsPlayback.active).toBe(false)
    expect(activeVoiceSession).toEqual({ active: true, sessionId: 'session-1', correlationId: null })
    expect(events.shown).toEqual([])
    expect(events.states).toEqual([])
    expect(events.levels).toEqual([])
  })

  it('treats voice startup as a new user session only when not speaking', () => {
    const { events, sinks } = recorder()
    const activeTtsPlayback = { active: false }
    const activeVoiceSession = { active: false, sessionId: null, correlationId: null }
    const runtimeSinks = {
      ...sinks,
      getVoiceState: () => 'listening' as AuroraVoiceOverlayState,
      activeVoiceSession,
      activeTtsPlayback,
    }

    applyVoiceRuntimeEvent(voiceEvent({ kind: 'session_started', sessionId: 'session-2' }), runtimeSinks)

    expect(activeTtsPlayback.active).toBe(false)
    expect(activeVoiceSession).toEqual({ active: true, sessionId: 'session-2', correlationId: null })
    expect(events.shown).toEqual(['voice'])
    expect(events.states).toEqual(['listening'])
    expect(events.levels.at(-1)?.source).toBe('synthetic')
  })

  it('only initializes generic voice fallback when entering voice outside active TTS or processing', () => {
    expect(shouldInitializeVoiceListeningFallback({
      previousMode: 'hidden',
      payload: { mode: 'voice' },
      activeTtsPlayback: { active: false },
      voiceState: 'listening',
    })).toBe(true)
    expect(shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice' },
      activeTtsPlayback: { active: false },
      voiceState: 'processing',
    })).toBe(false)
    expect(shouldInitializeVoiceListeningFallback({
      previousMode: 'voice',
      payload: { mode: 'voice', reason: 'wakeword' },
      activeTtsPlayback: { active: false },
      voiceState: 'processing',
    })).toBe(true)
  })

  it('clears active TTS only for explicit TTS stop/pause/error', () => {
    const activeTtsPlayback = { active: true }
    const activeVoiceSession = { active: true, sessionId: 'session-1', correlationId: null }
    const { events, sinks } = recorder()
    const runtimeSinks = {
      ...sinks,
      getVoiceState: () => 'speaking' as AuroraVoiceOverlayState,
      activeVoiceSession,
      activeTtsPlayback,
    }

    applyVoiceRuntimeEvent(voiceEvent({ kind: 'transcription_final' }), runtimeSinks)
    expect(activeTtsPlayback.active).toBe(true)
    expect(events.states).toEqual([])

    applyVoiceRuntimeEvent(voiceEvent({ kind: 'session_started', sessionId: 'session-2' }), runtimeSinks)
    expect(activeTtsPlayback.active).toBe(true)
    expect(events.states).toEqual([])

    activeTtsPlayback.active = true
    applyDirectTtsEvent(event({ kind: 'tts.stopped', topic: 'TTS.Stopped', busTopic: 'TTS.Stopped' }), { ...sinks, activeTtsPlayback })
    expect(activeTtsPlayback.active).toBe(false)
    expect(events.hidden.length).toBeGreaterThan(0)
  })
})
