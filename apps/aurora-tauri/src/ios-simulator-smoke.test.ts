// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeScript = resolve(packageRoot, 'scripts/ios-simulator-smoke.mjs')

describe('iOS simulator smoke runner', () => {
  it('boots, installs, launches, captures evidence, and terminates a built app', () => {
    const fixture = createFixture()
    const result = runSmoke(fixture)
    const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8')) as {
      status: string
      bundleId: string
      appStayedAliveThroughSettleWindow: boolean
      pythonSidecarExpected: boolean
      secretsRedacted: boolean
    }
    const invocations = readFileSync(fixture.invocationPath, 'utf8')

    expect(result.status, result.stderr).toBe(0)
    expect(report).toMatchObject({
      status: 'passed',
      bundleId: 'dev.aurora.desktop',
      appStayedAliveThroughSettleWindow: true,
      pythonSidecarExpected: false,
      secretsRedacted: true,
    })
    expect(invocations).toContain('simctl list devices available -j')
    expect(invocations).toContain('simctl boot ios-simulator-1')
    expect(invocations).toContain(
      `simctl install ios-simulator-1 ${fixture.appPath}`,
    )
    expect(invocations).toContain(
      'simctl launch ios-simulator-1 dev.aurora.desktop',
    )
    expect(invocations).toContain(
      'simctl terminate ios-simulator-1 dev.aurora.desktop',
    )
    expect(invocations).toContain('simctl shutdown ios-simulator-1')
  })

  it('writes a failed report when simctl launch does not return a process id', () => {
    const fixture = createFixture({ invalidLaunchOutput: true })
    const result = runSmoke(fixture)
    const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8')) as {
      status: string
      error: string
      secretsRedacted: boolean
    }

    expect(result.status).not.toBe(0)
    expect(report.status).toBe('failed')
    expect(report.error).toContain('did not return a process id')
    expect(report.secretsRedacted).toBe(true)
  })

  it('discovers the newest simulator app from a generated build tree', () => {
    const fixture = createFixture({ useGeneratedAppTree: true })
    const result = runSmoke(fixture, { useConfiguredApp: false })
    const invocations = readFileSync(fixture.invocationPath, 'utf8')

    expect(result.status, result.stderr).toBe(0)
    expect(invocations).toContain(
      `simctl install ios-simulator-1 ${fixture.appPath}`,
    )
  })
})

function createFixture(
  options: {
    invalidLaunchOutput?: boolean
    useGeneratedAppTree?: boolean
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'aurora-ios-simulator-smoke-'))
  const bin = join(root, 'bin')
  const searchRoot = join(root, 'gen-apple')
  const appPath = options.useGeneratedAppTree
    ? join(searchRoot, 'build', 'aarch64-sim', 'Aurora.app')
    : join(root, 'Aurora.app')
  const reportPath = join(root, 'report.json')
  const screenshotPath = join(root, 'screenshot.png')
  const logPath = join(root, 'simulator.log')
  const invocationPath = join(root, 'invocations.log')
  mkdirSync(bin)
  mkdirSync(appPath, { recursive: true })
  writeFileSync(join(appPath, 'Info.plist'), '<plist/>')

  const xcrunPath = join(bin, 'xcrun')
  writeFileSync(
    xcrunPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.AURORA_IOS_STUB_INVOCATIONS, args.join(' ') + '\\n')
if (args.join(' ') === 'simctl list devices available -j') {
  process.stdout.write(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16', udid: 'ios-simulator-1', state: 'Shutdown', isAvailable: true }] } }))
} else if (args[0] === 'simctl' && args[1] === 'launch') {
  process.stdout.write(${JSON.stringify(
    options.invalidLaunchOutput
      ? 'launch completed without pid\n'
      : 'dev.aurora.desktop: 4242\n',
  )})
} else if (args[0] === 'simctl' && args[1] === 'io') {
  fs.writeFileSync(args[args.length - 1], 'png')
} else if (args[0] === 'simctl' && args[1] === 'get_app_container') {
  process.stdout.write('/tmp/aurora-app-container\\n')
} else if (args[0] === 'simctl' && args[1] === 'spawn') {
  process.stdout.write('Aurora simulator log: application running\\n')
}
`,
  )
  chmodSync(xcrunPath, 0o755)

  const plutilPath = join(bin, 'plutil')
  writeFileSync(
    plutilPath,
    '#!/usr/bin/env node\nprocess.stdout.write("dev.aurora.desktop\\n")\n',
  )
  chmodSync(plutilPath, 0o755)

  return {
    root,
    bin,
    appPath,
    searchRoot,
    reportPath,
    screenshotPath,
    logPath,
    invocationPath,
  }
}

function runSmoke(
  fixture: ReturnType<typeof createFixture>,
  options: { useConfiguredApp?: boolean } = {},
) {
  const useConfiguredApp = options.useConfiguredApp ?? true
  return spawnSync(process.execPath, [smokeScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ''}`,
      AURORA_IOS_STUB_INVOCATIONS: fixture.invocationPath,
      ...(useConfiguredApp
        ? { AURORA_IOS_SIMULATOR_APP: fixture.appPath }
        : { AURORA_IOS_SIMULATOR_SEARCH_ROOT: fixture.searchRoot }),
      AURORA_IOS_SIMULATOR_REPORT: fixture.reportPath,
      AURORA_IOS_SIMULATOR_SCREENSHOT: fixture.screenshotPath,
      AURORA_IOS_SIMULATOR_LOG: fixture.logPath,
      AURORA_IOS_SIMULATOR_SETTLE_MS: '0',
    },
    encoding: 'utf8',
  })
}
