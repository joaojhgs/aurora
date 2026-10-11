import {
  cancelIosVoiceMainFlowFixture,
  iosVoiceMainFlowCounters,
  pushIosVoiceMainFlowPcm,
} from './native-ios-voice'
import { createIosVoiceMainFlowAdapter, type IosVoiceMainFlowAdapter, type IosVoiceMainFlowControlResult } from './aurora-client'
import { CACTUS_OFFLINE_ASSISTANT_MODEL, DEFAULT_OFFLINE_ASSISTANT_MODEL } from './tauri-local-inference'
import {
  emptyRuntimeProfileDocument,
  parseRuntimeProfileDocument,
  serializeRuntimeProfileDocument,
} from '@aurora/ui/runtime-profile'

type LoopbackRun = { nonce: string; wavBase64: string; simulatorArchitecture: 'arm64' | 'x86_64'; nativeGateway: { gateway: string; bearer: string } }
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

type IosVoiceSetupStep = NonNullable<IosVoiceMainFlowControlResult['setupStep']>
type IosVoiceSetupFailureCode = NonNullable<IosVoiceMainFlowControlResult['failureCode']>

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
        run,
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
    try {
      await prepareSpeech(ownership, setupDeadline, (step) => { result.setupStep = step })
      result.setupStep = null
      result.failureCode = null
    } catch (error) {
      result.failureCode = classifySpeechSetupFailure(error, result.setupStep)
      throw error
    }
    result.speechReady = true
    result.stage = 'speech_ready'
    result.stage = 'model_setup'
    await prepareModel(ownership, setupDeadline)
    result.modelReady = true
    result.stage = 'model_ready'
    try {
      await readOwnedProfile(ownership)
      const credentialStatus = await adapter.getIosVoiceCredentialStatus()
      const liveStatus = await adapter.getIosVoiceStatus()
      const readiness = await ownership.speech.getReadiness()
      if (!credentialStatus.configured || !credentialStatus.hasBearer || !credentialStatus.remoteAudioConsent
        || liveStatus.details?.nativeTurnTransportAvailable !== true || liveStatus.capability !== 'ios.voiceForegroundCapture'
        || !readiness.available || readiness.state !== 'ready'
        || !(['vad', 'kws', 'stt', 'tts'] as const).every((task) => readiness.capabilities[task])) throw new Error()
    } catch {
      result.stage = 'speech_setup'
      result.setupStep = 'voice_readiness'
      result.failureCode = 'voice_readiness_failed'
      throw new Error('voice_readiness_failed')
    }
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
  readonly initialModelState: 'absent' | 'ready'
  readonly modelId: string
  readonly simulatorArchitecture: 'arm64' | 'x86_64'
  readonly initialSpeechCache: ReadonlyMap<string, boolean>
  readonly gateway: string
  readonly bearer: string
  readonly initialActiveSlots: Record<string, string>
  readonly initiallyInstalledIosPacks: ReadonlySet<string>
  createdProfileId: string | null
  createdLocalNodeId: string | null
  selectedSttPackId: string | null
  credentialCreated: boolean
  createdIosPacks: Array<{ task: 'vad' | 'kws' | 'tts'; packId: string }>
}

