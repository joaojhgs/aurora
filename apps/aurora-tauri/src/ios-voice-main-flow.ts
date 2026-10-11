import {
  cancelIosVoiceMainFlowFixture,
  iosVoiceMainFlowCounters,
  pushIosVoiceMainFlowPcm,
} from './native-ios-voice'
import { createIosVoiceMainFlowAdapter, type IosVoiceMainFlowAdapter } from './aurora-client'
import {
  emptyRuntimeProfileDocument,
  parseRuntimeProfileDocument,
  serializeRuntimeProfileDocument,
} from '@aurora/ui/runtime-profile'

type LoopbackRun = { nonce: string; wavBase64: string; simulatorArchitecture: 'arm64' | 'x86_64' }
type LoopbackResult = {
  nonce: string
  status: 'passed' | 'failed'
  stage: 'profile_setup' | 'profile_created' | 'speech_setup' | 'speech_ready' | 'model_setup' | 'model_ready' | 'voice_started' | 'pcm_injected' | 'transcript_returned' | 'assistant_final_rendered' | 'cancelled' | 'unavailable'
  setupStep: IosVoiceSetupStep | null
  failureCode: IosVoiceSetupFailureCode | null
  chunks: number
  samples: number
  transcriptReceived: boolean
  assistantFinalRendered: boolean
  cancelled: boolean
  profileCreated: boolean
  speechReady: boolean
  modelReady: boolean
  profileRestored: boolean
  preferencesRestored: boolean
  ownedAssetsRemoved: boolean
}

type IosVoiceSetupStep = 'profile_read' | 'profile_validation' | 'preferences_read' | 'model_status' | 'speech_catalog' | 'ownership_capture' | 'device_option' | 'onboarding_navigation' | 'profile_creation' | 'profile_readback'
type IosVoiceSetupFailureCode = 'profile_not_empty' | 'model_not_owned' | 'speech_catalog_unavailable' | 'offline_profile_option_unavailable' | 'setup_timeout' | 'setup_failed'

let started = false
let assistantRuntimeDisposer: (() => Promise<void>) | null = null

/** Registers disposal from the current production runtime owner for this debug-only flow. */
export function registerIosVoiceMainFlowRuntimeDisposer(dispose: () => Promise<void>): () => void {
  if (import.meta.env.VITE_AURORA_IOS_VOICE_LIVE_TEST !== '1') return () => undefined
  assistantRuntimeDisposer = dispose
  return () => { if (assistantRuntimeDisposer === dispose) assistantRuntimeDisposer = null }
}

/** Installs one bounded, loopback-controlled run in the explicitly enabled debug bundle. */
export function installIosVoiceMainFlow(controlOriginValue: string | undefined): void {
  if (started || import.meta.env.VITE_AURORA_IOS_VOICE_LIVE_TEST !== '1') return
  const controlOrigin = validateLoopbackOrigin(controlOriginValue)
  if (!controlOrigin) return
  started = true
  const adapter = createIosVoiceMainFlowAdapter()
  if (!adapter) return
  void pollForRun(controlOrigin, adapter)
}

async function pollForRun(origin: string, adapter: IosVoiceMainFlowAdapter): Promise<void> {
  const deadline = Date.now() + 2_100_000
  while (Date.now() < deadline) {
    let delivery: Awaited<ReturnType<IosVoiceMainFlowAdapter['pollRun']>>
    try {
      delivery = await adapter.pollRun(origin)
    } catch {
      await delay(500)
      continue
    }
    if (delivery.kind === 'idle') { await delay(500); continue }
    if (delivery.kind !== 'run') return
    try {
      await executeRun(origin, validateRun(delivery.payload), adapter)
    } catch {
      return
    }
    return
  }
}

