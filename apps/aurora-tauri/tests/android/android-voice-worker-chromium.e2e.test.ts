// @vitest-environment node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  adbOutput,
  adbOutputOrEmpty,
  adbReverseList,
  chromiumChromePackage,
  chromiumChromeTarget,
  clearAdbReverseMappings,
  cleanupAndroidBrowser,
  createAndroidWebViewShellHarness,
  launchAndroidBrowser,
  packageVersion,
  resolveAdb,
  resolveDeviceSerial,
  runAdb,
  type AndroidBrowserClaims,
  type AndroidBrowserRestoreState
} from './android-webview-shell-harness-utils.js'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const voiceWebRoot = resolve(repoRoot, 'packages/aurora-voice-web')
const voiceWebDist = resolve(voiceWebRoot, 'dist')
const testTimeoutMs = Number(process.env.AURORA_ANDROID_CHROMIUM_VOICE_TIMEOUT_MS ?? 180_000)
const expectedChromiumVersion = '153.0.7996.0'
const expectedChromiumSnapshot = {
  source: 'https://commondatastorage.googleapis.com/chromium-browser-snapshots/AndroidDesktop_x64/1675650/chrome-android-desktop.zip',
  apkSha256: 'fafbac253a23918591ece4d506fe2155b68d68e199a9b372187071a1d8af0b80'
}
const chromiumClaims: AndroidBrowserClaims = {
  browserSurface: 'Android emulator Chromium snapshot',
  package: chromiumChromePackage,
  physicalDevice: false,
  chromePackage: true,
  mockedWorker: false,
  mockedWasm: false,
  pcmSource: 'deterministic injected Int16Array source',
  microphonePermission: false,
  acousticCapture: false
}

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('Android Chromium production voice Worker/WASM bridge', () => {
  it(
    'runs the built browser entry through module Worker and generated Rust/WASM start frame stop complete abandon repeat',
    async () => {
      assertBuiltProductionVoiceArtifacts()
      const resources = await createResources()
      cleanup = resources.close

      const result = await waitForSelfReportedProof(resources)
      if (isFailedSelfReport(result)) {
        throw new Error(`Android Chromium harness failed: ${result.error.message}\n${result.error.stack ?? ''}`)
      }
      const metadata = readHostMetadata(resources.adb, resources.serial, result.selfReported)

      expect(metadata).toMatchObject({
        deviceSerial: resources.serial,
        sdk: '35',
        release: '15',
        cpuAbi: 'x86_64',
        browserPackage: chromiumChromePackage,
        browserVersion: expectedChromiumVersion,
        browserActivity: chromiumChromeTarget.activityName,
        snapshotSource: expectedChromiumSnapshot.source,
        apkSha256: expectedChromiumSnapshot.apkSha256
      })
      expect(metadata.userAgent).toContain('Android')
      expect(metadata.userAgent).toContain('Chrome/153.0.0.0')
      expect(metadata.targetUrl).toBe(`${resources.harness.baseUrl}/`)
      expect(result.selfReported).toMatchObject({
        href: `${resources.harness.baseUrl}/`,
        runtimePath: 'self-reporting-page'
      })
      expect(result.claims).toEqual(chromiumClaims)
      expect(result.artifacts).toMatchObject({
        servedDist: true,
        workerRequested: true,
        wasmRequested: true,
        exactWasmInventory: true,
        wasmCoreWithinLimit: true,
        wasmLoaderWithinLimit: true,
        forbiddenArtifactCount: 0
      })
      expect(result.artifacts.wasmFiles).toEqual([
        'aurora_voice_wasm.d.ts',
        'aurora_voice_wasm.js',
        'aurora_voice_wasm_bg.wasm',
        'aurora_voice_wasm_bg.wasm.d.ts'
      ])
      expect(result.requests).toEqual(expect.arrayContaining([
        '/index.html',
        '/__aurora_voice_harness__.js',
        '/dist/browser.js',
        '/dist/voice-worker.js',
        '/dist/wasm/aurora_voice_wasm.js',
        '/dist/wasm/aurora_voice_wasm_bg.wasm'
      ]))

      assertCompleteRepeat(result.completeRepeat, 'android-chromium')
      assertAbandonRepeat(result.abandonRepeat, 'android-chromium')
      assertRedaction(result.redaction)
      expect(result.leakScan).toMatchObject({
        eventLeak: false,
        snapshotLeak: false,
        consoleLeak: false,
        rawPcmLeak: false,
        transcriptLeak: false
      })
      expect(result.consoleErrors).toEqual([])
      expect(result.workerSideErrors).toEqual([])

      await resources.close()
      cleanup = undefined
      expect(adbReverseList(resources.adb, resources.serial)).toBe('')
      expect(packageEnabledState(resources.adb, resources.serial, chromiumChromePackage)).toBe(resources.restoreState.packageEnabledState)
      expect(stayOnWhilePluggedIn(resources.adb, resources.serial)).toBe(resources.restoreState.stayOnWhilePluggedIn)
      expect(commandLineState(resources.adb, resources.serial, chromiumChromeTarget.commandLineFile ?? '')).toEqual({
        existed: resources.restoreState.commandLine?.existed ?? false,
        content: resources.restoreState.commandLine?.content ?? ''
      })
    },
    Math.max(300_000, testTimeoutMs + 120_000)
  )
})

