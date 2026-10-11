'use client'

import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AssistantRoutePolicy, AssistantStreamUpdate, AuroraClient, AuroraError } from '@aurora/client'
import type { AuroraVoiceTtsAudio } from '@aurora/voice-web'
import type { AssistantStreamState, AssistantUiMessage } from './assistant-view'

interface StreamedTtsAudioPlayback {
  readonly audio: HTMLAudioElement
  readonly url: string
  released: boolean
}

export interface AssistantBrowserTtsRuntime {
  synthesizeSpeech(input: { text: string; voiceId: string; generation: number }): Promise<AuroraVoiceTtsAudio>
}

export interface UseAssistantTtsOptions {
  client: Pick<AuroraClient, 'assistant'>
  sessionId: string | null
  usesLocalSidecar: boolean
  browserLocalTtsVoiceId: string | undefined
  resolveReadAloudRoutePolicy: () => AssistantRoutePolicy | null
  browserVoiceRuntime: () => Promise<AssistantBrowserTtsRuntime>
  cancelBrowserVoiceRuntime: (reason: string) => Promise<void>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  setLastError: (message: string | null) => void
  productAssistantErrorCopy: (error: AuroraError | Error) => string
}

export interface UseAssistantTtsResult {
  speakingMessageId: string | null
  speakingMessageIdRef: MutableRefObject<string | null>
  lastAssistantMessageIdRef: MutableRefObject<string | null>
  browserVoiceRemoteTtsAudioSeenRef: MutableRefObject<boolean>
  setSpeakingMessageId: (next: string | null) => void
  enqueueStreamedTtsAudio: (update: AssistantStreamUpdate) => void
  enqueueBrowserTtsAudio: (audio: AuroraVoiceTtsAudio) => boolean
  stopStreamedTtsPlayback: () => void
  readAssistantMessageAloud: (message: AssistantUiMessage) => Promise<void>
  synthesizeBrowserReadAloud: (textToSpeak: string, messageId?: string | null) => Promise<boolean>
  interruptTtsForVoiceCapture: () => Promise<void>
  invalidateReadAloudFallback: () => void
}