async function prepareOfflineSetup(adapter: IosVoiceMainFlowAdapter, run: LoopbackRun, deadline: number, onStep: (step: IosVoiceSetupStep) => void, onOwnershipReady: (ownership: OfflineSetupOwnership) => void): Promise<OfflineSetupOwnership> {
  const simulatorArchitecture = run.simulatorArchitecture
  onStep('profile_read')
  const profileValue = await adapter.getProfile()
  onStep('profile_validation')
  const originalProfileWasNull = profileValue.value == null
  const originalProfileValue = originalProfileWasNull
    ? serializeRuntimeProfileDocument(emptyRuntimeProfileDocument())
    : requireCanonicalEmptyProfile(profileValue.value)
  onStep('preferences_read')
  // On iOS, onboarding mode and runtime tier are read from the active runtime
  // profile (runtimeBackedModePreferenceStore), not generic secure storage. The
  // main flow accepts only an empty profile, so both original selections are
  // absent and the profile readback below is their authoritative restoration.
  const inference = adapter.inference
  onStep('model_status')
  const modelId = simulatorArchitecture === 'arm64'
    ? CACTUS_OFFLINE_ASSISTANT_MODEL
    : DEFAULT_OFFLINE_ASSISTANT_MODEL
  if (simulatorArchitecture === 'arm64') {
    const [engines, catalog] = await Promise.all([inference.engines(), inference.catalog()])
    if (!engines.some((engine) => engine.engine === 'cactus')
      || !catalog.some((entry) => entry.modelId === modelId && entry.capabilities.chat)) {
      throw new Error('cactus_engine_unavailable')
    }
  }
  const model = await inference.modelStatus(modelId)
  if (model.state !== 'absent' && model.state !== 'ready') throw new Error('model_not_owned')
  const speech = adapter.speech
  onStep('voice_credential_status')
  const credentialStatus = await adapter.getIosVoiceCredentialStatus()
  if (credentialStatus.configured || credentialStatus.hasBearer) throw new Error('voice_credential_already_configured')
  const iosStatus = await adapter.getIosVoicePackStatus()
  const iosStatusRecord = iosStatus && typeof iosStatus === 'object' ? iosStatus as Record<string, unknown> : {}
  const installed = Array.isArray(iosStatusRecord.packs) ? iosStatusRecord.packs : []
  const initiallyInstalledIosPacks = new Set(installed.flatMap((item) => item && typeof item === 'object'
    && (item as Record<string, unknown>).installed === true
    && typeof (item as Record<string, unknown>).task === 'string'
    && typeof (item as Record<string, unknown>).packId === 'string'
    ? [`${(item as Record<string, unknown>).task}:${(item as Record<string, unknown>).packId}`] : []))
  const initialActiveSlots = iosStatusRecord.activeSlots && typeof iosStatusRecord.activeSlots === 'object'
    ? { ...(iosStatusRecord.activeSlots as Record<string, string>) } : {}
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
    initialModelState: model.state,
    modelId,
    simulatorArchitecture,
    initialSpeechCache,
    gateway: run.nativeGateway.gateway,
    bearer: run.nativeGateway.bearer,
    initialActiveSlots,
    initiallyInstalledIosPacks,
    createdProfileId: null,
    createdLocalNodeId: null,
    selectedSttPackId: null,
    credentialCreated: false,
    createdIosPacks: [],
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
  if (code === 'voice_credential_already_configured') return 'voice_credential_already_configured'
  if (code === 'offline_profile_option_unavailable') return 'offline_profile_option_unavailable'
  if (code === 'main_flow_timeout' || code === 'main flow timed out') return 'setup_timeout'
  return 'setup_failed'
}

