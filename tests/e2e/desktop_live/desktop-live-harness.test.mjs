import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const harness = path.join(repoRoot, 'tests/e2e/desktop_live/desktop-live-e2e.mjs')
const webdriverDriver = path.join(repoRoot, 'tests/e2e/desktop_live/desktop-webdriver-driver.mjs')
const liveRunner = path.join(repoRoot, 'scripts/desktop_live_e2e.sh')
const applicationWrapper = path.join(repoRoot, 'scripts/desktop_live_application.sh')
const desktopWorkflow = path.join(repoRoot, '.github/workflows/tauri-desktop.yml')
const tauriCargoManifest = path.join(repoRoot, 'apps/aurora-tauri/src-tauri/Cargo.toml')
const tauriRustLibrary = path.join(repoRoot, 'apps/aurora-tauri/src-tauri/src/lib.rs')
const webdriverConfig = path.join(
  repoRoot,
  'apps/aurora-tauri/src-tauri/tauri.desktop-live-webdriver.conf.json',
)

test('self-test validates desktop process-tree and profile helpers', async () => {
  const output = await execNode([harness, '--self-test'])
  assert.match(output.stdout, /self-test passed/)
})

test('webdriver fixture self-test validates endpoint redaction and digest helpers', async () => {
  const output = await execNode([webdriverDriver, '--self-test'])
  assert.match(output.stdout, /self-test passed/)
})

test('check-only mode writes a gated report without launching Tauri or Python', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora-desktop-live-check.'))
  const output = await execNode([harness, '--check-only'], {
    AURORA_DESKTOP_LIVE_E2E_ARTIFACT_DIR: artifactDir,
  })
  const report = JSON.parse(
    await fs.readFile(path.join(artifactDir, 'desktop-live-check.json'), 'utf8'),
  )
  assert.equal(report.status, 'ready-to-run')
  assert.equal(report.liveEnabled, false)
  assert.equal(report.prerequisites.pythonPeerHarness, true)
  assert.equal(report.prerequisites.signalingServicesHarness, true)
  assert.equal(report.prerequisites.scanner, true)
  assert.equal(report.prerequisites.repoOwnedWebDriverFixture, true)
  assert.equal(report.prerequisites.applicationWrapper, true)
  assert.equal(report.prerequisites.maintainedLiveRunner, true)
  assert.equal(report.launchContract.env.AURORA_TAURI_DEV_AUTOSIDECAR, '0')
  assert.match(output.stdout, /AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND/)
})

test('webdriver fixture fails closed with nonce and PID binding when no endpoint is configured', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora-desktop-webdriver.'))
  const reportPath = path.join(artifactDir, 'desktop-client-report.json')
  const donePath = path.join(artifactDir, 'desktop-done.json')
  await assert.rejects(
    execNode([webdriverDriver], {
      AURORA_DESKTOP_LIVE_E2E_DESKTOP_REPORT: reportPath,
      AURORA_DESKTOP_LIVE_E2E_DONE: donePath,
      AURORA_DESKTOP_LIVE_E2E_SESSION_NONCE: 'nonce-123',
      AURORA_DESKTOP_LIVE_E2E_TAURI_PID: '4242',
    }),
    /exit code 2/,
  )
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  const done = JSON.parse(await fs.readFile(donePath, 'utf8'))
  assert.equal(report.status, 'blocked')
  assert.equal(report.sessionNonce, 'nonce-123')
  assert.equal(report.tauriPid, '4242')
  assert.equal(report.secretsRedacted, true)
  assert.equal(done.ok, false)
})

test('harness source preserves real-peer, Python-free desktop-client, driver, and scanner gates', async () => {
  const source = await fs.readFile(harness, 'utf8')
  assert.match(source, /scripts\/webrtc_interop_gateway\.py/)
  assert.match(source, /scripts\/webrtc_interop_services\.sh/)
  assert.match(source, /scripts\/webrtc_interop_scan\.py/)
  assert.match(source, /AURORA_TAURI_DEV_AUTOSIDECAR: '0'/)
  assert.match(source, /AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND/)
  assert.match(source, /AURORA_DESKTOP_LIVE_E2E_SESSION_NONCE/)
  assert.match(source, /AURORA_DESKTOP_LIVE_E2E_APPLICATION/)
  assert.match(source, /AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE/)
  assert.match(source, /webdriverProvider === 'official'/)
  assert.match(source, /assertNoSeededSecretsInTree/)
  assert.match(source, /enforceNoSeededSecretsInTree/)
  assert.match(source, /desktop-secret-quarantine/)
  assert.match(source, /validateDriverReport/)
  assert.match(source, /beforeHook/)
  assert.match(source, /afterHook/)
  assert.match(source, /WEBRTC_INTEROP_AC18_LOCAL_TOOL_PROVIDER: '1'/)
  assert.doesNotMatch(source, /stdio:\s*'inherit'[\s\S]{0,120}shell:\s*true/)
})

