import {
  createPeerHostLocalSpeechSource,
  type PeerHostLocalSpeechSource,
} from '@aurora/client/webrtc'
import { createAuroraBrowserVoiceRuntime } from '@aurora/voice-web/browser'
import {
  openActiveBrowserSpeechPacks,
  type AuroraBrowserSpeechPackTrustSelection,
} from './browser-speech-pack'
import type { AuroraRuntimeProfileV2 } from './runtime-profile'
import type { AuroraNodeConfigDocumentV2 } from '@aurora/client/node-config'

const TRUST_STORAGE_KEY = 'aurora.browserSpeechTrust.v1'

export interface BrowserSpeechHostOptions {
  readonly profile: AuroraRuntimeProfileV2
  readonly nodeConfig: AuroraNodeConfigDocumentV2
  readonly localPeerId: string
  readonly onAvailabilityChange?: (available: boolean) => void | Promise<void>
}

export interface BrowserSpeechHost {
  readonly source: PeerHostLocalSpeechSource
  setVisible(visible: boolean): Promise<void>
  close(): Promise<void>
}

/** Opens only the packs selected and trusted by this profile and registers ready shared stages. */
export async function createBrowserSpeechHost(options: BrowserSpeechHostOptions): Promise<BrowserSpeechHost | null> {
  const selection = options.profile.localNode.localSpeechSelection
  const trustSelections = loadTrustSelections(selection)
  const enabledTasks = (['stt', 'tts'] as const).filter((task) => options.nodeConfig.speech.sharing[task])
  if (enabledTasks.length === 0 || trustSelections.length === 0) return null
  const packs = await openActiveBrowserSpeechPacks({
    enabled: true,
    tasks: enabledTasks,
    trustSelections: trustSelections.filter((selection) => enabledTasks.includes(selection.task as 'stt' | 'tts')),
    ttsVoiceId: selection?.tts?.voiceId ?? null,
  })
  if (packs.state !== 'ready') return null

  const selectedModel = (task: 'stt' | 'tts', modelId: string | null, language: string | null) => {
    const selected = selection?.[task]
    if (!selected?.packId) return undefined
    const pack = packs.packs.find((candidate) => candidate.identity.packId === selected.packId)
    if (!pack || (modelId !== null && pack.identity.packId !== modelId && !pack.models.some((model) => model.family === modelId))) return undefined
    const families = new Set(pack.models.filter((model) => model.task === task).map((model) => model.family))
    const models = packs.modelBindings.models.filter((model) => model.task === task && families.has(model.family) &&
      (modelId === null || pack.identity.packId === modelId || model.family === modelId) &&
      (language === null || model.config?.language === language))
    return models.length === 1 ? models[0] : undefined
  }
  const sttConfig = options.nodeConfig.speech.stages.stt
  const ttsConfig = options.nodeConfig.speech.stages.tts
  const sttSelected = enabledTasks.includes('stt') ? selectedModel('stt', sttConfig.modelId ?? null, sttConfig.language ?? null) : undefined
  const ttsSelected = enabledTasks.includes('tts') ? selectedModel('tts', ttsConfig.modelId ?? null, ttsConfig.language ?? null) : undefined
  const sttLanguage = sttSelected?.config?.language ?? null
  const ttsLanguage = ttsSelected?.config?.language ?? null
  if (sttSelected && sttConfig.language != null && sttConfig.language !== sttLanguage) return null
  if (ttsSelected && ttsConfig.language != null && ttsConfig.language !== ttsLanguage) return null
  if (ttsSelected && (!selection?.tts?.voiceId || packs.ttsVoiceId !== selection.tts.voiceId || ttsSelected.config?.voiceId !== selection.tts.voiceId)) return null

  const runtime = createAuroraBrowserVoiceRuntime({
    ownerId: `mesh-speech-${options.profile.id}`,
    modelBindings: packs.modelBindings,
  })
  let readiness: Awaited<ReturnType<typeof runtime.initialize>>
  try {
    readiness = await runtime.initialize()
  } catch {
    await runtime.cancel('speech_engine_unavailable').catch(() => undefined)
    return null
  }
  const source = createPeerHostLocalSpeechSource({
    peerId: options.localPeerId,
    runtime,
    revision: options.nodeConfig.revision,
    ...(sttSelected && readiness.stt ? { stt: { enabled: true, modelId: sttSelected.family, language: sttLanguage } } : {}),
    ...(ttsSelected && readiness.tts ? { tts: { enabled: true, modelId: ttsSelected.family, language: ttsLanguage, voiceId: selection?.tts?.voiceId ?? null } } : {}),
  })
  if (source.capabilities().length === 0) {
    await source.close()
    return null
  }
  let closed = false
  let visible = typeof document === 'undefined' || document.visibilityState === 'visible'
  let lifecycleGeneration = 0
  if (!visible) source.setVisible(false)
  const refresh = async () => { await options.onAvailabilityChange?.(source.capabilities().length > 0) }
  const visibilityChanged = () => {
    void setVisible(typeof document === 'undefined' || document.visibilityState === 'visible')
  }
  async function setVisible(next: boolean): Promise<void> {
    if (closed || visible === next) return
    visible = next
    const generation = ++lifecycleGeneration
    if (!next) {
      source.setVisible(false)
    } else {
      try {
        const ready = await runtime.initialize()
        if (closed || !visible || generation !== lifecycleGeneration) return
        source.setReady({ stt: Boolean(sttSelected && ready.stt), tts: Boolean(ttsSelected && ready.tts) })
        source.setVisible(true)
      } catch {
        if (closed || !visible || generation !== lifecycleGeneration) return
        source.setVisible(false)
      }
    }
    await refresh()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged)
  await refresh()
  return {
    source,
    setVisible,
    async close() {
      if (closed) return
      closed = true
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged)
      await source.close()
      await runtime.dispose().catch(() => undefined)
      await refresh()
    },
  }
}

function loadTrustSelections(
  selected: AuroraRuntimeProfileV2['localNode']['localSpeechSelection'],
): AuroraBrowserSpeechPackTrustSelection[] {
  if (typeof window === 'undefined' || !selected) return []
  try {
    const raw = window.localStorage.getItem(TRUST_STORAGE_KEY)
    const value = raw ? JSON.parse(raw) as unknown : null
    if (!Array.isArray(value)) return []
    return value.filter(isTrustSelection).filter((trust) => {
      const chosen = selected[trust.task]
      return chosen?.packId === trust.packId && chosen.packRevision === trust.packVersion &&
        (trust.task !== 'tts' || (chosen.voiceId === trust.voiceId && chosen.referenceProfileId === trust.referenceProfileId))
    })
  } catch {
    return []
  }
}

function isTrustSelection(value: unknown): value is AuroraBrowserSpeechPackTrustSelection {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record.task === 'stt' || record.task === 'tts') &&
    typeof record.packId === 'string' && typeof record.packVersion === 'string' &&
    typeof record.expectedManifestSha256 === 'string' &&
    (record.voiceId === undefined || typeof record.voiceId === 'string') &&
    (record.referenceProfileId === undefined || typeof record.referenceProfileId === 'string')
}
