import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const harness = path.join(repoRoot, 'tests/e2e/desktop_live/desktop-live-e2e.mjs')

test('self-test validates desktop process-tree and profile helpers', async () => {
  const output = await execNode([harness, '--self-test'])
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
  assert.equal(report.launchContract.env.AURORA_TAURI_DEV_AUTOSIDECAR, '0')
  assert.match(output.stdout, /AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND/)
})

test('harness source preserves real-peer, Python-free desktop-client, driver, and scanner gates', async () => {
  const source = await fs.readFile(harness, 'utf8')
  assert.match(source, /scripts\/webrtc_interop_gateway\.py/)
  assert.match(source, /scripts\/webrtc_interop_services\.sh/)
  assert.match(source, /scripts\/webrtc_interop_scan\.py/)
  assert.match(source, /src-tauri\/tauri\.client\.conf\.json/)
  assert.match(source, /AURORA_TAURI_DEV_AUTOSIDECAR: '0'/)
  assert.match(source, /AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND/)
  assert.match(source, /assertNoTauriOwnedPythonChild/)
  assert.match(source, /WEBRTC_INTEROP_AC18_LOCAL_TOOL_PROVIDER: '1'/)
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
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}
