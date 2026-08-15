export type AuroraVoiceWebCapabilityName = 'vad' | 'kws' | 'stt' | 'tts'

export interface AuroraVoiceWebCapabilities {
  readonly vad: boolean
  readonly kws: boolean
  readonly stt: boolean
  readonly tts: boolean
}

export const AURORA_VOICE_WEB_DEFAULT_CAPABILITIES: AuroraVoiceWebCapabilities = Object.freeze({
  vad: false,
  kws: false,
  stt: false,
  tts: false
})

export type AuroraVoiceLifecycleReason =
  | 'visible'
  | 'hidden'
  | 'frozen'
  | 'pagehide'
  | 'discarded'
  | 'ineligible'
  | 'cancelled'
  | 'stopped'

export interface AuroraVoiceLifecycleEligibility {
  readonly foregroundOnly: true
  readonly visible: boolean
  readonly frozen: boolean
  readonly eligible: boolean
  readonly reason: AuroraVoiceLifecycleReason
}

export type AuroraVoiceWebState = 'idle' | 'active' | 'cancelled' | 'stopped'

export type AuroraVoiceTurnFinishOutcome = 'completed' | 'abandoned'

export interface AuroraVoiceWebSession {
  readonly ownerId: string
  readonly sessionId: string
  readonly generation: number
  readonly startedAtMs: number
  readonly foregroundOnly: true
}

export interface AuroraPcmFrame {
  readonly sessionId: string
  readonly generation: number
  readonly sequence: number
  readonly discontinuity?: boolean
  readonly sampleRateHz: 16000
  readonly channels: 1
  readonly pcm: Int16Array
}

export interface AuroraPcmFrameEnvelope {
  readonly sessionId: string
  readonly generation: number
  readonly sequence: number
  readonly discontinuity: boolean
  readonly sampleRateHz: 16000
  readonly channels: 1
  readonly sampleCount: number
  readonly byteLength: number
  readonly queuedBytes: number
}

export interface AuroraCapturedAudio {
  readonly sessionId: string
  readonly generation: number
  readonly sampleRateHz: 16000
  readonly channels: 1
  readonly sampleCount: number
  readonly durationMs: number
  readonly pcm: Int16Array
  readonly redacted: true
}

export type AuroraVoiceWebModelTask = 'vad' | 'kws' | 'stt' | 'tts'
export type AuroraVoiceWebModelFamily =
  | 'silero-vad'
  | 'moonshine'
  | 'whisper'
  | 'sense-voice'
  | 'sherpa-kws-transducer'
  | 'piper'
  | 'pockettts'
export type AuroraVoiceWebModelKind = 'vad' | 'offline-asr' | 'keyword-spotter' | 'offline-tts'
export type AuroraVoiceWebModelFileRole =
  | 'model'
  | 'encoder'
  | 'decoder'
  | 'mergedDecoder'
  | 'tokens'
  | 'joiner'
  | 'keywords'
  | 'bpeVocab'
  | 'lexicon'
  | 'dataDir'
  | 'lmFlow'
  | 'lmMain'
  | 'textConditioner'
  | 'vocabJson'
  | 'tokenScoresJson'
  | 'referenceAudio'

export interface AuroraVoiceWebModelFileReference {
  readonly role: AuroraVoiceWebModelFileRole
  readonly fileId: string
  readonly virtualPath: string
}

export interface AuroraVoiceWebModelDescriptor {
  readonly task: AuroraVoiceWebModelTask
  readonly family: AuroraVoiceWebModelFamily
  readonly kind: AuroraVoiceWebModelKind
  readonly files: readonly AuroraVoiceWebModelFileReference[]
  readonly config?: {
    readonly language?: string
    readonly task?: string
    readonly keywords?: string
    readonly keywordsScore?: number
    readonly keywordsThreshold?: number
    readonly voiceId?: string
    readonly speakerId?: number
    readonly speed?: number
    readonly noiseScale?: number
    readonly noiseScaleW?: number
    readonly lengthScale?: number
    readonly referenceText?: string
    readonly referenceSampleRateHz?: number
  }
}

export interface AuroraVoiceWebModelFileBinding {
  readonly task: AuroraVoiceWebModelTask
  readonly fileId: string
  readonly virtualPath: string
  readonly sha256: string
  readonly byteLength: number
  readonly bytes: Uint8Array
}

export interface AuroraVoiceWebModelBindings {
  readonly files: readonly AuroraVoiceWebModelFileBinding[]
  readonly models: readonly AuroraVoiceWebModelDescriptor[]
}

export interface AuroraVoiceVadState {
  readonly active: boolean
  readonly speechDetected: boolean
  readonly sequence: number
  readonly redacted: true
}

export interface AuroraVoiceKwsHit {
  readonly keyword: string
  readonly score: number | null
  readonly sequence: number
  readonly redacted: true
}

export interface AuroraVoiceSttResult {
  readonly text: string
  readonly final: boolean
  readonly sequence: number
  readonly redacted: true
}

export interface AuroraVoiceInferenceOutput {
  readonly vad?: AuroraVoiceVadState
  readonly kwsHits: readonly AuroraVoiceKwsHit[]
  readonly stt: readonly AuroraVoiceSttResult[]
  readonly redacted: true
}

export interface AuroraVoiceTtsRequest {
  readonly text: string
  readonly generation?: number
  readonly voiceId?: string
  readonly speakerId?: number
  readonly speed?: number
}

