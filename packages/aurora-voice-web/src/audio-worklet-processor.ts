export const AURORA_AUDIO_WORKLET_PROCESSOR_NAME = 'aurora-voice-pcm-source'

export interface AuroraAudioWorkletProcessorPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  close(): void
}

interface ProcessorState {
  readonly sessionId: string
  readonly sampleRateHz: number
  sequence: number
  active: boolean
  closed: boolean
}

export class AuroraAudioWorkletProcessorCore {
  private readonly state: ProcessorState

  constructor(private readonly port: AuroraAudioWorkletProcessorPort, sessionId: string, sampleRateHz: number) {
    this.state = {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      sampleRateHz: Number.isFinite(sampleRateHz) ? Math.trunc(sampleRateHz) : 0,
      sequence: 0,
      active: true,
      closed: false
    }
    this.port.onmessage = (event) => this.handleControl(event.data)
  }

  process(inputs: readonly Float32Array[][]): boolean {
    if (!this.state.active || this.state.closed) return false
    const input = inputs[0]
    if (input === undefined) return true
    const firstChannel = input?.[0]
    if (firstChannel === undefined) return true
    const blockLength = firstChannel.length
    if (blockLength === 0) return true

    const mono = new Float32Array(blockLength)
    const channelCount = input.length
    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
      let sum = 0
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        sum += input[channelIndex]?.[sampleIndex] ?? 0
      }
      mono[sampleIndex] = sum / channelCount
    }

    this.port.postMessage({
      type: 'audio',
      sessionId: this.state.sessionId,
      sampleRateHz: this.state.sampleRateHz,
      sequence: this.state.sequence,
      samples: mono
    }, [mono.buffer])
    this.state.sequence += 1
    return true
  }

  private handleControl(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const message = data as Partial<{ type: string; sessionId: string; requestId: string }>
    if (message.sessionId !== this.state.sessionId) return
    if (message.type === 'stop') {
      this.close('stopped', message.requestId)
      return
    }
    if (message.type === 'cancel') {
      this.close('cancelled', message.requestId)
    }
  }

  private close(type: 'stopped' | 'cancelled', requestId: string | undefined): void {
    if (this.state.closed) return
    this.state.active = false
    this.state.closed = true
    this.port.postMessage({ type, requestId: typeof requestId === 'string' ? requestId : '' })
    this.port.close()
  }
}

declare const sampleRate: number

interface AudioWorkletRegistrationGlobal {
  AudioWorkletProcessor?: new () => { readonly port: MessagePort }
  registerProcessor?: (name: string, processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor) => void
}

interface AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][]): boolean
}

const registrationGlobal = globalThis as typeof globalThis & AudioWorkletRegistrationGlobal
if (
  typeof registrationGlobal.registerProcessor === 'function' &&
  typeof registrationGlobal.AudioWorkletProcessor === 'function'
) {
  const BaseAudioWorkletProcessor = registrationGlobal.AudioWorkletProcessor
  class AuroraAudioWorkletProcessor extends BaseAudioWorkletProcessor implements AudioWorkletProcessor {
    private readonly core: AuroraAudioWorkletProcessorCore

    constructor(options: AudioWorkletNodeOptions) {
      super()
      const processorOptions = options.processorOptions as { sessionId?: unknown } | undefined
      this.core = new AuroraAudioWorkletProcessorCore(
        this.port,
        typeof processorOptions?.sessionId === 'string' ? processorOptions.sessionId : '',
        sampleRate
      )
    }

    process(inputs: Float32Array[][]): boolean {
      return this.core.process(inputs)
    }
  }
  registrationGlobal.registerProcessor(AURORA_AUDIO_WORKLET_PROCESSOR_NAME, AuroraAudioWorkletProcessor)
}