async function prepareSpeech(ownership: OfflineSetupOwnership, setupDeadline: number, onStep: (step: IosVoiceSetupStep) => void): Promise<void> {
  const deadline = Math.min(Date.now() + 650_000, setupDeadline)
  onStep('settings_navigation')
  await openSettings()
  onStep('speech_catalog')
  const catalog = await ownership.speech.listCatalog()
  if (catalog.state !== 'ready') throw new Error('speech_catalog_unavailable')
  onStep('speech_pack_selection')
  const rawValue = await ownership.adapter.listIosVoicePacks()
  const rawEntries = arrayFromCatalogResponse(rawValue)
  const supportedFamilies = new Set(['silero_vad', 'zipformer', 'whisper', 'vits_piper', 'pockettts'])
  const compatible = rawEntries.filter((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    const platforms = Array.isArray(entry.compatiblePlatforms) ? entry.compatiblePlatforms : []
    const architectures = Array.isArray(entry.compatibleArchitectures) ? entry.compatibleArchitectures : []
    const family = typeof entry.modelFamily === 'string' ? entry.modelFamily.toLowerCase() : ''
    return entry.task === 'stt' && entry.acknowledged === true && entry.requiresReferenceAudio !== true && entry.requiresReferenceProfile !== true
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(entry.sha256)
      && typeof (entry.runtimeRevision ?? entry.engineRuntimeRevision) === 'string'
      && platforms.some((value) => typeof value === 'string' && ['ios', 'all'].includes(value.toLowerCase()))
      && architectures.some((value) => typeof value === 'string' && ['all', ownership.simulatorArchitecture].includes(value.toLowerCase()))
      && supportedFamilies.has(family)
  })
  const rawSelected = compatible.find((entry) => typeof entry.packId === 'string' && catalog.items.some((item) => item.packId === entry.packId && item.task === 'stt'))
  const selected = rawSelected ? catalog.items.find((item) => item.packId === rawSelected.packId && item.task === 'stt') : undefined
  if (!selected) throw new Error('speech_pack_unavailable')
  if (ownership.initiallyInstalledIosPacks.has(`stt:${selected.packId}`)
    && ownership.initialActiveSlots.stt !== selected.packId) throw new Error('speech_pack_unavailable')
  ownership.selectedSttPackId = selected.packId
  onStep('voice_credential_setup')
  await readOwnedProfile(ownership)
  const credential = await ownership.adapter.setIosVoiceCredential({
    gateway: ownership.gateway,
    bearer: ownership.bearer,
    remoteAudioConsent: true,
  })
  ownership.credentialCreated = true
  if (!credential.configured || !credential.hasBearer || !credential.remoteAudioConsent) throw new Error('voice_credential_setup_failed')

  onStep('speech_profile_readback')
  const current = await readOwnedProfile(ownership)
  if (current.localNode.localSpeechSelection?.stt?.packId !== selected.packId) {
    onStep('speech_picker_selection')
    await chooseSpeechOption('Choose transcription', selected.displayName, deadline)
  }
  onStep('speech_readiness')
  await waitFor(async () => {
    const document = await readOwnedProfile(ownership)
    const ready = await ownership.speech.getReadiness()
    return document.localNode.localSpeechSelection?.stt?.packId === selected.packId
      && ready.available && ready.activeSlots.stt === selected.packId
  }, remaining(deadline, 650_000))

  onStep('voice_pack_setup')
  const requiredPacks: Partial<Record<'vad' | 'kws' | 'stt' | 'tts', { packId: string; sha256: string; revision: string }>> = {
    stt: { packId: selected.packId, sha256: String(rawSelected?.sha256 ?? ''), revision: String(rawSelected?.runtimeRevision ?? rawSelected?.engineRuntimeRevision ?? '') },
  }
  for (const task of ['vad', 'kws', 'tts'] as const) {
    const entry = rawEntries.find((value): value is Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const item = value as Record<string, unknown>
      const platforms = Array.isArray(item.compatiblePlatforms) ? item.compatiblePlatforms : []
      const architectures = Array.isArray(item.compatibleArchitectures) ? item.compatibleArchitectures : []
      return item.task === task && item.acknowledged === true && item.requiresReferenceAudio !== true && item.requiresReferenceProfile !== true
        && typeof item.packId === 'string' && /^[a-f0-9]{64}$/iu.test(String(item.sha256 ?? ''))
        && typeof (item.runtimeRevision ?? item.engineRuntimeRevision) === 'string'
        && platforms.some((p) => typeof p === 'string' && ['ios', 'all'].includes(p.toLowerCase()))
        && architectures.some((a) => typeof a === 'string' && ['all', ownership.simulatorArchitecture].includes(a.toLowerCase()))
    })
    if (!entry || typeof entry.packId !== 'string') throw new Error('voice_pack_setup_failed')
    requiredPacks[task] = { packId: entry.packId, sha256: String(entry.sha256), revision: String(entry.runtimeRevision ?? entry.engineRuntimeRevision) }
    const status = await ownership.adapter.getIosVoicePackStatus()
    const packs = status && typeof status === 'object' && Array.isArray((status as Record<string, unknown>).packs)
      ? (status as Record<string, unknown>).packs as unknown[] : []
    const installed = packs.some((pack) => pack && typeof pack === 'object' && (pack as Record<string, unknown>).task === task
      && (pack as Record<string, unknown>).packId === entry.packId && (pack as Record<string, unknown>).installed === true)
    if (installed && ownership.initialActiveSlots[task] !== entry.packId) throw new Error('voice_pack_setup_failed')
    if (!installed) {
      await ownership.adapter.downloadIosVoicePack({ task, packId: entry.packId, forceDownload: false, activate: false })
      ownership.createdIosPacks.push({ task, packId: entry.packId })
    }
    await ownership.adapter.activateIosVoicePack({ task, packId: entry.packId, slot: task })
  }
  const status = await ownership.adapter.getIosVoicePackStatus()
  const activeSlots = status && typeof status === 'object' ? (status as Record<string, unknown>).activeSlots as Record<string, string> | undefined : undefined
  if (!activeSlots || !(['vad', 'kws', 'tts', 'stt'] as const).every((task) => {
    const expected = requiredPacks[task as 'vad' | 'kws' | 'stt' | 'tts']
    return expected && activeSlots[task] === expected.packId
  })) throw new Error('voice_pack_setup_failed')
  const statusPacks = status && typeof status === 'object' && Array.isArray((status as Record<string, unknown>).packs)
    ? (status as Record<string, unknown>).packs as unknown[] : []
  for (const [task, expected] of Object.entries(requiredPacks)) {
    const installed = statusPacks.find((pack) => pack && typeof pack === 'object' && (pack as Record<string, unknown>).task === task
      && (pack as Record<string, unknown>).packId === expected?.packId)
    if (!installed || (installed as Record<string, unknown>).installed !== true
      || (installed as Record<string, unknown>).sha256 !== expected?.sha256
      || (installed as Record<string, unknown>).runtimeRevision !== expected?.revision) throw new Error('voice_pack_setup_failed')
  }
  onStep('voice_readiness')
  const [liveStatus, readiness] = await Promise.all([ownership.adapter.getIosVoiceStatus(), ownership.speech.getReadiness()])
  if (liveStatus.details?.nativeTurnTransportAvailable !== true || liveStatus.capability !== 'ios.voiceForegroundCapture' || !readiness.available || readiness.state !== 'ready'
    || !(['vad', 'kws', 'stt', 'tts'] as const).every((task) => readiness.capabilities[task] && readiness.activeSlots[task] === activeSlots[task])) {
    throw new Error('voice_readiness_failed')
  }
}


function arrayFromCatalogResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const entries = record.packs ?? record.entries
  return Array.isArray(entries) ? entries : []
}

function classifySpeechSetupFailure(error: unknown, step: IosVoiceSetupStep | null): IosVoiceSetupFailureCode {
  const code = error instanceof Error ? error.message : ''
  if (code === 'voice_credential_setup_failed') return 'voice_credential_setup_failed'
  if (code === 'voice_pack_setup_failed') return 'voice_pack_setup_failed'
  if (code === 'voice_readiness_failed') return 'voice_readiness_failed'
  if (code === 'speech_catalog_unavailable') return 'speech_catalog_unavailable'
  if (code === 'speech_pack_unavailable') return 'speech_pack_unavailable'
  if (code === 'speech_pack_not_selectable') return 'speech_pack_not_selectable'
  if (code === 'main_flow_timeout' || code === 'main flow timed out') {
    if (step === 'speech_readiness') return 'speech_readiness_timeout'
    if (step === 'speech_picker_selection') return 'speech_picker_timeout'
    return 'speech_setup_timeout'
  }
  switch (step) {
    case 'settings_navigation': return 'speech_settings_navigation_failed'
    case 'speech_catalog': return 'speech_catalog_failed'
    case 'speech_pack_selection': return 'speech_pack_selection_failed'
    case 'speech_profile_readback': return 'speech_profile_readback_failed'
    case 'speech_picker_selection': return 'speech_picker_failed'
    case 'speech_readiness': return 'speech_readiness_failed'
    default: return 'speech_setup_failed'
  }
}

