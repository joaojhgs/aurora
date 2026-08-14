import type { AuroraVoiceWebSherpaAssets } from './types.js'

export const AURORA_VOICE_WORKER_ASSET_NAME = 'voice-worker.js'
export const AURORA_VOICE_WASM_CORE_ASSET_NAME = 'aurora_voice_wasm_bg.wasm'
export const AURORA_VOICE_SHERPA_VAD_ASR_QUERY = 'sherpa_vad_asr'
export const AURORA_VOICE_SHERPA_VAD_HELPER_QUERY = 'sherpa_vad_helper'
export const AURORA_VOICE_SHERPA_ASR_HELPER_QUERY = 'sherpa_asr_helper'
export const AURORA_VOICE_SHERPA_KWS_QUERY = 'sherpa_kws'
export const AURORA_VOICE_SHERPA_KWS_HELPER_QUERY = 'sherpa_kws_helper'

export interface AuroraVoiceWorkerSherpaAssetUrls {
  readonly vadAsrModuleUrl?: Pick<URL, 'href'>
  readonly vadHelperUrl?: Pick<URL, 'href'>
  readonly asrHelperUrl?: Pick<URL, 'href'>
  readonly kwsModuleUrl?: Pick<URL, 'href'>
  readonly kwsHelperUrl?: Pick<URL, 'href'>
}

function currentPageUrl(): string | undefined {
  return typeof globalThis.location === 'undefined'
    ? undefined
    : globalThis.location.href
}

export function buildAuroraVoiceWorkerUrl(
  workerUrl: Pick<URL, 'href'>,
  wasmUrl: Pick<URL, 'href'>,
  baseUrl: string | URL | undefined = currentPageUrl(),
  sherpaAssets: AuroraVoiceWorkerSherpaAssetUrls = {}
): URL {
  const url = baseUrl === undefined
    ? new URL(workerUrl.href)
    : new URL(workerUrl.href, baseUrl)
  const resolvedWasmUrl = new URL(wasmUrl.href, url)
  url.searchParams.set('wasm', resolvedWasmUrl.href)
  setOptionalSameOriginQuery(url, AURORA_VOICE_SHERPA_VAD_ASR_QUERY, sherpaAssets.vadAsrModuleUrl)
  setOptionalSameOriginQuery(url, AURORA_VOICE_SHERPA_VAD_HELPER_QUERY, sherpaAssets.vadHelperUrl)
  setOptionalSameOriginQuery(url, AURORA_VOICE_SHERPA_ASR_HELPER_QUERY, sherpaAssets.asrHelperUrl)
  setOptionalSameOriginQuery(url, AURORA_VOICE_SHERPA_KWS_QUERY, sherpaAssets.kwsModuleUrl)
  setOptionalSameOriginQuery(url, AURORA_VOICE_SHERPA_KWS_HELPER_QUERY, sherpaAssets.kwsHelperUrl)
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

export function resolveSameOriginSherpaAssetUrls(location: Pick<Location, 'href'>): AuroraVoiceWebSherpaAssets {
  const workerUrl = new URL(location.href)
  return {
    ...resolveOptionalSameOriginQuery(workerUrl, AURORA_VOICE_SHERPA_VAD_ASR_QUERY, 'vadAsrModuleUrl'),
    ...resolveOptionalSameOriginQuery(workerUrl, AURORA_VOICE_SHERPA_VAD_HELPER_QUERY, 'vadHelperUrl'),
    ...resolveOptionalSameOriginQuery(workerUrl, AURORA_VOICE_SHERPA_ASR_HELPER_QUERY, 'asrHelperUrl'),
    ...resolveOptionalSameOriginQuery(workerUrl, AURORA_VOICE_SHERPA_KWS_QUERY, 'kwsModuleUrl'),
    ...resolveOptionalSameOriginQuery(workerUrl, AURORA_VOICE_SHERPA_KWS_HELPER_QUERY, 'kwsHelperUrl')
  }
}

function setOptionalSameOriginQuery(url: URL, key: string, asset: Pick<URL, 'href'> | undefined): void {
  if (asset === undefined) return
  const resolved = new URL(asset.href, url)
  if (resolved.origin !== url.origin) throw new Error('Voice worker is not available')
  url.searchParams.set(key, resolved.href)
}

function resolveOptionalSameOriginQuery<T extends keyof AuroraVoiceWebSherpaAssets>(
  workerUrl: URL,
  key: string,
  property: T
): Partial<Record<T, string>> {
  const value = workerUrl.searchParams.get(key)
  if (value === null) return {}
  const asset = new URL(value, workerUrl)
  if (asset.origin !== workerUrl.origin) throw new Error('Voice worker is not available')
  return { [property]: asset.href } as Partial<Record<T, string>>
}
