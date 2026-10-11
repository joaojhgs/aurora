import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { startHostedUi } from './run-android-three-node-live.mjs'
import { runAndroidLocalInferenceMainFlow } from './android-local-inference-main-flow.mjs'
import { activeAndroidProfileDocument, androidEvaluate, clickAndroidControl, createPairingCleanup } from './android-native-turn-pairing.mjs'
import { navigateAndroidToMesh, resolveAndroidDeviceSerial, runAndroidVoiceLiveSmoke } from './android-voice-live-smoke.mjs'

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKSPACE_ROOT = resolve(APP_ROOT, '../..')
const FIXTURE = resolve(APP_ROOT, 'scripts/fixture-openai-stream.mjs')
const DEFAULTS = resolve(WORKSPACE_ROOT, 'app/services/config/config_defaults.json')
export const AUTHORIZED_NATIVE_ASSISTANT_METHOD = 'Orchestrator.ExternalUserInput'
const HOSTED_PEER_PYTHON_PERMISSIONS = Object.freeze([
  'Gateway.use', 'Gateway.GetRegistry', 'Gateway.GetCapabilityCatalog', 'Gateway.GetCapabilityGraph',
  'Gateway.GetMeshStatus', 'Gateway.GetWebRTCDiagnostics', 'Auth.WhoAmI', 'Auth.MeshListPeers',
  'Auth.MeshGetPeer', 'Config.use', 'Orchestrator.use', 'TTS.use', 'DB.use', 'Tooling.use',
  'Scheduler.use', 'Backup.use',
])

export function acceptanceEnvironment(environment = process.env) {
  const mainFlowOnly = environment.AURORA_ANDROID_MAIN_FLOW_ONLY === '1'
  const required = ['AURORA_THREE_NODE_BROKER_URL']
  const missing = required.filter((key) => !environment[key])
  if (missing.length > 0) throw new Error(`Successful native turn acceptance requires authorized three-node configuration: ${missing.join(', ')}.`)
  return {
    ...environment,
    AURORA_ANDROID_NATIVE_TURN_ACCEPTANCE: '1',
    AURORA_MODEL_FIXTURE_LABEL: 'deterministic OpenAI-compatible model fixture',
    AURORA_ANDROID_NATIVE_EVENT_BRIDGE_ACCEPTANCE: '1',
    AURORA_ANDROID_NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE: mainFlowOnly ? '0' : '1',
    AURORA_NATIVE_ASSISTANT_METHOD: AUTHORIZED_NATIVE_ASSISTANT_METHOD,
    LLM_PROVIDER: 'openai',
    OPENAI_MODEL: 'aurora-ui-acceptance-fixture',
    OPENAI_API_KEY: 'fixture-only',
    AURORA_THREE_NODE_GATEWAY_API_KEY: environment.AURORA_THREE_NODE_GATEWAY_API_KEY ?? `fixture-${randomUUID()}`,
  }
}

export function acceptanceCommands() {
  return {
    modelFixture: ['node', FIXTURE],
    threeNode: ['pnpm', 'android:three-node:live'],
    voiceTurn: ['pnpm', 'android:voice:live'],
  }
}

export function buildIsolatedAssistantConfig({ gatewayPort, brokerUrl, appId, room, roomPassword = '' }) {
  const config = JSON.parse(readFileSync(DEFAULTS, 'utf8'))
  config.ui.activate = false
  config.services.orchestrator.enabled = true
  config.services.orchestrator.llm.provider = 'openai'
  config.services.orchestrator.llm.third_party.openai.options.model = 'aurora-ui-acceptance-fixture'
  config.services.orchestrator.llm.third_party.openai.options.api_key = 'fixture-only'
  config.services.auth.enabled = true
  config.services.auth.webrtc_auth_timeout_seconds = 30
  config.services.auth.webrtc_pairing_timeout_seconds = 120
  config.services.db.enabled = true
  config.services.db.embeddings.use_local = false
  config.services.tooling.enabled = true
  config.services.scheduler.enabled = false
  config.services.stt.coordinator.enabled = false
  config.services.stt.transcription.enabled = false
  config.services.stt.wakeword.enabled = false
  config.services.gateway.enabled = true
  config.services.gateway.api.host = '127.0.0.1'
  config.services.gateway.api.port = Number(gatewayPort)
  config.services.gateway.mesh_network.enabled = true
  config.services.gateway.mesh_network.node_name = 'Native turn acceptance Python'
  config.services.gateway.webrtc.enabled = true
  config.services.gateway.webrtc.strategy = 'mqtt'
  config.services.gateway.webrtc.app_id = appId
  config.services.gateway.webrtc.room = room
  config.services.gateway.webrtc.password = roomPassword
  config.services.gateway.webrtc.encrypt_signaling = true
  config.services.gateway.webrtc.enable_app_layer_e2ee = true
  config.services.gateway.webrtc.legacy_event_broadcast = false
  config.services.gateway.webrtc.stun_servers = []
  config.services.gateway.webrtc.turn_servers = []
  config.services.gateway.signaling_mqtt.brokers = [brokerUrl]
  config.services.gateway.signaling_mqtt.topic_root = 'aurora'
  return config
}

