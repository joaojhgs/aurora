import {
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  type AuroraCapturedAudio,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerHost,
  type AuroraVoiceWorkerRequestOptions,
  type AuroraVoiceWorkerResponse
} from '../types.js'

export class RecordingVoiceWorkerHost implements AuroraVoiceWorkerHost {
  readonly commands: AuroraVoiceWorkerCommand[] = []
  readonly transfers: Transferable[][] = []
  responseOverride: ((command: AuroraVoiceWorkerCommand) => AuroraVoiceWorkerResponse) | null = null

  async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    this.transfers.push([...(options?.transfer ?? [])])
    if (command.type === 'audio_frame') {
      this.commands.push({ ...command, pcm: new Int16Array(command.pcm) })
    } else {
      this.commands.push(command)
    }
    return this.responseOverride?.(command) ?? defaultResponse(command)
  }

  commandsOf<T extends AuroraVoiceWorkerCommand['type']>(type: T): Extract<AuroraVoiceWorkerCommand, { type: T }>[] {
    return this.commands.filter((command): command is Extract<AuroraVoiceWorkerCommand, { type: T }> => command.type === type)
  }

  serializedCommands(): string {
    return JSON.stringify(this.commands, (_key, value: unknown) => {
      if (value instanceof Int16Array) return { sampleCount: value.length, byteLength: value.byteLength }
      return value
    })
  }
}

function defaultResponse(command: AuroraVoiceWorkerCommand): AuroraVoiceWorkerResponse {
  switch (command.type) {
    case 'init':
      return {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities: { vad: false, kws: false, stt: false, tts: false },
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      }
    case 'start':
      return { type: 'ack', sessionId: command.session.sessionId, generation: command.session.generation, sequence: null }
    case 'audio_frame':
      return { type: 'ack', sessionId: command.frame.sessionId, generation: command.frame.generation, sequence: command.frame.sequence }
    case 'stop':
      return { type: 'stop_result', sessionId: command.sessionId, generation: command.generation, capturedAudio: capturedAudio(command.sessionId, command.generation, []) }
    case 'finish_turn':
      return { type: 'ack', sessionId: command.sessionId, generation: command.generation, sequence: null }
    case 'cancel':
      return { type: 'ack', sessionId: command.sessionId ?? '', generation: command.generation, sequence: null }
    case 'shutdown':
      return { type: 'ack', sessionId: '', generation: command.generation, sequence: null }
  }
}

export function capturedAudio(sessionId: string, generation: number, samples: readonly number[]): AuroraCapturedAudio {
  const pcm = Int16Array.from(samples)
  return Object.freeze({
    sessionId,
    generation,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: pcm.length,
    durationMs: Math.floor(pcm.length / 16),
    pcm,
    redacted: true
  })
}
