export const AURORA_VOICE_WORKER_ASSET_NAME = 'voice-worker.js'
export const AURORA_VOICE_WASM_CORE_ASSET_NAME = 'aurora_voice_wasm_bg.wasm'

function currentPageUrl(): string | undefined {
  return typeof globalThis.location === 'undefined'
    ? undefined
    : globalThis.location.href
}

export function buildAuroraVoiceWorkerUrl(
  workerUrl: Pick<URL, 'href'>,
  wasmUrl: Pick<URL, 'href'>,
  baseUrl: string | URL | undefined = currentPageUrl()
): URL {
  const url = baseUrl === undefined
    ? new URL(workerUrl.href)
    : new URL(workerUrl.href, baseUrl)
  const resolvedWasmUrl = new URL(wasmUrl.href, url)
  url.searchParams.set('wasm', resolvedWasmUrl.href)
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
