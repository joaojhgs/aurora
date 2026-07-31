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
import { deflateSync } from 'node:zlib'
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
      screenshotEvidence: {
        status: string
        contrastPixelRatio: number
        edgeContrastRatio: number
        secretsRedacted: boolean
      }
    }
    const invocations = readFileSync(fixture.invocationPath, 'utf8')

    expect(result.status, result.stderr).toBe(0)
    expect(report).toMatchObject({
      status: 'passed',
      bundleId: 'dev.aurora.desktop',
      appStayedAliveThroughSettleWindow: true,
      pythonSidecarExpected: false,
      secretsRedacted: true,
      screenshotEvidence: {
        status: 'passed',
        secretsRedacted: true,
      },
    })
    expect(report.screenshotEvidence.contrastPixelRatio).toBeGreaterThan(0)
    expect(report.screenshotEvidence.edgeContrastRatio).toBeGreaterThan(0)
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

  it('fails when the simulator captures a blank frame', () => {
    const fixture = createFixture({ screenshot: 'blank' })
    const result = runSmoke(fixture)
    const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8')) as {
      status: string
      error: string
      screenshotEvidence: {
        status: string
        failures: string[]
      }
    }

    expect(result.status).not.toBe(0)
    expect(report.status).toBe('failed')
    expect(report.error).toContain('did not show meaningful rendered UI')
    expect(report.screenshotEvidence.status).toBe('failed')
    expect(report.screenshotEvidence.failures).not.toEqual([])
  })

  it('fails when the simulator screenshot is not a valid PNG', () => {
    const fixture = createFixture({ screenshot: 'invalid' })
    const result = runSmoke(fixture)
    const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8')) as {
      status: string
      error: string
    }

    expect(result.status).not.toBe(0)
    expect(report.status).toBe('failed')
    expect(report.error).toContain('not a valid PNG')
  })

  it('retries a transient blank frame until rendered UI is visible', () => {
    const fixture = createFixture({
      screenshotSequence: ['blank', 'visible'],
    })
    const result = runSmoke(fixture, {
      renderTimeoutMs: 1_000,
      screenshotRetryMs: 0,
    })
    const report = JSON.parse(readFileSync(fixture.reportPath, 'utf8')) as {
      status: string
      screenshotEvidence: {
        status: string
        captureAttempts: number
      }
    }
    const invocations = readFileSync(fixture.invocationPath, 'utf8')

    expect(result.status, result.stderr).toBe(0)
    expect(report.screenshotEvidence).toMatchObject({
      status: 'passed',
      captureAttempts: 2,
    })
    expect(
      invocations.match(/simctl io ios-simulator-1 screenshot/g),
    ).toHaveLength(2)
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
    screenshot?: 'visible' | 'blank' | 'invalid'
    screenshotSequence?: Array<'visible' | 'blank' | 'invalid'>
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
  const screenshotKinds = options.screenshotSequence ?? [
    options.screenshot ?? 'visible',
  ]
  const screenshotSourcePaths = screenshotKinds.map((kind, index) => {
    const path = join(root, `screenshot-source-${index}.png`)
    writeScreenshotFixture(path, kind)
    return path
  })
  const screenshotCounterPath = join(root, 'screenshot-counter.txt')
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
  const sources = JSON.parse(process.env.AURORA_IOS_STUB_SCREENSHOT_SOURCES)
  const counterPath = process.env.AURORA_IOS_STUB_SCREENSHOT_COUNTER
  const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0
  fs.copyFileSync(sources[Math.min(attempt, sources.length - 1)], args[args.length - 1])
  fs.writeFileSync(counterPath, String(attempt + 1))
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
    screenshotSourcePaths,
    screenshotCounterPath,
    logPath,
    invocationPath,
  }
}

function runSmoke(
  fixture: ReturnType<typeof createFixture>,
  options: {
    useConfiguredApp?: boolean
    renderTimeoutMs?: number
    screenshotRetryMs?: number
  } = {},
) {
  const useConfiguredApp = options.useConfiguredApp ?? true
  return spawnSync(process.execPath, [smokeScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ''}`,
      AURORA_IOS_STUB_INVOCATIONS: fixture.invocationPath,
      AURORA_IOS_STUB_SCREENSHOT_SOURCES: JSON.stringify(
        fixture.screenshotSourcePaths,
      ),
      AURORA_IOS_STUB_SCREENSHOT_COUNTER: fixture.screenshotCounterPath,
      ...(useConfiguredApp
        ? { AURORA_IOS_SIMULATOR_APP: fixture.appPath }
        : { AURORA_IOS_SIMULATOR_SEARCH_ROOT: fixture.searchRoot }),
      AURORA_IOS_SIMULATOR_REPORT: fixture.reportPath,
      AURORA_IOS_SIMULATOR_SCREENSHOT: fixture.screenshotPath,
      AURORA_IOS_SIMULATOR_LOG: fixture.logPath,
      AURORA_IOS_SIMULATOR_SETTLE_MS: '0',
      AURORA_IOS_SIMULATOR_RENDER_TIMEOUT_MS: String(
        options.renderTimeoutMs ?? 0,
      ),
      AURORA_IOS_SIMULATOR_SCREENSHOT_RETRY_MS: String(
        options.screenshotRetryMs ?? 0,
      ),
    },
    encoding: 'utf8',
  })
}

function writeScreenshotFixture(
  path: string,
  kind: 'visible' | 'blank' | 'invalid',
) {
  if (kind === 'invalid') {
    writeFileSync(path, 'not-a-png')
    return
  }
  const background = [11, 15, 20, 255] as const
  writeFileSync(
    path,
    createRgbaPng(390, 844, (x, y) => {
      if (kind === 'blank') return background
      if (y >= 120 && y < 170 && x >= 28 && x < 330) {
        return [238, 242, 247, 255]
      }
      if (y >= 260 && y < 280 && x >= 52 && x < 270) {
        return [148, 163, 184, 255]
      }
      if (y >= 320 && y < 350 && x >= 52 && x < 330) {
        return [56, 189, 248, 255]
      }
      if (y >= 220 && y < 430 && x >= 24 && x < 366) {
        return [28, 37, 50, 255]
      }
      if (y >= 490 && y < 510 && x >= 90 && x < 300) {
        return [255, 255, 255, 255]
      }
      if (y >= 470 && y < 530 && x >= 24 && x < 366) {
        return [124, 58, 237, 255]
      }
      if (y >= 590 && y < 650 && x >= 24 && x < 366) {
        return [15, 118, 110, 255]
      }
      return background
    }),
  )
}

function createRgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    rows[rowOffset] = 0
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y)
      const offset = rowOffset + 1 + x * 4
      rows[offset] = rgba[0]
      rows[offset + 1] = rgba[1]
      rows[offset + 2] = rgba[2]
      rows[offset + 3] = rgba[3]
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function crc32(buffer: Buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}