export async function allocateLocalPort() {
  const server = createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
  if (!port) throw new Error('Could not allocate local gateway port.')
  return port
}

export async function waitForOwnedStack({ baseUrl, apiKey, expectedNodeName, expectedAppId, expectedRoom, child, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childExited(child)) throw new Error(`Aurora main.py exited before health readiness (status ${child.exitCode ?? child.signalCode ?? 'unknown'}).`)
    try {
      const health = await fetch(`${baseUrl}/api/health`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(5_000) })
      const healthBody = await health.json()
      if (!health.ok || healthBody.status !== 'healthy' || healthBody.gateway !== 'up') throw new Error('gateway_not_healthy')
      const headers = { 'X-API-Key': apiKey, 'content-type': 'application/json' }
      const meshResponse = await fetch(`${baseUrl}/api/Gateway/GetMeshStatus`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5_000) })
      const mesh = await meshResponse.json()
      const inviteResponse = await fetch(`${baseUrl}/api/Gateway/GetMeshInviteConfig`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5_000) })
      const invite = await inviteResponse.json()
      const local = mesh.local ?? {}
      if (meshResponse.ok && inviteResponse.ok && local.mesh_started === true && local.webrtc_started === true && local.node_name === expectedNodeName && invite.app_id === expectedAppId && invite.room === expectedRoom) return { health: healthBody, mesh, invite }
    } catch { /* wait for the real service */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error(`Timed out waiting for owned Aurora mesh stack at ${baseUrl}.`)
}

export async function stopChild(child, { graceMs = 5_000 } = {}) {
  if (!child || childExited(child)) return
  const signalGroup = (signal) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); return } catch { /* process group may already be gone */ }
    }
    try { child.kill(signal) } catch { /* child already exited */ }
  }
  const waitForExit = (timeoutMs) => new Promise((resolvePromise) => {
    if (childExited(child)) return resolvePromise(true)
    const timer = setTimeout(resolvePromise, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolvePromise(true) })
  })
  signalGroup('SIGTERM')
  await waitForExit(graceMs)
  if (childExited(child)) return
  signalGroup('SIGKILL')
  await waitForExit(graceMs)
  if (!childExited(child)) throw new Error(`Owned process ${child.pid ?? 'unknown'} did not exit after SIGKILL; refusing temporary-data deletion.`)
}

function childExited(child) {
  return child.exitCode != null || child.signalCode != null
}

export async function cleanupAcceptanceResources({ python, fixture, configDir, hostedSpeechConsumer, stop = stopChild, remove = (directory) => rmSync(directory, { recursive: true, force: true }) }) {
  const errors = []
  try {
    await hostedSpeechConsumer?.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await stop(python)
    if (configDir) remove(configDir)
  } catch (error) {
    errors.push(error)
  }
  try {
    await stop(fixture)
  } catch (error) {
    errors.push(error)
  }
  return errors
}

export function throwAcceptanceErrors(primaryError, cleanupErrors) {
  const errors = primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Native turn acceptance and cleanup failures occurred.')
}

