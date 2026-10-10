import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runAndroidVoiceLiveSmoke } from './android-voice-live-smoke.mjs'

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKSPACE_ROOT = resolve(APP_ROOT, '../..')
const FIXTURE = resolve(APP_ROOT, 'scripts/fixture-openai-stream.mjs')
const DEFAULTS = resolve(WORKSPACE_ROOT, 'app/services/config/config_defaults.json')
export const AUTHORIZED_NATIVE_ASSISTANT_METHOD = 'Orchestrator.ExternalUserInput'

export function acceptanceEnvironment(environment = process.env) {
  const required = ['AURORA_THREE_NODE_BROKER_URL']
  const missing = required.filter((key) => !environment[key])
  if (missing.length > 0) throw new Error(`Successful native turn acceptance requires authorized three-node configuration: ${missing.join(', ')}.`)
  return {
    ...environment,
    AURORA_ANDROID_NATIVE_TURN_ACCEPTANCE: '1',
    AURORA_MODEL_FIXTURE_LABEL: 'deterministic OpenAI-compatible model fixture',
    AURORA_ANDROID_NATIVE_EVENT_BRIDGE_ACCEPTANCE: '1',
    AURORA_ANDROID_NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE: '1',
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
  config.services.tooling.enabled = false
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

export async function cleanupAcceptanceResources({ python, fixture, configDir, stop = stopChild, remove = (directory) => rmSync(directory, { recursive: true, force: true }) }) {
  const errors = []
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

export async function runAcceptance() {
  const environment = acceptanceEnvironment()
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
  let primaryError
  const fixture = spawn('node', [FIXTURE], { cwd: WORKSPACE_ROOT, env: fixtureEnvironment, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
  try {
    fixtureUrl = await readFixtureReady(fixture)
    const runEnvironment = {
      ...environment,
      OPENAI_BASE_URL: fixtureUrl,
    }
    const gatewayPort = await allocateLocalPort()
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
        OPENAI_BASE_URL: fixtureUrl,
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
    const request = {
      post: async (url, options = {}) => await fetch(url, { method: 'POST', headers: options.headers, body: JSON.stringify(options.data ?? {}) }),
    }
    await runAndroidVoiceLiveSmoke({
      environment: runEnvironment,
      pairing: {
        request,
        gatewayUrl: runEnvironment.AURORA_THREE_NODE_GATEWAY_URL,
        gatewayApiKey: runEnvironment.AURORA_THREE_NODE_GATEWAY_API_KEY,
        inviteText,
        pythonPeerId: ownedStack.mesh.local?.peer_id,
      },
      modelFixture: fixtureTurn,
    })
    if (childExited(python)) throw new Error(`Aurora main.py exited with status ${python.exitCode ?? python.signalCode ?? 'unknown'}.`)
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = await cleanupAcceptanceResources({ python, fixture, configDir })
    throwAcceptanceErrors(primaryError, cleanupErrors)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcceptance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
