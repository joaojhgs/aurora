import {
  BrowserAudioWorkletPcmSource,
  type AuroraBrowserAudioLifecycleLostReason,
  type AuroraBrowserAudioWorkletSourceOptions
} from './audio-worklet-source.js'
import {
  openActiveBrowserModelPack,
  type AuroraBrowserModelPackTrustOptions
} from './browser-model-pack.js'
import {
  createAuroraBrowserPageLifecycle,
  type AuroraBrowserPageLifecyclePort
} from './browser-lifecycle.js'
import { AuroraVoiceWebRuntime, visibleLifecycle } from './runtime.js'
import { buildAuroraVoiceWorkerUrl } from './worker-assets.js'
import {
  AuroraAcknowledgedWorkerHost,
  type AuroraBrowserWorkerPort
} from './worker-rpc.js'
import type {
  AuroraAudioWorkletPcmSource,
  AuroraVoiceLifecycleEligibility,
  AuroraVoiceLifecycleReason,
  AuroraVoiceWebModelBindings,
  AuroraVoiceWebModelDescriptor,
  AuroraVoiceWebModelFileBinding,
  AuroraVoiceWebModelTask,
  AuroraVoiceWebRuntimeOptions
} from './types.js'
import type { AuroraWebModelStoreHost } from './model-store-host.js'

export interface AuroraBrowserVoiceRuntimeOptions {
  readonly ownerId: string
  readonly worker?: AuroraBrowserWorkerPort
  readonly workerFactory?: (url: URL, options: WorkerOptions) => AuroraBrowserWorkerPort
  readonly workerUrl?: URL
  readonly wasmUrl?: URL
  readonly sherpaAssets?: {
    readonly vadAsrModuleUrl?: URL
    readonly vadHelperUrl?: URL
    readonly asrHelperUrl?: URL
    readonly kwsModuleUrl?: URL
    readonly kwsHelperUrl?: URL
    readonly ttsModuleUrl?: URL
    readonly ttsHelperUrl?: URL
  }
  readonly modelBindings?: AuroraVoiceWebModelBindings
  readonly pcmSource?: AuroraAudioWorkletPcmSource
  readonly lifecycle?: () => AuroraVoiceLifecycleEligibility
  readonly pageLifecycle?: AuroraBrowserPageLifecyclePort | null
  readonly workerTimeoutMs?: number
  readonly ttsTimeoutMs?: number
  readonly audio?: AuroraBrowserAudioWorkletSourceOptions
  readonly onAudioLifecycleLost?: (reason: AuroraBrowserAudioLifecycleLostReason) => void
  readonly onPageLifecycleLost?: (reason: Exclude<AuroraVoiceLifecycleReason, 'visible'>) => void
  readonly sessionIdFactory?: AuroraVoiceWebRuntimeOptions['sessionIdFactory']
  readonly nowMs?: () => number
}

export function createAuroraBrowserVoiceRuntime(options: AuroraBrowserVoiceRuntimeOptions): AuroraVoiceWebRuntime {
  let runtime: AuroraLifecycleAwareBrowserVoiceRuntime | null = null
  const pageLifecycle = options.pageLifecycle === undefined
    ? createAuroraBrowserPageLifecycle()
    : options.pageLifecycle
  const lifecycle = combineLifecycle(pageLifecycle, options.lifecycle)
  const worker = options.worker ?? createWorker(options.workerFactory, options.workerUrl, options.wasmUrl, options.sherpaAssets)
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
    lifecycle,
    ...(options.workerTimeoutMs !== undefined ? { workerTimeoutMs: options.workerTimeoutMs } : {}),
    ...(options.ttsTimeoutMs !== undefined ? { ttsTimeoutMs: options.ttsTimeoutMs } : {}),
    ...(options.modelBindings !== undefined ? { modelBindings: options.modelBindings } : {}),
    ...(options.sessionIdFactory !== undefined ? { sessionIdFactory: options.sessionIdFactory } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {})
  }
  runtime = new AuroraLifecycleAwareBrowserVoiceRuntime(
    runtimeOptions,
    pageLifecycle,
    lifecycle,
    options.onPageLifecycleLost
  )
  return runtime
}

class AuroraLifecycleAwareBrowserVoiceRuntime extends AuroraVoiceWebRuntime {
  private unsubscribePageLifecycle: (() => void) | null
  private lifecycleRefreshChain: Promise<void> = Promise.resolve()
  private cancellation: Promise<void> | null = null

