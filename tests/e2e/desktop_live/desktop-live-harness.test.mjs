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

test('maintained desktop live scripts are valid and bind tauri-driver to the wrapper', async () => {
  await execFilePromise('bash', ['-n', liveRunner])
  await execFilePromise('bash', ['-n', applicationWrapper])
  const runnerSource = await fs.readFile(liveRunner, 'utf8')
  const wrapperSource = await fs.readFile(applicationWrapper, 'utf8')
  assert.match(runnerSource, /VITE_AURORA_DESKTOP_LIVE_E2E=1/)
  assert.match(runnerSource, /VITE_AURORA_DESKTOP_LIVE_E2E_FORCE_NATIVE_WEBRTC=1/)
  assert.match(runnerSource, /tauri-driver/)
  assert.match(runnerSource, /src-tauri\/tauri\.client\.conf\.json/)
  assert.match(runnerSource, /AURORA_DESKTOP_LIVE_E2E_APPLICATION/)
  assert.match(wrapperSource, /AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE/)
  assert.match(wrapperSource, /exec "\$AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN"/)
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
