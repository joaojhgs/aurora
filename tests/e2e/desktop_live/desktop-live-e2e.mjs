#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRoleSwitchEvidence } from './role-switch-evidence.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serviceScript = path.join(repoRoot, 'scripts/webrtc_interop_services.sh')
const gatewayScript = path.join(repoRoot, 'scripts/webrtc_interop_gateway.py')
const scannerScript = path.join(repoRoot, 'scripts/webrtc_interop_scan.py')
const localWebDriverScript = path.join(repoRoot, 'tests/e2e/desktop_live/desktop-webdriver-driver.mjs')
const applicationWrapperScript = path.join(repoRoot, 'scripts/desktop_live_application.sh')
const liveRunnerScript = path.join(repoRoot, 'scripts/desktop_live_e2e.sh')
const defaultArtifactDir = path.join(repoRoot, 'reports/desktop-live-e2e')
const laneChoices = new Set(['direct', 'stun', 'turn'])

const args = new Set(process.argv.slice(2))

if (args.has('--self-test')) {
  await runSelfTest()
} else if (args.has('--check-only') || process.env.AURORA_DESKTOP_LIVE_E2E !== '1') {
  await runCheckOnly()
} else {
  await runLive()
}

async function runCheckOnly() {
  const artifactDir = resolveArtifactDir()
  await fs.mkdir(artifactDir, { recursive: true })
  const report = {
    schema: 'aurora.desktop_live_e2e.check.v1',
    status: 'ready-to-run',
    liveEnabled: process.env.AURORA_DESKTOP_LIVE_E2E === '1',
    driverCommandConfigured: Boolean(process.env.AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND),
    lane: resolveLane(),
    prerequisites: {
      pnpm: commandAvailable('pnpm'),
      uv: commandAvailable('uv'),
      pythonPeerHarness: await fileExists(gatewayScript),
      signalingServicesHarness: await fileExists(serviceScript),
      scanner: await fileExists(scannerScript),
      repoOwnedWebDriverFixture: await fileExists(localWebDriverScript),
      applicationWrapper: await fileExists(applicationWrapperScript),
      maintainedLiveRunner: await fileExists(liveRunnerScript),
    },
    launchContract: desktopClientLaunchContract(),
    stopCondition:
      'Full live mode requires AURORA_DESKTOP_LIVE_E2E=1 plus AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND to drive the Tauri WebView approval and RPC path.',
    secretsRedacted: true,
  }
  await writeJson(path.join(artifactDir, 'desktop-live-check.json'), report)
  assert.equal(report.prerequisites.pythonPeerHarness, true)
  assert.equal(report.prerequisites.signalingServicesHarness, true)
  assert.equal(report.prerequisites.scanner, true)
  assert.equal(report.prerequisites.applicationWrapper, true)
  assert.equal(report.prerequisites.maintainedLiveRunner, true)
  console.log(JSON.stringify(report, null, 2))
}

