import type { MeshSpeechStageCapabilityExportV1, MeshSpeechStageCapabilityV1 } from '../mesh.js'
import type { GeneratedBackendMethodParsedInput } from '../generated-contracts.js'
import { generatedPeerHostMethodDescriptor, PeerHostContractRegistry } from './contract-registry.js'

const MAX_STT_BYTES = 4 * 1024 * 1024
const MAX_STT_SAMPLES = 16_000 * 60
const MAX_TTS_SAMPLES_PER_SECOND = 192_000
const MAX_TTS_SECONDS = 60
const MIN_TTS_SAMPLE_RATE_HZ = 8_000

export interface PeerHostLocalSpeechStage {
  readonly enabled: boolean
  readonly modelId: string | null
  readonly language: string | null
  readonly voiceId?: string | null
  readonly implementation?: MeshSpeechStageCapabilityV1['implementation']
}

export interface PeerHostLocalSpeechOptions {
  readonly peerId: string
  readonly runtime: PeerHostLocalSpeechRuntimePort
  readonly stt?: PeerHostLocalSpeechStage
  readonly tts?: PeerHostLocalSpeechStage
  readonly revision: number
}

export interface PeerHostLocalSpeechRuntimePort {
  transcribeSpeech(request: { readonly pcm: Int16Array; readonly language?: string }): Promise<{ readonly text: string }>
  synthesizeSpeech(request: { readonly text: string; readonly voiceId: string; readonly speed?: number }): Promise<{
    readonly pcm: Int16Array
    readonly sampleRateHz: number
    readonly durationMs: number
  }>
  cancel(reason?: string): Promise<void>
}

export interface PeerHostLocalSpeechSource {
  register(registry: PeerHostContractRegistry): void
  capabilities(): readonly MeshSpeechStageCapabilityExportV1[]
  setReady(readiness: { readonly stt: boolean; readonly tts: boolean }): void
  setVisible(visible: boolean): void
  close(): Promise<void>
}