async function createHostedPeerSpeechConsumer({ environment, gatewayUrl, gatewayApiKey, inviteText }) {
  let hostedUi
  let browser
  let browserContext
  let page
  let browserPeerId
  let androidPairingCleanup
  let speechPolicyRestore
  let closed = false
  let closePromise
  const probe = () => page?.evaluate(() => window.__auroraHostedPeerSpeech?.close())
  const close = async () => {
    if (closePromise) return await closePromise
    closed = true
    closePromise = (async () => {
      const errors = []
      try { await probe() } catch (error) { errors.push(error) }
      try { await speechPolicyRestore?.() } catch (error) { errors.push(error) }
      try { await androidPairingCleanup?.() } catch (error) { errors.push(error) }
      try { await browserContext?.close() } catch (error) { errors.push(error) }
      try { await browser?.close() } catch (error) { errors.push(error) }
      try { await hostedUi?.close() } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'Hosted speech consumer cleanup failed.')
    })()
    return await closePromise
  }
  try {
    hostedUi = await startHostedUi({
      configuration: { baseUrl: '' },
      environment: { ...environment, NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST: '1' },
    })
    browser = await chromium.launch({ headless: true })
    browserContext = await browser.newContext()
    page = await browserContext.newPage()
    browserPeerId = await joinOwnedPythonMesh(page, hostedUi.baseUrl, gatewayUrl, gatewayApiKey, inviteText)
    await page.waitForFunction(() => typeof window.__auroraHostedPeerSpeech?.run === 'function', null, { timeout: 30_000 })
    const connected = await waitForHosted(async () => {
      const response = await hostedGatewayPost(gatewayUrl, gatewayApiKey, '/api/Gateway/GetWebRTCDiagnostics')
      return (response.peers ?? []).some((peer) => peer.stable_peer_id === browserPeerId
        && peer.connection_state === 'connected' && peer.data_channel_state === 'open'
        && peer.auth_state === 'authenticated'
        && Number(peer.effective_permission_count) === HOSTED_PEER_PYTHON_PERMISSIONS.length)
    }, 'the authenticated browser connection to the owned Python host')
    if (!connected) throw new Error('Hosted browser did not authenticate with the owned Python host.')
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Hosted browser setup and cleanup failed.')
    }
    throw error
  }

  return {
    async run({ androidClient, invoke, activeProfile, foregroundAudioBase64, wakeAudioBase64 }) {
      if (closed || !page || !browserPeerId) throw new Error('Hosted speech consumer is unavailable.')
      const stored = await invoke('aurora_thin_profile_get')
      const originalProfileValue = stored?.value
      const { active } = activeAndroidProfileDocument(originalProfileValue)
      const androidPeerId = active.localNode.stablePeerId
      const androidNodeName = active.localNode.nodeName
      if (androidPeerId !== activeProfile?.localNode?.stablePeerId || !androidNodeName) {
        throw new Error('Android speech consumer identity changed before hosted pairing.')
      }
      if (active.nodeMode !== 'mesh-node' || active.runtimeTier !== 'lightweight-ts') {
        throw new Error('Android must be using its existing local speech-device role for this flow.')
      }
      const previousCredential = await invoke('aurora_thin_peer_credential_status', { request: { peerId: browserPeerId } })
      if (previousCredential?.found !== false) throw new Error('Android already has a browser credential; refusing profile mutation.')
      androidPairingCleanup = createPairingCleanup({ invoke, originalProfileValue, pythonPeerId: browserPeerId, previousCredential })
      try {
        speechPolicyRestore = await enableHostedSpeechSharing(androidClient, invoke, {
          profileId: active.id,
          stablePeerId: androidPeerId,
        })
        await navigateAndroidToMesh(androidClient)
        await pairHostedBrowserWithAndroid({ page, androidClient, androidPeerId, androidNodeName, browserPeerId })
        const credential = await invoke('aurora_thin_peer_credential_status', { request: { peerId: browserPeerId } })
        if (credential?.found !== true || credential?.hasBearerToken !== true
          || credential?.credential?.claimantPeerId !== androidPeerId) {
          throw new Error('Android did not retain the authenticated browser credential.')
        }
        const nativeSession = await invoke('aurora_mesh_session_snapshot')
        if (!nativeSession?.peers?.some((peer) => peer.peerId === browserPeerId && Number.isInteger(peer.connectionId))) {
          throw new Error('Android did not bind the authenticated browser session.')
        }
        const summary = await page.evaluate(async ({ peerId, foregroundAudioBase64, wakeAudioBase64 }) => {
          const probe = window.__auroraHostedPeerSpeech
          if (!probe) throw new Error('hosted_speech_probe_unavailable')
          return await probe.run({ peerId, foregroundAudioBase64, wakeAudioBase64 })
        }, { peerId: androidPeerId, foregroundAudioBase64, wakeAudioBase64 })
        return validateHostedSpeechSummary(summary)
      } catch {
        throw new Error('The authenticated hosted speech main flow did not complete.')
      }
    },
    close,
  }
}

const HOSTED_SPEECH_POLICY_SWITCHES = Object.freeze({
  stt: 'Share speech recognition',
  tts: 'Share spoken answers',
  kws: 'Share wake-word detection',
  vad: 'Share speech detection',
  kwsRemote: 'Allow connected wake-word requests',
  vadRemote: 'Allow connected speech-detection requests',
})