async function runLive() {
  const lane = resolveLane()
  const artifactDir = resolveArtifactDir()
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora-desktop-live-e2e.'))
  const readyPath = path.join(artifactDir, 'gateway-ready.json')
  const donePath = path.join(artifactDir, 'desktop-done.json')
  const pythonReportPath = path.join(artifactDir, 'python-gateway-report.json')
  const desktopReportPath = path.join(artifactDir, 'desktop-client-report.json')
  const driverLogPath = path.join(artifactDir, 'desktop-driver.log')
  const sessionReportPath = path.join(artifactDir, 'desktop-session-report.json')
  const finalReportPath = path.join(artifactDir, 'report.json')
  const runtimeProfilePath = path.join(runtimeDir, 'runtime-profile.json')
  const invitePath = path.join(runtimeDir, 'mesh-invite.json')
  const roomSecret = crypto.randomBytes(32).toString('base64url')
  const token = `desktop.${crypto.randomBytes(24).toString('base64url')}`
  const sessionNonce = crypto.randomBytes(24).toString('base64url')
  const room = `desktop-live-${process.pid}-${Date.now().toString(36)}`
  const timeoutMs = Number(process.env.AURORA_DESKTOP_LIVE_E2E_TIMEOUT_MS ?? 180_000)
  const driverCommand = process.env.AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND
  const driverApplication = process.env.AURORA_DESKTOP_LIVE_E2E_APPLICATION
  const applicationPidFile = process.env.AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE

  let servicesStarted = false
  let pythonPeer
  let pythonOutput = ''
  const seededSecrets = [roomSecret, token]

  const cleanup = async () => {
    await terminateChild(pythonPeer, 5_000)
    if (servicesStarted) {
      spawnSync(serviceScript, ['down'], { cwd: repoRoot, stdio: 'ignore' })
    }
    await fs.rm(runtimeDir, { recursive: true, force: true })
  }

  try {
    await fs.mkdir(artifactDir, { recursive: true })
    await Promise.all([
      fs.rm(readyPath, { force: true }),
      fs.rm(donePath, { force: true }),
      fs.rm(pythonReportPath, { force: true }),
      fs.rm(desktopReportPath, { force: true }),
      fs.rm(driverLogPath, { force: true }),
      fs.rm(sessionReportPath, { force: true }),
      fs.rm(finalReportPath, { force: true }),
      applicationPidFile ? fs.rm(applicationPidFile, { force: true }) : Promise.resolve(),
    ])

    run(serviceScript, ['up'])
    servicesStarted = true
    await waitForPort(9001, timeoutMs, 'MQTT broker')
    if (lane === 'turn') await waitForPort(3478, timeoutMs, 'TURN server')

    pythonPeer = spawn('uv', [
      'run',
      'python',
      gatewayScript,
      '--lane',
      lane,
      '--ready',
      readyPath,
      '--done',
      donePath,
      '--report',
      pythonReportPath,
      '--broker',
      'ws://127.0.0.1:9001/mqtt',
      '--room',
      room,
      '--timeout',
      String(Math.ceil(timeoutMs / 1000)),
      ...(lane === 'turn' ? ['--turn', 'turn:127.0.0.1:3478?transport=udp'] : []),
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        WEBRTC_INTEROP_ROOM_SECRET: roomSecret,
        WEBRTC_INTEROP_TOKEN: token,
        WEBRTC_INTEROP_AC18_LOCAL_TOOL_PROVIDER: '1',
      },
      stdio: 'pipe',
    })
    pythonPeer.stdout.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })
    pythonPeer.stderr.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })

    const ready = await waitForJson(readyPath, timeoutMs, 'Python peer readiness', pythonPeer, () =>
      redactSeeded(redactProcessOutput(pythonOutput), seededSecrets),
    )
    const runtimeProfile = buildRuntimeProfileDocument(ready)
    const invite = buildDesktopInvite(ready, roomSecret)
    await writeJson(runtimeProfilePath, runtimeProfile)
    await writeJson(invitePath, invite)

    if (!driverCommand || !driverApplication || !applicationPidFile) {
      const blocker = !driverCommand
        ? 'missing-driver-command'
        : 'missing-driver-application'
      await writeJson(desktopReportPath, {
        schema: 'aurora.desktop_live_e2e.desktop_report.v1',
        status: 'blocked',
        blocker,
        driverCommandEnv: 'AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND',
        sessionNonce,
        tauriPid: 'unavailable',
        requiredDriverEvidence: [
          'launch the exact desktop-client binary through tauri-driver',
          'bind the WebView report to the wrapper-recorded application PID',
          'approve the Python peer pairing in the desktop WebView',
          'run the WebRTC interop browser-entry contract inside the Tauri WebView',
          'write desktop-done.json and desktop-client-report.json',
        ],
        launchContract: desktopClientLaunchContract(),
        secretsRedacted: true,
      })
      await writeJson(donePath, { ok: false, at: new Date().toISOString(), reason: blocker })
      await enforceNoSeededSecretsInTree(artifactDir, seededSecrets)
      throw new Error(
        'Desktop live E2E requires the driver command, tauri-driver application wrapper, and application PID file',
      )
    }

    const driverRun = await runDriver(driverCommand, {
      AURORA_DESKTOP_LIVE_E2E_READY: readyPath,
      AURORA_DESKTOP_LIVE_E2E_DONE: donePath,
      AURORA_DESKTOP_LIVE_E2E_DESKTOP_REPORT: desktopReportPath,
      AURORA_DESKTOP_LIVE_E2E_RUNTIME_PROFILE: runtimeProfilePath,
      AURORA_DESKTOP_LIVE_E2E_INVITE: invitePath,
      AURORA_DESKTOP_LIVE_E2E_ROOM_SECRET: roomSecret,
      AURORA_DESKTOP_LIVE_E2E_APPLICATION: driverApplication,
      AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE: applicationPidFile,
      AURORA_DESKTOP_LIVE_E2E_SESSION_NONCE: sessionNonce,
      WEBRTC_INTEROP_LANE: lane,
      WEBRTC_INTEROP_READY: readyPath,
      WEBRTC_INTEROP_DONE: donePath,
      WEBRTC_INTEROP_BROWSER_REPORT: desktopReportPath,
      WEBRTC_INTEROP_ARTIFACT_DIR: artifactDir,
      WEBRTC_INTEROP_ROOM_SECRET: roomSecret,
    }, timeoutMs, seededSecrets, driverLogPath)

    await waitForJson(donePath, timeoutMs, 'desktop driver completion')
    const desktopReport = await waitForJson(desktopReportPath, 10_000, 'desktop driver report')
    validateDriverReport(desktopReport, { sessionNonce })
    const tauriPid = String(desktopReport.tauriPid)
    const processTreeBefore = desktopReport.processTree.beforeHook
    const processTreeAfter = desktopReport.processTree.afterHook
    await writeSessionReport(sessionReportPath, {
      status: 'passed',
      sessionNonce,
      tauriPid,
      processTreeBefore,
      processTreeAfter,
      driverReportPath: desktopReportPath,
      driverLogDigest: driverRun.outputDigest,
    })
    await enforceNoSeededSecretsInTree(artifactDir, seededSecrets)
    await waitForChild(pythonPeer, 30_000, 'Python peer')
    run('uv', [
      'run',
      'python',
      scannerScript,
      '--artifact-dir',
      artifactDir,
      '--python-report',
      pythonReportPath,
      '--browser-report',
      desktopReportPath,
      '--out',
      finalReportPath,
      '--lane',
      lane,
    ])
    const aggregate = await waitForJson(finalReportPath, 10_000, 'aggregate report')
    assert.equal(aggregate.status, 'passed')
    assert.equal(aggregate.secretsRedacted, true)
    await writeJson(finalReportPath, {
      ...aggregate,
      desktopSession: {
        tauriPid,
        sessionNonceDigest: sha256Hex(sessionNonce),
        processTree: {
          beforeDriver: processTreeBefore,
          afterDriver: processTreeAfter,
        },
        driverReportDigest: sha256Hex(JSON.stringify(desktopReport)),
        driverLogDigest: driverRun.outputDigest,
      },
      secretsRedacted: true,
    })
    await enforceNoSeededSecretsInTree(artifactDir, seededSecrets)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeJson(path.join(artifactDir, 'desktop-live-failure.json'), {
      schema: 'aurora.desktop_live_e2e.failure.v1',
      status: 'failed',
      error: redactSeeded(message, seededSecrets),
      pythonOutputTail: redactSeeded(redactProcessOutput(pythonOutput).slice(-20_000), seededSecrets),
      secretsRedacted: true,
    })
    await enforceNoSeededSecretsInTree(artifactDir, seededSecrets, { originalError: error })
    throw error
  } finally {
    await cleanup()
  }
}