export interface AuroraVoiceTtsAudio {
  readonly generation: number
  readonly sampleRateHz: number
  readonly channels: 1
  readonly sampleCount: number
  readonly durationMs: number
  readonly pcm: Int16Array
  readonly redacted: true
}

export type AuroraVoiceWebEventKind =
  | 'session_started'
  | 'session_stopped'
  | 'session_cancelled'
  | 'lifecycle_lost'
  | 'frame_accepted'
  | 'frame_dropped'
  | 'voice_inference'
  | 'error'

export interface AuroraVoiceWebEvent {
  readonly kind: AuroraVoiceWebEventKind
  readonly ownerId: string
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

export type AuroraVoiceWebEventListener = (event: AuroraVoiceWebEvent) => void

export interface AuroraAudioWorkletPcmSource {
  start(session: AuroraVoiceWebSession, sink: AuroraAudioWorkletPcmSink): Promise<void>
  stop(sessionId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
}

export interface AuroraAudioWorkletPcmSink {
  pushFrame(frame: AuroraPcmFrame): Promise<boolean>
}

export const AURORA_VOICE_WORKER_PROTOCOL_VERSION = 1
export const AURORA_VOICE_WORKER_MAX_REQUEST_ID = 2_147_483_647

export type AuroraVoiceWorkerCommand =
  | {
      readonly type: 'init'
      readonly protocolVersion: typeof AURORA_VOICE_WORKER_PROTOCOL_VERSION
      readonly maxFrameSamples: number
      readonly maxQueuedBytes: number
      readonly modelBindings?: AuroraVoiceWebModelBindings
    }
  | {
      readonly type: 'start'
      readonly session: AuroraVoiceWebSession
      readonly capabilities: AuroraVoiceWebCapabilities
    }
  | {
      readonly type: 'audio_frame'
      readonly frame: AuroraPcmFrameEnvelope
      readonly pcm: Int16Array
    }
  | {
      readonly type: 'stop'
      readonly sessionId: string
      readonly generation: number
    }
  | {
      readonly type: 'finish_turn'
      readonly sessionId: string
      readonly generation: number
      readonly outcome: AuroraVoiceTurnFinishOutcome
    }
  | {
      readonly type: 'synthesize_tts'
      readonly generation: number
      readonly text: string
      readonly voiceId?: string
      readonly speakerId?: number
      readonly speed?: number
    }
  | {
      readonly type: 'cancel'
      readonly sessionId: string | null
      readonly generation: number
      readonly reason: string
    }
  | {
      readonly type: 'shutdown'
      readonly generation: number
      readonly reason: string
    }

export type AuroraVoiceWorkerResponse =
  | {
      readonly type: 'ready'
      readonly protocolVersion: typeof AURORA_VOICE_WORKER_PROTOCOL_VERSION
      readonly capabilities: AuroraVoiceWebCapabilities
      readonly maxFrameSamples: number
      readonly maxQueuedBytes: number
    }
  | {
      readonly type: 'ack'
      readonly sessionId: string
      readonly generation: number
      readonly sequence: number | null
      readonly inference?: AuroraVoiceInferenceOutput
    }
  | {
      readonly type: 'reject'
      readonly sessionId: string | null
      readonly generation: number
      readonly sequence: number | null
      readonly reason: string
    }
  | {
      readonly type: 'stop_result'
      readonly sessionId: string
      readonly generation: number
      readonly capturedAudio: AuroraCapturedAudio
    }
  | {
      readonly type: 'tts_result'
      readonly generation: number
      readonly audio: AuroraVoiceTtsAudio
    }

export interface AuroraVoiceWorkerRequestEnvelope {
  readonly protocolVersion: typeof AURORA_VOICE_WORKER_PROTOCOL_VERSION
  readonly requestId: number
  readonly command: AuroraVoiceWorkerCommand
}

export interface AuroraVoiceWorkerResponseEnvelope {
  readonly protocolVersion: typeof AURORA_VOICE_WORKER_PROTOCOL_VERSION
  readonly requestId: number
  readonly response: AuroraVoiceWorkerResponse
}

export interface AuroraVoiceWorkerRequestOptions {
  readonly transfer?: readonly Transferable[]
  readonly timeoutMs?: number
}

export interface AuroraVoiceWorkerHost {
  request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse>
  shutdown?(): void
}

export interface AuroraVoiceWebRuntimeOptions {
  readonly ownerId: string
  readonly worker: AuroraVoiceWorkerHost
  readonly pcmSource?: AuroraAudioWorkletPcmSource
  readonly lifecycle?: () => AuroraVoiceLifecycleEligibility
  readonly maxFrameSamples?: number
  readonly maxQueuedBytes?: number
  readonly workerTimeoutMs?: number
  readonly ttsTimeoutMs?: number
  readonly modelBindings?: AuroraVoiceWebModelBindings
  readonly nowMs?: () => number
  readonly sessionIdFactory?: (ownerId: string, generation: number) => string
}

export interface AuroraVoiceWebRuntimeSnapshot {
  readonly ownerId: string
  readonly state: AuroraVoiceWebState
  readonly sessionId: string | null
  readonly generation: number
  readonly nextSequence: number
  readonly queuedBytes: number
  readonly capabilities: AuroraVoiceWebCapabilities
  readonly lifecycle: AuroraVoiceLifecycleEligibility
}

export class AuroraVoiceWebRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuroraVoiceWebRuntimeError'
    this.code = code
  }
}