async function enableHostedSpeechSharing(androidClient, invoke, owner) {
  if (typeof owner.profileId !== 'string' || owner.profileId.trim() === ''
    || typeof owner.stablePeerId !== 'string' || owner.stablePeerId.trim() === '') {
    throw new Error('Android speech settings require an identified active profile owner.')
  }
  let originalValues = null
  let changed = false
  let restored = false

  const assertSameOwner = async () => {
    const current = await invoke('aurora_thin_profile_get')
    const { active } = activeAndroidProfileDocument(current?.value)
    if (active.id !== owner.profileId || active.localNode.stablePeerId !== owner.stablePeerId
      || active.nodeMode !== 'mesh-node' || active.runtimeTier !== 'lightweight-ts') {
      throw new Error('The active Android speech settings owner changed during the connected flow.')
    }
  }

  const openSettings = async () => {
    const opened = await androidEvaluate(androidClient, `(() => {
      const link = [...document.querySelectorAll('a[href="/settings"]')]
        .find((candidate) => candidate.getClientRects().length > 0);
      if (!link) return false;
      link.click();
      return true;
    })()`)
    if (opened !== true) throw new Error('Android Settings is not available through the current profile UI.')
    await waitForHosted(async () => await androidEvaluate(androidClient, `(() =>
      window.location.pathname === '/settings'
      && document.body?.innerText?.includes('Listening and speaking') === true
    )()`), 'Android owner-bound speech settings', 30_000)
    await waitForHosted(async () => {
      const values = await readHostSpeechSwitches(androidClient)
      return values ? values : null
    }, 'the saved Android speech sharing choices', 30_000)
  }

  const applyValues = async (values) => {
    let didChange = false
    const order = [
      'stt',
      'tts',
      ...(values.kws ? ['kws', 'kwsRemote'] : ['kwsRemote', 'kws']),
      ...(values.vad ? ['vad', 'vadRemote'] : ['vadRemote', 'vad']),
    ]
    for (const key of order) {
      const label = HOSTED_SPEECH_POLICY_SWITCHES[key]
      const desired = values[key]
      const current = await readHostSpeechSwitch(androidClient, label)
      if (current === desired) continue
      changed = true
      didChange = true
      const clicked = await androidEvaluate(androidClient, `(() => {
        const control = [...document.querySelectorAll('[role="switch"]')]
          .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)}
            && candidate.getClientRects().length > 0);
        if (!control || control.getAttribute('aria-disabled') === 'true' || control.disabled) return false;
        control.click();
        return true;
      })()`)
      if (clicked !== true) throw new Error(`Android could not update the saved ${key} sharing choice.`)
      const toggled = await waitForHosted(async () => (await readHostSpeechSwitch(androidClient, label)) === desired,
        `the ${key} speech sharing choice`, 10_000)
      if (toggled !== true) throw new Error(`Android did not update the saved ${key} sharing choice.`)
    }
    return didChange
  }

  const saveAndVerify = async (values) => {
    await assertSameOwner()
    const changedValues = await readHostSpeechSwitches(androidClient)
    if (!changedValues || !Object.keys(values).every((key) => changedValues[key] === values[key])) {
      throw new Error('Android speech sharing draft did not match the requested owner choices.')
    }
    const saved = await androidEvaluate(androidClient, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Save choices'
          && !candidate.disabled && candidate.getClientRects().length > 0);
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (saved !== true) throw new Error('Android speech sharing choices could not be saved.')
    const readBack = await waitForHosted(async () => {
      const current = await readHostSpeechSwitches(androidClient)
      const body = await androidEvaluate(androidClient, 'document.body?.innerText ?? ""')
      const matches = current && Object.keys(values).every((key) => current[key] === values[key])
      const acknowledged = typeof body === 'string'
        && (body.includes('Saved for your next conversation.')
          || body.includes('Saved, but current transcription status could not be confirmed.'))
      return matches && acknowledged ? current : null
    }, 'the acknowledged Android speech sharing policy', 30_000)
    if (!readBack) throw new Error('Android speech sharing policy was not confirmed after saving.')
    await assertSameOwner()
  }

  const restore = async () => {
    if (!changed || restored || !originalValues) return
    await assertSameOwner()
    await openSettings()
    const needsSave = await applyValues(originalValues)
    if (needsSave) await saveAndVerify(originalValues)
    await assertSameOwner()
    restored = true
  }

  try {
    await assertSameOwner()
    await openSettings()
    originalValues = await readHostSpeechSwitches(androidClient)
    if (!originalValues) throw new Error('Android owner-bound speech sharing choices are unavailable.')
    const enabledValues = Object.fromEntries(Object.keys(HOSTED_SPEECH_POLICY_SWITCHES).map((key) => [key, true]))
    const needsSave = await applyValues(enabledValues)
    if (needsSave) await saveAndVerify(enabledValues)
    await assertSameOwner()
    return async () => {
      await restore()
      await navigateAndroidToMesh(androidClient)
    }
  } catch (error) {
    if (changed && originalValues) {
      try { await restore() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Android speech policy setup and restoration failed.')
      }
    }
    throw error
  }
}

async function readHostSpeechSwitches(androidClient) {
  const values = {}
  for (const [key, label] of Object.entries(HOSTED_SPEECH_POLICY_SWITCHES)) {
    values[key] = await readHostSpeechSwitch(androidClient, label)
    if (typeof values[key] !== 'boolean') return null
  }
  return values
}

async function readHostSpeechSwitch(androidClient, label) {
  return await androidEvaluate(androidClient, `(() => {
    const control = [...document.querySelectorAll('[role="switch"]')]
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)}
        && candidate.getClientRects().length > 0);
    if (!control) return null;
    const value = control.getAttribute('aria-checked');
    return value === 'true' ? true : value === 'false' ? false : null;
  })()`)
}