function desktopClientLaunchContract() {
  return {
    package: '@aurora/tauri-ui',
    command: 'scripts/desktop_live_e2e.sh',
    application: 'scripts/desktop_live_application.sh',
    webdriverCapability: 'tauri:options.application',
    env: {
      AURORA_TAURI_DEV_AUTOSIDECAR: '0',
      VITE_AURORA_DESKTOP_LIVE_E2E: '1',
      VITE_AURORA_RUNTIME_MODE: 'desktop-thin',
      VITE_AURORA_CONNECTION_MODE: 'webrtc-only',
      VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: '1',
    },
    forbiddenDescendants: ['python', 'python3', 'uv', 'main.py', 'aurora-sidecar'],
  }
}

function buildRuntimeProfileDocument(ready) {
  const profileId = `desktop-live-${ready.lane ?? 'direct'}`
  return {
    version: 2,
    activeProfileId: profileId,
    profiles: [{
      version: 2,
      id: profileId,
      label: 'Desktop live peer',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      homeConnection: {
        mode: 'webrtc-only',
        signalingUrl: ready.brokerUrl,
        homePeerId: ready.expectedStablePeerId,
        webrtcProfile: {
          mode: 'webrtc-only',
          appId: ready.appId,
          room: ready.room,
          roomSecretRef: `${profileId}.room`,
          signalingBrokers: [ready.brokerUrl],
          expectedStablePeerId: ready.expectedStablePeerId,
          expectedSignalingPeerId: ready.expectedSignalingPeerId,
          nodeName: ready.nodeName,
          production: false,
          allowInsecureLoopbackSignaling: true,
          stunServers: ready.stunServers ?? [],
          turnServers: ready.turnServers ?? [],
          requireAppLayerE2ee: true,
        },
      },
      localNode: {
        nodeName: 'Aurora desktop live E2E',
        stablePeerId: ready.localStablePeerId ?? 'desktop-live-g009',
        enabledCapabilityPacks: ['native-actions', 'local-tools'],
        meshMembership: {
          signalingUrl: ready.brokerUrl,
          webrtcProfile: {
            mode: 'webrtc-only',
            appId: ready.appId,
            room: ready.room,
            roomSecretRef: `${profileId}.room`,
            signalingBrokers: [ready.brokerUrl],
            expectedStablePeerId: ready.expectedStablePeerId,
            expectedSignalingPeerId: ready.expectedSignalingPeerId,
            nodeName: ready.nodeName,
            production: false,
            allowInsecureLoopbackSignaling: true,
            stunServers: ready.stunServers ?? [],
            turnServers: ready.turnServers ?? [],
            requireAppLayerE2ee: true,
          },
        },
      },
    }],
  }
}