  constructor(
    options: AuroraVoiceWebRuntimeOptions,
    pageLifecycle: AuroraBrowserPageLifecyclePort | null,
    lifecycle: () => AuroraVoiceLifecycleEligibility,
    onPageLifecycleLost: ((reason: Exclude<AuroraVoiceLifecycleReason, 'visible'>) => void) | undefined
  ) {
    super(options)
    this.unsubscribePageLifecycle = pageLifecycle?.subscribe((pageEligibility) => {
      const eligibility = !isEligible(pageEligibility) ? pageEligibility : lifecycle()
      const affectedSession = this.snapshot()
      if (isEligible(eligibility) || affectedSession.sessionId === null) return
      this.lifecycleRefreshChain = this.lifecycleRefreshChain
        .then(async () => {
          const currentSession = this.snapshot()
          if (
            currentSession.sessionId !== affectedSession.sessionId ||
            currentSession.generation !== affectedSession.generation
          ) return
          try {
            await this.refreshLifecycleEligibility(eligibility)
          } finally {
            if (eligibility.reason !== 'visible') onPageLifecycleLost?.(eligibility.reason)
          }
        })
        .catch(() => undefined)
    }) ?? null
  }

  override cancel(reason = 'cancelled'): Promise<void> {
    if (this.cancellation !== null) return this.cancellation
    const cancellation = super.cancel(reason)
    const tracked = cancellation.finally(() => {
      if (this.cancellation === tracked) this.cancellation = null
    })
    this.cancellation = tracked
    return tracked
  }

  override async dispose(): Promise<void> {
    this.unsubscribePageLifecycle?.()
    this.unsubscribePageLifecycle = null
    await this.lifecycleRefreshChain
    await super.dispose()
  }
}

function combineLifecycle(
  pageLifecycle: AuroraBrowserPageLifecyclePort | null,
  explicitLifecycle: (() => AuroraVoiceLifecycleEligibility) | undefined
): () => AuroraVoiceLifecycleEligibility {
  return () => {
    const pageEligibility = pageLifecycle?.current()
    if (pageEligibility !== undefined && !isEligible(pageEligibility)) return pageEligibility
    return explicitLifecycle?.() ?? pageEligibility ?? visibleLifecycle()
  }
}

function isEligible(eligibility: AuroraVoiceLifecycleEligibility): boolean {
  return eligibility.eligible && eligibility.visible && !eligibility.frozen
}

export async function loadAuroraBrowserVoiceModelBindings(
  host: AuroraWebModelStoreHost,
  trust: AuroraBrowserModelPackTrustOptions,
  tasks: readonly AuroraVoiceWebModelTask[] = ['vad', 'kws', 'stt', 'tts']
): Promise<AuroraVoiceWebModelBindings | undefined> {
  const files: AuroraVoiceWebModelFileBinding[] = []
  const models: AuroraVoiceWebModelDescriptor[] = []
  for (const task of tasks) {
    const pack = await openActiveBrowserModelPack(host, { task }, trust)
    if (pack === null) continue
    const packModels = pack.models.filter((model) => model.task === task)
    if (packModels.length === 0) throw new Error('Voice worker is not available')
    models.push(...packModels)
    for (const file of pack.files) {
      files.push({
        task,
        fileId: file.fileId,
        virtualPath: file.virtualPath,
        sha256: file.sha256,
        byteLength: file.byteLength,
        bytes: await file.readAll()
      })
    }
  }
  return files.length === 0 ? undefined : { files, models }
}

function createWorker(
  factory: AuroraBrowserVoiceRuntimeOptions['workerFactory'],
  workerUrl?: URL,
  wasmUrl?: URL,
  sherpaAssets?: AuroraBrowserVoiceRuntimeOptions['sherpaAssets']
): AuroraBrowserWorkerPort {
  const resolvedWorkerUrl = workerUrl ?? new URL('./voice-worker.js', import.meta.url)
  const resolvedWasmUrl = wasmUrl ?? new URL('./wasm/aurora_voice_wasm_bg.wasm', import.meta.url)
  const url = buildAuroraVoiceWorkerUrl(resolvedWorkerUrl, resolvedWasmUrl, undefined, sherpaAssets)
  if (factory !== undefined) return factory(url, { type: 'module', name: 'aurora-voice-worker' })
  return new Worker(url, { type: 'module', name: 'aurora-voice-worker' })
}