test('webdriver fixture source invokes the narrow desktop live WebView hook', async () => {
  const source = await fs.readFile(webdriverDriver, 'utf8')
  assert.match(source, /__AURORA_DESKTOP_LIVE_E2E__/)
  assert.match(source, /aurora\.desktop_live_e2e\.webdriver_result\.v1/)
  assert.match(source, /JSON\.stringify\(\{ schema: envelopeSchema, result \}\)/)
  assert.match(source, /parseHookResultEnvelope/)
  assert.match(source, /buildHookPayload/)
  assert.match(source, /validatePassedHookResult/)
  assert.match(source, /roleSwitchEvidence/)
  assert.match(source, /remote-console/)
  assert.match(source, /mesh-node/)
  assert.match(source, /desktop-webview-hook-invalid-report/)
  assert.match(source, /desktop-webview-hook-incomplete/)
  assert.match(source, /tauri:options/)
  assert.match(source, /actualOsPidVerified/)
  assert.match(source, /captureProcessTree/)
})

test('maintained desktop live scripts support official and embedded WebDriver providers', async () => {
  await execFilePromise('bash', ['-n', liveRunner])
  await execFilePromise('bash', ['-n', applicationWrapper])
  const runnerSource = await fs.readFile(liveRunner, 'utf8')
  const wrapperSource = await fs.readFile(applicationWrapper, 'utf8')
  assert.match(runnerSource, /VITE_AURORA_DESKTOP_LIVE_E2E=1/)
  assert.match(runnerSource, /desktop_platform.*Linux/)
  assert.match(runnerSource, /desktop_force_native_webrtc="1"/)
  assert.match(runnerSource, /desktop_force_native_webrtc="0"/)
  assert.match(runnerSource, /AURORA_DESKTOP_LIVE_E2E_EXPECTED_WEBRTC_PRIMITIVE/)
  assert.match(runnerSource, /AURORA_DESKTOP_LIVE_E2E_KEEP_DIST/)
  assert.match(runnerSource, /apps\/aurora-tauri\/dist/)
  assert.match(runnerSource, /tauri-driver/)
  assert.match(runnerSource, /AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_PROVIDER/)
  assert.match(runnerSource, /desktop-live-webdriver/)
  assert.match(runnerSource, /tauri\.desktop-live-webdriver\.conf\.json/)
  assert.match(runnerSource, /TAURI_WEBDRIVER_PORT/)
  assert.match(runnerSource, /\/status/)
  assert.match(runnerSource, /src-tauri\/tauri\.client\.conf\.json/)
  assert.match(runnerSource, /AURORA_DESKTOP_LIVE_E2E_APPLICATION/)
  assert.match(wrapperSource, /AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE/)
  assert.match(wrapperSource, /exec "\$AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN"/)
})

test('macOS live lane uses the embedded WebDriver and does not install unsupported tauri-driver', async () => {
  const source = await fs.readFile(desktopWorkflow, 'utf8')
  const macosJob = source
    .split('  desktop-client-live-macos-stun:')[1]
    ?.split('  desktop-client-native-packages:')[0]
  assert.ok(macosJob, 'macOS desktop live job must exist')
  assert.match(macosJob, /runs-on: macos-latest/)
  assert.match(macosJob, /AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_PROVIDER: embedded/)
  assert.match(macosJob, /AURORA_DESKTOP_LIVE_E2E_LANE: stun/)
  assert.match(macosJob, /AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC: "0"/)
  assert.doesNotMatch(macosJob, /cargo install tauri-driver/)
})

test('embedded WebDriver is dependency-, registration-, and capability-gated to the live debug build', async () => {
  const [cargoManifest, rustLibrary, configSource] = await Promise.all([
    fs.readFile(tauriCargoManifest, 'utf8'),
    fs.readFile(tauriRustLibrary, 'utf8'),
    fs.readFile(webdriverConfig, 'utf8'),
  ])
  const config = JSON.parse(configSource)
  const capability = config.app.security.capabilities[1]

  assert.match(
    cargoManifest,
    /desktop-live-webdriver\s*=\s*\["dep:tauri-plugin-wdio-webdriver"\]/,
  )
  assert.match(
    cargoManifest,
    /tauri-plugin-wdio-webdriver\s*=\s*\{[^\n]*version\s*=\s*"=1\.2\.0"[^\n]*optional\s*=\s*true/,
  )
  assert.match(
    rustLibrary,
    /cfg\(all\(desktop, debug_assertions, feature = "desktop-live-webdriver"\)\)/,
  )
  assert.match(rustLibrary, /tauri_plugin_wdio_webdriver::init\(\)/)
  assert.deepEqual(capability.permissions, ['wdio-webdriver:default'])
  assert.equal(config.app.security.capabilities[0], 'aurora-thin')
  assert.equal(capability.identifier, 'aurora-desktop-live-webdriver')
})

function execNode(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: repoRoot,
        env: { ...process.env, ...extraEnv },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message = `exit code ${error.code ?? 'unknown'}: ${error.message}`
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