function buildDesktopInvite(ready, roomSecret) {
  return {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: new Date().toISOString(),
    node: {
      peer_id: ready.expectedStablePeerId,
      node_name: ready.nodeName,
    },
    mesh: {
      enabled: true,
      version_policy: 'compatible',
      peer_selection: 'lowest_latency',
    },
    signaling: {
      provider: 'mqtt',
      app_id: ready.appId,
      room: ready.room,
      room_password: roomSecret,
      encrypt_signaling: true,
      mqtt_brokers: [ready.brokerUrl],
      mqtt_topic_root: 'aurora',
    },
    webrtc: {
      enabled: true,
      app_layer_e2ee: true,
      stun_servers: ready.stunServers ?? [],
      turn_servers: ready.turnServers ?? [],
    },
    auth: {
      default_pairing_permissions: [
        'Gateway.use',
        'Gateway.GetRegistry',
        'Gateway.GetCapabilityCatalog',
        'Gateway.GetCapabilityGraph',
        'Config.use',
        'Orchestrator.use',
        'TTS.use',
        'Tooling.use',
      ],
      auth_timeout_seconds: 30,
      pairing_timeout_seconds: 120,
    },
  }
}

async function runDriver(command, env, timeoutMs, seededSecrets, logPath) {
  const child = spawn(command, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exit = await waitForExit(child, timeoutMs, 'desktop driver command')
  const redacted = redactSeeded(redactProcessOutput(`stdout:\n${stdout}\nstderr:\n${stderr}`), seededSecrets)
  assertNoSeededSecretsInText(redacted, seededSecrets, 'desktop driver log')
  await fs.writeFile(logPath, redacted)
  if (exit.code !== 0) {
    throw new Error(`desktop driver command exited with ${exit.code ?? `signal ${exit.signal}`}`)
  }
  return {
    outputDigest: sha256Hex(redacted),
  }
}

function validateDriverReport(report, { sessionNonce }) {
  assert.equal(report.status, 'passed', 'desktop driver report must pass before aggregate scan')
  assert.equal(report.sessionNonce, sessionNonce, 'desktop driver report must echo the launch nonce')
  assert.match(String(report.tauriPid), /^[1-9]\d{0,19}$/u, 'desktop driver report must contain the launched Tauri PID')
  assert.equal(report.secretsRedacted, true, 'desktop driver report must declare redacted artifacts')
  assert.equal(
    report.noHttpFetchTransportUsed,
    true,
    'desktop driver report must declare WebRTC-only application traffic',
  )
  assert.equal(
    report.browserResult?.noHttpFetchTransportUsed,
    true,
    'desktop browser result must declare WebRTC-only application traffic',
  )
  assert.deepEqual(
    report.browserResult?.httpFetchCalls,
    [],
    'desktop browser result must contain no observed HTTP requests',
  )
  assertRoleSwitchEvidence(report.roleSwitchEvidence, 'desktop driver report')
  assert.equal(
    report.desktopResult?.pidBinding?.actualOsPidVerified,
    true,
    'desktop driver report must verify the actual driver-launched OS PID',
  )
  assert.equal(
    String(report.desktopResult?.pidBinding?.observedPid),
    String(report.tauriPid),
    'desktop WebView PID binding must match the wrapper-recorded application PID',
  )
  for (const [label, snapshot] of Object.entries({
    beforeHook: report.processTree?.beforeHook,
    afterHook: report.processTree?.afterHook,
  })) {
    assert.equal(
      String(snapshot?.rootPid),
      String(report.tauriPid),
      `${label} process snapshot must bind to the launched Tauri PID`,
    )
    assert.deepEqual(
      snapshot?.forbiddenMatches,
      [],
      `${label} process snapshot must contain no Python or sidecar descendants`,
    )
  }
}

async function waitForJson(file, timeoutMs, label, child, childOutput) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        throw new Error(`${label} did not appear before child exit ${child.exitCode}: ${childOutput?.() ?? ''}`)
      }
      await sleep(100)
    }
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForChild(child, timeoutMs, label) {
  if (!child) return
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`${label} exited with ${child.exitCode}`)
    return
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${label} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}

