#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const smokeScript = join(packageRoot, 'scripts', 'ios-simulator-smoke.mjs')
const voiceScript = join(packageRoot, 'scripts', 'ios-voice-main-flow.mjs')
const appSearchRoot = join(packageRoot, 'src-tauri', 'gen', 'apple')
const controlOrigin = 'http://127.0.0.1:39461'
const env = {
  ...process.env,
  VITE_AURORA_IOS_VOICE_LIVE_TEST: '1',
  VITE_AURORA_IOS_VOICE_LIVE_TEST_CONTROL_ORIGIN: controlOrigin,
}
const tempDir = mkdtempSync(join(tmpdir(), 'aurora-ios-voice-main-ci-'))
const smokeReport = join(tempDir, 'simulator-smoke.json')
let selectedUdid = ''
let bootedBefore = new Set()

try {
  if (process.platform !== 'darwin') throw new Error('macOS is required for iOS simulator acceptance')
  bootedBefore = readBootedSimulatorUdids()

  // Reuse the existing client builder's owned generated-archive cleanup.
  rmSync(join(appSearchRoot, 'build'), { recursive: true, force: true })

  run('pnpm', [
    '--filter', '@aurora/tauri-ui', 'tauri', 'ios', 'build',
    '--debug', '--target', 'aarch64-sim',
    '--config', 'src-tauri/tauri.ios.conf.json',
    '--config', 'src-tauri/tauri.ios-voice-live-test.conf.json',
  ], env, 20 * 60_000)

  const appPath = runCapture(process.execPath, [smokeScript, '--print-app-path'], {
    ...env,
    AURORA_IOS_SIMULATOR_APP: '',
    AURORA_IOS_SIMULATOR_SEARCH_ROOT: appSearchRoot,
  }).trim()
  if (!appPath.endsWith('.app')) throw new Error('debug simulator app was not resolved')

  run(process.execPath, [smokeScript], {
    ...env,
    AURORA_IOS_SIMULATOR_APP: appPath,
    AURORA_IOS_SIMULATOR_KEEP_BOOTED: '1',
    AURORA_IOS_SIMULATOR_REPORT: smokeReport,
    AURORA_IOS_SIMULATOR_SCREENSHOT: join(tempDir, 'simulator.png'),
    AURORA_IOS_SIMULATOR_LOG: join(tempDir, 'simulator.log'),
  })
  const report = JSON.parse(readFileSync(smokeReport, 'utf8'))
  if (report.status !== 'passed' || !report.device?.udid) {
    throw new Error('debug simulator smoke did not return an owned simulator')
  }
  selectedUdid = report.device.udid

  run(process.execPath, [voiceScript, '--udid', selectedUdid, '--app-path', appPath], {
    ...env,
    AURORA_IOS_VOICE_LIVE_TEST_CONTROL_ORIGIN: controlOrigin,
  }, 46 * 60_000)
} finally {
  if (!selectedUdid) {
    try {
      selectedUdid = JSON.parse(readFileSync(smokeReport, 'utf8')).device?.udid ?? ''
    } catch {
      // The simulator smoke may fail before it can select or report a device.
    }
  }
  if (selectedUdid && !bootedBefore.has(selectedUdid)) {
    try {
      execFileSync('xcrun', ['simctl', 'shutdown', selectedUdid], { stdio: 'ignore', timeout: 20_000 })
    } catch {
      // Preserve the primary build or acceptance failure; shutdown is best effort.
    }
  }
  rmSync(tempDir, { recursive: true, force: true })
}

function readBootedSimulatorUdids() {
  const listing = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8', timeout: 15_000 }))
  return new Set(Object.values(listing.devices ?? {}).flat().filter((device) => device.state === 'Booted').map((device) => device.udid))
}

function run(command, args, commandEnv, timeoutMs = 360_000) {
  const result = spawnSync(command, args, { cwd: repoRoot, env: commandEnv, stdio: 'inherit', timeout: timeoutMs })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}

function runCapture(command, args, commandEnv) {
  const result = spawnSync(command, args, { cwd: repoRoot, env: commandEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
  return result.stdout
}
