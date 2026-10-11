'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { GeneratedContractClient, type GeneratedBackendClientMethodId } from '@aurora/client'
import type { AssistantVoiceRoutes, AuroraRuntimeProfileV2, AuroraShellSnapshot, RouteAvailability } from '@aurora/ui'
import type { AuroraBrowserRuntime } from './aurora-client'

const BrowserShellSnapshotContext = createContext<AuroraShellSnapshot | null>(null)
const BrowserRuntimeProfileContext = createContext<AuroraRuntimeProfileV2 | null>(null)
const BrowserRuntimeContext = createContext<AuroraBrowserRuntime | null>(null)

export function BrowserShellRuntimeProvider({
  runtime,
  snapshot,
  runtimeProfile = null,
  children,
}: {
  runtime: AuroraBrowserRuntime
  snapshot: AuroraShellSnapshot
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  children: ReactNode
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST !== '1') return
    const probe = createHostedPeerSpeechProbe(runtime)
    const target = window as typeof window & { __auroraHostedPeerSpeech?: typeof probe }
    target.__auroraHostedPeerSpeech = probe
    return () => {
      delete target.__auroraHostedPeerSpeech
      void probe.close()
    }
  }, [runtime])

  return (
    <BrowserRuntimeContext.Provider value={runtime}>
      <BrowserShellSnapshotContext.Provider value={snapshot}>
        <BrowserRuntimeProfileContext.Provider value={runtimeProfile}>
          {children}
        </BrowserRuntimeProfileContext.Provider>
      </BrowserShellSnapshotContext.Provider>
    </BrowserRuntimeContext.Provider>
  )
}

export function useBrowserShellRuntime(): AuroraBrowserRuntime {
  const runtime = useContext(BrowserRuntimeContext)
  if (!runtime) throw new Error('Aurora browser runtime is unavailable')
  return runtime
}

export function useOptionalBrowserShellRuntime(): AuroraBrowserRuntime | null {
  return useContext(BrowserRuntimeContext)
}

export function useBrowserRuntimeProfile(): AuroraRuntimeProfileV2 | null {
  return useContext(BrowserRuntimeProfileContext)
}

export function useBrowserRoute(
  fallback: RouteAvailability,
): RouteAvailability {
  const snapshot = useContext(BrowserShellSnapshotContext)
  return snapshot?.routes.find(
    (candidate) => candidate.item.id === fallback.item.id,
  ) ?? fallback
}

export function useBrowserCancellationRoute(
  fallback: RouteAvailability | undefined,
): RouteAvailability | undefined {
  const snapshot = useContext(BrowserShellSnapshotContext)
  return snapshot?.assistantCancellationRoute ?? fallback
}

export function useBrowserAssistantVoiceRoutes(
  fallback: AssistantVoiceRoutes | undefined,
): AssistantVoiceRoutes | undefined {
  const snapshot = useContext(BrowserShellSnapshotContext)
  if (!snapshot || snapshot.loadState === 'loading') return fallback
  return snapshot?.assistantVoiceRoutes ?? fallback
}


type HostedSpeechStage = 'kws' | 'vad'

function createHostedPeerSpeechProbe(runtime: AuroraBrowserRuntime) {
  let closed = false
  let activeRun: Promise<unknown> | null = null
  let activeAbort: AbortController | null = null

  const run = async (input: { peerId: string; foregroundAudioBase64: string; wakeAudioBase64: string }) => {
    if (closed || activeRun) throw new Error('Hosted speech check is unavailable')
    const controller = new AbortController()
    activeAbort = controller
    const work = runHostedSpeechCheck(runtime, input, controller.signal)
    activeRun = work
    try {
      return await work
    } finally {
      if (activeRun === work) activeRun = null
      if (activeAbort === controller) activeAbort = null
    }
  }

  return {
    run,
    async close() {
      if (closed) return
      closed = true
      activeAbort?.abort()
      await activeRun
    },
  }
}