export function useAssistantTts({
  client,
  sessionId,
  usesLocalSidecar,
  browserLocalTtsVoiceId,
  resolveReadAloudRoutePolicy,
  browserVoiceRuntime,
  cancelBrowserVoiceRuntime,
  setStreamState,
  setLastError,
  productAssistantErrorCopy,
}: UseAssistantTtsOptions): UseAssistantTtsResult {
  const readAloudFallbackTokenRef = useRef(0)
  const [speakingMessageId, setSpeakingMessageIdState] = useState<string | null>(null)
  const speakingMessageIdRef = useRef<string | null>(null)
  const lastAssistantMessageIdRef = useRef<string | null>(null)
  const streamedTtsQueueRef = useRef<string[]>([])
  const streamedTtsAudioRef = useRef<StreamedTtsAudioPlayback | null>(null)
  const browserVoiceRemoteTtsAudioSeenRef = useRef(false)

  function setSpeakingMessageId(next: string | null) {
    speakingMessageIdRef.current = next
    setSpeakingMessageIdState(next)
  }

  function invalidateReadAloudFallback() {
    readAloudFallbackTokenRef.current += 1
  }

  function enqueueStreamedTtsAudio(update: AssistantStreamUpdate) {
    const chunk = update.ttsAudio
    if (!chunk) return
    if (usesLocalSidecar) return
    if (chunk.final) {
      if (!streamedTtsAudioRef.current && streamedTtsQueueRef.current.length === 0) {
        setSpeakingMessageId(null)
      }
      return
    }
    if (!chunk.audioData) return
    browserVoiceRemoteTtsAudioSeenRef.current = true
    enqueueTtsAudio(chunk.audioData, chunk.encoding ?? 'wav', chunk.mimeType)
  }

  function enqueueBrowserTtsAudio(audio: AuroraVoiceTtsAudio): boolean {
    if (typeof window === 'undefined' || typeof window.URL?.createObjectURL !== 'function') return false
    if (audio.sampleCount <= 0 || audio.pcm.length === 0) return false
    const url = window.URL.createObjectURL(new Blob([wavBytesFromPcm16(audio.pcm, audio.sampleRateHz)], { type: 'audio/wav' }))
    streamedTtsQueueRef.current.push(url)
    void drainStreamedTtsAudioQueue()
    return true
  }

  function enqueueTtsAudio(audioData: string, encoding: string, explicitMimeType?: string | null): boolean {
    if (typeof window === 'undefined' || typeof window.URL?.createObjectURL !== 'function') return false
    const bytes = base64ToUint8Array(audioData)
    if (bytes.byteLength === 0) return false
    const normalizedEncoding = encoding.toLowerCase()
    const mimeType = explicitMimeType ?? (normalizedEncoding === 'raw' ? 'audio/wav' : `audio/${normalizedEncoding}`)
    const url = window.URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    streamedTtsQueueRef.current.push(url)
    void drainStreamedTtsAudioQueue()
    return true
  }

  async function drainStreamedTtsAudioQueue() {
    if (streamedTtsAudioRef.current) return
    const nextUrl = streamedTtsQueueRef.current.shift()
    if (!nextUrl || typeof Audio === 'undefined') {
      if (!nextUrl) setSpeakingMessageId(null)
      return
    }
    const audio = new Audio(nextUrl)
    const playback: StreamedTtsAudioPlayback = { audio, url: nextUrl, released: false }
    streamedTtsAudioRef.current = playback
    const cleanup = () => {
      if (playback.released) return
      playback.released = true
      if (streamedTtsAudioRef.current === playback) streamedTtsAudioRef.current = null
      window.URL.revokeObjectURL(playback.url)
      void drainStreamedTtsAudioQueue()
    }
    audio.onended = cleanup
    audio.onerror = cleanup
    try {
      await audio.play()
    } catch {
      cleanup()
    }
  }

  function stopStreamedTtsPlayback() {
    const activePlayback = streamedTtsAudioRef.current
    streamedTtsAudioRef.current = null
    if (activePlayback && !activePlayback.released) {
      activePlayback.released = true
      activePlayback.audio.onended = null
      activePlayback.audio.onerror = null
      activePlayback.audio.pause()
      activePlayback.audio.removeAttribute('src')
      activePlayback.audio.load()
      window.URL.revokeObjectURL(activePlayback.url)
    }
    for (const url of streamedTtsQueueRef.current) {
      window.URL.revokeObjectURL(url)
    }
    streamedTtsQueueRef.current = []
    setSpeakingMessageId(null)
  }

  async function readAssistantMessageAloud(message: AssistantUiMessage) {
    const speakableText = message.text.trim()
    if (!speakableText) return
    if (speakingMessageIdRef.current === message.id) {
      await stopReadAloud('user_interrupt')
      return
    }
    setLastError(null)
    setSpeakingMessageId(message.id)
    lastAssistantMessageIdRef.current = message.id
    let routePolicy: AssistantRoutePolicy | null = null
    let routeResolved = false
    try {
      routePolicy = resolveReadAloudRoutePolicy()
      routeResolved = true
      if (!routePolicy) {
        setSpeakingMessageId(null)
        return
      }
      if (usesLocalSidecar) {
        const result = await client.assistant.requestReadAloud({
          text: speakableText,
          interrupt: true,
          routePolicy
        })
        if (!result.ok) throw result.error
        setStreamState((current) => ({ ...current, message: 'Reading assistant response through Aurora TTS.' }))
        return
      }
      if (browserLocalTtsVoiceId && !routePolicy.peerId) {
        await synthesizeBrowserReadAloud(speakableText, message.id)
        setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
        return
      }
      const result = await client.assistant.synthesizeReadAloud({
        text: speakableText,
        voice: null,
        speed: 1,
        format: 'wav',
        routePolicy
      })
      if (!result.ok) throw result.error
      if (!enqueueTtsAudio(result.data.audio_data, result.data.format)) {
        throw new Error('This device could not start audio playback.')
      }
      setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
    } catch (error) {
      if (routeResolved && !routePolicy?.peerId && browserReadAloud(speakableText, message.id)) {
        setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
        return
      }
      setSpeakingMessageId(null)
      setLastError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
    }
  }

  async function stopReadAloud(reason: string) {
    invalidateReadAloudFallback()
    stopStreamedTtsPlayback()
    await cancelBrowserVoiceRuntime(reason)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    const result = await client.assistant.cancel({
      sessionId,
      scopes: ['tts_playback'],
      reason
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
  }

  async function synthesizeBrowserReadAloud(textToSpeak: string, messageId: string | null = null): Promise<boolean> {
    if (!browserLocalTtsVoiceId) return false
    const token = readAloudFallbackTokenRef.current + 1
    readAloudFallbackTokenRef.current = token
    if (messageId) setSpeakingMessageId(messageId)
    const runtime = await browserVoiceRuntime()
    const audio = await runtime.synthesizeSpeech({
      text: textToSpeak,
      voiceId: browserLocalTtsVoiceId,
      generation: token
    })
    if (readAloudFallbackTokenRef.current !== token) return false
    if (!enqueueBrowserTtsAudio(audio)) throw new Error('This device could not start audio playback.')
    return true
  }

  function browserReadAloud(textToSpeak: string, messageId: string | null = null): boolean {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(textToSpeak)
    const token = readAloudFallbackTokenRef.current
    if (messageId) setSpeakingMessageId(messageId)
    utterance.onend = () => {
      if (readAloudFallbackTokenRef.current === token && (!messageId || speakingMessageIdRef.current === messageId)) {
        setSpeakingMessageId(null)
      }
    }
    utterance.onerror = () => {
      if (readAloudFallbackTokenRef.current === token && (!messageId || speakingMessageIdRef.current === messageId)) {
        setSpeakingMessageId(null)
      }
    }
    window.speechSynthesis.speak(utterance)
    return true
  }

  async function interruptTtsForVoiceCapture() {
    if (speakingMessageIdRef.current) setSpeakingMessageId(null)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    const result = await client.assistant.cancel({
      sessionId,
      scopes: ['tts_playback'],
      reason: 'voice_capture_started'
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
  }

  return {
    speakingMessageId,
    speakingMessageIdRef,
    lastAssistantMessageIdRef,
    browserVoiceRemoteTtsAudioSeenRef,
    setSpeakingMessageId,
    enqueueStreamedTtsAudio,
    enqueueBrowserTtsAudio,
    stopStreamedTtsPlayback,
    readAssistantMessageAloud,
    synthesizeBrowserReadAloud,
    interruptTtsForVoiceCapture,
    invalidateReadAloudFallback,
  }
}

export function base64ToUint8Array(value: string): Uint8Array {
  if (typeof atob !== 'function') return new Uint8Array()
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function wavBytesFromPcm16(pcm: Int16Array, sampleRateHz: number): Uint8Array {
  const headerBytes = 44
  const dataBytes = pcm.length * 2
  const bytes = new Uint8Array(headerBytes + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRateHz, true)
  view.setUint32(28, sampleRateHz * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(headerBytes + index * 2, pcm[index] ?? 0, true)
  }
  return bytes
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