async function joinOwnedPythonMesh(page, baseUrl, gatewayUrl, gatewayApiKey, inviteText) {
  const browserName = `Aurora hosted speech ${randomUUID().slice(0, 8)}`
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('radio', { name: /Make this device available/u }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('textbox', { name: 'This device name', exact: true }).fill(browserName)
  await page.getByLabel('Paste invite').fill(inviteText)
  await page.getByRole('button', { name: 'Save invite and continue' }).click()
  await page.waitForURL(/\/mesh/u, { timeout: 30_000 })
  const review = page.getByRole('button', { name: 'Review & approve' })
  await review.waitFor({ state: 'visible', timeout: 90_000 })
  await review.click()
  const dialog = page.getByRole('dialog')
  const code = normalizeHostedCode(await dialog.locator('code[aria-label^="Verification code "]').getAttribute('aria-label'))
  if (!code) throw new Error('Hosted browser pairing code is missing.')
  const pending = await waitForHosted(async () => {
    const response = await hostedGatewayPost(gatewayUrl, gatewayApiKey, '/api/Auth/ListPendingPairings')
    const matches = (response.pairings ?? []).filter((pairing) => pairing.status === 'pending'
      && normalizeHostedCode(pairing.verification_code) === code)
    if (matches.length > 1) throw new Error('Hosted browser pairing is ambiguous.')
    return matches[0] ?? null
  }, 'the exact browser pairing request')
  if (!pending?.code || !pending.remote_peer_id) throw new Error('Hosted browser pairing identity is unavailable.')
  await approveHostedBrowserPairing(gatewayUrl, gatewayApiKey, pending)
  await dialog.getByRole('button', { name: 'Approve & pair' }).click()
  const roster = await waitForHosted(async () => {
    const response = await hostedGatewayPost(gatewayUrl, gatewayApiKey, '/api/Auth/MeshListPeers')
    return (response.peers ?? []).some((peer) => peer.peer_id === pending.remote_peer_id
      && peer.outbound_status === 'approved' && peer.inbound_status === 'approved'
      && peer.connection_status === 'connected')
  }, 'the bilaterally approved browser connection')
  if (!roster) throw new Error('Hosted browser was not connected to the owned Python host.')
  return pending.remote_peer_id
}

async function approveHostedBrowserPairing(gatewayUrl, apiKey, pending) {
  const payload = { code: pending.code, permissions: HOSTED_PEER_PYTHON_PERMISSIONS, is_admin: false }
  const draft = await hostedGatewayPost(gatewayUrl, apiKey, '/api/Gateway/AdminActionDraft', {
    method_id: 'Auth.PairingApprove', payload,
  })
  const confirmation = await hostedGatewayPost(gatewayUrl, apiKey, '/api/Gateway/AdminActionConfirm', {
    action_id: draft.action_id,
    nonce: draft.nonce,
    digest: draft.digest,
    reason: 'Verify the owned hosted speech consumer connection.',
    reauth_confirmed: true,
    phrase: draft.required_phrase,
  })
  const response = await fetch(`${gatewayUrl}/api/Auth/PairingApprove`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'X-Aurora-AdminAction-Id': confirmation.action_id,
      'X-Aurora-AdminAction-Token': confirmation.confirmation_token,
      'X-Aurora-AdminAction-Digest': confirmation.digest,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Owned browser pairing approval was rejected.')
}

async function pairHostedBrowserWithAndroid({ page, androidClient, androidPeerId, androidNodeName, browserPeerId }) {
  await page.goto(new URL('/mesh', page.url()).toString(), { waitUntil: 'domcontentloaded' })
  const refreshBrowser = page.getByRole('button', { name: 'Refresh' }).first()
  await refreshBrowser.click()
  await clickAndroidControl(androidClient, 'Refresh')
  const deviceName = page.getByLabel('Devices in this Aurora').getByText(androidNodeName, { exact: true })
  await deviceName.waitFor({ state: 'visible', timeout: 90_000 })
  await deviceName.locator('..').locator('..').getByRole('button', { name: 'Set up' }).click()
  const browserReview = page.getByRole('button', { name: 'Review & approve' })
  await browserReview.waitFor({ state: 'visible', timeout: 90_000 })
  await browserReview.click()
  const browserDialog = page.getByRole('dialog')
  const browserCode = normalizeHostedCode(await browserDialog.locator('code[aria-label^="Verification code "]').getAttribute('aria-label'))
  if (!browserCode) throw new Error('Android pairing code was not displayed to the hosted browser.')
  const androidCode = await waitForHosted(async () => {
    const code = await androidEvaluate(androidClient, `(() => document.querySelector('[role="dialog"] code[aria-label^="Verification code "]')?.getAttribute('aria-label')?.replace(/^Verification code\\s+/u, '') ?? '')()`)
    if (normalizeHostedCode(code)) return normalizeHostedCode(code)
    await clickAndroidControl(androidClient, 'Refresh')
    await clickAndroidControl(androidClient, 'Review & approve')
    return ''
  }, 'Android direct-pairing review')
  if (androidCode !== browserCode) throw new Error('The browser and Android pairing codes did not match.')
  const androidApprove = waitForHosted(async () => await clickAndroidControl(androidClient, 'Approve & pair'), 'Android direct-pairing approval')
  await Promise.all([browserDialog.getByRole('button', { name: 'Approve & pair' }).click(), androidApprove])
  const admitted = await waitForHosted(async () => {
    const session = await androidEvaluate(androidClient, `window.__TAURI_INTERNALS__?.invoke('aurora_mesh_session_snapshot')`)
    const snapshot = typeof session === 'string' ? safeJson(session) : session
    return snapshot?.peers?.some((peer) => peer.peerId === browserPeerId) === true
  }, 'Android native session after browser pairing')
  if (!admitted) throw new Error('Android did not establish the approved browser session.')
}

async function hostedGatewayPost(gatewayUrl, apiKey, path, body = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Owned Aurora host request failed.')
  return await response.json()
}

async function waitForHosted(read, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

function normalizeHostedCode(value) {
  return String(value ?? '').replace(/Verification code /u, '').replace(/\s+/gu, '')
}

function safeJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function validateHostedSpeechSummary(value) {
  if (!value || !Number.isSafeInteger(value.sttCharacters) || value.sttCharacters <= 0
    || !Number.isFinite(value.sttDurationMs) || value.sttDurationMs <= 0
    || !Number.isSafeInteger(value.ttsBytes) || value.ttsBytes <= 44
    || !Number.isFinite(value.ttsDurationMs) || value.ttsDurationMs <= 0) {
    throw new Error('Native finite speech results were incomplete.')
  }
  for (const stage of [value.kws, value.vad]) {
    if (stage?.state !== 'completed' || !Number.isSafeInteger(stage.inputCount) || stage.inputCount <= 0
      || !Number.isSafeInteger(stage.outputCount) || stage.outputCount <= 0) {
      throw new Error('Native foreground speech session results were incomplete.')
    }
  }
  return {
    stt: { characters: value.sttCharacters, durationMs: value.sttDurationMs },
    tts: { bytes: value.ttsBytes, durationMs: value.ttsDurationMs },
    kws: value.kws,
    vad: value.vad,
  }
}

export async function armFixtureTurn(fixtureUrl, turnId) {
  const response = await fetch(`${fixtureUrl}/__fixture/arm/${encodeURIComponent(turnId)}`, { method: 'POST' })
  if (!response.ok) throw new Error(`Could not arm model fixture turn ${turnId} (status ${response.status}).`)
}

export function createFixtureTurnControl(fixtureUrl, turnId, { partialText = process.env.AURORA_MODEL_FIXTURE_PARTIAL ?? 'Fixture partial response', completedText = process.env.AURORA_MODEL_FIXTURE_COMPLETED ?? 'Fixture completed response' } = {}) {
  return {
    turnId,
    partialText,
    completedText,
    arm: () => armFixtureTurn(fixtureUrl, turnId),
    async waitPending(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const response = await fetch(`${fixtureUrl}/__fixture/status/${encodeURIComponent(turnId)}`)
        const status = await response.json()
        if (status.pending === true) return status
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
      }
      throw new Error(`Model fixture did not receive target turn ${turnId} before the deadline.`)
    },
    async resume() {
      const response = await fetch(`${fixtureUrl}/__fixture/resume/${encodeURIComponent(turnId)}`, { method: 'POST' })
      if (!response.ok) throw new Error(`Could not resume model fixture turn ${turnId} (status ${response.status}).`)
      return await response.json()
    },
  }
}

export async function readFixtureReady(fixture, timeoutMs = 15_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = ''
    const timer = setTimeout(() => settle(new Error('Model fixture did not publish readiness metadata before the deadline.')), timeoutMs)
    const settle = (error, value) => {
      clearTimeout(timer)
      fixture.stdout.off('data', onData)
      fixture.off('error', onError)
      fixture.off('exit', onExit)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const onError = (error) => settle(error)
    const onExit = (code) => settle(new Error(`Model fixture exited before readiness (status ${code ?? 'unknown'}).`))
    const onData = (chunk) => {
      buffer += String(chunk)
      for (const line of buffer.split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const metadata = JSON.parse(line)
          if (metadata.baseUrl) {
            settle(null, metadata.baseUrl)
            return
          }
        } catch { /* accumulate until a complete JSON line arrives */ }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
    }
    fixture.stdout.on('data', onData)
    fixture.once('error', onError)
    fixture.once('exit', onExit)
  })
}

export function installWorkspacePlaywrightChromium() {
  execFileSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    timeout: 180_000,
  })
}