async function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function terminateChild(child, timeoutMs) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  try {
    await waitForChild(child, timeoutMs, 'child shutdown')
  } catch {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

async function waitForPort(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.setTimeout(500, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${label} on localhost:${port}`)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
}

async function writeSessionReport(file, {
  status,
  sessionNonce,
  tauriPid,
  processTreeBefore,
  processTreeAfter,
  driverReportPath,
  driverLogDigest,
}) {
  await writeJson(file, {
    schema: 'aurora.desktop_live_e2e.session.v1',
    status,
    tauriPid,
    sessionNonceDigest: sha256Hex(sessionNonce),
    processTree: {
      beforeDriver: processTreeBefore,
      afterDriver: processTreeAfter,
    },
    driverReportPath: path.relative(repoRoot, driverReportPath),
    ...(driverLogDigest ? { driverLogDigest } : {}),
    secretsRedacted: true,
  })
}

async function enforceNoSeededSecretsInTree(root, seededSecrets, { originalError } = {}) {
  const findings = await findSeededSecretFindingsInTree(root, seededSecrets)
  if (findings.length === 0) return
  const quarantine = await redactLeakingArtifacts(root, seededSecrets, findings)
  const originalMessage = originalError instanceof Error
    ? originalError.message
    : String(originalError ?? '')
  const message = redactSeeded(
    `seeded secret scan failed; redacted ${quarantine.redactedFileCount} leaking artifact(s) before upload${originalMessage ? `; original failure: ${originalMessage}` : ''}`,
    seededSecrets,
  )
  throw new Error(message, { cause: originalError })
}

async function assertNoSeededSecretsInTree(root, seededSecrets) {
  const findings = await findSeededSecretFindingsInTree(root, seededSecrets)
  assert.deepEqual(findings, [], 'desktop live artifacts/logs must not contain seeded room secrets or tokens')
}

async function findSeededSecretFindingsInTree(root, seededSecrets) {
  const findings = []
  for (const file of await collectArtifactFiles(root)) {
    const text = await fs.readFile(file, 'utf8')
    for (const secret of seededSecrets) {
      if (secret && text.includes(secret)) {
        findings.push({ file: path.relative(repoRoot, file), secretDigest: sha256Hex(secret) })
      }
    }
  }
  return findings
}

async function redactLeakingArtifacts(root, seededSecrets, findings) {
  const uniqueFiles = [...new Set(findings.map((finding) => path.resolve(repoRoot, finding.file)))]
  for (const file of uniqueFiles) {
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, redactSeeded(text, seededSecrets))
  }
  const quarantineReport = {
    schema: 'aurora.desktop_live_e2e.secret_quarantine.v1',
    redactedFileCount: uniqueFiles.length,
    redactedFiles: uniqueFiles.map((file) => path.relative(repoRoot, file)),
    findingDigests: findings.map((finding) => finding.secretDigest),
    at: new Date().toISOString(),
    secretsRedacted: true,
  }
  await writeJson(path.join(root, 'desktop-secret-quarantine.json'), quarantineReport)
  return quarantineReport
}

async function collectArtifactFiles(root) {
  const out = []
  async function visit(directory) {
    let entries = []
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
      } else if (entry.isFile() && /\.(json|log|txt)$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await visit(root)
  return out
}

function resolveArtifactDir() {
  return path.resolve(process.env.AURORA_DESKTOP_LIVE_E2E_ARTIFACT_DIR ?? defaultArtifactDir)
}

function resolveLane() {
  const lane = process.env.AURORA_DESKTOP_LIVE_E2E_LANE ?? 'direct'
  if (!laneChoices.has(lane)) {
    throw new Error(`AURORA_DESKTOP_LIVE_E2E_LANE must be direct, stun, or turn; received ${lane}`)
  }
  return lane
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function fileExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function commandAvailable(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return result.status === 0
}

function redactProcessOutput(text) {
  return text
    .replace(/(authorization|api[_-]?key|token|secret|password|roomSecret|room_secret)([=:\s]+)[^\s,;]+/gi, '$1$2<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
}

function redactSeeded(text, secrets) {
  return secrets.reduce((next, secret) => next.split(secret).join('<redacted>'), text)
}

function assertNoSeededSecretsInText(text, seededSecrets, label) {
  const leaked = seededSecrets.filter((secret) => secret && text.includes(secret))
  assert.deepEqual(leaked.map(sha256Hex), [], `${label} must not contain exact seeded secrets`)
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSelfTest() {
  const ready = {
    lane: 'direct',
    appId: 'app',
    room: 'room',
    brokerUrl: 'ws://127.0.0.1:9001/mqtt',
    expectedStablePeerId: 'python-gateway-g009',
    localStablePeerId: 'browser-g009',
    expectedSignalingPeerId: '100-python-g009',
    nodeName: 'G009 Python Gateway',
    stunServers: [],
    turnServers: [],
  }
  const profile = buildRuntimeProfileDocument(ready)
  assert.equal(profile.activeProfileId, 'desktop-live-direct')
  assert.equal(profile.profiles[0].runtimeTier, 'lightweight-ts')
  assert.equal(profile.profiles[0].homeConnection.webrtcProfile.requireAppLayerE2ee, true)
  const invite = buildDesktopInvite(ready, 'secret-room')
  assert.equal(invite.signaling.room_password, 'secret-room')
  assert.match(JSON.stringify(desktopClientLaunchContract()), /AURORA_TAURI_DEV_AUTOSIDECAR/)
  const redacted = redactSeeded('token-value room-secret', ['token-value', 'room-secret'])
  assert.equal(redacted, '<redacted> <redacted>')
  assert.doesNotThrow(() => assertNoSeededSecretsInText(redacted, ['token-value'], 'self-test redaction'))
  assert.throws(
    () => assertNoSeededSecretsInText('leaked token-value', ['token-value'], 'self-test leak'),
    /self-test leak/,
  )
  const passedDriverReport = {
    status: 'passed',
    sessionNonce: 'nonce',
    tauriPid: '123',
    roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
    noHttpFetchTransportUsed: true,
    browserResult: {
      noHttpFetchTransportUsed: true,
      httpFetchCalls: [],
    },
    desktopResult: {
      pidBinding: {
        actualOsPidVerified: true,
        observedPid: '123',
      },
    },
    processTree: {
      beforeHook: { rootPid: '123', forbiddenMatches: [] },
      afterHook: { rootPid: '123', forbiddenMatches: [] },
    },
    secretsRedacted: true,
  }
  assert.doesNotThrow(() =>
    validateDriverReport(passedDriverReport, { sessionNonce: 'nonce' }),
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      sessionNonce: 'wrong',
    }, { sessionNonce: 'nonce' }),
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      secretsRedacted: true,
      roleSwitchEvidence: undefined,
    }, { sessionNonce: 'nonce' }),
    /roleSwitchEvidence\.passed/,
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      roleSwitchEvidence: { passed: false, from: 'remote-console', to: 'mesh-node' },
    }, { sessionNonce: 'nonce' }),
    /roleSwitchEvidence\.passed/,
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      roleSwitchEvidence: { passed: true, from: 'mesh-node', to: 'remote-console' },
    }, { sessionNonce: 'nonce' }),
    /roleSwitchEvidence\.from/,
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      noHttpFetchTransportUsed: false,
    }, { sessionNonce: 'nonce' }),
    /WebRTC-only application traffic/,
  )
  assert.throws(() =>
    validateDriverReport({
      ...passedDriverReport,
      browserResult: {
        noHttpFetchTransportUsed: false,
        httpFetchCalls: ['https://unexpected.example/'],
      },
    }, { sessionNonce: 'nonce' }),
    /WebRTC-only/,
  )
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora-desktop-secret-self-test.'))
  const leaking = path.join(artifactRoot, 'driver-report.json')
  await writeJson(leaking, { token: 'token-value', status: 'failed' })
  await assert.rejects(
    enforceNoSeededSecretsInTree(artifactRoot, ['token-value'], {
      originalError: new Error('driver failed'),
    }),
    /seeded secret scan failed/,
  )
  const redactedLeak = await fs.readFile(leaking, 'utf8')
  assert.equal(redactedLeak.includes('token-value'), false)
  const quarantineReport = JSON.parse(
    await fs.readFile(path.join(artifactRoot, 'desktop-secret-quarantine.json'), 'utf8'),
  )
  assert.equal(quarantineReport.redactedFileCount, 1)
  assert.equal(JSON.stringify(quarantineReport).includes('token-value'), false)
  await assertNoSeededSecretsInTree(artifactRoot, ['token-value'])
  console.log('desktop-live-e2e self-test passed')
}