async function executeRun(origin: string, run: LoopbackRun, adapter: IosVoiceMainFlowAdapter): Promise<void> {
  let thread: HTMLElement | null = null
  let baselineItems = 0
  let result: LoopbackResult = {
    nonce: run.nonce,
    status: 'failed',
    stage: 'unavailable',
    setupStep: null,
    failureCode: null,
    chunks: 0,
    samples: 0,
    transcriptReceived: false,
    assistantFinalRendered: false,
    cancelled: false,
    profileCreated: false,
    speechReady: false,
    modelReady: false,
    profileRestored: false,
    preferencesRestored: false,
    ownedAssetsRemoved: false,
  }
  let ownership: OfflineSetupOwnership | null = null
  const overallDeadline = Date.now() + 2_100_000
  try {
    const setupDeadline = overallDeadline - 480_000
    result.stage = 'profile_setup'
    result.setupStep = 'profile_read'
    try {
      ownership = await prepareOfflineSetup(
        adapter,
        run.simulatorArchitecture,
        setupDeadline,
        (step) => { result.setupStep = step },
        (captured) => { ownership = captured },
      )
    } catch (error) {
      result.failureCode = classifySetupFailure(error)
      throw error
    }
    result.setupStep = null
    result.profileCreated = true
    result.stage = 'profile_created'
    result.stage = 'speech_setup'
    await prepareSpeech(ownership, setupDeadline)
    result.speechReady = true
    result.stage = 'speech_ready'
    result.stage = 'model_setup'
    await prepareModel(ownership, setupDeadline)
    result.modelReady = true
    result.stage = 'model_ready'
    const mainDeadline = Math.min(Date.now() + 180_000, overallDeadline - 300_000)
    await openAssistant(mainDeadline)
    thread = await waitForElement<HTMLElement>('[aria-label="Assistant conversation thread"]', remaining(mainDeadline, 30_000))
    baselineItems = thread.querySelectorAll('[data-slot="message-scroller-item"]').length
    const pcm = decodeSyntheticPcmWav(run.wavBase64)
    const startButton = await waitForVoiceButton('Push to talk', remaining(mainDeadline, 30_000))
    startButton.click()
    await waitForVoiceButton('Stop listening', remaining(mainDeadline, 20_000))
    result.stage = 'voice_started'
    for (let offset = 0; offset < pcm.length; offset += 4096) {
      const chunk = pcm.subarray(offset, Math.min(offset + 4096, pcm.length))
      if (remaining(mainDeadline, 180_000) < Math.ceil(chunk.length * 1000 / 16_000)) throw new Error('main_flow_timeout')
      await pushIosVoiceMainFlowPcm(chunk)
      result.stage = 'pcm_injected'
      result.chunks += 1
      result.samples += chunk.length
      await delay(Math.ceil(chunk.length * 1000 / 16_000))
    }
    const currentStop = await waitForVoiceButton('Stop listening', remaining(mainDeadline, 2_000))
    currentStop.click()
    await waitFor(async () => {
      const counters = iosVoiceMainFlowCounters()
      if (!counters?.transcriptReceived) return false
      result.transcriptReceived = true
      result.stage = 'transcript_returned'
      const items = Array.from(thread!.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]'))
      if (items.length < baselineItems + 2) return false
      const last = items.at(-1)
      const sent = Array.from(last?.querySelectorAll('span.sr-only') ?? [])
        .some((status) => status.textContent?.trim() === 'Aurora · sent')
      const answer = last?.querySelector('p')?.textContent?.trim() ?? ''
      const pending = last?.querySelector('[role="status"][aria-busy="true"]') !== null
      if (!sent || !answer || pending) return false
      result.assistantFinalRendered = true
      result.stage = 'assistant_final_rendered'
      return true
    }, remaining(mainDeadline, 90_000))
    result.status = 'passed'
  } catch {
    result.status = 'failed'
  } finally {
    await cancelIosVoiceMainFlowFixture().catch(() => undefined)
    const counters = iosVoiceMainFlowCounters()
    if (counters) {
      result.chunks = counters.chunks
      result.samples = counters.samples
      result.transcriptReceived = counters.transcriptReceived
      result.cancelled ||= counters.cancelled
    }
    if (ownership) {
      const cleanup = await restoreOfflineSetup(ownership, overallDeadline)
      result.profileRestored = cleanup.profileRestored
      result.preferencesRestored = cleanup.preferencesRestored
      result.ownedAssetsRemoved = cleanup.ownedAssetsRemoved
      if (!cleanup.ok) result.status = 'failed'
    }
    if (result.status !== 'passed' && result.cancelled) result.stage = 'cancelled'
    await adapter.postResult(origin, result)
  }
}

type OfflineSetupOwnership = {
  readonly adapter: IosVoiceMainFlowAdapter
  readonly inference: IosVoiceMainFlowAdapter["inference"]
  readonly speech: IosVoiceMainFlowAdapter["speech"]
  readonly originalProfileValue: string
  readonly originalProfileWasNull: boolean
  readonly originalMode: string | null
  readonly originalTier: string | null
  readonly initialModelState: 'absent' | 'ready'
  readonly simulatorArchitecture: 'arm64' | 'x86_64'
  readonly initialSpeechCache: ReadonlyMap<string, boolean>
  createdProfileId: string | null
  createdLocalNodeId: string | null
  selectedSttPackId: string | null
}