/** Registers only explicitly shared, initialized local finite speech methods. */
export function createPeerHostLocalSpeechSource(options: PeerHostLocalSpeechOptions): PeerHostLocalSpeechSource {
  let visible = true
  let closed = false
  let registeredRegistry: PeerHostContractRegistry | null = null
  let activeOperation: object | null = null
  const ownedMethods = new Map<string, object>()
  const ready = {
    stt: options.stt?.enabled === true && nonEmpty(options.stt.modelId),
    tts: options.tts?.enabled === true && nonEmpty(options.tts.voiceId),
  }
  const stages = {
    stt: options.stt?.enabled && nonEmpty(options.stt.modelId) ? options.stt : undefined,
    tts: options.tts?.enabled && nonEmpty(options.tts.voiceId) ? options.tts : undefined,
  }
  const checkLive = (signal: AbortSignal, stage: 'stt' | 'tts') => {
    if (closed || !visible || !ready[stage] || signal.aborted) throw new Error('Local speech provider is unavailable')
  }
  const acquireOperation = () => {
    if (activeOperation !== null) throw new Error('Local speech engine is busy')
    const operation = {}
    activeOperation = operation
    const release = () => {
      if (activeOperation === operation) activeOperation = null
    }
    return { operation, release }
  }
  const bindAbort = (signal: AbortSignal, operation: object) => {
    const cancel = () => {
      if (activeOperation === operation) void options.runtime.cancel('peer_request_aborted').catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }
  const source: PeerHostLocalSpeechSource = {
    register(registry) {
      if (registeredRegistry && registeredRegistry !== registry) throw new Error('Local speech methods already belong to another peer host')
      registeredRegistry = registry
      if (stages.stt) {
        const descriptor = generatedPeerHostMethodDescriptor('Transcription.Transcribe', async (input, context) => {
        checkLive(context.signal, 'stt')
        validateSttSelector(input, stages.stt!, options.peerId)
        const pcm = decodeRawPcm(input.audio_data)
        if (pcm.length === 0 || pcm.length > MAX_STT_SAMPLES || pcm.byteLength > MAX_STT_BYTES) {
          throw new Error('Audio is outside the supported local transcription limit')
        }
        const operation = acquireOperation()
        const cleanup = bindAbort(context.signal, operation.operation)
        try {
          const result = await options.runtime.transcribeSpeech({
            pcm,
            ...(stages.stt!.language !== null ? { language: stages.stt!.language } : {}),
          })
          checkLive(context.signal, 'stt')
          return {
            confidence: null,
            duration_ms: pcm.length / 16,
            language: stages.stt!.language,
            model_used: stages.stt!.modelId!,
            text: result.text,
          }
        } finally {
          cleanup()
          operation.release()
        }
        }, { maxRequestBytes: Math.ceil(MAX_STT_BYTES * 4 / 3) + 16_384, maxConcurrent: 1, timeoutMs: 60_000 })
        registry.replace(descriptor)
        ownedMethods.set(descriptor.methodId, descriptor)
      }

      if (stages.tts) {
        const descriptor = generatedPeerHostMethodDescriptor('TTS.Synthesize', async (input, context) => {
        checkLive(context.signal, 'tts')
        validateTtsSelector(input, stages.tts!, options.peerId)
        const operation = acquireOperation()
        const cleanup = bindAbort(context.signal, operation.operation)
        try {
          const audio = await options.runtime.synthesizeSpeech({
            text: input.text,
            voiceId: stages.tts!.voiceId!,
            ...(input.speed === undefined ? {} : { speed: input.speed }),
          })
          checkLive(context.signal, 'tts')
          if (!(audio.pcm instanceof Int16Array) || audio.pcm.length === 0 ||
            !isSupportedSampleRate(audio.sampleRateHz) ||
            audio.pcm.length > audio.sampleRateHz * MAX_TTS_SECONDS ||
            !Number.isFinite(audio.durationMs) || audio.durationMs < 0 || audio.durationMs > MAX_TTS_SECONDS * 1_000) {
            throw new Error('Synthesized audio is outside the supported local limit')
          }
          const sampleRate = input.sample_rate ?? audio.sampleRateHz
          if (!isSupportedSampleRate(sampleRate)) {
            throw new Error('Requested sample rate is outside the supported local limit')
          }
          const pcm = sampleRate === audio.sampleRateHz ? audio.pcm : resamplePcm(audio.pcm, audio.sampleRateHz, sampleRate)
          return {
            audio_data: encodeBase64(encodeWav(pcm, sampleRate)),
            channels: 1,
            duration_ms: audio.durationMs,
            format: 'wav',
            sample_rate: sampleRate,
            text: input.text,
          }
        } finally {
          cleanup()
          operation.release()
        }
        }, { maxRequestBytes: 16_384, maxConcurrent: 1, timeoutMs: 120_000 })
        registry.replace(descriptor)
        ownedMethods.set(descriptor.methodId, descriptor)
      }
    },
    capabilities() {
      if (closed || !visible) return []
      return [
        ...(stages.stt && ready.stt ? [speechCapability('stt', options.peerId, options.revision, stages.stt.modelId!, stages.stt.language, 'Transcription.Transcribe', undefined, stages.stt.implementation)] : []),
        ...(stages.tts && ready.tts ? [speechCapability('tts', options.peerId, options.revision, stages.tts.modelId, stages.tts.language, 'TTS.Synthesize', stages.tts.voiceId!, stages.tts.implementation)] : []),
      ]
    },
    setReady(readiness) {
      ready.stt = Boolean(stages.stt && readiness.stt)
      ready.tts = Boolean(stages.tts && readiness.tts)
    },
    setVisible(value) {
      visible = value
      if (!value) void options.runtime.cancel('page_hidden').catch(() => undefined)
    },
    async close() {
      closed = true
      visible = false
      for (const [methodId, descriptor] of ownedMethods) registeredRegistry?.unregister(methodId, descriptor)
      ownedMethods.clear()
      await options.runtime.cancel('provider_closed').catch(() => undefined)
    },
  }
  return source
}

type SttInput = GeneratedBackendMethodParsedInput<'Transcription.Transcribe'>
type TtsInput = GeneratedBackendMethodParsedInput<'TTS.Synthesize'>

function validateSttSelector(input: SttInput, stage: PeerHostLocalSpeechStage, peerId: string): void {
  if (!matchesLocalSelector(input.mesh_selector, peerId, 'Transcription') || input.format !== 'raw' || input.sample_rate !== 16_000 || input.channels !== 1 || input.model !== stage.modelId) {
    throw new Error('Transcription request does not match the selected local model')
  }
  if (input.language !== null && input.language !== stage.language) throw new Error('Transcription language is unavailable locally')
  if ((input.auto_language_candidates?.length ?? 0) > 0) throw new Error('Automatic language selection is unavailable locally')
}

function validateTtsSelector(input: TtsInput, stage: PeerHostLocalSpeechStage, peerId: string): void {
  if (!matchesLocalSelector(input.mesh_selector, peerId, 'TTS') || input.format !== 'wav' ||
    (input.model_id !== null && input.model_id !== undefined && input.model_id !== stage.modelId) ||
    (input.voice !== null && input.voice !== stage.voiceId)) {
    throw new Error('Synthesis request does not match the selected local voice')
  }
  if (input.language !== null && input.language !== stage.language) throw new Error('Synthesis language is unavailable locally')
}

function matchesLocalSelector(
  selector: unknown,
  peerId: string,
  module: 'Transcription' | 'TTS'
): boolean {
  if (selector == null) return true
  if (!isRecord(selector)) return false
  const fields = selector
  const resourceId = `remote:${peerId}:${module}`
  const hasIdentity = fields.peer_id != null || fields.service_instance_id != null
  return hasIdentity &&
    (fields.peer_id == null || fields.peer_id === peerId) &&
    (fields.service_instance_id == null || fields.service_instance_id === resourceId) &&
    fields.provider_id == null &&
    [fields.data_scope, fields.hardware_target, fields.resource_namespace, fields.tool_id]
      .every((value) => value === null || value === undefined)
}

function isSupportedSampleRate(sampleRate: number): boolean {
  return Number.isSafeInteger(sampleRate) && sampleRate >= MIN_TTS_SAMPLE_RATE_HZ && sampleRate <= MAX_TTS_SAMPLES_PER_SECOND
}

/** Convert PCM rate without changing its duration or pitch. */
function resamplePcm(pcm: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  const outputLength = Math.round(pcm.length * targetRate / sourceRate)
  if (outputLength <= 0 || outputLength > MAX_TTS_SAMPLES_PER_SECOND * MAX_TTS_SECONDS) {
    throw new Error('Resampled audio is outside the supported local limit')
  }
  const output = new Int16Array(outputLength)
  const sourceStep = sourceRate / targetRate
  for (let index = 0; index < output.length; index += 1) {
    const sourcePosition = index * sourceStep
    const left = Math.min(Math.floor(sourcePosition), pcm.length - 1)
    const right = Math.min(left + 1, pcm.length - 1)
    const fraction = sourcePosition - left
    output[index] = Math.round(pcm[left]! + (pcm[right]! - pcm[left]!) * fraction)
  }
  return output
}

function speechCapability(
  stage: 'stt' | 'tts', peerId: string, revision: number, modelId: string | null, language: string | null,
  methodId: string, voiceId?: string, implementation: MeshSpeechStageCapabilityV1['implementation'] = 'wasm'
): MeshSpeechStageCapabilityExportV1 {
  const stt = stage === 'stt'
  return {
    capability: {
      schema: 'speech-stage-capability.v1', stage, method_ids: [methodId], modes: ['finite'],
      implementation, peer_id: peerId, resource_id: `remote:${peerId}:${stt ? 'Transcription' : 'TTS'}`,
      capability_revision: revision, supported_formats: [stt ? 'raw' : 'wav'],
      sample_rates: stt ? [16_000] : [], channels: [1],
      supported_languages: language ? [language] : [], model_ids: modelId ? [modelId] : [],
      lifecycle: ['foreground'], max_input_bytes: stt ? MAX_STT_BYTES : 16_384,
      max_chunk_bytes: stt ? 64 * 1024 : 16_384, max_concurrent: 1,
      max_queue: 0, lease_ms: 15_000, readiness: 'ready', required_permissions: [methodId],
      audio_consent_required: true, experimental: false, exported: true,
    },
    voice_ids: voiceId ? [voiceId] : [],
    requires_remote_audio_egress: false,
  }
}

function decodeRawPcm(encoded: string): Int16Array {
  if (encoded.length === 0 || encoded.length > Math.ceil(MAX_STT_BYTES * 4 / 3) + 4) throw new Error('Audio is outside the supported local transcription limit')
  const binary = atob(encoded)
  if (binary.length > MAX_STT_BYTES || binary.length % 2 !== 0) throw new Error('Invalid local transcription audio')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Int16Array(bytes.buffer)
}

function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(wav.buffer)
  const ascii = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  ascii(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, pcm.byteLength, true)
  for (let index = 0; index < pcm.length; index += 1) view.setInt16(44 + index * 2, pcm[index]!, true)
  return wav
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return btoa(binary)
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
