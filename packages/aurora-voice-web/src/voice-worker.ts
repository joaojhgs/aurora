import { AuroraWasmVoiceBridge } from './wasm-bridge.js'
import { resolveSameOriginSherpaAssetUrls, resolveSameOriginWasmUrl } from './worker-assets.js'
import { AuroraVoiceWorkerDispatcher } from './worker-dispatcher.js'

type AuroraVoiceWorkerScope = {
  readonly addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
  readonly location: Location
  readonly postMessage: (message: unknown, transfer?: readonly Transferable[]) => void
}

const workerScope = self as unknown as AuroraVoiceWorkerScope
const dispatcher = new AuroraVoiceWorkerDispatcher(new AuroraWasmVoiceBridge({
  wasmUrl: resolveSameOriginWasmUrl(workerScope.location).href,
  sherpaAssets: resolveSameOriginSherpaAssetUrls(workerScope.location)
}), workerScope)

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  void dispatcher.handleMessage(event.data)
})