async function prepareOfflineSetup(adapter: IosVoiceMainFlowAdapter, simulatorArchitecture: 'arm64' | 'x86_64', deadline: number, onStep: (step: IosVoiceSetupStep) => void, onOwnershipReady: (ownership: OfflineSetupOwnership) => void): Promise<OfflineSetupOwnership> {
  onStep('profile_read')
  const profileValue = await adapter.getProfile()
  onStep('profile_validation')
  const originalProfileWasNull = profileValue.value == null
  const originalProfileValue = originalProfileWasNull
    ? serializeRuntimeProfileDocument(emptyRuntimeProfileDocument())
    : requireCanonicalEmptyProfile(profileValue.value)
  onStep('preferences_read')
  const [mode, tier] = await Promise.all([
    adapter.getPreference('onboarding-mode'),
    adapter.getPreference('runtime-tier'),
  ])
  const inference = adapter.inference
  onStep('model_status')
  const model = await inference.modelStatus('chat-qwen3-0b8')
  if (model.state !== 'absent' && model.state !== 'ready') throw new Error('model_not_owned')
  const speech = adapter.speech
  onStep('speech_catalog')
  const catalog = await speech.listCatalog()
  if (catalog.state !== 'ready' || !catalog.items.some((item) => item.task === 'stt')) {
    throw new Error('speech_catalog_unavailable')
  }
  const initialSpeechCache = new Map(catalog.items.map((item) => [`${item.task}:${item.packId}`, item.cached === true]))
  const ownership: OfflineSetupOwnership = {
    adapter,
    inference,
    speech,
    originalProfileValue,
    originalProfileWasNull,
    originalMode: mode.value ?? null,
    originalTier: tier.value ?? null,
    initialModelState: model.state,
    simulatorArchitecture,
    initialSpeechCache,
    createdProfileId: null,
    createdLocalNodeId: null,
    selectedSttPackId: null,
  }
  onStep('ownership_capture')
  onOwnershipReady(ownership)
  const setupTimeout = remaining(deadline, 120_000)
  onStep('device_option')
  const deviceRadio = await waitForElement<HTMLButtonElement>('button[role="radio"][title="Make this device available"]', setupTimeout)
  if (deviceRadio.disabled) throw new Error('offline_profile_option_unavailable')
  if (deviceRadio.getAttribute('aria-checked') !== 'true') deviceRadio.click()
  onStep('onboarding_navigation')
  await waitFor(async () => {
    const step = document.querySelector<HTMLElement>('[data-step="detect"]')
    if (!step) return false
    const button = Array.from(step.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.innerText.trim() === 'Continue' && !candidate.disabled)
    if (!button) return false
    button.click()
    return true
  }, setupTimeout)
  await waitForElement<HTMLElement>('[data-step="setup"]', remaining(deadline, setupTimeout))
  onStep('profile_creation')
  const continueButton = await waitForButtonText('Continue on this device', remaining(deadline, setupTimeout))
  continueButton.click()
  onStep('profile_readback')
  await waitFor(async () => {
    try {
      const current = await ownership.adapter.getProfile()
      const document = parseRuntimeProfileDocument(typeof current.value === 'string' ? current.value : null)
      const activeProfileId = document?.activeProfileId
      const active = document?.profiles.find((profile) => profile.id === activeProfileId)
      if (!active || document!.profiles.length !== 1 || active.nodeMode !== 'mesh-node'
        || active.runtimeTier !== 'lightweight-ts' || active.homeConnection
        || active.localNode.meshMembership
        || active.localNode.enabledCapabilityPacks.length !== 1
        || active.localNode.enabledCapabilityPacks[0] !== 'local-inference') return false
      ownership.createdProfileId = active.id
      ownership.createdLocalNodeId = active.localNode.stablePeerId
      return true
    } catch { return false }
  }, remaining(deadline, setupTimeout))
  return ownership
}

function classifySetupFailure(error: unknown): IosVoiceSetupFailureCode {
  const code = error instanceof Error ? error.message : ''
  if (code === 'profile_not_empty') return 'profile_not_empty'
  if (code === 'model_not_owned') return 'model_not_owned'
  if (code === 'speech_catalog_unavailable') return 'speech_catalog_unavailable'
  if (code === 'offline_profile_option_unavailable') return 'offline_profile_option_unavailable'
  if (code === 'main_flow_timeout' || code === 'main flow timed out') return 'setup_timeout'
  return 'setup_failed'
}

