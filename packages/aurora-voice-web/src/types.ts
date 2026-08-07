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

export type AuroraVoiceWebEventKind =
  | 'session_started'
  | 'session_stopped'
  | 'session_cancelled'
  | 'lifecycle_lost'
  | 'frame_accepted'
  | 'frame_dropped'
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