async function createResources() {
  const adb = resolveAdb()
  const serial = resolveDeviceSerial()
  const harness = await createAndroidWebViewShellHarness(voiceWebRoot, {
    claims: chromiumClaims,
    harnessPrefix: 'android-chromium'
  })
  const reversedPorts: number[] = []
  let restoreState: AndroidBrowserRestoreState | undefined
  let closed = false

  try {
    const port = Number(new URL(harness.baseUrl).port)
    clearAdbReverseMappings(adb, serial)
    runAdb(adb, serial, ['reverse', `tcp:${port}`, `tcp:${port}`])
    reversedPorts.push(port)
    restoreState = launchAndroidBrowser(adb, serial, chromiumChromeTarget, `${harness.baseUrl}/`)
    return {
      adb,
      serial,
      harness,
      restoreState,
      async close() {
        if (closed) return
        closed = true
        cleanupAndroidBrowser(adb, serial, chromiumChromeTarget, reversedPorts, restoreState)
        await harness.close()
      }
    }
  } catch (error) {
    cleanupAndroidBrowser(adb, serial, chromiumChromeTarget, reversedPorts, restoreState)
    await harness.close()
    throw error
  }
}

async function waitForSelfReportedProof(resources: Awaited<ReturnType<typeof createResources>>): Promise<AndroidVoiceBrowserProof | FailedSelfReport> {
  try {
    return await resources.harness.waitForResult<AndroidVoiceBrowserProof | FailedSelfReport>(testTimeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error([
      message,
      `Request frontier: ${JSON.stringify(resources.harness.requests)}`,
      `Chromium logcat:\n${filteredChromiumLogcat(resources.adb, resources.serial)}`
    ].join('\n'))
  }
}

function readHostMetadata(adb: string, serial: string, selfReported: SelfReportedPage) {
  return {
    deviceSerial: serial,
    sdk: adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.sdk']).trim(),
    release: adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.release']).trim(),
    cpuAbi: adbOutput(adb, serial, ['shell', 'getprop', 'ro.product.cpu.abi']).trim(),
    fingerprint: adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.fingerprint']).trim(),
    browserPackage: chromiumChromePackage,
    browserVersion: packageVersion(adb, serial, chromiumChromePackage),
    browserActivity: chromiumChromeTarget.activityName,
    userAgent: selfReported.userAgent,
    targetUrl: selfReported.href,
    snapshotSource: expectedChromiumSnapshot.source,
    apkSha256: expectedChromiumSnapshot.apkSha256
  }
}

function assertCompleteRepeat(completeRepeat: any, prefix: string): void {
  expect(completeRepeat.first).toMatchObject({
    ownerId: `${prefix}-complete`,
    sessionId: `${prefix}-complete:1`,
    generation: 1,
    foregroundOnly: true
  })
  expect(completeRepeat.firstAudio).toMatchObject({
    sessionId: `${prefix}-complete:1`,
    generation: 1,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 6,
    pcm: [100, -100, 200, -200, 321, -321],
    redacted: true
  })
  expect(completeRepeat.stoppedSnapshot).toMatchObject({
    state: 'stopped',
    sessionId: `${prefix}-complete:1`,
    generation: 1,
    capabilities: { vad: false, kws: false, stt: false, tts: false }
  })
  expect(completeRepeat.completedSnapshot).toMatchObject({
    state: 'idle',
    sessionId: null,
    generation: 1,
    capabilities: { vad: false, kws: false, stt: false, tts: false }
  })
  expect(completeRepeat.second).toMatchObject({
    sessionId: `${prefix}-complete:2`,
    generation: 2
  })
  expect(completeRepeat.secondAudio).toMatchObject({
    sessionId: `${prefix}-complete:2`,
    generation: 2,
    sampleCount: 3,
    pcm: [7, 8, 9],
    redacted: true
  })
  expect(completeRepeat.finalSnapshot).toMatchObject({
    state: 'idle',
    sessionId: null,
    generation: 2,
    queuedBytes: 0,
    capabilities: { vad: false, kws: false, stt: false, tts: false }
  })
  expect(completeRepeat.events.map((event: any) => event.kind)).toEqual([
    'session_started',
    'frame_accepted',
    'frame_accepted',
    'session_stopped',
    'session_started',
    'frame_accepted',
    'session_stopped'
  ])
  expect(completeRepeat.events.every((event: any) => event.redacted === true)).toBe(true)
  expect(completeRepeat.events.some((event: any) => event.kind === 'error')).toBe(false)
}

function assertAbandonRepeat(abandonRepeat: any, prefix: string): void {
  expect(abandonRepeat.first).toMatchObject({
    sessionId: `${prefix}-abandon:1`,
    generation: 1
  })
  expect(abandonRepeat.firstAudio).toEqual({ sampleCount: 4, redacted: true })
  expect(abandonRepeat.abandonedSnapshot).toMatchObject({
    state: 'cancelled',
    sessionId: null,
    generation: 1,
    capabilities: { vad: false, kws: false, stt: false, tts: false }
  })
  expect(abandonRepeat.second).toMatchObject({
    sessionId: `${prefix}-abandon:2`,
    generation: 2
  })
  expect(abandonRepeat.secondAudio).toEqual({ sampleCount: 2, redacted: true })
  expect(abandonRepeat.finalSnapshot).toMatchObject({
    state: 'idle',
    sessionId: null,
    generation: 2,
    queuedBytes: 0,
    capabilities: { vad: false, kws: false, stt: false, tts: false }
  })
  expect(abandonRepeat.events.every((event: any) => event.redacted === true)).toBe(true)
  expect(abandonRepeat.events.some((event: any) => event.kind === 'error')).toBe(false)
}

function assertRedaction(redaction: any): void {
  for (const snapshot of redaction.snapshots) {
    expect(snapshot.capabilities).toEqual({ vad: false, kws: false, stt: false, tts: false })
    expect(snapshot.lifecycle).toMatchObject({
      foregroundOnly: true,
      visible: true,
      frozen: false,
      eligible: true
    })
    expect(snapshot).not.toHaveProperty('pcm')
    expect(snapshot).not.toHaveProperty('transcript')
  }
  expect(redaction.captured).toEqual({ sampleCount: 2, redacted: true })
}

function filteredChromiumLogcat(adb: string, serial: string): string {
  return adbOutputOrEmpty(adb, serial, ['logcat', '-d'])
    .split('\n')
    .filter((line) => !/ F crashpad: /u.test(line))
    .filter((line) => /org\.chromium\.chrome|chromium|CrRendererMain|Renderer process|SIGTRAP|Fatal signal|aw_browser_terminator|incorrect payload|Cmdline:|signal 5/u.test(line))
    .slice(-120)
    .join('\n')
    .slice(-16_000)
}

function packageEnabledState(adb: string, serial: string, packageName: string): string {
  const output = adbOutputOrEmpty(adb, serial, ['shell', 'dumpsys', 'package', packageName])
  return /User 0:.*\senabled=([0-9]+)/u.exec(output)?.[1] ?? '0'
}

function stayOnWhilePluggedIn(adb: string, serial: string): string {
  return adbOutputOrEmpty(adb, serial, ['shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in']).trim()
}

function commandLineState(adb: string, serial: string, file: string): { readonly existed: boolean; readonly content: string } {
  if (file.length === 0) return { existed: false, content: '' }
  const existed = adbOutputOrEmpty(adb, serial, ['shell', 'sh', '-c', `[ -f '${file}' ] && echo yes || echo no`]).trim() === 'yes'
  return {
    existed,
    content: existed ? adbOutputOrEmpty(adb, serial, ['shell', 'cat', file]) : ''
  }
}

function isFailedSelfReport(result: AndroidVoiceBrowserProof | FailedSelfReport): result is FailedSelfReport {
  return 'ok' in result && result.ok === false
}

function assertBuiltProductionVoiceArtifacts(): void {
  for (const required of [
    'browser.js',
    'voice-worker.js',
    'wasm/aurora_voice_wasm.js',
    'wasm/aurora_voice_wasm_bg.wasm'
  ]) {
    if (!existsSync(join(voiceWebDist, required))) {
      throw new Error(`Missing built @aurora/voice-web dist artifact: ${required}`)
    }
  }
}

interface SelfReportedPage {
  readonly userAgent: string
  readonly href: string
  readonly readyState: string
  readonly runtimePath: 'self-reporting-page'
}

interface FailedSelfReport {
  readonly ok: false
  readonly error: {
    readonly name: string
    readonly message: string
    readonly stack?: string
  }
  readonly selfReported?: SelfReportedPage
}

interface AndroidVoiceBrowserProof {
  readonly selfReported: SelfReportedPage
  readonly metadata: null
  readonly completeRepeat: any
  readonly abandonRepeat: any
  readonly redaction: any
  readonly requests: readonly string[]
  readonly artifacts: {
    readonly servedDist: boolean
    readonly workerRequested: boolean
    readonly wasmRequested: boolean
    readonly exactWasmInventory: boolean
    readonly wasmCoreWithinLimit: boolean
    readonly wasmLoaderWithinLimit: boolean
    readonly wasmFiles: readonly string[]
    readonly wasmSizes: Record<string, number>
    readonly forbiddenArtifactCount: number
  }
  readonly consoleErrors: readonly string[]
  readonly claims: AndroidBrowserClaims
  readonly workerSideErrors: readonly unknown[]
  readonly leakScan: {
    readonly eventLeak: boolean
    readonly snapshotLeak: boolean
    readonly consoleLeak: boolean
    readonly rawPcmLeak: boolean
    readonly transcriptLeak: boolean
  }
}