async function prepareSpeech(ownership: OfflineSetupOwnership, setupDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + 650_000, setupDeadline)
  await openSettings()
  const catalog = await ownership.speech.listCatalog()
  if (catalog.state !== 'ready') throw new Error('speech_catalog_unavailable')
  const rawValue = await ownership.adapter.listIosVoicePacks()
  const rawEntries = Array.isArray(rawValue) ? rawValue : []
  const supportedFamilies = new Set(['silero_vad', 'zipformer', 'whisper', 'vits_piper', 'pockettts'])
  const compatible = rawEntries.filter((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    const platforms = Array.isArray(entry.compatiblePlatforms) ? entry.compatiblePlatforms : []
    const architectures = Array.isArray(entry.compatibleArchitectures) ? entry.compatibleArchitectures : []
    const family = typeof entry.modelFamily === 'string' ? entry.modelFamily.toLowerCase() : ''
    return entry.task === 'stt' && entry.acknowledged === true && entry.requiresReferenceAudio !== true && entry.requiresReferenceProfile !== true
      && platforms.some((value) => typeof value === 'string' && ['ios', 'all'].includes(value.toLowerCase()))
      && architectures.some((value) => typeof value === 'string' && ['all', ownership.simulatorArchitecture].includes(value.toLowerCase()))
      && supportedFamilies.has(family)
  })
  const rawSelected = compatible.find((entry) => typeof entry.packId === 'string' && catalog.items.some((item) => item.packId === entry.packId && item.task === 'stt'))
  const selected = rawSelected ? catalog.items.find((item) => item.packId === rawSelected.packId && item.task === 'stt') : undefined
  if (!selected) throw new Error('speech_pack_unavailable')
  ownership.selectedSttPackId = selected.packId
  const current = await readOwnedProfile(ownership)
  if (current.localNode.localSpeechSelection?.stt?.packId !== selected.packId) {
    await chooseSpeechOption('Choose transcription', selected.displayName, deadline)
  }
  await waitFor(async () => {
    const document = await readOwnedProfile(ownership)
    const ready = await ownership.speech.getReadiness()
    return document.localNode.localSpeechSelection?.stt?.packId === selected.packId
      && ready.available && ready.activeSlots.stt === selected.packId
  }, remaining(deadline, 650_000))
}

async function prepareModel(ownership: OfflineSetupOwnership, setupDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + 650_000, setupDeadline)
  const before = await ownership.inference.modelStatus('chat-qwen3-0b8')
  if (before.state !== 'absent' && before.state !== 'ready') throw new Error('model_not_owned')
  if (before.state !== 'ready') {
    const button = await waitForButtonText('Download offline answers', 30_000)
    button.click()
    await waitFor(async () => (await ownership.inference.modelStatus('chat-qwen3-0b8')).state === 'ready', remaining(deadline, 650_000))
  }
  let toggle = await waitForElement<HTMLButtonElement>('#offline-assistant-enabled[role="switch"]', 30_000)
  if (toggle.getAttribute('aria-checked') !== 'true') toggle.click()
  await waitFor(() => {
    toggle = document.querySelector<HTMLButtonElement>('#offline-assistant-enabled[role="switch"]') ?? toggle
    return toggle.getAttribute('aria-checked') === 'true'
  }, 30_000)
}

async function openSettings(): Promise<void> {
  const settingsLink = await waitForElement<HTMLAnchorElement>('a[href="/settings"]', 30_000)
  settingsLink.click()
  await waitForElement<HTMLElement>('section[aria-label="Settings"]', 30_000)
}

async function openAssistant(deadline: number): Promise<void> {
  const assistantLink = await waitForElement<HTMLAnchorElement>('a[href="/assistant"]', remaining(deadline, 30_000))
  assistantLink.click()
}

async function chooseSpeechOption(label: string, optionLabel: string, deadline: number): Promise<void> {
  const trigger = await waitForElement<HTMLButtonElement>(`button[aria-label="${label}"]`, remaining(deadline, 30_000))
  trigger.click()
  const option = await waitForElement<HTMLElement>(`[cmdk-item]:not([aria-disabled="true"])`, remaining(deadline, 650_000))
  if (!option.innerText.includes(optionLabel)) {
    const matching = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]:not([aria-disabled="true"])'))
      .find((candidate) => candidate.innerText.includes(optionLabel))
    if (!matching) throw new Error('speech_pack_not_selectable')
    matching.click()
  } else option.click()
  await waitFor(() => trigger.innerText.includes(optionLabel), remaining(deadline, 650_000))
}