async function prepareModel(ownership: OfflineSetupOwnership, setupDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + 650_000, setupDeadline)
  const before = await ownership.inference.modelStatus(ownership.modelId)
  if (before.state !== 'absent' && before.state !== 'ready') throw new Error('model_not_owned')
  if (before.state !== 'ready') {
    const button = await waitForButtonText('Download offline answers', 30_000)
    button.click()
    await waitFor(async () => (await ownership.inference.modelStatus(ownership.modelId)).state === 'ready', remaining(deadline, 650_000))
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
  const assistantLink = await waitForElement<HTMLAnchorElement>('a[href="/"]', remaining(deadline, 30_000))
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
      if (ownership.credentialCreated) {
        const beforeDelete = await ownership.adapter.getProfile()
        const deleteDocument = parseRuntimeProfileDocument(typeof beforeDelete.value === 'string' ? beforeDelete.value : null)
        if (deleteDocument?.activeProfileId !== ownership.createdProfileId || deleteDocument.profiles.length !== 1
          || deleteDocument.profiles[0]?.localNode.stablePeerId !== ownership.createdLocalNodeId) throw new Error('owned_profile_changed')
        await ownership.adapter.deleteIosVoiceCredential()
        const deletedStatus = await ownership.adapter.getIosVoiceCredentialStatus()
        if (deletedStatus.configured || deletedStatus.hasBearer) throw new Error('voice_credential_cleanup_failed')
      }
      for (const [task, packId] of Object.entries(ownership.initialActiveSlots)) {
        if (['vad', 'kws', 'stt', 'tts'].includes(task) && packId) {
          await ownership.adapter.activateIosVoicePack({ task: task as 'vad' | 'kws' | 'stt' | 'tts', packId, slot: task as 'vad' | 'kws' | 'stt' | 'tts' })
        }
      }
      for (const pack of ownership.createdIosPacks) {
        if (!ownership.initiallyInstalledIosPacks.has(`${pack.task}:${pack.packId}`)) {
          await ownership.adapter.removeIosVoicePack(pack)
        }
      }
      const saved = await ownership.adapter.setProfile(ownership.originalProfileValue)
      if (saved.ok !== true) throw new Error('profile_restore_failed')
      const restored = await ownership.adapter.getProfile()
      const restoredDocument = parseRuntimeProfileDocument(typeof restored.value === 'string' ? restored.value : null)
      profileRestored = restoredDocument?.profiles.length === 0 && restoredDocument.activeProfileId === null
        && (ownership.originalProfileWasNull || restored.value === ownership.originalProfileValue)
    }
    if (!profileRestored) throw new Error('profile_restore_failed')
    // iOS selection state is profile-backed, and its original canonical-empty
    // profile was just read back above. Do not invoke desktop/Android generic
    // secure-storage commands, which are intentionally unsupported on iOS.
    preferencesRestored = profileRestored
    if (ownership.createdProfileId && !runtimeDisposed) throw new Error('assistant_runtime_disposal_unavailable')
    if (runtimeDisposed) {
      if (ownership.selectedSttPackId && ownership.initialSpeechCache.get(`stt:${ownership.selectedSttPackId}`) !== true) {
        if (Date.now() >= deadline) throw new Error('cleanup_timeout')
        await ownership.speech.remove({ task: 'stt', packId: ownership.selectedSttPackId })
      }
      if (ownership.initialModelState === 'absent') {
        if (Date.now() >= deadline) throw new Error('cleanup_timeout')
        const model = await ownership.inference.modelStatus(ownership.modelId)
        if (model.state !== 'absent') await ownership.inference.deleteModel(ownership.modelId)
        if ((await ownership.inference.modelStatus(ownership.modelId)).state !== 'absent') throw new Error('model_cleanup_failed')
      }
    }
    const speechCatalog = await ownership.speech.listCatalog()
    const speechEntry = speechCatalog.items.find((item) => item.task === 'stt' && item.packId === ownership.selectedSttPackId)
    const modelStatus = await ownership.inference.modelStatus(ownership.modelId)
    const speechWasCached = ownership.selectedSttPackId
      ? ownership.initialSpeechCache.get(`stt:${ownership.selectedSttPackId}`) === true
      : false
    const speechRestored = !ownership.selectedSttPackId
      || (speechEntry !== undefined && speechEntry.cached === speechWasCached)
    const iosStatus = await ownership.adapter.getIosVoicePackStatus()
    const currentPacks = iosStatus && typeof iosStatus === 'object' && Array.isArray((iosStatus as Record<string, unknown>).packs)
      ? (iosStatus as Record<string, unknown>).packs as unknown[] : []
    const iosPacksRestored = ownership.createdIosPacks.every(({ task, packId }) => !currentPacks.some((pack) => pack && typeof pack === 'object'
      && (pack as Record<string, unknown>).task === task && (pack as Record<string, unknown>).packId === packId
      && (pack as Record<string, unknown>).installed === true))
    ownedAssetsRemoved = speechRestored && iosPacksRestored && modelStatus.state === ownership.initialModelState
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
  const rawGateway = run.nativeGateway
  if (!rawGateway || typeof rawGateway !== 'object' || Array.isArray(rawGateway)) throw new Error('invalid gateway configuration')
  const gateway = rawGateway as Record<string, unknown>
  if (typeof gateway.gateway !== 'string' || typeof gateway.bearer !== 'string' || !gateway.bearer.trim()) throw new Error('invalid gateway configuration')
  try {
    const url = new URL(gateway.gateway)
    if (!['https:', 'http:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
  } catch { throw new Error('invalid gateway configuration') }
  return { nonce: run.nonce, wavBase64: run.wavBase64, simulatorArchitecture: run.simulatorArchitecture, nativeGateway: { gateway: gateway.gateway, bearer: gateway.bearer } }
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