async function runHostedSpeechCheck(
  runtime: AuroraBrowserRuntime,
  input: { peerId: string; foregroundAudioBase64: string; wakeAudioBase64: string },
  signal: AbortSignal,
) {
  if (!input || typeof input.peerId !== 'string' || input.peerId.length < 1 || input.peerId.length > 256
    || !isBoundedPcmBase64(input.foregroundAudioBase64)
    || !isBoundedPcmBase64(input.wakeAudioBase64)) {
    throw new Error('Hosted speech check input is invalid')
  }
  const foregroundPcm = decodeHostedBase64(input.foregroundAudioBase64)
  const wakePcm = decodeHostedBase64(input.wakeAudioBase64)
  const manifest = await runtime.peer.getManifest(input.peerId)
  if (!manifest || manifest.peerId !== input.peerId || manifest.trusted !== true || manifest.authenticated !== true) {
    throw new Error('The selected device is not currently authenticated')
  }
  const exported = (manifest.services ?? []).flatMap((service) => service.speechStageCapabilities ?? [])
  const stt = requireNativeCapability(exported, input.peerId, 'stt', 'Transcription.Transcribe')
  if (!stt.capability.supported_formats.includes('raw')
    || !stt.capability.sample_rates.includes(16_000)
    || !stt.capability.channels.includes(1)) {
    throw new Error('The selected device has no compatible native transcription format')
  }
  const ttsExport = exported.find((entry) => entry.capability.stage === 'tts'
    && entry.capability.peer_id === input.peerId
    && entry.capability.readiness === 'ready'
    && entry.capability.exported === true
    && entry.capability.implementation === 'native'
    && entry.capability.lifecycle.includes('foreground')
    && entry.capability.method_ids.includes('TTS.Synthesize')
    && entry.voice_ids.length === 1
    && entry.capability.model_ids.length <= 1
    && entry.capability.supported_formats.includes('wav'))
  if (!ttsExport) throw new Error('The selected device has no ready native voice')
  const kws = requireNativeCapability(exported, input.peerId, 'kws', 'WakeWord.StreamStart')
  const vad = requireNativeCapability(exported, input.peerId, 'vad', 'VAD.StreamStart')
  for (const capability of [kws, vad]) {
    if (!capability.capability.experimental || !capability.capability.modes.includes('streaming')
      || capability.capability.sample_rates.length !== 1 || capability.capability.sample_rates[0] !== 16_000
      || capability.capability.channels.length !== 1 || capability.capability.channels[0] !== 1
      || !capability.capability.supported_formats.includes('pcm_s16le')) {
      throw new Error('The selected device has no compatible foreground speech session')
    }
    const prefix = capability.capability.stage === 'kws' ? 'WakeWord' : 'VAD'
    const requiredMethods = ['StreamStart', 'StreamChunk', 'StreamEnd', 'StreamCancel', 'StreamStatus', 'StreamResult']
      .map((suffix) => `${prefix}.${suffix}`)
    if (requiredMethods.some((method) => !capability.capability.method_ids.includes(method))) {
      throw new Error('The selected device does not expose a complete foreground speech session')
    }
  }

  const client = new GeneratedContractClient({
    transport: { kind: 'mesh' },
    request: (method, payload, options) => runtime.client.requestPeer(input.peerId, method, payload, options),
  })
  const request = (method: GeneratedBackendClientMethodId, payload: unknown, requestSignal?: AbortSignal) =>
    client.request(method, payload as never, {
      timeoutMs: 120_000,
      ...(requestSignal ? { signal: requestSignal } : {}),
    })
  const language = oneSupportedLanguage(stt.capability.supported_languages)
  const transcription = await request('Transcription.Transcribe', {
    audio_data: input.foregroundAudioBase64,
    channels: 1,
    format: 'raw',
    language,
    mesh_selector: { peer_id: input.peerId, service_instance_id: `remote:${input.peerId}:Transcription` },
    model: requireOneModel(stt.capability.model_ids),
    sample_rate: 16_000,
  }, signal) as { text: string; duration_ms: number; model_used: string }
  if (!transcription.text.trim() || transcription.model_used !== stt.capability.model_ids[0]) {
    throw new Error('The selected device did not complete native transcription')
  }

  const ttsCapability = ttsExport.capability
  const speech = await request('TTS.Synthesize', {
    format: 'wav',
    language: oneSupportedLanguage(ttsCapability.supported_languages),
    mesh_selector: { peer_id: input.peerId, service_instance_id: `remote:${input.peerId}:TTS` },
    model_id: ttsCapability.model_ids.length === 1 ? ttsCapability.model_ids[0] : null,
    text: 'Aurora local speech check.',
    voice: ttsExport.voice_ids[0],
  }, signal) as { audio_data: string; duration_ms: number; format: string; sample_rate: number }
  const wav = decodeHostedBase64(speech.audio_data)
  if (speech.format !== 'wav' || speech.duration_ms <= 0 || wav.byteLength < 44
    || String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF'
    || String.fromCharCode(...wav.subarray(8, 12)) !== 'WAVE') {
    throw new Error('The selected device did not complete native speech synthesis')
  }

  const sessions: Array<{ stage: HostedSpeechStage; sessionId: string }> = []
  try {
    const kwsResult = await runHostedSpeechStage(request, input.peerId, 'kws', kws.capability, wakePcm, signal, sessions)
    const vadResult = await runHostedSpeechStage(request, input.peerId, 'vad', vad.capability, foregroundPcm, signal, sessions)
    return {
      sttCharacters: [...transcription.text.trim()].length,
      sttDurationMs: transcription.duration_ms,
      ttsBytes: wav.byteLength,
      ttsDurationMs: speech.duration_ms,
      kws: summarizeHostedStage(kwsResult),
      vad: summarizeHostedStage(vadResult),
    }
  } finally {
    const cleanup = await Promise.allSettled(sessions.map(async ({ stage, sessionId }) => {
      const prefix = stage === 'kws' ? 'WakeWord' : 'VAD'
      const resultMethod = `${prefix}.StreamResult` as GeneratedBackendClientMethodId
      try {
        const result = await request(resultMethod, { session_id: sessionId }) as { session_id?: string; state?: string }
        if (result.session_id === sessionId && ['completed', 'canceled', 'interrupted', 'revoked', 'timed_out', 'failed'].includes(result.state ?? '')) return
      } catch { /* retain the cleanup attempt below */ }
      const cancelMethod = `${prefix}.StreamCancel` as GeneratedBackendClientMethodId
      const canceled = await request(cancelMethod, { reason: 'interrupted', session_id: sessionId }) as { session_id?: string; state?: string }
      if (canceled.session_id !== sessionId || !['completed', 'canceled', 'interrupted', 'revoked', 'timed_out', 'failed'].includes(canceled.state ?? '')) {
        throw new Error('Native speech cancellation did not reach a terminal result')
      }
    }))
    if (cleanup.some((result) => result.status === 'rejected')) {
      throw new Error('The selected device did not release every hosted speech session')
    }
  }
}