async function readOwnedProfile(ownership: OfflineSetupOwnership) {
  const result = await ownership.adapter.getProfile()
  const document = parseRuntimeProfileDocument(typeof result.value === 'string' ? result.value : null)
  const active = document?.profiles.find((profile) => profile.id === ownership.createdProfileId)
  if (!active || document?.activeProfileId !== ownership.createdProfileId || document.profiles.length !== 1) {
    throw new Error('owned_profile_changed')
  }
  return active
}

async function restoreOfflineSetup(ownership: OfflineSetupOwnership, deadline: number): Promise<{
  ok: boolean; profileRestored: boolean; preferencesRestored: boolean; ownedAssetsRemoved: boolean
}> {
  let profileRestored = false, preferencesRestored = false, ownedAssetsRemoved = false
  let runtimeDisposed = false
  try {
    if (Date.now() >= deadline) throw new Error('cleanup_timeout')
    const current = await ownership.adapter.getProfile()
    const document = parseRuntimeProfileDocument(typeof current.value === 'string' ? current.value : null)
    if (!ownership.createdProfileId
      && (current.value == null || (document?.profiles.length === 0 && document.activeProfileId === null))) {
      profileRestored = ownership.originalProfileWasNull ? current.value == null : current.value === ownership.originalProfileValue
    } else if (ownership.createdProfileId && document?.profiles.length === 1
      && document.activeProfileId === ownership.createdProfileId
      && document.profiles[0]?.id === ownership.createdProfileId
      && document.profiles[0]?.localNode.stablePeerId === ownership.createdLocalNodeId
      && document.profiles[0]?.nodeMode === 'mesh-node'
      && document.profiles[0]?.runtimeTier === 'lightweight-ts'
      && !document.profiles[0]?.homeConnection
      && !document.profiles[0]?.localNode.meshMembership
      && document.profiles[0]?.localNode.enabledCapabilityPacks.length === 1
      && document.profiles[0]?.localNode.enabledCapabilityPacks[0] === 'local-inference') {
      // Close the actual production router while its exact owning profile is still active.
      const disposeRuntime = assistantRuntimeDisposer
      if (!disposeRuntime) throw new Error('assistant_runtime_disposal_unavailable')
      await disposeRuntime()
      runtimeDisposed = true
      if (Date.now() >= deadline) throw new Error('cleanup_timeout')
      const saved = await ownership.adapter.setProfile(ownership.originalProfileValue)
      if (saved.ok !== true) throw new Error('profile_restore_failed')
      const restored = await ownership.adapter.getProfile()
      const restoredDocument = parseRuntimeProfileDocument(typeof restored.value === 'string' ? restored.value : null)
      profileRestored = restoredDocument?.profiles.length === 0 && restoredDocument.activeProfileId === null
        && (ownership.originalProfileWasNull || restored.value === ownership.originalProfileValue)
    }
    if (!profileRestored) throw new Error('profile_restore_failed')
    const modeSaved = ownership.originalMode === null
      ? await ownership.adapter.deletePreference('onboarding-mode')
      : await ownership.adapter.setPreference('onboarding-mode', ownership.originalMode)
    const tierSaved = ownership.originalTier === null
      ? await ownership.adapter.deletePreference('runtime-tier')
      : await ownership.adapter.setPreference('runtime-tier', ownership.originalTier)
    if (!modeSaved.ok || !tierSaved.ok) throw new Error('preference_restore_failed')
    const [mode, tier] = await Promise.all([
      ownership.adapter.getPreference('onboarding-mode'),
      ownership.adapter.getPreference('runtime-tier'),
    ])
    preferencesRestored = (mode.value ?? null) === ownership.originalMode && (tier.value ?? null) === ownership.originalTier
    if (!preferencesRestored) throw new Error('preference_restore_failed')
    if (ownership.createdProfileId && !runtimeDisposed) throw new Error('assistant_runtime_disposal_unavailable')
    if (runtimeDisposed) {
      if (ownership.selectedSttPackId && ownership.initialSpeechCache.get(`stt:${ownership.selectedSttPackId}`) !== true) {
        if (Date.now() >= deadline) throw new Error('cleanup_timeout')
        await ownership.speech.remove({ task: 'stt', packId: ownership.selectedSttPackId })
      }
      if (ownership.initialModelState === 'absent') {
        if (Date.now() >= deadline) throw new Error('cleanup_timeout')
        const model = await ownership.inference.modelStatus('chat-qwen3-0b8')
        if (model.state !== 'absent') await ownership.inference.deleteModel('chat-qwen3-0b8')
        if ((await ownership.inference.modelStatus('chat-qwen3-0b8')).state !== 'absent') throw new Error('model_cleanup_failed')
      }
    }
    const speechCatalog = await ownership.speech.listCatalog()
    const speechEntry = speechCatalog.items.find((item) => item.task === 'stt' && item.packId === ownership.selectedSttPackId)
    const modelStatus = await ownership.inference.modelStatus('chat-qwen3-0b8')
    const speechWasCached = ownership.selectedSttPackId
      ? ownership.initialSpeechCache.get(`stt:${ownership.selectedSttPackId}`) === true
      : false
    const speechRestored = !ownership.selectedSttPackId
      || (speechEntry !== undefined && speechEntry.cached === speechWasCached)
    ownedAssetsRemoved = speechRestored && modelStatus.state === ownership.initialModelState
  } catch {
    return { ok: false, profileRestored, preferencesRestored, ownedAssetsRemoved }
  }
  return { ok: profileRestored && preferencesRestored && ownedAssetsRemoved, profileRestored, preferencesRestored, ownedAssetsRemoved }
}

