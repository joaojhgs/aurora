import {
  BrowserAudioWorkletPcmSource,
  type AuroraBrowserAudioLifecycleLostReason,
  type AuroraBrowserAudioWorkletSourceOptions
} from './audio-worklet-source.js'
import { AuroraVoiceWebRuntime } from './runtime.js'
import { buildAuroraVoiceWorkerUrl } from './worker-assets.js'
import {
  AuroraAcknowledgedWorkerHost,
  type AuroraBrowserWorkerPort
} from './worker-rpc.js'
import type {
  AuroraAudioWorkletPcmSource,
  AuroraVoiceLifecycleEligibility,
  AuroraVoiceWebRuntimeOptions
} from './types.js'

export interface AuroraBrowserVoiceRuntimeOptions {
  readonly ownerId: string
  readonly worker?: AuroraBrowserWorkerPort
  readonly workerFactory?: (url: URL, options: WorkerOptions) => AuroraBrowserWorkerPort
  readonly workerUrl?: URL
  readonly wasmUrl?: URL
  readonly pcmSource?: AuroraAudioWorkletPcmSource
  readonly lifecycle?: () => AuroraVoiceLifecycleEligibility
  readonly workerTimeoutMs?: number
  readonly audio?: AuroraBrowserAudioWorkletSourceOptions
  readonly onAudioLifecycleLost?: (reason: AuroraBrowserAudioLifecycleLostReason) => void
  readonly sessionIdFactory?: AuroraVoiceWebRuntimeOptions['sessionIdFactory']
  readonly nowMs?: () => number
}

export function createAuroraBrowserVoiceRuntime(options: AuroraBrowserVoiceRuntimeOptions): AuroraVoiceWebRuntime {
  let runtime: AuroraVoiceWebRuntime | null = null
  const worker = options.worker ?? createWorker(options.workerFactory, options.workerUrl, options.wasmUrl)
  const workerHostOptions: { timeoutMs?: number } = {}
  if (options.workerTimeoutMs !== undefined) workerHostOptions.timeoutMs = options.workerTimeoutMs
  const workerHost = new AuroraAcknowledgedWorkerHost(worker, workerHostOptions)
  const pcmSource = options.pcmSource ?? new BrowserAudioWorkletPcmSource({
    ...options.audio,
    onLifecycleLost: (reason) => {
      options.audio?.onLifecycleLost?.(reason)
      options.onAudioLifecycleLost?.(reason)
      void runtime?.cancel('audio_lifecycle_lost')
    }
  })
  const runtimeOptions: AuroraVoiceWebRuntimeOptions = {
    ownerId: options.ownerId,
    worker: workerHost,
    pcmSource,
    ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
    ...(options.workerTimeoutMs !== undefined ? { workerTimeoutMs: options.workerTimeoutMs } : {}),
    ...(options.sessionIdFactory !== undefined ? { sessionIdFactory: options.sessionIdFactory } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {})
  }
  runtime = new AuroraVoiceWebRuntime(runtimeOptions)
  return runtime
}

function createWorker(factory: AuroraBrowserVoiceRuntimeOptions['workerFactory'], workerUrl?: URL, wasmUrl?: URL): AuroraBrowserWorkerPort {
  const resolvedWorkerUrl = workerUrl ?? new URL('./voice-worker.js', import.meta.url)
  const resolvedWasmUrl = wasmUrl ?? new URL('./wasm/aurora_voice_wasm_bg.wasm', import.meta.url)
  const url = buildAuroraVoiceWorkerUrl(resolvedWorkerUrl, resolvedWasmUrl)
  if (factory !== undefined) return factory(url, { type: 'module', name: 'aurora-voice-worker' })
  return new Worker(url, { type: 'module', name: 'aurora-voice-worker' })
}