async function runHostedSpeechStage(
  request: (method: GeneratedBackendClientMethodId, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
  peerId: string,
  stage: HostedSpeechStage,
  capability: import('@aurora/client/webrtc').MeshSpeechStageCapabilityV1,
  pcm: Uint8Array,
  signal: AbortSignal,
  sessions: Array<{ stage: HostedSpeechStage; sessionId: string }>,
) {
  const prefix = stage === 'kws' ? 'WakeWord' : 'VAD'
  if (signal.aborted) throw new Error('Hosted speech check was cancelled')
  const id = () => globalThis.crypto.randomUUID()
  const attemptId = id()
  const generation = 1
  const resource = capability.resource_id
  const start = await request(`${prefix}.StreamStart` as GeneratedBackendClientMethodId, {
    attempt_id: attemptId,
    capability_revision: capability.capability_revision,
    config_revision: 0,
    consent_revision: null,
    exact_selector: true,
    experimental_remote: true,
    generation,
    mode: 'streaming',
    operation_id: id(),
    remaining_deadline_ms: 60_000,
    request_id: id(),
    route_revision: id(),
    target_peer_id: peerId,
    target_resource_id: resource,
  }) as { status: string; session_id: string | null; accepted_limits?: { max_chunk_bytes?: number; max_input_bytes?: number } }
  if (start.session_id) sessions.push({ stage, sessionId: start.session_id })
  if (start.status !== 'admitted' || !start.session_id) throw new Error(`Native ${stage} session was not admitted`)
  const limits = start.accepted_limits
  const maxInput = limits?.max_input_bytes ?? capability.max_input_bytes
  const maxEncodedChunk = Math.min(limits?.max_chunk_bytes ?? capability.max_chunk_bytes, 48 * 1024)
  if (pcm.byteLength > maxInput || maxEncodedChunk <= 0) throw new Error(`Native ${stage} session limits are insufficient`)
  let sequence = 0
  for (let offset = 0; offset < pcm.byteLength; offset += maxEncodedChunk) {
    if (signal.aborted) throw new Error('Hosted speech check was cancelled')
    const chunk = pcm.subarray(offset, Math.min(offset + maxEncodedChunk, pcm.byteLength))
    const method = `${prefix}.StreamChunk` as GeneratedBackendClientMethodId
    await request(method, {
      attempt_id: attemptId,
      audio_data: encodeHostedBase64(chunk),
      generation,
      is_final: false,
      payload_kind: 'audio',
      payload_size_bytes: chunk.byteLength,
      sequence,
      session_id: start.session_id,
    }, signal)
    sequence += 1
  }
  const endMethod = `${prefix}.StreamEnd` as GeneratedBackendClientMethodId
  await request(endMethod, { final_sequence: sequence - 1, session_id: start.session_id }, signal)
  const statusMethod = `${prefix}.StreamStatus` as GeneratedBackendClientMethodId
  const status = await request(statusMethod, { session_id: start.session_id }, signal) as { state: string; session_id: string }
  const resultMethod = `${prefix}.StreamResult` as GeneratedBackendClientMethodId
  const result = await request(resultMethod, { session_id: start.session_id }) as { state: string; input_count?: number; output_count?: number }
  const retainedIndex = sessions.findIndex((session) => session.sessionId === start.session_id)
  if (retainedIndex < 0) throw new Error(`Native ${stage} session cleanup ownership was lost`)
  sessions.splice(retainedIndex, 1)
  if (result.state !== 'completed' || status.state === 'failed' || status.session_id !== start.session_id
    || !result.input_count || !result.output_count) {
    throw new Error(`Native ${stage} session did not complete actual audio processing`)
  }
  return result
}

function summarizeHostedStage(result: { state: string; input_count?: number; output_count?: number }) {
  return { state: result.state, inputCount: result.input_count ?? 0, outputCount: result.output_count ?? 0 }
}

function requireNativeCapability(
  exports: readonly import('@aurora/client/webrtc').MeshSpeechStageCapabilityExportV1[],
  peerId: string,
  stage: 'stt' | 'kws' | 'vad',
  method: string,
) {
  const matches = exports.filter(({ capability }) => capability.stage === stage
    && capability.peer_id === peerId
    && capability.readiness === 'ready'
    && capability.exported === true
    && capability.implementation === 'native'
    && capability.lifecycle.includes('foreground')
    && capability.method_ids.includes(method))
  if (matches.length !== 1) throw new Error(`The selected device does not have one ready native ${stage} stage`)
  if (stage === 'stt') requireOneModel(matches[0]!.capability.model_ids)
  return matches[0]!
}

function requireOneModel(modelIds: readonly string[]) {
  if (modelIds.length !== 1 || !modelIds[0]) throw new Error('The selected device has no exact native speech model')
  return modelIds[0]
}

function oneSupportedLanguage(languages: readonly string[]) {
  return languages.length === 1 ? languages[0] : null
}

function decodeHostedBase64(value: string): Uint8Array {
  if (typeof atob !== 'function') throw new Error('Hosted speech encoding is unavailable')
  let decoded: string
  try { decoded = atob(value) } catch { throw new Error('Hosted speech result is invalid') }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

function encodeHostedBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return btoa(binary)
}

function isBoundedPcmBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 6_000_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false
  const decodedBytes = Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  return decodedBytes > 0 && decodedBytes <= 4 * 1024 * 1024 && decodedBytes % 2 === 0
}