function requireCanonicalEmptyProfile(value: unknown): string {
  if (typeof value !== 'string') throw new Error('profile_not_empty')
  const profile = parseRuntimeProfileDocument(value)
  if (!profile || profile.activeProfileId !== null || profile.profiles.length !== 0) throw new Error('profile_not_empty')
  return value
}

async function waitForButtonText(text: string, timeoutMs: number): Promise<HTMLButtonElement> {
  let button: HTMLButtonElement | null = null
  await waitFor(() => {
    const matches = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((candidate) => candidate.innerText.trim() === text && !candidate.disabled)
    button = matches.length === 1 ? matches[0]! : null
    return button !== null
  }, timeoutMs)
  if (!button) throw new Error('control_unavailable')
  return button
}

function validateRun(value: unknown): LoopbackRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid run')
  const run = value as Record<string, unknown>
  if (typeof run.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(run.nonce)) throw new Error('invalid nonce')
  if (typeof run.wavBase64 !== 'string' || run.wavBase64.length > 1_400_000) throw new Error('invalid wav')
  if (run.simulatorArchitecture !== 'arm64' && run.simulatorArchitecture !== 'x86_64') throw new Error('invalid simulator architecture')
  return { nonce: run.nonce, wavBase64: run.wavBase64, simulatorArchitecture: run.simulatorArchitecture }
}

function decodeSyntheticPcmWav(encoded: string): Float32Array {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
  if (bytes.byteLength < 44 || bytes.byteLength > 960_044) throw new Error('wav size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('wav header')
  let format = 0, channels = 0, rate = 0, bits = 0, dataOffset = -1, dataLength = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = ascii(offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8
    if (body + size > bytes.length) throw new Error('wav chunk')
    if (id === 'fmt ') {
      if (size < 16) throw new Error('wav format')
      format = view.getUint16(body, true); channels = view.getUint16(body + 2, true)
      rate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true)
    } else if (id === 'data') { dataOffset = body; dataLength = size }
    offset = body + size + (size & 1)
  }
  if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16 || dataOffset < 0 || dataLength === 0 || dataLength > 960000 || dataLength % 2 !== 0) throw new Error('wav contract')
  const samples = new Float32Array(dataLength / 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768
  return samples
}

async function waitForVoiceButton(label: 'Push to talk' | 'Stop listening', timeoutMs: number): Promise<HTMLButtonElement> {
  let found: HTMLButtonElement | null = null
  await waitFor(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
      .filter((button) => button.getAttribute('aria-label') === label && !button.disabled)
    found = buttons.length === 1 ? buttons[0]! : null
    return found !== null
  }, timeoutMs)
  if (!found) throw new Error('voice control unavailable')
  return found
}

async function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  let found: T | null = null
  await waitFor(() => { found = document.querySelector<T>(selector); return found !== null }, timeoutMs)
  if (!found) throw new Error('assistant unavailable')
  return found
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(250)
  }
  throw new Error('main flow timed out')
}

function remaining(deadline: number, maximumMs: number): number {
  const value = Math.min(maximumMs, deadline - Date.now())
  if (value <= 0) throw new Error('main_flow_timeout')
  return value
}

function validateLoopbackOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch { return null }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)) }