export async function runAcceptance() {
  const environment = acceptanceEnvironment()
  const mainFlowOnly = environment.AURORA_ANDROID_MAIN_FLOW_ONLY === '1'
  const adb = resolveAdbCommand(environment)
  const explicitSerial = environment.AURORA_ANDROID_DEVICE_SERIAL ?? environment.ANDROID_SERIAL
  const serial = resolveAndroidDeviceSerial(
    execFileSync(adb, ['devices', '-l'], { encoding: 'utf8', timeout: 30_000 }),
    explicitSerial,
  )
  const androidAppId = environment.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
  Object.assign(environment, { ADB: adb, AURORA_ANDROID_DEVICE_SERIAL: serial, AURORA_ANDROID_APP_ID: androidAppId })
  installWorkspacePlaywrightChromium()
  const turnId = `native-turn-${randomUUID()}`
  const fixturePartialText = `Fixture partial response ${turnId}`
  const fixtureCompletedText = `Fixture completed response ${turnId}`
  const fixtureEnvironment = {
    ...environment,
    AURORA_MODEL_FIXTURE_PARTIAL: fixturePartialText,
    AURORA_MODEL_FIXTURE_COMPLETED: fixtureCompletedText,
  }
  let fixtureUrl = ''
  let python
  let configDir
  let brokerReverse
  let hostedSpeechConsumer
  let primaryError
  let voiceMainAttempted = false
  let voiceMainReadyOnOwnedApk = false
  let voiceCleanupFailed = false
  const fixture = spawn('node', [FIXTURE], { cwd: WORKSPACE_ROOT, env: fixtureEnvironment, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
  try {
    fixtureUrl = await readFixtureReady(fixture)
    const runEnvironment = {
      ...environment,
      OPENAI_BASE_URL: `${fixtureUrl}/v1`,
    }
    const gatewayPort = await allocateLocalPort()
    brokerReverse = await reverseLoopbackBroker(environment, environment.AURORA_THREE_NODE_BROKER_URL)
    const appId = `aurora-native-turn-${randomUUID().slice(0, 8)}`
    const room = `native-turn-${randomUUID().slice(0, 8)}`
    const roomPassword = `fixture-room-${randomUUID()}`
    Object.assign(runEnvironment, {
      AURORA_THREE_NODE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      AURORA_THREE_NODE_GATEWAY_API_KEY: environment.AURORA_THREE_NODE_GATEWAY_API_KEY,
      AURORA_WEBRTC_PASSWORD: roomPassword,
    })
    configDir = mkdtempSync(join(os.tmpdir(), 'aurora-native-turn-ui-'))
    const configPath = join(configDir, 'config.json')
    writeFileSync(configPath, JSON.stringify(buildIsolatedAssistantConfig({
      gatewayPort,
      brokerUrl: runEnvironment.AURORA_THREE_NODE_BROKER_URL,
      appId,
      room,
      roomPassword,
    })))
    python = spawn('uv', ['run', 'python', 'main.py'], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...runEnvironment,
        AURORA_ARCHITECTURE_MODE: 'threads',
        AURORA_CONFIG_FILE: configPath,
        AURORA_DATA_DIR: configDir,
        AURORA_GATEWAY_API_KEYS: runEnvironment.AURORA_THREE_NODE_GATEWAY_API_KEY,
        AURORA_WEBRTC_PASSWORD: roomPassword,
        OPENAI_BASE_URL: `${fixtureUrl}/v1`,
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'inherit',
      detached: true,
    })
    const ownedStack = await waitForOwnedStack({ baseUrl: runEnvironment.AURORA_THREE_NODE_GATEWAY_URL, apiKey: runEnvironment.AURORA_THREE_NODE_GATEWAY_API_KEY, expectedNodeName: 'Native turn acceptance Python', expectedAppId: appId, expectedRoom: room, child: python })
    const inviteText = JSON.stringify({
      kind: 'aurora.mesh.invite',
      version: 1,
      generated_at: new Date().toISOString(),
      node: { peer_id: ownedStack.mesh.local?.peer_id, node_name: ownedStack.mesh.local?.node_name },
      mesh: { enabled: true, version_policy: ownedStack.mesh.local?.version_policy ?? 'compatible', peer_selection: ownedStack.mesh.local?.peer_selection ?? 'lowest_latency' },
      signaling: { provider: 'mqtt', app_id: ownedStack.invite.app_id, room: ownedStack.invite.room, room_password: ownedStack.invite.room_password, encrypt_signaling: true, mqtt_brokers: [runEnvironment.AURORA_THREE_NODE_BROKER_URL], mqtt_topic_root: 'aurora' },
      webrtc: { enabled: true, strategy: 'mqtt', enable_app_layer_e2ee: true, legacy_event_broadcast: false, stun_servers: [], turn_servers: [] },
    })
    const fixtureTurn = createFixtureTurnControl(fixtureUrl, turnId, {
      partialText: fixturePartialText,
      completedText: fixtureCompletedText,
    })
    if (environment.AURORA_ANDROID_MAIN_FLOW_ONLY === '1') {
      hostedSpeechConsumer = await createHostedPeerSpeechConsumer({
        environment,
        gatewayUrl: runEnvironment.AURORA_THREE_NODE_GATEWAY_URL,
        gatewayApiKey: runEnvironment.AURORA_THREE_NODE_GATEWAY_API_KEY,
        inviteText,
      })
    }
    const request = {
      post: async (url, options = {}) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: options.headers,
          body: JSON.stringify(options.data ?? {}),
        })
        return {
          ok: () => response.ok,
          status: () => response.status,
          json: () => response.json(),
        }
      },
    }
    voiceMainAttempted = mainFlowOnly
    try {
      await runAndroidVoiceLiveSmoke({
        environment: runEnvironment,
        pairing: {
          request,
          gatewayUrl: runEnvironment.AURORA_THREE_NODE_GATEWAY_URL,
          gatewayApiKey: runEnvironment.AURORA_THREE_NODE_GATEWAY_API_KEY,
          inviteText,
          pythonPeerId: ownedStack.mesh.local?.peer_id,
          permissions: HOSTED_PEER_PYTHON_PERMISSIONS,
        },
        modelFixture: fixtureTurn,
        hostedSpeechConsumer,
        remoteConsoleShellMain: mainFlowOnly,
        onInstalledAppReady: ({ adb: readyAdb, serial: readySerial, appId: readyAppId }) => {
          if (readyAdb !== adb || readySerial !== serial || readyAppId !== androidAppId) {
            throw new Error('The connected voice main changed its selected Android target.')
          }
          voiceMainReadyOnOwnedApk = true
        },
      })
    } catch (error) {
      voiceCleanupFailed = error instanceof AggregateError
      throw error
    }
    if (childExited(python)) throw new Error(`Aurora main.py exited with status ${python.exitCode ?? python.signalCode ?? 'unknown'}.`)
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = await cleanupAcceptanceResources({ python, fixture, configDir, hostedSpeechConsumer })
    if (brokerReverse) {
      try {
        await cleanupLoopbackBrokerReverse(brokerReverse)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    let offlineMainError
    if (mainFlowOnly && voiceMainAttempted && voiceMainReadyOnOwnedApk && !voiceCleanupFailed && cleanupErrors.length === 0) {
      try {
        await runAndroidLocalInferenceMainFlow({
          adb,
          serial,
          appId: androidAppId,
          environment: { ...environment, AURORA_ANDROID_LOCAL_INFERENCE_MAIN_FLOW: '1' },
        })
      } catch (error) {
        offlineMainError = error
      }
    }
    const primary = primaryError && offlineMainError
      ? new AggregateError([primaryError, offlineMainError], 'Connected and offline assistant main flows failed.')
      : primaryError ?? offlineMainError
    throwAcceptanceErrors(primary, cleanupErrors)
  }
}

