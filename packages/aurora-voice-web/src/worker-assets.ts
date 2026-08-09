export const AURORA_VOICE_WORKER_ASSET_NAME = 'voice-worker.js'
export const AURORA_VOICE_WASM_CORE_ASSET_NAME = 'aurora_voice_wasm_bg.wasm'

export function buildAuroraVoiceWorkerUrl(workerUrl: URL, wasmUrl: URL): URL {
  const url = new URL(workerUrl.href)
  url.searchParams.set('wasm', wasmUrl.href)
  return url
}

export function resolveSameOriginWasmUrl(location: Pick<Location, 'href'>): URL {
  const workerUrl = new URL(location.href)
  const queryUrl = workerUrl.searchParams.get('wasm')
  const wasmUrl = queryUrl === null
    ? new URL(`./wasm/${AURORA_VOICE_WASM_CORE_ASSET_NAME}`, workerUrl)
    : new URL(queryUrl, workerUrl)
  if (wasmUrl.origin !== workerUrl.origin) {
    throw new Error('Voice worker is not available')
  }
  return wasmUrl
}