async function reverseLoopbackBroker(environment, brokerUrl) {
  const port = loopbackWebSocketPort(brokerUrl)
  if (port === null) return null
  const adb = resolveAdbCommand(environment)
  const explicitSerial = environment.AURORA_ANDROID_DEVICE_SERIAL ?? environment.ANDROID_SERIAL
  const devices = execFileSync(adb, ['devices', '-l'], { encoding: 'utf8', timeout: 30_000 })
  const serial = resolveAndroidDeviceSerial(devices, explicitSerial)
  const existing = listReverseMappings(adb, serial)
    .filter((mapping) => mapping.local === `tcp:${port}`)
  if (existing.length > 1) throw new Error(`Android device ${serial} has ambiguous reverse mappings for tcp:${port}.`)
  if (existing.length === 1) {
    if (existing[0].remote !== `tcp:${port}`) {
      throw new Error(`Android device ${serial} already maps tcp:${port} to a different host port.`)
    }
    return { adb, serial, port, owned: false }
  }
  execFileSync(adb, ['-s', serial, 'reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`], { stdio: 'ignore', timeout: 30_000 })
  return { adb, serial, port, owned: true }
}

async function cleanupLoopbackBrokerReverse({ adb, serial, port, owned }) {
  if (!owned) return
  const local = `tcp:${port}`
  const remote = `tcp:${port}`
  const mappings = listReverseMappings(adb, serial).filter((mapping) => mapping.local === local)
  if (mappings.length === 0) return
  if (mappings.length !== 1 || mappings[0].remote !== remote) {
    throw new Error(`Android device ${serial} reverse mapping for ${local} changed before cleanup; refusing to remove it.`)
  }
  execFileSync(adb, ['-s', serial, 'reverse', '--remove', local], { stdio: 'ignore', timeout: 30_000 })
}

function listReverseMappings(adb, serial) {
  const output = execFileSync(adb, ['-s', serial, 'reverse', '--list'], { encoding: 'utf8', timeout: 30_000 })
  const mappings = []
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u).filter(Boolean)
    if (fields.length === 0) continue
    let local
    let remote
    if (fields.length === 2) {
      [local, remote] = fields
    } else if (fields.length === 3) {
      [, local, remote] = fields
    } else {
      throw new Error(`Android device ${serial} returned an unrecognized reverse mapping list.`)
    }
    if (!/^(?:tcp:\d+|localabstract:.+|localreserved:.+|localfilesystem:.+)$/u.test(local)
      || !/^(?:tcp:\d+|localabstract:.+|localreserved:.+|localfilesystem:.+)$/u.test(remote)) {
      throw new Error(`Android device ${serial} returned an unrecognized reverse mapping list.`)
    }
    mappings.push({ local, remote })
  }
  return mappings
}

function loopbackWebSocketPort(value) {
  try {
    const url = new URL(value)
    if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
    return Number(url.port || (url.protocol === 'wss:' ? 443 : 80))
  } catch {
    return null
  }
}

function resolveAdbCommand(environment) {
  const candidates = [
    environment.ADB,
    environment.ANDROID_HOME ? join(environment.ANDROID_HOME, 'platform-tools', 'adb') : undefined,
    environment.ANDROID_SDK_ROOT ? join(environment.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined,
    join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    join(os.homedir(), '.local/share/android-sdk/platform-tools/adb'),
    'adb',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate !== 'adb' && !existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 5_000 })
      return candidate
    } catch { /* try the next installed adb location */ }
  }
  throw new Error('Android adb is required to route a loopback signaling broker to the selected device.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcceptance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
